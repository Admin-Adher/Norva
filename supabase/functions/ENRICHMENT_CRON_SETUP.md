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
touches**: per provider, the **films-audio bulk** runs frequently in a **day window
6-23 UTC** (`*/3` probe or `*/5` vod), and séries/sous-titres/whisper are parked in a
**staggered night window 0-5 UTC** (see the 2026-06-29 v2 note for the full design).
Each job is a queue-drainer, so a tick that finds nothing is cheap. Re-raise / lower
cadence as catalogue turnover and user activity change.

## Off-peak window (provider single-connection collision)

The provider (`apdxes.xyz`) allows **one connection at a time** and answers any
*concurrent* access with `user_multi_ip` (429). The `audio-backfill` jobs each
open several provider connections per tick (internal `concurrency` 3–4), so when
a tick overlapped a user opening a series fiche, the user-facing `series-info`
(via the gateway) took the 429 — the "I'm connected nowhere yet it 429s" symptom.

Fix (current design — full rationale in the 2026-06-29 v2 note below): this
single-connection rule applies to **every panel** (super8k & AÎRO too — all
mono-connexion; apdxes even 429s on metadata). Per provider, **films-audio** runs in a
**day window 6-23 UTC** at concurrency 1 (vod conc 2 for apdxes), and
**séries/sous-titres/whisper** run in a **staggered night window 0-5 UTC** (cycle 9,
3 min apart) so two accesses never hit the one slot at once — neither each other nor a
daytime user.
`series-info` is additionally cached server-side (`cloud_series_info_cache` +
`norva-series-info`), so a once-fetched series never hits the provider again. The
TMDB jobs below touch TMDB (not the provider) but are *also* parked off-peak to
keep the daytime egress quiet. The catalogue auto-refresh (`norva-auto-refresh-detect`,
jobid 1) also touches the provider when a sync comes due — move it off-peak too if
daytime re-syncs bite.

> **2026-06-29 (v2) — parité premium 4 dimensions × N providers, fenêtres disjointes.**
> **TROIS** providers mono-connexion : `super8k.top` (owner `c5be5ac4…`), `apdxes.xyz`
> (frère `0b971271…`), `mandara.cc` = panel **AÎRO** (compte catalogue dédié `7bdab1df…`).
> Les crons sont **par-uuid**. Providers distincts = comptes/slots distincts → **flottes en
> parallèle sans collision** entre providers. Les écritures atterrissent dans les caches
> cross-user keyés par **`providerKey`** (cf. `docs/PROVIDER-IDENTITY-DEDUP.md`) → tout user
> d'un **miroir** du même panel hérite instantanément.
>
> **4 dimensions par provider** : audio films · audio séries · sous-titres films · whisper
> (résidu non-tagué). `langs` (films tagués) a été **supprimé** : redondant avec `untagged`
> (qui sonde TOUS les films non résolus, tagués compris).
>
> **Slot unique = il faut time-sharer dans le TEMPS, pas paralléliser.** Tout ce qui touche
> le provider (probe ET, pour apdxes, même les métadonnées vod) compte pour l'unique
> connexion. Donc, par provider :
> - **Films (audio)** = le gros → fenêtre **jour 6-23 UTC**, fréquent (`*/3`/`*/5`).
> - **Séries + sous-titres + whisper** → fenêtre **nuit 0-5 UTC**, **décalés de 3 min**
>   (cycle 9 : `0-59/9`, `3-59/9`, `6-59/9`) → jamais deux accès simultanés sur le slot.
>
> **Méthode par panel** : `vod` (`get_vod_info` expose l'audio → métadonnées via relais,
> rapide) si dispo, sinon **`probe`** (lecture d'entête, ~500/h en conc 1). Vérifier d'abord
> `get_vod_info` (une ligne d'essai suffit) :
> - **super8k** : `vod` mort (`relayEmpty:60`) → tout en **probe**. Gros chantier : ~92k
>   titres, ~7 % résolus, débit ~500/h → **~1 semaine** pour l'audio films (PAS « à jour »,
>   ancienne note erronée corrigée). Sous-titres/séries (nuit) → plus lents (semaines) ; le
>   cache **persiste** donc ça se complète tout seul.
> - **apdxes** : `vod` MARCHE (`relayEmpty:0`) → films en **vod** (rapide, ~1 jour). Mais
>   apdxes **429 sur toute concurrence** (même métadonnée) → vod aussi restreint 6-23.
> - **AÎRO** : `vod` mort (`get_vod_info` = métadonnées descriptives, pas de bloc audio) →
>   tout en **probe**. ~9,5k films + 2,2k séries.

### Flotte backfill provider — 4 dimensions × 3 providers (touche le slot)

| Provider (uuid) | Films audio — jour 6-23 | Séries — `0-59/9` 0-5 | Sous-titres — `3-59/9` 0-5 | Whisper — `6-59/9` 0-5 |
|---|---|---|---|---|
| **super8k** (`c5be5ac4…`) probe | `norva-audio-langs-untagged` `*/3` (25) | `norva-audio-langs-series` (15) | `norva-subtitle-backfill-movie` (10) | `norva-audio-langs-whisper` (4) |
| **apdxes** (`0b971271…`) vod films | `norva-audio-langs-jeremy` **vod** `3-58/5` (50, conc 2) | `norva-audio-langs-jeremy-series` (15) | `norva-subtitle-backfill-jeremy` (10) | `norva-audio-langs-jeremy-whisper` (4) |
| **AÎRO** (`7bdab1df…`) probe | `norva-audio-langs-airo` `1-58/3` (25) | `norva-audio-langs-airo-series` (15) | `norva-subtitle-backfill-airo` (10) | `norva-audio-langs-airo-whisper` (4) |

(limit entre parenthèses ; conc 1 sauf apdxes films vod conc 2. Sous-titres = `target:subtitle` ;
non redondant avec l'audio : couvre les films dont l'audio fut déduit par nom — donc jamais
header-probé — dont les sous-titres restent inconnus. whisper = `mode:whisper`.)

> **Note pg_cron** : les 3 providers ont leurs jobs de nuit aux mêmes minutes (0/3/6…) →
> jusqu'à 3 jobs simultanés (comptes distincts → aucune collision provider). Si un « job
> startup timeout » apparaît, décaler les minutes par provider.

#### Bascule automatique « fallthrough » (jour épuisé → on draine les dimensions de nuit) — edge v22

Les 3 crons de **jour** (films audio) portent `'fallthrough', true` dans leur body. Quand la
dimension primaire (films audio) renvoie **0 candidat** (`processed:0`), la route
`runAudioBackfill` enchaîne **automatiquement** sur la dimension suivante non terminée du **même
provider**, dans cet ordre, et traite **un** lot puis s'arrête :

```
films audio (vod/probe) → séries audio (probe) → sous-titres films → sous-titres séries → whisper films → whisper séries
```

→ dès que les films audio d'un provider sont finis, **sa fenêtre de jour accélère les dimensions
qui étaient nuit-only** (elles reçoivent jour **+** nuit). No-op tant que les films ne sont pas finis.

**Slot-safe** (invariant : jamais 2 accès simultanés) : les dimensions s'enchaînent **strictement
en séquentiel** (un accès provider à la fois) ; chaque dimension garde son garde `userHasLiveSession()` ;
la chaîne **s'arrête net** (`skipped:live-session`) dès qu'un user regarde → jamais de 2ᵉ connexion
provider à côté d'un stream live (`user_multi_ip`). Code : `runAudioBackfill` (wrapper auth + chaîne) +
`runOneDimension` (logique par dimension, inchangée), `supabase/functions/norva-playback/index.ts`.

Pour activer/désactiver un provider : ajouter/retirer `'fallthrough', true` du body de son cron de
jour (`cron.alter_job(<jobid>, command := $cmd$ … $cmd$)`). Vérifié live (apdxes : films vod `processed:0`
→ bascule séries `processed:15`, `200`).

### TMDB & maintenance — ne touchent PAS le slot de stream

| Job | Endpoint / action | Cadence |
|---|---|---|
| `norva-enrich-search-match` | `norva-source-sync/cron/search-match` (limit 50, conc 6) | `6,16,26,36,46,56 3,4 * * *` — off-peak |
| `norva-origlang-backfill` | `norva-tmdb-origlang` (limit 300, gardé `where exists …`) | `1,11,21,31,41,51 3,4 * * *` — off-peak |
| `norva-enrich-revalidate` | `norva-source-sync/cron/revalidate` (limit 80, conc 8) | `5 */6 * * *` — toutes les 6 h |
| `norva-enrich-backfill-years` | `norva-source-sync/cron/backfill-years` (limit 200, conc 12) | `30 3 * * *` — quotidien 03:30 |
| `norva-series-info-cache-prune` | pure SQL `delete from cloud_series_info_cache` | `15 2 * * *` — quotidien 02:15 |

> Each `audio-backfill` job carries an explicit `userId` — **one driving account per
> provider** (`c5be5ac4…` super8k, `0b971271…` apdxes, `7bdab1df…` AÎRO). Enrichment writes
> land in the cross-user global caches (`catalog_file_tracks` keyed by **providerKey**,
> `catalog_titles`), shared by every user of that panel (all mirror URLs collapse to one
> providerKey), so a single account drives each panel's fleet and any later same-panel
> signup inherits the results instantly — even after the driving account is deleted (the
> global caches are not tied to a user/source; see `docs/PROVIDER-IDENTITY-DEDUP.md`).

## (Re)create — run via execute_sql, NOT as a migration

```sql
-- Audio/subtitle backfill → norva-playback/audio-backfill  (Vault: norva_backfill_token)
-- TROIS providers mono-connexion, 4 dimensions chacun. Slot unique par compte → on TIME-SHARE
-- dans le temps : films audio le JOUR (6-23), séries/sous-titres/whisper la NUIT (0-5) décalés
-- de 3 min (cycle 9 : 0-59/9, 3-59/9, 6-59/9) → jamais deux accès simultanés sur le slot.
-- super8k/AÎRO = probe (vod mort) ; apdxes = vod pour les films (mais 429 sur TOUTE concurrence
-- → vod aussi restreint 6-23). timeout 110s < intervalle. providerKey : cf PROVIDER-IDENTITY-DEDUP.

-- ───────── super8k (probe) — userId c5be5ac4… ─────────
-- films audio bulk : header-probe de TOUS les films non-résolus, jour 6-23 (libère 0-5).
select cron.schedule('norva-audio-langs-untagged', '*/3 6-23 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','mode','probe','limit',25,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);
-- (`norva-audio-langs` films-tagués SUPPRIMÉ — redondant avec untagged, qui sonde TOUS les films.)

select cron.schedule('norva-audio-langs-series', '0-59/9 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','series','mode','probe','limit',15,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-subtitle-backfill-movie', '3-59/9 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','target','subtitle','limit',10,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-audio-langs-whisper', '6-59/9 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','type','movie','mode','whisper','limit',4,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

-- ───────── apdxes (vod films) — userId 0b971271… ─────────
-- films audio : get_vod_info MARCHE → 'vod' (métadonnées). 429 sur toute concurrence → 6-23, conc 2.
select cron.schedule('norva-audio-langs-jeremy', '3-58/5 6-23 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','0b971271-9fa1-4547-8dc6-ab64dcbb9d33','type','movie','mode','vod','limit',50,'concurrency',2),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-audio-langs-jeremy-series', '0-59/9 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','0b971271-9fa1-4547-8dc6-ab64dcbb9d33','type','series','mode','probe','limit',15,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-subtitle-backfill-jeremy', '3-59/9 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','0b971271-9fa1-4547-8dc6-ab64dcbb9d33','type','movie','target','subtitle','limit',10,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-audio-langs-jeremy-whisper', '6-59/9 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','0b971271-9fa1-4547-8dc6-ab64dcbb9d33','type','movie','mode','whisper','limit',4,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

-- ───────── AÎRO (mandara.cc, probe) — userId 7bdab1df… ─────────
select cron.schedule('norva-audio-langs-airo', '1-58/3 6-23 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','type','movie','mode','probe','limit',25,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-audio-langs-airo-series', '0-59/9 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','type','series','mode','probe','limit',15,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-subtitle-backfill-airo', '3-59/9 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','type','movie','target','subtitle','limit',10,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-audio-langs-airo-whisper', '6-59/9 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','type','movie','mode','whisper','limit',4,'concurrency',1),
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
