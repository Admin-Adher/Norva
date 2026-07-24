begin;

-- Provider-scoped language facets must be derived from the exact file
-- observations attached to variants owned by that provider. The title-level
-- union intentionally cannot be used here: a grouped title may have French on
-- provider A and English on provider B.
create or replace function public.cloud_exact_language_counts_by_source(
  p_user_id uuid,
  p_item_type text,
  p_source_id uuid
) returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $function$
  with owned_source as (
    select source.id
    from public.cloud_sources source
    where source.id = p_source_id
      and source.user_id = p_user_id
      and source.enabled
      and source.deleted_at is null
  ),
  exact_languages as (
    select
      observation.title_id,
      lower(language_code) as language_code,
      'audio'::text as facet
    from owned_source
    join public.cloud_title_variants variant
      on variant.source_id = owned_source.id
     and variant.user_id = p_user_id
     and variant.item_type = p_item_type
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = variant.user_id
     and title.item_type = p_item_type
     and title.variant_count > 0
    join public.cloud_title_file_language_observations observation
      on observation.user_id = variant.user_id
     and observation.title_id = variant.title_id
     and observation.variant_id = variant.id
     and observation.audio_observed
    cross join lateral unnest(observation.audio_languages) as language_code

    union all

    select
      observation.title_id,
      lower(language_code) as language_code,
      'subtitles'::text as facet
    from owned_source
    join public.cloud_title_variants variant
      on variant.source_id = owned_source.id
     and variant.user_id = p_user_id
     and variant.item_type = p_item_type
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = variant.user_id
     and title.item_type = p_item_type
     and title.variant_count > 0
    join public.cloud_title_file_language_observations observation
      on observation.user_id = variant.user_id
     and observation.title_id = variant.title_id
     and observation.variant_id = variant.id
     and observation.subtitle_observed
    cross join lateral unnest(observation.subtitle_languages) as language_code
  ),
  valid_languages as (
    select title_id, language_code, facet
    from exact_languages
    where language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
  ),
  counts as (
    select
      facet,
      language_code,
      count(distinct title_id)::bigint as title_count
    from valid_languages
    group by facet, language_code
  )
  select jsonb_build_object(
    'audio',
    coalesce(
      jsonb_object_agg(language_code, title_count)
        filter (where facet = 'audio'),
      '{}'::jsonb
    ),
    'subtitles',
    coalesce(
      jsonb_object_agg(language_code, title_count)
        filter (where facet = 'subtitles'),
      '{}'::jsonb
    )
  )
  from counts
$function$;

revoke all on function public.cloud_exact_language_counts_by_source(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.cloud_exact_language_counts_by_source(uuid, text, uuid)
  to service_role;

notify pgrst, 'reload schema';

commit;
