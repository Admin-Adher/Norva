-- Cron audit — Lot 4 (decisions on the two open items).
--
-- 1) norva-series-info-prewarm: UNSCHEDULED. It was paused AND broken — its body hardcoded a
--    sourceId that no longer exists, and its live schedule (*/10 * * * *) had drifted from the
--    documented off-peak '*/10 1-5 * * *' (docs/SERIES-INFO-CACHE.md §9). A paused job with a dead
--    target is debt, and the dashboard's "crons en pause" counter becomes a real signal again.
--    Re-enabling later requires: re-pointing sourceId/userId to a живой source, restoring the
--    off-peak schedule, AND coordinating with the per-host night enrichment crons (0-5h) — a prewarm
--    opens provider connections and would race the same hosts' enrichment slots (user_multi_ip).
--    Until then, cloud_series_info_cache fills via read-through on series-page opens.
--
-- 2) norva-series-info-cache-prune: retention 30d → 90d. With the prewarm gone the cache only
--    refills via read-through, so a longer stale-while-error window is strictly better; the table
--    is metadata-only (14 rows / 216 kB today) — storage cost is nil.
--
-- 3) jeremy host-split (documented decision, NO action): the jeremy account carries two distinct
--    hosts (ott.km4ever.org = Ferran, 51k VOD variants; apdxes.xyz = AtlasPro, LIVE-ONLY, 0 VOD).
--    Splitting its account-wide crons per source (the AÎRO pattern) is a ×2 ONLY IF apdxes ever
--    imports VOD. Preconditions verified by the audit: (a) apdxes imports VOD (today: gain zero —
--    audio-backfill only enriches VOD); (b) its provider identity resolves ≠ km4ever's (needs ≥32
--    VOD items for the stream-ID fingerprint; if it's a mirror, the identity fanout already shares
--    probes and a split is waste); (c) REPLACE the account-wide crons — running both would put two
--    connections of the same account on one host (the real user_multi_ip); (d) start with reduced
--    limits: AtlasPro was rate-limited for endpoint_abuse on player_api.php in June 2026.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'norva-series-info-prewarm') then
    perform cron.unschedule('norva-series-info-prewarm');
  end if;
end $$;

do $$
declare v bigint;
begin
  select jobid into v from cron.job where jobname = 'norva-series-info-cache-prune';
  if v is not null then
    perform cron.alter_job(v, command =>
      $c$delete from public.cloud_series_info_cache where fetched_at < now() - interval '90 days'$c$);
  end if;
end $$;
