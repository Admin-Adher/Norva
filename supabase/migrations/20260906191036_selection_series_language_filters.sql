begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- The imported parent preserves the explicit language group of its files.
-- Keep these declarations separate from observed audio and subtitle tracks.
create or replace function public.selection_provider_audio_language(p_metadata jsonb, p_external_id text)
returns text language sql immutable security invoker set search_path = '' as $function$
  select case split_part(p_metadata ->> 'selectionVodGroup', ' / ', 2)
    when 'Telugu' then 'te' when 'Tamil' then 'ta' when 'Malayalam' then 'ml'
    when 'Hindi' then 'hi' when 'Kannada' then 'kn' when 'English' then 'en'
  end
  where p_external_id ~ '^norva-selection:(movie|series):[a-f0-9]{64}$'
    and p_metadata ->> 'selectionRevision' = 'selection-vod-20260906-v1'
    and p_metadata ->> 'discoveryFeed' = 'babuperumana-vod'
    and p_metadata ->> 'selectionVodGroup' ~ '^Movies / (Telugu|Tamil|Malayalam|Hindi|Kannada|English)( / (19|20)[0-9]{2})?$'
$function$;
revoke all on function public.selection_provider_audio_language(jsonb, text) from public, anon, authenticated;
grant execute on function public.selection_provider_audio_language(jsonb, text) to service_role;

-- A required fourth parameter keeps the three-argument movie RPC compatible
-- while the Edge replicas roll forward. No ambiguous defaulted overload.
create or replace function public.cloud_selection_audio_catalog_counts(
  p_user_id uuid, p_selection_source_id uuid, p_source_id uuid, p_item_type text
) returns jsonb language sql stable security invoker set search_path = '' as $function$
  with declarations as materialized (
    select variant.title_id,
      public.selection_provider_audio_language(variant.metadata, variant.external_id) as language
    from public.cloud_catalog_visible_title_variants variant
    where variant.user_id = p_user_id and variant.source_id = p_selection_source_id
      and (p_source_id is null or variant.source_id = p_source_id)
      and variant.item_type = p_item_type and p_item_type in ('movie', 'series')
      and not exists (
        select 1 from public.cloud_title_file_language_observations observation
        where observation.user_id = variant.user_id and observation.title_id = variant.title_id
          and observation.variant_id = variant.id
          and observation.audio_observed and cardinality(observation.audio_languages) > 0
      )
  ), languages as materialized (
    select distinct language from declarations where language is not null
  ), combined as (
    select language, title_id from declarations where language is not null
    union
    select language.language, variant.title_id
    from languages language
    join public.cloud_title_file_language_observations observation
      on observation.user_id = p_user_id and observation.audio_observed
      and language.language = any(observation.audio_languages)
    join public.cloud_catalog_visible_title_variants variant
      on variant.user_id = observation.user_id and variant.title_id = observation.title_id
      and variant.id = observation.variant_id and variant.item_type = p_item_type
    where p_source_id is null or variant.source_id = p_source_id
  ), counts as (
    select language, count(distinct title_id) as count from combined group by language
  )
  select coalesce(jsonb_object_agg(language, count), '{}'::jsonb) from counts
$function$;
revoke all on function public.cloud_selection_audio_catalog_counts(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cloud_selection_audio_catalog_counts(uuid, uuid, uuid, text) to service_role;

create or replace function public.cloud_catalog_visible_title_ids_by_source_languages(
  p_user_id uuid, p_item_type text, p_source_id uuid,
  p_audio_language text default null, p_subtitle_language text default null
) returns table(title_id uuid)
language sql stable security invoker set search_path = '' as $function$
  select distinct variant.title_id
  from public.cloud_catalog_visible_title_variants variant
  where variant.user_id = p_user_id
    and (p_source_id is null or variant.source_id = p_source_id)
    and variant.item_type = p_item_type and p_item_type in ('movie', 'series')
    and (
      p_source_id is null or public.norva_source_catalog_visible(p_source_id, p_user_id)
      -- Selection has no credential lifecycle. These rows have already passed
      -- the visible-variant view, including ownership and generation checks.
      or (regexp_replace(lower(btrim(p_audio_language)), '^catalog-', 'provider-') =
        'provider-' || public.selection_provider_audio_language(variant.metadata, variant.external_id))
    )
    and (
      nullif(lower(btrim(p_audio_language)), '') is null
      or exists (
        select 1 from public.cloud_title_file_language_observations observation
        where observation.user_id = variant.user_id and observation.title_id = variant.title_id
          and observation.variant_id = variant.id and observation.audio_observed
          and nullif(regexp_replace(lower(btrim(p_audio_language)), '^catalog-', ''), '') = any(observation.audio_languages)
      )
      or (
        regexp_replace(lower(btrim(p_audio_language)), '^catalog-', 'provider-') =
          'provider-' || public.selection_provider_audio_language(variant.metadata, variant.external_id)
        and not exists (
          select 1 from public.cloud_title_file_language_observations observation
          where observation.user_id = variant.user_id and observation.title_id = variant.title_id
            and observation.variant_id = variant.id
            and observation.audio_observed and cardinality(observation.audio_languages) > 0
        )
      )
    )
    and (
      nullif(lower(btrim(p_subtitle_language)), '') is null
      or exists (
        select 1 from public.cloud_title_file_language_observations observation
        where observation.user_id = variant.user_id and observation.title_id = variant.title_id
          and observation.variant_id = variant.id and observation.subtitle_observed
          and nullif(lower(btrim(p_subtitle_language)), '') = any(observation.subtitle_languages)
      )
    )
$function$;
revoke all on function public.cloud_catalog_visible_title_ids_by_source_languages(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.cloud_catalog_visible_title_ids_by_source_languages(uuid, text, uuid, text, text) to service_role;

notify pgrst, 'reload schema';
commit;
