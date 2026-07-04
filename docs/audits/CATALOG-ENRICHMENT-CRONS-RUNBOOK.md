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
| 85 | `norva-catalog-reconcile` | `*/5 * * * *` | `norva_reconcile_catalog('0b971271-…')` — refusionne + rafraîchit posters | **focalisé jeremy** |

Note : jobs 12/85 focalisés sur le compte de vérif (`jeremy`) — le dedup serveur
(`list_media_items_deduped`) est live pour **tous**, mais n'**agit** que là où `dedup_key`
est rempli. Les autres comptes voient donc la grille **inchangée** (zéro régression) tant que
la généralisation n'est pas lancée.

## Procédure de généralisation (au feu vert utilisateur)

Portée : **3 comptes** au total ; **515** doublons de titres globaux (petit).

```sql
-- 1. Reconcile one-shot pour TOUS les comptes (dédup + posters frais)
select norva_reconcile_catalog(null);

-- 2. Reconcile cron en global (retirer le uuid focalisé)
select cron.alter_job(85, command := $$select norva_reconcile_catalog(null);$$);

-- 3. (le search-match job 12 repasse en global tout seul via le garde-fou job 84
--     dès que l'éligible de jeremy < 300 — rien à faire manuellement)
```

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
