-- Speed audit on the largest account (projethorizon2030, 383k movie items / 419k titles):
-- two more per-load full-account scans on Home / Movies / Series.
--
-- 1. Home "Recently Added" rail (listTitleRail, norva-catalog index.ts:1409) orders
--    cloud_titles by created_at desc with NO supporting index — a full-account top-N sort
--    of ~188k rows (Gather Merge + Sort), fired twice per Home load (movie + series).
--    idx_cloud_titles_recent makes it a bounded index scan: measured 90s-class sort -> 19ms.
--
-- 2. cloud_genre_bucket_counts's big-account guard was an exact count(*) on cloud_media_items
--    (~3.8s at 383k items) executed on every Movies/Series load, purely to decide "too big,
--    return nothing". Swapped for the planner-estimate helper (catalog_item_estimate, added in
--    20260704250000): ~3.8s -> ~50ms, same behaviour. Normal accounts (< 60k) still get exact
--    per-bucket counts.
--
-- Live DB: idx_cloud_titles_recent was built with CREATE INDEX CONCURRENTLY (imports were
-- writing); IF NOT EXISTS here is a no-op where it already landed.

create index if not exists idx_cloud_titles_recent
on public.cloud_titles (user_id, item_type, created_at desc, synced_at desc)
where variant_count > 0;

create or replace function public.cloud_genre_bucket_counts(p_user_id uuid, p_item_type text, p_source_id uuid default null)
returns table(bucket text, n bigint)
language plpgsql
stable
set search_path to 'public'
as $$
begin
  -- Big-account guard: planner estimate (instant) instead of an exact count(*).
  if public.catalog_item_estimate(p_user_id, p_item_type) > 60000 then
    return;
  end if;
  return query
    select b as bucket, count(*) as n
    from public.cloud_titles t
         cross join lateral unnest(coalesce(t.genre_buckets, array['autres'])) as b
    where t.user_id = p_user_id
      and t.item_type = p_item_type
      and t.variant_count > 0
      and b <> 'autres'
      and (
        p_source_id is null
        or exists (
          select 1 from public.cloud_title_variants v
          where v.title_id = t.id and v.source_id = p_source_id
        )
      )
    group by b;
end $$;
