-- =============================================================================
-- Reconcile family → max_parallel_workers_per_gather = 0 (no parallel DSM).
-- =============================================================================
-- norva_reconcile_catalog(NULL, …) does GLOBAL scans (canonicalize's group-by over
-- all cloud_titles, the media→variants→titles join in backfill). On the self-host DB
-- container the default /dev/shm (~64 MB) is too small for the parallel-query dynamic
-- shared memory segments those scans request:
--     ERROR: could not resize shared memory segment … No space left on device
-- (observed running a manual global drain 2026-07-14). These functions are BOUNDED
-- (LIMIT-based batches), so parallelism buys them nothing — pin them to serial so they
-- never allocate a parallel DSM segment. No downtime (plain ALTER), no correctness
-- change. The alternative (raise the db container's shm_size) needs a recreate; this
-- doesn't. Nested calls inherit the setting, so altering the whole family is belt-and-
-- suspenders regardless of entry point (cron calls norva_reconcile_catalog).
--
-- DO block so it survives any overload/signature drift (ALTER by resolved oid).

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'norva_reconcile_catalog',
        'norva_canonicalize_titles_for_user',
        'norva_backfill_media_identity',
        'norva_refresh_posters_from_catalog',
        'norva_recompute_dedup_primary'
      )
  loop
    execute format('alter function %s set max_parallel_workers_per_gather = 0', r.sig);
    raise notice 'pinned serial: %', r.sig;
  end loop;
end $$;
