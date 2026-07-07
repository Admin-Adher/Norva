-- Partial index for the default Movies/Series grid ("recommended" rail + main grid) fast path.
--
-- list_media_items_deduped (20260704271000) default view filters `is_dedup_primary` and orders by
-- title. Before this index that predicate had NO supporting index: the planner used
-- idx_cmi_sort_title (user_id, item_type, title, external_id) and POST-FILTERED is_dedup_primary row
-- by row. Fine at small scale, but at a big account with heavy duplicate density (e.g. an Xtream
-- panel that lists many versions of the same film, or a second owner of the same provider) the
-- ordered scan must skip/heap-fetch huge numbers of non-primary rows to yield one page — and under
-- import IO load it blew past statement_timeout ("Unable to list media items — canceling statement").
--
-- This partial index contains ONLY the dedup-primary rows, in the grid's sort order, so the fast
-- path is a pure bounded index scan regardless of duplicate density. EXPLAIN on the live catalogue
-- went from statement-timeout to "Index Scan using idx_cmi_dedup_primary_title" (~700ms cold under
-- import load; ~50ms warm).
--
-- NOTE: in production this was built with CREATE INDEX CONCURRENTLY (no write lock, so an in-flight
-- import's is_dedup_primary updates were not blocked). A migration runs in a transaction where
-- CONCURRENTLY is illegal, so this file uses a plain IF NOT EXISTS create — a no-op against prod
-- (index already exists) and correct for a fresh rebuild (no concurrent writers to contend with).
-- The `title`/`added`/`rating`/`year` sibling sorts on the default grid still post-filter; add
-- matching partial indexes if those sorts also degrade at scale (title is the default rail sort).

create index if not exists idx_cmi_dedup_primary_title
  on public.cloud_media_items (user_id, item_type, title, external_id)
  where is_dedup_primary;
