-- Explicit, bounded new speech regions after a complete inconclusive analysis.
-- Pass zero and all existing evidence stay compatible. No automatic mass retry.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
alter table public.catalog_file_audio_validation_jobs
  add column if not exists sampling_pass integer not null default 0
  check (sampling_pass between 0 and 6);
do $guard$ begin
 if md5(pg_get_functiondef('public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'::regprocedure)) <> '4d70c053885e4eac18198cbcacf61769' then raise exception 'Automatic language start definition drifted'; end if;
end $guard$;
CREATE OR REPLACE FUNCTION public.start_resampled_catalog_file_audio_validation_job(p_requested_by uuid, p_source_id uuid, p_variant_id uuid, p_identity_key text, p_item_type text, p_external_id text, p_expected_audio_indices integer[], p_profile jsonb, p_profile_fingerprint text, p_profile_probed_at timestamp with time zone, p_file_size_bytes bigint, p_cached_audio_tracks jsonb, p_provider_drain_attested boolean, p_sampling_pass integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
       'mkv', 'matroska', 'matroskawebm', 'webm', 'mp4', 'mov', 'movmp4m4a3gp3g2mj2', 'avi', 'ogg', 'flv', 'mpg', 'mpeg', 'ts', 'mpegts'
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
    left join public.catalog_source_provider_identities identity
      on identity.source_id = source.id
     and identity.user_id = source.user_id
    where coalesce(identity.identity_id::text,'source:'||source.id::text)=btrim(p_identity_key)
      and variant.id = p_variant_id
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

  -- Run under the existing per-user and exact-file advisory locks.
  -- Automatic intake never revives quarantines or completed attempts against
  -- the same observed bytes. A genuinely changed profile is a new assessment.
  if exists(select 1 from public.catalog_file_audio_validation_jobs prior
    where prior.identity_key=btrim(p_identity_key) and prior.item_type=p_item_type
      and prior.external_id=btrim(p_external_id)
      and (prior.quarantined_at is not null or (prior.state in ('failed','cancelled','expired')
        and prior.profile_fingerprint=p_profile_fingerprint
        and prior.error_code is distinct from 'LANGUAGE_VALIDATION_STRICT_CONSENSUS_INCONCLUSIVE'))) then
    return jsonb_build_object('busy',true,'code','LANGUAGE_VALIDATION_PRIOR_OUTCOME_PRESERVED');
  end if;

  -- Operator-authorized exploration of new, disjoint speech regions only.
  -- Keep all old jobs, receipts, provider attempts and their retry dates intact.
  -- This route cannot revive failed transport, quarantined or unfinished work.
  if p_sampling_pass is null or p_sampling_pass not between 1 and 6
     or coalesce((v_profile_snapshot->>'durationSeconds')::numeric,0) < 2880
     or not exists (
       select 1 from public.catalog_file_audio_validation_jobs prior
       where prior.requested_by=p_requested_by and prior.source_id=p_source_id
         and prior.variant_id=p_variant_id and prior.identity_key=btrim(p_identity_key)
         and prior.item_type=p_item_type and prior.external_id=btrim(p_external_id)
         and prior.profile_fingerprint=p_profile_fingerprint
         and prior.profile_snapshot=v_profile_snapshot
         and prior.state='failed' and prior.quarantined_at is null
         and prior.error_code='LANGUAGE_VALIDATION_STRICT_CONSENSUS_INCONCLUSIVE'
         and prior.strict_lid_window_position=prior.strict_lid_window_count
         and prior.strict_lid_window_count in (4,6)
         and jsonb_array_length(prior.strict_lid_window_tokens)=prior.strict_lid_window_count
         and prior.sampling_pass=p_sampling_pass-1
     ) or exists (
       select 1 from public.catalog_file_audio_validation_jobs prior
       where prior.identity_key=btrim(p_identity_key) and prior.item_type=p_item_type
         and prior.external_id=btrim(p_external_id) and prior.profile_fingerprint=p_profile_fingerprint
         and prior.sampling_pass>=p_sampling_pass
     ) then
    return jsonb_build_object('limited',true,'code','LANGUAGE_RESAMPLING_NOT_ELIGIBLE');
  end if;
  if (select count(*) from public.catalog_file_audio_validation_jobs j
      where j.requested_by=p_requested_by and j.request_origin='manual'
        and j.created_at>v_now-interval '24 hours') >=20 then
    return jsonb_build_object('limited',true,'code','LANGUAGE_VALIDATION_RATE_LIMITED');
  end if;

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

  if not exists(select 1 from public.admin_feature_flags where key='adaptive_language_admission_enabled' and enabled) then
    return jsonb_build_object('limited',true,'code','LANGUAGE_AUTOMATIC_ADMISSION_PAUSED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('catalog-language-admission',0));
  if not public.catalog_language_queue_available(btrim(p_identity_key)) then
    return jsonb_build_object('limited',true,'code','LANGUAGE_AUTOMATIC_QUEUE_FULL',
      'retryAt',v_now+interval '1 minute','retryAfterSeconds',60);
  end if;

  insert into public.catalog_file_audio_validation_jobs (
    requested_by, source_id, variant_id, identity_key, item_type, external_id,
    expected_audio_indices, profile_fingerprint, profile_snapshot, profile_probed_at,
    file_size_bytes, cached_audio_tracks, state, retry_at, queue_expires_at, request_origin, sampling_pass
  ) values (
    p_requested_by, p_source_id, p_variant_id, btrim(p_identity_key), p_item_type,
    btrim(p_external_id), p_expected_audio_indices, p_profile_fingerprint,
    v_profile_snapshot, p_profile_probed_at, p_file_size_bytes, p_cached_audio_tracks,
    'retry_wait', v_now, null, 'manual', p_sampling_pass
  ) returning * into v_job;

  update public.catalog_file_tracks cache
     set audio_lang_verified_at = null,
         audio_lang_retry_at = null,
         audio_lang_verification = jsonb_build_object(
           'protocol', 2,
           'status', 'validating',
           'method', 'whisper-strict-consensus-v4',
           'automatic', false,
           'samplingPass', p_sampling_pass,
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
           'automatic', false,
           'samplingPass', p_sampling_pass,
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
$function$
;
revoke all on function public.start_resampled_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean,integer) from public,anon,authenticated;
grant execute on function public.start_resampled_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean,integer) to service_role;
do $patch$ declare def text; begin
  def:=pg_get_functiondef('public.claim_catalog_file_audio_validation_job(uuid,text,integer)'::regprocedure);
  if md5(def)<>'726c614659ff5d6553f5954a01ef8d8c' then raise exception 'Language claim definition drifted'; end if;
  def:=replace(def,$old$'windowProtocol', v_job.strict_lid_window_protocol$old$,$new$'windowProtocol', v_job.strict_lid_window_protocol,
    'samplingPass', v_job.sampling_pass$new$);
  execute def;
end $patch$;
notify pgrst,'reload schema';
commit;
