begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Source-scoped language filters used to return every matching title id to the
-- Edge runtime (5k-10k ids on real catalogues), which then issued one
-- PostgREST request per 50 ids merely to recover sort keys.  The sequential
-- fan-out regularly exceeded the Edge wall-clock limit and left Movies/Series
-- on an empty bucket grid.  Keep visibility and exact-file language evidence
-- in the database, select only the requested page, and return a small JSONB
-- contract to Edge.
create or replace function public.cloud_catalog_visible_title_language_page(
  p_user_id uuid,
  p_item_type text,
  p_source_id uuid,
  p_filters jsonb default '{}'::jsonb
) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with parameters as materialized (
    select
      nullif(lower(btrim(p_filters ->> 'audio')), '') as audio_language,
      nullif(lower(btrim(p_filters ->> 'subtitle')), '') as subtitle_language,
      coalesce(
        array(
          select lower(btrim(value))
          from jsonb_array_elements_text(
            case when jsonb_typeof(p_filters -> 'buckets') = 'array'
              then p_filters -> 'buckets'
              else '[]'::jsonb
            end
          ) value
          where nullif(btrim(value), '') is not null
        ),
        '{}'::text[]
      ) as genre_buckets,
      coalesce(
        array(
          select lower(btrim(value))
          from jsonb_array_elements_text(
            case when jsonb_typeof(p_filters -> 'hiddenBuckets') = 'array'
              then p_filters -> 'hiddenBuckets'
              else '[]'::jsonb
            end
          ) value
          where nullif(btrim(value), '') is not null
        ),
        '{}'::text[]
      ) as hidden_genre_buckets,
      nullif(btrim(p_filters ->> 'search'), '') as search_text,
      case when coalesce(p_filters ->> 'yearMin', '') ~ '^[0-9]{4}$'
        then (p_filters ->> 'yearMin')::integer end as year_min,
      case when coalesce(p_filters ->> 'yearMax', '') ~ '^[0-9]{4}$'
        then (p_filters ->> 'yearMax')::integer end as year_max,
      case when coalesce(p_filters ->> 'minRating', '') ~ '^[0-9]+(?:\.[0-9]+)?$'
        then (p_filters ->> 'minRating')::numeric end as min_rating,
      case when coalesce(p_filters ->> 'addedAfter', '') <> ''
        then (p_filters ->> 'addedAfter')::timestamptz end as added_after,
      case p_filters ->> 'sort'
        when 'added' then 'added'
        when 'rating' then 'rating'
        when 'year' then 'year'
        when 'year-asc' then 'year-asc'
        when 'name' then 'name'
        when 'lang-match' then 'lang-match'
        else 'default'
      end as sort_key,
      nullif(lower(btrim(p_filters ->> 'prefAudio')), '') as preferred_audio,
      nullif(lower(btrim(p_filters ->> 'prefSubtitle')), '') as preferred_subtitle,
      greatest(100, least(coalesce((p_filters ->> 'candidateLimit')::integer, 6000), 8000))
        as candidate_limit,
      greatest(1, least(coalesce((p_filters ->> 'limit')::integer, 36), 100)) as page_limit,
      greatest(0, least(coalesce((p_filters ->> 'offset')::integer, 0), 1000000)) as page_offset
  ),
  language_title_ids as materialized (
    select title_id
    from public.cloud_catalog_visible_title_ids_by_source_languages(
      p_user_id,
      p_item_type,
      p_source_id,
      (select audio_language from parameters),
      (select subtitle_language from parameters)
    )
  ),
  display_owners as materialized (
    select distinct on (variant.title_id)
      variant.title_id,
      variant.generation_id
    from public.cloud_catalog_visible_title_variants variant
    join language_title_ids language_title
      on language_title.title_id = variant.title_id
    where variant.user_id = p_user_id
    order by
      variant.title_id,
      variant.source_id,
      variant.generation_id nulls first,
      variant.id
  ),
  effective_titles as materialized (
    select
      title.id,
      case when projection.title_id is not null
        then projection.title else title.title end as title,
      case when projection.title_id is not null
        then projection.release_year else title.release_year end as release_year,
      (case when projection.title_id is not null
        then projection.poster_url else title.poster_url end) is not null as has_poster,
      coalesce(
        case when projection.title_id is not null
          then projection.genre_buckets else title.genre_buckets end,
        array['autres']::text[]
      ) as genre_buckets,
      case when projection.title_id is not null
        then projection.rating_num else title.rating_num end as rating_num,
      case when projection.title_id is not null
        then projection.catalog_created_at else title.created_at end as created_at
    from language_title_ids language_title
    join display_owners display_owner using (title_id)
    join public.cloud_titles title
      on title.id = language_title.title_id
     and title.user_id = p_user_id
     and title.item_type = p_item_type
    left join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.user_id = title.user_id
     and projection.title_id = title.id
     and projection.generation_id = display_owner.generation_id
  ),
  filtered_titles as materialized (
    select title.*
    from effective_titles title
    cross join parameters parameter
    where p_item_type in ('movie', 'series')
      and (
        cardinality(parameter.genre_buckets) = 0
        or title.genre_buckets && parameter.genre_buckets
      )
  ),
  fully_filtered_titles as materialized (
    select title.*
    from filtered_titles title
    cross join parameters parameter
    where (cardinality(parameter.hidden_genre_buckets) = 0
      or not (title.genre_buckets && parameter.hidden_genre_buckets))
      and (parameter.search_text is null
        or title.title ilike '%' || parameter.search_text || '%')
      and (parameter.year_min is null or title.release_year >= parameter.year_min)
      and (parameter.year_max is null or title.release_year <= parameter.year_max)
      and (parameter.min_rating is null or title.rating_num >= parameter.min_rating)
      and (parameter.added_after is null or title.created_at >= parameter.added_after)
  ),
  candidates as materialized (
    select title.*
    from fully_filtered_titles title
    order by title.created_at desc nulls last, title.id
    limit (
      select case when parameter.sort_key = 'lang-match'
        then parameter.candidate_limit
        else 2147483647
      end
      from parameters parameter
    )
  ),
  ranked as materialized (
    select
      candidate.*,
      case when parameter.sort_key = 'lang-match' then
        case when parameter.preferred_audio is not null and exists (
          select 1
          from public.cloud_catalog_visible_title_variants variant
          join public.cloud_title_file_language_observations observation
            on observation.user_id = variant.user_id
           and observation.title_id = variant.title_id
           and observation.variant_id = variant.id
           and observation.audio_observed
          where variant.user_id = p_user_id
            and variant.source_id = p_source_id
            and variant.title_id = candidate.id
            and parameter.preferred_audio = any(observation.audio_languages)
        ) then 2 else 0 end
        + case when parameter.preferred_subtitle is not null and exists (
          select 1
          from public.cloud_catalog_visible_title_variants variant
          join public.cloud_title_file_language_observations observation
            on observation.user_id = variant.user_id
           and observation.title_id = variant.title_id
           and observation.variant_id = variant.id
           and observation.subtitle_observed
          where variant.user_id = p_user_id
            and variant.source_id = p_source_id
            and variant.title_id = candidate.id
            and parameter.preferred_subtitle = any(observation.subtitle_languages)
        ) then 1 else 0 end
      else 0 end as language_rank
    from candidates candidate
    cross join parameters parameter
  ),
  ordered as materialized (
    select
      title.id,
      row_number() over (
        order by
          case when parameter.sort_key = 'lang-match' then title.language_rank end desc nulls last,
          case when parameter.sort_key = 'default' then title.has_poster end desc nulls last,
          case when parameter.sort_key in ('default', 'added', 'lang-match')
            then title.created_at end desc nulls last,
          case when parameter.sort_key = 'rating' then title.rating_num end desc nulls last,
          case when parameter.sort_key = 'year' then title.release_year end desc nulls last,
          case when parameter.sort_key = 'year-asc' then title.release_year end asc nulls last,
          case when parameter.sort_key = 'name' then title.title end asc nulls last,
          title.id
      ) as ordinal
    from ranked title
    cross join parameters parameter
  ),
  page as materialized (
    select ordered.*
    from ordered
    order by ordered.ordinal
    limit (select parameter.page_limit from parameters parameter)
    offset (select parameter.page_offset from parameters parameter)
  )
  select jsonb_build_object(
    'titleIds', coalesce(
      (select jsonb_agg(page.id order by page.ordinal) from page),
      '[]'::jsonb
    ),
    'count', (select count(*) from ranked)
  )
$function$;

revoke all on function public.cloud_catalog_visible_title_language_page(
  uuid, text, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.cloud_catalog_visible_title_language_page(
  uuid, text, uuid, jsonb
) to service_role;

comment on function public.cloud_catalog_visible_title_language_page(
  uuid, text, uuid, jsonb
) is 'Bounded source-language title pagination for Movies/Series; keeps visibility, exact file evidence, filtering, count and ordering inside one SQL request.';

do $assert$
declare
  v_security_definer boolean;
  v_config text[];
begin
  select procedure_state.prosecdef, procedure_state.proconfig
    into v_security_definer, v_config
  from pg_proc procedure_state
  where procedure_state.oid =
    'public.cloud_catalog_visible_title_language_page(uuid,text,uuid,jsonb)'::regprocedure;

  if not found
     or coalesce(v_security_definer, true)
     or not ('search_path=""' = any(coalesce(v_config, '{}'::text[])))
     or not has_function_privilege(
       'service_role',
       'public.cloud_catalog_visible_title_language_page(uuid,text,uuid,jsonb)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.cloud_catalog_visible_title_language_page(uuid,text,uuid,jsonb)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.cloud_catalog_visible_title_language_page(uuid,text,uuid,jsonb)',
       'EXECUTE'
     ) then
    raise exception 'cloud catalog visible title language page contract drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
