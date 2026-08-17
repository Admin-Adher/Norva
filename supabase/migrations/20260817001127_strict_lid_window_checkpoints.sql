-- Durable, per-window strict LID checkpoints for Edge v52 / Gateway v103.
-- Opaque receipts are service-role-only and are never projected into public responses.

create or replace function public.strict_lid_window_tokens_are_valid(p_tokens jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select coalesce(
    jsonb_typeof(p_tokens) = 'array'
    and jsonb_array_length(p_tokens) between 0 and 6
    and not exists (
      select 1
      from jsonb_array_elements(p_tokens) token(value)
      where jsonb_typeof(token.value) <> 'string'
         or length(token.value #>> '{}') > 98304
         or (token.value #>> '{}') !~ '^v1\.[a-f0-9]{16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
    )
    and jsonb_array_length(p_tokens) = (
      select count(distinct token.value #>> '{}')
      from jsonb_array_elements(p_tokens) token(value)
    ),
    false
  )
$function$;

alter table public.catalog_file_audio_validation_jobs
  add column strict_lid_window_position integer not null default 0,
  add column strict_lid_window_count integer not null default 0,
  add column strict_lid_window_tokens jsonb not null default '[]'::jsonb,
  add column strict_lid_window_protocol integer not null default 0;

alter table public.catalog_file_audio_validation_jobs
  drop constraint if exists catalog_file_audio_validation_jobs_attempt_count_check;

alter table public.catalog_file_audio_validation_jobs
  add constraint catalog_file_audio_validation_jobs_attempt_count_check
    check (attempt_count between 0 and 256),
  add constraint catalog_file_audio_validation_jobs_strict_lid_window_position_check
    check (strict_lid_window_position between 0 and 6),
  add constraint catalog_file_audio_validation_jobs_strict_lid_window_count_check
    check (strict_lid_window_count in (0, 4, 6)),
  add constraint catalog_file_audio_validation_jobs_strict_lid_window_protocol_check
    check (strict_lid_window_protocol in (0, 1)),
  add constraint catalog_file_audio_validation_jobs_strict_lid_window_tokens_check
    check (
      public.strict_lid_window_tokens_are_valid(strict_lid_window_tokens)
      and jsonb_array_length(strict_lid_window_tokens) = strict_lid_window_position
    ),
  add constraint catalog_file_audio_validation_jobs_strict_lid_window_state_check
    check (
      (
        strict_lid_window_count = 0
        and strict_lid_window_position = 0
        and strict_lid_window_protocol = 0
        and strict_lid_window_tokens = '[]'::jsonb
      )
      or (
        strict_lid_window_count in (4, 6)
        and strict_lid_window_protocol = 1
        and strict_lid_window_position <= strict_lid_window_count
      )
    );

comment on column public.catalog_file_audio_validation_jobs.strict_lid_window_position is
  'Service-only count of immutable strict-LID window receipts persisted for the current track.';
comment on column public.catalog_file_audio_validation_jobs.strict_lid_window_count is
  'Service-only exact deterministic window count (4 short-form, 6 long-form) for the current track.';
comment on column public.catalog_file_audio_validation_jobs.strict_lid_window_tokens is
  'Service-only ordered opaque AEAD receipts; never return through caller-facing APIs or logs.';
comment on column public.catalog_file_audio_validation_jobs.strict_lid_window_protocol is
  'Service-only durable strict-LID window checkpoint protocol; 1 when a current-track cursor exists.';

alter table public.catalog_file_audio_validation_jobs enable row level security;
alter table public.catalog_file_audio_validation_jobs force row level security;
revoke all on table public.catalog_file_audio_validation_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.catalog_file_audio_validation_jobs to service_role;

-- Reinstall the start RPC so terminal v51 jobs remain historical rows while a
-- fresh v52 job is created under the existing per-user locks and quotas.
create or replace function public.start_catalog_file_audio_validation_job(
  p_requested_by uuid,
  p_source_id uuid,
  p_variant_id uuid,
  p_identity_key text,
  p_external_id text,
  p_expected_audio_indices integer[],
  p_profile_fingerprint text,
  p_profile_probed_at timestamptz,
  p_file_size_bytes bigint,
  p_cached_audio_tracks jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_profile jsonb;
  v_profile_snapshot jsonb;
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
     or coalesce(btrim(p_external_id), '') = ''
     or coalesce(p_profile_fingerprint, '') !~ '^[a-f0-9]{64}$'
     or p_file_size_bytes not between 1 and 9007199254740991
     or cardinality(p_expected_audio_indices) not between 1 and 32
     or jsonb_typeof(p_cached_audio_tracks) is distinct from 'array' then
    raise exception 'Invalid language validation job input' using errcode = '22023';
  end if;
  if public.catalog_audio_track_indexes(p_cached_audio_tracks)
       is distinct from p_expected_audio_indices
     or jsonb_array_length(p_cached_audio_tracks) <> cardinality(p_expected_audio_indices) then
    raise exception 'Cached audio inventory mismatch' using errcode = '22023';
  end if;

  -- All inserts for one requester serialize here. This makes both quotas exact
  -- under concurrent POSTs rather than a best-effort count followed by a race.
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation-user:' || p_requested_by::text,
    0
  ));

  update public.catalog_file_audio_validation_jobs job
     set state = 'queued',
         lease_owner = null,
         lease_expires_at = null,
         queue_expires_at = v_now + interval '15 minutes',
         retry_at = null,
         error_code = null,
         updated_at = v_now
   where job.requested_by = p_requested_by
     and (
       (job.state in ('running', 'finalizing') and job.lease_expires_at <= v_now)
       or (job.state = 'retry_wait' and (job.retry_at is null or job.retry_at <= v_now))
     );

  -- A queued track has no worker lease. If no poll resumes it within 15 minutes,
  -- fail it atomically so it cannot hold either the per-file unique slot or the
  -- per-user active quota forever. Cache evidence remains aggregate-only.
  with expired as (
    update public.catalog_file_audio_validation_jobs job
       set state = 'expired',
           error_code = 'LANGUAGE_VALIDATION_QUEUE_EXPIRED',
           queue_expires_at = null,
           retry_at = v_now,
           purge_after = v_now + interval '7 days',
           updated_at = v_now
     where job.requested_by = p_requested_by
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

  -- Terminal evidence is retained for seven days, then removed in a bounded
  -- batch so a single start can never turn into an unbounded maintenance scan.
  with due as (
    select job.id
    from public.catalog_file_audio_validation_jobs job
    where job.requested_by = p_requested_by
      and job.state in ('verified', 'failed', 'expired', 'cancelled')
      and job.purge_after <= v_now
    order by job.purge_after, job.id
    limit 100
    for update skip locked
  )
  delete from public.catalog_file_audio_validation_jobs job
  using due
  where job.id = due.id;

  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation:' || btrim(p_identity_key) || ':movie:' || btrim(p_external_id),
    0
  ));

  -- The same exact file can be shared across owners. Expire its abandoned
  -- queue after taking the canonical file lock even when another owner created it.
  with expired as (
    update public.catalog_file_audio_validation_jobs job
       set state = 'expired',
           error_code = 'LANGUAGE_VALIDATION_QUEUE_EXPIRED',
           queue_expires_at = null,
           retry_at = v_now,
           purge_after = v_now + interval '7 days',
           updated_at = v_now
     where job.identity_key = btrim(p_identity_key)
       and job.item_type = 'movie'
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

  select variant.codec_profile
    into v_profile
  from public.cloud_title_variants variant
  join public.cloud_sources source
    on source.id = variant.source_id
   and source.user_id = variant.user_id
   and source.deleted_at is null
   and source.enabled = true
  join public.catalog_source_provider_identities identity
    on identity.source_id = source.id
   and identity.user_id = source.user_id
   and identity.identity_id::text = btrim(p_identity_key)
  where variant.id = p_variant_id
    and variant.user_id = p_requested_by
    and variant.source_id = p_source_id
    and variant.item_type = 'movie'
    and variant.external_id = p_external_id;
  if not found
     or not public.vod_language_profile_is_exact(v_profile)
     or public.vod_language_profile_audio_indices(v_profile) is distinct from p_expected_audio_indices
     or public.vod_language_profile_file_size_bytes(v_profile) is distinct from p_file_size_bytes
     or coalesce(v_profile->>'probedAt', v_profile->>'probed_at')::timestamptz
        is distinct from p_profile_probed_at then
    raise exception 'Exact language validation profile changed' using errcode = '40001';
  end if;
  v_profile_snapshot := public.vod_language_profile_snapshot(v_profile);

  select job.* into v_active
  from public.catalog_file_audio_validation_jobs job
  where job.identity_key = btrim(p_identity_key)
    and job.item_type = 'movie'
    and job.external_id = btrim(p_external_id)
    and job.state in ('queued', 'running', 'retry_wait', 'finalizing')
  for update;

  if found then
    if v_active.state in ('running', 'finalizing')
       and v_active.lease_expires_at <= v_now then
      update public.catalog_file_audio_validation_jobs
         set state = 'queued',
             lease_owner = null,
             lease_expires_at = null,
             queue_expires_at = v_now + interval '15 minutes',
             updated_at = v_now
       where id = v_active.id
       returning * into v_active;
    elsif v_active.state = 'retry_wait'
      and (v_active.retry_at is null or v_active.retry_at <= v_now) then
      update public.catalog_file_audio_validation_jobs
         set state = 'queued',
             retry_at = null,
             error_code = null,
             lease_owner = null,
             lease_expires_at = null,
             queue_expires_at = v_now + interval '15 minutes',
             updated_at = v_now
       where id = v_active.id
       returning * into v_active;
    end if;

    if v_active.requested_by is distinct from p_requested_by
       or v_active.source_id is distinct from p_source_id then
      return jsonb_build_object('busy', true);
    end if;
    if v_active.profile_fingerprint is distinct from p_profile_fingerprint
       or v_active.variant_id is distinct from p_variant_id
       or v_active.expected_audio_indices is distinct from p_expected_audio_indices
       or v_active.profile_snapshot is distinct from v_profile_snapshot
       or v_active.file_size_bytes is distinct from p_file_size_bytes then
      update public.catalog_file_audio_validation_jobs
         set state = 'failed',
             error_code = 'PROFILE_CHANGED',
             lease_owner = null,
             lease_expires_at = null,
             queue_expires_at = null,
             retry_at = null,
             purge_after = v_now + interval '7 days',
             updated_at = v_now
       where id = v_active.id;
      update public.catalog_file_tracks cache
         set audio_lang_verified_at = null,
             audio_lang_retry_at = v_now,
             audio_lang_verification = jsonb_build_object(
               'protocol', 2,
               'status', 'failed',
               'method', 'whisper-strict-consensus-v4',
               'reason', 'profile_changed',
               'retryAt', v_now
             ),
             updated_at = v_now
       where cache.server_host = v_active.identity_key
         and cache.item_type = v_active.item_type
         and cache.external_id = v_active.external_id
         and cache.audio_lang_verification->>'jobId' = v_active.id::text;
    else
      return jsonb_build_object(
        'jobId', v_active.id,
        'state', v_active.state,
        'retryAt', v_active.retry_at,
        'queueExpiresAt', v_active.queue_expires_at,
        'leaseExpiresAt', v_active.lease_expires_at
      );
    end if;
  end if;

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
    file_size_bytes, cached_audio_tracks
  ) values (
    p_requested_by, p_source_id, p_variant_id, btrim(p_identity_key), 'movie', btrim(p_external_id),
    p_expected_audio_indices, p_profile_fingerprint, v_profile_snapshot, p_profile_probed_at,
    p_file_size_bytes, p_cached_audio_tracks
  ) returning * into v_job;

  update public.catalog_file_tracks cache
     set audio_lang_verified_at = null,
         audio_lang_retry_at = null,
         audio_lang_verification = jsonb_build_object(
           'protocol', 2,
           'status', 'validating',
           'method', 'whisper-strict-consensus-v4',
           'jobId', v_job.id,
           'startedAt', v_now
         ),
         updated_at = v_now
   where cache.server_host = btrim(p_identity_key)
     and cache.item_type = 'movie'
     and cache.external_id = btrim(p_external_id)
     and public.catalog_audio_track_indexes(cache.audio_tracks) = p_expected_audio_indices
     and jsonb_array_length(cache.audio_tracks) = cardinality(p_expected_audio_indices);
  if not found then
    raise exception 'Canonical audio inventory changed' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'jobId', v_job.id,
    'state', v_job.state,
    'queueExpiresAt', v_job.queue_expires_at,
    'leaseExpiresAt', v_job.lease_expires_at
  );
end
$function$;

create or replace function public.claim_catalog_file_audio_validation_job(
  p_job_id uuid,
  p_lease_owner text,
  p_ttl_seconds integer default 300
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.catalog_file_audio_validation_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_ttl integer := greatest(60, least(coalesce(p_ttl_seconds, 300), 900));
  v_track_index integer;
  v_window_count integer := 0;
  v_is_renewal boolean := false;
begin
  if p_job_id is null or coalesce(btrim(p_lease_owner), '') = '' then return null; end if;
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id;
  if not found then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation:' || v_job.identity_key || ':movie:' || v_job.external_id,
    0
  ));
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id
  for update;
  if not found or v_job.state in ('verified', 'failed', 'expired', 'cancelled') then return null; end if;

  if v_job.state = 'queued'
     and v_job.lease_owner is null
     and v_job.queue_expires_at <= v_now then
    update public.catalog_file_audio_validation_jobs
       set state = 'expired',
           error_code = 'LANGUAGE_VALIDATION_QUEUE_EXPIRED',
           queue_expires_at = null,
           retry_at = v_now,
           strict_lid_window_position = 0,
           strict_lid_window_count = 0,
           strict_lid_window_tokens = '[]'::jsonb,
           strict_lid_window_protocol = 0,
           purge_after = v_now + interval '7 days',
           updated_at = v_now
     where id = v_job.id;
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
     where cache.server_host = v_job.identity_key
       and cache.item_type = v_job.item_type
       and cache.external_id = v_job.external_id
       and cache.audio_lang_verification->>'jobId' = v_job.id::text;
    return null;
  end if;
  if v_job.state = 'retry_wait' and v_job.retry_at > v_now then return null; end if;
  if v_job.state in ('running', 'finalizing')
     and v_job.lease_expires_at > v_now
     and v_job.lease_owner is distinct from btrim(p_lease_owner) then
    return null;
  end if;

  v_is_renewal := v_job.state in ('running', 'finalizing')
    and v_job.lease_expires_at > v_now
    and v_job.lease_owner = btrim(p_lease_owner);
  if not v_is_renewal and v_job.attempt_count >= 256 then
    update public.catalog_file_audio_validation_jobs
       set state = 'cancelled',
           error_code = 'LANGUAGE_VALIDATION_ATTEMPT_LIMIT',
           lease_owner = null,
           lease_expires_at = null,
           queue_expires_at = null,
           retry_at = v_now,
           strict_lid_window_position = 0,
           strict_lid_window_count = 0,
           strict_lid_window_tokens = '[]'::jsonb,
           strict_lid_window_protocol = 0,
           cancelled_at = v_now,
           purge_after = v_now + interval '7 days',
           updated_at = v_now
     where id = v_job.id;
    update public.catalog_file_tracks cache
       set audio_lang_verified_at = null,
           audio_lang_retry_at = v_now,
           audio_lang_verification = jsonb_build_object(
             'protocol', 2,
             'status', 'failed',
             'method', 'whisper-strict-consensus-v4',
             'reason', 'language_validation_attempt_limit',
             'retryAt', v_now
           ),
           updated_at = v_now
     where cache.server_host = v_job.identity_key
       and cache.item_type = v_job.item_type
       and cache.external_id = v_job.external_id
       and cache.audio_lang_verification->>'jobId' = v_job.id::text;
    return null;
  end if;
  if v_job.next_track_position > cardinality(v_job.expected_audio_indices) then
    raise exception 'Invalid language validation cursor' using errcode = '22023';
  end if;

  v_track_index := case
    when v_job.next_track_position < cardinality(v_job.expected_audio_indices)
      then v_job.expected_audio_indices[v_job.next_track_position + 1]
    else null
  end;
  if v_track_index is not null then
    v_window_count := case
      when coalesce((v_job.profile_snapshot->>'durationSeconds')::numeric, 0) >= 120 then 6
      when coalesce((v_job.profile_snapshot->>'durationSeconds')::numeric, 0) >= 80 then 4
      else 0
    end;
    if v_job.strict_lid_window_count not in (0, v_window_count)
       or v_job.strict_lid_window_position > v_window_count
       or (v_job.strict_lid_window_count = 0 and v_job.strict_lid_window_position <> 0) then
      raise exception 'Invalid strict LID window cursor' using errcode = '22023';
    end if;
  end if;

  update public.catalog_file_audio_validation_jobs
     set state = case when v_track_index is null then 'finalizing' else 'running' end,
         retry_at = null,
         error_code = null,
         queue_expires_at = null,
         lease_owner = btrim(p_lease_owner),
         lease_expires_at = v_now + make_interval(secs => v_ttl),
         attempt_count = attempt_count + case when v_is_renewal then 0 else 1 end,
         strict_lid_window_count = case when v_track_index is null then 0 else v_window_count end,
         strict_lid_window_protocol = case when v_window_count in (4, 6) then 1 else 0 end,
         updated_at = v_now
   where id = v_job.id
   returning * into v_job;

  return jsonb_build_object(
    'jobId', v_job.id,
    'requestedBy', v_job.requested_by,
    'sourceId', v_job.source_id,
    'variantId', v_job.variant_id,
    'identityKey', v_job.identity_key,
    'itemType', v_job.item_type,
    'itemId', v_job.external_id,
    'expectedAudioIndices', to_jsonb(v_job.expected_audio_indices),
    'profileFingerprint', v_job.profile_fingerprint,
    'profileProbedAt', v_job.profile_probed_at,
    'fileSizeBytes', v_job.file_size_bytes,
    'cachedAudioTracks', v_job.cached_audio_tracks,
    'nextTrackPosition', v_job.next_track_position,
    'trackIndex', v_track_index,
    'windowPosition', v_job.strict_lid_window_position,
    'windowCount', v_job.strict_lid_window_count,
    'windowTokens', v_job.strict_lid_window_tokens,
    'windowProtocol', v_job.strict_lid_window_protocol
  );
end
$function$;

create or replace function public.checkpoint_catalog_file_audio_validation_window(
  p_job_id uuid,
  p_lease_owner text,
  p_stream_index integer,
  p_window_ordinal integer,
  p_window_count integer,
  p_window_protocol integer,
  p_window_token text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.catalog_file_audio_validation_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_expected_index integer;
  v_complete boolean;
begin
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation:' || v_job.identity_key || ':movie:' || v_job.external_id,
    0
  ));
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id
  for update;
  if not found
     or v_job.state <> 'running'
     or v_job.lease_owner is distinct from btrim(p_lease_owner)
     or v_job.lease_expires_at <= v_now then
    return null;
  end if;
  v_expected_index := v_job.expected_audio_indices[v_job.next_track_position + 1];
  if p_stream_index is distinct from v_expected_index
     or p_window_protocol <> 1
     or p_window_count not in (4, 6)
     or p_window_count is distinct from v_job.strict_lid_window_count
     or p_window_protocol is distinct from v_job.strict_lid_window_protocol
     or p_window_ordinal is distinct from v_job.strict_lid_window_position + 1
     or p_window_ordinal > p_window_count
     or p_window_token is null
     or length(p_window_token) > 98304
     or p_window_token !~ '^v1\.[a-f0-9]{16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
     or v_job.strict_lid_window_tokens ? p_window_token then
    raise exception 'Invalid strict LID window checkpoint' using errcode = '22023';
  end if;

  v_complete := p_window_ordinal = p_window_count;
  update public.catalog_file_audio_validation_jobs
     set strict_lid_window_position = p_window_ordinal,
         strict_lid_window_tokens = strict_lid_window_tokens || jsonb_build_array(p_window_token),
         state = case when v_complete then 'running' else 'queued' end,
         queue_expires_at = case when v_complete then null else v_now + interval '15 minutes' end,
         lease_owner = case when v_complete then lease_owner else null end,
         lease_expires_at = case when v_complete then lease_expires_at else null end,
         updated_at = v_now
   where id = v_job.id;
  return jsonb_build_object(
    'complete', v_complete,
    'windowPosition', p_window_ordinal,
    'windowCount', p_window_count
  );
end
$function$;

create or replace function public.reset_catalog_file_audio_validation_windows(
  p_job_id uuid,
  p_lease_owner text,
  p_stream_index integer,
  p_window_position integer,
  p_window_count integer,
  p_window_protocol integer
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.catalog_file_audio_validation_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id;
  if not found then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation:' || v_job.identity_key || ':movie:' || v_job.external_id,
    0
  ));
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id
  for update;
  if not found
     or v_job.state <> 'running'
     or v_job.lease_owner is distinct from btrim(p_lease_owner)
     or v_job.lease_expires_at <= v_now
     or p_stream_index is distinct from v_job.expected_audio_indices[v_job.next_track_position + 1]
     or p_window_position is distinct from v_job.strict_lid_window_position
     or p_window_count is distinct from v_job.strict_lid_window_count
     or p_window_protocol is distinct from v_job.strict_lid_window_protocol
     or p_window_position is distinct from p_window_count
     or p_window_count not in (4, 6)
     or p_window_protocol <> 1 then
    return false;
  end if;
  update public.catalog_file_audio_validation_jobs
     set strict_lid_window_position = 0,
         strict_lid_window_count = 0,
         strict_lid_window_tokens = '[]'::jsonb,
         strict_lid_window_protocol = 0,
         updated_at = v_now
   where id = v_job.id;
  return true;
end
$function$;

create or replace function public.checkpoint_catalog_file_audio_validation_track(
  p_job_id uuid,
  p_lease_owner text,
  p_stream_index integer,
  p_evidence jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.catalog_file_audio_validation_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_expected_index integer;
  v_language text;
  v_safe_evidence jsonb;
  v_complete boolean;
begin
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation:' || v_job.identity_key || ':movie:' || v_job.external_id,
    0
  ));
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id
  for update;
  if not found
     or v_job.state <> 'running'
     or v_job.lease_owner is distinct from btrim(p_lease_owner)
     or v_job.lease_expires_at <= v_now then
    return null;
  end if;
  v_expected_index := v_job.expected_audio_indices[v_job.next_track_position + 1];
  v_language := lower(coalesce(p_evidence->>'language', ''));
  if p_stream_index is distinct from v_expected_index
     or v_job.strict_lid_window_protocol <> 1
     or v_job.strict_lid_window_count not in (4, 6)
     or v_job.strict_lid_window_position <> v_job.strict_lid_window_count
     or jsonb_array_length(v_job.strict_lid_window_tokens) <> v_job.strict_lid_window_count
     or jsonb_typeof(p_evidence) is distinct from 'object'
     or p_evidence->>'method' is distinct from 'whisper-strict-consensus-v4'
     or coalesce((p_evidence->>'index')::integer, -1) is distinct from p_stream_index
     or v_language !~ '^[a-z]{2,3}$'
     or coalesce((p_evidence->>'sampleCount')::integer, 0) < 4
     or coalesce((p_evidence->>'consensus')::integer, 0) < 4
     or coalesce((p_evidence->>'rejectedSpeechSampleCount')::integer, -1) <> 0
     or coalesce((p_evidence->>'minSampleProbability')::numeric, 0) < 0.95
     or coalesce((p_evidence->>'minSampleWordCount')::integer, 0) < 12
     or coalesce((p_evidence->>'minSampleUniqueWordCount')::integer, 0) < 8 then
    raise exception 'Invalid strict language evidence' using errcode = '22023';
  end if;

  v_safe_evidence := jsonb_build_object(
    'index', p_stream_index,
    'language', v_language,
    'method', 'whisper-strict-consensus-v4',
    'consensus', (p_evidence->>'consensus')::integer,
    'sampleCount', (p_evidence->>'sampleCount')::integer,
    'rejectedSpeechSampleCount', 0,
    'minSampleProbability', (p_evidence->>'minSampleProbability')::numeric,
    'minSampleWordCount', (p_evidence->>'minSampleWordCount')::integer,
    'minSampleUniqueWordCount', (p_evidence->>'minSampleUniqueWordCount')::integer
  );
  v_complete := v_job.next_track_position + 1 = cardinality(v_job.expected_audio_indices);
  update public.catalog_file_audio_validation_jobs
     set next_track_position = next_track_position + 1,
         evidence = evidence || jsonb_build_array(v_safe_evidence),
         strict_lid_window_position = 0,
         strict_lid_window_count = 0,
         strict_lid_window_tokens = '[]'::jsonb,
         strict_lid_window_protocol = 0,
         state = case when v_complete then 'finalizing' else 'queued' end,
         queue_expires_at = case when v_complete then null else v_now + interval '15 minutes' end,
         lease_owner = case when v_complete then lease_owner else null end,
         lease_expires_at = case when v_complete then lease_expires_at else null end,
         updated_at = v_now
   where id = v_job.id;
  return jsonb_build_object(
    'complete', v_complete,
    'nextTrackPosition', v_job.next_track_position + 1
  );
end
$function$;

-- Keep the v51 RPC name fail-closed during a rolling migration. Old workers can
-- only advance after the new complete-window invariant is present in the row.
create or replace function public.checkpoint_catalog_file_audio_validation_job(
  p_job_id uuid,
  p_lease_owner text,
  p_stream_index integer,
  p_evidence jsonb
) returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select public.checkpoint_catalog_file_audio_validation_track(
    p_job_id,
    p_lease_owner,
    p_stream_index,
    p_evidence
  )
$function$;

revoke all on function public.strict_lid_window_tokens_are_valid(jsonb)
  from public, anon, authenticated;
revoke all on function public.start_catalog_file_audio_validation_job(
  uuid, uuid, uuid, text, text, integer[], text, timestamptz, bigint, jsonb
) from public, anon, authenticated;
revoke all on function public.claim_catalog_file_audio_validation_job(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.checkpoint_catalog_file_audio_validation_window(
  uuid, text, integer, integer, integer, integer, text
) from public, anon, authenticated;
revoke all on function public.reset_catalog_file_audio_validation_windows(
  uuid, text, integer, integer, integer, integer
) from public, anon, authenticated;
revoke all on function public.checkpoint_catalog_file_audio_validation_track(uuid, text, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.checkpoint_catalog_file_audio_validation_job(uuid, text, integer, jsonb)
  from public, anon, authenticated;

grant execute on function public.strict_lid_window_tokens_are_valid(jsonb) to service_role;
grant execute on function public.start_catalog_file_audio_validation_job(
  uuid, uuid, uuid, text, text, integer[], text, timestamptz, bigint, jsonb
) to service_role;
grant execute on function public.claim_catalog_file_audio_validation_job(uuid, text, integer) to service_role;
grant execute on function public.checkpoint_catalog_file_audio_validation_window(
  uuid, text, integer, integer, integer, integer, text
) to service_role;
grant execute on function public.reset_catalog_file_audio_validation_windows(
  uuid, text, integer, integer, integer, integer
) to service_role;
grant execute on function public.checkpoint_catalog_file_audio_validation_track(uuid, text, integer, jsonb)
  to service_role;
grant execute on function public.checkpoint_catalog_file_audio_validation_job(uuid, text, integer, jsonb)
  to service_role;

notify pgrst, 'reload schema';
