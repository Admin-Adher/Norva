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
| `norva_backfill_media_identity(uuid\|null)` | `cloud_media_items.dedup_key` = identité du titre lié + propage tmdb & poster frais | `20260704200500` |
| `list_media_items_deduped(...)` | grille plate : pagine par **film distinct** (dédup cross-page) en gardant toutes les versions | `20260704201000` |
| `norva_refresh_posters_from_catalog(uuid\|null)` | `cloud_titles.poster_url` ← `catalog_titles` (source enrichie fraîche) | `20260704203000` |
| `norva_reconcile_catalog(uuid\|null)` | = canonicalize → refresh_posters → backfill_media_identity (tout idempotent) | `20260704202000` + `…203000` |

## Crons pg_cron (runtime — NON versionnés)

| jobid | jobname | schedule | rôle | portée actuelle |
|-------|---------|----------|------|-----------------|
| 12 | `norva-enrich-search-match` | `*/3 * * * *` | matching TMDB des titres non matchés (`/cron/search-match?limit=1000&conc=15`) | **focalisé jeremy** (`&user=0b971271-…`) |
| 84 | `norva-enrich-guardian-revert` | `*/10 * * * *` | quand l'éligible de jeremy < 300 → **retire `&user=` du job 12** (repasse global) puis **se supprime** | garde-fou, actif |
| 85 | `norva-catalog-reconcile` | `1-59/3 0-6 * * *` | `norva_reconcile_catalog(null, 3000)` — canonicalize + posters + `dedup_key` (résilient, advisory-lock, batché) | **global, nuit only** |

Note : jobs 12/85 focalisés sur le compte de vérif (`jeremy`) — le dedup serveur
(`list_media_items_deduped`) est live pour **tous**, mais n'**agit** que là où `dedup_key`
est rempli. Les autres comptes voient donc la grille **inchangée** (zéro régression) tant que
la généralisation n'est pas lancée.

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

Vérification post-généralisation :
```sql
-- doublons d'identité restants (attendu ~0)
select coalesce(sum(n-1),0) from (
  select count(*) n from cloud_titles where provider_tmdb_id is not null
  group by user_id, item_type, provider_tmdb_id having count(*)>1) d;
```

## Remise en état / arrêt (si besoin)

```sql
select cron.unschedule('norva-catalog-reconcile');      -- stop reconcile
select cron.unschedule('norva-enrich-guardian-revert'); -- stop le garde-fou
-- job 12 : cron.alter_job(12, schedule := '*/5 * * * *') pour revenir au rythme d'origine
```
