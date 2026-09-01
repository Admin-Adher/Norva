-- A disabled source is a user-controlled pause: background workers must never
-- touch its provider account. When the same source becomes enabled and ready
-- again, however, any exact-file repair backlog must resume immediately instead
-- of waiting for a stale 24-hour schedule/exhaustion marker.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- M3U imports are intentionally bounded to one Edge isolate, but the isolate is
-- not a durable owner.  Persist the owner in PostgreSQL so overlapping cron
-- ticks, manual retries and recycled isolates can never open two provider
-- transports for the same source.  Failed attempts are also durable: transient
-- failures back off (1m, 5m, 15m) and the fourth failed provider attempt is
-- quarantined until the user explicitly disables/re-enables the source.
create table if not exists public.cloud_source_m3u_sync_leases (
  source_id uuid primary key references public.cloud_sources(id) on delete cascade,
  user_id uuid not null,
  lease_token uuid,
  lease_until timestamptz,
  reset_after_release boolean not null default false,
  attempt_count integer not null default 0 check (attempt_count between 0 and 4),
  next_attempt_at timestamptz not null default '-infinity'::timestamptz,
  state text not null default 'idle'
    check (state in ('idle', 'running', 'retry_wait', 'quarantined')),
  last_error_kind text,
  last_error_at timestamptz,
  updated_at timestamptz not null default statement_timestamp(),
  check (
    (state = 'running' and lease_token is not null and lease_until is not null)
    or (state <> 'running' and lease_token is null and lease_until is null)
  ),
  check (not reset_after_release or state = 'running')
);

alter table public.cloud_source_m3u_sync_leases enable row level security;
revoke all on table public.cloud_source_m3u_sync_leases
  from public, anon, authenticated, service_role;

create index if not exists cloud_source_m3u_sync_leases_due_idx
  on public.cloud_source_m3u_sync_leases (state, next_attempt_at, updated_at);

create or replace function public.norva_claim_source_m3u_sync_lease(
  p_source_id uuid,
  p_user_id uuid,
  p_lease_token uuid,
  p_ttl_seconds integer default 300
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_until timestamptz;
  v_lease public.cloud_source_m3u_sync_leases%rowtype;
begin
  if p_source_id is null
     or p_user_id is null
     or p_lease_token is null
     or p_ttl_seconds not between 60 and 900 then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_claim');
  end if;

  -- This row lock serializes the claim with enable/delete/config transitions.
  perform 1
  from public.cloud_sources source
  where source.id = p_source_id
    and source.user_id = p_user_id
    and source.source_type = 'm3u'
    and source.enabled
    and source.deleted_at is null
  for update;
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'source_not_eligible');
  end if;

  insert into public.cloud_source_m3u_sync_leases as lease (
    source_id, user_id, state, attempt_count, next_attempt_at, updated_at
  ) values (
    p_source_id, p_user_id, 'idle', 0, '-infinity'::timestamptz, v_now
  )
  on conflict (source_id) do nothing;

  select * into v_lease
  from public.cloud_source_m3u_sync_leases lease
  where lease.source_id = p_source_id
    and lease.user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'owner_mismatch');
  end if;

  -- A credential/re-enable reset cannot revoke an owner whose provider read is
  -- still in flight. Once that owner has settled (or its lease has expired),
  -- consume the deferred reset before evaluating retry/quarantine state.
  if v_lease.reset_after_release
     and (v_lease.state <> 'running' or v_lease.lease_until <= v_now) then
    update public.cloud_source_m3u_sync_leases lease
    set state = 'idle',
        lease_token = null,
        lease_until = null,
        reset_after_release = false,
        attempt_count = 0,
        next_attempt_at = '-infinity'::timestamptz,
        last_error_kind = null,
        last_error_at = null,
        updated_at = v_now
    where lease.source_id = p_source_id
      and lease.user_id = p_user_id
    returning lease.* into v_lease;
  end if;

  if v_lease.state = 'running' and v_lease.lease_until > v_now then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'leased',
      'retryAt', v_lease.lease_until,
      'attemptCount', v_lease.attempt_count
    );
  end if;
  if v_lease.state = 'quarantined' then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'quarantined',
      'attemptCount', v_lease.attempt_count
    );
  end if;
  if v_lease.attempt_count >= 4 then
    update public.cloud_source_m3u_sync_leases lease
    set state = 'quarantined',
        lease_token = null,
        lease_until = null,
        next_attempt_at = '-infinity'::timestamptz,
        last_error_kind = coalesce(lease.last_error_kind, 'LEASE_EXPIRED'),
        last_error_at = coalesce(lease.last_error_at, v_now),
        updated_at = v_now
    where lease.source_id = p_source_id
      and lease.user_id = p_user_id;
    return jsonb_build_object(
      'claimed', false,
      'reason', 'quarantined',
      'attemptCount', v_lease.attempt_count
    );
  end if;
  if v_lease.next_attempt_at > v_now then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'backoff',
      'retryAt', v_lease.next_attempt_at,
      'attemptCount', v_lease.attempt_count
    );
  end if;

  v_until := v_now + make_interval(secs => p_ttl_seconds);
  update public.cloud_source_m3u_sync_leases lease
  set state = 'running',
      lease_token = p_lease_token,
      lease_until = v_until,
      reset_after_release = false,
      attempt_count = least(4, lease.attempt_count + 1),
      next_attempt_at = '-infinity'::timestamptz,
      updated_at = v_now
  where lease.source_id = p_source_id
    and lease.user_id = p_user_id;

  update public.cloud_sources source
  set config_hint = jsonb_set(
        case when jsonb_typeof(source.config_hint) = 'object'
          then source.config_hint else '{}'::jsonb end,
        '{m3uSyncControl}',
        jsonb_build_object(
          'v', 1,
          'state', 'running',
          'attemptCount', least(4, v_lease.attempt_count + 1),
          'leaseUntil', v_until,
          'updatedAt', v_now
        ),
        true
      )
  where source.id = p_source_id
    and source.user_id = p_user_id;

  return jsonb_build_object(
    'claimed', true,
    'leaseUntil', v_until,
    'attemptCount', least(4, v_lease.attempt_count + 1)
  );
end
$function$;

-- Foreground check/estimate calls must share the same single-flight authority
-- without erasing or advancing the durable import retry budget. They may enter
-- only from a genuinely clean idle row. A crashed diagnostic owner is
-- recoverable after its lease expires because a diagnostic claim never raises
-- attempt_count above zero.
create or replace function public.norva_claim_source_m3u_diagnostic_lease(
  p_source_id uuid,
  p_user_id uuid,
  p_lease_token uuid,
  p_ttl_seconds integer default 60
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_until timestamptz;
  v_lease public.cloud_source_m3u_sync_leases%rowtype;
begin
  if p_source_id is null
     or p_user_id is null
     or p_lease_token is null
     or p_ttl_seconds not between 60 and 300 then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_claim');
  end if;

  perform 1
  from public.cloud_sources source
  where source.id = p_source_id
    and source.user_id = p_user_id
    and source.source_type = 'm3u'
    and source.enabled
    and source.deleted_at is null
  for update;
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'source_not_eligible');
  end if;

  insert into public.cloud_source_m3u_sync_leases as lease (
    source_id, user_id, state, attempt_count, next_attempt_at, updated_at
  ) values (
    p_source_id, p_user_id, 'idle', 0, '-infinity'::timestamptz, v_now
  )
  on conflict (source_id) do nothing;

  select * into v_lease
  from public.cloud_source_m3u_sync_leases lease
  where lease.source_id = p_source_id
    and lease.user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'owner_mismatch');
  end if;

  -- A configuration/re-enable reset may have been requested while a
  -- diagnostic provider read was live.  Once that owner has expired, consume
  -- the deferred reset here too; otherwise diagnostic-only callers would keep
  -- seeing an already-expired row as leased forever.
  if v_lease.reset_after_release
     and (v_lease.state <> 'running' or v_lease.lease_until <= v_now) then
    update public.cloud_source_m3u_sync_leases lease
    set state = 'idle',
        lease_token = null,
        lease_until = null,
        reset_after_release = false,
        attempt_count = 0,
        next_attempt_at = '-infinity'::timestamptz,
        last_error_kind = null,
        last_error_at = null,
        updated_at = v_now
    where lease.source_id = p_source_id
      and lease.user_id = p_user_id
    returning lease.* into v_lease;
  end if;

  if v_lease.state = 'running'
     and v_lease.attempt_count = 0
     and not v_lease.reset_after_release
     and v_lease.lease_until <= v_now then
    update public.cloud_source_m3u_sync_leases lease
    set state = 'idle',
        lease_token = null,
        lease_until = null,
        updated_at = v_now
    where lease.source_id = p_source_id
      and lease.user_id = p_user_id
    returning lease.* into v_lease;
  end if;

  if v_lease.state = 'running' then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'leased',
      'retryAt', v_lease.lease_until,
      'attemptCount', v_lease.attempt_count
    );
  elsif v_lease.state = 'quarantined' then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'quarantined',
      'attemptCount', v_lease.attempt_count
    );
  elsif v_lease.state <> 'idle'
        or v_lease.attempt_count <> 0
        or v_lease.next_attempt_at > v_now
        or v_lease.reset_after_release then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'backoff',
      'retryAt', v_lease.next_attempt_at,
      'attemptCount', v_lease.attempt_count
    );
  end if;

  v_until := v_now + make_interval(secs => p_ttl_seconds);
  update public.cloud_source_m3u_sync_leases lease
  set state = 'running',
      lease_token = p_lease_token,
      lease_until = v_until,
      reset_after_release = false,
      updated_at = v_now
  where lease.source_id = p_source_id
    and lease.user_id = p_user_id;

  return jsonb_build_object(
    'claimed', true,
    'leaseUntil', v_until,
    'attemptCount', 0,
    'diagnostic', true
  );
end
$function$;

create or replace function public.norva_renew_source_m3u_sync_lease(
  p_source_id uuid,
  p_user_id uuid,
  p_lease_token uuid,
  p_ttl_seconds integer default 300
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_until timestamptz := v_now + make_interval(secs => p_ttl_seconds);
  v_renewed boolean := false;
begin
  if p_source_id is null
     or p_user_id is null
     or p_lease_token is null
     or p_ttl_seconds not between 60 and 900 then
    return false;
  end if;

  -- Preserve the global lock order used by claim and the enable trigger:
  -- cloud_sources first, then cloud_source_m3u_sync_leases.  Renewing in the
  -- opposite order can deadlock an explicit disable/re-enable or a new claim.
  perform 1
  from public.cloud_sources source
  where source.id = p_source_id
    and source.user_id = p_user_id
    and source.source_type = 'm3u'
    and source.enabled
    and source.deleted_at is null
  for update;
  if not found then
    return false;
  end if;

  update public.cloud_source_m3u_sync_leases lease
  set lease_until = v_until,
      updated_at = v_now
  where lease.source_id = p_source_id
    and lease.user_id = p_user_id
    and lease.state = 'running'
    and lease.lease_token = p_lease_token
    and not lease.reset_after_release
    and lease.lease_until > v_now
  returning true into v_renewed;

  if v_renewed then
    update public.cloud_sources source
    set config_hint = jsonb_set(
          case when jsonb_typeof(source.config_hint) = 'object'
            then source.config_hint else '{}'::jsonb end,
          '{m3uSyncControl}',
          coalesce(source.config_hint->'m3uSyncControl', '{}'::jsonb)
            || jsonb_build_object('state', 'running', 'leaseUntil', v_until, 'updatedAt', v_now),
          true
        )
    where source.id = p_source_id
      and source.user_id = p_user_id;
  end if;

  return coalesce(v_renewed, false);
end
$function$;

create or replace function public.norva_settle_source_m3u_sync_lease(
  p_source_id uuid,
  p_user_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_error_kind text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_lease public.cloud_source_m3u_sync_leases%rowtype;
  v_state text;
  v_retry_at timestamptz := '-infinity'::timestamptz;
  v_clear_budget boolean := false;
begin
  if p_outcome not in ('success', 'transient_error', 'permanent_error', 'cancelled') then
    return jsonb_build_object('settled', false, 'reason', 'invalid_outcome');
  end if;

  -- Settlement must use the same source -> lease lock order as claim/renew.
  -- Do not require enabled/visible here: a worker that observes a concurrent
  -- user pause still needs to release its exact token without reopening I/O.
  perform 1
  from public.cloud_sources source
  where source.id = p_source_id
    and source.user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('settled', false, 'reason', 'source_gone');
  end if;

  select * into v_lease
  from public.cloud_source_m3u_sync_leases lease
  where lease.source_id = p_source_id
    and lease.user_id = p_user_id
    and lease.state = 'running'
    and lease.lease_token = p_lease_token
  for update;
  if not found then
    return jsonb_build_object('settled', false, 'reason', 'lease_lost');
  end if;

  -- A reset requested while the provider transport was live wins over the old
  -- attempt's outcome. The old token is the only actor allowed to release it;
  -- the next claim then starts with a fresh attempt budget.
  v_clear_budget := v_lease.reset_after_release
    or p_outcome in ('success', 'cancelled');

  if v_clear_budget then
    v_state := 'idle';
  elsif p_outcome = 'permanent_error' or v_lease.attempt_count >= 4 then
    v_state := 'quarantined';
  else
    v_state := 'retry_wait';
    v_retry_at := v_now + case v_lease.attempt_count
      when 1 then interval '1 minute'
      when 2 then interval '5 minutes'
      else interval '15 minutes'
    end;
  end if;

  update public.cloud_source_m3u_sync_leases lease
  set state = v_state,
      lease_token = null,
      lease_until = null,
      reset_after_release = false,
      attempt_count = case when v_clear_budget
        then 0 else lease.attempt_count end,
      next_attempt_at = case when v_state = 'retry_wait'
        then v_retry_at else '-infinity'::timestamptz end,
      last_error_kind = case when v_clear_budget
        then null else nullif(left(coalesce(p_error_kind, 'UNKNOWN'), 120), '') end,
      last_error_at = case when v_clear_budget
        then null else v_now end,
      updated_at = v_now
  where lease.source_id = p_source_id
    and lease.user_id = p_user_id;

  update public.cloud_sources source
  set config_hint = jsonb_set(
        case when jsonb_typeof(source.config_hint) = 'object'
          then source.config_hint else '{}'::jsonb end,
        '{m3uSyncControl}',
        jsonb_strip_nulls(jsonb_build_object(
          'v', 1,
          'state', v_state,
          'attemptCount', case when v_clear_budget then 0 else v_lease.attempt_count end,
          'nextAttemptAt', case when v_state = 'retry_wait' then v_retry_at else null end,
          'lastErrorKind', case when v_clear_budget then null else p_error_kind end,
          'updatedAt', v_now
        )),
        true
      )
  where source.id = p_source_id
    and source.user_id = p_user_id;

  return jsonb_build_object(
    'settled', true,
    'state', v_state,
    'attemptCount', case when v_clear_budget then 0 else v_lease.attempt_count end,
    'retryAt', case when v_state = 'retry_wait' then v_retry_at else null end
  );
end
$function$;

revoke all on function public.norva_claim_source_m3u_sync_lease(uuid,uuid,uuid,integer)
  from public, anon, authenticated;
revoke all on function public.norva_claim_source_m3u_diagnostic_lease(uuid,uuid,uuid,integer)
  from public, anon, authenticated;
revoke all on function public.norva_renew_source_m3u_sync_lease(uuid,uuid,uuid,integer)
  from public, anon, authenticated;
revoke all on function public.norva_settle_source_m3u_sync_lease(uuid,uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.norva_claim_source_m3u_sync_lease(uuid,uuid,uuid,integer)
  to service_role;
grant execute on function public.norva_claim_source_m3u_diagnostic_lease(uuid,uuid,uuid,integer)
  to service_role;
grant execute on function public.norva_renew_source_m3u_sync_lease(uuid,uuid,uuid,integer)
  to service_role;
grant execute on function public.norva_settle_source_m3u_sync_lease(uuid,uuid,uuid,text,text)
  to service_role;

comment on table public.cloud_source_m3u_sync_leases is
  'Durable single-flight, bounded retry and quarantine state for M3U catalogue imports.';

-- The minutely norva-resume-stuck-sync watchdog is the durable owner of an
-- interrupted import.  Re-enabling must therefore make the existing cursor
-- immediately claimable in the row itself; an Edge waitUntil is only an
-- acceleration and cannot be the correctness boundary because its isolate may
-- disappear after the enabled CAS commits.
create or replace function public.norva_schedule_source_sync_resume_when_enabled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_due_at timestamptz := '1970-01-01 00:00:00+00'::timestamptz;
  v_hint jsonb := case when jsonb_typeof(new.config_hint) = 'object'
    then new.config_hint else '{}'::jsonb end;
  v_cursor jsonb;
  v_progress jsonb;
  v_finalize_cursor jsonb;
  v_discovery_resume boolean := false;
  v_finalize_resume boolean := false;
begin
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id then
    raise exception 'source ownership is immutable' using errcode = '42501';
  end if;

  if not coalesce(new.enabled, false)
     or coalesce(old.enabled, false)
     or new.deleted_at is not null
     or new.source_type not in ('xtream', 'm3u') then
    return new;
  end if;

  -- A deliberate re-enable is the recovery boundary for a quarantined M3U
  -- import. Never delete a still-live owner: its provider read may remain in
  -- flight until the next heartbeat. Mark it for reset-on-release instead, so a
  -- new worker cannot recreate the row and open a second provider transport.
  if new.source_type = 'm3u' then
    update public.cloud_source_m3u_sync_leases lease
    set reset_after_release = true,
        updated_at = v_now
    where lease.source_id = new.id
      and lease.user_id = new.user_id
      and lease.state = 'running'
      and lease.lease_until > v_now;

    if not found then
      delete from public.cloud_source_m3u_sync_leases lease
      where lease.source_id = new.id
        and lease.user_id = new.user_id;
    end if;
  end if;

  -- A ready M3U may have been quarantined by the independent raw-only fair
  -- refresh lane. The false -> true transition above is still its explicit
  -- recovery boundary, but it must not rewrite a healthy catalogue status or
  -- manufacture a resumable cursor. The fair-refresh recovery trigger has
  -- already made the row due; only the provider lease reset belongs here.
  if new.sync_status = 'ready' then
    return new;
  end if;

  v_cursor := case when jsonb_typeof(v_hint->'syncCursor') = 'object'
    then v_hint->'syncCursor' else '{}'::jsonb end;
  v_progress := case when jsonb_typeof(v_hint->'syncProgress') = 'object'
    then v_hint->'syncProgress' else '{}'::jsonb end;
  v_finalize_cursor := case when jsonb_typeof(v_hint->'finalizeCursor') = 'object'
    then v_hint->'finalizeCursor' else '{}'::jsonb end;

  v_discovery_resume := new.source_type = 'xtream'
    and v_cursor->>'active' = 'true'
    and v_cursor->>'phase' = 'discover';
  v_finalize_resume := new.source_type = 'xtream'
    and (
      coalesce(v_progress->>'stage', '') in (
        'materializing', 'building_titles', 'building_live_channels',
        'building_live_variants', 'finalizing'
      )
      or coalesce(v_finalize_cursor->>'phase', '') in (
        'live', 'live_channels', 'live_variants', 'titles', 'complete'
      )
    );

  if v_discovery_resume then
    -- Preserve the exact run/generation cursor, but reset its continuation
    -- budget and stale its heartbeat so the existing watchdog can claim it on
    -- the next minute even if the enabling HTTP isolate dies immediately.
    v_cursor := jsonb_set(v_cursor, '{attempts}', '0'::jsonb, true);
    v_cursor := jsonb_set(v_cursor, '{heartbeatAt}', to_jsonb(v_due_at), true);
    new.config_hint := jsonb_set(v_hint, '{syncCursor}', v_cursor, true);
  elsif v_finalize_resume then
    -- Finalization has its own persisted cursor and lease.  Only make the
    -- progress timestamp due; the watchdog still honours an unexpired lease.
    v_progress := jsonb_set(v_progress, '{updatedAt}', to_jsonb(v_due_at), true);
    new.config_hint := jsonb_set(v_hint, '{syncProgress}', v_progress, true);
  elsif new.source_type = 'xtream' then
    -- A legacy/non-ready source may predate the resumable cursor.  Materialize
    -- the same v1 cursor shape used by freshSyncCursor so the watchdog can start
    -- it without a request-owned promise.
    v_cursor := jsonb_build_object(
      'v', 1,
      'active', true,
      'phase', 'discover',
      'deleted', false,
      'typeIdx', 0,
      'catIdx', 0,
      'counts', jsonb_build_object('live', 0, 'movies', 0, 'series', 0),
      'sig', jsonb_build_object(
        'live', jsonb_build_object('count', 0, 'maxAdded', 0, 'xor', 0, 'add', 0),
        'movie', jsonb_build_object('count', 0, 'maxAdded', 0, 'xor', 0, 'add', 0),
        'series', jsonb_build_object('count', 0, 'maxAdded', 0, 'xor', 0, 'add', 0)
      ),
      'startedAt', v_now,
      'heartbeatAt', v_due_at,
      'attempts', 0,
      'runVersion', floor(extract(epoch from v_now) * 1000)::bigint,
      'fetchErrors', 0
    );
    new.sync_status := 'syncing';
    new.sync_error := null;
    new.config_hint := jsonb_set(v_hint, '{syncCursor}', v_cursor, true);
  else
    -- M3U imports are single-isolate, so the same watchdog uses the durable
    -- status/progress marker instead of a discovery cursor.
    new.sync_status := 'syncing';
    new.sync_error := null;
    v_progress := jsonb_set(v_progress, '{status}', '"queued"'::jsonb, true);
    v_progress := jsonb_set(v_progress, '{stage}', '"queued"'::jsonb, true);
    v_progress := jsonb_set(v_progress, '{updatedAt}', to_jsonb(v_due_at), true);
    new.config_hint := jsonb_set(v_hint, '{syncProgress}', v_progress, true);
  end if;

  return new;
end
$function$;

revoke all on function public.norva_schedule_source_sync_resume_when_enabled()
  from public, anon, authenticated;

drop trigger if exists trg_schedule_source_sync_resume_when_enabled
  on public.cloud_sources;
create trigger trg_schedule_source_sync_resume_when_enabled
before update of enabled, sync_status, deleted_at
on public.cloud_sources
for each row
execute function public.norva_schedule_source_sync_resume_when_enabled();

-- Extend the fair-refresh recovery boundary to the explicit M3U source
-- re-enable action. A ready source never transitions through sync_status, so
-- the original config/foreground-ready trigger alone cannot release a
-- TOGGLE_SOURCE suspension. Sequence fencing invalidates an old fair worker;
-- the M3U transport lease above is independently reset now or on release.
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
  v_reenabled_m3u boolean := new.source_type = 'm3u'
    and coalesce(new.enabled, false)
    and not coalesce(old.enabled, false)
    and new.deleted_at is null;
begin
  if not v_config_changed and not v_became_ready and not v_reenabled_m3u then
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
    'lastOutcome', case
      when v_config_changed then 'config_changed'
      when v_reenabled_m3u then 'source_reenabled'
      else 'foreground_recovered'
    end,
    'lastCompletedAt', clock_timestamp()
  );
  new.auto_refresh_lease_owner := null;
  new.auto_refresh_lease_expires_at := null;
  new.auto_refresh_lease_sequence := old.auto_refresh_lease_sequence + 1;
  new.auto_refresh_next_at := case
    when v_config_changed or v_reenabled_m3u then clock_timestamp()
    else clock_timestamp() + interval '6 hours'
  end;
  return new;
end
$function$;

drop trigger if exists trg_cloud_sources_reset_auto_refresh_on_recovery
  on public.cloud_sources;
create trigger trg_cloud_sources_reset_auto_refresh_on_recovery
before update of config_ciphertext, sync_status, enabled on public.cloud_sources
for each row
execute function public.norva_reset_cloud_auto_refresh_on_source_recovery();

revoke all on function public.norva_reset_cloud_auto_refresh_on_source_recovery()
  from public, anon, authenticated, service_role;

-- A committed credential transition is also an explicit recovery boundary.
-- Keeping an old permanent-error quarantine after the encrypted M3U config was
-- replaced would strand the corrected source indefinitely.
create or replace function public.norva_reset_m3u_sync_lease_after_config_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id then
    raise exception 'source ownership is immutable' using errcode = '42501';
  end if;

  if new.source_type = 'm3u'
     and new.config_ciphertext is distinct from old.config_ciphertext then
    update public.cloud_source_m3u_sync_leases lease
    set reset_after_release = true,
        updated_at = v_now
    where lease.source_id = new.id
      and lease.user_id = new.user_id
      and lease.state = 'running'
      and lease.lease_until > v_now;

    if not found then
      delete from public.cloud_source_m3u_sync_leases lease
      where lease.source_id = new.id
        and lease.user_id = new.user_id;
    end if;
  end if;
  return new;
end
$function$;

revoke all on function public.norva_reset_m3u_sync_lease_after_config_change()
  from public, anon, authenticated;

drop trigger if exists trg_reset_m3u_sync_lease_after_config_change
  on public.cloud_sources;
create trigger trg_reset_m3u_sync_lease_after_config_change
after update of config_ciphertext
on public.cloud_sources
for each row
execute function public.norva_reset_m3u_sync_lease_after_config_change();

create or replace function public.norva_wake_source_enrichment_when_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  -- Source ownership is immutable in the managed-source contract. Refuse to
  -- turn this maintenance trigger into a cross-tenant write primitive even if
  -- a future caller weakens that surrounding boundary.
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id then
    raise exception 'source ownership is immutable' using errcode = '42501';
  end if;

  if not coalesce(new.enabled, false)
     or new.deleted_at is not null
     or new.sync_status <> 'ready'
     or (
       coalesce(old.enabled, false)
       and old.deleted_at is null
       and old.sync_status = 'ready'
     ) then
    return new;
  end if;

  if exists (
    select 1
    from public.cloud_catalog_visible_title_variants variant
    where variant.source_id = new.id
      and variant.user_id = new.user_id
      and variant.item_type = 'movie'
  ) then
    insert into public.catalog_enrichment_source_schedule as schedule (
      source_id,
      user_id,
      next_run_at,
      dispatch_count,
      cycle_had_work,
      updated_at
    ) values (
      new.id,
      new.user_id,
      v_now,
      0,
      false,
      v_now
    )
    on conflict on constraint catalog_enrichment_source_schedule_pkey do update
      set next_run_at = case
            when schedule.lease_until is null or schedule.lease_until <= v_now
              then least(schedule.next_run_at, excluded.next_run_at)
            else schedule.next_run_at
          end,
          dispatch_count = case
            when schedule.lease_until is null or schedule.lease_until <= v_now
              then schedule.dispatch_count - mod(schedule.dispatch_count, 12)
            else schedule.dispatch_count
          end,
          cycle_had_work = case
            when schedule.lease_until is null or schedule.lease_until <= v_now
              then false
            else schedule.cycle_had_work
          end,
          updated_at = v_now
      where schedule.user_id = excluded.user_id;

    -- The repaired empty-audio rows are movie-probe candidates again. A dry
    -- memo written before the source was paused must not suppress either the
    -- exact probe or the independent strict-untagged certification lane.
    delete from public.enrichment_exhausted exhausted
    where exhausted.k in (
      new.user_id::text || ':' || new.id::text || ':movie:probe',
      new.user_id::text || ':' || new.id::text || ':movie:whisper-untagged'
    );
  end if;

  return new;
end
$function$;

revoke all on function public.norva_wake_source_enrichment_when_ready()
  from public, anon, authenticated;

drop trigger if exists trg_wake_source_enrichment_when_ready
  on public.cloud_sources;
create trigger trg_wake_source_enrichment_when_ready
after update of enabled, sync_status, deleted_at
on public.cloud_sources
for each row
execute function public.norva_wake_source_enrichment_when_ready();

-- Keep the existing minutely watchdog as the only durable dispatcher, but
-- align its cheap pg_cron guard with the worker now that it also resumes M3U.
do $cron_guard$
declare
  v_job_id bigint;
  v_job_count integer;
  v_active_job_count integer;
  v_secret_count integer;
  v_command text := $command$
      select net.http_post(
        url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/resume-stuck',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'norva_cron_shared_secret'
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 5000
      )
      where exists (
        select 1
        from public.cloud_sources source
        where source.source_type in ('xtream', 'm3u')
          and source.sync_status in ('syncing', 'error')
          and source.enabled
          and source.deleted_at is null
      );
    $command$;
begin
  if to_regnamespace('cron') is null then
    raise exception 'required pg_cron schema is unavailable'
      using errcode = '55000';
  end if;

  -- Serialize install/repair attempts for this logical job. pg_cron does not
  -- enforce jobname uniqueness, so a count-then-create sequence alone can race
  -- two concurrent deployers into duplicate active dispatchers.
  perform pg_advisory_xact_lock(hashtextextended(
    'norva-cron-job:norva-resume-stuck-sync', 0
  ));

  select count(*) into v_secret_count
  from vault.decrypted_secrets secret
  where secret.name = 'norva_cron_shared_secret'
    and nullif(secret.decrypted_secret, '') is not null;
  if v_secret_count <> 1 then
    raise exception 'exactly one non-empty norva_cron_shared_secret is required'
      using errcode = '55000';
  end if;

  select count(*), count(*) filter (where active), min(jobid)
  into v_job_count, v_active_job_count, v_job_id
  from cron.job
  where jobname = 'norva-resume-stuck-sync';

  if v_job_count > 1 then
    raise exception 'exactly one norva-resume-stuck-sync job is required'
      using errcode = '55000';
  elsif v_job_count = 0 then
    v_job_id := cron.schedule(
      'norva-resume-stuck-sync', '* * * * *', v_command
    );
  else
    perform cron.alter_job(
      v_job_id,
      schedule => '* * * * *',
      command => v_command,
      active => true
    );
  end if;

  select count(*) into v_active_job_count
  from cron.job
  where jobname = 'norva-resume-stuck-sync'
    and active;
  if v_active_job_count <> 1 or v_job_id is null then
    raise exception 'exactly one active norva-resume-stuck-sync job is required'
      using errcode = '55000';
  end if;
end
$cron_guard$;

commit;
