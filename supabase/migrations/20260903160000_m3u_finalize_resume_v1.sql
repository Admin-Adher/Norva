-- M3U provider I/O and catalogue projection are separate durable phases.
-- Raw rows that already reached finalization can therefore resume locally,
-- even when an obsolete provider transport lease was quarantined after the
-- Edge isolate died during the former one-shot projection.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- Reaching READY proves provider transport is no longer in flight. Reset its
-- independent retry budget in the same source-row transaction so a crash
-- between finalization handoff and explicit lease settlement cannot leave a
-- healthy source carrying a stale running/quarantined transport state.
create or replace function public.norva_settle_m3u_transport_on_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_hint jsonb := case when jsonb_typeof(new.config_hint) = 'object'
    then new.config_hint else '{}'::jsonb end;
begin
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id then
    raise exception 'source ownership is immutable' using errcode = '42501';
  end if;

  if new.source_type <> 'm3u'
     or new.sync_status <> 'ready'
     or old.sync_status = 'ready' then
    return new;
  end if;

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
  where lease.source_id = new.id
    and lease.user_id = new.user_id;

  new.config_hint := jsonb_set(
    v_hint,
    '{m3uSyncControl}',
    jsonb_build_object(
      'v', 1,
      'state', 'idle',
      'attemptCount', 0,
      'updatedAt', v_now
    ),
    true
  );
  return new;
end
$function$;

revoke all on function public.norva_settle_m3u_transport_on_ready()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_zz_settle_m3u_transport_on_ready
  on public.cloud_sources;
create trigger trg_zz_settle_m3u_transport_on_ready
before update of sync_status
on public.cloud_sources
for each row
execute function public.norva_settle_m3u_transport_on_ready();

-- Capture only sources whose raw import is explicitly complete. No provider
-- credential, URL, tenant identifier or source identifier is hard-coded here.
create temporary table m3u_finalize_resume_candidates
on commit drop
as
select source.id as source_id, source.user_id
from public.cloud_sources source
where source.source_type = 'm3u'
  and source.sync_status in ('syncing', 'error')
  and source.enabled
  and source.deleted_at is null
  and coalesce(source.config_hint->'syncProgress'->>'stage', '') in (
    'materializing', 'building_titles', 'building_live_channels',
    'building_live_variants', 'finalizing'
  )
  and source.config_hint->'syncProgress'->'steps'->'import'->>'status' = 'done'
  and jsonb_typeof(source.config_hint->'syncProgress'->'counts'->'total') = 'number'
  and (source.config_hint->'syncProgress'->'counts'->>'total')::numeric > 0;

-- Seed (or preserve) the exact bounded cursor and make its progress heartbeat
-- immediately due. The minutely watchdog becomes the sole durable dispatcher.
update public.cloud_sources source
set sync_status = 'syncing',
    sync_error = null,
    config_hint = (
      (case when jsonb_typeof(source.config_hint) = 'object'
        then source.config_hint else '{}'::jsonb end) - 'finalizeLease'
    ) || jsonb_build_object(
      'finalizeCursor', case
        when jsonb_typeof(source.config_hint->'finalizeCursor') = 'object'
         and coalesce(source.config_hint->'finalizeCursor'->>'phase', '') in (
           'live', 'live_channels', 'live_variants', 'titles', 'complete'
         )
         and jsonb_typeof(source.config_hint->'finalizeCursor'->'offset') = 'number'
         and (source.config_hint->'finalizeCursor'->>'offset')::numeric >= 0
          then source.config_hint->'finalizeCursor'
            || jsonb_build_object(
              'afterId', coalesce(source.config_hint->'finalizeCursor'->>'afterId', '')
            )
        else jsonb_build_object('phase', 'live', 'offset', 0, 'afterId', '')
      end,
      'm3uSyncControl', jsonb_build_object(
        'v', 1,
        'state', 'idle',
        'attemptCount', 0,
        'updatedAt', clock_timestamp()
      ),
      'syncProgress', (
        case when jsonb_typeof(source.config_hint->'syncProgress') = 'object'
          then source.config_hint->'syncProgress' else '{}'::jsonb end
      ) || jsonb_build_object(
        'status', 'syncing',
        'stage', 'finalizing',
        'percent', greatest(
          86,
          case
            when jsonb_typeof(source.config_hint->'syncProgress'->'percent') = 'number'
              then least(99, (source.config_hint->'syncProgress'->>'percent')::integer)
            else 86
          end
        ),
        'updatedAt', '1970-01-01T00:00:00.000Z',
        'steps', (
          case when jsonb_typeof(source.config_hint->'syncProgress'->'steps') = 'object'
            then source.config_hint->'syncProgress'->'steps' else '{}'::jsonb end
        ) || jsonb_build_object('finalize', jsonb_build_object('status', 'running'))
      )
    )
from m3u_finalize_resume_candidates candidate
where source.id = candidate.source_id
  and source.user_id = candidate.user_id;

insert into public.cloud_source_m3u_sync_leases as lease (
  source_id,
  user_id,
  state,
  lease_token,
  lease_until,
  reset_after_release,
  attempt_count,
  next_attempt_at,
  last_error_kind,
  last_error_at,
  updated_at
)
select
  candidate.source_id,
  candidate.user_id,
  'idle',
  null,
  null,
  false,
  0,
  '-infinity'::timestamptz,
  null,
  null,
  clock_timestamp()
from m3u_finalize_resume_candidates candidate
on conflict (source_id) do update
set user_id = excluded.user_id,
    state = 'idle',
    lease_token = null,
    lease_until = null,
    reset_after_release = false,
    attempt_count = 0,
    next_attempt_at = '-infinity'::timestamptz,
    last_error_kind = null,
    last_error_at = null,
    updated_at = excluded.updated_at;

do $verify$
begin
  if exists (
    select 1
    from m3u_finalize_resume_candidates candidate
    join public.cloud_sources source
      on source.id = candidate.source_id
     and source.user_id = candidate.user_id
    left join public.cloud_source_m3u_sync_leases lease
      on lease.source_id = candidate.source_id
     and lease.user_id = candidate.user_id
    where source.sync_status <> 'syncing'
       or coalesce(source.config_hint->'finalizeCursor'->>'phase', '') not in (
         'live', 'live_channels', 'live_variants', 'titles', 'complete'
       )
       or coalesce(lease.state, '') <> 'idle'
       or coalesce(lease.attempt_count, -1) <> 0
       or lease.lease_token is not null
       or lease.lease_until is not null
  ) then
    raise exception 'M3U finalization recovery invariant failed'
      using errcode = '55000';
  end if;
end
$verify$;

comment on function public.norva_settle_m3u_transport_on_ready() is
  'Resets the independent M3U provider transport lease when durable catalogue finalization reaches ready.';

commit;
