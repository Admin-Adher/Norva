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

revoke all on function public.finalize_catalog_file_audio_validation_job(
  uuid, text, text, timestamptz, bigint, integer[]
) from public, anon, authenticated;

grant execute on function public.finalize_catalog_file_audio_validation_job(
  uuid, text, text, timestamptz, bigint, integer[]
) to service_role;

notify pgrst, 'reload schema';
