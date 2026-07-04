-- Periodic catalog reconciler: keeps the identity layer canonical as enrichment runs.
--
-- The search-match cron resolves tmdb ids into cloud_titles continuously, which can
-- re-introduce cross-identity duplicates (a freshly-matched `norm:` title colliding
-- with an existing `tmdb:` title) and leaves the flat-grid dedup_key / propagated
-- tmdb stale. Rather than complicate the hot matching path, a lightweight scheduled
-- reconcile re-runs the two idempotent maintenance functions. Both are cheap when
-- there is nothing to do (canonicalize only touches dup groups; the media backfill
-- only rewrites rows whose key/tmdb drifted). Pass NULL to reconcile every user.

create or replace function norva_reconcile_catalog(p_user_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_merged  integer;
  v_touched integer;
begin
  v_merged  := norva_canonicalize_titles_for_user(p_user_id);
  v_touched := norva_backfill_media_identity(p_user_id);
  return jsonb_build_object('titles_merged', v_merged, 'media_rows_reconciled', v_touched);
end $$;

-- Index that makes the canonicalize group-by (user_id, item_type, provider_tmdb_id)
-- cheap enough to run on a schedule.
create index if not exists cloud_titles_user_type_tmdb_idx
  on cloud_titles (user_id, item_type, provider_tmdb_id)
  where provider_tmdb_id is not null;
