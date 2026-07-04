-- Cron throughput tuning (live-data verification, 2026-07-04). Both changes were applied
-- live via cron.schedule/cron.alter_job; this migration journals them for the repo.
--
-- 1) KING365 series → dedicated night WHISPER lane (jobid 83).
--    Live diagnosis: 3,921 series, 1,885 never probed, 994 probed-but-"und" and GROWING
--    ~780/day — 779 of the 780 daily probes are FRESH probes that come back "und" (the
--    panel does not tag its series). The classic probe can never resolve them; whisper
--    can (17/17 = 100% resolve rate on this panel's movies) but (a) the dedicated
--    whisper cron was movie-only and (b) the daytime fallthrough chain stops at the
--    first dimension that processed work, so 'series whisper' was NEVER reached while
--    series probes kept finding candidates → whisper_attempted = 0 on all series.
--    Minute offset 1 vs the movie-whisper lane's 5 (≥4-min gap) — same single-slot
--    spacing pattern as the other panels' multi-lane setups.
select cron.schedule('norva-whisper-airo-king365-series', '1-59/9 0-5 * * *', $$
  select net.http_post(url:='https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='norva_backfill_token')),
    body:=jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','4e3d7dd8-9123-4bd6-9a02-36cc92e40a33','type','series','mode','whisper','limit',4,'concurrency',1),
    timeout_milliseconds:=110000);
$$)
where not exists (select 1 from cron.job where jobname = 'norva-whisper-airo-king365-series');

-- 2) TMDB search-match: night window 3-4h → 2-5h (12 → 24 runs) + conc 6 → 10.
--    The route clamps limit at 300 (already at ceiling), so widening = more runs.
--    Drain: 3,600 → 7,200 titles/night; the 471,717-title unmatched backlog goes from
--    ~131 days to ~66 days. TMDB API pressure stays ≈5 req/s peak (limit ~50 req/s),
--    and search-match talks ONLY to TMDB — zero provider connections involved.
do $$
declare v_jobid int;
begin
  select jobid into v_jobid from cron.job where jobname = 'norva-enrich-search-match';
  if v_jobid is not null then
    perform cron.alter_job(v_jobid, schedule := '6,16,26,36,46,56 2,3,4,5 * * *', command := '
  select net.http_post(
    url := ''https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/search-match?limit=300&conc=10'',
    headers := jsonb_build_object(''Content-Type'',''application/json'',''Authorization'',''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name = ''norva_cron_shared_secret'')),
    body := ''{}''::jsonb, timeout_milliseconds := 120000);
    ');
  end if;
end $$;
