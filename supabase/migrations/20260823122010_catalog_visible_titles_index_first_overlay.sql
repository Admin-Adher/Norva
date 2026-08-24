begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Runtime rollups remain generation/head aware, but payload predicates must be
-- applied before this function is called.  ROWS 1 is exact and prevents the
-- planner from multiplying title cardinality by the default SRF estimate.
create or replace function public.norva_visible_catalog_title_runtime(
  p_title_id uuid,
  p_user_id uuid
) returns table (
  best_variant_id uuid,
  best_generation_id uuid,
  display_generation_id uuid,
  variant_count integer,
  last_observed_ttff_ms integer,
  version_languages text[],
  whisper_attempted_at timestamptz,
  visible_source_ids uuid[],
  file_audio_languages text[],
  file_subtitle_languages text[],
  file_audio_verified_languages text[],
  audio_probed_at timestamptz,
  subtitle_probed_at timestamptz,
  audio_lang_verified_at timestamptz
)
language sql
stable
rows 1
security invoker
set search_path = ''
as $function$
  select
    best_variant.id,
    best_variant.generation_id,
    display_owner.generation_id,
    visible_rollup.variant_count,
    best_variant.last_observed_ttff_ms,
    visible_rollup.version_languages,
    visible_rollup.whisper_attempted_at,
    visible_rollup.visible_source_ids,
    coalesce(file_languages.file_audio_languages, '{}'::text[]),
    coalesce(file_languages.file_subtitle_languages, '{}'::text[]),
    coalesce(file_languages.file_audio_verified_languages, '{}'::text[]),
    file_languages.audio_probed_at,
    file_languages.subtitle_probed_at,
    file_languages.audio_lang_verified_at
  from lateral (
    select
      count(*)::integer as variant_count,
      array_agg(distinct variant.source_id order by variant.source_id)
        as visible_source_ids,
      coalesce(
        array_agg(
          distinct lower(btrim(variant.language))
          order by lower(btrim(variant.language))
        ) filter (where nullif(btrim(variant.language), '') is not null),
        '{}'::text[]
      ) as version_languages,
      max(variant.audio_whisper_attempted_at) as whisper_attempted_at
    from public.cloud_catalog_visible_title_variants variant
    where variant.title_id = p_title_id and variant.user_id = p_user_id
  ) visible_rollup
  join lateral (
    select
      variant.id,
      variant.generation_id,
      variant.last_observed_ttff_ms
    from public.cloud_catalog_visible_title_variants variant
    where variant.title_id = p_title_id and variant.user_id = p_user_id
    order by
      variant.playback_cost_score asc,
      variant.last_observed_ttff_ms asc nulls last,
      variant.created_at desc,
      variant.id asc
    limit 1
  ) best_variant on true
  join lateral (
    select variant.generation_id
    from public.cloud_catalog_visible_title_variants variant
    where variant.title_id = p_title_id and variant.user_id = p_user_id
    order by variant.source_id, variant.generation_id nulls first, variant.id
    limit 1
  ) display_owner on true
  left join lateral (
    select
      coalesce(array_agg(distinct language_code order by language_code)
        filter (where facet = 'audio'), '{}'::text[])
        as file_audio_languages,
      coalesce(array_agg(distinct language_code order by language_code)
        filter (where facet = 'subtitle'), '{}'::text[])
        as file_subtitle_languages,
      coalesce(array_agg(distinct language_code order by language_code)
        filter (where facet = 'verified_audio'), '{}'::text[])
        as file_audio_verified_languages,
      max(observed_at) filter (where facet = 'audio') as audio_probed_at,
      max(observed_at) filter (where facet = 'subtitle') as subtitle_probed_at,
      max(verified_at) filter (where facet = 'verified_audio')
        as audio_lang_verified_at
    from (
      select
        'audio'::text as facet,
        lower(language_code) as language_code,
        observation.updated_at as observed_at,
        null::timestamptz as verified_at
      from public.cloud_catalog_visible_title_variants variant
      join public.cloud_title_file_language_observations observation
        on observation.user_id = variant.user_id
       and observation.title_id = variant.title_id
       and observation.variant_id = variant.id
       and observation.audio_observed
      cross join lateral unnest(observation.audio_languages) language_code
      where variant.title_id = p_title_id and variant.user_id = p_user_id

      union all

      select
        'subtitle'::text,
        lower(language_code),
        observation.updated_at,
        null::timestamptz
      from public.cloud_catalog_visible_title_variants variant
      join public.cloud_title_file_language_observations observation
        on observation.user_id = variant.user_id
       and observation.title_id = variant.title_id
       and observation.variant_id = variant.id
       and observation.subtitle_observed
      cross join lateral unnest(observation.subtitle_languages) language_code
      where variant.title_id = p_title_id and variant.user_id = p_user_id

      union all

      select
        'verified_audio'::text,
        lower(language_code),
        observation.updated_at,
        observation.audio_verified_at
      from public.cloud_catalog_visible_title_variants variant
      join public.cloud_title_file_language_observations observation
        on observation.user_id = variant.user_id
       and observation.title_id = variant.title_id
       and observation.variant_id = variant.id
       and observation.audio_observed
       and observation.audio_verified_at is not null
      cross join lateral unnest(observation.audio_languages) language_code
      where variant.title_id = p_title_id and variant.user_id = p_user_id
    ) exact_language
    where language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
  ) file_languages on true
  where visible_rollup.variant_count > 0
$function$;

revoke all on function public.norva_visible_catalog_title_runtime(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.norva_visible_catalog_title_runtime(uuid, uuid)
to service_role;

-- Branch-local ordering is intentional.  It exposes one ordered index path per
-- direct-column payload branch, so an outer PostgREST ORDER/LIMIT becomes a
-- Merge Append and stops after the requested rows.  Without these branch
-- pathkeys PostgreSQL hydrates every matching title, then performs a top Sort.
create or replace view public.cloud_catalog_visible_titles
with (security_invoker = true, security_barrier = true)
as
(
  select
    title.id,
    projection.user_id,
    projection.item_type,
    projection.identity_key,
    projection.identity_source,
    projection.provider_tmdb_id,
    projection.provider_imdb_id,
    projection.match_status,
    projection.title,
    projection.original_title,
    projection.release_year,
    projection.poster_url,
    projection.backdrop_url,
    projection.metadata,
    runtime.best_variant_id as default_variant_id,
    runtime.variant_count,
    runtime.last_observed_ttff_ms,
    projection.synced_at,
    projection.catalog_created_at as created_at,
    projection.updated_at,
    runtime.version_languages,
    runtime.file_audio_languages as audio_languages,
    runtime.audio_probed_at,
    null::jsonb as audio_tracks,
    projection.genre_category,
    projection.genre_payload,
    '[]'::jsonb as subtitle_tracks,
    runtime.subtitle_probed_at,
    runtime.whisper_attempted_at,
    projection.year_backfill_attempted_at,
    projection.revalidate_attempted_at,
    projection.search_match_attempted_at,
    runtime.audio_lang_verified_at,
    projection.genre_buckets,
    projection.rating_num,
    runtime.file_audio_languages,
    runtime.file_subtitle_languages,
    runtime.file_audio_verified_languages,
    runtime.visible_source_ids,
    (projection.poster_url is not null) as has_poster
  from public.cloud_source_catalog_generation_candidate_titles projection
  join public.cloud_titles title
    on title.id = projection.title_id and title.user_id = projection.user_id
  cross join lateral public.norva_visible_catalog_title_runtime(
    title.id, title.user_id
  ) runtime
  where projection.generation_id = runtime.display_generation_id
  order by projection.synced_at desc, projection.updated_at desc
)

union all

(
  select
    title.id,
    title.user_id,
    title.item_type,
    title.identity_key,
    title.identity_source,
    title.provider_tmdb_id,
    title.provider_imdb_id,
    title.match_status,
    title.title,
    title.original_title,
    title.release_year,
    title.poster_url,
    title.backdrop_url,
    title.metadata,
    runtime.best_variant_id as default_variant_id,
    runtime.variant_count,
    runtime.last_observed_ttff_ms,
    title.synced_at,
    title.created_at,
    title.updated_at,
    runtime.version_languages,
    runtime.file_audio_languages as audio_languages,
    runtime.audio_probed_at,
    null::jsonb as audio_tracks,
    title.genre_category,
    title.genre_payload,
    '[]'::jsonb as subtitle_tracks,
    runtime.subtitle_probed_at,
    runtime.whisper_attempted_at,
    title.year_backfill_attempted_at,
    title.revalidate_attempted_at,
    title.search_match_attempted_at,
    runtime.audio_lang_verified_at,
    title.genre_buckets,
    title.rating_num,
    runtime.file_audio_languages,
    runtime.file_subtitle_languages,
    runtime.file_audio_verified_languages,
    runtime.visible_source_ids,
    (title.poster_url is not null) as has_poster
  from public.cloud_titles title
  cross join lateral public.norva_visible_catalog_title_runtime(
    title.id, title.user_id
  ) runtime
  where not exists (
    select 1
    from public.cloud_source_catalog_generation_candidate_titles projection
    where projection.title_id = title.id
      and projection.user_id = title.user_id
      and projection.generation_id = runtime.display_generation_id
  )
  order by title.synced_at desc, title.updated_at desc
);

drop function if exists public.norva_visible_catalog_title_projection(
  uuid, uuid, uuid
);

do $assert$
declare
  v_options text[];
  v_definition text;
  v_runtime_rows real;
  v_runtime_security_definer boolean;
begin
  select class.reloptions, lower(pg_get_viewdef(class.oid, true))
    into v_options, v_definition
  from pg_class class
  join pg_namespace namespace on namespace.oid = class.relnamespace
  where namespace.nspname = 'public'
    and class.relname = 'cloud_catalog_visible_titles'
    and class.relkind = 'v';
  select procedure_state.prorows, procedure_state.prosecdef
    into v_runtime_rows, v_runtime_security_definer
  from pg_proc procedure_state
  where procedure_state.oid =
    'public.norva_visible_catalog_title_runtime(uuid,uuid)'::regprocedure;

  if not found
     or not coalesce(v_options @> array['security_invoker=true'], false)
     or not coalesce(v_options @> array['security_barrier=true'], false)
     or position('union all' in v_definition) = 0
     or position('order by projection.synced_at desc' in v_definition) = 0
     or position('order by title.synced_at desc' in v_definition) = 0
     or position('norva_visible_catalog_title_runtime' in v_definition) = 0
     or position('promoted_at' in v_definition) <> 0
     or position('promotion.phase' in v_definition) <> 0
     or position('norva_visible_catalog_title_projection' in v_definition) <> 0
     or v_runtime_rows is distinct from 1::real
     or coalesce(v_runtime_security_definer, true)
     or not public.norva_catalog_title_projection_indexes_ready()
     or not has_function_privilege(
       'service_role',
       'public.norva_visible_catalog_title_runtime(uuid,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.norva_visible_catalog_title_runtime(uuid,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.norva_visible_catalog_title_runtime(uuid,uuid)',
       'EXECUTE'
     ) then
    raise exception 'cloud_catalog_visible_titles index-first overlay drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
