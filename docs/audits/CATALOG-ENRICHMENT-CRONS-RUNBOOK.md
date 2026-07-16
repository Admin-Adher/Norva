# Runbook — enrichissement TMDB + dédup/posters du catalogue (2026-07-04)

Ce document capture l'**état opérationnel** (crons pg_cron live, RPC, procédure de
généralisation) mis en place pendant la session Movies/Series. Ces crons sont des jobs
`pg_cron` **runtime** (pas dans les migrations du repo) → sans ce doc ils seraient
« invisibles ». Détail technique complet des correctifs : `MOVIES-SERIES-PAGES-AUDIT.md`
(Lots 4 / 4b / 4c).

## Changelog de session (déployé sur `main`)

| PR | Sujet |
|----|-------|
| #124 | Audit + fix pages Movies/Series (rails genre + barre de filtres) |
| #127 | Matcher TMDB français (recherche `fr-FR` + année + scoring bi-titre) |
| #131 | Grille plate sert le poster frais de `cloud_titles` + onerror fiche détail |
| #132 | Fiche détail : overview global depuis `catalog_titles` (thinning) |
| #133 | **Dédup Movies/Series** : identité canonique + `dedup_key` + RPC dédup serveur |
| #134 | RPC `norva_reconcile_catalog` (garde l'identité canonique) |
| #135 | Posters frais depuis `catalog_titles` (data + overlay autoritaire) + versions fiche |
| #136 | Doc audit Lot 4 |
| #137 | Auto-bascule sur la version suivante quand un flux est mort (`RANGE_UNSUPPORTED`) |
| #139 | Scroll molette de la fiche Series (modèle mono-scroller) |
| #140–#143 | **Sous-titres in-band instantanés** (cause racine énumération mal placée) + doc |

## RPC (dans les migrations — durables)

| Fonction | Rôle | Migration |
|----------|------|-----------|
| `norva_canonicalize_titles_for_user(uuid\|null)` | fusionne les titres partageant un `provider_tmdb_id` sous des `identity_key` différents → 1 titre canonique `tmdb:<id>` | `20260704200000` |
| `norva_backfill_media_identity(uuid\|null, p_limit)` | `cloud_media_items.dedup_key` = identité du titre lié + propage tmdb & poster ; **+ recompute `is_dedup_primary`** des groupes touchés (maintenance dédup) | `20260704200500` → `210000` → `270000` |
| `list_media_items_deduped(...)` | grille plate : dédup **précalculé** (`is_dedup_primary`) → index scan borné à toute taille ; vues filtrées source/genre = routage par estimation | `20260704201000` → `250000` → `271000` |
| `catalog_item_estimate(uuid, text)` | taille estimée d'un `(user,item_type)` via le **planner** (instantané) — routage gros/petit compte sans `count(*)` | `20260704250000` |
| `norva_recompute_dedup_primary(uuid\|null, p_limit)` | marque **1 représentant** par groupe `dedup_key` (`is_dedup_primary`) — backfill idempotent borné | `20260704270000` |
| `norva_refresh_posters_from_catalog(uuid\|null)` | `cloud_titles.poster_url` ← `catalog_titles` (source enrichie fraîche) | `20260704203000` |
| `norva_reconcile_catalog(uuid\|null)` | = canonicalize → refresh_posters → backfill_media_identity (tout idempotent) | `20260704202000` + `…203000` |

## Crons pg_cron (runtime — NON versionnés)

| jobid | jobname | schedule | rôle | portée actuelle |
|-------|---------|----------|------|-----------------|
| 12 | `norva-enrich-search-match` | `*/3 * * * *` | matching TMDB des titres non matchés (`/cron/search-match?limit=1000&conc=15`) | **global** — dé-épinglé le 2026-07-05 (cf. « Incident 2026-07-05 ») |
| ~~84~~ | ~~`norva-enrich-guardian-revert`~~ | — | garde-fou de revert du job 12 | **SUPPRIMÉ** le 2026-07-05 (cassé — `permission denied`, cf. « Incident 2026-07-05 ») |
| 85 | `norva-catalog-reconcile` | `3-59/20 0-6 * * *` | `set statement_timeout='600s'; norva_reconcile_catalog(null, 3000)` — canonicalize + posters + `dedup_key` + recompute `is_dedup_primary` des groupes touchés (résilient, advisory-lock, batché) | **global, nuit only** — timeout 600s + cadence /20 depuis 2026-07-05 (cf. « Incident 2026-07-05 ») |

Note (obsolète depuis 2026-07-05) : le job 12 fut un temps **focalisé jeremy**
(`&user=0b971271-…`) pour drainer son backlog en premier, avec le garde-fou job 84 censé le
repasser en global une fois jeremy drainé. Le garde-fou était **cassé** → job 12 resté bloqué
sur jeremy (voir l'incident du 2026-07-05). Depuis, job 12 est **global** et le dedup de la
grille plate ne dépend plus du drain (il est **précalculé** via `is_dedup_primary` — cf.
`CATALOG-SPEED-AUDIT-2026-07-04.md` §1).

## Généralisation — LANCÉE (2026-07-04, batché)

⚠️ **La volumétrie réelle est bien plus grande que prévu** : 2 comptes énormes
(**570k** + **273k** media items ; ~419k + ~93k titres). Total **~925k media items** à
backfiller (`dedup_key`), impossible en une seule requête (timeout + transaction géante).

`cloud_titles` a un trigger de mirror `AFTER UPDATE … FOR EACH STATEMENT` vers
`catalog_titles`, et `cloud_media_items` un trigger `cmi_set_sort_cols` par-ligne → les
UPDATE en masse coûtent ~1 ms/ligne. Un run de reconcile 10k ≈ 70-100 s **côté serveur**
(pg_cron n'a pas la limite 60 s du client MCP).

**Ce qui a été fait :**
- RPC `norva_backfill_media_identity` / `norva_refresh_posters_from_catalog` rendus
  **batchés** (param `p_limit`) — migration `20260704210000`. Les anciennes signatures
  1-arg sont **DROP**ées (sinon un appel 1-arg est ambigu, « function is not unique »).
- `norva_canonicalize_titles_for_user(null)` exécuté → **0 doublon de titre global**.
- Cron **job 85 en global batché** : `norva_reconcile_catalog(null, 10000)` à `*/3` →
  draine les ~825k media items en **~4 h** (background). Chaque run : canonicalize (0
  maintenant) + refresh 10k + backfill 10k.
- Le search-match (job 12) repasse en global via le garde-fou (job 84) < 300 éligibles.

**Suivi du drain :**
```sql
select count(*) filter (where dedup_key is null) as media_backlog,
       count(*) as media_total
from cloud_media_items;
-- + runs récents : select status, start_time, end_time from cron.job_run_details
--   where jobid=85 order by start_time desc limit 5;
```

**Une fois drainé** (`media_backlog` ≈ 0) : le reconcile reste en global (maintien).
Pour accélérer le drain, élargir la fenêtre (ex. `1-59/3 * * * *` = 24/7) — à ne faire
que si le Home reste instantané sous la charge.

## Incident 2026-07-04 : le drain global saturait le Home (corrigé)

Passer le job 85 en global `10000`/`*/3` **24/7** a saturé l'I/O de la base : le Home
restait bloqué sur ses skeletons (Continue Watching / Selection Norva). Deux causes,
deux correctifs durables :

1. **Le reconcile lui-même** — chaque run faisait un UPDATE 10k sur `cloud_media_items`
   (trigger `cmi_set_sort_cols` par-ligne ~7-10 ms) → 120 s de churn de `shared_buffers`
   en continu, plus des runs qui **se chevauchaient** (deadlock sur l'index unique
   `identity_key` contre le search-match job 12, tous deux `*/3` → même minute) et des
   **statement_timeout** (canonicalize non batché = 0 progrès sur timeout).
   → migration `20260704220000_resilient_reconcile.sql` :
   - `norva_canonicalize_titles_for_user(uuid, p_limit)` **batché** + **savepoint par
     groupe** (un deadlock transitoire saute 1 groupe, pas tout le run) ;
   - `norva_reconcile_catalog` prend un **advisory lock** (`pg_try_advisory_lock`) →
     jamais deux runs en //, et **wrap chaque étape** (un échec ne perd pas les autres) ;
   - défaut batch 5000. Cron rappelé en **`1-59/3 0-6`** (nuit only) + batch **3000**.

2. **Le Home appelait `top_viewed_titles()` en live** (rail « Selection Norva »/Top 10).
   La fonction joignait `cloud_watch_history` ⋈ `cloud_title_variants` (755k) ⋈
   `cloud_titles` avec `v.external_id in (h.item_id, h.parent_item_id)` — ce IN sur deux
   colonnes de la ligne externe empêchait l'usage de l'index `(source_id, item_type,
   external_id)` → **seq scan 755k** à chaque chargement (>60 s cache froid).
   → migration `20260704221000_top_viewed_fast.sql` : réécrit en **LATERAL** pour driver
   depuis les ~90 lignes d'historique et Index-Scanner les variantes (`external_id =
   ANY(array)`). Coût 382, **>60 s → ~220 ms**. Sémantique identique, aucune modif edge.

**Leçon** : tout drain de masse global doit être **advisory-locked, batché petit, et
fenêtré la nuit** ; et aucun rail Home ne doit exécuter d'agrégat non-indexé en live.

## Incident 2026-07-05 : timeouts intermittents reconcile + dashboard (corrigé)

**Symptôme** : dashboard admin « 163 échecs 24 h » — `norva-catalog-reconcile` (jobid 85, 121
échecs) et `admin-dashboard-refresh` (jobid 60, 16 échecs), tous `ERROR: canceling statement
due to statement timeout`. **Sans lien avec les Phases i18n 3-5** (aucun échec ne référence les
nouveaux objets ; 0 échec après leur déploiement 15:25 UTC ; les 2 jobs échouaient déjà la veille).

**Cause racine** : le `statement_timeout` **par défaut de la base est 120 s**, et un job pg_cron
`select fn()` hérite de cette valeur. Les deux requêtes ont grossi avec le catalogue et tournent
désormais **~116 s** — juste sous la limite — donc elles **échouent par intermittence** dès que la
contention diurne les pousse au-delà de 120 s (mesuré : reconcile 115,8 s, dashboard 115,8 s).

- **Reconcile** : `norva_backfill_media_identity` construit un `temp table` en joignant
  `cloud_media_items` (948k) × `cloud_title_variants` (720k) × `cloud_titles` (584k) avec un
  filtre **non-sargable** (`mi.dedup_key is distinct from ct.identity_key OR …`) puis `LIMIT 3000`.
  Le backlog étant quasi drainé, trouver 3000 candidats **scanne la quasi-totalité** du join.
  (Ni bloat — dead < 6 % — ni index manquant : coût inhérent d'un scan à candidats rares.)
- **Dashboard** : `refresh_admin_dashboard()` agrège `cloud_titles`/variants sur les comptes
  enrichisseurs (catalogues énormes). Son `set local statement_timeout to '180s'` **interne est un
  no-op** : un `SET LOCAL` dans une fonction **ne ré-arme pas** le timer de l'instruction externe
  déjà lancée → elle mourait quand même à 120 s.

**Correctif** (runtime, `cron.alter_job` — non dans les migrations, comme le reste de ce doc) :
le seul endroit fiable pour lever le timeout est **la commande cron, AVANT** l'appel de fonction.
```sql
-- reconcile (85) : 600s + cadence /20 (advisory-locké de toute façon → /3 empilait des skips)
select cron.alter_job(85, schedule => '3-59/20 0-6 * * *',
  command => $j$set statement_timeout='600s'; select norva_reconcile_catalog(null, 3000);$j$);
-- dashboard (60) : 300s avant l'appel (le SET LOCAL interne ne suffit pas)
select cron.alter_job(60,
  command => $j$set statement_timeout='300s'; select public.refresh_admin_dashboard();$j$);
```
**Vérifié en prod** (one-shots) : les deux **réussissent** en ~116 s, avec 2,6×–5× de marge.

**Suivi / si ça revient** : ces requêtes sont désormais bornées, pas optimisées — elles
grossissent avec le catalogue. Si un run repasse près de son plafond, le vrai fix est de rendre
la recherche de candidats **sargable** (marqueur « dirty » à la `*_attempted_at`, pour ne plus
re-scanner les lignes déjà réconciliées) plutôt que de relever encore le timeout.

Vérification post-généralisation :
```sql
-- doublons d'identité restants (attendu ~0)
select coalesce(sum(n-1),0) from (
  select count(*) n from cloud_titles where provider_tmdb_id is not null
  group by user_id, item_type, provider_tmdb_id having count(*)>1) d;
```

## Incident 2026-07-05 : enrichissement Ninja « bloqué » + échecs cron

Constat admin : le compte `projethorizon2030` (mega, source **Ninja** — `976e7bbd…`,
172k films) affichait un enrichissement à ~0,6 % / **~266 j** d'ETA, et le dashboard listait
**~40 échecs / 24 h**. Diagnostic : **deux enrichissements distincts**, à ne pas confondre.

### 1. Match TMDB (posters/métadonnées/dédup) — vrai bug, corrigé

Le job 12 était resté **épinglé sur jeremy** (`&user=0b971271…`) alors que jeremy est
**100 % matché (0 éligible)** → il tournait à vide pendant que **les ~395k titres du mega
n'étaient jamais matchés** (0 tentative en 6 h). Le garde-fou (job 84) censé le repasser en
global échouait **toutes les 10 min** : il faisait un `UPDATE cron.job …` direct → `ERROR:
permission denied for table job` (Supabase interdit l'UPDATE direct de `cron.job`, il faut
`cron.alter_job`). D'où ~25 échecs/jour à lui seul.

**Correctif (live, via la voie autorisée) :**
```sql
-- repasser le search-match en GLOBAL (retire &user=…), la voie que le garde-fou ne pouvait pas prendre
select cron.alter_job(12, command := ' select net.http_post( url := ''…/cron/search-match?limit=1000&conc=15'', … ); ');
-- supprimer le garde-fou cassé (son rôle est accompli : jeremy drainé + job 12 global)
select cron.unschedule('norva-enrich-guardian-revert');
```
Ceci **restaure l'état voulu par la migration `20260704180000`** (qui définit déjà job 12 en
global) ; l'épinglage + le garde-fou étaient des ajouts live ad-hoc, non versionnés → rien ne
les recrée au déploiement. **Vérifié** : le mega passe de 0 → **~949 tentatives / 20 min**
(~68k/j), backlog en baisse → drain en **~6 j** au lieu de « jamais ». Même cadence qu'avant
(pas de risque anti-ban supplémentaire).

### 2. Enrichissement AUDIO (le « 266 j » du dashboard) — anti-ban, **volontaire**

C'est un **autre** sous-système : les crons `norva-audio-airo-ninja` (job 79, films) /
`-series` (job 80) appellent `norva-playback/audio-backfill` en **`concurrency=1, limit=12`,
toutes les 12 min**. Chaque sonde **ouvre un vrai flux** chez le provider (ffprobe des pistes
audio) → une à la fois, espacées, pour **ne pas faire bannir le compte Ninja**. Au rythme
sûr : ~579 films/j → ~266 j pour 153k. **La lenteur est délibérée et correcte.** L'accélérer
(monter `concurrency`/`limit`/fréquence) = **risque de ban provider** → décision produit, pas
un bug. Le « 266 j » est l'ETA honnête (`never_probed / probed_24h`) affichée par le dashboard.

### 3. Échecs cron restants (non fataux)

Après suppression du garde-fou, les ~40 échecs/24 h tombent à ~15, tous des **timeouts
auto-réparants** :
- `admin-dashboard-refresh` (job 60) : timeout d'agrégation → **corrigé** par un index couvrant
  (`idx_ctv_id_source`), fonction ~120 s → **~40 s**. Détail : `CATALOG-SPEED-AUDIT-2026-07-04.md`.
- `norva-catalog-reconcile` (job 85) : timeout du backfill média la nuit → **résilient** (chaque
  étape isolée en exception, reprend au tick suivant). Non bloquant.

## Remise en état / arrêt (si besoin)

```sql
select cron.unschedule('norva-catalog-reconcile');      -- stop reconcile
-- job 84 (garde-fou) déjà supprimé le 2026-07-05 — ne plus le recréer (utiliser cron.alter_job).
-- job 12 : cron.alter_job(12, schedule := '*/5 * * * *') pour revenir au rythme d'origine ;
--          pour re-focaliser un compte : cron.alter_job(12, command := '…?…&user=<uuid>…')
--          (JAMAIS d'UPDATE cron.job direct → permission denied — règle du Supabase MANAGÉ).
-- ⚠ Self-host Hetzner (2026-07-16) : c'est l'INVERSE — cron.alter_job y échoue même en
--   superuser (« Job N does not exist or you don't own it », garde username = current_user,
--   jobs recréés sous un autre rôle) ; utiliser l'UPDATE direct de cron.job (le trigger
--   cron.job_cache_invalidate notifie le launcher). Cf. ops/hetzner/scripts/09-reopen-probe-windows.sql.
```
