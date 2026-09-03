-- The logical live catalogue exposes one compact preview per quality label,
-- but every distinct provider stream must remain a materialized fallback.
-- Re-run only READY M3U catalogues whose active raw live rows outnumber their
-- materialized concrete variants after the former page-local label collapse.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

create temporary table m3u_live_variant_rebuild_candidates
on commit drop
as
select
  source.id as source_id,
  source.user_id,
  raw_count.value as raw_live,
  variant_count.value as live_variants
from public.cloud_sources source
left join public.cloud_source_catalog_heads head
  on head.source_id = source.id
 and head.user_id = source.user_id
cross join lateral (
  select count(*)::bigint as value
  from public.cloud_media_items raw
  where raw.source_id = source.id
    and raw.user_id = source.user_id
    and raw.item_type = 'live'
    and raw.available
    and (raw.generation_id is null or raw.generation_id = head.active_generation_id)
) raw_count
cross join lateral (
  select count(*)::bigint as value
  from public.cloud_live_variants variant
  where variant.source_id = source.id
    and variant.user_id = source.user_id
    and (variant.generation_id is null or variant.generation_id = head.active_generation_id)
) variant_count
where source.source_type = 'm3u'
  and source.sync_status = 'ready'
  and source.enabled
  and source.deleted_at is null
  and raw_count.value > variant_count.value;

update public.cloud_sources source
set sync_status = 'syncing',
    sync_error = null,
    config_hint = (
      (case when jsonb_typeof(source.config_hint) = 'object'
        then source.config_hint else '{}'::jsonb end) - 'finalizeLease'
    ) || jsonb_build_object(
      'finalizeCursor', jsonb_build_object(
        'phase', 'live',
        'offset', 0,
        'afterId', ''
      ),
      'syncProgress', (
        case when jsonb_typeof(source.config_hint->'syncProgress') = 'object'
          then source.config_hint->'syncProgress' else '{}'::jsonb end
      ) || jsonb_build_object(
        'status', 'syncing',
        'stage', 'finalizing',
        'percent', 91,
        'updatedAt', '1970-01-01T00:00:00.000Z',
        'steps', (
          case when jsonb_typeof(source.config_hint->'syncProgress'->'steps') = 'object'
            then source.config_hint->'syncProgress'->'steps' else '{}'::jsonb end
        ) || jsonb_build_object('finalize', jsonb_build_object('status', 'running'))
      )
    )
from m3u_live_variant_rebuild_candidates candidate
where source.id = candidate.source_id
  and source.user_id = candidate.user_id;

update public.cloud_source_m3u_sync_leases lease
set state = 'idle',
    lease_token = null,
    lease_until = null,
    reset_after_release = false,
    attempt_count = 0,
    next_attempt_at = '-infinity'::timestamptz,
    last_error_kind = null,
    last_error_at = null,
    updated_at = clock_timestamp()
from m3u_live_variant_rebuild_candidates candidate
where lease.source_id = candidate.source_id
  and lease.user_id = candidate.user_id;

do $verify$
begin
  if exists (
    select 1
    from m3u_live_variant_rebuild_candidates candidate
    join public.cloud_sources source
      on source.id = candidate.source_id
     and source.user_id = candidate.user_id
    left join public.cloud_source_m3u_sync_leases lease
      on lease.source_id = candidate.source_id
     and lease.user_id = candidate.user_id
    where candidate.raw_live <= candidate.live_variants
       or source.sync_status <> 'syncing'
       or source.config_hint #>> '{finalizeCursor,phase}' <> 'live'
       or source.config_hint #>> '{finalizeCursor,offset}' <> '0'
       or source.config_hint ? 'finalizeLease'
       or coalesce(lease.state, '') <> 'idle'
       or coalesce(lease.attempt_count, -1) <> 0
       or lease.lease_token is not null
       or lease.lease_until is not null
  ) then
    raise exception 'M3U concrete live variant rebuild invariant failed'
      using errcode = '55000';
  end if;
end
$verify$;

commit;
