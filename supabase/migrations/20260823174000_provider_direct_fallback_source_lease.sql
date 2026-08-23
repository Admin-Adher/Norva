-- Must precede the online rollout control plane at 20260823180000.
begin;

set local lock_timeout = '2s';
set local statement_timeout = '5min';

-- External FKs, transition-secret columns and all existing-table triggers are
-- installed in short, independently retryable units around this definition
-- migration.  No existing source is scanned here; the service-owned keyset
-- backfill below starts only after all future-write fences are exact.

-- A direct provider fallback and every credential transition that can touch
-- the same provider account serialize on the opaque SHA-256 account affinity,
-- not on a source id.  This matters when two Norva sources share one provider
-- account.  The lease is deliberately not FK-backed: after the advisory lock,
-- the claim path must never acquire a cloud_sources tuple lock.  Ownership and
-- the current affinity are instead read and rechecked while holding the mutex;
-- an orphan can live for at most the bounded TTL.
create table public.cloud_source_direct_fallback_leases (
  affinity_hash text primary key check (affinity_hash ~ '^[0-9a-f]{64}$'),
  source_id uuid not null,
  user_id uuid not null,
  lease_token uuid not null unique,
  lease_owner text not null check (
    btrim(lease_owner) <> '' and length(lease_owner) <= 160
  ),
  lease_until timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index cloud_source_direct_fallback_leases_expiry_idx
  on public.cloud_source_direct_fallback_leases(lease_until, affinity_hash);
create index cloud_source_direct_fallback_leases_source_idx
  on public.cloud_source_direct_fallback_leases(source_id, user_id);

alter table public.cloud_source_direct_fallback_leases enable row level security;
revoke all on table public.cloud_source_direct_fallback_leases
  from public, anon, authenticated, service_role;

-- All callers that can touch more than one affinity use this helper so their
-- advisory locks are acquired in lowercase lexical order.  That order is the
-- deadlock-avoidance contract for old/candidate/previous account sets.
create or replace function public.norva_lock_provider_account_fallback_affinities(
  p_affinity_hashes text[]
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_affinity_hash text;
begin
  for v_affinity_hash in
    select distinct candidate.affinity_hash
    from pg_catalog.unnest(coalesce(p_affinity_hashes, '{}'::text[]))
      as candidate(affinity_hash)
    where candidate.affinity_hash is not null
    order by candidate.affinity_hash
  loop
    if v_affinity_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'provider account affinity is invalid'
        using errcode = '22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'provider-account-transition-fallback:' || v_affinity_hash,
      0
    ));
  end loop;
end
$function$;

create or replace function public.norva_assert_provider_account_fallback_leases_available(
  p_affinity_hashes text[]
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  delete from public.cloud_source_direct_fallback_leases lease
  where lease.affinity_hash = any(coalesce(p_affinity_hashes, '{}'::text[]))
    and lease.lease_until <= clock_timestamp();
  if exists (
    select 1
    from public.cloud_source_direct_fallback_leases lease
    where lease.affinity_hash = any(coalesce(p_affinity_hashes, '{}'::text[]))
      and lease.lease_until > clock_timestamp()
  ) then
    raise exception 'provider account is in direct fallback use'
      using errcode = '55P03', detail = 'reason=direct_fallback_lease_active';
  end if;
end
$function$;

create or replace function public.norva_assert_no_other_provider_account_transition(
  p_affinity_hashes text[],
  p_excluded_transition_id uuid default null
) returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from public.cloud_source_transitions transition
    left join public.cloud_source_provider_account_affinities old_affinity
      on old_affinity.source_id = transition.old_source_id
     and old_affinity.user_id = transition.user_id
    left join public.cloud_source_provider_account_affinities candidate_affinity
      on candidate_affinity.source_id = transition.candidate_source_id
     and candidate_affinity.user_id = transition.user_id
    left join public.cloud_source_transition_secrets secret
      on secret.transition_id = transition.id
     and secret.user_id = transition.user_id
    where transition.state not in ('completed', 'failed', 'cancelled')
      and transition.id is distinct from p_excluded_transition_id
      and exists (
        select 1
        from pg_catalog.unnest(coalesce(p_affinity_hashes, '{}'::text[]))
          requested(affinity_hash)
        where requested.affinity_hash = any(array[
          old_affinity.affinity_hash,
          candidate_affinity.affinity_hash,
          secret.candidate_account_affinity_hash,
          secret.previous_account_affinity_hash
        ])
      )
  ) then
    raise exception 'provider account already has a non-terminal transition'
      using errcode = '55P03', detail = 'reason=account_transition_active';
  end if;
end
$function$;

create or replace function public.norva_transition_provider_account_affinities(
  p_transition_id uuid,
  p_user_id uuid
) returns text[]
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    array_agg(distinct hashes.affinity_hash order by hashes.affinity_hash)
      filter (where hashes.affinity_hash is not null),
    '{}'::text[]
  )
  from public.cloud_source_transitions transition
  left join public.cloud_source_provider_account_affinities old_affinity
    on old_affinity.source_id = transition.old_source_id
   and old_affinity.user_id = transition.user_id
  left join public.cloud_source_provider_account_affinities candidate_affinity
    on candidate_affinity.source_id = transition.candidate_source_id
   and candidate_affinity.user_id = transition.user_id
  left join public.cloud_source_transition_secrets secret
    on secret.transition_id = transition.id
   and secret.user_id = transition.user_id
  cross join lateral pg_catalog.unnest(array[
    old_affinity.affinity_hash,
    candidate_affinity.affinity_hash,
    secret.candidate_account_affinity_hash,
    secret.previous_account_affinity_hash
  ]) hashes(affinity_hash)
  where transition.id = p_transition_id
    and transition.user_id = p_user_id
$function$;

-- Swap and compensation call this before taking transition/source rows.  At
-- those states candidate and previous hashes are already bound, so the sorted
-- set is complete; rechecking after acquisition catches catalog drift.
create or replace function public.norva_lock_credential_transition_account_affinities(
  p_transition_id uuid,
  p_user_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_affinity_hashes text[];
  v_rechecked_hashes text[];
begin
  if not exists (
    select 1 from public.cloud_source_transitions transition
    where transition.id = p_transition_id and transition.user_id = p_user_id
  ) then
    raise exception 'credential transition not found' using errcode = 'P0002';
  end if;
  v_affinity_hashes := public.norva_transition_provider_account_affinities(
    p_transition_id, p_user_id
  );
  if cardinality(v_affinity_hashes) < 1 then
    raise exception 'credential transition account affinity is unavailable'
      using errcode = '55000', detail = 'reason=affinity_missing';
  end if;
  perform public.norva_lock_provider_account_fallback_affinities(
    v_affinity_hashes
  );
  v_rechecked_hashes := public.norva_transition_provider_account_affinities(
    p_transition_id, p_user_id
  );
  if v_rechecked_hashes is distinct from v_affinity_hashes then
    raise exception 'credential transition account affinities changed while locking'
      using errcode = '40001', detail = 'reason=affinity_changed';
  end if;
  perform public.norva_assert_provider_account_fallback_leases_available(
    v_affinity_hashes
  );
  perform set_config(
    'norva.account_transition_lock_id', p_transition_id::text, true
  );
end
$function$;

-- Raw config writes are forbidden.  The only Phase 3 mutation path is a
-- credential swap/compensation that first acquired the complete sorted account
-- mutex set through norva_lock_credential_transition_account_affinities().
-- This AFTER trigger does not acquire a new lock when the proof is absent, so a
-- rejected row-locking UPDATE cannot invert the global affinity-before-row
-- order.  Raising here rolls the source row and lifecycle revision back.
create or replace function public.norva_switch_provider_account_affinity()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_transition_id uuid;
  v_candidate_hash text;
  v_previous_hash text;
  v_swap_applied_at timestamptz;
  v_lock_transition_id text;
begin
  if new.source_type is distinct from old.source_type then
    raise exception 'source type mutation is outside credential transition scope'
      using errcode = '55000', detail = 'reason=source_type_write_forbidden';
  end if;
  if new.config_ciphertext is not distinct from old.config_ciphertext then
    -- Sync/progress writers legitimately maintain non-identity hint fields
    -- while flags are OFF.  Only the two fields that define account affinity
    -- are credential state and therefore require the transition mutex.
    if (new.config_hint->>'serverHost') is distinct from
         (old.config_hint->>'serverHost')
       or (new.config_hint->>'username') is distinct from
         (old.config_hint->>'username') then
      raise exception 'source account hint mutation is outside a credential transition'
        using errcode = '55000', detail = 'reason=config_write_requires_transition';
    end if;
    return new;
  end if;
  select transition.id, secret.candidate_account_affinity_hash,
      secret.previous_account_affinity_hash, secret.swap_applied_at
    into v_transition_id, v_candidate_hash, v_previous_hash, v_swap_applied_at
  from public.cloud_source_transitions transition
  join public.cloud_source_transition_secrets secret
    on secret.transition_id = transition.id
   and secret.user_id = transition.user_id
  where transition.old_source_id = new.id
    and transition.user_id = new.user_id
    and transition.transition_kind = 'credential'
    and transition.state = 'committing'
    and (
      secret.candidate_config_ciphertext = new.config_ciphertext
      or secret.previous_config_ciphertext = new.config_ciphertext
    )
  order by transition.started_at desc
  limit 1;
  if not found then
    raise exception 'source config mutation is outside a credential transition'
      using errcode = '55000', detail = 'reason=config_write_requires_transition';
  end if;
  v_lock_transition_id := current_setting(
    'norva.account_transition_lock_id', true
  );
  if v_lock_transition_id is distinct from v_transition_id::text then
    raise exception 'source config mutation lacks account lock proof'
      using errcode = '55000', detail = 'reason=config_write_lock_proof_missing';
  end if;

  if v_swap_applied_at is null and exists (
    select 1
    from public.cloud_source_transition_secrets secret
    where secret.transition_id = v_transition_id
      and secret.candidate_config_ciphertext = new.config_ciphertext
  ) then
    if v_candidate_hash is null then
      raise exception 'candidate provider account affinity is not bound'
        using errcode = '55000';
    end if;
    insert into public.cloud_source_provider_account_affinities (
      source_id, user_id, affinity_hash, updated_at
    ) values (
      new.id, new.user_id, v_candidate_hash, clock_timestamp()
    )
    on conflict (source_id) do update
    set user_id = excluded.user_id,
        affinity_hash = excluded.affinity_hash,
        updated_at = excluded.updated_at;
  elsif v_previous_hash is null then
    delete from public.cloud_source_provider_account_affinities
    where source_id = new.id and user_id = new.user_id;
  else
    insert into public.cloud_source_provider_account_affinities (
      source_id, user_id, affinity_hash, updated_at
    ) values (
      new.id, new.user_id, v_previous_hash, clock_timestamp()
    )
    on conflict (source_id) do update
    set user_id = excluded.user_id,
        affinity_hash = excluded.affinity_hash,
        updated_at = excluded.updated_at;
  end if;
  return new;
end
$function$;

create or replace function public.norva_backfill_source_provider_account_affinities(
  p_limit integer default 100
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'
set statement_timeout = '30s'
as $function$
declare
  v_rollout public.cloud_source_provider_account_affinity_rollout%rowtype;
  v_source public.cloud_sources%rowtype;
  v_candidate_ids uuid[];
  v_expected integer := 0;
  v_inspected integer := 0;
  v_inserted integer := 0;
  v_rows integer := 0;
  v_last uuid;
  v_complete boolean := false;
begin
  perform public.norva_credential_require_service_role();
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'provider account affinity backfill limit must be between 1 and 500'
      using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-account-affinity-backfill',0)
  );
  select rollout.* into strict v_rollout
  from public.cloud_source_provider_account_affinity_rollout rollout
  where rollout.singleton
  for update;
  v_last := v_rollout.source_cursor;
  if v_rollout.phase='complete' then
    return jsonb_build_object(
      'complete',true,'inspectedSources',0,'affinityRowsInserted',0,
      'nextCursor',v_rollout.source_cursor
    );
  end if;

  select coalesce(pg_catalog.array_agg(candidate.id order by candidate.id),'{}'::uuid[])
    into v_candidate_ids
  from (
    select source.id
    from public.cloud_sources source
    where v_rollout.source_cursor is null or source.id>v_rollout.source_cursor
    order by source.id
    limit p_limit
  ) candidate;
  v_expected := pg_catalog.cardinality(v_candidate_ids);

  for v_source in
    select source.* from public.cloud_sources source
    where source.id=any(v_candidate_ids)
    order by source.id
    for share of source skip locked
  loop
    v_inspected:=v_inspected+1;
    v_last:=v_source.id;
    if v_source.source_type='xtream' and v_source.deleted_at is null
       and coalesce(btrim(v_source.config_hint->>'serverHost'),'')<>''
       and coalesce(btrim(v_source.config_hint->>'username'),'')<>'' then
      insert into public.cloud_source_provider_account_affinities(
        source_id,user_id,affinity_hash
      ) values (
        v_source.id,v_source.user_id,
        encode(extensions.digest(
          lower(v_source.config_hint->>'serverHost') || '/'
            || (v_source.config_hint->>'username'),'sha256'
        ),'hex')
      ) on conflict(source_id) do nothing;
      get diagnostics v_rows=row_count;
      v_inserted:=v_inserted+v_rows;
    end if;
  end loop;
  if v_inspected<>v_expected then
    raise exception 'provider account affinity source batch is locked; retry unchanged cursor'
      using errcode='55P03',detail='reason=source_batch_locked';
  end if;
  if v_inspected>0 then
    update public.cloud_source_provider_account_affinity_rollout rollout
    set phase='running',source_cursor=v_last,
      inspected_sources=rollout.inspected_sources+v_inspected,
      affinity_rows_inserted=rollout.affinity_rows_inserted+v_inserted,
      started_at=coalesce(rollout.started_at,clock_timestamp()),
      updated_at=clock_timestamp()
    where rollout.singleton;
  else
    v_complete := not exists (
      select 1
      from public.cloud_sources source
      left join public.cloud_source_provider_account_affinities affinity
        on affinity.source_id=source.id and affinity.user_id=source.user_id
      where source.source_type='xtream' and source.deleted_at is null
        and (
          coalesce(btrim(source.config_hint->>'serverHost'),'')=''
          or coalesce(btrim(source.config_hint->>'username'),'')=''
          or affinity.source_id is null
          or affinity.affinity_hash<>encode(extensions.digest(
            lower(source.config_hint->>'serverHost') || '/'
              || (source.config_hint->>'username'),'sha256'
          ),'hex')
        )
    ) and public.norva_provider_access_foundation_trigger_is_exact(
      'public.cloud_sources','trg_cloud_sources_provider_account_affinity',
      'public.norva_switch_provider_account_affinity()'::regprocedure,17
    ) and public.norva_provider_access_foundation_trigger_is_exact(
      'public.cloud_sources','trg_00_cloud_sources_provider_account_affinity_insert',
      'public.norva_insert_source_provider_account_affinity()'::regprocedure,5
    ) and public.norva_provider_access_foundation_trigger_is_exact(
      'public.cloud_source_transitions','trg_00_cloud_source_transition_fallback_lease',
      'public.norva_source_transition_fallback_lease_guard()'::regprocedure,7
    ) and public.norva_provider_access_foundation_trigger_is_exact(
      'public.cloud_source_provider_account_affinities',
      'trg_00_provider_account_affinity_fallback_lease',
      'public.norva_provider_account_affinity_fallback_lease_guard()'::regprocedure,31
    ) and public.norva_provider_access_foundation_fk_is_exact(
      'public.cloud_source_provider_account_affinities',
      'cloud_source_provider_account_affinities_owner_fk',
      array['user_id','source_id']::name[],'public.cloud_sources',
      array['user_id','id']::name[],'c','c',true
    );
    update public.cloud_source_provider_account_affinity_rollout rollout
    set phase=case when v_complete then 'complete' else 'running' end,
      completed_at=case when v_complete then coalesce(rollout.completed_at,clock_timestamp()) else null end,
      started_at=coalesce(rollout.started_at,clock_timestamp()),
      updated_at=clock_timestamp()
    where rollout.singleton;
  end if;
  return jsonb_build_object(
    'complete',v_complete,'inspectedSources',v_inspected,
    'affinityRowsInserted',v_inserted,'nextCursor',v_last
  );
end
$function$;

create or replace function public.norva_insert_source_provider_account_affinity()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_server_host text := new.config_hint->>'serverHost';
  v_username text := new.config_hint->>'username';
begin
  if new.source_type <> 'xtream'
     or coalesce(btrim(v_server_host), '') = ''
     or coalesce(btrim(v_username), '') = '' then
    return new;
  end if;
  insert into public.cloud_source_provider_account_affinities(
    source_id, user_id, affinity_hash
  ) values (
    new.id,
    new.user_id,
    encode(extensions.digest(lower(v_server_host) || '/' || v_username, 'sha256'), 'hex')
  )
  on conflict (source_id) do nothing;
  return new;
end
$function$;

-- Called by norva_create_credential_transition before it takes any source row
-- lock.  Xtream transition creation is fail closed when its old account
-- affinity is unknown; otherwise the INSERT trigger would have no mutex to
-- acquire and a concurrent claim could observe the affinity only after it.
create or replace function public.norva_assert_transition_account_fallback_available(
  p_source_id uuid,
  p_user_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_affinity_hash text;
begin
  select affinity.affinity_hash
    into v_affinity_hash
  from public.cloud_source_provider_account_affinities affinity
  where affinity.source_id = p_source_id
    and affinity.user_id = p_user_id;
  if not found then
    raise exception 'credential transition account affinity is unavailable'
      using errcode = '55000', detail = 'reason=affinity_missing';
  end if;

  perform public.norva_lock_provider_account_fallback_affinities(
    array[v_affinity_hash]
  );

  -- The affinity mutation trigger uses the same mutex.  Recheck after taking
  -- it so a pre-lock read can never authorize a stale account.
  if not exists (
    select 1
    from public.cloud_source_provider_account_affinities affinity
    where affinity.source_id = p_source_id
      and affinity.user_id = p_user_id
      and affinity.affinity_hash = v_affinity_hash
  ) then
    raise exception 'provider account affinity changed while opening transition'
      using errcode = '40001', detail = 'reason=affinity_changed';
  end if;

  delete from public.cloud_source_direct_fallback_leases lease
  where lease.affinity_hash = v_affinity_hash
    and lease.lease_until <= clock_timestamp();
  if exists (
    select 1
    from public.cloud_source_direct_fallback_leases lease
    where lease.affinity_hash = v_affinity_hash
      and lease.lease_until > clock_timestamp()
  ) then
    raise exception 'credential transition blocked by active direct fallback lease'
      using errcode = '55P03', detail = 'reason=direct_fallback_lease_active';
  end if;
end
$function$;

create or replace function public.norva_claim_source_direct_fallback_lease(
  p_source_id uuid,
  p_user_id uuid,
  p_owner text,
  p_ttl_seconds integer default 30
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_affinity_hash text;
  v_token uuid := gen_random_uuid();
  v_until timestamptz;
  v_retry_after integer;
begin
  perform public.norva_credential_require_service_role();
  if p_source_id is null or p_user_id is null then
    raise exception 'source_id and user_id are required' using errcode = '22004';
  end if;
  if p_owner is null or btrim(p_owner) = '' or length(p_owner) > 160 then
    raise exception 'bounded fallback lease owner is required'
      using errcode = '22023';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 5 or p_ttl_seconds > 120 then
    raise exception 'fallback lease TTL must be between 5 and 120 seconds'
      using errcode = '22023';
  end if;

  -- Plain ownership read before the account mutex; never FOR UPDATE/SHARE.
  perform 1
  from public.cloud_sources source
  where source.id = p_source_id
    and source.user_id = p_user_id
    and source.deleted_at is null;
  if not found then
    raise exception 'source not found' using errcode = 'P0002';
  end if;

  select affinity.affinity_hash
    into v_affinity_hash
  from public.cloud_source_provider_account_affinities affinity
  where affinity.source_id = p_source_id
    and affinity.user_id = p_user_id;
  if not found then
    raise exception 'source direct fallback account affinity is unavailable'
      using errcode = '55000', detail = 'reason=affinity_missing';
  end if;

  perform public.norva_lock_provider_account_fallback_affinities(
    array[v_affinity_hash]
  );

  -- Recheck both ownership and affinity under the mutex.  This is still a
  -- non-locking read; the affinity trigger cannot commit a mutation involving
  -- this hash until this transaction releases the advisory lock.
  if not exists (
    select 1
    from public.cloud_sources source
    join public.cloud_source_provider_account_affinities affinity
      on affinity.source_id = source.id
     and affinity.user_id = source.user_id
    where source.id = p_source_id
      and source.user_id = p_user_id
      and source.deleted_at is null
      and affinity.affinity_hash = v_affinity_hash
  ) then
    raise exception 'source account affinity changed during fallback claim'
      using errcode = '40001', detail = 'reason=affinity_changed';
  end if;

  delete from public.cloud_source_direct_fallback_leases lease
  where lease.affinity_hash = v_affinity_hash
    and lease.lease_until <= clock_timestamp();

  -- Match current source affinities and the candidate/previous hashes already
  -- bound to a transition secret.  No user predicate is intentional: one
  -- opaque provider account cannot safely be used by another Norva user while
  -- its credentials are transitioning.
  if exists (
    select 1
    from public.cloud_source_transitions transition
    left join public.cloud_source_provider_account_affinities old_affinity
      on old_affinity.source_id = transition.old_source_id
     and old_affinity.user_id = transition.user_id
    left join public.cloud_source_provider_account_affinities candidate_affinity
      on candidate_affinity.source_id = transition.candidate_source_id
     and candidate_affinity.user_id = transition.user_id
    left join public.cloud_source_transition_secrets secret
      on secret.transition_id = transition.id
     and secret.user_id = transition.user_id
    where transition.state not in ('completed', 'failed', 'cancelled')
      and v_affinity_hash = any(array[
        old_affinity.affinity_hash,
        candidate_affinity.affinity_hash,
        secret.candidate_account_affinity_hash,
        secret.previous_account_affinity_hash
      ])
  ) then
    raise exception 'source direct fallback blocked by active account transition'
      using errcode = '55P03', detail = 'reason=transition_active';
  end if;

  select greatest(1, ceil(extract(epoch from
           (lease.lease_until - clock_timestamp())))::integer)
    into v_retry_after
  from public.cloud_source_direct_fallback_leases lease
  where lease.affinity_hash = v_affinity_hash
    and lease.lease_until > clock_timestamp();
  if found then
    raise exception 'provider account direct fallback lease is busy'
      using errcode = '55P03',
        detail = format('reason=lease_busy;retry_after_seconds=%s', v_retry_after);
  end if;

  v_until := clock_timestamp() + make_interval(secs => p_ttl_seconds);
  insert into public.cloud_source_direct_fallback_leases (
    affinity_hash, source_id, user_id, lease_token, lease_owner, lease_until
  ) values (
    v_affinity_hash, p_source_id, p_user_id, v_token, btrim(p_owner), v_until
  );

  return jsonb_build_object(
    'claimed', true,
    'sourceId', p_source_id,
    'userId', p_user_id,
    'leaseToken', v_token,
    'leaseOwner', btrim(p_owner),
    'leaseUntil', v_until
  );
end
$function$;

-- Snapshot-fenced production claim.  The provider credentials are read before
-- a caller knows whether a direct fallback is necessary, so account affinity
-- alone is not an adequate ABA fence: a password-only refresh keeps the same
-- host/user affinity.  The caller therefore proves the exact ciphertext it
-- decrypted and the lifecycle revision from that same snapshot.  Both the
-- expected and currently published affinities are locked before the catalog is
-- rechecked, so a concurrent A -> B swap either completes first and fails this
-- CAS or waits behind the lease.
create or replace function public.norva_claim_source_direct_fallback_lease(
  p_source_id uuid,
  p_user_id uuid,
  p_owner text,
  p_ttl_seconds integer,
  p_expected_provider_account_affinity_hash text,
  p_expected_config_revision bigint,
  p_expected_config_ciphertext_hash text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_affinity_hash text;
  v_token uuid := gen_random_uuid();
  v_until timestamptz;
  v_retry_after integer;
begin
  perform public.norva_credential_require_service_role();
  if p_source_id is null or p_user_id is null then
    raise exception 'source_id and user_id are required' using errcode = '22004';
  end if;
  if p_owner is null or btrim(p_owner) = '' or length(p_owner) > 160 then
    raise exception 'bounded fallback lease owner is required'
      using errcode = '22023';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 5 or p_ttl_seconds > 120 then
    raise exception 'fallback lease TTL must be between 5 and 120 seconds'
      using errcode = '22023';
  end if;
  if p_expected_provider_account_affinity_hash is null
     or p_expected_provider_account_affinity_hash !~ '^[0-9a-f]{64}$'
     or p_expected_config_ciphertext_hash is null
     or p_expected_config_ciphertext_hash !~ '^[0-9a-f]{64}$'
     or p_expected_config_revision is null
     or p_expected_config_revision < 0 then
    raise exception 'fallback source snapshot proof is invalid'
      using errcode = '22023';
  end if;

  -- Non-locking pre-read only.  Every config_ciphertext/source_type mutation is
  -- revisioned by trg_cloud_sources_track_config_revision in the foundation.
  select affinity.affinity_hash
    into v_affinity_hash
  from public.cloud_sources source
  join public.cloud_source_provider_account_affinities affinity
    on affinity.source_id = source.id
   and affinity.user_id = source.user_id
  where source.id = p_source_id
    and source.user_id = p_user_id
    and source.deleted_at is null;
  if not found then
    if exists (
      select 1 from public.cloud_sources source
      where source.id = p_source_id
        and source.user_id = p_user_id
        and source.deleted_at is null
    ) then
      raise exception 'source direct fallback account affinity is unavailable'
        using errcode = '55000', detail = 'reason=affinity_missing';
    end if;
    raise exception 'source not found' using errcode = 'P0002';
  end if;

  perform public.norva_lock_provider_account_fallback_affinities(array[
    v_affinity_hash, p_expected_provider_account_affinity_hash
  ]);

  -- One catalog statement proves owner, current account, exact encrypted
  -- config, and lifecycle revision.  No expected or actual hashes are exposed
  -- in the error or return payload.
  if not exists (
    select 1
    from public.cloud_sources source
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.source_id = source.id
     and lifecycle.user_id = source.user_id
    join public.cloud_source_provider_account_affinities affinity
      on affinity.source_id = source.id
     and affinity.user_id = source.user_id
    where source.id = p_source_id
      and source.user_id = p_user_id
      and source.deleted_at is null
      and affinity.affinity_hash = v_affinity_hash
      and affinity.affinity_hash = p_expected_provider_account_affinity_hash
      and lifecycle.config_revision = p_expected_config_revision
      and encode(extensions.digest(source.config_ciphertext, 'sha256'), 'hex')
          = p_expected_config_ciphertext_hash
  ) then
    raise exception 'source configuration snapshot changed during fallback claim'
      using errcode = '40001', detail = 'reason=source_config_snapshot_changed';
  end if;

  delete from public.cloud_source_direct_fallback_leases lease
  where lease.affinity_hash = v_affinity_hash
    and lease.lease_until <= clock_timestamp();

  if exists (
    select 1
    from public.cloud_source_transitions transition
    left join public.cloud_source_provider_account_affinities old_affinity
      on old_affinity.source_id = transition.old_source_id
     and old_affinity.user_id = transition.user_id
    left join public.cloud_source_provider_account_affinities candidate_affinity
      on candidate_affinity.source_id = transition.candidate_source_id
     and candidate_affinity.user_id = transition.user_id
    left join public.cloud_source_transition_secrets secret
      on secret.transition_id = transition.id
     and secret.user_id = transition.user_id
    where transition.state not in ('completed', 'failed', 'cancelled')
      and v_affinity_hash = any(array[
        old_affinity.affinity_hash,
        candidate_affinity.affinity_hash,
        secret.candidate_account_affinity_hash,
        secret.previous_account_affinity_hash
      ])
  ) then
    raise exception 'source direct fallback blocked by active account transition'
      using errcode = '55P03', detail = 'reason=transition_active';
  end if;

  select greatest(1, ceil(extract(epoch from
           (lease.lease_until - clock_timestamp())))::integer)
    into v_retry_after
  from public.cloud_source_direct_fallback_leases lease
  where lease.affinity_hash = v_affinity_hash
    and lease.lease_until > clock_timestamp();
  if found then
    raise exception 'provider account direct fallback lease is busy'
      using errcode = '55P03',
        detail = format('reason=lease_busy;retry_after_seconds=%s', v_retry_after);
  end if;

  v_until := clock_timestamp() + make_interval(secs => p_ttl_seconds);
  insert into public.cloud_source_direct_fallback_leases (
    affinity_hash, source_id, user_id, lease_token, lease_owner, lease_until
  ) values (
    v_affinity_hash, p_source_id, p_user_id, v_token, btrim(p_owner), v_until
  );

  return jsonb_build_object(
    'claimed', true,
    'sourceId', p_source_id,
    'userId', p_user_id,
    'leaseToken', v_token,
    'leaseOwner', btrim(p_owner),
    'leaseUntil', v_until
  );
end
$function$;

create or replace function public.norva_release_source_direct_fallback_lease(
  p_source_id uuid,
  p_user_id uuid,
  p_lease_token uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_affinity_hash text;
  v_released integer := 0;
begin
  perform public.norva_credential_require_service_role();
  if p_source_id is null or p_user_id is null or p_lease_token is null then
    raise exception 'source_id, user_id and lease token are required'
      using errcode = '22004';
  end if;

  select lease.affinity_hash
    into v_affinity_hash
  from public.cloud_source_direct_fallback_leases lease
  where lease.source_id = p_source_id
    and lease.user_id = p_user_id
    and lease.lease_token = p_lease_token;
  if not found then
    return false;
  end if;

  perform public.norva_lock_provider_account_fallback_affinities(
    array[v_affinity_hash]
  );
  delete from public.cloud_source_direct_fallback_leases lease
  where lease.affinity_hash = v_affinity_hash
    and lease.source_id = p_source_id
    and lease.user_id = p_user_id
    and lease.lease_token = p_lease_token;
  get diagnostics v_released = row_count;
  return v_released = 1;
end
$function$;

create or replace function public.norva_source_transition_fallback_lease_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_affinity_hashes text[];
begin
  if exists (
    select 1
    from public.cloud_sources source
    where source.user_id = new.user_id
      and source.id = any(array[new.old_source_id, new.candidate_source_id])
      and source.source_type = 'xtream'
      and not exists (
        select 1
        from public.cloud_source_provider_account_affinities affinity
        where affinity.source_id = source.id
          and affinity.user_id = source.user_id
      )
  ) then
    raise exception 'source transition account affinity is unavailable'
      using errcode = '55000', detail = 'reason=affinity_missing';
  end if;

  select coalesce(
      array_agg(distinct affinity.affinity_hash order by affinity.affinity_hash),
      '{}'::text[]
    )
    into v_affinity_hashes
  from public.cloud_source_provider_account_affinities affinity
  where affinity.user_id = new.user_id
    and affinity.source_id = any(array[new.old_source_id, new.candidate_source_id]);

  perform public.norva_lock_provider_account_fallback_affinities(
    v_affinity_hashes
  );
  delete from public.cloud_source_direct_fallback_leases lease
  where lease.affinity_hash = any(v_affinity_hashes)
    and lease.lease_until <= clock_timestamp();
  if exists (
    select 1
    from public.cloud_source_direct_fallback_leases lease
    where lease.affinity_hash = any(v_affinity_hashes)
      and lease.lease_until > clock_timestamp()
  ) then
    raise exception 'source transition blocked by active direct fallback lease'
      using errcode = '55P03', detail = 'reason=direct_fallback_lease_active';
  end if;
  perform public.norva_assert_no_other_provider_account_transition(
    v_affinity_hashes, null
  );
  return new;
end
$function$;

-- Any later affinity insertion/change/removal takes the old/new account locks
-- in the same order and cannot move a source across an active fallback lease.
create or replace function public.norva_provider_account_affinity_fallback_lease_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_affinity_hashes text[];
  v_excluded_transition_id uuid;
begin
  select coalesce(
      array_agg(distinct candidate.affinity_hash order by candidate.affinity_hash),
      '{}'::text[]
    )
    into v_affinity_hashes
  from pg_catalog.unnest(array[
    case when tg_op in ('UPDATE', 'DELETE') then old.affinity_hash end,
    case when tg_op in ('INSERT', 'UPDATE') then new.affinity_hash end
  ]) as candidate(affinity_hash)
  where candidate.affinity_hash is not null;

  perform public.norva_lock_provider_account_fallback_affinities(
    v_affinity_hashes
  );
  delete from public.cloud_source_direct_fallback_leases lease
  where lease.affinity_hash = any(v_affinity_hashes)
    and lease.lease_until <= clock_timestamp();
  if exists (
    select 1
    from public.cloud_source_direct_fallback_leases lease
    where lease.affinity_hash = any(v_affinity_hashes)
      and lease.lease_until > clock_timestamp()
  ) then
    raise exception 'provider account affinity change blocked by direct fallback lease'
      using errcode = '55P03', detail = 'reason=direct_fallback_lease_active';
  end if;
  begin
    v_excluded_transition_id := nullif(current_setting(
      'norva.account_transition_lock_id', true
    ), '')::uuid;
  exception when others then
    v_excluded_transition_id := null;
  end;
  perform public.norva_assert_no_other_provider_account_transition(
    v_affinity_hashes, v_excluded_transition_id
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

-- Re-emit transition creation with the account mutex immediately before its
-- first cloud_sources row lock.  Exact fragment matching makes upstream drift
-- fail the migration closed instead of silently restoring a lock inversion.
do $block$
declare
  v_definition text;
  v_marker text := '  select source.* into v_source' || chr(10);
  v_occurrences integer;
begin
  v_definition := replace(pg_catalog.pg_get_functiondef(
    'public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text)'::regprocedure
  ), chr(13), '');
  v_occurrences := (
    length(v_definition) - length(replace(v_definition, v_marker, ''))
  ) / length(v_marker);
  if v_occurrences <> 1 then
    raise exception 'credential transition affinity mutex rewrite drifted: % markers',
      v_occurrences using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_marker,
    '  perform public.norva_assert_transition_account_fallback_available(' || chr(10)
    || '    p_source_id, p_user_id' || chr(10)
    || '  );' || chr(10) || chr(10) || v_marker
  );
  execute v_definition;
end
$block$;

-- Re-emit the affinity bind so candidate account publication and a direct
-- fallback on that account are mutually exclusive.  The advisory lock is
-- acquired before transition/secret row locks; replay of an already-bound
-- identical hash remains idempotent.
create or replace function public.norva_bind_credential_transition_account_affinity(
  p_transition_id uuid,
  p_user_id uuid,
  p_candidate_account_affinity_hash text,
  p_expected_transition_revision bigint
) returns jsonb
language plpgsql volatile security definer set search_path='' as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_secret public.cloud_source_transition_secrets%rowtype;
  v_previous_hash text;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if p_candidate_account_affinity_hash is null
     or p_candidate_account_affinity_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'candidate provider account affinity is invalid' using errcode='22023';
  end if;

  perform public.norva_lock_provider_account_fallback_affinities(
    array[p_candidate_account_affinity_hash]
  );

  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id=p_transition_id and transition.user_id=p_user_id for update;
  if not found then
    raise exception 'credential transition not found' using errcode='P0002';
  end if;
  select secret.* into v_secret from public.cloud_source_transition_secrets secret
  where secret.transition_id=p_transition_id and secret.user_id=p_user_id for update;
  if not found then
    raise exception 'credential transition secret not found' using errcode='55000';
  end if;
  if v_secret.candidate_account_affinity_hash is not null then
    if v_secret.candidate_account_affinity_hash=p_candidate_account_affinity_hash then
      return public.norva_credential_transition_result(p_transition_id,p_user_id);
    end if;
    raise exception 'candidate provider account affinity replay mismatch' using errcode='22023';
  end if;
  if v_transition.state<>'validating'
     or v_transition.revision<>p_expected_transition_revision
     or v_secret.cleared_at is not null then
    raise exception 'candidate provider account affinity CAS failed' using errcode='40001';
  end if;

  delete from public.cloud_source_direct_fallback_leases lease
  where lease.affinity_hash=p_candidate_account_affinity_hash
    and lease.lease_until<=clock_timestamp();
  if exists (
    select 1 from public.cloud_source_direct_fallback_leases lease
    where lease.affinity_hash=p_candidate_account_affinity_hash
      and lease.lease_until>clock_timestamp()
  ) then
    raise exception 'candidate provider account affinity is in direct fallback use'
      using errcode='55P03',detail='reason=direct_fallback_lease_active';
  end if;
  perform public.norva_assert_no_other_provider_account_transition(
    array[p_candidate_account_affinity_hash], p_transition_id
  );

  select affinity.affinity_hash into v_previous_hash
  from public.cloud_source_provider_account_affinities affinity
  where affinity.source_id=v_transition.old_source_id and affinity.user_id=p_user_id;
  update public.cloud_source_transition_secrets
  set candidate_account_affinity_hash=p_candidate_account_affinity_hash,
      previous_account_affinity_hash=v_previous_hash
  where transition_id=p_transition_id and user_id=p_user_id;
  update public.cloud_source_credential_transition_jobs
  set available_at=now()
  where transition_id=p_transition_id and user_id=p_user_id
    and job_kind='validate_candidate' and state='pending';
  return public.norva_credential_transition_result(p_transition_id,p_user_id);
end
$function$;

-- Atomic production entrypoint: old and candidate account affinities are
-- reserved before any transition row exists, then the historical create and
-- bind steps execute inside this one transaction.  A candidate conflict can
-- therefore never strand an unbound VALIDATING transition.
create or replace function public.norva_create_credential_transition(
  p_user_id uuid,
  p_source_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_if_match_revision bigint,
  p_candidate_config_ciphertext text,
  p_candidate_config_hint jsonb,
  p_actor text,
  p_candidate_account_affinity_hash text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_old_affinity_hash text;
  v_existing public.cloud_source_transitions%rowtype;
  v_existing_candidate_hash text;
  v_existing_secret_cleared_at timestamptz;
  v_excluded_transition_id uuid;
  v_result jsonb;
  v_transition_id uuid;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  if p_candidate_account_affinity_hash is null
     or p_candidate_account_affinity_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'candidate provider account affinity is invalid'
      using errcode = '22023';
  end if;
  select affinity.affinity_hash into v_old_affinity_hash
  from public.cloud_source_provider_account_affinities affinity
  where affinity.source_id = p_source_id and affinity.user_id = p_user_id;
  if not found then
    raise exception 'credential transition account affinity is unavailable'
      using errcode = '55000', detail = 'reason=affinity_missing';
  end if;

  perform public.norva_lock_provider_account_fallback_affinities(array[
    v_old_affinity_hash, p_candidate_account_affinity_hash
  ]);
  if not exists (
    select 1 from public.cloud_source_provider_account_affinities affinity
    where affinity.source_id = p_source_id
      and affinity.user_id = p_user_id
      and affinity.affinity_hash = v_old_affinity_hash
  ) then
    raise exception 'source account affinity changed during transition creation'
      using errcode = '40001', detail = 'reason=affinity_changed';
  end if;

  -- Recheck idempotency only after the account locks.  Two simultaneous exact
  -- requests then converge on one transition instead of reporting a conflict.
  select transition.* into v_existing
  from public.cloud_source_transitions transition
  where transition.user_id = p_user_id
    and transition.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.transition_kind <> 'credential'
       or v_existing.old_source_id <> p_source_id
       or v_existing.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'idempotency key reused with different request'
        using errcode = '22023';
    end if;
    v_excluded_transition_id := v_existing.id;
    select secret.candidate_account_affinity_hash, secret.cleared_at
      into v_existing_candidate_hash, v_existing_secret_cleared_at
    from public.cloud_source_transition_secrets secret
    where secret.transition_id = v_existing.id
      and secret.user_id = p_user_id;
    if v_existing_candidate_hash is not null
       and v_existing_candidate_hash <> p_candidate_account_affinity_hash then
      raise exception 'candidate provider account affinity replay mismatch'
        using errcode = '22023';
    end if;
    if not found then
      raise exception 'credential transition secret not found' using errcode = '55000';
    end if;
    if v_existing_candidate_hash = p_candidate_account_affinity_hash
       or v_existing_secret_cleared_at is not null
       or v_existing.state in ('completed', 'failed', 'cancelled') then
      return public.norva_credential_transition_result(
        v_existing.id, p_user_id
      );
    end if;
  end if;

  perform public.norva_assert_provider_account_fallback_leases_available(array[
    v_old_affinity_hash, p_candidate_account_affinity_hash
  ]);
  perform public.norva_assert_no_other_provider_account_transition(
    array[v_old_affinity_hash, p_candidate_account_affinity_hash],
    v_excluded_transition_id
  );

  v_result := public.norva_create_credential_transition(
    p_user_id,
    p_source_id,
    p_idempotency_key,
    p_request_fingerprint,
    p_if_match_revision,
    p_candidate_config_ciphertext,
    p_candidate_config_hint,
    p_actor
  );
  v_transition_id := (v_result->>'transitionId')::uuid;
  return public.norva_bind_credential_transition_account_affinity(
    v_transition_id,
    p_user_id,
    p_candidate_account_affinity_hash,
    (v_result->>'revision')::bigint
  );
end
$function$;

-- Swap and rollback historically locked the transition/source rows before the
-- config update triggered an affinity advisory lock.  Re-emit both routines
-- so the complete sorted affinity set is acquired first, matching bind order
-- and eliminating H -> transition / transition -> H deadlocks.
do $block$
declare
  v_definition text;
  v_marker text := '  select transition.* into v_transition' || chr(10)
    || '  from public.cloud_source_transitions transition' || chr(10);
  v_occurrences integer;
begin
  v_definition := replace(pg_catalog.pg_get_functiondef(
    'public.norva_begin_credential_swap(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text)'::regprocedure
  ), chr(13), '');
  v_occurrences := (
    length(v_definition) - length(replace(v_definition, v_marker, ''))
  ) / length(v_marker);
  if v_occurrences <> 1 then
    raise exception 'credential swap affinity lock rewrite drifted: % markers',
      v_occurrences using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_marker,
    '  perform public.norva_lock_credential_transition_account_affinities(' || chr(10)
    || '    p_transition_id, p_user_id' || chr(10)
    || '  );' || chr(10) || chr(10) || v_marker
  );
  execute v_definition;
end
$block$;

do $block$
declare
  v_definition text;
  v_marker text := '  select transition.* into v_transition from public.cloud_source_transitions transition' || chr(10);
  v_occurrences integer;
begin
  v_definition := replace(pg_catalog.pg_get_functiondef(
    'public.norva_restore_previous_credential_config(uuid,uuid,uuid,text,integer,bigint,bigint,bigint,text)'::regprocedure
  ), chr(13), '');
  v_occurrences := (
    length(v_definition) - length(replace(v_definition, v_marker, ''))
  ) / length(v_marker);
  if v_occurrences <> 1 then
    raise exception 'credential restore affinity lock rewrite drifted: % markers',
      v_occurrences using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_marker,
    '  perform public.norva_lock_credential_transition_account_affinities(' || chr(10)
    || '    p_transition_id, p_user_id' || chr(10)
    || '  );' || chr(10) || chr(10) || v_marker
  );
  execute v_definition;
end
$block$;

-- Keep the existing enrichment claim contract, but exclude any source that is
-- participating in non-terminal replacement or credential work.  The direct
-- fallback lease remains the atomic guarantee at fetch time.
do $block$
declare
  v_definition text;
  v_marker text := '    and source.deleted_at is null' || chr(10);
  v_replacement text;
  v_occurrences integer;
begin
  v_definition := replace(pg_catalog.pg_get_functiondef(
    'public.claim_catalog_enrichment_sources(integer,integer)'::regprocedure
  ), chr(13), '');
  v_occurrences := (
    length(v_definition) - length(replace(v_definition, v_marker, ''))
  ) / length(v_marker);
  if v_occurrences <> 2 then
    raise exception 'enrichment transition exclusion rewrite drifted: % markers',
      v_occurrences using errcode = '55000';
  end if;
  v_replacement := v_marker || $sql$
    and not exists (
      select 1
      from public.cloud_source_transitions transition
      where transition.user_id = source.user_id
        and (
          transition.old_source_id = source.id
          or transition.candidate_source_id = source.id
        )
        and transition.state not in ('completed', 'failed', 'cancelled')
    )
$sql$;
  v_definition := replace(v_definition, v_marker, v_replacement);
  execute v_definition;
end
$block$;

revoke all on function
  public.norva_claim_source_direct_fallback_lease(uuid,uuid,text,integer),
  public.norva_claim_source_direct_fallback_lease(uuid,uuid,text,integer,text,bigint,text),
  public.norva_release_source_direct_fallback_lease(uuid,uuid,uuid),
  public.norva_backfill_source_provider_account_affinities(integer),
  public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text),
  public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text,text)
from public, anon, authenticated, service_role;
revoke all on function
  public.norva_lock_provider_account_fallback_affinities(text[]),
  public.norva_assert_provider_account_fallback_leases_available(text[]),
  public.norva_assert_no_other_provider_account_transition(text[],uuid),
  public.norva_transition_provider_account_affinities(uuid,uuid),
  public.norva_lock_credential_transition_account_affinities(uuid,uuid),
  public.norva_assert_transition_account_fallback_available(uuid,uuid),
  public.norva_insert_source_provider_account_affinity(),
  public.norva_source_transition_fallback_lease_guard(),
  public.norva_provider_account_affinity_fallback_lease_guard()
from public, anon, authenticated, service_role;
revoke all on function
  public.norva_bind_credential_transition_account_affinity(uuid,uuid,text,bigint)
from public, anon, authenticated, service_role;
revoke all on function public.claim_catalog_enrichment_sources(integer,integer)
from public, anon, authenticated, service_role;
notify pgrst, 'reload schema';

commit;
