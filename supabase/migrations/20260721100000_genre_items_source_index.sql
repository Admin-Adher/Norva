-- Keep source-scoped genre grids index-backed.
--
-- media-genre-items filters logical titles through their provider variants. The
-- existing unique index starts with (source_id, item_type, external_id), which
-- still leaves PostgREST to recover title_id from every matching provider row.
-- This covering order makes the EXISTS/embedded relationship lookup cheap and
-- also supports returning only the selected provider's versions.

create index if not exists idx_cloud_title_variants_source_title
  on public.cloud_title_variants (source_id, title_id);
