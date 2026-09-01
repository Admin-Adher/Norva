-- Automatic exact-file `und` audio certification.
--
-- A catalogue probe may discover an exact stream inventory, but a one-window
-- Whisper result is only provisional.  Movies and registered episodes now use
-- the existing resumable 4/6-window journal; only its strict finalizer may
-- publish language values into canonical tracks and catalogue facets.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.catalog_file_audio_validation_jobs
  drop constraint if exists catalog_file_audio_validation_jobs_item_type_check;
alter table public.catalog_file_audio_validation_jobs
  add constraint catalog_file_audio_validation_jobs_item_type_check
  check (item_type in ('movie', 'episode'));

create or replace function public.start_automatic_catalog_file_audio_validation_job(
  p_requested_by uuid,
  p_source_id uuid,
  p_variant_id uuid,
  p_identity_key text,
  p_item_type text,
  p_external_id text,
  p_expected_audio_indices integer[],
  p_profile jsonb,
  p_profile_fingerprint text,
  p_profile_probed_at timestamptz,
  p_file_size_bytes bigint,
  p_cached_audio_tracks jsonb,
  p_provider_drain_attested boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_profile_snapshot jsonb;
  v_canonical_profile jsonb;
  v_job public.catalog_file_audio_validation_jobs%rowtype;
  v_active public.catalog_file_audio_validation_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_active_count integer := 0;
  v_starts_24h integer := 0;
  v_quota_retry_at timestamptz;
begin
  if p_requested_by is null
     or p_source_id is null
     or p_variant_id is null
     or coalesce(btrim(p_identity_key), '') = ''
     or p_item_type not in ('movie', 'episode')
     or coalesce(btrim(p_external_id), '') = ''
     or coalesce(p_profile_fingerprint, '') !~ '^[a-f0-9]{64}$'
     or p_file_size_bytes not between 1 and 9007199254740991
     or cardinality(p_expected_audio_indices) not between 1 and 32
     or jsonb_typeof(p_cached_audio_tracks) is distinct from 'array'
     or jsonb_typeof(p_profile) is distinct from 'object' then
    raise exception 'Invalid automatic language validation input' using errcode = '22023';
  end if;
  if public.catalog_audio_track_indexes(p_cached_audio_tracks)
       is distinct from p_expected_audio_indices
     or jsonb_array_length(p_cached_audio_tracks) <> cardinality(p_expected_audio_indices) then
    raise exception 'Cached audio inventory mismatch' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(p_cached_audio_tracks) track(value)
    where coalesce(
      nullif(lower(btrim(coalesce(track.value->>'lang', track.value->>'language'))), ''),
      'und'
    ) in ('und', 'un', 'mis', 'mul', 'zxx', 'nar', 'unknown')
  ) then
    raise exception 'Automatic language validation requires an untagged audio track'
      using errcode = '22023';
  end if;
  if p_item_type = 'episode' and p_provider_drain_attested is not true then
    raise exception 'Episode language validation requires provider drain attestation'
      using errcode = 'PT409';
  end if;

  v_profile_snapshot := public.vod_language_profile_snapshot(p_profile);
  if public.vod_language_profile_audio_indices(v_profile_snapshot)
       is distinct from p_expected_audio_indices
     or public.vod_language_profile_file_size_bytes(v_profile_snapshot)
       is distinct from p_file_size_bytes
     or (v_profile_snapshot->>'probedAt')::timestamptz
       is distinct from p_profile_probed_at
     or v_profile_snapshot->>'probeSource' not in ('gatewayinband', 'gatewayprobe')
     or (
       v_profile_snapshot->>'probeSource' = 'gatewayinband'
       and coalesce((v_profile_snapshot->>'metadataComplete')::boolean, false) is not true
     )
     or v_profile_snapshot->>'container' not in (
       'mkv', 'matroska', 'matroskawebm', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg', 'ts'
     )
     or coalesce((v_profile_snapshot->>'durationSeconds')::numeric, 0) < 80
     or coalesce((v_profile_snapshot->>'durationSeconds')::numeric, 0) > 86400 then
    raise exception 'Exact automatic language validation profile is invalid'
      using errcode = '22023';
  end if;

  -- The submitted profile is server-observed, but its catalogue coordinates
  -- are independently re-bound here.  A service-role bug cannot cross tenant,
  -- source, variant or provider-identity boundaries.
  if p_item_type = 'movie' then
    select variant.codec_profile into v_canonical_profile
    from public.cloud_title_variants variant
    join public.cloud_sources source
      on source.id = variant.source_id
     and source.user_id = variant.user_id
     and source.deleted_at is null
     and source.enabled = true
     and source.sync_status = 'ready'
    join public.cloud_source_catalog_heads head
      on head.source_id = variant.source_id
     and head.user_id = variant.user_id
     and head.active_generation_id = variant.generation_id
    join public.catalog_source_provider_identities identity
      on identity.source_id = source.id
     and identity.user_id = source.user_id
     and identity.identity_id::text = btrim(p_identity_key)
    where variant.id = p_variant_id
      and variant.user_id = p_requested_by
      and variant.source_id = p_source_id
      and variant.item_type = 'movie'
      and variant.external_id = btrim(p_external_id);
    if not found
       or public.vod_language_profile_snapshot(v_canonical_profile)
         is distinct from v_profile_snapshot then
      raise exception 'Exact movie language validation profile changed'
        using errcode = 'PT409';
    end if;
  else
    perform 1
    from public.catalog_series_episode_memberships membership
    join public.cloud_sources source
      on source.id = membership.source_id
     and source.user_id = membership.user_id
     and source.deleted_at is null
     and source.enabled = true
     and source.sync_status = 'ready'
    join public.cloud_source_catalog_heads head
      on head.source_id = membership.source_id
     and head.user_id = membership.user_id
     and head.active_generation_id = membership.generation_id
    join public.cloud_title_variants parent_variant
      on parent_variant.id = membership.parent_variant_id
     and parent_variant.user_id = membership.user_id
     and parent_variant.source_id = membership.source_id
     and parent_variant.generation_id = head.active_generation_id
     and parent_variant.item_type = 'series'
     and parent_variant.external_id = membership.parent_series_id
    join public.catalog_source_provider_identities identity
      on identity.source_id = membership.source_id
     and identity.user_id = membership.user_id
     and identity.identity_id = membership.provider_identity_id
    where membership.user_id = p_requested_by
      and membership.source_id = p_source_id
      and membership.parent_variant_id = p_variant_id
      and membership.parent_item_type = 'series'
      and membership.provider_identity_id::text = btrim(p_identity_key)
      and membership.episode_id = btrim(p_external_id);
    if not found then
      raise exception 'Exact episode membership is not available'
        using errcode = '42501';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation-user:' || p_requested_by::text,
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation:' || btrim(p_identity_key) || ':' ||
      p_item_type || ':' ||
      btrim(p_external_id),
    0
  ));

  with expired as (
    update public.catalog_file_audio_validation_jobs job
       set state = 'expired',
           error_code = 'LANGUAGE_VALIDATION_QUEUE_EXPIRED',
           queue_expires_at = null,
           retry_at = v_now,
           purge_after = v_now + interval '7 days',
           updated_at = v_now
     where job.identity_key = btrim(p_identity_key)
       and job.item_type = p_item_type
       and job.external_id = btrim(p_external_id)
       and job.state = 'queued'
       and job.lease_owner is null
       and job.queue_expires_at <= v_now
     returning job.id, job.identity_key, job.item_type, job.external_id
  )
  update public.catalog_file_tracks cache
     set audio_lang_verified_at = null,
         audio_lang_retry_at = v_now,
         audio_lang_verification = jsonb_build_object(
           'protocol', 2,
           'status', 'failed',
           'method', 'whisper-strict-consensus-v4',
           'reason', 'language_validation_queue_expired',
           'retryAt', v_now
         ),
         updated_at = v_now
    from expired
   where cache.server_host = expired.identity_key
     and cache.item_type = expired.item_type
     and cache.external_id = expired.external_id
     and cache.audio_lang_verification->>'jobId' = expired.id::text;

  select job.* into v_active
  from public.catalog_file_audio_validation_jobs job
  where job.identity_key = btrim(p_identity_key)
    and job.item_type = p_item_type
    and job.external_id = btrim(p_external_id)
    and job.state in ('queued', 'running', 'retry_wait', 'finalizing')
  for update;
  if found then
    if v_active.requested_by is distinct from p_requested_by
       or v_active.source_id is distinct from p_source_id then
      return jsonb_build_object('busy', true);
    end if;
    if v_active.variant_id = p_variant_id
       and v_active.profile_fingerprint = p_profile_fingerprint
       and v_active.profile_snapshot = v_profile_snapshot
       and v_active.expected_audio_indices = p_expected_audio_indices
       and v_active.file_size_bytes = p_file_size_bytes then
      return jsonb_build_object(
        'jobId', v_active.id,
        'state', v_active.state,
        'retryAt', v_active.retry_at,
        'queueExpiresAt', v_active.queue_expires_at,
        'leaseExpiresAt', v_active.lease_expires_at
      );
    end if;
    update public.catalog_file_audio_validation_jobs
       set state = 'failed',
           error_code = 'PROFILE_CHANGED',
           lease_owner = null,
           lease_expires_at = null,
           queue_expires_at = null,
           retry_at = v_now,
           purge_after = v_now + interval '7 days',
           updated_at = v_now
     where id = v_active.id;
  end if;

  -- Automatic certification shares the same bounded tenant budget as an
  -- explicit strict-validation request. The per-user advisory lock above
  -- makes both the active and rolling-24h counts exact under concurrency.
  select count(*)::integer,
         min(coalesce(job.queue_expires_at, job.lease_expires_at, job.retry_at))
    into v_active_count, v_quota_retry_at
  from public.catalog_file_audio_validation_jobs job
  where job.requested_by = p_requested_by
    and job.state in ('queued', 'running', 'retry_wait', 'finalizing');
  if v_active_count >= 2 then
    v_quota_retry_at := coalesce(v_quota_retry_at, v_now + interval '30 seconds');
    return jsonb_build_object(
      'limited', true,
      'code', 'LANGUAGE_VALIDATION_CONCURRENCY_LIMIT',
      'retryAt', v_quota_retry_at,
      'retryAfterSeconds', greatest(
        1,
        least(900, ceil(extract(epoch from (v_quota_retry_at - v_now)))::integer)
      )
    );
  end if;

  select count(*)::integer, min(job.created_at) + interval '24 hours'
    into v_starts_24h, v_quota_retry_at
  from public.catalog_file_audio_validation_jobs job
  where job.requested_by = p_requested_by
    and job.created_at > v_now - interval '24 hours';
  if v_starts_24h >= 20 then
    return jsonb_build_object(
      'limited', true,
      'code', 'LANGUAGE_VALIDATION_RATE_LIMITED',
      'retryAt', v_quota_retry_at,
      'retryAfterSeconds', greatest(
        1,
        least(86400, ceil(extract(epoch from (v_quota_retry_at - v_now)))::integer)
      )
    );
  end if;

  insert into public.catalog_file_audio_validation_jobs (
    requested_by, source_id, variant_id, identity_key, item_type, external_id,
    expected_audio_indices, profile_fingerprint, profile_snapshot, profile_probed_at,
    file_size_bytes, cached_audio_tracks, state, retry_at, queue_expires_at
  ) values (
    p_requested_by, p_source_id, p_variant_id, btrim(p_identity_key), p_item_type,
    btrim(p_external_id), p_expected_audio_indices, p_profile_fingerprint,
    v_profile_snapshot, p_profile_probed_at, p_file_size_bytes, p_cached_audio_tracks,
    'retry_wait', v_now, null
  ) returning * into v_job;

  update public.catalog_file_tracks cache
     set audio_lang_verified_at = null,
         audio_lang_retry_at = null,
         audio_lang_verification = jsonb_build_object(
           'protocol', 2,
           'status', 'validating',
           'method', 'whisper-strict-consensus-v4',
           'automatic', true,
           'providerDrainAttested', case
             when p_item_type = 'episode' then p_provider_drain_attested
             else null
           end,
           'jobId', v_job.id,
           'startedAt', v_now
         ),
         audio_whisper_retry_at = v_now + interval '1 day',
         audio_whisper_verification = jsonb_build_object(
           'status', 'queued',
           'method', 'whisper-strict-consensus-v4',
           'automatic', true,
           'jobId', v_job.id,
           'queuedAt', v_now
         ),
         updated_at = v_now
   where cache.server_host = btrim(p_identity_key)
     and cache.item_type = p_item_type
     and cache.external_id = btrim(p_external_id)
     and cache.audio_lang_verified_at is null
     and public.catalog_audio_track_indexes(cache.audio_tracks) = p_expected_audio_indices
     and jsonb_array_length(cache.audio_tracks) = cardinality(p_expected_audio_indices);
  if not found then
    raise exception 'Canonical audio inventory changed' using errcode = 'PT409';
  end if;

  return jsonb_build_object(
    'jobId', v_job.id,
    'state', v_job.state,
    'retryAt', v_job.retry_at
  );
end
$function$;

revoke all on function public.start_automatic_catalog_file_audio_validation_job(
  uuid, uuid, uuid, text, text, text, integer[], jsonb, text, timestamptz, bigint, jsonb, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.start_automatic_catalog_file_audio_validation_job(
  uuid, uuid, uuid, text, text, text, integer[], jsonb, text, timestamptz, bigint, jsonb, boolean
) to service_role;

-- The original strict worker was movie-only. Its retry and quarantine
-- transitions must write the cache row selected by the durable job type or an
-- episode failure would either contaminate a same-id movie or remain stuck.
create or replace function public.fail_catalog_file_audio_validation_job(
  p_job_id uuid,
  p_lease_owner text,
  p_error_code text,
  p_terminal boolean default false,
  p_retry_at timestamptz default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.catalog_file_audio_validation_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_code text := upper(regexp_replace(
    coalesce(p_error_code, 'VALIDATION_FAILED'), '[^A-Z0-9_]+', '_', 'g'
  ));
  v_retry_at timestamptz := coalesce(p_retry_at, v_now + interval '1 day');
  v_provenance jsonb;
begin
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id;
  if not found or v_job.item_type not in ('movie', 'episode') then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation:' || v_job.identity_key || ':' ||
      v_job.item_type || ':' || v_job.external_id,
    0
  ));
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id
  for update;
  if not found
     or v_job.item_type not in ('movie', 'episode')
     or v_job.state not in ('running', 'finalizing')
     or v_job.lease_owner is distinct from btrim(p_lease_owner) then
    return false;
  end if;
  v_code := left(v_code, 64);
  v_provenance := jsonb_build_object(
    'protocol', 2,
    'status', 'pending',
    'method', 'whisper-strict-consensus-v4',
    'reason', lower(v_code),
    'completedTracks', v_job.next_track_position,
    'trackCount', cardinality(v_job.expected_audio_indices),
    'attemptedAt', v_now,
    'retryAt', v_retry_at
  );
  if not public.record_catalog_file_audio_verification(
    v_job.identity_key, v_job.item_type, v_job.external_id, false,
    v_now, v_retry_at, v_provenance
  ) then
    raise exception 'Unable to persist language validation retry cursor'
      using errcode = 'PT409';
  end if;
  update public.catalog_file_audio_validation_jobs
     set state = case when coalesce(p_terminal, false) then 'failed' else 'retry_wait' end,
         error_code = v_code,
         retry_at = v_retry_at,
         lease_owner = null,
         lease_expires_at = null,
         queue_expires_at = null,
         purge_after = case
           when coalesce(p_terminal, false) then v_now + interval '7 days'
           else purge_after
         end,
         updated_at = v_now
   where id = v_job.id;
  return true;
end
$function$;

revoke all on function public.fail_catalog_file_audio_validation_job(
  uuid, text, text, boolean, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.fail_catalog_file_audio_validation_job(
  uuid, text, text, boolean, timestamptz
) to service_role;

create or replace function public.norva_quarantine_audio_validation_provider_no_progress(
  p_job_id uuid,
  p_error_code text default 'LANGUAGE_VALIDATION_NO_PROGRESS_QUARANTINED'
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.catalog_file_audio_validation_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_retry_at timestamptz := v_now + interval '24 hours';
  v_code text := left(upper(regexp_replace(
    coalesce(p_error_code, 'LANGUAGE_VALIDATION_NO_PROGRESS_QUARANTINED'),
    '[^A-Z0-9_]+', '_', 'g'
  )), 64);
begin
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id;
  if not found or v_job.item_type not in ('movie', 'episode') then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation:' || v_job.identity_key || ':' ||
      v_job.item_type || ':' || v_job.external_id,
    0
  ));
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id
  for update;
  if not found
     or v_job.item_type not in ('movie', 'episode')
     or v_job.state in ('verified', 'failed', 'expired', 'cancelled') then
    return false;
  end if;
  if not public.record_catalog_file_audio_verification(
    v_job.identity_key,
    v_job.item_type,
    v_job.external_id,
    false,
    v_now,
    v_retry_at,
    jsonb_build_object(
      'protocol', 3,
      'status', 'failed',
      'method', 'whisper-strict-consensus-v4',
      'reason', lower(v_code),
      'completedTracks', v_job.next_track_position,
      'trackCount', cardinality(v_job.expected_audio_indices),
      'providerAttempts', v_job.provider_attempt_count,
      'consecutiveProviderNoProgress', v_job.consecutive_provider_no_progress_count,
      'quarantinedAt', v_now,
      'retryAt', v_retry_at
    )
  ) then
    raise exception 'Unable to persist language validation quarantine'
      using errcode = 'PT409';
  end if;
  -- Terminalizing the job must not manufacture provider-drain evidence. A
  -- timed-out Gateway request may still own its upstream socket even though the
  -- Edge attempt made no progress. Keep both transport leases until the
  -- attested release path deletes them, or until their TTL expires; otherwise a
  -- fourth failure could immediately admit a second connection to a
  -- mono-session provider account.
  update public.catalog_file_audio_validation_jobs
     set state = 'failed',
         error_code = v_code,
         retry_at = v_retry_at,
         lease_owner = null,
         lease_expires_at = null,
         queue_expires_at = null,
         provider_attempt_token = null,
         provider_attempt_started_at = null,
         quarantined_at = v_now,
         purge_after = v_now + interval '30 days',
         updated_at = v_now
   where id = v_job.id;
  return true;
end
$function$;

revoke all on function public.norva_quarantine_audio_validation_provider_no_progress(
  uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.norva_quarantine_audio_validation_provider_no_progress(
  uuid, text
) to service_role;

create or replace function public.finalize_catalog_file_audio_validation_job(
  p_job_id uuid,
  p_lease_owner text,
  p_profile_fingerprint text,
  p_profile_probed_at timestamptz,
  p_file_size_bytes bigint,
  p_expected_audio_indices integer[]
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.catalog_file_audio_validation_jobs%rowtype;
  v_profile jsonb;
  v_cache public.catalog_file_tracks%rowtype;
  v_validated_tracks jsonb;
  v_verified_at timestamptz := clock_timestamp();
  v_provenance jsonb;
  v_episode_id text;
  v_active_generation_id uuid;
  v_parent_series_id text;
begin
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation:' || v_job.identity_key || ':' ||
      v_job.item_type || ':' ||
      v_job.external_id,
    0
  ));
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id
  for update;
  if not found
     or v_job.item_type not in ('movie', 'episode')
     or v_job.state <> 'finalizing'
     or v_job.lease_owner is distinct from btrim(p_lease_owner)
     or v_job.lease_expires_at <= v_verified_at
     or v_job.next_track_position <> cardinality(v_job.expected_audio_indices)
     or jsonb_array_length(v_job.evidence) <> cardinality(v_job.expected_audio_indices)
     or v_job.profile_fingerprint is distinct from p_profile_fingerprint
     or v_job.profile_probed_at is distinct from p_profile_probed_at
     or v_job.file_size_bytes is distinct from p_file_size_bytes
     or v_job.expected_audio_indices is distinct from p_expected_audio_indices then
    return null;
  end if;

  select cache.* into v_cache
  from public.catalog_file_tracks cache
  where cache.server_host = v_job.identity_key
    and cache.item_type = v_job.item_type
    and cache.external_id = v_job.external_id
  for update;
  if not found
     or public.catalog_audio_track_indexes(v_cache.audio_tracks)
       is distinct from v_job.expected_audio_indices
     or jsonb_array_length(v_cache.audio_tracks) <> cardinality(v_job.expected_audio_indices) then
    raise exception 'Canonical audio inventory changed' using errcode = 'PT409';
  end if;

  -- Publication barrier.  Lock the complete tenant/source/catalog binding in a
  -- stable order before revalidating the item.  Holding the active head in
  -- SHARE mode until commit prevents a concurrent catalogue switch from
  -- making the exact-language result stale between validation and publication.
  perform 1
  from public.cloud_sources source
  where source.id = v_job.source_id
    and source.user_id = v_job.requested_by
    and source.deleted_at is null
    and source.enabled = true
    and source.sync_status = 'ready'
  for share;
  if not found then
    raise exception 'Exact language validation source changed'
      using errcode = 'PT409';
  end if;

  select head.active_generation_id into v_active_generation_id
  from public.cloud_source_catalog_heads head
  where head.source_id = v_job.source_id
    and head.user_id = v_job.requested_by
  for share;
  if not found then
    raise exception 'Exact language validation catalogue head changed'
      using errcode = 'PT409';
  end if;

  perform 1
  from public.catalog_source_provider_identities identity
  where identity.source_id = v_job.source_id
    and identity.user_id = v_job.requested_by
    and identity.identity_id::text = v_job.identity_key
  for share;
  if not found then
    raise exception 'Exact language validation provider identity changed'
      using errcode = 'PT409';
  end if;

  if v_job.item_type = 'movie' then
    select variant.codec_profile into v_profile
    from public.cloud_title_variants variant
    where variant.id = v_job.variant_id
      and variant.user_id = v_job.requested_by
      and variant.source_id = v_job.source_id
      and variant.generation_id = v_active_generation_id
      and variant.item_type = 'movie'
      and variant.external_id = v_job.external_id
    for update;
    if not found
       or public.vod_language_profile_audio_indices(v_profile)
         is distinct from v_job.expected_audio_indices
       or public.vod_language_profile_file_size_bytes(v_profile)
         is distinct from v_job.file_size_bytes
       or public.vod_language_profile_snapshot(v_profile)
         is distinct from v_job.profile_snapshot
       or coalesce(v_profile->>'probedAt', v_profile->>'probed_at')::timestamptz
         is distinct from v_job.profile_probed_at then
      raise exception 'Exact movie language validation profile changed'
        using errcode = 'PT409';
    end if;
  else
    select parent_variant.external_id into v_parent_series_id
    from public.cloud_title_variants parent_variant
    where parent_variant.id = v_job.variant_id
      and parent_variant.user_id = v_job.requested_by
      and parent_variant.source_id = v_job.source_id
      and parent_variant.generation_id = v_active_generation_id
      and parent_variant.item_type = 'series'
    for share;
    if not found then
      raise exception 'Exact episode parent variant changed'
        using errcode = 'PT409';
    end if;

    select membership.episode_id into v_episode_id
    from public.catalog_series_episode_memberships membership
    where membership.user_id = v_job.requested_by
      and membership.source_id = v_job.source_id
      and membership.generation_id = v_active_generation_id
      and membership.parent_variant_id = v_job.variant_id
      and membership.parent_item_type = 'series'
      and membership.parent_series_id = v_parent_series_id
      and membership.provider_identity_id::text = v_job.identity_key
      and membership.episode_id = v_job.external_id
    for update;
    if not found or v_episode_id is distinct from v_job.external_id then
      raise exception 'Exact episode membership changed' using errcode = 'PT409';
    end if;
  end if;

  select jsonb_agg(
    jsonb_set(track.value, '{lang}', to_jsonb(proof.value->>'language'), true)
    order by track.ordinality
  ) into v_validated_tracks
  from jsonb_array_elements(v_cache.audio_tracks) with ordinality track(value, ordinality)
  join jsonb_array_elements(v_job.evidence) proof(value)
    on (proof.value->>'index')::integer = (track.value->>'index')::integer;
  if jsonb_array_length(coalesce(v_validated_tracks, '[]'::jsonb))
       <> cardinality(v_job.expected_audio_indices) then
    raise exception 'Incomplete strict language evidence' using errcode = '22023';
  end if;

  v_provenance := jsonb_build_object(
    'protocol', 2,
    'status', 'verified',
    'method', 'whisper-strict-consensus-v4',
    'acceptance', 'strict-gateway-consensus-v4',
    'automatic', true,
    'sampleDurationSeconds', 20,
    'allTracksVerified', true,
    'trackCount', cardinality(v_job.expected_audio_indices),
    'profileFingerprint', v_job.profile_fingerprint,
    'profileProbedAt', v_job.profile_probed_at,
    'fileSizeBytes', v_job.file_size_bytes,
    'minConsensus', (
      select min((entry.value->>'consensus')::integer)
      from jsonb_array_elements(v_job.evidence) entry(value)
    ),
    'minSampleProbability', (
      select min((entry.value->>'minSampleProbability')::numeric)
      from jsonb_array_elements(v_job.evidence) entry(value)
    ),
    'minSampleWordCount', (
      select min((entry.value->>'minSampleWordCount')::integer)
      from jsonb_array_elements(v_job.evidence) entry(value)
    ),
    'minSampleUniqueWordCount', (
      select min((entry.value->>'minSampleUniqueWordCount')::integer)
      from jsonb_array_elements(v_job.evidence) entry(value)
    ),
    'tracks', v_job.evidence,
    'verifiedAt', v_verified_at
  );

  perform public.upsert_catalog_file_validated_tracks(
    v_job.identity_key, v_job.item_type, v_job.external_id,
    v_validated_tracks, '[]'::jsonb, true, false
  );
  if not public.record_catalog_file_audio_verification(
    v_job.identity_key, v_job.item_type, v_job.external_id, true,
    v_verified_at, null, v_provenance
  ) then
    raise exception 'Unable to finalize strict language validation' using errcode = 'PT409';
  end if;
  update public.catalog_file_audio_validation_jobs
     set state = 'verified',
         verified_at = v_verified_at,
         retry_at = null,
         error_code = null,
         lease_owner = null,
         lease_expires_at = null,
         queue_expires_at = null,
         purge_after = v_verified_at + interval '7 days',
         cached_audio_tracks = v_validated_tracks,
         updated_at = v_verified_at
   where id = v_job.id;
  return jsonb_build_object('verifiedAt', v_verified_at, 'audioTracks', v_job.evidence);
end
$function$;

revoke all on function public.finalize_catalog_file_audio_validation_job(
  uuid, text, text, timestamptz, bigint, integer[]
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_catalog_file_audio_validation_job(
  uuid, text, text, timestamptz, bigint, integer[]
) to service_role;

-- Rolling-deploy fence: an old Edge isolate may still call the cascade RPC.
-- Preserve its bounded aggregate evidence in the immutable attempt table, but
-- downgrade `detected` to `pending` and never forward its provisional language
-- to either exact tracks or title/episode facets.
create or replace function public.persist_catalog_audio_lid_outcome(
  p_attempt_id uuid,
  p_server_host text,
  p_item_type text,
  p_external_id text,
  p_stream_index integer,
  p_expected_audio_probed_at timestamptz,
  p_policy_version text,
  p_rollout_mode text,
  p_cohort_bucket integer,
  p_route text,
  p_status text,
  p_language text default null,
  p_confidence double precision default null,
  p_sample_sha256 text default null,
  p_sample_bytes integer default null,
  p_extraction_ms integer default null,
  p_inference_ms integer default null,
  p_evidence jsonb default '{}'::jsonb,
  p_retry_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_status text := case when p_status = 'detected' then 'pending' else p_status end;
  v_route text := case
    when p_status = 'detected' then 'pending-disagreement'
    else p_route
  end;
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb)
    || jsonb_strip_nulls(jsonb_build_object(
      'provisionalStatus', p_status,
      'provisionalRoute', case when p_status = 'detected' then p_route else null end,
      'provisionalLanguage', case when p_status = 'detected' then p_language else null end,
      'provisionalConfidence', case when p_status = 'detected' then p_confidence else null end,
      'publicationBlockedBy', 'strict-multi-window-required'
    ));
begin
  -- Validate the original detected verdict before downgrading it. Otherwise an
  -- invalid old-isolate route/language/confidence could bypass the established
  -- cascade validators merely because the forwarded attempt is now pending.
  if p_status = 'detected' and (
    p_route is null
    or p_route not in ('fast-consensus', 'whisper-tiebreak', 'full-transcript-fallback')
    or p_language is null
    or p_language !~ '^[a-z]{2}$'
    or p_confidence is null
    or p_confidence < 0
    or p_confidence > 1
  ) then
    raise exception 'Detected provisional verdict is invalid'
      using errcode = '22023';
  end if;

  if p_item_type = 'movie' then
    return public.persist_catalog_movie_audio_lid_outcome(
      p_attempt_id, p_server_host, p_item_type, p_external_id, p_stream_index,
      p_expected_audio_probed_at, p_policy_version, p_rollout_mode,
      p_cohort_bucket, v_route, v_status, null, null, p_sample_sha256,
      p_sample_bytes, p_extraction_ms, p_inference_ms, v_evidence,
      coalesce(p_retry_at, clock_timestamp() + interval '15 minutes')
    );
  elsif p_item_type = 'episode' then
    return public.persist_catalog_episode_audio_lid_outcome(
      p_attempt_id, p_server_host, p_item_type, p_external_id, p_stream_index,
      p_expected_audio_probed_at, p_policy_version, p_rollout_mode,
      p_cohort_bucket, v_route, v_status, null, null, p_sample_sha256,
      p_sample_bytes, p_extraction_ms, p_inference_ms, v_evidence,
      coalesce(p_retry_at, clock_timestamp() + interval '15 minutes')
    );
  end if;
  raise exception 'Invalid LID cascade item type' using errcode = '22023';
end
$function$;

revoke all on function public.persist_catalog_audio_lid_outcome(
  uuid, text, text, text, integer, timestamptz, text, text, integer,
  text, text, text, double precision, text, integer, integer, integer,
  jsonb, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.persist_catalog_audio_lid_outcome(
  uuid, text, text, text, integer, timestamptz, text, text, integer,
  text, text, text, double precision, text, integer, integer, integer,
  jsonb, timestamptz
) to service_role;

comment on function public.start_automatic_catalog_file_audio_validation_job(
  uuid, uuid, uuid, text, text, text, integer[], jsonb, text, timestamptz, bigint, jsonb, boolean
) is
  'Tenant-bound automatic movie/episode enqueue for strict 4/6-window audio language certification.';

notify pgrst, 'reload schema';

commit;
