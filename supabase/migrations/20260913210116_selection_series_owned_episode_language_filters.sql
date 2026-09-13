begin;
set local lock_timeout = '2s';
set local statement_timeout = '20s';

-- Selection episodes have their own file IDs. They must never be treated as the
-- series file, nor may a title/TMDB union or an arbitrary provider episode be
-- substituted. Reuse the owned active-file proof of Selection's ingestion RPC.
-- All metadata below comes from service-owned generation rows (not JWT/user
-- metadata). A matching existing observation is mandatory; this is read-only.
create function public.cloud_catalog_selection_series_observed_audio_languages(
  p_user_id uuid, p_source_id uuid
) returns table(title_id uuid, variant_id uuid, language text)
language sql stable security invoker set search_path = '' as $f$
  with owner_hash as materialized (
    select encode(sha256(convert_to('norva-selection-curated-v1:' || p_user_id::text, 'UTF8')), 'hex') as digest
  ), parameters as materialized (
    select (substr(digest,1,8) || '-' || substr(digest,9,4) || '-4' || substr(digest,14,3)
      || '-a' || substr(digest,18,3) || '-' || substr(digest,21,12))::uuid as source_id
    from owner_hash
  ), parents as materialized (
    -- One canonical source per owner, indexed before joining any episode rows.
    select variant.*
    from parameters p
    join public.cloud_catalog_visible_title_variants variant
      on variant.source_id=p.source_id and variant.user_id=p_user_id
    join public.cloud_source_catalog_heads head
      on head.source_id=variant.source_id and head.user_id=variant.user_id
        and head.active_generation_id=variant.generation_id
    join public.cloud_titles title
      on title.id=variant.title_id and title.user_id=variant.user_id and title.item_type='series'
    where variant.item_type='series'
      and (p_source_id is null or variant.source_id=p_source_id)
      and variant.external_id ~ '^norva-selection:series:[a-f0-9]{64}$'
      and variant.metadata->>'seriesDelivery'='selection'
      and variant.metadata->>'selectionRevision'='selection-vod-20260906-v1'
  ), owned_files as materialized (
    select parent.title_id,parent.id as variant_id,observation.audio_languages,
      episode.metadata->'codecProfile'->'audioTracks' as audio_tracks,
      cache.audio_tracks as cache_audio_tracks,
      nullif(cache.audio_lang_verification->>'urlSha256','') as cache_url_hash,
      episode.metadata#>>'{selectionPlaybackValidation,urlSha256}' as current_url_hash,
      (cache.audio_probed_at is not null or cache.audio_lang_verified_at is not null) as cache_observed
    from parents parent
    join public.cloud_title_file_language_observations observation
      on observation.user_id=parent.user_id and observation.title_id=parent.title_id
        and observation.variant_id=parent.id and observation.audio_observed
    join public.cloud_media_items episode
      on episode.source_id=parent.source_id and episode.generation_id=parent.generation_id
        and episode.item_type='episode' and episode.external_id=observation.file_external_id
        and episode.user_id=parent.user_id and episode.available
        and episode.parent_external_id=parent.external_id
    join public.cloud_media_items parent_item
      on parent_item.id=parent.media_item_id and parent_item.user_id=parent.user_id
        and parent_item.source_id=parent.source_id and parent_item.generation_id=parent.generation_id
        and parent_item.item_type='series' and parent_item.external_id=parent.external_id and parent_item.available
    left join public.catalog_file_tracks cache
      on cache.server_host='source:' || parent.source_id::text
        and cache.item_type='episode' and cache.external_id=observation.file_external_id
    where observation.file_external_id ~ '^norva-selection:movie:[a-f0-9]{64}$'
      and episode.metadata->>'selectionRevision'=parent.metadata->>'selectionRevision'
      and episode.metadata->>'discoveryFeed'=parent.metadata->>'discoveryFeed'
      and episode.metadata->>'selectionParentId'=parent.external_id
      and nullif(episode.metadata#>>'{selectionPlaybackValidation,containerMetadataCheckedAt}','') is not null
      and episode.metadata#>>'{selectionPlaybackValidation,urlSha256}'=
        encode(sha256(convert_to(episode.playback_hint->>'targetUrl','UTF8')),'hex')
  ), valid_files as materialized (
    select file.*,
      array(select distinct code from (
        select case raw.value when 'yue' then 'yue' else public.norva_canonical_language_code(raw.value) end as code
        from unnest(file.audio_languages) raw(value)
      ) canonical where code is not null order by code) as observation_codes,
      public.cloud_file_track_languages(file.audio_tracks) as file_codes,
      public.cloud_file_track_languages(file.cache_audio_tracks) as cache_codes
    from owned_files file
    where jsonb_typeof(file.audio_tracks)='array'
      and jsonb_array_length(case when jsonb_typeof(file.audio_tracks)='array' then file.audio_tracks else '[]'::jsonb end)>0
      and cardinality(public.catalog_audio_track_indexes(file.audio_tracks))=
        jsonb_array_length(case when jsonb_typeof(file.audio_tracks)='array' then file.audio_tracks else '[]'::jsonb end)
  )
  select distinct file.title_id,file.variant_id,code.language
  from valid_files file
  cross join lateral unnest(file.observation_codes) code(language)
  where cardinality(file.observation_codes)>0 and file.observation_codes=file.file_codes
    and (file.cache_url_hash is null or file.cache_url_hash=file.current_url_hash)
    -- A later observed cache may invalidate old metadata/observations. Missing
    -- cache is allowed by Selection's original audited-snapshot proof; a known
    -- conflicting or empty current cache must not revive stale languages.
    and (not coalesce(file.cache_observed,false) or (
      file.cache_codes=file.observation_codes
      and jsonb_typeof(file.cache_audio_tracks)='array'
      and cardinality(public.catalog_audio_track_indexes(file.cache_audio_tracks))=
        jsonb_array_length(case when jsonb_typeof(file.cache_audio_tracks)='array' then file.cache_audio_tracks else '[]'::jsonb end)
    ))
$f$;
revoke all on function public.cloud_catalog_selection_series_observed_audio_languages(uuid,uuid) from public,anon,authenticated;
grant execute on function public.cloud_catalog_selection_series_observed_audio_languages(uuid,uuid) to service_role;
comment on function public.cloud_catalog_selection_series_observed_audio_languages(uuid,uuid) is
  'Read-only languages in genuinely owned active Selection episode files, requiring existing observation and current audited-file concordance; not all episodes or a parent track map.';

-- Keep exact parent/file equality for every pre-existing movie/Xtream path.
-- Only the canonical Selection helper adds episode languages. Compute it once
-- for series and use the same set for facets, filters, unknowns and hint vetoes.
create or replace function public.cloud_catalog_effective_audio_languages(
  p_user_id uuid,p_item_type text,p_source_id uuid,p_language text
) returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path='' as $f$
  with codes as materialized (
    select raw_code,case raw_code when 'yue' then 'yue' else public.norva_canonical_language_code(raw_code) end as code
    from (select distinct unnest(audio_languages) as raw_code
      from public.cloud_title_file_language_observations where user_id=p_user_id and audio_observed) raw
  ), selection_observed as materialized (
    select observed.*
    from public.cloud_catalog_selection_series_observed_audio_languages(p_user_id,p_source_id) observed
    where p_item_type='series'
  )
  select effective.* from (
    select variant.title_id,variant.id,codes.code
    from public.cloud_title_file_language_observations observation
    join public.cloud_catalog_visible_title_variants variant
      on variant.user_id=observation.user_id and variant.title_id=observation.title_id and variant.id=observation.variant_id
        and variant.external_id=observation.file_external_id
    cross join lateral unnest(observation.audio_languages) language(value)
    join codes on codes.raw_code=language.value
    where observation.user_id=p_user_id and observation.audio_observed
      and codes.code is not null and (p_language is null or codes.code=p_language)
      and variant.item_type=p_item_type and p_item_type in ('movie','series')
      and (p_source_id is null or variant.source_id=p_source_id)
    union all
    select observed.title_id,observed.variant_id,observed.language
    from selection_observed observed
    where p_language is null or observed.language=p_language
    union all
    select variant.title_id,variant.id,case hint.language when 'fil' then 'tl' else hint.language end
    from public.cloud_catalog_provider_language_hints hint
    join public.cloud_catalog_visible_title_variants variant
      on variant.id=hint.variant_id and variant.user_id=hint.user_id and variant.title_id=hint.title_id and variant.source_id=hint.source_id
    where hint.user_id=p_user_id and hint.item_type=p_item_type and variant.item_type=p_item_type
      and p_item_type in ('movie','series') and (p_source_id is null or hint.source_id=p_source_id)
      and (p_language is null or hint.language=p_language or (p_language='tl' and hint.language='fil'))
      and not exists(select 1 from public.cloud_title_file_language_observations observation
        cross join lateral unnest(observation.audio_languages) language(value)
        join codes on codes.raw_code=language.value and codes.code is not null
        where observation.user_id=hint.user_id and observation.title_id=hint.title_id and observation.variant_id=hint.variant_id
          and observation.file_external_id=variant.external_id and observation.audio_observed)
      and not exists(select 1 from selection_observed observed
        where observed.title_id=hint.title_id and observed.variant_id=hint.variant_id)
  ) effective(title_id,variant_id,language)
  join public.cloud_titles title on title.id=effective.title_id and title.user_id=p_user_id and title.item_type=p_item_type
$f$;
revoke all on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text) to service_role;

notify pgrst,'reload schema';
commit;
