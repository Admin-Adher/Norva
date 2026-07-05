-- Fix: admin dashboard refresh (cron job norva-dashboard-refresh) timed out ~9x/24h.
--
-- refresh_admin_dashboard()'s coverage + per-source rollup both resolve each title's
-- panel via `default_variant_id -> cloud_title_variants.source_id`. With no covering
-- index, the planner built its hash from a FULL HEAP SEQ SCAN of all ~755k variant rows
-- (wide) — the dominant I/O, and under import contention it pushed the whole function past
-- its budget. (Note: the function's internal `set local statement_timeout='180s'` is a
-- no-op — statement_timeout is armed when the cron statement begins, so the effective
-- budget is the cron role default, ~120s; failures hit at exactly 120.1s.)
--
-- idx_ctv_id_source lets both the coverage query and the src_rows `tc`/`vc` CTEs read
-- (id, source_id) via an INDEX-ONLY scan (~25MB) instead of the heap. Measured on the live
-- catalogue mid-import: coverage 100s+ -> ~10s, src_rows -> ~21s, whole function ~40s
-- (well under the 120s budget). source_id is insert-only on variants, so the index has
-- negligible maintenance churn.
--
-- Live DB: built with CREATE INDEX CONCURRENTLY; IF NOT EXISTS is a no-op where it landed.

create index if not exists idx_ctv_id_source
on public.cloud_title_variants (id) include (source_id);
