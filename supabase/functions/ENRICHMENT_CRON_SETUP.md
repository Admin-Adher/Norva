# Catalogue enrichment / backfill crons (pg_cron)

The catalogue enrichment + backfill fleet runs as pg_cron jobs that POST to edge
routes (audio/subtitle probing on `norva-playback/audio-backfill`, TMDB
match/revalidate/year-backfill on `norva-source-sync/cron/*`). Each is a
**queue-drainer**: it processes a small batch of not-yet-enriched rows, so once
the catalogue is fully enriched a tick finds nothing and is cheap.

Like `norva-source-sync/CRON_SETUP.md`, this is **not a migration**: apply with
`execute_sql` against the project. Commands reference Vault secrets
(`norva_backfill_token`, `norva_cron_shared_secret`) by NAME via subquery — no
secret value appears here. `cron.schedule(name, …)` is idempotent (re-running
updates the existing job), so this file is the source of truth for the cadences.

## Cadences (throttled)

Originally most of these ran **every 5 min**. With a small user base on the free
tier that burned ~72 cron fires/hour → disproportionate Edge-invocation + egress
cost (and constant `UPDATE` churn that bloats the title tables). Throttled to the
cadences below (~10 fires/hour, ~−86%); enrichment still completes, just less
often — ample for the current scale. Re-raise if catalogue turnover grows.

| Job | Endpoint | Cadence |
|---|---|---|
| `norva-audio-langs` | `norva-playback/audio-backfill` (movie, probe) | `0,30 * * * *` (every 30 min) |
| `norva-audio-langs-series` | `norva-playback/audio-backfill` (series, probe) | `10,40 * * * *` (every 30 min) |
| `norva-audio-langs-untagged` | `norva-playback/audio-backfill` (movie, vod, untagged) | `20 * * * *` (hourly) |
| `norva-subtitle-backfill-movie` | `norva-playback/audio-backfill` (movie, subtitle) | `25 * * * *` (hourly) |
| `norva-enrich-search-match` | `norva-source-sync/cron/search-match` | `15,45 * * * *` (every 30 min) |
| `norva-enrich-revalidate` | `norva-source-sync/cron/revalidate` | `5 */6 * * *` (every 6 h) |
| `norva-enrich-backfill-years` | `norva-source-sync/cron/backfill-years` | `30 3 * * *` (daily 03:30) |

> The `audio-backfill` jobs carry an explicit `userId` (the primary account whose
> catalogue stands in for the shared provider); enrichment writes land in the
> cross-user `catalog_titles` global cache, so one account drives the fleet.

## (Re)create — run via execute_sql, NOT as a migration

```sql
-- Audio/subtitle backfill → norva-playback/audio-backfill  (Vault: norva_backfill_token)
select cron.schedule('norva-audio-langs', '0,30 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','mode','probe','requireTag','multi,vostfr,vo,vff,vfq','limit',15,'concurrency',3),
    timeout_milliseconds := 120000
  );
$cron$);

select cron.schedule('norva-audio-langs-series', '10,40 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','series','mode','probe','limit',12,'concurrency',3),
    timeout_milliseconds := 120000
  );
$cron$);

select cron.schedule('norva-audio-langs-untagged', '20 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','mode','vod','untaggedOnly',true,'limit',40,'concurrency',4),
    timeout_milliseconds := 120000
  );
$cron$);

select cron.schedule('norva-subtitle-backfill-movie', '25 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','target','subtitle','limit',10,'concurrency',3),
    timeout_milliseconds := 120000
  );
$cron$);

-- TMDB enrichment → norva-source-sync/cron/*  (Vault: norva_cron_shared_secret)
select cron.schedule('norva-enrich-search-match', '15,45 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/search-match?limit=50&conc=6',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
$cron$);

select cron.schedule('norva-enrich-revalidate', '5 */6 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/revalidate?limit=80&conc=8',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
$cron$);

select cron.schedule('norva-enrich-backfill-years', '30 3 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/backfill-years?limit=200&conc=12',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
$cron$);
```

## Inspect / pause / remove

```sql
select jobid, jobname, schedule, active from cron.job order by jobid;   -- inspect
select cron.unschedule('norva-audio-langs');                            -- remove one
```

## One-off VACUUM FULL (reclaim title-table bloat)

The enrichment `UPDATE` churn bloats `cloud_titles` / `cloud_media_items` /
`catalog_titles`. `VACUUM` can't run via `execute_sql` (transaction wrapper), but
pg_cron runs outside a transaction — so reclaim by scheduling a temporary job,
letting it fire once, then unscheduling. One VACUUM statement per job:

```sql
select cron.schedule('vac-tmp', '* * * * *', 'vacuum (full, analyze) public.cloud_titles');
-- wait ~1–2 min, confirm cron.job_run_details shows 'succeeded', then:
select cron.unschedule('vac-tmp');
```
