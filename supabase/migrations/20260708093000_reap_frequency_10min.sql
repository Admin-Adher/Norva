-- Micro-opt: reap_deleted_sources() no longer needs to run every minute.
--
-- The every-minute schedule was set while actively draining the old Ninja
-- duplicate (~763k rows). That drain is now complete (0 soft-deleted sources),
-- so the reaper's per-minute runs are near-instant no-ops (advisory lock →
-- empty `deleted_at is not null` loop → unlock). Dial it back to every 10 min:
-- still drains any future source deletion promptly, with 6× less cron noise.
--
-- Command unchanged: it still lifts the statement_timeout to 900s before the
-- CALL so any future large drain commits its progress (see 20260707180000).

select cron.schedule(
  'norva-reap-deleted-sources',
  '*/10 * * * *',
  $cmd$set statement_timeout to '900s'; call public.reap_deleted_sources();$cmd$
);
