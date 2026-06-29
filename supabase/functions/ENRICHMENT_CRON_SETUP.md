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

## Off-peak window (provider single-connection collision)

The provider (`apdxes.xyz`) allows **one connection at a time** and answers any
*concurrent* access with `user_multi_ip` (429). The `audio-backfill` jobs each
open several provider connections per tick (internal `concurrency` 3–4), so when
a tick overlapped a user opening a series fiche, the user-facing `series-info`
(via the gateway) took the 429 — the "I'm connected nowhere yet it 429s" symptom.

Fix: the four provider-probing jobs are consolidated into a **staggered
03:00–04:58 UTC window**, 2 min apart, so (a) none ever overlaps a *user* during
the day and (b) none overlaps *another crawl* at night. `series-info` is
additionally cached server-side (`cloud_series_info_cache` + `norva-series-info`),
so a once-fetched series never hits the provider again. The TMDB jobs below touch
TMDB (not the provider), so they stay spread across the day. The catalogue
auto-refresh (`norva-source-sync/cron/refresh-due`, jobid 1) also touches the
provider when a sync comes due — move it off-peak too if daytime re-syncs bite.

> **2026-06-29 — bascule 24/7 (single-slot-safe).** L'owner n'utilise pas le site en
> journée et veut drainer le backlog (≈64k titres sans langue) plus vite. Les jobs
> qui ouvrent une connexion **stream** (`probe`/`subtitle`/`whisper`) passent en
> **concurrence 1** et sont **décalés de 2 min** (cycle de 10 min) → il n'y a JAMAIS
> plus d'**UNE** connexion stream de backfill à la fois : le backfill ne se heurte
> donc jamais lui-même. Le `vod` reste métadonnées (relais `get_vod_info`, pas une
> connexion stream) → parallélisable. Si l'owner regarde un film pendant un tick, le
> pire est 1 (lui) + 1 (backfill) → un retry géré (cf. logique 458/429), pas une
> tempête. Réversible : restaurer `… 3,4 * * *` (off-peak 2 h) ci-dessous.

| Job | Endpoint | Cadence (24/7, décalé) | conc |
|---|---|---|---|
| `norva-audio-langs` | `…/audio-backfill` (movie, probe) | `0,10,20,30,40,50 * * * *` | 1 |
| `norva-audio-langs-series` | `…/audio-backfill` (series, probe) | `2,12,22,32,42,52 * * * *` | 1 |
| `norva-audio-langs-untagged` | `…/audio-backfill` (movie, **vod** = métadonnées) | `4,14,24,34,44,54 * * * *` | 4 |
| `norva-subtitle-backfill-movie` | `…/audio-backfill` (movie, subtitle) | `6,16,26,36,46,56 * * * *` | 1 |
| `norva-audio-langs-whisper` | `…/audio-backfill` (movie, **whisper** = résidu non-tagué) | `8,28,48 * * * *` | 1 |
| `norva-enrich-search-match` | `norva-source-sync/cron/search-match` | `15,45 * * * *` (every 30 min) |
| `norva-enrich-revalidate` | `norva-source-sync/cron/revalidate` | `5 */6 * * *` (every 6 h) |
| `norva-enrich-backfill-years` | `norva-source-sync/cron/backfill-years` | `30 3 * * *` (daily 03:30) |
| `norva-series-info-cache-prune` | pure SQL `delete from cloud_series_info_cache` | `15 2 * * *` (daily 02:15) |

> The `audio-backfill` jobs carry an explicit `userId` (the primary account whose
> catalogue stands in for the shared provider); enrichment writes land in the
> cross-user `catalog_titles` global cache, so one account drives the fleet.

## (Re)create — run via execute_sql, NOT as a migration

```sql
-- Audio/subtitle backfill → norva-playback/audio-backfill  (Vault: norva_backfill_token)
-- 24/7 staggered, stream-touching jobs concurrency 1 (max ONE provider stream
-- connection at a time). vod = metadata (relay), parallel-safe. timeout 110s < 120s gap.
select cron.schedule('norva-audio-langs', '0,10,20,30,40,50 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','mode','probe','requireTag','multi,vostfr,vo,vff,vfq','limit',10,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-audio-langs-series', '2,12,22,32,42,52 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','series','mode','probe','limit',8,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-audio-langs-untagged', '4,14,24,34,44,54 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','mode','vod','untaggedOnly',true,'limit',60,'concurrency',4),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-subtitle-backfill-movie', '6,16,26,36,46,56 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','target','subtitle','limit',8,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

-- whisper: detect the truly-untagged residual (multi-track titles with an unknown
-- track that probe/vod can't resolve). Serialized; small. See WHISPER-AUDIO-* doc.
select cron.schedule('norva-audio-langs-whisper', '8,28,48 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','mode','whisper','limit',4,'concurrency',1),
    timeout_milliseconds := 110000
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

-- Series-info cache eviction (pure SQL, no edge/provider call). Bounds the cross-user
-- cloud_series_info_cache to "series opened in the last 30 days". See docs/SERIES-INFO-CACHE.md.
select cron.schedule('norva-series-info-cache-prune', '15 2 * * *', $cron$
  delete from public.cloud_series_info_cache where fetched_at < now() - interval '30 days'
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
