-- Authoritative, exact-file diagnostics for the dynamic enrichment fleet.
--
-- The legacy admin coverage card reads cloud_titles.audio_probed_at. Since the
-- exact-file cutover, that compatibility timestamp is intentionally not
-- refreshed for every multi-variant title, so zero title-level throughput is
-- not evidence that the worker stopped. This RPC reports the durable scheduler,
-- provider guards and canonical file coordinates used by the current workers.
--
-- The query is intentionally bounded to admin_enrichment_accounts. Its large
-- joins start from those sources and use existing primary/unique indexes:
--   cloud_title_variants(source_id, item_type, external_id)
--   cloud_title_file_language_observations(user_id, variant_id, file_external_id)
--   catalog_file_tracks(server_host, item_type, external_id)
--   catalog_series_episode_memberships(source_id, parent_series_id, episode_id)
-- No provider secret, URL, response body or editable config_hint value is
-- returned or used as an identity.

begin;

create or replace function public.admin_enrichment_engine_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, cron
set max_parallel_workers_per_gather = 0
set statement_timeout = '30s'
set work_mem = '16MB'
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_enrichment_paused boolean := false;
  v_episode_audio_scan_enabled boolean := false;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'enrichment_paused'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'episode_audio_scan_enabled'
    ), false)
    into v_enrichment_paused, v_episode_audio_scan_enabled
  from public.admin_feature_flags flag
  where flag.key in ('enrichment_paused', 'episode_audio_scan_enabled');

  return (
    with driver_sources as materialized (
      select
        account.user_id,
        owner.email as owner_email,
        source.id as source_id,
        coalesce(
          provider_identity.display_name,
          source.display_name,
          left(source.id::text, 8)
        ) as panel,
        source.enabled as source_enabled,
        source.sync_status as source_sync_status,
        identity.identity_id as provider_identity_id,
        identity.provider_key,
        case
          when coalesce(source.config_hint->>'serverHost', '') <> ''
           and coalesce(source.config_hint->>'username', '') <> ''
            then lower(source.config_hint->>'serverHost')
              || '/'
              || (source.config_hint->>'username')
          else null
        end as provider_account_key,
        coalesce(
          identity.identity_id::text,
          'source:' || source.id::text
        ) as movie_cache_server
      from public.admin_enrichment_accounts account
      join auth.users owner
        on owner.id = account.user_id
      join public.cloud_sources source
        on source.user_id = account.user_id
       and source.deleted_at is null
      left join public.catalog_source_provider_identities identity
        on identity.source_id = source.id
       and identity.user_id = source.user_id
      left join public.provider_identities provider_identity
        on provider_identity.id = identity.identity_id
    ),
    owned_variants as materialized (
      select
        driver.user_id,
        driver.owner_email,
        driver.source_id,
        driver.panel,
        driver.source_enabled,
        driver.source_sync_status,
        driver.provider_identity_id,
        driver.provider_key,
        driver.provider_account_key,
        driver.movie_cache_server,
        variant.id as variant_id,
        variant.title_id,
        variant.item_type,
        variant.external_id
      from driver_sources driver
      join public.cloud_title_variants variant
        on variant.source_id = driver.source_id
       and variant.user_id = driver.user_id
       and variant.item_type in ('movie', 'series')
    ),
    source_title_progress as materialized (
      select
        variant.source_id,
        variant.title_id,
        variant.item_type,
        coalesce(bool_or(
          observation.audio_observed
          and observation.audio_verified_at is not null
          and cardinality(observation.audio_languages) > 0
        ), false) as has_resolved_audio,
        coalesce(bool_or(
          observation.subtitle_observed
          and cardinality(observation.subtitle_languages) > 0
        ), false) as has_subtitles
      from owned_variants variant
      left join public.cloud_title_file_language_observations observation
        on observation.user_id = variant.user_id
       and observation.variant_id = variant.variant_id
       and observation.title_id = variant.title_id
      group by
        variant.source_id,
        variant.title_id,
        variant.item_type
    ),
    source_types as materialized (
      select
        driver.user_id,
        driver.owner_email,
        driver.source_id,
        driver.panel,
        driver.source_enabled,
        driver.source_sync_status,
        driver.provider_identity_id,
        driver.provider_key,
        driver.provider_account_key,
        driver.movie_cache_server,
        progress.item_type,
        count(*)::bigint as catalog_titles,
        count(*) filter (
          where progress.has_resolved_audio
        )::bigint as resolved_titles,
        count(*) filter (
          where progress.has_subtitles
        )::bigint as subtitle_titles
      from driver_sources driver
      join source_title_progress progress
        on progress.source_id = driver.source_id
      group by
        driver.user_id,
        driver.owner_email,
        driver.source_id,
        driver.panel,
        driver.source_enabled,
        driver.source_sync_status,
        driver.provider_identity_id,
        driver.provider_key,
        driver.provider_account_key,
        driver.movie_cache_server,
        progress.item_type
    ),
    movie_file_universe as materialized (
      select
        variant.source_id,
        'movie'::text as item_type,
        variant.movie_cache_server as server_host,
        variant.external_id
      from owned_variants variant
      where variant.item_type = 'movie'
        and coalesce(btrim(variant.external_id), '') <> ''
    ),
    series_file_universe as materialized (
      select distinct
        membership.source_id,
        'series'::text as item_type,
        membership.provider_identity_id::text as server_host,
        membership.episode_id as external_id
      from public.catalog_series_episode_memberships membership
      join source_types source_type
        on source_type.source_id = membership.source_id
       and source_type.user_id = membership.user_id
       and source_type.item_type = 'series'
    ),
    file_universe as materialized (
      select
        movie.source_id,
        movie.item_type,
        movie.server_host,
        movie.external_id,
        'movie'::text as cache_item_type
      from movie_file_universe movie

      union all

      select
        series.source_id,
        series.item_type,
        series.server_host,
        series.external_id,
        'episode'::text as cache_item_type
      from series_file_universe series
    ),
    file_progress as materialized (
      select
        file.source_id,
        file.item_type,
        count(*)::bigint as known_files,
        count(*) filter (
          where cache.audio_probed_at is not null
        )::bigint as probed_files,
        count(*) filter (
          where cache.audio_probed_at is null
        )::bigint as never_probed_files,
        count(*) filter (
          where cache.audio_probed_at >= v_now - interval '24 hours'
        )::bigint as probed_files_24h,
        count(*) filter (
          where cache.audio_lang_verified_at is not null
        )::bigint as verified_files,
        count(*) filter (
          where cache.audio_lang_verified_at >= v_now - interval '24 hours'
        )::bigint as verified_files_24h,
        max(cache.audio_probed_at) as last_probe_at,
        max(cache.audio_lang_verified_at) as last_verified_at
      from file_universe file
      left join public.catalog_file_tracks cache
        on cache.server_host = file.server_host
       and cache.item_type = file.cache_item_type
       and cache.external_id = file.external_id
      group by file.source_id, file.item_type
    ),
    provider_backoff as materialized (
      select
        backoff.source_id,
        backoff.consecutive_failures,
        backoff.failure_class,
        backoff.last_code,
        backoff.next_retry_at
      from public.catalog_provider_inventory_backoff backoff
      join driver_sources driver
        on driver.source_id = backoff.source_id
       and driver.provider_identity_id = backoff.provider_identity_id
    ),
    circuit_signal as materialized (
      select
        driver.source_id,
        max(circuit.open_until) as open_until
      from driver_sources driver
      join public.provider_probe_circuit circuit
        on circuit.identity_key = driver.provider_identity_id::text
        or circuit.identity_key = driver.provider_key
      group by driver.source_id
    ),
    provider_activity_signal as materialized (
      select
        driver.source_id,
        activity.last_seen_at + interval '5 minutes' as busy_until
      from driver_sources driver
      join public.provider_account_activity activity
        on activity.account_key = driver.provider_account_key
      where activity.last_seen_at > v_now - interval '5 minutes'
    ),
    raw_rows as materialized (
      select
        source_type.owner_email,
        source_type.user_id,
        source_type.source_id,
        source_type.provider_identity_id,
        source_type.panel,
        source_type.item_type,
        source_type.catalog_titles,
        coalesce(progress.known_files, 0::bigint) as known_files,
        coalesce(progress.probed_files, 0::bigint) as probed_files,
        coalesce(progress.never_probed_files, 0::bigint) as never_probed_files,
        coalesce(progress.probed_files_24h, 0::bigint) as probed_files_24h,
        coalesce(progress.verified_files, 0::bigint) as verified_files,
        coalesce(progress.verified_files_24h, 0::bigint) as verified_files_24h,
        source_type.resolved_titles,
        case
          when source_type.catalog_titles = 0 then 0::numeric
          else round(
            source_type.resolved_titles::numeric
            * 100.0
            / source_type.catalog_titles::numeric,
            1
          )
        end as resolved_pct,
        source_type.subtitle_titles,
        progress.last_probe_at,
        progress.last_verified_at,
        case
          when source_type.item_type = 'series' then 'exact_episode'
          else 'exact_file'
        end as progress_scope,
        source_type.source_enabled,
        source_type.source_sync_status,
        schedule.source_id is not null as schedule_present,
        schedule.next_run_at,
        schedule.lease_until,
        schedule.last_claimed_at,
        schedule.last_finished_at,
        coalesce(schedule.consecutive_failures, 0) as consecutive_failures,
        coalesce(schedule.dispatch_count, 0) as dispatch_count,
        schedule.last_result->>'mode' as last_result_mode,
        schedule.last_result->>'itemType' as last_result_item_type,
        case
          when coalesce(schedule.last_result->>'processed', '') ~ '^[0-9]+$'
            then (schedule.last_result->>'processed')::bigint
          else 0::bigint
        end as last_result_processed,
        case
          when coalesce(schedule.last_result->>'failed', '') ~ '^[0-9]+$'
            then (schedule.last_result->>'failed')::bigint
          else 0::bigint
        end as last_result_failed,
        left(coalesce(
          nullif(schedule.last_result->>'error', ''),
          nullif(provider.last_code, '')
        ), 500) as last_error,
        replace(
          lower(coalesce(
            nullif(schedule.last_result->>'skipped', ''),
            nullif(schedule.last_result->>'stoppedAt', ''),
            ''
          )),
          '-',
          '_'
        ) as last_skip,
        coalesce(
          (schedule.last_result->>'paused')::boolean,
          false
        ) as last_result_paused,
        coalesce(
          (schedule.last_result->>'exhausted')::boolean,
          false
        ) as last_result_exhausted,
        circuit.open_until as circuit_open_until,
        activity.busy_until as provider_busy_until,
        provider.failure_class as provider_failure_class,
        provider.next_retry_at as provider_next_retry_at,
        coalesce(provider.consecutive_failures, 0) as provider_failures
      from source_types source_type
      left join file_progress progress
        on progress.source_id = source_type.source_id
       and progress.item_type = source_type.item_type
      left join public.catalog_enrichment_source_schedule schedule
        on schedule.source_id = source_type.source_id
       and schedule.user_id = source_type.user_id
      left join provider_backoff provider
        on provider.source_id = source_type.source_id
      left join circuit_signal circuit
        on circuit.source_id = source_type.source_id
      left join provider_activity_signal activity
        on activity.source_id = source_type.source_id
    ),
    row_signals as materialized (
      select
        raw.*,
        (
          raw.last_result_item_type is null
          or raw.last_result_item_type = raw.item_type
          or (
            raw.item_type = 'series'
            and raw.last_result_item_type = 'episode'
          )
        ) as last_result_matches_type,
        coalesce(
          greatest(
            case
              when raw.circuit_open_until > v_now
                then raw.circuit_open_until
            end,
            case
              when raw.provider_busy_until > v_now
                then raw.provider_busy_until
            end,
            case
              when raw.provider_next_retry_at > v_now
                then raw.provider_next_retry_at
            end
          ),
          case
            when raw.next_run_at > v_now then raw.next_run_at
          end
        ) as retry_candidate_at,
        case
          when raw.provider_next_retry_at > v_now
           and raw.provider_failure_class = 'authentication'
            then 'authentication'
          when raw.provider_next_retry_at > v_now
           and raw.provider_failure_class = 'forbidden'
            then 'forbidden'
          when raw.circuit_open_until > v_now then 'circuit_open'
          when raw.provider_next_retry_at > v_now
           and raw.provider_failure_class = 'rate_limited'
            then 'rate_limited'
          when raw.provider_busy_until > v_now
            then 'provider_account_busy'
          when raw.provider_next_retry_at > v_now
           and raw.provider_failure_class = 'viewer_priority'
            then 'provider_account_busy'
          when raw.provider_next_retry_at > v_now
           and raw.provider_failure_class = 'background_busy'
            then 'provider_background_busy'
          else null
        end as durable_block_reason
      from raw_rows raw
    ),
    classified as materialized (
      select
        signal.*,
        case
          when signal.source_enabled is not true then 'disabled'
          when signal.source_sync_status is distinct from 'ready' then 'disabled'
          when signal.provider_identity_id is null
           and not signal.schedule_present then 'not_scheduled'
          when signal.provider_identity_id is null then 'blocked'
          when not signal.schedule_present then 'not_scheduled'
          when signal.known_files > 0
           and signal.never_probed_files = 0 then 'complete'
          when v_enrichment_paused then 'paused'
          when signal.item_type = 'series'
           and not v_episode_audio_scan_enabled then 'paused'
          when signal.lease_until > v_now then 'running'
          when signal.durable_block_reason in (
            'authentication', 'forbidden', 'worker_error'
          ) then 'blocked'
          when signal.durable_block_reason is not null then 'retry_wait'
          when signal.last_result_paused
           and signal.last_skip = 'enrichment_paused' then 'paused'
          when signal.item_type = 'series'
           and signal.last_skip = 'episode_audio_scan_disabled' then 'paused'
          when signal.last_skip = 'provider_identity_pending' then 'blocked'
          when signal.last_skip in (
            'provider_auth', 'provider_metadata_failed',
            'provider_guard_unavailable'
          ) then 'blocked'
          when signal.last_skip in (
            'provider_rate_limit', 'provider_backpressure'
          ) then 'retry_wait'
          when signal.last_skip in (
            'live_session', 'live_session_race', 'viewer_midtick'
          ) then 'retry_wait'
          when signal.last_skip in (
            'pregen_active', 'pregen_active_race'
          ) then 'retry_wait'
          when signal.last_skip in (
            'provider_account_busy', 'account_busy', 'identity_busy',
            'provider_inventory_backoff'
          ) then 'retry_wait'
          when signal.last_skip in (
            'provider_background_busy', 'background_busy'
          ) then 'retry_wait'
          when signal.last_skip in (
            'footprint_budget', 'low_footprint_provider'
          ) then 'retry_wait'
          when signal.last_skip in (
            'rate_limited', 'too_many_requests'
          ) then 'retry_wait'
          when signal.last_skip in (
            'circuit_open', 'provider_lease_busy'
          ) then 'retry_wait'
          when signal.consecutive_failures > 0
           and signal.next_run_at > v_now then 'retry_wait'
          when signal.consecutive_failures > 0 then 'blocked'
          when signal.known_files = 0 then 'idle'
          when signal.probed_files_24h > 0 then 'active'
          when signal.never_probed_files > 0
           and signal.next_run_at < v_now - interval '5 minutes'
           and coalesce(signal.lease_until, '-infinity'::timestamptz) <= v_now
            then 'stalled'
          when signal.last_result_matches_type
           and (
             signal.last_skip = 'exhausted'
             or signal.last_result_exhausted
           ) then 'idle'
          else 'idle'
        end as state,
        case
          when signal.source_enabled is not true then 'source_disabled'
          when signal.source_sync_status is distinct from 'ready'
            then 'source_not_ready'
          when signal.provider_identity_id is null then 'source_not_ready'
          when not signal.schedule_present then 'schedule_missing'
          when signal.known_files > 0
           and signal.never_probed_files = 0 then 'complete'
          when v_enrichment_paused then 'enrichment_paused'
          when signal.item_type = 'series'
           and not v_episode_audio_scan_enabled
            then 'episode_audio_scan_disabled'
          when signal.lease_until > v_now then 'lease_active'
          when signal.durable_block_reason is not null
            then signal.durable_block_reason
          when signal.last_result_paused
           and signal.last_skip = 'enrichment_paused'
            then 'enrichment_paused'
          when signal.item_type = 'series'
           and signal.last_skip = 'episode_audio_scan_disabled'
            then 'episode_audio_scan_disabled'
          when signal.last_skip = 'provider_identity_pending'
            then 'source_not_ready'
          when signal.last_skip = 'provider_auth'
            then 'authentication'
          when signal.last_skip in (
            'provider_rate_limit', 'provider_backpressure'
          ) then 'rate_limited'
          when signal.last_skip in (
            'provider_metadata_failed', 'provider_guard_unavailable'
          ) then 'worker_error'
          when signal.last_skip in (
            'live_session', 'live_session_race', 'viewer_midtick'
          ) then 'live_session'
          when signal.last_skip in (
            'pregen_active', 'pregen_active_race'
          ) then 'pregen_active'
          when signal.last_skip in (
            'provider_account_busy', 'account_busy', 'identity_busy',
            'provider_inventory_backoff'
          ) then case
            when signal.provider_failure_class = 'background_busy'
              then 'provider_background_busy'
            when signal.provider_failure_class = 'rate_limited'
              then 'rate_limited'
            when signal.provider_failure_class = 'authentication'
              then 'authentication'
            when signal.provider_failure_class = 'forbidden'
              then 'forbidden'
            else 'provider_account_busy'
          end
          when signal.last_skip in (
            'provider_background_busy', 'background_busy'
          ) then 'provider_background_busy'
          when signal.last_skip in (
            'footprint_budget', 'low_footprint_provider'
          ) then 'footprint_budget'
          when signal.last_skip in (
            'rate_limited', 'too_many_requests'
          ) then 'rate_limited'
          when signal.last_skip in (
            'circuit_open', 'provider_lease_busy'
          ) then 'circuit_open'
          when signal.consecutive_failures > 0
           and signal.next_run_at > v_now then 'retry_scheduled'
          when signal.consecutive_failures > 0 then 'worker_error'
          when signal.known_files = 0 then 'no_known_files'
          when signal.probed_files_24h > 0 then 'progressing'
          when signal.never_probed_files > 0
           and signal.next_run_at < v_now - interval '5 minutes'
           and coalesce(signal.lease_until, '-infinity'::timestamptz) <= v_now
            then 'queue_overdue'
          when signal.last_result_matches_type
           and (
             signal.last_skip = 'exhausted'
             or signal.last_result_exhausted
           ) then 'exhausted'
          else 'no_recent_probe'
        end as reason
      from row_signals signal
    ),
    scheduler_job as materialized (
      select
        job.jobid,
        job.jobname,
        job.schedule,
        job.active
      from cron.job job
      where job.jobname = 'norva-dynamic-enrichment-fleet'
      order by job.jobid desc
      limit 1
    ),
    scheduler_status as materialized (
      select
        job.jobname,
        job.schedule,
        job.active,
        latest.start_time as last_run_at,
        latest.status as last_status,
        count(history.jobid) filter (
          where history.start_time >= v_now - interval '24 hours'
        )::integer as runs_24h,
        count(history.jobid) filter (
          where history.start_time >= v_now - interval '24 hours'
            and history.status = 'failed'
        )::integer as failures_24h
      from scheduler_job job
      left join lateral (
        select run.start_time, run.status
        from cron.job_run_details run
        where run.jobid = job.jobid
        order by run.start_time desc
        limit 1
      ) latest on true
      left join cron.job_run_details history
        on history.jobid = job.jobid
       and history.start_time >= v_now - interval '24 hours'
      group by
        job.jobname,
        job.schedule,
        job.active,
        latest.start_time,
        latest.status
    )
    select jsonb_build_object(
      'schema_version', 1,
      'generated_at', v_now,
      'window_hours', 24,
      'flags', jsonb_build_object(
        'enrichment_paused', v_enrichment_paused,
        'episode_audio_scan_enabled', v_episode_audio_scan_enabled
      ),
      'scheduler', coalesce((
        select jsonb_build_object(
          'jobname', scheduler.jobname,
          'present', true,
          'active', scheduler.active,
          'schedule', scheduler.schedule,
          'last_run_at', scheduler.last_run_at,
          'last_status', scheduler.last_status,
          'runs_24h', scheduler.runs_24h,
          'failures_24h', scheduler.failures_24h
        )
        from scheduler_status scheduler
      ), jsonb_build_object(
        'jobname', 'norva-dynamic-enrichment-fleet',
        'present', false,
        'active', false,
        'schedule', null,
        'last_run_at', null,
        'last_status', null,
        'runs_24h', 0,
        'failures_24h', 0
      )),
      'summary', (
        select jsonb_build_object(
          'rows', count(*)::integer,
          'panels', count(distinct coalesce(
            row.provider_identity_id::text,
            'source:' || row.source_id::text
          ))::integer,
          'sources', count(distinct row.source_id)::integer,
          'active', count(*) filter (
            where row.state = 'active'
          )::integer,
          'running', count(*) filter (
            where row.state = 'running'
          )::integer,
          'idle', count(*) filter (
            where row.state = 'idle'
          )::integer,
          'complete', count(*) filter (
            where row.state = 'complete'
          )::integer,
          'paused', count(*) filter (
            where row.state = 'paused'
          )::integer,
          'blocked', count(*) filter (
            where row.state = 'blocked'
          )::integer,
          'retry_wait', count(*) filter (
            where row.state = 'retry_wait'
          )::integer,
          'stalled', count(*) filter (
            where row.state = 'stalled'
          )::integer,
          'disabled', count(*) filter (
            where row.state = 'disabled'
          )::integer,
          'not_scheduled', count(*) filter (
            where row.state = 'not_scheduled'
          )::integer,
          'probed_files_24h', coalesce(sum(row.probed_files_24h), 0::numeric)
        )
        from classified row
      ),
      'rows', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'owner_email', row.owner_email,
            'user_id', row.user_id,
            'source_id', row.source_id,
            'provider_identity_id', row.provider_identity_id,
            'panel', row.panel,
            'item_type', row.item_type,
            'catalog_titles', row.catalog_titles,
            'known_files', row.known_files,
            'probed_files', row.probed_files,
            'never_probed_files', row.never_probed_files,
            'probed_files_24h', row.probed_files_24h,
            'verified_files', row.verified_files,
            'verified_files_24h', row.verified_files_24h,
            'resolved_titles', row.resolved_titles,
            'resolved_pct', row.resolved_pct,
            'subtitle_titles', row.subtitle_titles,
            'last_probe_at', row.last_probe_at,
            'last_verified_at', row.last_verified_at,
            'progress_scope', row.progress_scope,
            'source_enabled', row.source_enabled,
            'source_sync_status', row.source_sync_status,
            'state', row.state,
            'reason', row.reason,
            'next_retry_at', case
              when row.state in ('blocked', 'retry_wait')
                then row.retry_candidate_at
              else null
            end,
            'next_run_at', row.next_run_at,
            'lease_until', row.lease_until,
            'last_claimed_at', row.last_claimed_at,
            'last_finished_at', row.last_finished_at,
            'consecutive_failures', row.consecutive_failures,
            'dispatch_count', row.dispatch_count,
            'last_result_mode', row.last_result_mode,
            'last_result_item_type', row.last_result_item_type,
            'last_result_processed', row.last_result_processed,
            'last_result_failed', row.last_result_failed,
            'last_error', row.last_error
          )
          order by
            row.owner_email,
            row.panel,
            row.item_type,
            row.source_id
        )
        from classified row
      ), '[]'::jsonb)
    )
  );
end
$function$;

revoke all on function public.admin_enrichment_engine_health()
  from public, anon, authenticated;
grant execute on function public.admin_enrichment_engine_health()
  to authenticated;

comment on function public.admin_enrichment_engine_health() is
  'Admin-only exact-file enrichment progress and durable scheduler/provider health. Returns no provider secrets or editable source configuration.';

commit;
