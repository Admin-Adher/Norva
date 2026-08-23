begin;
set local lock_timeout = '2s';
set local statement_timeout = '5min';

-- Late fail-closed compatibility layer.  The Phase 3 migration deliberately
-- does not rewrite historical migrations; this file replaces the active RPC
-- signatures used by current sync writers and disables every remaining
-- service-executable routine that reads a physical generation table without a
-- generation/head/central-visible fence.

-- Provider account affinity is operationally required for the mono-account
-- busy ledger, but username must not return to the public source hint.  Store
-- only the canonical account-key SHA-256 and switch it with the credential.
create table if not exists public.cloud_source_provider_account_affinities (
  source_id uuid primary key,
  user_id uuid not null,
  affinity_hash text not null check (affinity_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now(),
  unique (source_id,user_id)
);
alter table public.cloud_source_provider_account_affinities enable row level security;
revoke all on table public.cloud_source_provider_account_affinities
  from public,anon,authenticated,service_role;

-- Existing rows are deliberately not scanned here.  The immediately following
-- 174000 migration installs the future-write trigger and performs at most one
-- bounded catch-up batch; any remainder is handled by its bounded service RPC.

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
  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id=p_transition_id and transition.user_id=p_user_id for update;
  if not found then raise exception 'credential transition not found' using errcode='P0002'; end if;
  select secret.* into v_secret from public.cloud_source_transition_secrets secret
  where secret.transition_id=p_transition_id and secret.user_id=p_user_id for update;
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
  select affinity.affinity_hash into v_previous_hash
  from public.cloud_source_provider_account_affinities affinity
  where affinity.source_id=v_transition.old_source_id and affinity.user_id=p_user_id
  for share;
  update public.cloud_source_transition_secrets
  set candidate_account_affinity_hash=p_candidate_account_affinity_hash,
      previous_account_affinity_hash=v_previous_hash
  where transition_id=p_transition_id and user_id=p_user_id;
  update public.cloud_source_credential_transition_jobs
  set available_at=statement_timestamp()
  where transition_id=p_transition_id and user_id=p_user_id
    and job_kind='validate_candidate' and state='pending';
  return public.norva_credential_transition_result(p_transition_id,p_user_id);
end
$function$;

create or replace function public.norva_credential_job_affinity_guard()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
  if new.job_kind<>'validate_candidate' then return new; end if;
  if not exists (
    select 1 from public.cloud_source_transition_secrets secret
    where secret.transition_id=new.transition_id and secret.user_id=new.user_id
      and secret.candidate_account_affinity_hash is not null
  ) then
    if tg_op='INSERT' then
      new.available_at:='infinity'::timestamptz;
    elsif new.state='completed' then
      raise exception 'candidate provider account affinity is not bound' using errcode='55000';
    end if;
  end if;
  return new;
end
$function$;
create or replace function public.norva_switch_provider_account_affinity()
returns trigger language plpgsql security definer set search_path='' as $function$
declare
  v_transition_id uuid; v_candidate_hash text; v_previous_hash text;
  v_swap_applied_at timestamptz;
begin
  if new.config_ciphertext is not distinct from old.config_ciphertext then return new; end if;
  select transition.id,secret.candidate_account_affinity_hash,
    secret.previous_account_affinity_hash,secret.swap_applied_at
  into v_transition_id,v_candidate_hash,v_previous_hash,v_swap_applied_at
  from public.cloud_source_transitions transition
  join public.cloud_source_transition_secrets secret on secret.transition_id=transition.id
    and secret.user_id=transition.user_id
  where transition.old_source_id=new.id and transition.user_id=new.user_id
    and transition.transition_kind='credential' and transition.state='committing'
    and (secret.candidate_config_ciphertext=new.config_ciphertext
      or secret.previous_config_ciphertext=new.config_ciphertext)
  order by transition.started_at desc limit 1;
  if not found then return new; end if;
  if v_swap_applied_at is null and exists (
    select 1 from public.cloud_source_transition_secrets secret
    where secret.transition_id=v_transition_id
      and secret.candidate_config_ciphertext=new.config_ciphertext
  ) then
    if v_candidate_hash is null then
      raise exception 'candidate provider account affinity is not bound' using errcode='55000';
    end if;
    insert into public.cloud_source_provider_account_affinities(source_id,user_id,affinity_hash,updated_at)
    values(new.id,new.user_id,v_candidate_hash,clock_timestamp())
    on conflict(source_id) do update set user_id=excluded.user_id,
      affinity_hash=excluded.affinity_hash,updated_at=excluded.updated_at;
  elsif v_previous_hash is null then
    delete from public.cloud_source_provider_account_affinities
    where source_id=new.id and user_id=new.user_id;
  else
    insert into public.cloud_source_provider_account_affinities(source_id,user_id,affinity_hash,updated_at)
    values(new.id,new.user_id,v_previous_hash,clock_timestamp())
    on conflict(source_id) do update set user_id=excluded.user_id,
      affinity_hash=excluded.affinity_hash,updated_at=excluded.updated_at;
  end if;
  return new;
end
$function$;

create or replace function public.norva_clear_transition_affinity_hashes()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
  if new.cleared_at is not null then
    new.candidate_account_affinity_hash:=null;
    new.previous_account_affinity_hash:=null;
  end if;
  return new;
end
$function$;
create or replace function public.provider_account_touch_many(p_keys text[],p_kind text)
returns void language sql security definer set search_path='' as $function$
  insert into public.provider_account_activity as activity(account_key,last_seen_at,kind)
  select distinct encode(extensions.digest(key,'sha256'),'hex'),statement_timestamp(),
    pg_catalog.left(coalesce(p_kind,''),32)
  from pg_catalog.unnest(coalesce(p_keys,'{}'::text[])) key
  where key is not null and key<>'' and pg_catalog.length(key)<=300
  on conflict(account_key) do update set last_seen_at=excluded.last_seen_at,kind=excluded.kind
  where excluded.kind is distinct from 'language-validation'
    or activity.kind in ('presence','language-validation')
    or activity.last_seen_at<=excluded.last_seen_at-interval '5 minutes'
$function$;

-- Convert the short-lived legacy heartbeat ledger in bounded, retryable
-- service-owned batches.  The partial index installed immediately before this
-- file makes each SKIP LOCKED acquisition proportional to p_limit rather than
-- to the already-converted history.
create or replace function public.norva_migrate_provider_account_activity_affinities(
  p_limit integer
) returns jsonb
language plpgsql
security definer
set search_path=''
set lock_timeout='2s'
set statement_timeout='30s'
as $function$
declare
  v_inspected integer := 0;
  v_deleted integer := 0;
  v_upserted integer := 0;
  v_complete boolean := false;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'provider account activity migration limit must be between 1 and 500'
      using errcode='22023';
  end if;
  with candidates as materialized (
    select legacy.ctid, legacy.account_key, legacy.last_seen_at, legacy.kind,
      encode(extensions.digest(legacy.account_key,'sha256'),'hex') opaque_key
    from public.provider_account_activity legacy
    where legacy.account_key !~ '^[0-9a-f]{64}$'
    order by legacy.account_key
    limit p_limit
    for update skip locked
  ), upserted as (
    insert into public.provider_account_activity as activity(account_key,last_seen_at,kind)
    select candidate.opaque_key,candidate.last_seen_at,candidate.kind
    from candidates candidate
    on conflict(account_key) do update set
      last_seen_at=greatest(activity.last_seen_at,excluded.last_seen_at),
      kind=case when excluded.last_seen_at>=activity.last_seen_at
        then excluded.kind else activity.kind end
    returning 1
  ), deleted as (
    delete from public.provider_account_activity legacy
    using candidates candidate
    where legacy.ctid=candidate.ctid
      and legacy.account_key=candidate.account_key
    returning 1
  )
  select (select count(*) from candidates),
    (select count(*) from upserted),
    (select count(*) from deleted)
  into v_inspected,v_upserted,v_deleted;
  v_complete := not exists (
    select 1 from public.provider_account_activity legacy
    where legacy.account_key !~ '^[0-9a-f]{64}$'
  );
  return jsonb_build_object(
    'complete',v_complete,'inspectedRows',v_inspected,
    'upsertedRows',v_upserted,'deletedRows',v_deleted
  );
end
$function$;

-- Fail closed for the pre-split no-argument helper: it used to scan and delete
-- the entire ledger in one transaction.  Only the bounded signature below is
-- service executable.
create or replace function public.norva_migrate_provider_account_activity_affinities()
returns integer
language plpgsql
security definer
set search_path=''
as $function$
begin
  raise exception 'bounded provider account activity migration limit is required'
    using errcode='22023', detail='reason=bounded_limit_required';
end
$function$;

create or replace function public.provider_account_touch_by_source(p_source_id uuid,p_kind text)
returns void language sql security definer set search_path='' as $function$
  insert into public.provider_account_activity as activity(account_key,last_seen_at,kind)
  select opaque.account_key,
    statement_timestamp(),pg_catalog.left(coalesce(p_kind,''),32)
  from public.cloud_sources source
  cross join public.cloud_source_provider_account_affinity_rollout rollout
  left join public.cloud_source_provider_account_affinities affinity
    on affinity.source_id=source.id and affinity.user_id=source.user_id
  cross join lateral (
    select coalesce(affinity.affinity_hash,
      case when rollout.phase <> 'complete'
        and not exists (
          select 1 from public.admin_feature_flags flag
          where flag.key in (
            'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
            'provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled',
            'provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
          ) and flag.enabled
        )
        and source.source_type='xtream'
        and coalesce(btrim(source.config_hint->>'serverHost'),'')<>''
        and coalesce(btrim(source.config_hint->>'username'),'')<>''
      then encode(extensions.digest(
        lower(source.config_hint->>'serverHost') || '/'
          || (source.config_hint->>'username'),'sha256'),'hex') end
    ) as account_key
  ) opaque
  where source.id=p_source_id and source.deleted_at is null
    and opaque.account_key is not null
  on conflict(account_key) do update set last_seen_at=excluded.last_seen_at,kind=excluded.kind
$function$;

create or replace function public.provider_account_touch_by_user(p_user uuid,p_kind text)
returns void language sql security definer set search_path='' as $function$
  insert into public.provider_account_activity as activity(account_key,last_seen_at,kind)
  select distinct opaque.account_key,
    statement_timestamp(),pg_catalog.left(coalesce(p_kind,''),32)
  from public.cloud_sources source
  cross join public.cloud_source_provider_account_affinity_rollout rollout
  left join public.cloud_source_provider_account_affinities affinity
    on affinity.source_id=source.id and affinity.user_id=source.user_id
  cross join lateral (
    select coalesce(affinity.affinity_hash,
      case when rollout.phase <> 'complete'
        and not exists (
          select 1 from public.admin_feature_flags flag
          where flag.key in (
            'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
            'provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled',
            'provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
          ) and flag.enabled
        )
        and source.source_type='xtream'
        and coalesce(btrim(source.config_hint->>'serverHost'),'')<>''
        and coalesce(btrim(source.config_hint->>'username'),'')<>''
      then encode(extensions.digest(
        lower(source.config_hint->>'serverHost') || '/'
          || (source.config_hint->>'username'),'sha256'),'hex') end
    ) as account_key
  ) opaque
  where source.user_id=p_user and source.deleted_at is null
    and opaque.account_key is not null
  on conflict(account_key) do update set last_seen_at=excluded.last_seen_at,kind=excluded.kind
  where excluded.kind is distinct from 'presence' or activity.kind='presence'
    or activity.last_seen_at<=excluded.last_seen_at-interval '5 minutes'
$function$;

create or replace function public.provider_account_busy(p_key text)
returns boolean language sql stable security definer set search_path='' as $function$
  select coalesce((select bool_or(
      activity.last_seen_at>statement_timestamp()-interval '5 minutes'
    )
    from public.provider_account_activity activity
    where activity.account_key in (
      p_key,encode(extensions.digest(p_key,'sha256'),'hex')
    )),false)
$function$;

create or replace function public.provider_account_busy_for_foreground_validation(p_key text)
returns boolean language sql stable security definer set search_path='' as $function$
  select coalesce((select bool_or(
      activity.last_seen_at>statement_timestamp()-interval '5 minutes'
        and activity.kind is distinct from 'presence'
        and activity.kind is distinct from 'language-validation'
    )
    from public.provider_account_activity activity
    where activity.account_key in (
      p_key,encode(extensions.digest(p_key,'sha256'),'hex')
    )),false)
$function$;

-- The historical admin health RPC predates generation heads and derived the
-- provider activity key from the public config hint. Re-emit the same routine
-- from its authoritative definition while replacing only the four unsafe
-- fragments: affinity lookup, active variant head, and active episode head.
-- Abort the migration if the historical definition drifts instead of silently
-- leaving an unsafe diagnostic executable.
do $block$
declare
  v_definition text := pg_get_functiondef(
    'public.admin_enrichment_engine_health()'::regprocedure
  );
  v_before text;
begin
  -- Historical migration files were loaded with CRLF on Windows. Normalize
  -- the stored body before exact fail-closed fragment replacement.
  v_definition := replace(v_definition, chr(13), '');
  if v_definition like '%affinity.affinity_hash as provider_account_key%'
     and v_definition like '%variant.generation_id = variant_head.active_generation_id%'
     and v_definition like '%membership_head.active_generation_id = membership.generation_id%' then
    return;
  end if;
  v_before := v_definition;
  v_definition := replace(v_definition, $old$
        case
          when coalesce(source.config_hint->>'serverHost', '') <> ''
           and coalesce(source.config_hint->>'username', '') <> ''
            then lower(source.config_hint->>'serverHost')
              || '/'
              || (source.config_hint->>'username')
          else null
        end as provider_account_key,$old$, $new$
        affinity.affinity_hash as provider_account_key,$new$);
  if v_definition = v_before then
    raise exception 'admin health provider affinity rewrite did not match' using errcode='55000';
  end if;

  v_before := v_definition;
  v_definition := replace(v_definition, $old$
      left join public.provider_identities provider_identity
        on provider_identity.id = identity.identity_id
    ),$old$, $new$
      left join public.provider_identities provider_identity
        on provider_identity.id = identity.identity_id
      left join public.cloud_source_provider_account_affinities affinity
        on affinity.source_id = source.id
       and affinity.user_id = source.user_id
    ),$new$);
  if v_definition = v_before then
    raise exception 'admin health affinity join rewrite did not match' using errcode='55000';
  end if;

  v_before := v_definition;
  v_definition := replace(v_definition, $old$
      join public.cloud_title_variants variant
        on variant.source_id = driver.source_id
       and variant.user_id = driver.user_id
       and variant.item_type in ('movie', 'series')$old$, $new$
      join public.cloud_source_catalog_heads variant_head
        on variant_head.source_id = driver.source_id
       and variant_head.user_id = driver.user_id
      join public.cloud_title_variants variant
        on variant.source_id = driver.source_id
       and variant.user_id = driver.user_id
       and variant.generation_id = variant_head.active_generation_id
       and variant.item_type in ('movie', 'series')$new$);
  if v_definition = v_before then
    raise exception 'admin health active variant rewrite did not match' using errcode='55000';
  end if;

  v_before := v_definition;
  v_definition := replace(v_definition, $old$
      from public.catalog_series_episode_memberships membership
      join source_types source_type
        on source_type.source_id = membership.source_id
       and source_type.user_id = membership.user_id
       and source_type.item_type = 'series'$old$, $new$
      from public.catalog_series_episode_memberships membership
      join public.cloud_source_catalog_heads membership_head
        on membership_head.source_id = membership.source_id
       and membership_head.user_id = membership.user_id
       and membership_head.active_generation_id = membership.generation_id
      join source_types source_type
        on source_type.source_id = membership.source_id
       and source_type.user_id = membership.user_id
       and source_type.item_type = 'series'$new$);
  if v_definition = v_before then
    raise exception 'admin health active episode rewrite did not match' using errcode='55000';
  end if;

  execute v_definition;
end
$block$;

revoke all on function public.admin_enrichment_engine_health()
  from public,anon,authenticated,service_role;
grant execute on function public.admin_enrichment_engine_health()
  to authenticated;

-- Internal active-series projections complete the same head boundary used by
-- the four public catalogue projections. They are never Data-API readable.
create or replace view public.cloud_catalog_visible_series_episode_memberships
with (security_barrier=true) as
select membership.*
from public.catalog_series_episode_memberships membership
join public.cloud_source_catalog_heads head
  on head.source_id=membership.source_id
 and head.user_id=membership.user_id
 and head.active_generation_id=membership.generation_id
join public.cloud_catalog_visible_sources source
  on source.id=membership.source_id and source.user_id=membership.user_id;

create or replace view public.cloud_catalog_visible_series_inventory_state
with (security_barrier=true) as
select inventory.*
from public.catalog_series_inventory_state inventory
join public.cloud_source_catalog_heads head
  on head.source_id=inventory.source_id
 and head.user_id=inventory.user_id
 and head.active_generation_id=inventory.generation_id
join public.cloud_catalog_visible_sources source
  on source.id=inventory.source_id and source.user_id=inventory.user_id;

revoke all on public.cloud_catalog_visible_series_episode_memberships,
  public.cloud_catalog_visible_series_inventory_state
  from public,anon,authenticated,service_role;

-- Re-emit current service read/derivation callers with their exact signatures
-- and return contracts. Only FROM/JOIN targets are changed; return row types
-- and writes to non-generation ledgers remain untouched. Any routine whose
-- body still names a physical generation table is left for the fail-closed
-- revocation pass below.
do $block$
declare
  routine record;
  v_definition text;
  v_body text;
begin
  for routine in
    select proc.oid
    from pg_proc proc
    where proc.pronamespace='public'::regnamespace
      and proc.proname=any(array[
        'audio_backfill_candidates','file_audio_backfill_candidates',
        'fill_user_audio_from_catalog','finalize_catalog_file_audio_validation_job',
        'catalog_series_episode_coordinates_by_episode',
        'catalog_episode_probe_retry_state','whitelist_subtitle_candidates',
        'file_audio_tag_suspect_variants','file_whisper_candidate_variants',
        'whisper_candidate_titles','catalog_media_mirror_diff',
        'fanout_episode_file_tracks_to_users','fanout_detected_file_tracks_to_users',
        'fanout_file_tracks_to_users','refresh_catalog_file_audio_detection_provenance',
        'record_catalog_file_audio_whisper_outcome',
        'claim_provider_overview_candidates','top_viewed_titles',
        'search_media_items','list_media_items_deduped'
      ]::name[])
  loop
    v_definition:=replace(pg_get_functiondef(routine.oid),chr(13),'');
    v_definition:=replace(v_definition,'from public.cloud_media_items',
      'from public.cloud_catalog_visible_media_items');
    v_definition:=replace(v_definition,'join public.cloud_media_items',
      'join public.cloud_catalog_visible_media_items');
    v_definition:=replace(v_definition,'from public.cloud_title_variants',
      'from public.cloud_catalog_visible_title_variants');
    v_definition:=replace(v_definition,'join public.cloud_title_variants',
      'join public.cloud_catalog_visible_title_variants');
    v_definition:=replace(v_definition,'from public.cloud_live_logical_channels',
      'from public.cloud_catalog_visible_live_logical_channels');
    v_definition:=replace(v_definition,'join public.cloud_live_logical_channels',
      'join public.cloud_catalog_visible_live_logical_channels');
    v_definition:=replace(v_definition,'from public.cloud_live_variants',
      'from public.cloud_catalog_visible_live_variants');
    v_definition:=replace(v_definition,'join public.cloud_live_variants',
      'join public.cloud_catalog_visible_live_variants');
    v_definition:=replace(v_definition,'from public.catalog_series_episode_memberships',
      'from public.cloud_catalog_visible_series_episode_memberships');
    v_definition:=replace(v_definition,'join public.catalog_series_episode_memberships',
      'join public.cloud_catalog_visible_series_episode_memberships');
    v_definition:=replace(v_definition,'from public.catalog_series_inventory_state',
      'from public.cloud_catalog_visible_series_inventory_state');
    v_definition:=replace(v_definition,'join public.catalog_series_inventory_state',
      'join public.cloud_catalog_visible_series_inventory_state');
    v_definition:=replace(v_definition,'from cloud_media_items',
      'from public.cloud_catalog_visible_media_items');
    v_definition:=replace(v_definition,'join cloud_media_items',
      'join public.cloud_catalog_visible_media_items');
    v_definition:=replace(v_definition,'from cloud_title_variants',
      'from public.cloud_catalog_visible_title_variants');
    v_definition:=replace(v_definition,'join cloud_title_variants',
      'join public.cloud_catalog_visible_title_variants');
    v_definition:=replace(v_definition,'from cloud_live_logical_channels',
      'from public.cloud_catalog_visible_live_logical_channels');
    v_definition:=replace(v_definition,'join cloud_live_logical_channels',
      'join public.cloud_catalog_visible_live_logical_channels');
    v_definition:=replace(v_definition,'from cloud_live_variants',
      'from public.cloud_catalog_visible_live_variants');
    v_definition:=replace(v_definition,'join cloud_live_variants',
      'join public.cloud_catalog_visible_live_variants');
    v_definition:=replace(v_definition,'from catalog_series_episode_memberships',
      'from public.cloud_catalog_visible_series_episode_memberships');
    v_definition:=replace(v_definition,'join catalog_series_episode_memberships',
      'join public.cloud_catalog_visible_series_episode_memberships');
    v_definition:=replace(v_definition,'from catalog_series_inventory_state',
      'from public.cloud_catalog_visible_series_inventory_state');
    v_definition:=replace(v_definition,'join catalog_series_inventory_state',
      'join public.cloud_catalog_visible_series_inventory_state');
    execute v_definition;
    select lower(proc.prosrc) into v_body from pg_proc proc where proc.oid=routine.oid;
    if v_body !~ 'cloud_media_items|cloud_title_variants|cloud_live_logical_channels|cloud_live_variants|catalog_series_episode_memberships|catalog_series_inventory_state' then
      execute format('revoke all on function %s from public,anon,authenticated,service_role',routine.oid::regprocedure);
      execute format('grant execute on function %s to service_role',routine.oid::regprocedure);
    elsif v_body like '%cloud_catalog_visible_%' and v_body !~
      '(^|[^a-z_])(public\.)?(cloud_media_items|cloud_title_variants|cloud_live_logical_channels|cloud_live_variants|catalog_series_episode_memberships|catalog_series_inventory_state)([^a-z_]|$)' then
      execute format('revoke all on function %s from public,anon,authenticated,service_role',routine.oid::regprocedure);
      execute format('grant execute on function %s to service_role',routine.oid::regprocedure);
    end if;
  end loop;
end
$block$;

-- The old reset RPC rewrote and deleted an entire candidate generation in one
-- transaction and has no current caller. Keep the signature unavailable until
-- a resumable purge workflow owns it.
revoke all on function public.norva_reset_credential_catalog_generation(
  uuid,uuid,uuid,uuid,text,integer
) from public,anon,authenticated,service_role;

-- Clear live materialization with one global per-call budget. Callers must
-- resume until complete. The historical seven-argument signature remains
-- executable during DB-first/code-first rolling deployment and is revoked
-- only by the explicit online contract after caller-version evidence.
create or replace function public.norva_clear_catalog_generation_live_materialization_batch(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_limit integer default 1000
) returns jsonb
language plpgsql volatile security definer set search_path='' as $function$
declare
  v_variants integer:=0;
  v_channels integer:=0;
  v_budget integer;
  v_complete boolean;
begin
  if p_limit is null or p_limit<1 or p_limit>2000 then
    raise exception 'live materialization batch limit is invalid' using errcode='22023';
  end if;
  perform public.norva_set_catalog_delete_proof(
    p_source_id,p_user_id,p_generation_id,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  v_budget:=p_limit;
  with doomed as (
    select row.ctid from public.cloud_live_variants row
    where row.source_id=p_source_id and row.user_id=p_user_id
      and row.generation_id=p_generation_id
    limit v_budget
  )
  delete from public.cloud_live_variants row using doomed
  where row.ctid=doomed.ctid;
  get diagnostics v_variants=row_count;
  v_budget:=v_budget-v_variants;
  if v_budget>0 then
    with doomed as (
      select row.ctid from public.cloud_live_logical_channels row
      where row.source_id=p_source_id and row.user_id=p_user_id
        and row.generation_id=p_generation_id
      limit v_budget
    )
    delete from public.cloud_live_logical_channels row using doomed
    where row.ctid=doomed.ctid;
    get diagnostics v_channels=row_count;
  end if;
  v_complete:=not exists(select 1 from public.cloud_live_variants
      where source_id=p_source_id and user_id=p_user_id and generation_id=p_generation_id)
    and not exists(select 1 from public.cloud_live_logical_channels
      where source_id=p_source_id and user_id=p_user_id and generation_id=p_generation_id);
  return jsonb_build_object('deletedVariants',v_variants,
    'deletedChannels',v_channels,'deletedRows',v_variants+v_channels,
    'complete',v_complete);
end
$function$;

revoke all on function public.norva_clear_catalog_generation_live_materialization_batch(
  uuid,uuid,uuid,bigint,bigint,bigint,bigint,integer
) from public,anon,authenticated,service_role;
grant execute on function public.norva_clear_catalog_generation_live_materialization_batch(
  uuid,uuid,uuid,bigint,bigint,bigint,bigint,integer
) to service_role;
grant execute on function public.norva_clear_catalog_generation_live_materialization(
  uuid,uuid,uuid,bigint,bigint,bigint,bigint
) to service_role;

-- Cancellation/failure cleanup consumes one global budget across all six
-- physical tables. Completion uses indexed EXISTS probes, never six exact
-- COUNT(*) scans.
create or replace function public.norva_purge_cancelled_credential_generation_batch(
  p_generation_id uuid,
  p_user_id uuid,
  p_limit integer default 200
) returns jsonb
language plpgsql volatile security definer set search_path='' as $function$
declare
  v_budget integer;
  v_deleted integer:=0;
  v_count integer;
  v_remaining boolean;
begin
  perform public.norva_credential_require_service_role();
  if p_limit is null or p_limit<1 or p_limit>1000 then
    raise exception 'purge batch limit is invalid' using errcode='22023';
  end if;
  if not exists (
    select 1
    from public.cloud_source_catalog_generations generation
    join public.cloud_source_transitions transition
      on transition.id=generation.transition_id
     and transition.user_id=generation.user_id
    where generation.id=p_generation_id and generation.user_id=p_user_id
      and generation.state='purging'
      and transition.state in ('cancelled','failed')
    for update of generation
  ) then
    raise exception 'terminal generation purge CAS failed' using errcode='40001';
  end if;
  perform set_config('norva.catalog_purge_generation',p_generation_id::text,true);
  v_budget:=p_limit;

  with doomed as (select row.ctid from public.catalog_series_episode_memberships row
    where row.generation_id=p_generation_id limit v_budget)
  delete from public.catalog_series_episode_memberships row using doomed
    where row.ctid=doomed.ctid;
  get diagnostics v_count=row_count; v_deleted:=v_deleted+v_count; v_budget:=v_budget-v_count;
  if v_budget>0 then
    with doomed as (select row.ctid from public.catalog_series_inventory_state row
      where row.generation_id=p_generation_id limit v_budget)
    delete from public.catalog_series_inventory_state row using doomed where row.ctid=doomed.ctid;
    get diagnostics v_count=row_count; v_deleted:=v_deleted+v_count; v_budget:=v_budget-v_count;
  end if;
  if v_budget>0 then
    with doomed as (select row.ctid from public.cloud_live_variants row
      where row.generation_id=p_generation_id limit v_budget)
    delete from public.cloud_live_variants row using doomed where row.ctid=doomed.ctid;
    get diagnostics v_count=row_count; v_deleted:=v_deleted+v_count; v_budget:=v_budget-v_count;
  end if;
  if v_budget>0 then
    with doomed as (select row.ctid from public.cloud_live_logical_channels row
      where row.generation_id=p_generation_id limit v_budget)
    delete from public.cloud_live_logical_channels row using doomed where row.ctid=doomed.ctid;
    get diagnostics v_count=row_count; v_deleted:=v_deleted+v_count; v_budget:=v_budget-v_count;
  end if;
  if v_budget>0 then
    with doomed as (select row.ctid from public.cloud_title_variants row
      where row.generation_id=p_generation_id limit v_budget)
    delete from public.cloud_title_variants row using doomed where row.ctid=doomed.ctid;
    get diagnostics v_count=row_count; v_deleted:=v_deleted+v_count; v_budget:=v_budget-v_count;
  end if;
  if v_budget>0 then
    with doomed as (select row.ctid from public.cloud_media_items row
      where row.generation_id=p_generation_id limit v_budget)
    delete from public.cloud_media_items row using doomed where row.ctid=doomed.ctid;
    get diagnostics v_count=row_count; v_deleted:=v_deleted+v_count; v_budget:=v_budget-v_count;
  end if;
  perform set_config('norva.catalog_purge_generation','',true);

  v_remaining := exists(select 1 from public.catalog_series_episode_memberships where generation_id=p_generation_id)
    or exists(select 1 from public.catalog_series_inventory_state where generation_id=p_generation_id)
    or exists(select 1 from public.cloud_live_variants where generation_id=p_generation_id)
    or exists(select 1 from public.cloud_live_logical_channels where generation_id=p_generation_id)
    or exists(select 1 from public.cloud_title_variants where generation_id=p_generation_id)
    or exists(select 1 from public.cloud_media_items where generation_id=p_generation_id);
  if not v_remaining then
    delete from public.cloud_source_catalog_generation_categories where generation_id=p_generation_id;
    delete from public.cloud_source_catalog_generation_category_lists where generation_id=p_generation_id;
    delete from public.cloud_source_catalog_generation_inventory_actions where generation_id=p_generation_id;
    delete from public.cloud_source_catalog_generation_episode_copy where generation_id=p_generation_id;
    update public.cloud_source_catalog_generations
    set state='failed',revision=revision+1,updated_at=now()
    where id=p_generation_id;
  end if;
  return jsonb_build_object('generationId',p_generation_id,
    'deletedRows',v_deleted,'remainingRows',case when v_remaining then null else 0 end,
    'complete',not v_remaining);
end
$function$;

create or replace function public.heal_cloud_title_variants(
  p_user_id uuid,
  p_source_id uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint
) returns integer
language plpgsql volatile security definer set search_path = '' as $function$
declare v_inserted integer;
begin
  perform public.norva_set_catalog_delete_proof(
    p_source_id,p_user_id,p_generation_id,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  insert into public.cloud_title_variants (
    user_id,title_id,source_id,item_type,external_id,raw_title,poster_url,
    container_extension,playback_hint,metadata,generation_id,
    write_head_revision,write_config_revision,
    write_source_visibility_epoch,write_user_visibility_epoch
  )
  select item.user_id,title.id,item.source_id,item.item_type,item.external_id,
    item.title,item.poster_url,
    coalesce(nullif(item.playback_hint->>'container',''),
      case when item.item_type='movie' then 'mp4' else '' end),
    coalesce(item.playback_hint,'{}'::jsonb),
    jsonb_strip_nulls(jsonb_build_object(
      'categoryName',item.subtitle,'providerTmdbId',item.playback_hint->>'providerTmdbId',
      'identityKey',title.identity_key,'healed',true)),p_generation_id,
    p_head_revision,p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch
  from public.cloud_media_items item
  join public.cloud_titles title on title.user_id=item.user_id
    and title.item_type=item.item_type
    and title.identity_key='tmdb:'||(item.playback_hint->>'providerTmdbId')
  where item.user_id=p_user_id and item.source_id=p_source_id
    and item.generation_id=p_generation_id
    and coalesce(item.playback_hint->>'providerTmdbId','0') not in ('','0')
    and title.match_status='provider_verified'
  on conflict (source_id,generation_id,item_type,external_id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$function$;

create or replace function public.propagate_media_item_years(
  p_user uuid,
  p_source uuid,
  p_item_ids uuid[],
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint
) returns void
language plpgsql volatile security definer set search_path = '' as $function$
begin
  perform public.norva_set_catalog_delete_proof(
    p_source,p_user,p_generation_id,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  update public.cloud_media_items item
  set release_year=title.release_year,
      write_head_revision=p_head_revision,
      write_config_revision=p_config_revision,
      write_source_visibility_epoch=p_source_visibility_epoch,
      write_user_visibility_epoch=p_user_visibility_epoch
  from public.cloud_titles title
  where item.user_id=p_user and item.source_id=p_source
    and item.generation_id=p_generation_id
    and item.item_type in ('movie','series')
    and (p_item_ids is null or item.id=any(p_item_ids))
    and title.user_id=item.user_id and title.item_type=item.item_type
    and title.provider_tmdb_id=item.metadata->>'providerTmdbId'
    and title.provider_tmdb_id not in ('0','')
    and title.release_year is not null
    and item.release_year is distinct from title.release_year;
end
$function$;

create or replace function public.norva_hydrate_source_category_names(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_item_type text,
  p_limit integer default 2000
) returns integer
language plpgsql volatile security definer set search_path = '' as $function$
declare v_changed integer;
begin
  if p_item_type not in ('movie','series') or p_limit < 1 or p_limit > 20000 then
    raise exception 'category hydration bounds are invalid' using errcode='22023';
  end if;
  perform public.norva_set_catalog_delete_proof(
    p_source_id,p_user_id,p_generation_id,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  with targets as materialized (
    select item.id,item.external_id
    from public.cloud_media_items item
    where item.source_id=p_source_id and item.user_id=p_user_id
      and item.generation_id=p_generation_id and item.item_type=p_item_type
      and nullif(btrim(item.subtitle),'') is null
    order by item.id limit p_limit
  ), donor_names as materialized (
    select target.id,min(btrim(donor.subtitle)) category_name,
      count(distinct btrim(donor.subtitle)) distinct_names
    from targets target
    join public.catalog_source_provider_identities own_link on own_link.source_id=p_source_id
    join public.catalog_source_provider_identities donor_link
      on donor_link.identity_id=own_link.identity_id and donor_link.source_id<>p_source_id
    join public.cloud_source_catalog_heads donor_head on donor_head.source_id=donor_link.source_id
    join public.cloud_media_items donor on donor.source_id=donor_link.source_id
      and donor.generation_id=donor_head.active_generation_id
      and donor.item_type=p_item_type and donor.external_id=target.external_id
      and nullif(btrim(donor.subtitle),'') is not null
    group by target.id
  ), candidates as materialized (
    select id,category_name from donor_names where distinct_names=1
  ), changed as (
    update public.cloud_media_items item
    set subtitle=candidate.category_name,
      metadata=jsonb_set(coalesce(item.metadata,'{}'::jsonb),'{categoryName}',
        to_jsonb(candidate.category_name),true),
      write_head_revision=p_head_revision,write_config_revision=p_config_revision,
      write_source_visibility_epoch=p_source_visibility_epoch,
      write_user_visibility_epoch=p_user_visibility_epoch
    from candidates candidate
    where item.id=candidate.id and item.generation_id=p_generation_id
    returning item.id,candidate.category_name
  )
  update public.cloud_title_variants variant
  set metadata=jsonb_set(coalesce(variant.metadata,'{}'::jsonb),'{categoryName}',
        to_jsonb(changed.category_name),true),
      write_head_revision=p_head_revision,write_config_revision=p_config_revision,
      write_source_visibility_epoch=p_source_visibility_epoch,
      write_user_visibility_epoch=p_user_visibility_epoch
  from changed
  where variant.media_item_id=changed.id and variant.generation_id=p_generation_id;
  get diagnostics v_changed = row_count;
  return v_changed;
end
$function$;

-- Current enrichment writers pass the same immutable active-catalog fence to
-- every series/file-language RPC.  These overloads deliberately do not carry
-- defaults: PostgREST must resolve the fully fenced signature or fail closed.
create or replace function public.register_catalog_series_episodes(
  p_user_id uuid,
  p_source_id uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_parent_series_id text,
  p_payload jsonb
) returns integer
language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_variant_id uuid;
  v_title_id uuid;
  v_identity_id uuid;
  v_episode_count integer := 0;
  v_invalid text;
  v_duplicate text;
  v_payload_fingerprint text;
begin
  perform public.norva_set_catalog_delete_proof(
    p_source_id,p_user_id,p_generation_id,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  if coalesce(btrim(p_parent_series_id),'')='' or length(btrim(p_parent_series_id))>255
     or jsonb_typeof(p_payload) is distinct from 'object'
     or coalesce(jsonb_typeof(p_payload->'episodes'),'') not in ('object','array') then
    raise exception 'Owned source, parent series id and series-info episodes are required'
      using errcode='22023';
  end if;

  select variant.id,variant.title_id,identity.identity_id
  into v_variant_id,v_title_id,v_identity_id
  from public.cloud_title_variants variant
  join public.cloud_titles title on title.id=variant.title_id
    and title.user_id=variant.user_id and title.item_type=variant.item_type
  join public.cloud_sources source on source.id=variant.source_id
    and source.user_id=variant.user_id and source.deleted_at is null
    and source.enabled=true and source.source_type='xtream'
  join public.catalog_source_provider_identities identity
    on identity.source_id=source.id and identity.user_id=source.user_id
  where variant.user_id=p_user_id and variant.source_id=p_source_id
    and variant.generation_id=p_generation_id and variant.item_type='series'
    and variant.external_id=btrim(p_parent_series_id) and variant.title_id is not null
  for key share of variant,source;
  if not found then
    raise exception 'Parent series variant is not owned or lacks a verified provider identity'
      using errcode='42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'catalog-series-episode-provider:'||v_identity_id::text||':'||p_generation_id::text,0
  ));
  select rows.validation_error into v_invalid
  from public.catalog_series_info_episode_rows(p_payload) rows
  where rows.validation_error is not null order by rows.validation_error limit 1;
  if v_invalid is not null then
    raise exception 'Invalid series-info episode payload: %',v_invalid using errcode='22023';
  end if;
  select duplicate.episode_id into v_duplicate
  from (
    select rows.episode_id
    from public.catalog_series_info_episode_rows(p_payload) rows
    where rows.validation_error is null group by rows.episode_id
    having count(distinct jsonb_build_object(
      'container',rows.container_extension,'season',rows.season_number,
      'episode',rows.episode_number))>1
  ) duplicate order by duplicate.episode_id limit 1;
  if v_duplicate is not null then
    raise exception 'Series-info repeats episode id % with conflicting coordinates',v_duplicate
      using errcode='22023';
  end if;
  select count(distinct rows.episode_id)::integer into v_episode_count
  from public.catalog_series_info_episode_rows(p_payload) rows
  where rows.validation_error is null;
  if v_episode_count=0 then return 0; end if;

  if exists (
    select 1 from public.catalog_series_info_episode_rows(p_payload) incoming
    join public.catalog_series_episode_memberships existing
      on existing.generation_id=p_generation_id
     and existing.provider_identity_id=v_identity_id
     and existing.episode_id=incoming.episode_id
    where incoming.validation_error is null
      and existing.parent_series_id is distinct from btrim(p_parent_series_id)
  ) then
    raise exception 'Series-info contains a provider episode id already proven for another parent'
      using errcode='23505';
  end if;
  v_payload_fingerprint:=md5(p_payload::text);

  insert into public.catalog_series_episode_memberships as membership (
    user_id,source_id,provider_identity_id,parent_title_id,parent_variant_id,
    parent_item_type,parent_series_id,episode_id,container_extension,
    season_number,episode_number,payload_fingerprint,series_info_observed_at,
    created_at,updated_at,generation_id,write_head_revision,
    write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch
  )
  select distinct on (rows.episode_id)
    p_user_id,p_source_id,v_identity_id,v_title_id,v_variant_id,'series',
    btrim(p_parent_series_id),rows.episode_id,rows.container_extension,
    rows.season_number,rows.episode_number,v_payload_fingerprint,
    clock_timestamp(),clock_timestamp(),clock_timestamp(),p_generation_id,
    p_head_revision,p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch
  from public.catalog_series_info_episode_rows(p_payload) rows
  where rows.validation_error is null
  order by rows.episode_id,rows.season_number nulls last,rows.episode_number nulls last
  on conflict (source_id,generation_id,parent_series_id,episode_id) do update set
    user_id=excluded.user_id,provider_identity_id=excluded.provider_identity_id,
    parent_title_id=excluded.parent_title_id,parent_variant_id=excluded.parent_variant_id,
    parent_item_type='series',container_extension=excluded.container_extension,
    season_number=excluded.season_number,episode_number=excluded.episode_number,
    payload_fingerprint=excluded.payload_fingerprint,
    series_info_observed_at=excluded.series_info_observed_at,
    updated_at=clock_timestamp(),write_head_revision=p_head_revision,
    write_config_revision=p_config_revision,
    write_source_visibility_epoch=p_source_visibility_epoch,
    write_user_visibility_epoch=p_user_visibility_epoch;

  delete from public.catalog_series_episode_memberships existing
  where existing.user_id=p_user_id and existing.source_id=p_source_id
    and existing.generation_id=p_generation_id
    and existing.parent_series_id=btrim(p_parent_series_id)
    and not exists (
      select 1 from public.catalog_series_info_episode_rows(p_payload) incoming
      where incoming.validation_error is null and incoming.episode_id=existing.episode_id
    );
  return v_episode_count;
end
$function$;

create or replace function public.record_catalog_series_inventory_outcome(
  p_user uuid,
  p_source uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_parent_series_id text,
  p_success boolean,
  p_episode_count integer,
  p_retry_at timestamptz,
  p_details jsonb
) returns boolean
language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_variant_id uuid; v_title_id uuid; v_identity_id uuid;
  v_prior_failures integer:=0; v_registered integer:=0;
  v_now timestamptz:=clock_timestamp(); v_retry_at timestamptz;
begin
  perform public.norva_set_catalog_delete_proof(
    p_source,p_user,p_generation_id,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  if coalesce(btrim(p_parent_series_id),'')='' or length(btrim(p_parent_series_id))>255
     or p_success is null or (p_success and (p_episode_count is null or p_episode_count<=0))
     or (p_episode_count is not null and p_episode_count<0)
     or jsonb_typeof(coalesce(p_details,'{}'::jsonb)) is distinct from 'object'
     or octet_length(coalesce(p_details,'{}'::jsonb)::text)>32768 then
    raise exception 'Invalid exact series inventory outcome' using errcode='22023';
  end if;
  select variant.id,variant.title_id,identity.identity_id
  into v_variant_id,v_title_id,v_identity_id
  from public.cloud_title_variants variant
  join public.cloud_titles title on title.id=variant.title_id
    and title.user_id=variant.user_id and title.item_type=variant.item_type
  join public.cloud_sources source on source.id=variant.source_id
    and source.user_id=variant.user_id and source.deleted_at is null
    and source.enabled=true and source.sync_status='ready' and source.source_type='xtream'
  join public.catalog_source_provider_identities identity
    on identity.source_id=source.id and identity.user_id=source.user_id
  where variant.user_id=p_user and variant.source_id=p_source
    and variant.generation_id=p_generation_id and variant.item_type='series'
    and variant.external_id=btrim(p_parent_series_id) and variant.title_id is not null
  for key share of variant,source;
  if not found then return false; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'catalog-series-episode-provider:'||v_identity_id::text||':'||p_generation_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'catalog-series-inventory:'||p_source::text||':'||p_generation_id::text||':'||btrim(p_parent_series_id),0));
  if p_success then
    select count(*)::integer into v_registered
    from public.catalog_series_episode_memberships membership
    where membership.user_id=p_user and membership.source_id=p_source
      and membership.generation_id=p_generation_id
      and membership.provider_identity_id=v_identity_id
      and membership.parent_variant_id=v_variant_id
      and membership.parent_series_id=btrim(p_parent_series_id);
    if v_registered<>p_episode_count then
      raise exception 'Series inventory outcome does not match the exact registered episode set'
        using errcode='23514';
    end if;
  end if;
  select inventory.consecutive_failures into v_prior_failures
  from public.catalog_series_inventory_state inventory
  where inventory.source_id=p_source and inventory.generation_id=p_generation_id
    and inventory.parent_series_id=btrim(p_parent_series_id) for update;
  v_prior_failures:=coalesce(v_prior_failures,0);
  v_retry_at:=case
    when p_retry_at is not null then greatest(v_now+interval '1 minute',least(v_now+interval '30 days',p_retry_at))
    when p_success then v_now+interval '24 hours'
    else v_now+make_interval(mins=>least(1440,15*power(2::numeric,least(6,v_prior_failures))::integer)) end;

  insert into public.catalog_series_inventory_state as inventory (
    user_id,source_id,provider_identity_id,parent_title_id,parent_variant_id,
    parent_item_type,parent_series_id,consecutive_failures,episode_count,
    last_attempted_at,last_succeeded_at,last_failed_at,next_retry_at,last_details,
    created_at,updated_at,generation_id,write_head_revision,write_config_revision,
    write_source_visibility_epoch,write_user_visibility_epoch
  ) values (
    p_user,p_source,v_identity_id,v_title_id,v_variant_id,'series',btrim(p_parent_series_id),
    case when p_success then 0 else 1 end,case when p_success then p_episode_count else null end,
    v_now,case when p_success then v_now else null end,case when p_success then null else v_now end,
    v_retry_at,coalesce(p_details,'{}'::jsonb),v_now,v_now,p_generation_id,
    p_head_revision,p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch
  )
  on conflict (source_id,generation_id,parent_series_id) do update set
    user_id=excluded.user_id,provider_identity_id=excluded.provider_identity_id,
    parent_title_id=excluded.parent_title_id,parent_variant_id=excluded.parent_variant_id,
    parent_item_type='series',consecutive_failures=case when p_success then 0 else least(12,inventory.consecutive_failures+1) end,
    episode_count=case when p_success then excluded.episode_count else inventory.episode_count end,
    last_attempted_at=v_now,last_succeeded_at=case when p_success then v_now else inventory.last_succeeded_at end,
    last_failed_at=case when p_success then inventory.last_failed_at else v_now end,
    next_retry_at=v_retry_at,last_details=excluded.last_details,updated_at=v_now,
    write_head_revision=p_head_revision,write_config_revision=p_config_revision,
    write_source_visibility_epoch=p_source_visibility_epoch,
    write_user_visibility_epoch=p_user_visibility_epoch;
  return true;
end
$function$;

create or replace function public.recompute_cloud_title_file_languages(
  p_user_id uuid,p_title_id uuid
) returns boolean
language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_audio text[]:='{}'::text[]; v_verified text[]:='{}'::text[];
  v_subtitles text[]:='{}'::text[]; v_item_type text;
begin
  if p_user_id is null or p_title_id is null then return false; end if;
  perform 1 from public.cloud_titles title
  where title.user_id=p_user_id and title.id=p_title_id for update;
  if not found then return false; end if;
  select coalesce(array_agg(distinct language_code order by language_code),'{}'::text[])
  into v_audio
  from public.cloud_title_file_language_observations observation
  join public.cloud_title_variants variant on variant.id=observation.variant_id
    and variant.user_id=observation.user_id and variant.title_id=observation.title_id
  join public.cloud_source_catalog_heads head on head.source_id=variant.source_id
    and head.user_id=variant.user_id and head.active_generation_id=variant.generation_id
  cross join lateral unnest(observation.audio_languages) language_code
  where observation.user_id=p_user_id and observation.title_id=p_title_id and observation.audio_observed;
  select coalesce(array_agg(distinct language_code order by language_code),'{}'::text[])
  into v_verified
  from public.cloud_title_file_language_observations observation
  join public.cloud_title_variants variant on variant.id=observation.variant_id
    and variant.user_id=observation.user_id and variant.title_id=observation.title_id
  join public.cloud_source_catalog_heads head on head.source_id=variant.source_id
    and head.user_id=variant.user_id and head.active_generation_id=variant.generation_id
  cross join lateral unnest(observation.audio_languages) language_code
  where observation.user_id=p_user_id and observation.title_id=p_title_id
    and observation.audio_observed and observation.audio_verified_at is not null;
  select coalesce(array_agg(distinct language_code order by language_code),'{}'::text[])
  into v_subtitles
  from public.cloud_title_file_language_observations observation
  join public.cloud_title_variants variant on variant.id=observation.variant_id
    and variant.user_id=observation.user_id and variant.title_id=observation.title_id
  join public.cloud_source_catalog_heads head on head.source_id=variant.source_id
    and head.user_id=variant.user_id and head.active_generation_id=variant.generation_id
  cross join lateral unnest(observation.subtitle_languages) language_code
  where observation.user_id=p_user_id and observation.title_id=p_title_id and observation.subtitle_observed;
  update public.cloud_titles title set file_audio_languages=v_audio,
    file_audio_verified_languages=v_verified,file_subtitle_languages=v_subtitles
  where title.user_id=p_user_id and title.id=p_title_id
    and (title.file_audio_languages is distinct from v_audio
      or title.file_audio_verified_languages is distinct from v_verified
      or title.file_subtitle_languages is distinct from v_subtitles)
  returning title.item_type into v_item_type;
  if v_item_type is not null then
    update public.cloud_catalog_facet_summary set refreshed_at='epoch'::timestamptz
    where user_id=p_user_id and item_type=v_item_type;
  end if;
  return true;
end
$function$;

create or replace function public.hydrate_catalog_episode_file_tracks(
  p_user_id uuid,
  p_source_id uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_parent_series_id text,
  p_episode_ids text[]
) returns integer
language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_episode record; v_title_id uuid; v_title_ids uuid[]:='{}'::uuid[];
  v_audio_languages text[]; v_subtitle_languages text[];
  v_audio_observed boolean; v_subtitle_observed boolean; v_count integer:=0;
begin
  perform public.norva_set_catalog_delete_proof(
    p_source_id,p_user_id,p_generation_id,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  if coalesce(btrim(p_parent_series_id),'')='' then return 0; end if;
  for v_episode in
    select membership.parent_title_id,membership.parent_variant_id,
      membership.provider_identity_id,membership.parent_series_id,membership.episode_id,
      membership.season_number,membership.episode_number,
      cache.audio_tracks,cache.subtitle_tracks,cache.audio_probed_at,
      cache.subtitle_probed_at,cache.audio_lang_verified_at,cache.audio_lang_verification
    from public.catalog_series_episode_memberships membership
    join public.catalog_file_tracks cache
      on cache.server_host=membership.provider_identity_id::text
     and cache.item_type='episode' and cache.external_id=membership.episode_id
    where membership.user_id=p_user_id and membership.source_id=p_source_id
      and membership.generation_id=p_generation_id
      and membership.parent_series_id=btrim(p_parent_series_id)
      and (p_episode_ids is null or membership.episode_id=any(p_episode_ids))
      and (cache.audio_probed_at is not null or cache.subtitle_probed_at is not null)
    order by membership.season_number nulls last,
      membership.episode_number nulls last,membership.episode_id
  loop
    if exists (
      select 1 from public.catalog_series_episode_memberships conflicting
      where conflicting.generation_id=p_generation_id
        and conflicting.provider_identity_id=v_episode.provider_identity_id
        and conflicting.episode_id=v_episode.episode_id
        and conflicting.parent_series_id is distinct from v_episode.parent_series_id
    ) then
      raise exception 'Ambiguous provider episode coordinates' using errcode='23505';
    end if;
    v_audio_observed:=v_episode.audio_probed_at is not null;
    v_subtitle_observed:=v_episode.subtitle_probed_at is not null;
    v_audio_languages:=case when v_audio_observed
      then public.cloud_file_track_languages(v_episode.audio_tracks) else '{}'::text[] end;
    v_subtitle_languages:=case when v_subtitle_observed
      then public.cloud_file_track_languages(v_episode.subtitle_tracks) else '{}'::text[] end;
    insert into public.cloud_title_file_language_observations as observation (
      user_id,title_id,variant_id,file_external_id,audio_languages,subtitle_languages,
      audio_observed,subtitle_observed,audio_verified_at,audio_verification,updated_at
    ) values (
      p_user_id,v_episode.parent_title_id,v_episode.parent_variant_id,v_episode.episode_id,
      v_audio_languages,v_subtitle_languages,v_audio_observed,v_subtitle_observed,null,
      case when v_audio_observed then coalesce(v_episode.audio_lang_verification,'{}'::jsonb) else '{}'::jsonb end,
      clock_timestamp()
    ) on conflict (user_id,variant_id,file_external_id) do update set
      title_id=excluded.title_id,
      audio_languages=case when observation.audio_verified_at is not null then observation.audio_languages
        when excluded.audio_observed then excluded.audio_languages else observation.audio_languages end,
      subtitle_languages=case when excluded.subtitle_observed then excluded.subtitle_languages else observation.subtitle_languages end,
      audio_observed=observation.audio_observed or excluded.audio_observed,
      subtitle_observed=observation.subtitle_observed or excluded.subtitle_observed,
      audio_verified_at=observation.audio_verified_at,
      audio_verification=case when observation.audio_verified_at is not null then observation.audio_verification
        when excluded.audio_observed then excluded.audio_verification else observation.audio_verification end,
      updated_at=clock_timestamp();
    if v_audio_observed and v_episode.audio_lang_verified_at is not null
       and cardinality(v_audio_languages)>0 then
      update public.cloud_title_file_language_observations observation
      set audio_verified_at=v_episode.audio_lang_verified_at,
          audio_verification=coalesce(v_episode.audio_lang_verification,'{}'::jsonb)
            ||jsonb_build_object('status','verified','scope','canonical-episode-file'),
          updated_at=clock_timestamp()
      where observation.user_id=p_user_id
        and observation.title_id=v_episode.parent_title_id
        and observation.variant_id=v_episode.parent_variant_id
        and observation.file_external_id=v_episode.episode_id
        and observation.audio_verified_at is null and observation.audio_observed
        and observation.audio_languages=v_audio_languages;
    elsif v_audio_observed then
      update public.cloud_title_file_language_observations observation
      set audio_verification=coalesce(v_episode.audio_lang_verification,'{}'::jsonb)
            ||jsonb_build_object('scope','canonical-episode-file'),updated_at=clock_timestamp()
      where observation.user_id=p_user_id
        and observation.title_id=v_episode.parent_title_id
        and observation.variant_id=v_episode.parent_variant_id
        and observation.file_external_id=v_episode.episode_id
        and observation.audio_verified_at is null and observation.audio_observed
        and observation.audio_languages=v_audio_languages;
    end if;
    v_title_id:=v_episode.parent_title_id;
    if not (v_title_id=any(v_title_ids)) then v_title_ids:=array_append(v_title_ids,v_title_id); end if;
    v_count:=v_count+1;
  end loop;
  foreach v_title_id in array v_title_ids loop
    perform public.recompute_cloud_title_file_languages(p_user_id,v_title_id);
  end loop;
  return v_count;
end
$function$;

create or replace function public.hydrate_cloud_title_file_languages(
  p_user_id uuid,
  p_source_id uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_server_key text,
  p_item_type text,
  p_external_ids text[]
) returns integer
language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_file record; v_title_id uuid; v_title_ids uuid[]:='{}'::uuid[];
  v_cache_key text; v_audio_languages text[]; v_audio_verified boolean; v_count integer:=0;
begin
  perform public.norva_set_catalog_delete_proof(
    p_source_id,p_user_id,p_generation_id,p_head_revision,p_config_revision,
    p_source_visibility_epoch,p_user_visibility_epoch
  );
  if p_item_type is distinct from 'movie'
     or (p_server_key is not null and length(p_server_key)>512) then return 0; end if;
  v_cache_key:=public.catalog_source_file_cache_key(p_source_id,p_user_id);
  if coalesce(btrim(v_cache_key),'')='' then return 0; end if;
  for v_file in
    select variant.user_id,variant.title_id,variant.id variant_id,variant.external_id,
      cache.audio_tracks,cache.subtitle_tracks,cache.audio_probed_at is not null audio_observed,
      cache.subtitle_probed_at is not null subtitle_observed,cache.audio_lang_verified_at,
      cache.audio_lang_retry_at,cache.audio_lang_verification
    from public.cloud_title_variants variant
    join public.catalog_file_tracks cache on cache.server_host=v_cache_key
      and cache.item_type=variant.item_type and cache.external_id=variant.external_id
    where variant.user_id=p_user_id and variant.source_id=p_source_id
      and variant.generation_id=p_generation_id and variant.item_type='movie'
      and variant.title_id is not null
      and (p_external_ids is null or variant.external_id=any(p_external_ids))
      and (cache.audio_probed_at is not null or cache.subtitle_probed_at is not null)
    order by variant.title_id,variant.id
  loop
    v_audio_languages:=case when v_file.audio_observed then public.cloud_file_track_languages(v_file.audio_tracks) else '{}'::text[] end;
    v_audio_verified:=v_file.audio_observed and v_file.audio_lang_verified_at is not null and cardinality(v_audio_languages)>0;
    insert into public.cloud_title_file_language_observations as observation (
      user_id,title_id,variant_id,file_external_id,audio_languages,subtitle_languages,
      audio_observed,subtitle_observed,audio_verified_at,audio_verification,updated_at
    ) values (
      v_file.user_id,v_file.title_id,v_file.variant_id,v_file.external_id,v_audio_languages,
      case when v_file.subtitle_observed then public.cloud_file_track_languages(v_file.subtitle_tracks) else '{}'::text[] end,
      v_file.audio_observed,v_file.subtitle_observed,
      case when v_audio_verified then v_file.audio_lang_verified_at else null end,
      case when v_audio_verified then coalesce(v_file.audio_lang_verification,'{}'::jsonb) else '{}'::jsonb end,
      clock_timestamp()
    ) on conflict (user_id,variant_id,file_external_id) do update set
      title_id=excluded.title_id,
      audio_languages=case when excluded.audio_observed then excluded.audio_languages else observation.audio_languages end,
      subtitle_languages=case when excluded.subtitle_observed then excluded.subtitle_languages else observation.subtitle_languages end,
      audio_observed=observation.audio_observed or excluded.audio_observed,
      subtitle_observed=observation.subtitle_observed or excluded.subtitle_observed,
      updated_at=clock_timestamp();
    update public.cloud_title_file_language_observations observation
      set audio_verified_at=case when v_audio_verified then v_file.audio_lang_verified_at else null end,
          audio_verification=case when v_audio_verified then coalesce(v_file.audio_lang_verification,'{}'::jsonb) else '{}'::jsonb end,
          updated_at=clock_timestamp()
    where observation.user_id=v_file.user_id and observation.variant_id=v_file.variant_id
      and observation.file_external_id=v_file.external_id;
    update public.cloud_title_variants variant
      set audio_lang_verified_at=case when v_audio_verified then v_file.audio_lang_verified_at else null end,
          audio_lang_verify_retry_at=case when v_audio_verified then null else v_file.audio_lang_retry_at end,
          write_head_revision=p_head_revision,write_config_revision=p_config_revision,
          write_source_visibility_epoch=p_source_visibility_epoch,
          write_user_visibility_epoch=p_user_visibility_epoch
    where variant.user_id=v_file.user_id and variant.source_id=p_source_id
      and variant.generation_id=p_generation_id and variant.id=v_file.variant_id;
    if not (v_file.title_id=any(v_title_ids)) then v_title_ids:=array_append(v_title_ids,v_file.title_id); end if;
    v_count:=v_count+1;
  end loop;
  foreach v_title_id in array v_title_ids loop
    perform public.recompute_cloud_title_file_languages(p_user_id,v_title_id);
  end loop;
  return v_count;
end
$function$;

-- Keep legacy signatures service-callable through the rolling window. The
-- explicit online contract revokes them only after caller-version evidence;
-- Phase 3 flags remain OFF and non-activatable before that contract.
revoke all on function public.heal_cloud_title_variants(uuid,uuid) from public,anon,authenticated;
revoke all on function public.propagate_media_item_years(uuid,uuid,uuid[]) from public,anon,authenticated;
revoke all on function public.norva_hydrate_source_category_names(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.register_catalog_series_episodes(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.record_catalog_series_inventory_outcome(uuid,uuid,text,boolean,integer,timestamptz,jsonb) from public,anon,authenticated;
revoke all on function public.hydrate_catalog_episode_file_tracks(uuid,uuid,text,text[]) from public,anon,authenticated;
revoke all on function public.hydrate_cloud_title_file_languages(uuid,uuid,text,text,text[]) from public,anon,authenticated;
revoke all on function public.heal_cloud_title_variants(uuid,uuid,uuid,bigint,bigint,bigint,bigint) from public,anon,authenticated,service_role;
revoke all on function public.propagate_media_item_years(uuid,uuid,uuid[],uuid,bigint,bigint,bigint,bigint) from public,anon,authenticated,service_role;
revoke all on function public.norva_hydrate_source_category_names(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,integer) from public,anon,authenticated,service_role;
revoke all on function public.register_catalog_series_episodes(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.record_catalog_series_inventory_outcome(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,boolean,integer,timestamptz,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.hydrate_catalog_episode_file_tracks(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text[]) from public,anon,authenticated,service_role;
revoke all on function public.hydrate_cloud_title_file_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text,text[]) from public,anon,authenticated,service_role;
revoke all on function public.recompute_cloud_title_file_languages(uuid,uuid) from public,anon,authenticated;
revoke all on function public.norva_bind_credential_transition_account_affinity(uuid,uuid,text,bigint) from public,anon,authenticated,service_role;
revoke all on function public.norva_switch_provider_account_affinity() from public,anon,authenticated,service_role;
revoke all on function public.norva_clear_transition_affinity_hashes() from public,anon,authenticated,service_role;
revoke all on function public.norva_credential_job_affinity_guard() from public,anon,authenticated,service_role;
revoke all on function public.norva_migrate_provider_account_activity_affinities() from public,anon,authenticated,service_role;
revoke all on function public.norva_migrate_provider_account_activity_affinities(integer) from public,anon,authenticated,service_role;
revoke all on function public.provider_account_touch_many(text[],text) from public,anon,authenticated;
revoke all on function public.provider_account_touch_by_source(uuid,text) from public,anon,authenticated;
revoke all on function public.provider_account_touch_by_user(uuid,text) from public,anon,authenticated;
revoke all on function public.provider_account_busy(text) from public,anon,authenticated;
revoke all on function public.provider_account_busy_for_foreground_validation(text) from public,anon,authenticated;
grant execute on function public.heal_cloud_title_variants(uuid,uuid,uuid,bigint,bigint,bigint,bigint) to service_role;
grant execute on function public.propagate_media_item_years(uuid,uuid,uuid[],uuid,bigint,bigint,bigint,bigint) to service_role;
grant execute on function public.norva_hydrate_source_category_names(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,integer) to service_role;
grant execute on function public.register_catalog_series_episodes(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,jsonb) to service_role;
grant execute on function public.record_catalog_series_inventory_outcome(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,boolean,integer,timestamptz,jsonb) to service_role;
grant execute on function public.hydrate_catalog_episode_file_tracks(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text[]) to service_role;
grant execute on function public.hydrate_cloud_title_file_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text,text[]) to service_role;
grant execute on function public.recompute_cloud_title_file_languages(uuid,uuid) to service_role;
grant execute on function public.heal_cloud_title_variants(uuid,uuid) to service_role;
grant execute on function public.propagate_media_item_years(uuid,uuid,uuid[]) to service_role;
grant execute on function public.norva_hydrate_source_category_names(uuid,text,integer) to service_role;
grant execute on function public.register_catalog_series_episodes(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.record_catalog_series_inventory_outcome(uuid,uuid,text,boolean,integer,timestamptz,jsonb) to service_role;
grant execute on function public.hydrate_catalog_episode_file_tracks(uuid,uuid,text,text[]) to service_role;
grant execute on function public.hydrate_cloud_title_file_languages(uuid,uuid,text,text,text[]) to service_role;
grant execute on function public.norva_bind_credential_transition_account_affinity(uuid,uuid,text,bigint) to service_role;
grant execute on function public.provider_account_touch_many(text[],text) to service_role;
grant execute on function public.provider_account_touch_by_source(uuid,text) to service_role;
grant execute on function public.provider_account_touch_by_user(uuid,text) to service_role;
grant execute on function public.provider_account_busy(text) to service_role;
grant execute on function public.provider_account_busy_for_foreground_validation(text) to service_role;
grant execute on function public.norva_migrate_provider_account_activity_affinities(integer) to service_role;

-- Preserve every currently invoked legacy RPC during the rolling window. For
-- PL/pgSQL writers that still use pre-generation signatures, inject a hard
-- feature-activation guard into the existing body without changing its return
-- contract. They continue to work while both Phase 3 flags are OFF, and fail
-- closed if activation is attempted before caller-contract migration.
do $block$
declare
  routine record;
  v_definition text;
begin
  for routine in
    select proc.oid
    from pg_proc proc
    join pg_language lang on lang.oid=proc.prolang
    where proc.pronamespace='public'::regnamespace
      and lang.lanname='plpgsql'
      and proc.proname=any(array[
        'finalize_catalog_file_audio_validation_job',
        'record_catalog_file_container_observation',
        'record_catalog_file_audio_whisper_outcome',
        'record_catalog_episode_probe_outcome',
        'fanout_episode_file_tracks_to_users',
        'fanout_detected_file_tracks_to_users','fanout_file_tracks_to_users',
        'refresh_catalog_file_audio_detection_provenance',
        'merge_cloud_title_file_languages','upsert_cloud_title_rating_cas',
        'claim_catalog_enrichment_sources','record_provider_overview_outcome',
        'norva_resolve_provider_identity'
      ]::name[])
      and lower(proc.prosrc) ~
        'cloud_media_items|cloud_title_variants|cloud_live_logical_channels|cloud_live_variants|catalog_series_episode_memberships|catalog_series_inventory_state'
      and lower(proc.prosrc) not like '%legacy catalog writer disabled after generation activation%'
  loop
    v_definition:=replace(pg_get_functiondef(routine.oid),chr(13),'');
    v_definition:=regexp_replace(v_definition,'\mbegin\M',
      E'begin\n  -- legacy catalog writer disabled after generation activation\n  if current_setting(''norva.legacy_catalog_writer_fenced'',true) is distinct from ''on''\n     and exists (select 1 from public.admin_feature_flags flag\n    where flag.key in (''provider_credential_transition_v1_enabled'',\n      ''provider_replacement_v1_enabled'') and flag.enabled) then\n    raise exception ''legacy catalog writer disabled after generation activation'' using errcode=''55000'';\n  end if;',
      '');
    execute v_definition;
  end loop;

  for routine in
    select proc.oid
    from pg_proc proc
    where proc.pronamespace='public'::regnamespace
      and proc.proname=any(array[
        'finalize_catalog_file_audio_validation_job',
        'catalog_series_episode_coordinates_by_episode',
        'record_catalog_file_container_observation',
        'record_catalog_file_audio_whisper_outcome',
        'catalog_episode_probe_retry_state','record_catalog_episode_probe_outcome',
        'whitelist_subtitle_candidates','file_audio_tag_suspect_variants',
        'file_whisper_candidate_variants','whisper_candidate_titles',
        'audio_backfill_candidates','file_audio_backfill_candidates',
        'catalog_media_mirror_diff','fanout_episode_file_tracks_to_users',
        'fanout_detected_file_tracks_to_users','fanout_file_tracks_to_users',
        'refresh_catalog_file_audio_detection_provenance',
        'fill_user_audio_from_catalog','search_media_items',
        'list_media_items_deduped','merge_cloud_title_file_languages',
        'top_viewed_titles','upsert_cloud_title_rating_cas',
        'claim_catalog_enrichment_sources','record_provider_overview_outcome',
        'claim_provider_overview_candidates','norva_resolve_provider_identity'
      ]::name[])
  loop
    execute format('revoke all on function %s from public,anon,authenticated',routine.oid::regprocedure);
    execute format('grant execute on function %s to service_role',routine.oid::regprocedure);
  end loop;
end
$block$;

-- A fenced legacy call may reuse the historical implementation only after an
-- exact active-head CAS. This early row trigger projects the transaction-local
-- proof onto matching rows and silently skips rows from every other
-- source/generation. The normal Phase 3 row guard still revalidates the proof,
-- closing the switch/rollback ABA window.
create or replace function public.norva_apply_legacy_catalog_write_proof()
returns trigger language plpgsql security definer set search_path='' as $function$
declare
  v_source_id uuid:=nullif(current_setting('norva.legacy_catalog_source_id',true),'')::uuid;
  v_user_id uuid:=nullif(current_setting('norva.legacy_catalog_user_id',true),'')::uuid;
  v_generation_id uuid:=nullif(current_setting('norva.legacy_catalog_generation_id',true),'')::uuid;
  v_proof jsonb:=coalesce(nullif(current_setting('norva.catalog_delete_proof',true),''),'{}')::jsonb;
begin
  if current_setting('norva.legacy_catalog_writer_fenced',true) is distinct from 'on' then
    return new;
  end if;
  if new.source_id is distinct from v_source_id
     or new.user_id is distinct from v_user_id
     or new.generation_id is distinct from v_generation_id then
    return null;
  end if;
  new.write_head_revision:=(v_proof->>'headRevision')::bigint;
  new.write_config_revision:=(v_proof->>'configRevision')::bigint;
  new.write_source_visibility_epoch:=(v_proof->>'sourceVisibilityEpoch')::bigint;
  new.write_user_visibility_epoch:=(v_proof->>'userVisibilityEpoch')::bigint;
  return new;
end
$function$;

create or replace function public.record_provider_overview_outcome(
  p_user_id uuid,p_source_id uuid,p_external_id text,p_provider_overview text,
  p_provider_tmdb_id text,p_provider_imdb_id text,p_outcome text,
  p_retry_at timestamptz,p_provenance jsonb,
  p_generation_id uuid,p_head_revision bigint,p_config_revision bigint,
  p_source_visibility_epoch bigint,p_user_visibility_epoch bigint
) returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare v_result jsonb;
begin
  perform public.norva_set_catalog_delete_proof(p_source_id,p_user_id,p_generation_id,
    p_head_revision,p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch);
  perform set_config('norva.legacy_catalog_source_id',p_source_id::text,true);
  perform set_config('norva.legacy_catalog_user_id',p_user_id::text,true);
  perform set_config('norva.legacy_catalog_generation_id',p_generation_id::text,true);
  perform set_config('norva.legacy_catalog_writer_fenced','on',true);
  v_result:=public.record_provider_overview_outcome(p_user_id,p_source_id,p_external_id,
    p_provider_overview,p_provider_tmdb_id,p_provider_imdb_id,p_outcome,p_retry_at,p_provenance);
  perform set_config('norva.legacy_catalog_writer_fenced','off',true);
  return v_result;
end
$function$;

create or replace function public.record_catalog_file_container_observation(
  p_user_id uuid,p_source_id uuid,p_playback_session_id uuid,p_item_type text,
  p_external_id text,p_declared_container text,p_observed_container text,
  p_evidence jsonb,p_expected_media_item_id uuid,p_expected_media_item_updated_at timestamptz,
  p_generation_id uuid,p_head_revision bigint,p_config_revision bigint,
  p_source_visibility_epoch bigint,p_user_visibility_epoch bigint
) returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare v_result jsonb;
begin
  if p_expected_media_item_id is null or p_expected_media_item_updated_at is null then
    raise exception 'container observation item CAS is required' using errcode='22023';
  end if;
  perform public.norva_set_catalog_delete_proof(p_source_id,p_user_id,p_generation_id,
    p_head_revision,p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch);
  perform set_config('norva.legacy_catalog_source_id',p_source_id::text,true);
  perform set_config('norva.legacy_catalog_user_id',p_user_id::text,true);
  perform set_config('norva.legacy_catalog_generation_id',p_generation_id::text,true);
  perform set_config('norva.legacy_catalog_writer_fenced','on',true);
  v_result:=public.record_catalog_file_container_observation(p_user_id,p_source_id,
    p_playback_session_id,p_item_type,p_external_id,p_declared_container,
    p_observed_container,p_evidence,p_expected_media_item_id,p_expected_media_item_updated_at);
  perform set_config('norva.legacy_catalog_writer_fenced','off',true);
  return v_result;
end
$function$;

-- Five routines only read generation tables and write separate logical/cache
-- ledgers. Re-emit their existing signatures over visible/head projections and
-- remove the temporary flags-OFF guard; no caller migration is required.
do $block$
declare routine record; v_definition text; v_start integer; v_tail integer;
begin
  for routine in
    select proc.oid from pg_proc proc
    where proc.pronamespace='public'::regnamespace and proc.proname=any(array[
      'norva_resolve_provider_identity','merge_cloud_title_file_languages',
      'claim_catalog_enrichment_sources','record_catalog_episode_probe_outcome',
      'upsert_cloud_title_rating_cas'
    ]::name[])
  loop
    v_definition:=replace(pg_get_functiondef(routine.oid),chr(13),'');
    v_definition:=replace(v_definition,'from public.cloud_media_items','from public.cloud_catalog_visible_media_items');
    v_definition:=replace(v_definition,'join public.cloud_media_items','join public.cloud_catalog_visible_media_items');
    v_definition:=replace(v_definition,'from public.cloud_title_variants','from public.cloud_catalog_visible_title_variants');
    v_definition:=replace(v_definition,'join public.cloud_title_variants','join public.cloud_catalog_visible_title_variants');
    v_definition:=replace(v_definition,'from public.catalog_series_episode_memberships','from public.cloud_catalog_visible_series_episode_memberships');
    v_definition:=replace(v_definition,'join public.catalog_series_episode_memberships','join public.cloud_catalog_visible_series_episode_memberships');
    v_definition:=replace(v_definition,'from cloud_media_items','from public.cloud_catalog_visible_media_items');
    v_definition:=replace(v_definition,'join cloud_media_items','join public.cloud_catalog_visible_media_items');
    v_definition:=replace(v_definition,'from cloud_title_variants','from public.cloud_catalog_visible_title_variants');
    v_definition:=replace(v_definition,'join cloud_title_variants','join public.cloud_catalog_visible_title_variants');
    v_definition:=replace(v_definition,'from catalog_series_episode_memberships','from public.cloud_catalog_visible_series_episode_memberships');
    v_definition:=replace(v_definition,'join catalog_series_episode_memberships','join public.cloud_catalog_visible_series_episode_memberships');
    v_start:=position('-- legacy catalog writer disabled after generation activation' in v_definition);
    if v_start>0 then
      v_tail:=position('  end if;' in substring(v_definition from v_start));
      if v_tail=0 then raise exception 'legacy reader guard removal drifted: %',routine.oid::regprocedure using errcode='55000'; end if;
      v_definition:=substring(v_definition from 1 for v_start-1)
        ||substring(v_definition from v_start+v_tail+length('  end if;')-1);
    end if;
    execute v_definition;
    execute format('revoke all on function %s from public,anon,authenticated',routine.oid::regprocedure);
    execute format('grant execute on function %s to service_role',routine.oid::regprocedure);
  end loop;
end
$block$;

-- Clone the global fanout under a contracted name and bind its one physical
-- variant update to the head/config/visibility snapshot selected for each
-- owner. Late head switches make the UPDATE affect zero rows or fail its ABA
-- proof; a hidden generation can never be mutated.
do $block$
declare v_definition text; v_before text; v_start integer; v_tail integer;
begin
  v_definition:=replace(pg_get_functiondef(
    'public.fanout_file_tracks_to_users(text,text,text,jsonb,jsonb,boolean,boolean)'::regprocedure),chr(13),'');
  v_definition:=replace(v_definition,'FUNCTION public.fanout_file_tracks_to_users(',
    'FUNCTION public.norva_fanout_file_tracks_to_users_fenced(');
  v_start:=position('-- legacy catalog writer disabled after generation activation' in v_definition);
  if v_start>0 then
    v_tail:=position('  end if;' in substring(v_definition from v_start));
    v_definition:=substring(v_definition from 1 for v_start-1)
      ||substring(v_definition from v_start+v_tail+length('  end if;')-1);
  end if;
  v_before:=v_definition;
  v_definition:=replace(v_definition,$old$
      variant.id as variant_id,
      variant.external_id
    from public.cloud_catalog_visible_title_variants variant$old$,$new$
      variant.id as variant_id,
      variant.external_id,
      head.head_revision,
      lifecycle.config_revision,
      lifecycle.visibility_epoch as source_visibility_epoch,
      epoch.visibility_epoch as user_visibility_epoch
    from public.cloud_catalog_visible_title_variants variant
    join public.cloud_source_catalog_heads head
      on head.source_id=variant.source_id and head.user_id=variant.user_id
     and head.active_generation_id=variant.generation_id
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.source_id=variant.source_id and lifecycle.user_id=variant.user_id
    join public.cloud_user_catalog_visibility_epochs epoch
      on epoch.user_id=variant.user_id$new$);
  if v_definition=v_before then raise exception 'fenced fanout owner proof rewrite drifted' using errcode='55000'; end if;
  v_before:=v_definition;
  v_definition:=replace(v_definition,$old$
         set audio_lang_verified_at = null,
             audio_lang_verify_retry_at = null
       where variant.user_id = v_owner.user_id$old$,$new$
         set audio_lang_verified_at = null,
             audio_lang_verify_retry_at = null,
             write_head_revision=v_owner.head_revision,
             write_config_revision=v_owner.config_revision,
             write_source_visibility_epoch=v_owner.source_visibility_epoch,
             write_user_visibility_epoch=v_owner.user_visibility_epoch
       where variant.user_id = v_owner.user_id$new$);
  if v_definition=v_before then raise exception 'fenced fanout update proof rewrite drifted' using errcode='55000'; end if;
  execute v_definition;
end
$block$;

revoke all on function public.norva_apply_legacy_catalog_write_proof() from public,anon,authenticated,service_role;
revoke all on function public.record_provider_overview_outcome(uuid,uuid,text,text,text,text,text,timestamptz,jsonb,uuid,bigint,bigint,bigint,bigint) from public,anon,authenticated,service_role;
revoke all on function public.record_catalog_file_container_observation(uuid,uuid,uuid,text,text,text,text,jsonb,uuid,timestamptz,uuid,bigint,bigint,bigint,bigint) from public,anon,authenticated,service_role;
revoke all on function public.norva_fanout_file_tracks_to_users_fenced(text,text,text,jsonb,jsonb,boolean,boolean) from public,anon,authenticated,service_role;
grant execute on function public.record_provider_overview_outcome(uuid,uuid,text,text,text,text,text,timestamptz,jsonb,uuid,bigint,bigint,bigint,bigint) to service_role;
grant execute on function public.record_catalog_file_container_observation(uuid,uuid,uuid,text,text,text,text,jsonb,uuid,timestamptz,uuid,bigint,bigint,bigint,bigint) to service_role;
grant execute on function public.norva_fanout_file_tracks_to_users_fenced(text,text,text,jsonb,jsonb,boolean,boolean) to service_role;

-- Remaining legacy signatures are not revoked during expand: DB-first and
-- code-first rollout must both preserve existing product behavior. The
-- explicit, non-automatic online contract owns the final caller-protocol gate
-- and revocation. Feature flags stay OFF throughout this compatibility phase.

notify pgrst,'reload schema';
commit;
