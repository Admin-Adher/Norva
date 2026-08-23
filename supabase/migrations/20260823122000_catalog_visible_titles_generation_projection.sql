begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- A title shell is global to one user/identity, while credential candidates are
-- generation-scoped.  Read the payload belonging to the generation of the
-- selected active-head variant.  A compensating head restore therefore makes
-- the previous payload visible in the same transaction without mutating the
-- global catalogue overlay.
--
-- Keep the overlay as two direct-column UNION ALL branches.  A CASE expression
-- around title.match_status/provider_tmdb_id/release_year/title/updated_at
-- prevents Postgres from pushing PostgREST predicates into the existing
-- cloud_titles indexes and caused mega-account home rails and repair cursors to
-- scan every title.  The projection branch is expected to stay small, but is
-- nevertheless indexed for the same bounded selectors.
create index if not exists cloud_source_candidate_titles_home_verified_idx
  on public.cloud_source_catalog_generation_candidate_titles (
    user_id, item_type, synced_at desc, updated_at desc, title_id
  )
  where match_status = 'provider_verified';

create index if not exists cloud_source_candidate_titles_recent_idx
  on public.cloud_source_catalog_generation_candidate_titles (
    user_id, item_type, catalog_created_at desc, synced_at desc, title_id
  );

-- Generation-leading paths let selectors fan out only across the user's active
-- heads.  A million-row BUILDING generation can therefore never sit in front of
-- the active generation in a user/item/sort index.
create index if not exists cloud_source_candidate_titles_generation_verified_idx
  on public.cloud_source_catalog_generation_candidate_titles (
    generation_id, item_type, synced_at desc, updated_at desc, title_id
  )
  where match_status = 'provider_verified';

create index if not exists cloud_source_candidate_titles_generation_recent_idx
  on public.cloud_source_catalog_generation_candidate_titles (
    generation_id, item_type, catalog_created_at desc, synced_at desc, title_id
  );

create index if not exists cloud_source_candidate_titles_poster_idx
  on public.cloud_source_catalog_generation_candidate_titles (
    user_id, item_type, poster_url desc nulls last,
    catalog_created_at desc, title_id
  );

create index if not exists cloud_source_candidate_titles_year_desc_idx
  on public.cloud_source_catalog_generation_candidate_titles (
    user_id, item_type, release_year desc nulls last, title_id
  );

create index if not exists cloud_source_candidate_titles_year_asc_idx
  on public.cloud_source_catalog_generation_candidate_titles (
    user_id, item_type, release_year asc nulls last, title_id
  );

create index if not exists cloud_source_candidate_titles_name_idx
  on public.cloud_source_catalog_generation_candidate_titles (
    user_id, item_type, title, title_id
  );

create index if not exists cloud_source_candidate_titles_tmdb_idx
  on public.cloud_source_catalog_generation_candidate_titles (
    user_id, item_type, provider_tmdb_id, title_id
  )
  where provider_tmdb_id is not null;

create index if not exists cloud_source_candidate_titles_year_pending_idx
  on public.cloud_source_catalog_generation_candidate_titles (
    user_id, item_type, title_id
  )
  where release_year is null
    and provider_tmdb_id is not null;

revoke all on table
  public.cloud_source_catalog_generation_candidate_titles
from service_role;
grant select (
  generation_id, title_id, user_id, source_id, item_type, identity_key,
  identity_source, provider_tmdb_id, provider_imdb_id, match_status, title,
  original_title, release_year, poster_url, backdrop_url, metadata,
  genre_category, genre_payload, genre_buckets, rating_num,
  year_backfill_attempted_at, revalidate_attempted_at,
  search_match_attempted_at, synced_at, catalog_created_at, updated_at
) on table public.cloud_source_catalog_generation_candidate_titles
to service_role;

create or replace function public.norva_catalog_title_projection_indexes_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    public.norva_catalog_title_projection_index_is_exact(
      'idx_cloud_titles_projection_verified',
      'public.cloud_titles',
      array['user_id','item_type','synced_at','updated_at','id'],
      array[0,0,3,3,0]::smallint[],
      '(match_status = ''provider_verified''::text)',
      true
    )
    and public.norva_catalog_title_projection_index_is_exact(
      'idx_cloud_titles_projection_recent',
      'public.cloud_titles',
      array['user_id','item_type','created_at','synced_at','id'],
      array[0,0,3,3,0]::smallint[],
      null,
      true
    )
    and public.norva_catalog_title_projection_index_is_exact(
      'cloud_source_candidate_titles_generation_verified_idx',
      'public.cloud_source_catalog_generation_candidate_titles',
      array['generation_id','item_type','synced_at','updated_at','title_id'],
      array[0,0,3,3,0]::smallint[],
      '(match_status = ''provider_verified''::text)',
      true
    )
    and public.norva_catalog_title_projection_index_is_exact(
      'cloud_source_candidate_titles_generation_recent_idx',
      'public.cloud_source_catalog_generation_candidate_titles',
      array['generation_id','item_type','catalog_created_at','synced_at','title_id'],
      array[0,0,3,3,0]::smallint[],
      null,
      true
    )
    and public.norva_catalog_title_projection_index_is_exact(
      'cloud_source_candidate_titles_home_verified_idx',
      'public.cloud_source_catalog_generation_candidate_titles',
      array['user_id','item_type','synced_at','updated_at','title_id'],
      array[0,0,3,3,0]::smallint[],
      '(match_status = ''provider_verified''::text)',
      true
    )
    and public.norva_catalog_title_projection_index_is_exact(
      'cloud_source_candidate_titles_tmdb_idx',
      'public.cloud_source_catalog_generation_candidate_titles',
      array['user_id','item_type','provider_tmdb_id','title_id'],
      array[0,0,0,0]::smallint[],
      '(provider_tmdb_id IS NOT NULL)',
      true
    )
    and public.norva_catalog_title_projection_index_is_exact(
      'cloud_source_candidate_titles_poster_idx',
      'public.cloud_source_catalog_generation_candidate_titles',
      array['user_id','item_type','poster_url','catalog_created_at','title_id'],
      array[0,0,1,3,0]::smallint[],
      null,
      true
    )
    and public.norva_catalog_title_projection_index_is_exact(
      'cloud_source_candidate_titles_year_desc_idx',
      'public.cloud_source_catalog_generation_candidate_titles',
      array['user_id','item_type','release_year','title_id'],
      array[0,0,1,0]::smallint[],
      null,
      true
    )
    and public.norva_catalog_title_projection_index_is_exact(
      'cloud_source_candidate_titles_year_asc_idx',
      'public.cloud_source_catalog_generation_candidate_titles',
      array['user_id','item_type','release_year','title_id'],
      array[0,0,0,0]::smallint[],
      null,
      true
    )
    and public.norva_catalog_title_projection_index_is_exact(
      'cloud_source_candidate_titles_name_idx',
      'public.cloud_source_catalog_generation_candidate_titles',
      array['user_id','item_type','title','title_id'],
      array[0,0,0,0]::smallint[],
      null,
      true
    )
    and public.norva_catalog_title_projection_index_is_exact(
      'cloud_source_candidate_titles_recent_idx',
      'public.cloud_source_catalog_generation_candidate_titles',
      array['user_id','item_type','catalog_created_at','synced_at','title_id'],
      array[0,0,3,3,0]::smallint[],
      null,
      true
    )
    and public.norva_catalog_title_projection_index_is_exact(
      'cloud_source_candidate_titles_year_pending_idx',
      'public.cloud_source_catalog_generation_candidate_titles',
      array['user_id','item_type','title_id'],
      array[0,0,0]::smallint[],
      '((release_year IS NULL) AND (provider_tmdb_id IS NOT NULL))',
      true
    )
$function$;

revoke all on function
  public.norva_catalog_title_projection_indexes_ready()
from public, anon, authenticated, service_role;

create or replace view public.cloud_catalog_visible_titles
with (security_invoker = true, security_barrier = true)
as
select
  effective_title.id,
  effective_title.user_id,
  effective_title.item_type,
  effective_title.identity_key,
  effective_title.identity_source,
  effective_title.provider_tmdb_id,
  effective_title.provider_imdb_id,
  effective_title.match_status,
  effective_title.title,
  effective_title.original_title,
  effective_title.release_year,
  effective_title.poster_url,
  effective_title.backdrop_url,
  effective_title.metadata,
  best_variant.id as default_variant_id,
  visible_rollup.variant_count,
  best_variant.last_observed_ttff_ms,
  effective_title.synced_at,
  effective_title.created_at,
  effective_title.updated_at,
  visible_rollup.version_languages,
  coalesce(file_languages.file_audio_languages, '{}'::text[]) as audio_languages,
  file_languages.audio_probed_at,
  null::jsonb as audio_tracks,
  effective_title.genre_category,
  effective_title.genre_payload,
  '[]'::jsonb as subtitle_tracks,
  file_languages.subtitle_probed_at,
  visible_rollup.whisper_attempted_at,
  effective_title.year_backfill_attempted_at,
  effective_title.revalidate_attempted_at,
  effective_title.search_match_attempted_at,
  file_languages.audio_lang_verified_at,
  effective_title.genre_buckets,
  effective_title.rating_num,
  coalesce(file_languages.file_audio_languages, '{}'::text[])
    as file_audio_languages,
  coalesce(file_languages.file_subtitle_languages, '{}'::text[])
    as file_subtitle_languages,
  coalesce(file_languages.file_audio_verified_languages, '{}'::text[])
    as file_audio_verified_languages,
  visible_rollup.visible_source_ids
from (
  -- A durable generation payload is visible only when its generation supplies the
  -- best currently-visible variant.  The equality is applied below after the
  -- bounded best-variant lookup, so multiple active sources sharing one title
  -- cannot select the wrong source's candidate payload.
  select
    title.id,
    title.user_id,
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
    projection.synced_at,
    projection.catalog_created_at as created_at,
    projection.updated_at,
    projection.genre_category,
    projection.genre_payload,
    projection.year_backfill_attempted_at,
    projection.revalidate_attempted_at,
    projection.search_match_attempted_at,
    projection.genre_buckets,
    projection.rating_num,
    projection.generation_id as projection_generation_id
  from public.cloud_source_catalog_generation_candidate_titles projection
  join public.cloud_titles title
    on title.id = projection.title_id
   and title.user_id = projection.user_id
  join public.cloud_source_catalog_heads head
    on head.source_id = projection.source_id
   and head.user_id = projection.user_id
   and head.active_generation_id = projection.generation_id
  union all

  -- When the best visible generation has no durable payload, use the
  -- physical title directly.  Predicates on these columns remain plain Vars,
  -- allowing the established partial/GIN/TMDB indexes to remain usable.
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
    title.synced_at,
    title.created_at,
    title.updated_at,
    title.genre_category,
    title.genre_payload,
    title.year_backfill_attempted_at,
    title.revalidate_attempted_at,
    title.search_match_attempted_at,
    title.genre_buckets,
    title.rating_num,
    null::uuid as projection_generation_id
  from public.cloud_titles title
) effective_title
cross join lateral (
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
  where variant.title_id = effective_title.id
    and variant.user_id = effective_title.user_id
) visible_rollup
join lateral (
  select variant.id, variant.generation_id, variant.last_observed_ttff_ms
  from public.cloud_catalog_visible_title_variants variant
  where variant.title_id = effective_title.id
    and variant.user_id = effective_title.user_id
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
  where variant.title_id = effective_title.id
    and variant.user_id = effective_title.user_id
  order by variant.source_id, variant.generation_id nulls first, variant.id
  limit 1
) display_owner on true
left join lateral (
  select
    coalesce(array_agg(distinct language_code order by language_code)
      filter (where facet = 'audio'), '{}'::text[]) as file_audio_languages,
    coalesce(array_agg(distinct language_code order by language_code)
      filter (where facet = 'subtitle'), '{}'::text[]) as file_subtitle_languages,
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
    where variant.title_id = effective_title.id
      and variant.user_id = effective_title.user_id

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
    where variant.title_id = effective_title.id
      and variant.user_id = effective_title.user_id

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
    where variant.title_id = effective_title.id
      and variant.user_id = effective_title.user_id
  ) exact_language
  where language_code ~ '^[a-z]{2,3}$'
    and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
) file_languages on true
where visible_rollup.variant_count > 0
  and (
    effective_title.projection_generation_id = display_owner.generation_id
    or (
      effective_title.projection_generation_id is null
      and not exists (
        select 1
        from public.cloud_source_catalog_generation_candidate_titles projection
        where projection.title_id = effective_title.id
          and projection.user_id = effective_title.user_id
          and projection.generation_id = display_owner.generation_id
      )
    )
  );

-- The set-based overlay supersedes the per-title SECURITY DEFINER helper.  It
-- was introduced only by this not-yet-deployed expand series, so retaining an
-- executable compatibility surface has no rolling-deploy benefit.
drop function if exists public.norva_visible_catalog_title_projection(
  uuid, uuid, uuid
);

do $assert$
declare
  v_options text[];
  v_definition text;
  v_candidate_acl boolean;
  v_indexes_ready boolean;
begin
  select class.reloptions, pg_get_viewdef(class.oid, true)
    into v_options, v_definition
  from pg_class class
  join pg_namespace namespace on namespace.oid = class.relnamespace
  where namespace.nspname = 'public'
    and class.relname = 'cloud_catalog_visible_titles'
    and class.relkind = 'v';
  select bool_and(has_column_privilege(
    'service_role',
    'public.cloud_source_catalog_generation_candidate_titles',
    required.column_name,
    'SELECT'
  )) into v_candidate_acl
  from unnest(array[
    'generation_id','title_id','user_id','source_id','item_type','identity_key',
    'identity_source','provider_tmdb_id','provider_imdb_id','match_status',
    'title','original_title','release_year','poster_url','backdrop_url',
    'metadata','genre_category','genre_payload','genre_buckets','rating_num',
    'year_backfill_attempted_at','revalidate_attempted_at',
    'search_match_attempted_at','synced_at','catalog_created_at','updated_at'
  ]) required(column_name);
  select public.norva_catalog_title_projection_indexes_ready()
    into v_indexes_ready;

  if not found
     or not coalesce(v_options @> array['security_invoker=true'], false)
     or not coalesce(v_options @> array['security_barrier=true'], false)
     or position('union all' in lower(v_definition)) = 0
     or position(
       'cloud_source_catalog_generation_candidate_titles' in v_definition
     ) = 0
     or position('norva_visible_catalog_title_projection' in v_definition) <> 0
     or position('promoted_at' in lower(v_definition)) <> 0
     or position('promotion.phase' in lower(v_definition)) <> 0
     or to_regprocedure(
       'public.norva_visible_catalog_title_projection(uuid,uuid,uuid)'
     ) is not null
     or not coalesce(v_candidate_acl, false)
     or has_table_privilege(
       'service_role',
       'public.cloud_source_catalog_generation_candidate_titles',
       'SELECT'
     )
      or has_column_privilege(
        'service_role',
        'public.cloud_source_catalog_generation_candidate_titles',
        'shell_token',
        'SELECT'
      )
     or has_column_privilege(
       'service_role',
       'public.cloud_source_catalog_generation_candidate_titles',
       'catalog_metadata',
       'SELECT'
     )
     or has_table_privilege(
       'authenticated',
       'public.cloud_source_catalog_generation_candidate_titles',
       'SELECT'
     )
     or has_table_privilege(
       'anon',
       'public.cloud_source_catalog_generation_candidate_titles',
       'SELECT'
     )
     or not coalesce(v_indexes_ready, false)
     then
    raise exception 'cloud_catalog_visible_titles generation projection drift'
      using errcode = '55000', detail = jsonb_build_object(
        'options', v_options,
        'hasUnion', position('union all' in lower(v_definition)) > 0,
        'hasCandidateTable', position(
          'cloud_source_catalog_generation_candidate_titles' in v_definition
        ) > 0,
        'hasLegacyHelper', position(
          'norva_visible_catalog_title_projection' in v_definition
        ) > 0,
        'hasPhaseCoupling', position(
          'promotion.phase' in lower(v_definition)
        ) > 0,
        'candidateServiceSelect', v_candidate_acl,
        'indexesReady', v_indexes_ready
      )::text;
  end if;
end
$assert$;

commit;
