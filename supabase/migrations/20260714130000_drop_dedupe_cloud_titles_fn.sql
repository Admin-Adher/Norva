-- =============================================================================
-- Drop dedupe_cloud_titles_by_tmdb — superseded by norva_canonicalize_titles_for_user.
-- =============================================================================
-- 20260714120000 added dedupe_cloud_titles_by_tmdb() to merge duplicate cloud_titles
-- by provider_tmdb_id. Investigation (see docs/architecture/catalog-dedup-and-grouping.md)
-- showed norva_canonicalize_titles_for_user (20260704220000) ALREADY does exactly that
-- merge, and it runs inside norva_reconcile_catalog on the norva-catalog-reconcile cron
-- (0-6h) which ALSO propagates to the raw grid layer (norva_backfill_media_identity) —
-- which the standalone dedupe never did. So the function was a redundant re-implementation
-- of the merge half of an existing, more complete pipeline.
--
-- Its one-time global run already collapsed the backlog (equivalent to
-- norva_canonicalize_titles_for_user(null)); that merged data stays. cronSearchMatch no
-- longer calls it (wiring reverted). Drop the function and refresh PostgREST so the RPC
-- disappears from the schema cache.

drop function if exists public.dedupe_cloud_titles_by_tmdb(uuid);

notify pgrst, 'reload schema';
