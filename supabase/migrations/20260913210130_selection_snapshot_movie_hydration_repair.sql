begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- Service input is constructed by selectionSnapshotMovieManifests from the
-- checked-in container audit, never forwarded from user-editable metadata.
-- This narrowly scoped repair is also used by subsequent Selection imports.
create or replace function public.hydrate_selection_snapshot_movie_languages(
  p_user_id uuid, p_source_id uuid, p_generation_id uuid,
  p_head_revision bigint, p_config_revision bigint,
  p_source_visibility_epoch bigint, p_user_visibility_epoch bigint,
  p_files jsonb
) returns integer
language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_snapshot jsonb; v_key text; v_file record; v_cache record;
  v_title_id uuid; v_titles uuid[] := '{}'::uuid[];
  v_count integer := 0; v_changed integer; v_verified boolean;
  v_cache_map jsonb; v_snapshot_map jsonb;
begin
  perform public.norva_credential_require_service_role();
  if not public.norva_selection_source_identity_valid(p_source_id,p_user_id) then
    raise exception 'Canonical Selection ownership is required' using errcode='42501';
  end if;
  if p_files is null or jsonb_typeof(p_files) is distinct from 'array'
    or octet_length(p_files::text)>262144 then
    raise exception 'A bounded immutable Selection manifest is required' using errcode='22023';
  end if;
  if jsonb_array_length(p_files)>50 or exists (
    select 1 from jsonb_array_elements(p_files) entry
    where coalesce(entry->>'externalId','') !~ '^norva-selection:movie:[a-f0-9]{64}$'
      or coalesce(entry->>'urlSha256','') !~ '^[a-f0-9]{64}$'
      or entry->>'revision' is distinct from 'selection-vod-20260906-v1'
      or coalesce(entry->>'feedId','') not in ('herbert-tested-vod','klysmgt-tested-vod','sandro-tested-vod')
      or nullif(entry->>'probedAt','') is null
      or coalesce(public.selection_audio_tracks_complete(entry->'audioTracks'),false) is not true
      or jsonb_typeof(entry->'subtitleTracks') is distinct from 'array'
      or jsonb_typeof(entry->'hasSubtitle') is distinct from 'boolean'
  ) or (select count(*) from jsonb_array_elements(p_files)) is distinct from
       (select count(distinct entry->>'externalId') from jsonb_array_elements(p_files) entry) then
    raise exception 'Invalid immutable Selection manifest' using errcode='22023';
  end if;

  -- Lock authority before physical-file rows. No implicit adoption of a new
  -- generation, configuration, removed source, or visibility epoch is allowed.
  perform 1 from public.cloud_sources source
    where source.id=p_source_id and source.user_id=p_user_id for share;
  perform 1 from public.cloud_source_catalog_heads head
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.user_id=head.user_id and lifecycle.source_id=head.source_id
    where head.source_id=p_source_id and head.user_id=p_user_id for share of head,lifecycle;
  perform 1 from public.cloud_user_catalog_visibility_epochs epoch
    where epoch.user_id=p_user_id for share;
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

  for v_file in
    select variant.id variant_id,variant.title_id,variant.external_id,
      manifest.entry,manifest.entry->>'urlSha256' url_sha256,
      (manifest.entry->>'probedAt')::timestamptz probed_at
    from jsonb_array_elements(p_files) manifest(entry)
    join public.cloud_title_variants variant
      on variant.user_id=p_user_id and variant.source_id=p_source_id
      and variant.generation_id=p_generation_id and variant.item_type='movie'
      and variant.external_id=manifest.entry->>'externalId'
    join public.cloud_titles title on title.id=variant.title_id
      and title.user_id=variant.user_id and title.item_type='movie'
    join public.cloud_media_items media on media.id=variant.media_item_id
      and media.user_id=variant.user_id and media.source_id=variant.source_id
      and media.generation_id=variant.generation_id and media.item_type='movie'
      and media.external_id=variant.external_id and media.available
    where variant.metadata->>'selectionRevision'=manifest.entry->>'revision'
      and media.metadata->>'selectionRevision'=manifest.entry->>'revision'
      and variant.metadata->>'discoveryFeed'=manifest.entry->>'feedId'
      and media.metadata->>'discoveryFeed'=manifest.entry->>'feedId'
      and media.playback_hint->>'targetUrl'=variant.playback_hint->>'targetUrl'
      and nullif(variant.playback_hint->>'targetUrl','') is not null
      and encode(sha256(convert_to(variant.playback_hint->>'targetUrl','UTF8')),'hex')=manifest.entry->>'urlSha256'
      and media.metadata->'selectionPlaybackValidation'->>'urlSha256'=manifest.entry->>'urlSha256'
      and (nullif(media.metadata->'selectionPlaybackValidation'->>'containerMetadataCheckedAt','') is not null
        or (media.metadata->'selectionPlaybackValidation' ? 'containerAudioTags'
          and nullif(media.metadata->'selectionPlaybackValidation'->>'checkedAt','') is not null))
      and not exists (
        select 1 from public.cloud_title_file_language_observations observation
        where observation.user_id=variant.user_id and observation.title_id=variant.title_id
          and observation.variant_id=variant.id and observation.file_external_id=variant.external_id
      )
    order by variant.external_id,variant.id
    for share of variant,media
  loop
    -- The original probe time is kept; this is not a new playback or speech
    -- verification. A cache inserted concurrently wins without replacement.
    insert into public.catalog_file_tracks (
      server_host,item_type,external_id,audio_tracks,subtitle_tracks,
      audio_probed_at,subtitle_probed_at,audio_lang_verification
    ) values (
      v_key,'movie',v_file.external_id,v_file.entry->'audioTracks',v_file.entry->'subtitleTracks',
      v_file.probed_at,case when (v_file.entry->>'hasSubtitle')::boolean then v_file.probed_at else null end,
      jsonb_build_object('status','probed','method','selection-container-audit','urlSha256',v_file.url_sha256)
    ) on conflict (server_host,item_type,external_id) do nothing;

    select * into v_cache from public.catalog_file_tracks cache
      where cache.server_host=v_key and cache.item_type='movie' and cache.external_id=v_file.external_id
      for share;
    if v_cache.audio_probed_at is null then continue; end if;
    -- Older cache rows predate URL provenance. Reuse them only when their
    -- complete, indexed language map agrees with this exact reviewed file.
    -- A mismatching explicit URL digest is never rescued by matching languages.
    if nullif(v_cache.audio_lang_verification->>'urlSha256','') is not null then
      if v_cache.audio_lang_verification->>'urlSha256' is distinct from v_file.url_sha256 then continue; end if;
    else
      if not coalesce(public.selection_audio_tracks_complete(v_cache.audio_tracks),false) then continue; end if;
      select jsonb_agg(jsonb_build_array((track->>'index')::integer,
        public.norva_canonical_language_code(coalesce(track->>'lang',track->>'language'))) order by (track->>'index')::integer)
        into v_cache_map from jsonb_array_elements(v_cache.audio_tracks) track;
      select jsonb_agg(jsonb_build_array((track->>'index')::integer,
        public.norva_canonical_language_code(coalesce(track->>'lang',track->>'language'))) order by (track->>'index')::integer)
        into v_snapshot_map from jsonb_array_elements(v_file.entry->'audioTracks') track;
      if v_cache_map is distinct from v_snapshot_map then continue; end if;
    end if;
    v_verified:=v_cache.audio_lang_verified_at is not null
      and v_cache.audio_lang_verification->>'urlSha256'=v_file.url_sha256
      and cardinality(public.cloud_file_track_languages(v_cache.audio_tracks))>0;
    insert into public.cloud_title_file_language_observations as observation (
      user_id,title_id,variant_id,file_external_id,audio_languages,subtitle_languages,
      audio_observed,subtitle_observed,audio_verified_at,audio_verification,updated_at
    ) values (
      p_user_id,v_file.title_id,v_file.variant_id,v_file.external_id,
      public.cloud_file_track_languages(v_cache.audio_tracks),
      case when v_cache.subtitle_probed_at is not null then public.cloud_file_track_languages(v_cache.subtitle_tracks) else '{}'::text[] end,
      true,v_cache.subtitle_probed_at is not null,
      case when v_verified then v_cache.audio_lang_verified_at else null end,
      case when v_verified then v_cache.audio_lang_verification else '{}'::jsonb end,clock_timestamp()
    ) on conflict (user_id,variant_id,file_external_id) do nothing;
    -- Existing observations, including an explicitly unknown later result,
    -- are untouched. The normal crawler is responsible for updating them.
    get diagnostics v_changed=row_count;
    if v_changed>0 then
      v_count:=v_count+v_changed;
      v_titles:=array_append(v_titles,v_file.title_id);
    end if;
  end loop;
  for v_title_id in select distinct unnest(v_titles) order by 1 loop
    perform public.recompute_cloud_title_file_languages(p_user_id,v_title_id);
  end loop;
  return v_count;
end
$function$;

revoke all on function public.hydrate_selection_snapshot_movie_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,jsonb)
  from public,anon,authenticated;
grant execute on function public.hydrate_selection_snapshot_movie_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,jsonb)
  to service_role;
comment on function public.hydrate_selection_snapshot_movie_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,jsonb) is
  'Bounded immutable Selection movie snapshot hydration; current owner/file/generation fences, insert-only cache and observations, no inferred or newly verified audio.';
notify pgrst,'reload schema';
commit;
