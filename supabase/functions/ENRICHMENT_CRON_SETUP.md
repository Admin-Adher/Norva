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

Originally most of these ran **every 5 min** indiscriminately, burning ~72 cron
fires/hour → disproportionate Edge-invocation + egress cost (and constant `UPDATE`
churn that bloats the title tables). Now the cadence is **shaped by what each job
touches**: the single **bulk movie probe** runs hot (24/7 `*/3`, ~20 fires/h) to
drain the catalogue while the owner is away, and *everything else* is throttled
and parked off-peak (a few fires/h). Each job is a queue-drainer, so a tick that
finds nothing is cheap. Re-raise / lower the bulk cadence as catalogue turnover
and user activity change.

## Off-peak window (provider single-connection collision)

The provider (`apdxes.xyz`) allows **one connection at a time** and answers any
*concurrent* access with `user_multi_ip` (429). The `audio-backfill` jobs each
open several provider connections per tick (internal `concurrency` 3–4), so when
a tick overlapped a user opening a series fiche, the user-facing `series-info`
(via the gateway) took the 429 — the "I'm connected nowhere yet it 429s" symptom.

Fix (current design — see the dated note below for the full rationale): only the
**bulk movie probe** (`norva-audio-langs-untagged`) runs 24/7 at **concurrency 1**
(one slot, kept ~100 % busy by frequency, never by parallelism); every *other*
provider-touching job is parked in a **staggered 00:00–05:58 UTC off-peak window**
so it never disputes the slot with the bulk drainer *or* with a daytime user.
`series-info` is additionally cached server-side (`cloud_series_info_cache` +
`norva-series-info`), so a once-fetched series never hits the provider again. The
TMDB jobs below touch TMDB (not the provider) but are *also* parked off-peak to
keep the daytime egress quiet. The catalogue auto-refresh (`norva-auto-refresh-detect`,
jobid 1) also touches the provider when a sync comes due — move it off-peak too if
daytime re-syncs bite.

> **2026-06-29 — débit max single-slot, par provider.** Deux comptes, deux providers
> mono-connexion **distincts** : `super8k.top` (owner `c5be5ac4…`) et `apdxes.xyz`
> (frère `0b971271…`). Les crons sont **par-uuid** ; comme les providers diffèrent, les
> deux flottes tournent **en parallèle sans collision** (le slot unique est par compte).
>
> **Levier sur un slot unique = FRÉQUENCE, pas concurrence.** En conc ≥2 sur un
> mono-connexion, les connexions surnuméraires se font 429 (1 seul slot) → travail
> gaspillé. Donc : **conc 1**, mais lancé **en continu** pour garder le slot occupé ~100%.
>
> **super8k : `vod` est mort** (`get_vod_info` renvoie vide → `relayEmpty:60`) → seul le
> **`probe`** (lecture d'entête via relais, ~50% résolu/tick) marche. Le bulk films probe
> tourne **24/7 toutes les 3 min** (drainage principal) ; les jobs secondaires passent
> **off-peak** pour ne pas lui disputer le slot en journée. ~6k résolus/jour → catalogue
> résoluble (~1 sem). Le résidu `noLang` (fichier sans métadonnée) → whisper / inline.
>
> **apdxes : `vod` MARCHE** (`updated:6/8`, `relayEmpty:0`) → backfill **`vod`** rapide
> (métadonnées, non limité par le slot) → ses ~8k finis en < 1 jour.
>
> Si l'owner regarde un film pendant un tick : au pire 1 (lui) + 1 (probe bref) → un
> retry géré (logique 458/429). Réversible : restaurer `… 3,4 * * *` (off-peak).

### Flotte backfill provider (audio / sous-titres) — touche le slot de stream

| Job | uuid / provider | Travail | Cadence | limit / conc |
|---|---|---|---|---|
| `norva-audio-langs-untagged` | super8k (`c5be5ac4…`) | movie **probe** (bulk, tous non-résolus) | `*/3 * * * *` — 24/7, toutes les 3 min | 25 / 1 |
| `norva-audio-langs` | super8k | movie probe (tagués prioritaires) | `0,30 0-5 * * *` — off-peak | 15 / 1 |
| `norva-audio-langs-series` | super8k | series probe | `2,32 0-5 * * *` — off-peak | 15 / 1 |
| `norva-subtitle-backfill-movie` | super8k | movie subtitle | `6,36 0-5 * * *` — off-peak | 10 / 1 |
| `norva-audio-langs-whisper` | super8k | movie **whisper** (résidu non-tagué) | `8,28,48 0-5 * * *` — off-peak | 4 / 1 |
| `norva-audio-langs-jeremy` | apdxes (`0b971271…`) | movie **vod** (métadonnées, rapide) | `3,8,…,58 * * * *` — toutes les 5 min | 50 / 2 |

### TMDB & maintenance — ne touchent PAS le slot de stream

| Job | Endpoint / action | Cadence |
|---|---|---|
| `norva-enrich-search-match` | `norva-source-sync/cron/search-match` (limit 50, conc 6) | `6,16,26,36,46,56 3,4 * * *` — off-peak |
| `norva-origlang-backfill` | `norva-tmdb-origlang` (limit 300, gardé `where exists …`) | `1,11,21,31,41,51 3,4 * * *` — off-peak |
| `norva-enrich-revalidate` | `norva-source-sync/cron/revalidate` (limit 80, conc 8) | `5 */6 * * *` — toutes les 6 h |
| `norva-enrich-backfill-years` | `norva-source-sync/cron/backfill-years` (limit 200, conc 12) | `30 3 * * *` — quotidien 03:30 |
| `norva-series-info-cache-prune` | pure SQL `delete from cloud_series_info_cache` | `15 2 * * *` — quotidien 02:15 |

> Each `audio-backfill` job carries an explicit `userId` — **one driving account per
> provider** (`c5be5ac4…` for super8k, `0b971271…` for apdxes). Enrichment writes land
> in the cross-user global caches (`catalog_file_tracks`, `catalog_titles`), shared by
> every user of that provider, so a single account drives each provider's fleet and any
> later same-provider signup inherits the results instantly.

## (Re)create — run via execute_sql, NOT as a migration

```sql
-- Audio/subtitle backfill → norva-playback/audio-backfill  (Vault: norva_backfill_token)
-- DEUX providers mono-connexion distincts → deux flottes en parallèle (slot par compte).
-- Levier sur 1 slot = FRÉQUENCE, pas concurrence : conc 1 partout sur super8k, mais le bulk
-- tourne 24/7. apdxes accepte 'vod' (métadonnées via relais, non limité par le slot) → conc 2.
-- timeout 110s < intervalle, pour ne jamais empiler deux ticks.

-- super8k BULK : header-probe de TOUS les films non-résolus (sans requireTag), 24/7 toutes
-- les 3 min. C'est le drainage principal (get_vod_info renvoie vide sur super8k → 'vod' mort).
select cron.schedule('norva-audio-langs-untagged', '*/3 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','mode','probe','limit',25,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

-- super8k : films tagués prioritaires (requireTag), off-peak pour ne pas disputer le slot au bulk.
select cron.schedule('norva-audio-langs', '0,30 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','mode','probe','requireTag','multi,vostfr,vo,vff,vfq','limit',15,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

-- super8k : séries (probe), off-peak.
select cron.schedule('norva-audio-langs-series', '2,32 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','series','mode','probe','limit',15,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

-- super8k : sous-titres films, off-peak.
select cron.schedule('norva-subtitle-backfill-movie', '6,36 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','target','subtitle','limit',10,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

-- apdxes (frère, 0b971271…) : get_vod_info MARCHE (relayEmpty:0) → backfill 'vod' rapide
-- (métadonnées via relais, NON limité par le slot de stream) → conc 2, toutes les 5 min, 24/7.
select cron.schedule('norva-audio-langs-jeremy', '3,8,13,18,23,28,33,38,43,48,53,58 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','0b971271-9fa1-4547-8dc6-ab64dcbb9d33','type','movie','mode','vod','limit',50,'concurrency',2),
    timeout_milliseconds := 110000
  );
$cron$);

-- whisper: detect the truly-untagged residual (multi-track titles with an unknown
-- track that probe/vod can't resolve). Serialized; small. See WHISPER-AUDIO-* doc.
select cron.schedule('norva-audio-langs-whisper', '8,28,48 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','mode','whisper','limit',4,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

-- TMDB enrichment → norva-source-sync/cron/*  (Vault: norva_cron_shared_secret)
-- Ne touche pas le provider de stream, mais parqué off-peak (03:00–04:56) pour garder
-- l'egress diurne calme. Drainer : ne fait rien si rien n'est à matcher.
select cron.schedule('norva-enrich-search-match', '6,16,26,36,46,56 3,4 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/search-match?limit=50&conc=6',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
$cron$);

-- TMDB original_language backfill → norva-tmdb-origlang  (Vault: norva_backfill_token)
-- Comble original_language sur les catalog_titles déjà matchés TMDB. Gardé par WHERE EXISTS :
-- le tick ne POST que s'il reste des lignes à combler (sinon zéro invocation edge).
select cron.schedule('norva-origlang-backfill', '1,11,21,31,41,51 3,4 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-tmdb-origlang',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('limit',300),
    timeout_milliseconds := 120000
  )
  where exists (
    select 1 from public.catalog_titles
    where original_language is null and provider_tmdb_id is not null
  );
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
