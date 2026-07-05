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

## ⛔ 2026-07-03 — Ninja (`operator1.barfik.org`) PAUSÉ en lazy-only (anti-ban)

> **Les 4 crons Ninja sont DÉSACTIVÉS live** (`cron.unschedule`) — NE PAS les ré-appliquer tant que
> le « mode faible empreinte » n'est pas livré : `norva-audio-airo-ninja` (jobid 61),
> `norva-audio-airo-ninja-series` (66), `norva-subtitle-airo-ninja` (67),
> `norva-whisper-airo-ninja` (73).
>
> Cause : l'ancien compte Ninja a été **banni automatiquement** par le provider (« comportement
> suspect / partage de compte / trop de requêtes »). Diagnostic : notre crawl de fond tapait le
> provider mono-connexion depuis **plusieurs classes d'IP** (probes → Cloudflare `norva-relay` ;
> metadata → proxy résidentiel gateway) à **~7 410 probes/jour**, sans mutex incluant la lecture.
> Le compte a été remplacé ; pour ne pas rebannir le nouveau, Ninja tourne **sans crawl de fond**
> (enrichissement uniquement à la lecture réelle) jusqu'à ce que le mode faible empreinte existe
> (1 IP résidentielle unique + cap de débit + concurrence 1 incl. lecture). Détail :
> `docs/PROVIDER-ANTIBAN-NINJA.md`.

### Ninja — ré-activation domptée (à appliquer APRÈS déploiement gateway v63 + edge)

Le **mode faible empreinte est livré** (Slice 0-2, branche) : plafond **40/h**
(`provider_footprint_policy`, identité `d8453dc1-…`), probes via l'**IP résidentielle** de la gateway
(`POST /probe-audio`), **concurrence 1** + jitter 0,2-1,2 s + **mutex lecture** (la gateway renvoie
409 `account_busy` si un viewer tient la connexion). Tout est automatique côté runner dès qu'une
identité est `low_footprint` — la cadence des crons ne fait que fournir des ticks ; le plafond 40/h
reste la vraie limite, donc **pas de split jour/nuit** (le mutex gère le chevauchement lecture).
Séquence : déployer gateway v63 → merger l'edge → **PUIS** :

```sql
select cron.schedule('norva-audio-airo-ninja', '4-59/12 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','976e7bbd-f433-4a41-821d-3cb983c73921','type','movie','mode','probe','limit',12,'concurrency',1,'fallthrough',true),
    timeout_milliseconds := 110000 ); $cron$);
select cron.schedule('norva-audio-airo-ninja-series', '9-59/12 * * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','976e7bbd-f433-4a41-821d-3cb983c73921','type','series','mode','probe','limit',8,'concurrency',1),
    timeout_milliseconds := 110000 ); $cron$);
```

Sous-titres/whisper Ninja : ajoutés **plus tard**, une fois l'audio validé (48 h sans re-ban,
`résolu_24h > 0`). Après activation, vérifier : dashboard **« ⚠ provider muet » absent**,
`select count(*) from provider_probe_hits where identity_key='d8453dc1-…' and occurred_at > now()-interval '1 hour'` **≤ 40**,
gateway health sans 401 barfik. Tuner `max_probes_per_hour` (`provider_footprint_policy`) si besoin.

**Lazy / metadata-first** : pour Ninja (panel AÎRO), `get_vod_info` **n'expose pas** le bloc audio
(« vod mort », cf. note v2) → pas de raccourci metadata possible ; l'enrichissement passe forcément
par le header-probe (désormais résidentiel + capé). L'enrichissement à la **lecture réelle** reste
le complément gratuit (zéro connexion en plus).

## 2026-07-02 — Audit & optimisation de la flotte (v4)

> Trace complète : `docs/CRON-OPTIMIZATION-AUDIT.md` (méthode, findings, mesures, preuves live).
> Résumé de ce qui a changé dans CETTE flotte :
>
> - **Court-circuit `enrichment_exhausted`** : une (source, dimension) qui retourne 0 candidat est
>   sautée 30 min (TTL aligné sur l'auto-refresh) ; un tick productif efface la marque. Un tick à
>   sec coûte ~2 requêtes PK au lieu de scans de panel. Les modes ciblés (titleIds/catalog/
>   transcribe) ne sont jamais court-circuités. Table `public.enrichment_exhausted` (service-only).
> - **Index candidats** : `idx_cloud_titles_whisper_pending` (partiel `@>`), `idx_cloud_titles_audio_sweep`.
> - **Memo config source** (edge, TTL 60 s) : 1 lookup/déchiffrement par tick au lieu de 1/titre.
> - **Crons TMDB ressuscités** (curseur cyclique + `done` latché + marqueurs `*_attempted_at` 90 j) et
>   limits montées : backfill-years `limit=1000`, search-match `limit=300`, revalidate `limit=500`.
> - **Gardes SQL** (`WHERE EXISTS`) sur resume-stuck / import-notify-digest / auto-refresh-detect.
> - **Autres jobs** : admin-dashboard-refresh `2-57/10` (réécrit, ~8 s/run), reaper horaire,
>   rétentions `norva-cron-history-prune` (7 j) + `norva-admin-events-prune` (180 j),
>   series-info-prewarm **retiré** (cassé ; conditions de ré-activation dans la migration
>   `20260702120000`), series-info-cache-prune 90 j.

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

> **2026-07-01 (v3) — AÎRO = 5 hôtes distincts → crons PAR-PANEL (parallélisme).** Le compte
> `7bdab1df…` s'est révélé porter **5 panels distincts** (Airysat / Ninja / KING365 / Opplex /
> Promax, ~334k films), pas un seul host. Draîné par `user_id` seul, les 5 partageaient **UN**
> slot sérialisé → ~52 j de 1er passage (vs ~5 j pour super8k, 70k, mono-host dédié). Correctif :
> un scope **`sourceId`** (RPC `audio_backfill_candidates`, variant-driven) fait qu'un cron ne
> draine **qu'un** panel → chaque hôte a son slot et ils avancent **en parallèle**. **Charge
> par-hôte inchangée** (1 connexion/hôte, juste plus mise en file avec les voisins ; hôtes
> distincts → pas de `user_multi_ip`) → chaque panel AÎRO reçoit désormais le **même traitement
> que super8k**. `mode:whisper` étant aussi une connexion provider, `whisper_candidate_titles`
> gagne un `p_source` (scopé) ; le fallthrough propage `sourceId` sur **toutes** les dimensions.
> Détail des crons + `sourceId` dans la section SQL « AÎRO — 5 PANELS PARALLÉLISÉS » plus bas.

### Flotte backfill provider — 4 dimensions × 3 providers (touche le slot)

| Provider (uuid) | Films audio — jour 6-23 | Séries — `0-59/9` 0-5 | Sous-titres — `3-59/9` 0-5 | Whisper — `6-59/9` 0-5 |
|---|---|---|---|---|
| **super8k** (`c5be5ac4…`) probe | `norva-audio-langs-untagged` `*/3` (25) | `norva-audio-langs-series` (15) | `norva-subtitle-backfill-movie` (10) | `norva-audio-langs-whisper` (4) |
| **apdxes** (`0b971271…`) vod films | `norva-audio-langs-jeremy` **vod** `3-58/5` (50, conc 2) | `norva-audio-langs-jeremy-series` (15) | `norva-subtitle-backfill-jeremy` (10) | `norva-audio-langs-jeremy-whisper` (4) |
| **AÎRO** (`7bdab1df…`) probe | **5 panels parallélisés** — voir §v3 ci-dessous | (par-panel, fallthrough) | (géants: nuit dédiée) | (via fallthrough) |

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

#### Whisper nuit — LID des pistes non taguées + VERIFY des tags menteurs (v5, 2026-07-02)

Le mode `whisper` exécute DEUX phases par tick : (1) **verify** — candidats via la RPC
`audio_tag_suspects` (classe 1 : titre marqué FR sans `fr` sondé ; classe 2 : langue unique dont
le nom figure dans le titre — pattern releaser « Bhooth Bangla » tagué `bn` alors que le film est
hindi ; classe 2 servie en premier ; `verifyTitleIds` dans le body = vérification ciblée à la
demande) ; (2) **LID** des pistes non taguées (inchangé). Couverture whisper complétée le 02/07 :
**AÎRO n'avait AUCUN cron whisper** → 5 nouveaux crons per-panel, offsets cycle-9 sans collision :

| jobname | schedule | panel |
|---|---|---|
| `norva-whisper-airo-ninja` | `6-59/9 0-5` | Ninja (`976e7bbd…`) |
| `norva-whisper-airo-promax` | `7-59/9 0-5` | Promax (`3eb5999e…`) |
| `norva-whisper-airo-airysat` | `2-59/9 0-5` | Airysat (`f660f738…`) |
| `norva-whisper-airo-king365` | `5-59/9 0-5` | KING365 (`4e3d7dd8…`) |
| `norva-whisper-airo-opplex` | `8-59/9 0-5` | Opplex (`9579e61b…`) |

(super8k jobid 33 et jeremy jobid 54, account-wide `6-59/9 0-5`, inchangés — ils exécutent aussi
la phase verify désormais.)

#### Sous-titres IA — pré-génération nocturne whitelist + reaper (Phase 3c, edge v23)

Pré-génère les **sous-titres IA** (whisper → VTT) des titres « chauds » de chaque provider pour
qu'ils soient déjà prêts avant qu'un user les demande. Détail produit : `docs/PHASE3-AI-SUBTITLES.md` §11.

| jobname | jobid | schedule (UTC) | provider | body |
|---|---|---|---|---|
| `norva-subtitle-pregen-jeremy` | 56 | `20 0 * * *` | apdxes (`0b971271…`) | `mode:transcribe-whitelist, limit:2` |
| `norva-subtitle-pregen-airo` | 57 | `25 0 * * *` | AÎRO (`7bdab1df…`) | `mode:transcribe-whitelist, limit:2` |
| `norva-subtitle-pregen-super8k` | 58 | `30 0 * * *` | super8k (`c5be5ac4…`) | `mode:transcribe-whitelist, limit:2` |
| `norva-generated-subtitle-reaper` | 55 | `*/30 * * * *` | — (SQL pur) | passe `failed` les jobs `processing` > 2 h |

- **Candidats** : RPC `whitelist_subtitle_candidates(p_user, p_limit)` → titres sans sous-titre texte
  extractible, **récemment joués (≤21 j, priorité 0)** + **nouveautés films (priorité 1)**, ordre
  `priority asc, updated_at desc`.
- **Mode `transcribe-whitelist`** (`runOneDimension`) : sur-échantillonne (`p_limit=max(limit*6,20)`),
  enqueue `limit` **nouveaux** jobs (saute les `ready`/en-vol → avance au-delà des déjà-faits).
  **Touche le slot** (lecture audio provider) → garde `userHasLiveSession()` (`skipped:live-session`).
- Staggerés 00:20/00:25/00:30 pour ne pas se chevaucher (1 slot provider à la fois). **Attention :
  le stagger ne protège que l'ENQUEUE** — la queue gateway (concurrency 1) exécute les jobs
  15-50 min plus tard, en plein grid des crons nuit. La vraie protection est la **coordination
  crons ↔ pregen** (audit 2026-07-02, `docs/SUBTITLE-PREGEN-RELIABILITY.md`) : (a) les dimensions
  d'enrichissement skippent un compte tant qu'un job pregen/OCR `claimed_by` lui est en vol
  (`skipped:pregen-active`, TTL 2 h) ; (b) le gateway POST `norva-playback/pregen-gate` avant
  d'ouvrir la connexion provider et défère si viewer live ou heartbeat de tick < 150 s
  (`enrichment_tick_heartbeat`). Fail-open des deux côtés.
- Vérifié live (super8k non-live : `{candidates:20, enqueued:1, started:[{priority:0}]}`, `200`, job
  dispatché à la gateway ; jeremy live : `{skipped:'live-session'}`).

### TMDB & maintenance — ne touchent PAS le slot de stream

| Job | Endpoint / action | Cadence |
|---|---|---|
| `norva-enrich-search-match` | `norva-source-sync/cron/search-match` (limit 50, conc 6) | `6,16,26,36,46,56 3,4 * * *` — off-peak |
| `norva-origlang-backfill` | `norva-tmdb-origlang` (limit 300, gardé `where exists …`) | `1,11,21,31,41,51 3,4 * * *` — off-peak |
| `norva-enrich-revalidate` | `norva-source-sync/cron/revalidate` (limit 80, conc 8) | `5 */6 * * *` — toutes les 6 h |
| `norva-enrich-backfill-years` | `norva-source-sync/cron/backfill-years` (limit 200, conc 12) | `30 3 * * *` — quotidien 03:30 |
| `norva-prewarm-i18n` | `norva-source-sync/cron/prewarm-i18n` (limit 200, conc 8, gardé `where exists …`) | `35 2 * * *` — quotidien 02:35, avant la rafale 03-04 |
| `norva-series-info-cache-prune` | pure SQL `delete from cloud_series_info_cache` | `15 2 * * *` — quotidien 02:15 |

> **`norva-prewarm-i18n`** comble les synopsis multi-langues manquants du cache global
> `catalog_titles` (Phase 4 VOD i18n, `docs/roadmap/VOD-I18N-AND-REGIONS.md` C.8). L'enrichissement
> localise déjà chaque titre matché via les `translations` TMDB (39 390/39 479 matchs validés déjà
> traduits — ~89 trous résiduels), donc ce cron ne comble QUE ces trous : un pull `translations` par
> titre couvre TOUTES les langues d'un coup, marque `catalog_titles.i18n_attempted_at` (fenêtre de
> retry 90 j) et sort le titre du set-cible dès que l'i18n est écrit. Les ~51 k lignes à id numérique
> mais **sans** `metadata.tmdb` sont hors-scope (problème de *matching*, pas d'i18n — géré par
> `search-match`/`revalidate`). La longue traîne réellement consultée est peuplée par le chemin
> **on-demand** (`norva-catalog` getTmdbMeta écrit la carte complète à chaque ouverture de fiche).

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

-- ───────── AÎRO — 5 PANELS PARALLÉLISÉS (probe) — userId 7bdab1df… ─────────
-- v3 (2026-07-01) : le compte AÎRO porte 5 hôtes DISTINCTS (Airysat / Ninja / KING365 /
-- Opplex / Promax, ~334k films). Avant, un seul cron drainait par user_id → les 5 panels
-- partageaient UN slot sérialisé (~52 j pour un 1er passage). Maintenant chaque panel a SON
-- cron scopé par 'sourceId' (RPC audio_backfill_candidates) → ils s'enrichissent EN PARALLÈLE.
-- Charge par-hôte INCHANGÉE (chaque hôte voit toujours 1 connexion — juste plus mise en file
-- avec ses voisins ; hôtes distincts → aucun user_multi_ip). 'fallthrough',true : dès qu'un
-- panel a fini ses films, sa fenêtre de jour draine SES séries/sous-titres/whisper (scopés).
-- Cadences shaped par la taille du pool : géants (Ninja/Promax) au débit super8k (*/3, ~500/h),
-- moyens/petits moins fréquents. Minutes décalées (0/1/2/4/5) pour étaler les fires pg_cron.
-- source_ids : Ninja 976e7bbd… · Promax 3eb5999e… · Opplex 9579e61b… · KING365 4e3d7dd8… ·
-- Airysat f660f738… (voir admin_provider_overview / cloud_sources).

-- Films audio — JOUR 6-23, fallthrough (draine séries/sous-titres/whisper du panel une fois fini)
select cron.schedule('norva-audio-airo-ninja', '0-59/3 6-23 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','976e7bbd-f433-4a41-821d-3cb983c73921','type','movie','mode','probe','limit',25,'concurrency',1,'fallthrough',true),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-audio-airo-promax', '1-59/3 6-23 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','3eb5999e-117b-4196-aaaf-4304e80a48ff','type','movie','mode','probe','limit',25,'concurrency',1,'fallthrough',true),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-audio-airo-opplex', '2-59/6 6-23 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','9579e61b-5cda-4ea2-8b40-7996de8af32a','type','movie','mode','probe','limit',25,'concurrency',1,'fallthrough',true),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-audio-airo-king365', '4-59/12 6-23 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','4e3d7dd8-9123-4bd6-9a02-36cc92e40a33','type','movie','mode','probe','limit',25,'concurrency',1,'fallthrough',true),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-audio-airo-airysat', '5-59/30 6-23 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','f660f738-dbd6-43f8-acc0-b91784bfa138','type','movie','mode','probe','limit',25,'concurrency',1,'fallthrough',true),
    timeout_milliseconds := 110000
  );
$cron$);

-- NUIT 0-5 — SEULEMENT pour les 2 géants (films = semaines → il faut avancer leurs séries/sous-
-- titres en parallèle des films). Petits panels : couverts par le fallthrough de jour dès que leurs
-- films sont finis. Whisper = via fallthrough (scopé au panel). Minutes décalées par hôte (Ninja
-- 0/3, Promax 1/4) ; même hôte jamais 2 accès simultanés (≥3 min, connexions courtes).
select cron.schedule('norva-audio-airo-ninja-series', '0-59/9 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','976e7bbd-f433-4a41-821d-3cb983c73921','type','series','mode','probe','limit',15,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-subtitle-airo-ninja', '3-59/9 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','976e7bbd-f433-4a41-821d-3cb983c73921','type','movie','target','subtitle','limit',10,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-audio-airo-promax-series', '1-59/9 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','3eb5999e-117b-4196-aaaf-4304e80a48ff','type','series','mode','probe','limit',15,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-subtitle-airo-promax', '4-59/9 0-5 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','sourceId','3eb5999e-117b-4196-aaaf-4304e80a48ff','type','movie','target','subtitle','limit',10,'concurrency',1),
    timeout_milliseconds := 110000
  );
$cron$);

-- Retrait des anciens crons AÎRO account-wide (remplacés par les crons par-panel ci-dessus) :
--   select cron.unschedule('norva-audio-langs-airo');
--   select cron.unschedule('norva-audio-langs-airo-series');
--   select cron.unschedule('norva-subtitle-backfill-airo');
--   select cron.unschedule('norva-audio-langs-airo-whisper');

-- Sous-titres IA — pré-génération nocturne whitelist (Phase 3c). Staggerés 00:20/25/30, limit 2.
select cron.schedule('norva-subtitle-pregen-jeremy', '20 0 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','0b971271-9fa1-4547-8dc6-ab64dcbb9d33','mode','transcribe-whitelist','limit',2),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-subtitle-pregen-airo', '25 0 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','7bdab1df-80e6-46f9-bcdf-84b6595819a8','mode','transcribe-whitelist','limit',2),
    timeout_milliseconds := 110000
  );
$cron$);

select cron.schedule('norva-subtitle-pregen-super8k', '30 0 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback/audio-backfill',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_backfill_token')),
    body := jsonb_build_object('userId','c5be5ac4-3700-4a25-9509-8eaf7771fdb6','mode','transcribe-whitelist','limit',2),
    timeout_milliseconds := 110000
  );
$cron$);

-- Reaper sous-titres IA — débloque les jobs whisper coincés (SQL pur, pas d'edge).
select cron.schedule('norva-generated-subtitle-reaper', '*/30 * * * *', $cron$
  update public.catalog_generated_subtitles
     set status = 'failed',
         error = coalesce(error, '') || ' [reaped: stuck in processing > 2h]',
         updated_at = now()
   where status = 'processing'
     and updated_at < now() - interval '2 hours';
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

-- i18n pre-warm → norva-source-sync/cron/prewarm-i18n  (Vault: norva_cron_shared_secret)
-- Phase 4 : comble les synopsis multi-langues manquants des matchs validés (metadata.tmdb présent,
-- pas encore d'i18n) — 1 pull translations = toutes les langues. Gardé par WHERE EXISTS (index
-- partiel catalog_titles_i18n_gap_idx) : le tick ne POST que s'il reste des trous à combler et pas
-- attaqués depuis 90 j. Self-draining (un titre sort du set dès l'i18n écrit). 02:35, avant 03-04.
-- ⚠ Nécessite la migration 20260705020000_i18n_prewarm.sql (colonne + RPCs). Appliquer AVANT.
select cron.schedule('norva-prewarm-i18n', '35 2 * * *', $cron$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/prewarm-i18n?limit=200&conc=8',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000)
  where exists (
    select 1 from public.catalog_titles c
    where (c.metadata ? 'tmdb') and not (c.metadata ? 'i18n')
      and (c.i18n_attempted_at is null or c.i18n_attempted_at < now() - interval '90 days')
  );
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
