-- Phase 2b: schedule the (already-implemented but never-scheduled) provider-id revalidation.
-- norva-source-sync/cron/revalidate fetches TMDB details BY the provider-supplied tmdb id for
-- titles that have an id but were never validated (match_status='provider_unverified'/'weak'),
-- promotes the passing ones to provider_verified with the canonical title + i18n, AND now dual-
-- writes catalog_titles (global) so cloud_enrich_titles_from_catalog fans the result out to every
-- user and it survives re-sync. Cursor-resumable + 90d attempt markers, so it self-drains the
-- ~75k backlog and then idles. Offset from the */3 search-match cron to spread the TMDB load.
select cron.schedule(
  'norva-revalidate-provider-ids',
  '2-59/4 * * * *',
  $cron$ select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/revalidate?limit=800&conc=12',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ); $cron$
);
