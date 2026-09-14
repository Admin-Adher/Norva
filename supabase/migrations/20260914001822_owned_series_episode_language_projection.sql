begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Read-only projection. A series language means it occurs in a genuinely owned,
-- currently observed episode; it does NOT describe every episode or a parent
-- track map. Missing/incomplete evidence does not disprove an existing supplier
-- declaration: emit no observed language and retain that separate fallback.
create function public.cloud_catalog_xtream_series_episode_audio_evidence(
  p_user_id uuid,p_source_id uuid
) returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path='' as $f$
  with scoped_visible_sources as materialized (
    select source.id,source.user_id from public.cloud_catalog_visible_sources source
    where source.user_id=p_user_id and (p_source_id is null or source.id=p_source_id)
  ), scoped_memberships as materialized (
    -- Start with the much smaller observed-episode inventory, not every series
    -- in the catalogue. Materialization also bounds generic parameter plans.
    select membership.* from public.catalog_series_episode_memberships membership
    where membership.user_id=p_user_id
      and (p_source_id is null or membership.source_id=p_source_id)
  ), owned_files as materialized (
    select variant.title_id,variant.id as variant_id,observation.audio_languages,
      cache.audio_tracks::text collate "C" as track_map_text,
      observation.audio_languages::text collate "C" as observation_map_text,
      membership.provider_identity_id,membership.episode_id,membership.parent_series_id,
      cache.audio_tracks,cache.audio_probed_at,cache.audio_lang_verified_at,
      cache.observed_profile_fingerprint,cache.observed_profile_probed_at,
      cache.observed_profile_snapshot,cache.audio_lang_verification,
      observation.audio_verified_at,observation.audio_verification
    from scoped_memberships membership
    join public.cloud_title_file_language_observations observation
      on observation.user_id=membership.user_id and observation.title_id=membership.parent_title_id
        and observation.variant_id=membership.parent_variant_id and observation.file_external_id=membership.episode_id
    -- Equivalent visible-variant proof, joined by the exact member variant ID.
    -- Expanding the security-barrier variant view here made generic plans scan
    -- whole catalogues per episode; source visibility + active head stay exact.
    join public.cloud_title_variants variant
      on variant.user_id=observation.user_id and variant.title_id=observation.title_id
        and variant.id=observation.variant_id and variant.item_type='series'
    join scoped_visible_sources visible_source
      on visible_source.id=variant.source_id and visible_source.user_id=variant.user_id
    join public.cloud_source_catalog_heads head
      on head.user_id=variant.user_id and head.source_id=variant.source_id
        and head.active_generation_id=variant.generation_id
    join public.cloud_titles title
      on title.id=variant.title_id and title.user_id=variant.user_id and title.item_type='series'
    join public.cloud_media_items parent_item
      on parent_item.id=variant.media_item_id and parent_item.user_id=variant.user_id
        and parent_item.source_id=variant.source_id and parent_item.generation_id=variant.generation_id
        and parent_item.item_type='series' and parent_item.external_id=variant.external_id and parent_item.available
    join public.catalog_source_provider_identities identity
      on identity.source_id=variant.source_id and identity.user_id=variant.user_id
        and identity.identity_id=membership.provider_identity_id and identity.verified_at is not null
    join public.catalog_file_tracks cache
      on cache.server_host=membership.provider_identity_id::text
        and cache.item_type='episode' and cache.external_id=membership.episode_id
    where observation.user_id=p_user_id and observation.audio_observed
      and (p_source_id is null or variant.source_id=p_source_id)
      and membership.user_id=variant.user_id and membership.source_id=variant.source_id
      and membership.generation_id=variant.generation_id
      and membership.parent_title_id=variant.title_id and membership.parent_variant_id=variant.id
      and membership.parent_series_id=variant.external_id and membership.parent_item_type='series'
      and membership.episode_id=observation.file_external_id
      and cache.audio_probed_at is not null and isfinite(cache.audio_probed_at)
  ), track_maps as materialized (
    -- Thousands of episodes share the same small metadata track map. Apply the
    -- unchanged validators once per exact textual JSON map, not per file.
    -- JSONB equality conflates numeric 1 and 1.0, but the index validator reads
    -- their text differently. A deterministic text key preserves that guard.
    select raw.track_map_text,
      coalesce(public.selection_audio_tracks_complete(raw.track_map_text::jsonb),false) as complete,
      public.cloud_file_track_languages(raw.track_map_text::jsonb) as codes
    from (select distinct file.track_map_text from owned_files file) raw
  ), observation_maps as materialized (
    select raw.observation_map_text,
      array(select distinct code from (
        select case value when 'yue' then 'yue' else public.norva_canonical_language_code(value) end as code
        from unnest(raw.observation_map_text::text[]) language(value)
      ) canonical where code is not null order by code) as codes,
      not exists(select 1 from unnest(raw.observation_map_text::text[]) language(value)
        where value is distinct from 'yue' and public.norva_canonical_language_code(value) is null) as complete
    from (select distinct file.observation_map_text from owned_files file) raw
  ), checked_files as materialized (
    select file.*,observation_map.codes as observation_codes,
      observation_map.complete as observation_complete,track_map.codes as cache_codes,
      -- A supplied profile is authoritative. A missing profile is not a new
      -- speech certificate: the existing exact-coordinate metadata stays so.
      (file.observed_profile_fingerprint is null
        and file.observed_profile_probed_at is null and file.observed_profile_snapshot is null)
      or (file.observed_profile_fingerprint is not null
        and file.observed_profile_probed_at is not null and isfinite(file.observed_profile_probed_at)
        and file.observed_profile_snapshot is not null
        and file.audio_probed_at>=file.observed_profile_probed_at
        and public.catalog_audio_track_indexes(file.audio_tracks)=
          public.vod_language_profile_audio_indices(file.observed_profile_snapshot)
        and (file.audio_lang_verified_at is null or (
          file.audio_lang_verification->>'profileFingerprint'=file.observed_profile_fingerprint
          and file.audio_lang_verified_at>=file.observed_profile_probed_at
          and public.vod_language_profile_file_size_bytes(file.audio_lang_verification)=
            public.vod_language_profile_file_size_bytes(file.observed_profile_snapshot)
        ))
        and (file.audio_verified_at is null or (
          file.audio_verification->>'profileFingerprint'=file.observed_profile_fingerprint
        ))) as profile_matches
    from owned_files file
    join track_maps track_map on track_map.track_map_text=file.track_map_text and track_map.complete
    join observation_maps observation_map on observation_map.observation_map_text=file.observation_map_text
  ), evaluated as materialized (
    select file.title_id,file.variant_id,file.provider_identity_id,file.episode_id,file.parent_series_id,
      case when cardinality(file.observation_codes)>0 and file.observation_codes=file.cache_codes
        and coalesce(file.profile_matches,false)
        -- Mixed named/unknown observations are not a complete language map.
        and file.observation_complete
      then file.observation_codes else '{}'::text[] end as languages
    from checked_files file
  ), unambiguous_files as materialized (
    select file.*,not exists (
    -- Only audio-admissible files reach this ownership ambiguity check. The
    -- cross-owner, active generation and canonical identity guards are intact.
    select 1 from public.catalog_series_episode_memberships conflicting
    join public.cloud_title_variants other_parent
      on other_parent.id=conflicting.parent_variant_id
        and other_parent.user_id=conflicting.user_id
        and other_parent.source_id=conflicting.source_id
        and other_parent.generation_id=conflicting.generation_id
        and other_parent.title_id=conflicting.parent_title_id
        and other_parent.external_id=conflicting.parent_series_id
        and other_parent.item_type='series'
    join public.cloud_catalog_visible_sources other_source
      on other_source.id=other_parent.source_id and other_source.user_id=other_parent.user_id
    join public.cloud_source_catalog_heads other_head
      on other_head.source_id=other_parent.source_id and other_head.user_id=other_parent.user_id
        and other_head.active_generation_id=other_parent.generation_id
    join public.catalog_source_provider_identities other_identity
      on other_identity.source_id=conflicting.source_id
        and other_identity.user_id=conflicting.user_id
        and other_identity.identity_id=conflicting.provider_identity_id
        and other_identity.verified_at is not null
    where conflicting.provider_identity_id=file.provider_identity_id
      and conflicting.episode_id=file.episode_id
      and conflicting.parent_series_id is distinct from file.parent_series_id
    ) as unique_parent
    from evaluated file where cardinality(file.languages)>0
  )
  select distinct file.title_id,file.variant_id,code.language
  from unambiguous_files file cross join lateral unnest(file.languages) code(language)
  where file.unique_parent
$f$;
revoke all on function public.cloud_catalog_xtream_series_episode_audio_evidence(uuid,uuid) from public,anon,authenticated;
grant execute on function public.cloud_catalog_xtream_series_episode_audio_evidence(uuid,uuid) to service_role;
comment on function public.cloud_catalog_xtream_series_episode_audio_evidence(uuid,uuid) is
  'Complete owned active canonical episode evidence; named languages occur in observed episodes, not necessarily every episode. Incomplete evidence does not invalidate supplier declarations. No file probing or certification.';

-- The enrolment verifier accepts both legacy and legitimately re-enrolled
-- Selection source IDs. Display names/config_hint never confer ownership.
create function public.cloud_catalog_selection_series_episode_audio_evidence(
  p_user_id uuid,p_source_id uuid
) returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path='' as $f$
  with sources as materialized (
    select source.id from public.cloud_catalog_visible_sources source
    where source.user_id=p_user_id and (p_source_id is null or source.id=p_source_id)
      and public.norva_selection_source_identity_valid(source.id,p_user_id)
  ), parents as materialized (
    select variant.* from sources source
    join public.cloud_catalog_visible_title_variants variant
      on variant.source_id=source.id and variant.user_id=p_user_id
    join public.cloud_source_catalog_heads head
      on head.source_id=variant.source_id and head.user_id=variant.user_id
        and head.active_generation_id=variant.generation_id
    join public.cloud_titles title
      on title.id=variant.title_id and title.user_id=variant.user_id and title.item_type='series'
    where variant.item_type='series'
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
  ), checked_files as materialized (
    select file.*,
      array(select distinct code from (
        select case raw.value when 'yue' then 'yue' else public.norva_canonical_language_code(raw.value) end as code
        from unnest(file.audio_languages) raw(value)
      ) canonical where code is not null order by code) as observation_codes,
      public.cloud_file_track_languages(file.audio_tracks) as file_codes,
      public.cloud_file_track_languages(file.cache_audio_tracks) as cache_codes
    from owned_files file
  ), evaluated as materialized (
    select file.title_id,file.variant_id,
      case when coalesce(public.selection_audio_tracks_complete(file.audio_tracks),false)
        and cardinality(file.observation_codes)>0 and file.observation_codes=file.file_codes
        and not exists(select 1 from unnest(file.audio_languages) raw(value)
          where raw.value is distinct from 'yue' and public.norva_canonical_language_code(raw.value) is null)
        and (file.cache_url_hash is null or file.cache_url_hash=file.current_url_hash)
        and (not coalesce(file.cache_observed,false) or (
          file.cache_codes=file.observation_codes
          and coalesce(public.selection_audio_tracks_complete(file.cache_audio_tracks),false)
          and public.catalog_audio_track_indexes(file.cache_audio_tracks)=public.catalog_audio_track_indexes(file.audio_tracks)
        ))
      then file.observation_codes else '{}'::text[] end as languages
    from checked_files file
  )
  select distinct file.title_id,file.variant_id,code.language
  from evaluated file cross join lateral unnest(file.languages) code(language)
$f$;
revoke all on function public.cloud_catalog_selection_series_episode_audio_evidence(uuid,uuid) from public,anon,authenticated;
grant execute on function public.cloud_catalog_selection_series_episode_audio_evidence(uuid,uuid) to service_role;

-- Keep the deployed helper's public shape: named observed languages only.
create or replace function public.cloud_catalog_selection_series_observed_audio_languages(
  p_user_id uuid,p_source_id uuid
) returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path='' as $f$
  select observed.*
  from public.cloud_catalog_selection_series_episode_audio_evidence(p_user_id,p_source_id) observed
  where observed.language is not null
$f$;
revoke all on function public.cloud_catalog_selection_series_observed_audio_languages(uuid,uuid) from public,anon,authenticated;
grant execute on function public.cloud_catalog_selection_series_observed_audio_languages(uuid,uuid) to service_role;

create or replace function public.cloud_catalog_effective_audio_languages(
  p_user_id uuid,p_item_type text,p_source_id uuid,p_language text
) returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path='' as $f$
  with codes as materialized (
    select raw_code,case raw_code when 'yue' then 'yue' else public.norva_canonical_language_code(raw_code) end as code
    from (select distinct unnest(audio_languages) as raw_code
      from public.cloud_title_file_language_observations where user_id=p_user_id and audio_observed) raw
  ), scoped_variants as materialized (
    select variant.id,variant.title_id,variant.user_id,variant.source_id,
      variant.generation_id,variant.external_id,variant.item_type
    from public.cloud_catalog_visible_title_variants variant
    where variant.user_id=p_user_id and variant.item_type=p_item_type
      and p_item_type='series'
      and (p_source_id is null or variant.source_id=p_source_id)
  ), direct_observed as materialized (
    -- Evaluate exact-file ownership and numeric episode collisions once. Keep
    -- all languages here: filtering them before hint precedence revives stale
    -- declarations when the requested language is absent from observed audio.
    select variant.title_id,variant.id as variant_id,codes.code as language
    from public.cloud_title_file_language_observations observation
    join scoped_variants variant
      on variant.user_id=observation.user_id and variant.title_id=observation.title_id
        and variant.id=observation.variant_id and variant.external_id=observation.file_external_id
    cross join lateral unnest(observation.audio_languages) language(value)
    join codes on codes.raw_code=language.value and codes.code is not null
    where observation.user_id=p_user_id and observation.audio_observed
      and (variant.item_type='movie' or not exists (
        select 1 from public.catalog_series_episode_memberships membership
        join public.catalog_source_provider_identities identity
          on identity.source_id=membership.source_id and identity.user_id=membership.user_id
            and identity.identity_id=membership.provider_identity_id and identity.verified_at is not null
        where membership.user_id=variant.user_id and membership.source_id=variant.source_id
          and membership.generation_id=variant.generation_id
          and membership.parent_title_id=variant.title_id and membership.parent_variant_id=variant.id
          and membership.parent_series_id=variant.external_id and membership.parent_item_type='series'
          and membership.episode_id=observation.file_external_id
      ))
  ), direct_observed_variants as materialized (
    select distinct observed.title_id,observed.variant_id from direct_observed observed
  ), series_observed as materialized (
    select observed.*
    from public.cloud_catalog_selection_series_episode_audio_evidence(p_user_id,p_source_id) observed
    where p_item_type='series'
    union all
    select observed.*
    from public.cloud_catalog_xtream_series_episode_audio_evidence(p_user_id,p_source_id) observed
    where p_item_type='series'
  ), series_observed_variants as materialized (
    -- Languages are irrelevant to hint precedence. One row per variant avoids
    -- rescanning every observed language for every provider hint.
    select distinct observed.title_id,observed.variant_id from series_observed observed
  )
  select effective.* from (
    select direct.title_id,direct.variant_id,direct.language
    from direct_observed direct
    left join series_observed_variants observed
      on observed.title_id=direct.title_id and observed.variant_id=direct.variant_id
    where observed.variant_id is null and (p_language is null or direct.language=p_language)
    union all
    select observed.title_id,observed.variant_id,observed.language
    from series_observed observed
    where observed.language is not null and (p_language is null or observed.language=p_language)
    union all
    select variant.title_id,variant.id,case hint.language when 'fil' then 'tl' else hint.language end
    from public.cloud_catalog_provider_language_hints hint
    join scoped_variants variant
      on variant.id=hint.variant_id and variant.user_id=hint.user_id and variant.title_id=hint.title_id and variant.source_id=hint.source_id
    left join direct_observed_variants direct
      on direct.title_id=variant.title_id and direct.variant_id=variant.id
    left join series_observed_variants observed
      on observed.title_id=variant.title_id and observed.variant_id=variant.id
    where hint.user_id=p_user_id and hint.item_type=p_item_type and variant.item_type=p_item_type
      and p_item_type in ('movie','series') and (p_source_id is null or hint.source_id=p_source_id)
      and (p_language is null or hint.language=p_language or (p_language='tl' and hint.language='fil'))
      -- Deliberately unfiltered by requested language: a conflicting hint must
      -- not reappear when querying a language absent from observed episodes.
      and direct.variant_id is null and observed.variant_id is null
    union all
    -- Preserve the deployed movie access path without materializing its whole
    -- catalogue. Episode projection and its memoization apply only to series.
    select variant.title_id,variant.id,codes.code
    from public.cloud_title_file_language_observations observation
    join public.cloud_catalog_visible_title_variants variant
      on variant.user_id=observation.user_id and variant.title_id=observation.title_id and variant.id=observation.variant_id
        and variant.external_id=observation.file_external_id
    cross join lateral unnest(observation.audio_languages) language(value)
    join codes on codes.raw_code=language.value
    where p_item_type='movie' and observation.user_id=p_user_id and observation.audio_observed
      and codes.code is not null and (p_language is null or codes.code=p_language)
      and variant.item_type=p_item_type
      and (p_source_id is null or variant.source_id=p_source_id)
    union all
    select variant.title_id,variant.id,case hint.language when 'fil' then 'tl' else hint.language end
    from public.cloud_catalog_provider_language_hints hint
    join public.cloud_catalog_visible_title_variants variant
      on variant.id=hint.variant_id and variant.user_id=hint.user_id and variant.title_id=hint.title_id and variant.source_id=hint.source_id
    where p_item_type='movie' and hint.user_id=p_user_id and hint.item_type=p_item_type and variant.item_type=p_item_type
      and (p_source_id is null or hint.source_id=p_source_id)
      and (p_language is null or hint.language=p_language or (p_language='tl' and hint.language='fil'))
      and not exists(select 1 from public.cloud_title_file_language_observations observation
        cross join lateral unnest(observation.audio_languages) language(value)
        join codes on codes.raw_code=language.value and codes.code is not null
        where observation.user_id=hint.user_id and observation.title_id=hint.title_id and observation.variant_id=hint.variant_id
          and observation.file_external_id=variant.external_id and observation.audio_observed)
  ) effective(title_id,variant_id,language)
  join public.cloud_titles title on title.id=effective.title_id and title.user_id=p_user_id and title.item_type=p_item_type
$f$;
revoke all on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text) to service_role;

notify pgrst,'reload schema';
commit;
