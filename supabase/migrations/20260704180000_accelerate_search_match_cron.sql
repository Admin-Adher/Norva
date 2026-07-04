-- Accelerate the TMDB search-match cron to burn down the unmatched backlog.
--
-- WHY: ~459k BROWSABLE titles (variant_count>0) had never been attempted by the
-- search-match cron — 98.6% of the unmatched set. At the old cadence
-- (limit=300, ~24 runs/day over hours 2-5 = ~7.2k/day) the backlog needed ~65 days,
-- so genre grids surfaced (post genre_buckets fix) hundreds of real movies with no
-- poster/clean title simply because TMDB matching had never run on them
-- (e.g. "47 Ronin (FHD MULTI)" — matchable at ~0.92 confidence, just never reached).
--
-- The edge caps were raised (norva-source-sync: limit 300→1500, conc 20→30) and the
-- query now filters variant_count>0 (no TMDB calls on dead entries). Here we bump the
-- schedule: limit=1000 conc=15 per run, every 5 min around the clock (~288 runs/day ≈
-- 288k titles/day) — clears the ~459k browsable backlog in ~1-2 days, then self-limits
-- (once the backlog is drained each run only scans the few newly-synced unmatched rows).
--
-- Budget check: ~1.2k TMDB calls/run in ~35s (< the 120s http_post timeout); ~288k
-- titles/day ≈ ~8 req/s average, ~30-40 req/s peak at conc 15 — under TMDB's ~50 req/s.

do $$
declare v bigint;
begin
  select jobid into v from cron.job where jobname = 'norva-enrich-search-match';
  if v is not null then
    perform cron.alter_job(
      v,
      schedule => '*/5 * * * *',
      command  => $c$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/search-match?limit=1000&conc=15',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
      $c$
    );
  end if;
end $$;
