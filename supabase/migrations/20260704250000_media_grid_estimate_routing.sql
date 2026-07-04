-- Fix: the Movies/Series grid still cost ~3.3s per load for mega-accounts (380k+ items),
-- and sort=rating full-sorted the whole account.
--
-- Two remaining costs after the 60k big-account guard of 20260704230000:
--   1. The guard itself (`count(*) > 60000`) AND the big-path `total` were each an
--      unbounded index scan of the whole item_type — ~3.8s at 383k movie items, worse
--      mid-import (dirty visibility map -> heap fetches). `total` is only the cosmetic
--      "N titles" label; the client already falls back to "N+ titles" (hasMore derives
--      from films>=limit when total is null).
--   2. sort=rating had no supporting index -> a full 383k-row sort on the big path.
--
-- So:
--   * catalog_item_estimate(): the big/small decision now comes from a PLANNER ESTIMATE
--     (instant, from pg_statistic) instead of an exact count. Measured ~5% off actual
--     (365,687 est vs 383,634) — plenty accurate for a 60k threshold that has wide margin
--     (the exact dedup path stays under timeout well past 100k rows), and robust mid-import.
--   * The big path returns total = null (no count scan at all) -> the grid is just the
--     bounded index-page fetch (~0.3s cold, ~ms warm).
--   * idx_cmi_sort_rating makes sort=rating a bounded index scan like title/added/year.
-- Normal accounts are unchanged: exact cross-page dedup with an exact total.
--
-- Live DB: idx_cmi_sort_rating was built with CREATE INDEX CONCURRENTLY (imports were
-- writing); the IF NOT EXISTS here is a no-op where that already landed.

create index if not exists idx_cmi_sort_rating
on public.cloud_media_items (user_id, item_type, rating_num desc nulls last, external_id);

-- Instant per-(user,item_type) size estimate via the planner (no table scan).
-- VOLATILE because EXPLAIN is disallowed in non-volatile functions; that is fine — it is
-- only ever called for a routing decision, never inlined into a plan.
create or replace function public.catalog_item_estimate(p_user uuid, p_item_type text)
returns bigint
language plpgsql
volatile
set search_path to 'public'
as $$
declare
  v_plan json;
  v_rows bigint;
begin
  execute format(
    'explain (format json) select 1 from cloud_media_items where user_id = %L %s',
    p_user,
    case when p_item_type is null then '' else format('and item_type = %L', p_item_type) end
  ) into v_plan;
  v_rows := (v_plan->0->'Plan'->>'Plan Rows')::bigint;
  return coalesce(v_rows, 0);
end $$;

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
  -- Strategy probe: planner estimate (instant) instead of an exact count(*).
  v_big := public.catalog_item_estimate(p_user, p_item_type) > 60000;

  if v_big then
    -- Large account: index-driven page (no full-account sort, no count). Order maps to a
    -- matching (user_id, item_type, <col>) index so the page is a bounded index scan.
    v_order := case p_sort
      when 'added'    then 'added_at desc nulls last, external_id'
      when 'rating'   then 'rating_num desc nulls last, external_id'
      when 'year'     then 'release_year desc nulls last, external_id'
      when 'year-asc' then 'release_year asc nulls last, external_id'
      else 'title asc, external_id'
    end;
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

  -- Normal account: exact cross-page dedup (the original behaviour).
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
