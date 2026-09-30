-- Publish Selection's durable, Gateway-bound profile with its certificate.
-- Never borrow fields from another observation or weaken the observed guard.
begin;
set local statement_timeout='30s';
set local lock_timeout='3s';

create function public.selection_audio_publication_binding(
  p_profile jsonb,p_result jsonb,p_external_id text,p_url_sha256 text
) returns jsonb language plpgsql immutable set search_path='' as $function$
declare
  v_at timestamptz;
  v_bytes bigint;
  v_indices integer[];
  v_certificate jsonb:=p_result->'verification';
  v_track jsonb;
  v_evidence jsonb;
begin
  v_at:=nullif(p_profile->>'probedAt','')::timestamptz;
  v_bytes:=public.vod_language_profile_file_size_bytes(p_profile);
  v_indices:=public.vod_language_profile_audio_indices(p_profile);
  if jsonb_typeof(p_profile) is distinct from 'object'
    or p_profile->>'externalId' is distinct from p_external_id
    or p_profile->>'urlSha256' is distinct from p_url_sha256
    or coalesce(p_profile->>'fingerprint','') !~ '^[a-f0-9]{64}$'
    or v_at is null or not isfinite(v_at) or v_bytes is null
    or jsonb_typeof(p_profile->'durationSeconds') is distinct from 'number'
    or (p_profile->>'durationSeconds')::numeric not between 80 and 86400
    or p_profile->>'probeSource' not in ('gatewayprobe','gatewayinband')
    or p_profile->>'probeSource' is null
    or (p_profile->>'probeSource'='gatewayinband' and p_profile->>'metadataComplete' is distinct from 'true')
    or jsonb_typeof(p_profile->'audioTracks') is distinct from 'array'
    or cardinality(v_indices) not between 1 and 32
    or cardinality(v_indices)<>jsonb_array_length(p_profile->'audioTracks')
    or jsonb_typeof(p_result->'audioTracks') is distinct from 'array'
    or cardinality(v_indices)<>jsonb_array_length(p_result->'audioTracks')
    or v_indices is distinct from public.catalog_audio_track_indexes(p_result->'audioTracks')
    or jsonb_typeof(v_certificate) is distinct from 'object'
    or v_certificate->>'method' is distinct from 'selection-strict-lid-v1'
    or v_certificate->>'urlSha256' is distinct from p_url_sha256
    or v_certificate->>'profileFingerprint' is distinct from p_profile->>'fingerprint'
    or (v_certificate ? 'profileProbedAt' and
      nullif(v_certificate->>'profileProbedAt','')::timestamptz is distinct from v_at)
    or (v_certificate ? 'fileSizeBytes' and
      public.vod_language_profile_file_size_bytes(v_certificate) is distinct from v_bytes) then
    raise exception 'Selection publication profile binding is invalid' using errcode='PT409';
  end if;
  if p_result->>'verified'='true' then
    if v_certificate->>'status' is distinct from 'verified'
      or jsonb_typeof(v_certificate->'tracks') is distinct from 'array'
      or jsonb_array_length(v_certificate->'tracks')<>cardinality(v_indices) then
      raise exception 'Selection publication evidence is incomplete' using errcode='PT409';
    end if;
    for v_track in select value from jsonb_array_elements(p_result->'audioTracks') loop
      if (select count(*) from jsonb_array_elements(v_certificate->'tracks') entry
          where entry->>'index'=v_track->>'index')<>1 then
        raise exception 'Selection publication evidence map differs' using errcode='PT409';
      end if;
      select entry->'evidence' into v_evidence from jsonb_array_elements(v_certificate->'tracks') entry
        where entry->>'index'=v_track->>'index';
      if v_evidence->>'profileFingerprint' is distinct from p_profile->>'fingerprint'
        or nullif(v_evidence->>'profileProbedAt','')::timestamptz is distinct from v_at
        or public.vod_language_profile_file_size_bytes(v_evidence) is distinct from v_bytes
        or v_evidence->>'streamIndex' is distinct from v_track->>'index'
        or v_evidence->>'language' is distinct from v_track->>'lang'
        or v_evidence->>'status' is distinct from 'verified'
        or v_evidence->>'method' is distinct from 'whisper-strict-consensus-v4' then
        raise exception 'Selection publication evidence belongs to another profile' using errcode='PT409';
      end if;
    end loop;
  elsif p_result->>'verified' is distinct from 'false' or v_certificate->>'status' is distinct from 'probed' then
    raise exception 'Selection publication status is invalid' using errcode='PT409';
  end if;
  -- Legacy certificates lack these two top-level fields. They may be derived
  -- only after checking the durable profile AND every certified track above.
  return jsonb_build_object('profile',p_profile-'fingerprint'-'windowCount',
    'verification',v_certificate||jsonb_build_object('profileProbedAt',p_profile->>'probedAt','fileSizeBytes',v_bytes));
end
$function$;
revoke all on function public.selection_audio_publication_binding(jsonb,jsonb,text,text) from public,anon,authenticated;

create or replace function public.hydrate_selection_audio_results(
  p_user_id uuid,p_source_id uuid,p_generation_id uuid,p_head_revision bigint,p_config_revision bigint,
  p_source_visibility_epoch bigint,p_user_visibility_epoch bigint,p_external_ids text[]
) returns integer language plpgsql volatile security definer set search_path='' as $function$
declare
  v_snapshot jsonb; v_file record; v_stale record; v_ids text[]:='{}'::text[]; v_key text; v_changed integer; v_binding jsonb;
begin
  perform public.norva_credential_require_service_role();
  if not public.norva_selection_source_identity_valid(p_source_id,p_user_id) then
    raise exception 'Canonical Selection ownership is required' using errcode='42501';
  end if;
  if p_external_ids is null or cardinality(p_external_ids)>250 then
    raise exception 'A bounded Selection file batch is required' using errcode='22023';
  end if;
  perform 1 from public.cloud_sources source where source.id=p_source_id and source.user_id=p_user_id for share;
  perform 1 from public.cloud_source_catalog_heads head
    join public.cloud_source_lifecycle lifecycle on lifecycle.user_id=head.user_id and lifecycle.source_id=head.source_id
    where head.source_id=p_source_id and head.user_id=p_user_id for share of head,lifecycle;
  perform 1 from public.cloud_user_catalog_visibility_epochs epoch where epoch.user_id=p_user_id for share;
  v_snapshot:=public.norva_get_catalog_write_snapshot(p_source_id,p_user_id);
  if (v_snapshot->>'generationId')::uuid is distinct from p_generation_id
    or (v_snapshot->>'headRevision')::bigint is distinct from p_head_revision
    or (v_snapshot->>'configRevision')::bigint is distinct from p_config_revision
    or (v_snapshot->>'sourceVisibilityEpoch')::bigint is distinct from p_source_visibility_epoch
    or (v_snapshot->>'userVisibilityEpoch')::bigint is distinct from p_user_visibility_epoch
    or (v_snapshot->>'isCatalogVisible')::boolean is distinct from true then
    raise exception 'Selection catalogue snapshot changed' using errcode='PT409';
  end if;
  v_key:=public.catalog_source_file_cache_key(p_source_id,p_user_id);
  if v_key is distinct from 'source:'||p_source_id::text then
    raise exception 'Selection file cache identity changed' using errcode='PT409';
  end if;
  -- An import can retain an external id while changing its physical URL.
  -- Invalidate positively identified old-file evidence immediately, even when
  -- the new file's analysis has not completed. Never display certificate A on B.
  for v_stale in
    select variant.id variant_id,variant.title_id,variant.external_id,
      encode(sha256(convert_to(variant.playback_hint->>'targetUrl','UTF8')),'hex') current_digest
    from public.cloud_catalog_visible_title_variants variant
    join public.cloud_media_items media on media.id=variant.media_item_id and media.user_id=variant.user_id
      and media.source_id=variant.source_id and media.generation_id=variant.generation_id and media.item_type='movie' and media.available
    join public.catalog_file_tracks cache on cache.server_host=v_key and cache.item_type='movie' and cache.external_id=variant.external_id
    where variant.user_id=p_user_id and variant.source_id=p_source_id and variant.generation_id=p_generation_id
      and variant.item_type='movie' and variant.external_id=any(p_external_ids)
      and media.playback_hint->>'targetUrl'=variant.playback_hint->>'targetUrl'
      and nullif(variant.playback_hint->>'targetUrl','') is not null
      and nullif(cache.audio_lang_verification->>'urlSha256','') is not null
      and cache.audio_lang_verification->>'urlSha256' is distinct from
        encode(sha256(convert_to(variant.playback_hint->>'targetUrl','UTF8')),'hex')
    for update of cache
  loop
    update public.catalog_file_tracks set audio_tracks='[]'::jsonb,subtitle_tracks='[]'::jsonb,
      audio_probed_at=null,subtitle_probed_at=null,audio_lang_verified_at=null,audio_lang_retry_at=null,
      audio_lang_verification=jsonb_build_object('status','unidentified','urlSha256',v_stale.current_digest),updated_at=clock_timestamp()
      where server_host=v_key and item_type='movie' and external_id=v_stale.external_id;
    delete from public.cloud_title_file_language_observations observation where observation.user_id=p_user_id
      and observation.variant_id=v_stale.variant_id and observation.file_external_id=v_stale.external_id;
    perform public.norva_set_catalog_delete_proof(p_source_id,p_user_id,p_generation_id,p_head_revision,
      p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch);
    update public.cloud_title_variants variant set audio_lang_verified_at=null,audio_lang_verify_retry_at=null,
      write_head_revision=p_head_revision,write_config_revision=p_config_revision,
      write_source_visibility_epoch=p_source_visibility_epoch,write_user_visibility_epoch=p_user_visibility_epoch
      where variant.id=v_stale.variant_id and variant.user_id=p_user_id and variant.source_id=p_source_id
        and variant.generation_id=p_generation_id;
    perform public.recompute_cloud_title_file_languages(p_user_id,v_stale.title_id);
  end loop;
  for v_file in
    select distinct job.external_id,job.url_sha256,job.profile,job.result,job.completed_at
    from public.catalog_selection_audio_jobs job
    join public.cloud_catalog_visible_title_variants variant on variant.external_id=job.external_id
      and variant.user_id=p_user_id and variant.source_id=p_source_id and variant.generation_id=p_generation_id
      and variant.item_type='movie' and variant.external_id=any(p_external_ids)
    join public.cloud_media_items media on media.id=variant.media_item_id and media.user_id=variant.user_id
      and media.source_id=variant.source_id and media.generation_id=variant.generation_id and media.item_type='movie' and media.available
    where job.state='completed'
      and encode(sha256(convert_to(variant.playback_hint->>'targetUrl','UTF8')),'hex')=job.url_sha256
      and media.playback_hint->>'targetUrl'=variant.playback_hint->>'targetUrl'
  loop
    v_binding:=public.selection_audio_publication_binding(v_file.profile,v_file.result,v_file.external_id,v_file.url_sha256);
    insert into public.catalog_file_tracks as cache(
      server_host,item_type,external_id,audio_tracks,subtitle_tracks,audio_probed_at,subtitle_probed_at,
      audio_lang_verified_at,audio_lang_retry_at,audio_lang_verification,updated_at,
      observed_profile_fingerprint,observed_profile_probed_at,observed_profile_snapshot
    ) values(v_key,'movie',v_file.external_id,v_file.result->'audioTracks',v_file.result->'subtitleTracks',
      v_file.completed_at,v_file.completed_at,
      case when (v_file.result->>'verified')::boolean then v_file.completed_at else null end,null,
      v_binding->'verification',clock_timestamp(),v_file.profile->>'fingerprint',
      (v_file.profile->>'probedAt')::timestamptz,v_binding->'profile')
    on conflict(server_host,item_type,external_id) do update set
      audio_tracks=excluded.audio_tracks,audio_probed_at=excluded.audio_probed_at,
      subtitle_tracks=case when cache.subtitle_probed_at is null
          or cache.observed_profile_fingerprint is distinct from excluded.observed_profile_fingerprint or
          cache.audio_lang_verification->>'urlSha256' is distinct from excluded.audio_lang_verification->>'urlSha256'
        then excluded.subtitle_tracks else cache.subtitle_tracks end,
      subtitle_probed_at=case when cache.observed_profile_fingerprint is distinct from excluded.observed_profile_fingerprint
          or cache.audio_lang_verification->>'urlSha256' is distinct from excluded.audio_lang_verification->>'urlSha256'
        then excluded.subtitle_probed_at else coalesce(cache.subtitle_probed_at,excluded.subtitle_probed_at) end,
      audio_lang_verified_at=excluded.audio_lang_verified_at,audio_lang_retry_at=null,
      audio_lang_verification=excluded.audio_lang_verification,updated_at=clock_timestamp(),
      observed_profile_fingerprint=excluded.observed_profile_fingerprint,
      observed_profile_probed_at=excluded.observed_profile_probed_at,
      observed_profile_snapshot=excluded.observed_profile_snapshot
    where (cache.observed_profile_probed_at is null
        or cache.observed_profile_probed_at<=excluded.observed_profile_probed_at)
      and (cache.observed_profile_fingerprint is distinct from excluded.observed_profile_fingerprint
        or cache.audio_lang_verification->>'urlSha256' is distinct from excluded.audio_lang_verification->>'urlSha256'
      or (cache.audio_lang_verified_at is null and (excluded.audio_lang_verified_at is not null
        or cardinality(public.cloud_file_track_languages(cache.audio_tracks))=0
        or (not coalesce(public.selection_audio_tracks_complete(cache.audio_tracks),false)
          and public.selection_audio_tracks_complete(excluded.audio_tracks)))));
    get diagnostics v_changed=row_count;
    -- Hydrate even if a stronger cache entry was preserved: a fresh enrolment
    -- may still be missing its exact-file observation.
    v_ids:=array_append(v_ids,v_file.external_id);
  end loop;
  if cardinality(v_ids)=0 then return 0; end if;
  return public.hydrate_cloud_title_file_languages(p_user_id,p_source_id,p_generation_id,p_head_revision,
    p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch,v_key,'movie',v_ids);
end
$function$;

commit;
