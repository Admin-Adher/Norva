begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- A freshly invalidated facet summary must not send the public endpoint back
-- through cloud_catalog_visible_titles.  That compatibility view performs
-- several per-title lateral rollups and timed out on the real all-source
-- catalogue while the same exact set can be read directly from visible
-- variants plus the normalized file-language observation table.
--
-- Keep the fresh O(1) summary fast path.  On a missing/stale summary, scan the
-- user's visible variants once, scan the user's exact observations once, then
-- hash the two bounded sets together.  Audio and subtitle completion remain
-- independent and counts remain distinct by title across all visible sources.
create or replace function public.cloud_exact_language_counts(
  p_user_id uuid,
  p_item_type text
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_audio_counts jsonb;
  v_sub_counts jsonb;
begin
  if p_user_id is null or p_item_type not in ('movie', 'series') then
    raise exception 'invalid exact language facet arguments'
      using errcode = '22023';
  end if;

  select summary.audio_lang_counts, summary.subtitle_lang_counts
    into v_audio_counts, v_sub_counts
  from public.cloud_catalog_facet_summary summary
  where summary.user_id = p_user_id
    and summary.item_type = p_item_type
    and summary.refreshed_at >= now() - interval '60 minutes';

  if not found then
    with visible_variants as materialized (
      select variant.id, variant.title_id, variant.user_id
      from public.cloud_catalog_visible_title_variants variant
      where variant.user_id = p_user_id
        and variant.item_type = p_item_type
    ), user_observations as materialized (
      select
        observation.user_id,
        observation.title_id,
        observation.variant_id,
        observation.audio_observed,
        observation.audio_languages,
        observation.subtitle_observed,
        observation.subtitle_languages
      from public.cloud_title_file_language_observations observation
      where observation.user_id = p_user_id
        and (observation.audio_observed or observation.subtitle_observed)
    ), exact_observations as materialized (
      select
        variant.title_id,
        observation.audio_observed,
        observation.audio_languages,
        observation.subtitle_observed,
        observation.subtitle_languages
      from visible_variants variant
      join user_observations observation
        on observation.user_id = variant.user_id
       and observation.title_id = variant.title_id
       and observation.variant_id = variant.id
    ), exact_languages as materialized (
      select
        observation.title_id,
        lower(language_code) as language_code,
        'audio'::text as facet
      from exact_observations observation
      cross join lateral unnest(observation.audio_languages) language_code
      where observation.audio_observed

      union all

      select
        observation.title_id,
        lower(language_code) as language_code,
        'subtitles'::text as facet
      from exact_observations observation
      cross join lateral unnest(observation.subtitle_languages) language_code
      where observation.subtitle_observed
    ), counts as (
      select
        facet,
        language_code,
        count(distinct title_id)::bigint as title_count
      from exact_languages
      where language_code ~ '^[a-z]{2,3}$'
        and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
      group by facet, language_code
    )
    select
      coalesce(
        jsonb_object_agg(language_code, title_count)
          filter (where facet = 'audio'),
        '{}'::jsonb
      ),
      coalesce(
        jsonb_object_agg(language_code, title_count)
          filter (where facet = 'subtitles'),
        '{}'::jsonb
      )
      into v_audio_counts, v_sub_counts
    from counts;
  end if;

  return jsonb_build_object(
    'audio', coalesce(v_audio_counts, '{}'::jsonb),
    'subtitles', coalesce(v_sub_counts, '{}'::jsonb)
  );
end
$function$;

revoke all on function public.cloud_exact_language_counts(uuid, text)
  from public, anon, authenticated;
grant execute on function public.cloud_exact_language_counts(uuid, text)
  to service_role;

comment on function public.cloud_exact_language_counts(uuid, text) is
  'Exact all-source file-language title counts: fresh summary fast path, then an index-first visible-variant fallback without the compatibility title view.';

do $assert$
declare
  v_definition text := lower(pg_get_functiondef(
    'public.cloud_exact_language_counts(uuid,text)'::regprocedure
  ));
begin
  if position('cloud_catalog_visible_titles title' in v_definition) <> 0
     or position('cloud_catalog_visible_title_variants' in v_definition) = 0
     or position('cloud_title_file_language_observations' in v_definition) = 0
     or position('visible_variants as materialized' in v_definition) = 0
     or position('user_observations as materialized' in v_definition) = 0
     or position('count(distinct title_id)' in v_definition) = 0
     or not has_function_privilege(
       'service_role',
       'public.cloud_exact_language_counts(uuid,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.cloud_exact_language_counts(uuid,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.cloud_exact_language_counts(uuid,text)',
       'EXECUTE'
     ) then
    raise exception 'cloud exact language facet fallback drift'
      using errcode = '55000';
  end if;
end
$assert$;

notify pgrst, 'reload schema';

commit;
