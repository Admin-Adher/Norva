-- Cron audit — Lot 2: the three TMDB enrichment crons (backfill-years / revalidate / search-match)
-- were PERMANENT NO-OPS: their keyset cursor latched at the catalogue's max id after the first pass
-- and was never reset, so 100% of the backlog (22 691 year-less titles, 94 633 unverified/weak,
-- 462 655 unmatched) sat below the cursor forever, and ~99.9994% of newly imported UUIDv4 titles are
-- born below it too. Fix (edge, norva-source-sync): cursor resets to null at each pass end; `done`
-- is LATCHED true after the first pass (norva-catalog's onboarding `settled` flag reads it — a wrap
-- must never un-settle the progress bar).
--
-- This migration adds the CONVERGENCE layer the verifier made mandatory: without an attempt marker,
-- every new pass would re-burn the full TMDB budget on known failures (a new import would wait up to
-- ~771 days for its turn). Dedicated timestamptz columns (the proven cloud_titles.whisper_attempted_at
-- pattern — NOT metadata jsonb, which would rewrite multi-KB rows and isn't indexable), set on every
-- scanned row; the candidate selects skip rows attempted < 90 days ago. Successes leave the candidate
-- sets naturally (release_year set / match_status promoted).
--
-- Partial indexes bound each candidate walk to its own backlog instead of all 557k titles.
-- (Built CONCURRENTLY in ops — cloud_titles takes constant enrichment writes; the plain CREATEs
-- below are no-ops on live and exist for reproducibility.)
--
-- Limits raised (TMDB is NOT an IPTV provider host — no user_multi_ip constraint; caps are already
-- in the edge code): backfill-years 200→1000 (drains 22.7k in ~23 daily runs instead of 113),
-- search-match 50→300 (12 runs/day → 3 600/day), revalidate 80→500 (4 runs/day → 2 000/day).

alter table public.cloud_titles
  add column if not exists year_backfill_attempted_at timestamptz,
  add column if not exists revalidate_attempted_at   timestamptz,
  add column if not exists search_match_attempted_at timestamptz;

create index if not exists idx_cloud_titles_year_backfill_pending
  on public.cloud_titles (id)
  where release_year is null and provider_tmdb_id is not null;

create index if not exists idx_cloud_titles_revalidate_pending
  on public.cloud_titles (id)
  where match_status in ('provider_unverified','weak') and provider_tmdb_id is not null and provider_tmdb_id <> '0';

create index if not exists idx_cloud_titles_search_match_pending
  on public.cloud_titles (id)
  where match_status = 'unmatched';

do $$
declare v bigint;
begin
  select jobid into v from cron.job where jobname = 'norva-enrich-backfill-years';
  if v is not null then
    perform cron.alter_job(v, command => $c$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/backfill-years?limit=1000&conc=12',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
    $c$);
  end if;
  select jobid into v from cron.job where jobname = 'norva-enrich-revalidate';
  if v is not null then
    perform cron.alter_job(v, command => $c$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/revalidate?limit=500&conc=8',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
    $c$);
  end if;
  select jobid into v from cron.job where jobname = 'norva-enrich-search-match';
  if v is not null then
    perform cron.alter_job(v, command => $c$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/search-match?limit=300&conc=6',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
    $c$);
  end if;
end $$;
