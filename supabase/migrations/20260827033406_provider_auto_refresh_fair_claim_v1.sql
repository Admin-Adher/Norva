-- Durable and fair background catalogue refresh claims.
--
-- The legacy dispatcher selected one due source through PostgREST and only
-- afterwards tried to acquire a JSON lock. A fresh lock, a backoff or a
-- non-entitled owner in the first row therefore consumed the whole cron tick.
-- These RPCs move selection + lease acquisition into one short PostgreSQL
-- transaction using SKIP LOCKED. Provider I/O still happens outside the
-- transaction in Edge.
--
-- 401/403/404 are deliberately recorded as action-required evidence, not as
-- proof of expiry. A source remains catalog-visible until the existing
-- Provider Access state machine reaches one of its confirmed hidden states.

alter table public.cloud_sources
  add column if not exists auto_refresh_lease_owner text,
  add column if not exists auto_refresh_lease_sequence bigint not null default 0,
  add column if not exists auto_refresh_lease_expires_at timestamptz;

alter table public.cloud_sources
  add constraint cloud_sources_auto_refresh_lease_owner_ck check (
    auto_refresh_lease_owner is null
    or (
      btrim(auto_refresh_lease_owner) <> ''
      and length(auto_refresh_lease_owner) <= 200
      and auto_refresh_lease_owner !~ '[[:cntrl:]]'
    )
  ),
  add constraint cloud_sources_auto_refresh_lease_sequence_ck check (
    auto_refresh_lease_sequence >= 0
  ),
  add constraint cloud_sources_auto_refresh_lease_shape_ck check (
    (auto_refresh_lease_owner is null and auto_refresh_lease_expires_at is null)
    or (auto_refresh_lease_owner is not null and auto_refresh_lease_expires_at is not null)
  );

drop index if exists public.idx_cloud_sources_auto_refresh_due;
create index idx_cloud_sources_auto_refresh_due
  on public.cloud_sources (auto_refresh_next_at nulls first, id)
  where source_type in ('xtream', 'm3u')
    and enabled
    and deleted_at is null
    and ((auto_refresh_state ->> 'suspended') is distinct from 'true');

create or replace function public.norva_cloud_auto_refresh_trusted_context()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
      nullif(auth.jwt() ->> 'role', ''),
      nullif(current_setting('request.jwt.claim.role', true), ''),
      nullif(current_setting('role', true), 'none'),
      ''
    ) = 'service_role';
$function$;

-- cloud_sources has historically carried an owner update policy. Keep the
-- scheduler state server-owned even if a broad table grant is present during a
-- compatibility window or future ACL change. A user may change credentials
-- through the supported server path, but may not forge a lease, suppress a
-- warning or force a source back into the due queue.
create or replace function public.norva_guard_cloud_auto_refresh_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if public.norva_cloud_auto_refresh_trusted_context() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.auto_refresh_next_at is not null
       or coalesce(new.auto_refresh_state, '{}'::jsonb) <> '{}'::jsonb
       or new.auto_refresh_lease_owner is not null
       or new.auto_refresh_lease_sequence <> 0
       or new.auto_refresh_lease_expires_at is not null then
      raise exception 'cloud auto refresh scheduler state is server managed'
        using errcode = '42501';
    end if;
  elsif new.auto_refresh_next_at is distinct from old.auto_refresh_next_at
     or new.auto_refresh_state is distinct from old.auto_refresh_state
     or new.auto_refresh_lease_owner is distinct from old.auto_refresh_lease_owner
     or new.auto_refresh_lease_sequence is distinct from old.auto_refresh_lease_sequence
     or new.auto_refresh_lease_expires_at is distinct from old.auto_refresh_lease_expires_at then
    raise exception 'cloud auto refresh scheduler state is server managed'
      using errcode = '42501';
  end if;
  return new;
end
$function$;

drop trigger if exists trg_cloud_sources_auto_refresh_insert_guard
  on public.cloud_sources;
create trigger trg_cloud_sources_auto_refresh_insert_guard
before insert on public.cloud_sources
for each row execute function public.norva_guard_cloud_auto_refresh_state();

drop trigger if exists trg_cloud_sources_auto_refresh_update_guard
  on public.cloud_sources;
create trigger trg_cloud_sources_auto_refresh_update_guard
before update of auto_refresh_next_at, auto_refresh_state,
  auto_refresh_lease_owner, auto_refresh_lease_sequence, auto_refresh_lease_expires_at
on public.cloud_sources
for each row execute function public.norva_guard_cloud_auto_refresh_state();

create or replace function public.norva_claim_cloud_auto_refresh_sources(
  p_worker text,
  p_limit integer default 1,
  p_lease_seconds integer default 720
) returns table (
  source_id uuid,
  user_id uuid,
  source_type text,
  lease_sequence bigint,
  auto_refresh_state jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform public.norva_provider_access_service_role_required();
  if p_worker is null or btrim(p_worker) = '' or length(p_worker) > 200
     or p_worker ~ '[[:cntrl:]]'
     or p_limit is null or p_limit < 1 or p_limit > 8
     or p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 1200 then
    raise exception 'invalid cloud auto refresh claim request' using errcode = '22023';
  end if;

  return query
  with candidates as materialized (
    select source.id
    from public.cloud_sources source
    where source.source_type in ('xtream', 'm3u')
      and source.enabled
      and source.deleted_at is null
      and (source.auto_refresh_next_at is null or source.auto_refresh_next_at <= clock_timestamp())
      and (source.auto_refresh_state ->> 'suspended') is distinct from 'true'
      and (
        source.auto_refresh_lease_owner is null
        or source.auto_refresh_lease_expires_at <= clock_timestamp()
      )
      -- Compatibility fence for a rolling Edge deploy. A legacy worker writes
      -- lockedAt in JSON; the new claimant honors a fresh legacy lock while the
      -- new lease also writes lockedAt so an old isolate cannot double-claim it.
      and case
        when source.auto_refresh_state ->> 'lockedAt' is null then true
        when source.auto_refresh_state ->> 'lockedAt'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
          (source.auto_refresh_state ->> 'lockedAt')::timestamptz
            <= clock_timestamp() - interval '12 minutes'
        else true
      end
      and public.norva_source_catalog_visible_internal(source.id, source.user_id)
    order by source.auto_refresh_next_at nulls first, source.id
    for update of source skip locked
    limit p_limit
  ), claimed as (
    update public.cloud_sources source
    set auto_refresh_lease_owner = p_worker,
        auto_refresh_lease_sequence = source.auto_refresh_lease_sequence + 1,
        auto_refresh_lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
        auto_refresh_next_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
        auto_refresh_state = (
          coalesce(source.auto_refresh_state, '{}'::jsonb)
          - 'backoffUntil'
        ) || jsonb_build_object(
          'lockedAt', clock_timestamp(),
          'lastClaimedAt', clock_timestamp()
        )
    from candidates
    where source.id = candidates.id
    returning source.id, source.user_id, source.source_type,
      source.auto_refresh_lease_sequence, source.auto_refresh_state
  )
  select claimed.id, claimed.user_id, claimed.source_type,
    claimed.auto_refresh_lease_sequence, claimed.auto_refresh_state
  from claimed
  order by claimed.id;
end
$function$;

create or replace function public.norva_settle_cloud_auto_refresh_source(
  p_source_id uuid,
  p_user_id uuid,
  p_worker text,
  p_expected_lease_sequence bigint,
  p_outcome text,
  p_observed_at timestamptz default now(),
  p_http_status integer default null,
  p_error_kind text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_source public.cloud_sources%rowtype;
  v_state jsonb;
  v_clean jsonb;
  v_next_at timestamptz;
  v_attempts integer;
  v_terminal_count integer;
  v_same_terminal boolean;
  v_suspended boolean;
  v_action text;
begin
  perform public.norva_provider_access_service_role_required();
  if p_source_id is null or p_user_id is null
     or p_worker is null or btrim(p_worker) = '' or length(p_worker) > 200
     or p_expected_lease_sequence is null or p_expected_lease_sequence < 1
     or p_outcome not in ('success', 'not_entitled', 'transient_failure', 'action_required')
     or p_observed_at is null or p_observed_at > clock_timestamp() + interval '5 minutes'
     or (
       p_outcome = 'action_required'
       and (
         p_http_status not in (401, 403, 404)
         or p_error_kind not in ('auth', 'expired', 'not_found')
         or (p_http_status = 404 and p_error_kind <> 'not_found')
         or (p_http_status in (401, 403) and p_error_kind not in ('auth', 'expired'))
       )
     )
     or (
       p_outcome = 'transient_failure'
       and (p_error_kind is null or p_error_kind not in ('busy', 'infra', 'unknown'))
     )
     or (
       p_outcome in ('success', 'not_entitled')
       and (p_http_status is not null or p_error_kind is not null)
     ) then
    raise exception 'invalid cloud auto refresh settlement' using errcode = '22023';
  end if;

  select source.* into v_source
  from public.cloud_sources source
  where source.id = p_source_id and source.user_id = p_user_id
  for update;

  if not found then
    raise exception 'cloud auto refresh lease is stale' using errcode = '40001';
  end if;

  if v_source.auto_refresh_lease_owner is distinct from p_worker
     or v_source.auto_refresh_lease_sequence is distinct from p_expected_lease_sequence
     or v_source.auto_refresh_lease_expires_at is null
     or v_source.auto_refresh_lease_expires_at <= clock_timestamp() then
    raise exception 'cloud auto refresh lease is stale' using errcode = '40001';
  end if;

  v_state := coalesce(v_source.auto_refresh_state, '{}'::jsonb);
  v_clean := v_state - array[
    'lockedAt', 'backoffUntil', 'lastClaimedAt', 'lastCompletedAt',
    'lastOutcome', 'lastHttpStatus', 'lastErrorKind'
  ];

  if p_outcome = 'success' then
    v_next_at := p_observed_at + interval '6 hours';
    v_clean := v_clean - array[
      'actionRequired', 'actionRequiredReason', 'terminalHttpStatus',
      'terminalErrorKind', 'terminalFailureCount', 'terminalFirstAt',
      'terminalLastAt', 'suspended'
    ];
    v_state := v_clean || jsonb_build_object(
      'attempts', 0,
      'lastOutcome', 'success',
      'lastCompletedAt', p_observed_at
    );
  elsif p_outcome = 'not_entitled' then
    v_next_at := p_observed_at + interval '6 hours';
    v_state := v_clean || jsonb_build_object(
      'attempts', 0,
      'lastOutcome', 'not_entitled',
      'lastCompletedAt', p_observed_at
    );
  elsif p_outcome = 'transient_failure' then
    v_attempts := least(20, (
      case
        when coalesce(v_state ->> 'attempts', '') ~ '^[0-9]{1,2}$'
          then (v_state ->> 'attempts')::integer
        else 0
      end
    ) + 1);
    v_next_at := p_observed_at + make_interval(
      secs => least(21600, (300 * power(2::numeric, least(v_attempts, 6)))::integer)
    );
    v_state := v_clean || jsonb_build_object(
      'attempts', v_attempts,
      'lastOutcome', 'transient_failure',
      'lastErrorKind', p_error_kind,
      'lastCompletedAt', p_observed_at,
      'backoffUntil', v_next_at
    );
  else
    v_same_terminal := v_state ->> 'terminalHttpStatus' is not distinct from p_http_status::text
      and v_state ->> 'terminalErrorKind' is not distinct from p_error_kind;
    v_terminal_count := case
      when v_same_terminal then least(20, (
        case
          when coalesce(v_state ->> 'terminalFailureCount', '') ~ '^[0-9]{1,2}$'
            then (v_state ->> 'terminalFailureCount')::integer
          else 0
        end
      ) + 1)
      else 1
    end;
    v_suspended := v_terminal_count >= 2;
    v_action := case
      when p_error_kind = 'expired' then 'RENEW_ACCESS'
      when p_error_kind = 'auth' then 'UPDATE_LOGIN'
      else 'CHECK_PROVIDER'
    end;
    -- One confirmation retry is allowed after 24h. Two matching terminal
    -- observations suspend background pressure until a credential change or a
    -- successful user-initiated sync clears the fence.
    v_next_at := p_observed_at + case when v_suspended then interval '30 days' else interval '24 hours' end;
    v_state := v_clean || jsonb_build_object(
      'attempts', 0,
      'lastOutcome', 'action_required',
      'lastHttpStatus', p_http_status,
      'lastErrorKind', p_error_kind,
      'lastCompletedAt', p_observed_at,
      'actionRequired', true,
      'actionRequiredReason', v_action,
      'terminalHttpStatus', p_http_status,
      'terminalErrorKind', p_error_kind,
      'terminalFailureCount', v_terminal_count,
      'terminalFirstAt', case
        when v_same_terminal then coalesce(v_state -> 'terminalFirstAt', to_jsonb(p_observed_at))
        else to_jsonb(p_observed_at)
      end,
      'terminalLastAt', p_observed_at,
      'suspended', v_suspended
    );
  end if;

  update public.cloud_sources source
  set auto_refresh_lease_owner = null,
      auto_refresh_lease_expires_at = null,
      auto_refresh_next_at = v_next_at,
      auto_refresh_state = v_state
  where source.id = p_source_id
    and source.user_id = p_user_id
    and source.auto_refresh_lease_owner = p_worker
    and source.auto_refresh_lease_sequence = p_expected_lease_sequence;
  if not found then
    raise exception 'cloud auto refresh lease is stale' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'sourceId', p_source_id,
    'outcome', p_outcome,
    'nextAt', v_next_at,
    'actionRequired', coalesce(v_state ->> 'actionRequired' = 'true', false),
    'suspended', coalesce(v_state ->> 'suspended' = 'true', false),
    'terminalFailureCount', case
      when coalesce(v_state ->> 'terminalFailureCount', '') ~ '^[0-9]{1,2}$'
        then (v_state ->> 'terminalFailureCount')::integer
      else 0
    end
  );
end
$function$;

-- A real config promotion/rollback or a successful foreground sync is the only
-- local evidence that can clear an action-required suspension. Advancing the
-- lease sequence fences any old background worker that wakes after that change.
create or replace function public.norva_reset_cloud_auto_refresh_on_source_recovery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_config_changed boolean := new.config_ciphertext is distinct from old.config_ciphertext;
  v_became_ready boolean := public.norva_cloud_auto_refresh_trusted_context()
    and new.sync_status = 'ready'
    and old.sync_status is distinct from 'ready';
begin
  if not v_config_changed and not v_became_ready then
    return new;
  end if;
  new.auto_refresh_state := (
    coalesce(new.auto_refresh_state, '{}'::jsonb) - array[
      'lockedAt', 'backoffUntil', 'lastClaimedAt', 'actionRequired',
      'actionRequiredReason', 'terminalHttpStatus', 'terminalErrorKind',
      'terminalFailureCount', 'terminalFirstAt', 'terminalLastAt', 'suspended'
    ]
  ) || jsonb_build_object(
    'attempts', 0,
    'lastOutcome', case when v_config_changed then 'config_changed' else 'foreground_recovered' end,
    'lastCompletedAt', clock_timestamp()
  );
  new.auto_refresh_lease_owner := null;
  new.auto_refresh_lease_expires_at := null;
  new.auto_refresh_lease_sequence := old.auto_refresh_lease_sequence + 1;
  new.auto_refresh_next_at := case
    when v_config_changed then clock_timestamp()
    else clock_timestamp() + interval '6 hours'
  end;
  return new;
end
$function$;

drop trigger if exists trg_cloud_sources_reset_auto_refresh_on_recovery
  on public.cloud_sources;
create trigger trg_cloud_sources_reset_auto_refresh_on_recovery
before update of config_ciphertext, sync_status on public.cloud_sources
for each row
execute function public.norva_reset_cloud_auto_refresh_on_source_recovery();

revoke all on function public.norva_claim_cloud_auto_refresh_sources(text,integer,integer)
  from public, anon, authenticated;
revoke all on function public.norva_settle_cloud_auto_refresh_source(uuid,uuid,text,bigint,text,timestamptz,integer,text)
  from public, anon, authenticated;
revoke all on function public.norva_reset_cloud_auto_refresh_on_source_recovery()
  from public, anon, authenticated, service_role;
revoke all on function public.norva_cloud_auto_refresh_trusted_context()
  from public, anon, authenticated, service_role;
revoke all on function public.norva_guard_cloud_auto_refresh_state()
  from public, anon, authenticated, service_role;

grant execute on function public.norva_claim_cloud_auto_refresh_sources(text,integer,integer)
  to service_role;
grant execute on function public.norva_settle_cloud_auto_refresh_source(uuid,uuid,text,bigint,text,timestamptz,integer,text)
  to service_role;

-- The cron endpoint, headers and activation state are operator-owned because
-- managed Supabase and self-hosted Hetzner use different URLs. Do not rewrite
-- that environment-specific command from a schema migration. The claim RPC is
-- the durable authority and filters suspended sources before any provider I/O;
-- an existing cheap wake-up may therefore remain a harmless no-op.
