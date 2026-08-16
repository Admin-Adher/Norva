-- Durable, resumable strict language validation for exact MKV files.
--
-- The Edge function performs at most one audio track per waitUntil task. This
-- service-role-only journal is the crash/retry cursor; it intentionally stores
-- aggregate LID evidence only (never provider URLs, capabilities or transcripts).

create table public.catalog_file_audio_validation_jobs (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.cloud_sources(id) on delete cascade,
  variant_id uuid not null references public.cloud_title_variants(id) on delete cascade,
  identity_key text not null,
  item_type text not null default 'movie' check (item_type = 'movie'),
  external_id text not null,
  expected_audio_indices integer[] not null,
  profile_fingerprint text not null,
  profile_snapshot jsonb not null,
  profile_probed_at timestamptz not null,
  file_size_bytes bigint not null,
  cached_audio_tracks jsonb not null,
  state text not null default 'queued'
    check (state in (
      'queued', 'running', 'retry_wait', 'finalizing',
      'verified', 'failed', 'expired', 'cancelled'
    )),
  next_track_position integer not null default 0 check (next_track_position >= 0),
  evidence jsonb not null default '[]'::jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  queue_expires_at timestamptz default (clock_timestamp() + interval '15 minutes'),
  retry_at timestamptz,
  error_code text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 64),
  verified_at timestamptz,
  cancelled_at timestamptz,
  purge_after timestamptz not null default (clock_timestamp() + interval '7 days'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (cardinality(expected_audio_indices) between 1 and 32),
  check (profile_fingerprint ~ '^[a-f0-9]{64}$'),
  check (jsonb_typeof(profile_snapshot) = 'object'),
  check (file_size_bytes between 1 and 9007199254740991),
  check (jsonb_typeof(cached_audio_tracks) = 'array'),
  check (jsonb_typeof(evidence) = 'array'),
  check (next_track_position <= cardinality(expected_audio_indices)),
  check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  ),
  check ((state in ('running', 'finalizing')) = (lease_owner is not null)),
  check ((state = 'queued') = (queue_expires_at is not null)),
  check ((state = 'cancelled') = (cancelled_at is not null)),
  check (purge_after > created_at)
);

comment on table public.catalog_file_audio_validation_jobs is
  'Service-role-only resumable cursor for exact-file strict audio language validation; aggregate evidence only.';

alter table public.catalog_file_audio_validation_jobs enable row level security;
alter table public.catalog_file_audio_validation_jobs force row level security;
revoke all on table public.catalog_file_audio_validation_jobs
  from public, anon, authenticated;
grant select, insert, update, delete on table public.catalog_file_audio_validation_jobs
  to service_role;

create index catalog_file_audio_validation_jobs_requester_idx
  on public.catalog_file_audio_validation_jobs (requested_by, id);
create index catalog_file_audio_validation_jobs_resume_idx
  on public.catalog_file_audio_validation_jobs (
    state, queue_expires_at, retry_at, lease_expires_at, updated_at
  );
create index catalog_file_audio_validation_jobs_retention_idx
  on public.catalog_file_audio_validation_jobs (purge_after, requested_by)
  where state in ('verified', 'failed', 'expired', 'cancelled');
create unique index catalog_file_audio_validation_jobs_one_active_file_idx
  on public.catalog_file_audio_validation_jobs (identity_key, item_type, external_id)
  where state in ('queued', 'running', 'retry_wait', 'finalizing');

create or replace function public.vod_language_profile_audio_indices(p_profile jsonb)
returns integer[]
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select coalesce(array_agg(stream_index order by stream_index), '{}'::integer[])
  from (
    select distinct (track->>'index')::integer as stream_index
    from jsonb_array_elements(
      case
        when jsonb_typeof(p_profile->'audioTracks') = 'array' then p_profile->'audioTracks'
        when jsonb_typeof(p_profile->'audio_tracks') = 'array' then p_profile->'audio_tracks'
        else '[]'::jsonb
      end
    ) tracks(track)
    where coalesce(track->>'index', '') ~ '^[0-9]{1,3}$'
      and (track->>'index')::integer between 0 and 128
  ) indexed
$function$;

create or replace function public.vod_language_profile_file_size_bytes(p_profile jsonb)
returns bigint
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select case
    when coalesce(p_profile->>'fileSizeBytes', p_profile->>'file_size_bytes', '') ~ '^[0-9]{1,16}$'
      and coalesce(p_profile->>'fileSizeBytes', p_profile->>'file_size_bytes')::numeric
        between 1 and 9007199254740991
      then coalesce(p_profile->>'fileSizeBytes', p_profile->>'file_size_bytes')::bigint
    else null
  end
$function$;

create or replace function public.vod_language_profile_snapshot(p_profile jsonb)
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select jsonb_build_object(
    'metadataComplete', lower(coalesce(
      p_profile->>'metadataComplete', p_profile->>'metadata_complete', 'false'
    )) = 'true',
    'probeSource', regexp_replace(lower(
      coalesce(p_profile->>'probeSource', p_profile->>'probe_source', '')
    ),
      '[^a-z0-9]+', '', 'g'
    ),
    'probedAt', coalesce(p_profile->>'probedAt', p_profile->>'probed_at', ''),
    'container', regexp_replace(lower(coalesce(p_profile->>'container', '')), '[^a-z0-9]+', '', 'g'),
    'durationSeconds', case
      when coalesce(
        p_profile->>'durationSeconds', p_profile->>'duration_seconds', p_profile->>'duration', ''
      ) ~ '^[0-9]+(?:\.[0-9]+)?$'
        then coalesce(
          p_profile->>'durationSeconds', p_profile->>'duration_seconds', p_profile->>'duration'
        )::numeric
      else null
    end,
    'fileSizeBytes', public.vod_language_profile_file_size_bytes(p_profile),
    'audioTracks', (
      select coalesce(
        jsonb_agg(
          jsonb_strip_nulls(jsonb_build_object(
            'index', (track.value->>'index')::integer,
            'codec', left(regexp_replace(lower(coalesce(
              track.value->>'codec', track.value->>'codecName', track.value->>'codec_name', ''
            )), '[^a-z0-9]+', '', 'g'), 32),
            'channels', case
              when coalesce(track.value->>'channels', '') ~ '^[0-9]{1,2}$'
                and (track.value->>'channels')::integer between 0 and 16
                then (track.value->>'channels')::integer
              else null
            end,
            'default', lower(coalesce(track.value->>'default', 'false')) = 'true'
          ))
          order by (track.value->>'index')::integer
        ),
        '[]'::jsonb
      )
      from jsonb_array_elements(
        case
          when jsonb_typeof(p_profile->'audioTracks') = 'array' then p_profile->'audioTracks'
          when jsonb_typeof(p_profile->'audio_tracks') = 'array' then p_profile->'audio_tracks'
          else '[]'::jsonb
        end
      ) track(value)
      where coalesce(track.value->>'index', '') ~ '^[0-9]{1,3}$'
        and (track.value->>'index')::integer between 0 and 128
    )
  )
$function$;

create or replace function public.vod_language_profile_is_exact(p_profile jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select coalesce(
    jsonb_typeof(p_profile) = 'object'
    and lower(coalesce(
      p_profile->>'metadataComplete',
      p_profile->>'metadata_complete',
      'false'
    )) = 'true'
    and regexp_replace(lower(coalesce(p_profile->>'container', '')), '[^a-z0-9]+', '', 'g')
      in ('mkv', 'matroska', 'matroskawebm')
    and regexp_replace(lower(
      coalesce(p_profile->>'probeSource', p_profile->>'probe_source', '')
    ),
      '[^a-z0-9]+', '', 'g'
    ) = 'gatewayinband'
    and coalesce(
      p_profile->>'durationSeconds',
      p_profile->>'duration_seconds',
      p_profile->>'duration',
      ''
    ) ~ '^[0-9]+(?:\.[0-9]+)?$'
    and coalesce(
      p_profile->>'durationSeconds',
      p_profile->>'duration_seconds',
      p_profile->>'duration'
    )::numeric > 0
    and coalesce(p_profile->>'probedAt', p_profile->>'probed_at', '') <> ''
    and public.vod_language_profile_file_size_bytes(p_profile) is not null
    and cardinality(public.vod_language_profile_audio_indices(p_profile)) between 1 and 32
    and jsonb_array_length(
      case
        when jsonb_typeof(p_profile->'audioTracks') = 'array' then p_profile->'audioTracks'
        when jsonb_typeof(p_profile->'audio_tracks') = 'array' then p_profile->'audio_tracks'
        else '[]'::jsonb
      end
    ) = cardinality(public.vod_language_profile_audio_indices(p_profile)),
    false
  )
$function$;

revoke all on function public.vod_language_profile_audio_indices(jsonb)
  from public, anon, authenticated;
revoke all on function public.vod_language_profile_file_size_bytes(jsonb)
  from public, anon, authenticated;
revoke all on function public.vod_language_profile_snapshot(jsonb)
  from public, anon, authenticated;
revoke all on function public.vod_language_profile_is_exact(jsonb)
  from public, anon, authenticated;
grant execute on function public.vod_language_profile_audio_indices(jsonb) to service_role;
grant execute on function public.vod_language_profile_file_size_bytes(jsonb) to service_role;
grant execute on function public.vod_language_profile_snapshot(jsonb) to service_role;
grant execute on function public.vod_language_profile_is_exact(jsonb) to service_role;

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
  if not found
     or v_job.state in ('verified', 'failed', 'expired', 'cancelled') then
    return null;
  end if;
  if v_job.state = 'queued'
     and v_job.lease_owner is null
     and v_job.queue_expires_at <= v_now then
    update public.catalog_file_audio_validation_jobs
       set state = 'expired',
           error_code = 'LANGUAGE_VALIDATION_QUEUE_EXPIRED',
           queue_expires_at = null,
           retry_at = v_now,
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
  if v_job.attempt_count >= 64 then
    update public.catalog_file_audio_validation_jobs
       set state = 'cancelled',
           error_code = 'LANGUAGE_VALIDATION_ATTEMPT_LIMIT',
           lease_owner = null,
           lease_expires_at = null,
           queue_expires_at = null,
           retry_at = v_now,
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
  update public.catalog_file_audio_validation_jobs
     set state = case when v_track_index is null then 'finalizing' else 'running' end,
         retry_at = null,
         error_code = null,
         queue_expires_at = null,
         lease_owner = btrim(p_lease_owner),
         lease_expires_at = v_now + make_interval(secs => v_ttl),
         attempt_count = attempt_count + 1,
         updated_at = v_now
   where id = v_job.id;

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
    'trackIndex', v_track_index
  );
end
$function$;

create or replace function public.checkpoint_catalog_file_audio_validation_job(
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
         state = case when v_complete then 'finalizing' else 'queued' end,
         queue_expires_at = case
           when v_complete then null
           else v_now + interval '15 minutes'
         end,
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
  v_code text := upper(regexp_replace(coalesce(p_error_code, 'VALIDATION_FAILED'), '[^A-Z0-9_]+', '_', 'g'));
  v_retry_at timestamptz := coalesce(p_retry_at, v_now + interval '1 day');
  v_provenance jsonb;
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
    v_job.identity_key, 'movie', v_job.external_id, false,
    v_now, v_retry_at, v_provenance
  ) then
    raise exception 'Unable to persist language validation retry cursor' using errcode = '40001';
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

create or replace function public.cancel_catalog_file_audio_validation_job(
  p_job_id uuid,
  p_requested_by uuid,
  p_error_code text default 'LANGUAGE_VALIDATION_CANCELLED'
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.catalog_file_audio_validation_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_code text := left(upper(regexp_replace(
    coalesce(p_error_code, 'LANGUAGE_VALIDATION_CANCELLED'),
    '[^A-Z0-9_]+', '_', 'g'
  )), 64);
begin
  if p_job_id is null or p_requested_by is null then return false; end if;
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id
    and job.requested_by = p_requested_by;
  if not found then return false; end if;

  -- Match the start RPC lock order: requester first, canonical file second.
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation-user:' || p_requested_by::text,
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation:' || v_job.identity_key || ':movie:' || v_job.external_id,
    0
  ));
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id
    and job.requested_by = p_requested_by
  for update;
  if not found
     or v_job.state in ('verified', 'failed', 'expired', 'cancelled') then
    return false;
  end if;

  update public.catalog_file_audio_validation_jobs
     set state = 'cancelled',
         error_code = v_code,
         lease_owner = null,
         lease_expires_at = null,
         queue_expires_at = null,
         retry_at = v_now,
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
           'reason', lower(v_code),
           'retryAt', v_now
         ),
         updated_at = v_now
   where cache.server_host = v_job.identity_key
     and cache.item_type = v_job.item_type
     and cache.external_id = v_job.external_id
     and cache.audio_lang_verification->>'jobId' = v_job.id::text;
  return true;
end
$function$;

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
    and cache.item_type = 'movie'
    and cache.external_id = v_job.external_id
  for update;
  if not found
     or public.catalog_audio_track_indexes(v_cache.audio_tracks)
        is distinct from v_job.expected_audio_indices
     or jsonb_array_length(v_cache.audio_tracks) <> cardinality(v_job.expected_audio_indices) then
    raise exception 'Canonical audio inventory changed' using errcode = '40001';
  end if;

  select variant.codec_profile into v_profile
  from public.cloud_title_variants variant
  join public.cloud_sources source
    on source.id = variant.source_id
   and source.user_id = variant.user_id
   and source.deleted_at is null
   and source.enabled = true
  join public.catalog_source_provider_identities identity
    on identity.source_id = source.id
   and identity.user_id = source.user_id
   and identity.identity_id::text = v_job.identity_key
  where variant.id = v_job.variant_id
    and variant.user_id = v_job.requested_by
    and variant.source_id = v_job.source_id
    and variant.item_type = 'movie'
    and variant.external_id = v_job.external_id
  for update of variant;
  if not found
     or not public.vod_language_profile_is_exact(v_profile)
     or public.vod_language_profile_audio_indices(v_profile) is distinct from v_job.expected_audio_indices
     or public.vod_language_profile_file_size_bytes(v_profile) is distinct from v_job.file_size_bytes
     or public.vod_language_profile_snapshot(v_profile) is distinct from v_job.profile_snapshot
     or coalesce(v_profile->>'probedAt', v_profile->>'probed_at')::timestamptz
        is distinct from v_job.profile_probed_at then
    raise exception 'Exact language validation profile changed' using errcode = '40001';
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
    'sampleDurationSeconds', 30,
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
    v_job.identity_key, 'movie', v_job.external_id,
    v_validated_tracks, '[]'::jsonb, true, false
  );
  if not public.record_catalog_file_audio_verification(
    v_job.identity_key, 'movie', v_job.external_id, true,
    v_verified_at, null, v_provenance
  ) then
    raise exception 'Unable to finalize strict language validation' using errcode = '40001';
  end if;
  update public.catalog_file_audio_validation_jobs
     set state = 'verified', verified_at = v_verified_at,
         retry_at = null, error_code = null,
         lease_owner = null, lease_expires_at = null,
         queue_expires_at = null,
         purge_after = v_verified_at + interval '7 days',
         cached_audio_tracks = v_validated_tracks,
         updated_at = v_verified_at
   where id = v_job.id;
  return jsonb_build_object('verifiedAt', v_verified_at, 'audioTracks', v_job.evidence);
end
$function$;

revoke all on function public.start_catalog_file_audio_validation_job(
  uuid, uuid, uuid, text, text, integer[], text, timestamptz, bigint, jsonb
) from public, anon, authenticated;
revoke all on function public.claim_catalog_file_audio_validation_job(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.checkpoint_catalog_file_audio_validation_job(uuid, text, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_catalog_file_audio_validation_job(uuid, text, text, boolean, timestamptz)
  from public, anon, authenticated;
revoke all on function public.cancel_catalog_file_audio_validation_job(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.finalize_catalog_file_audio_validation_job(
  uuid, text, text, timestamptz, bigint, integer[]
) from public, anon, authenticated;

grant execute on function public.start_catalog_file_audio_validation_job(
  uuid, uuid, uuid, text, text, integer[], text, timestamptz, bigint, jsonb
) to service_role;
grant execute on function public.claim_catalog_file_audio_validation_job(uuid, text, integer)
  to service_role;
grant execute on function public.checkpoint_catalog_file_audio_validation_job(uuid, text, integer, jsonb)
  to service_role;
grant execute on function public.fail_catalog_file_audio_validation_job(uuid, text, text, boolean, timestamptz)
  to service_role;
grant execute on function public.cancel_catalog_file_audio_validation_job(uuid, uuid, text)
  to service_role;
grant execute on function public.finalize_catalog_file_audio_validation_job(
  uuid, text, text, timestamptz, bigint, integer[]
) to service_role;
