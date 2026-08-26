begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- V1 materialised the complete cloud_catalog_visible_titles projection.  That
-- projection evaluates the runtime visibility function per title and exceeded
-- the production refresh budget.  Keep the proven facet queries, then build
-- only the bounded rail payload from the already generation-filtered variants.
create or replace function public.cloud_refresh_facet_summary(
  p_user_id uuid,
  p_item_type text
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_counts jsonb;
  v_audio text[];
  v_version text[];
  v_audio_counts jsonb;
  v_sub_counts jsonb;
  v_rail_candidates jsonb;
  v_start_epoch bigint;
  v_end_epoch bigint;
begin
  if p_user_id is null or p_item_type not in ('movie', 'series') then
    raise exception 'invalid facet summary arguments' using errcode = '22023';
  end if;

  select coalesce(epoch.visibility_epoch, 1)
    into v_start_epoch
  from (select 1) singleton
  left join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = p_user_id;

  -- Preserve the historical/proven facet calculations.  These are deliberately
  -- separate because PostgreSQL can push each predicate through the visibility
  -- view; forcing the entire projection into one materialised spool cannot.
  select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb)
    into v_counts
  from (
    select bucket, count(*)::bigint as n
    from public.cloud_catalog_visible_titles title
    cross join lateral unnest(
      coalesce(title.genre_buckets, array['autres'])
    ) bucket
    where title.user_id = p_user_id
      and title.item_type = p_item_type
      and bucket <> 'autres'
    group by bucket
  ) genre_counts;

  select
    coalesce(jsonb_object_agg(language_code, n), '{}'::jsonb),
    coalesce(array_agg(language_code order by language_code), '{}'::text[])
    into v_audio_counts, v_audio
  from (
    select language_code, count(distinct title.id)::bigint as n
    from public.cloud_catalog_visible_titles title
    cross join lateral unnest(title.file_audio_languages) language_code
    where title.user_id = p_user_id
      and title.item_type = p_item_type
      and language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
    group by language_code
  ) audio_counts;

  select coalesce(array_agg(distinct lower(version_language)), '{}'::text[])
    into v_version
  from public.cloud_catalog_visible_titles title
  cross join lateral unnest(
    coalesce(title.version_languages, '{}'::text[])
  ) version_language
  where title.user_id = p_user_id
    and title.item_type = p_item_type
    and version_language is not null;

  select coalesce(jsonb_object_agg(language_code, n), '{}'::jsonb)
    into v_sub_counts
  from (
    select language_code, count(distinct title.id)::bigint as n
    from public.cloud_catalog_visible_titles title
    cross join lateral unnest(title.file_subtitle_languages) language_code
    where title.user_id = p_user_id
      and title.item_type = p_item_type
      and language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
    group by language_code
  ) subtitle_counts;

  -- cloud_catalog_visible_title_variants already applies source lifecycle and
  -- active-generation visibility.  Distinct-on collapses multiple playable
  -- variants without invoking norva_visible_catalog_title_runtime per title.
  -- Candidate projection metadata wins for a promoted generation; legacy title
  -- metadata remains the fallback for pre-generation rows.
  with visible_titles as materialized (
    select distinct on (variant.title_id)
      variant.title_id as id,
      coalesce(projection.genre_buckets, title.genre_buckets) as genre_buckets,
      coalesce(projection.catalog_created_at, title.created_at) as created_at,
      coalesce(projection.poster_url, title.poster_url) as poster_url
    from public.cloud_catalog_visible_title_variants variant
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = variant.user_id
    left join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.generation_id = variant.generation_id
     and projection.title_id = variant.title_id
     and projection.user_id = variant.user_id
    where variant.user_id = p_user_id
      and variant.item_type = p_item_type
    order by
      variant.title_id,
      projection.updated_at desc nulls last,
      title.updated_at desc
  ), ranked_candidates as (
    select
      candidate.id,
      candidate.genre_buckets,
      candidate.created_at,
      bucket,
      row_number() over (
        partition by bucket
        order by candidate.created_at desc, candidate.id
      ) as bucket_rank
    from visible_titles candidate
    cross join lateral unnest(candidate.genre_buckets) bucket
    where candidate.poster_url is not null
      and bucket <> 'autres'
  ), bounded_candidates as (
    select bucket, jsonb_agg(
      jsonb_build_object(
        'id', id,
        'genreBuckets', genre_buckets,
        'createdAt', created_at
      ) order by created_at desc, id
    ) as items
    from ranked_candidates
    where bucket_rank <= 150
    group by bucket
  )
  select coalesce(jsonb_object_agg(bucket, items), '{}'::jsonb)
    into v_rail_candidates
  from bounded_candidates;

  select coalesce(epoch.visibility_epoch, 1)
    into v_end_epoch
  from (select 1) singleton
  left join public.cloud_user_catalog_visibility_epochs epoch
    on epoch.user_id = p_user_id;
  if v_end_epoch <> v_start_epoch then
    raise exception 'catalog visibility changed during facet refresh'
      using errcode = '40001', detail = 'reason=catalog_visibility_changed';
  end if;

  insert into public.cloud_catalog_facet_summary (
    user_id,
    item_type,
    genre_bucket_counts,
    audio_langs,
    version_tags,
    audio_lang_counts,
    subtitle_lang_counts,
    genre_rail_candidates,
    genre_rail_visibility_epoch,
    refreshed_at
  ) values (
    p_user_id,
    p_item_type,
    coalesce(v_counts, '{}'::jsonb),
    coalesce(v_audio, '{}'::text[]),
    coalesce(v_version, '{}'::text[]),
    coalesce(v_audio_counts, '{}'::jsonb),
    coalesce(v_sub_counts, '{}'::jsonb),
    coalesce(v_rail_candidates, '{}'::jsonb),
    v_start_epoch,
    now()
  )
  on conflict (user_id, item_type) do update set
    genre_bucket_counts = excluded.genre_bucket_counts,
    audio_langs = excluded.audio_langs,
    version_tags = excluded.version_tags,
    audio_lang_counts = excluded.audio_lang_counts,
    subtitle_lang_counts = excluded.subtitle_lang_counts,
    genre_rail_candidates = excluded.genre_rail_candidates,
    genre_rail_visibility_epoch = excluded.genre_rail_visibility_epoch,
    refreshed_at = excluded.refreshed_at;
end
$function$;

revoke all on function public.cloud_refresh_facet_summary(uuid, text)
  from public, anon, authenticated;
grant execute on function public.cloud_refresh_facet_summary(uuid, text)
  to service_role;

commit;
