-- Grid rewrite on top of is_dedup_primary (20260704270000): the default Movies/Series grid
-- (no source/category filter) is now a single bounded index scan for ALL account sizes,
-- with exact cross-page dedup baked in by the precomputed flag. This replaces the
-- estimate-routed big/small split of 20260704250000 for the default view.
--
-- Measured on the live catalogue: jeremy (53k movie items, was ~31s exact-dedup) -> 47ms;
-- c5be5ac4 series (48k) -> 18ms; mega (383k) stays a bounded scan. total is null (the client
-- shows "N+ titles" while paging and the exact grouped count once fully loaded), so there is
-- no whole-account count scan on the hot path.
--
-- is_dedup_primary is a GLOBAL representative per film, so it must NOT be combined with a
-- source/category filter (which partitions a film's copies across buckets — the film's global
-- primary might live in another bucket). Those filtered views keep the estimate-routed
-- behaviour of 20260704250000 (big: index page; normal: exact per-bucket dedup).

create or replace function list_media_items_deduped(
  p_user uuid,
  p_item_type text default null,
  p_source uuid default null,
  p_category text default null,
  p_search text default null,
  p_year_min int default null,
  p_year_max int default null,
  p_min_rating numeric default null,
  p_added_after_epoch bigint default null,
  p_sort text default 'default',
  p_limit int default 60,
  p_offset int default 0
) returns jsonb
language plpgsql
stable
as $$
declare
  v_big boolean;
  v_order text;
  v_result jsonb;
begin
  v_order := case p_sort
    when 'added'    then 'added_at desc nulls last, external_id'
    when 'rating'   then 'rating_num desc nulls last, external_id'
    when 'year'     then 'release_year desc nulls last, external_id'
    when 'year-asc' then 'release_year asc nulls last, external_id'
    else 'title asc, external_id'
  end;

  -- FAST PATH — default grid (no source/category bucketing): filter is_dedup_primary ->
  -- bounded index scan with exact cross-page dedup for ALL sizes. total is null.
  if p_source is null and p_category is null then
    execute format($q$
      with page as (
        select p.*, row_number() over () as __rn
        from (
          select mi.*
          from cloud_media_items mi
          where mi.user_id = $1
            and ($2::text is null or mi.item_type = $2)
            and mi.is_dedup_primary
            and ($3::text is null or mi.title ilike '%%' || $3 || '%%')
            and ($4::int  is null or (mi.release_year >= $4 and mi.release_year <= $5))
            and ($6::numeric is null or mi.rating_num >= $6)
            and ($7::bigint is null or mi.added_at >= $7)
          order by %s
          limit greatest($8, 0) offset greatest($9, 0)
        ) p
      )
      select jsonb_build_object(
        'items', coalesce((select jsonb_agg((to_jsonb(page) - '__rn') order by __rn) from page), '[]'::jsonb),
        'films', (select count(*) from page),
        'total', null
      )
    $q$, v_order)
    into v_result
    using p_user, p_item_type, p_search, p_year_min, p_year_max, p_min_rating, p_added_after_epoch, p_limit, p_offset;
    return v_result;
  end if;

  -- SOURCE / CATEGORY FILTERED — estimate-routed (20260704250000): big -> index page, no dedup;
  -- normal -> exact cross-page dedup scoped to the filtered bucket.
  v_big := public.catalog_item_estimate(p_user, p_item_type) > 60000;
  if v_big then
    execute format($q$
      with page as (
        select p.*, row_number() over () as __rn
        from (
          select mi.*
          from cloud_media_items mi
          where mi.user_id = $1
            and ($2::text is null or mi.item_type = $2)
            and ($3::uuid is null or mi.source_id = $3)
            and ($4::text is null or mi.parent_external_id = $4)
            and ($5::text is null or mi.title ilike '%%' || $5 || '%%')
            and ($6::int  is null or (mi.release_year >= $6 and mi.release_year <= $7))
            and ($8::numeric is null or mi.rating_num >= $8)
            and ($9::bigint is null or mi.added_at >= $9)
          order by %s
          limit greatest($10, 0) offset greatest($11, 0)
        ) p
      )
      select jsonb_build_object(
        'items', coalesce((select jsonb_agg((to_jsonb(page) - '__rn') order by __rn) from page), '[]'::jsonb),
        'films', (select count(*) from page),
        'total', null
      )
    $q$, v_order)
    into v_result
    using p_user, p_item_type, p_source, p_category, p_search,
          p_year_min, p_year_max, p_min_rating, p_added_after_epoch, p_limit, p_offset;
    return v_result;
  end if;

  with filtered as (
    select mi.*, coalesce(mi.dedup_key, mi.id::text) as _dk
    from cloud_media_items mi
    where mi.user_id = p_user
      and (p_item_type is null or mi.item_type = p_item_type)
      and (p_source   is null or mi.source_id = p_source)
      and (p_category is null or mi.parent_external_id = p_category)
      and (p_search   is null or mi.title ilike '%' || p_search || '%')
      and (p_year_min is null or (mi.release_year >= p_year_min and mi.release_year <= p_year_max))
      and (p_min_rating is null or mi.rating_num >= p_min_rating)
      and (p_added_after_epoch is null or mi.added_at >= p_added_after_epoch)
  ),
  reps as (
    select distinct on (_dk)
      _dk, added_at, rating_num, release_year, lower(title) as _title, external_id
    from filtered
    order by _dk,
      (poster_url is not null) desc,
      ((metadata->>'providerTmdbId') is not null) desc,
      rating_num desc nulls last,
      external_id
  ),
  ordered as (
    select _dk,
      row_number() over (order by
        case when p_sort = 'added'    then added_at     end desc nulls last,
        case when p_sort = 'rating'   then rating_num   end desc nulls last,
        case when p_sort = 'year'     then release_year end desc nulls last,
        case when p_sort = 'year-asc' then release_year end asc  nulls last,
        case when (p_sort is null or p_sort in ('name','default','')) then _title end asc nulls last,
        external_id
      ) as _rn
    from reps
  ),
  page_films as (
    select _dk, _rn from ordered order by _rn offset greatest(p_offset, 0) limit greatest(p_limit, 0)
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg((to_jsonb(f) - '_dk') order by pf._rn, f.external_id)
      from page_films pf
      join filtered f on f._dk = pf._dk
    ), '[]'::jsonb),
    'films', (select count(*) from page_films),
    'total', (select count(*) from reps)
  ) into v_result;
  return v_result;
end $$;
