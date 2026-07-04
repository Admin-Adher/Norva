-- Server-side dedup for the flat Movies/Series grid.
--
-- A film the provider lists more than once (or that arrives from several sources)
-- must show as ONE card. We paginate by DISTINCT film (dedup_key = the linked title's
-- canonical identity) so a film lands on exactly one page — duplicates collapse even
-- when the provider entries would otherwise fall on different pages, which the
-- client-side grouping (it only sees loaded pages) cannot guarantee.
--
-- Crucially we still return EVERY version row of each page-film (flattened), so the
-- client keeps its version picker (quality / language selection) intact. The client
-- groups the rows back into one card and advances its cursor by `films`, not row count.
--
-- Returns { items: [version rows...], films: <films on this page>, total: <distinct
-- films matching the filters> }. Rows with a NULL dedup_key fall back to their own id,
-- so they are never wrongly merged.

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
language sql
stable
as $$
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
    -- one representative per film carries that film's sort keys; the representative is
    -- the richest row (poster + resolved tmdb + rating), external_id as tiebreaker.
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
  );
$$;
