# Audit de vitesse catalogue — banc d'essai plus gros compte (2026-07-04)

Test de charge mené sur le **plus gros compte** (`projethorizon2030@gmail.com`,
`7bdab1df-…`) pour dériver l'optimisation la meilleure pour **tous les types d'user**.
Volume au moment du test (import encore en cours) :

| table | ce compte | table entière |
|-------|-----------|---------------|
| `cloud_titles` | 334 712 films + 84 921 séries | ~582k |
| `cloud_media_items` | 383 634 films + 93 579 séries + 93 538 live | ~909k |
| `cloud_title_variants` | — | ~755k |

Ce compte représente à lui seul **72 %** de `cloud_titles` et **63 %** de
`cloud_media_items` → pire cas absolu.

## Méthode

Un workflow d'énumération (5 agents) a tracé **chaque** requête DB des chargements
initiaux Home / Movies / Series / fiche, traduite en SQL concret lié à ce compte, puis
classée par coût. Chaque requête a ensuite été mesurée en `EXPLAIN (ANALYZE)` réel.

## Correctifs livrés

| # | Requête | Déclencheur | Avant | Après | Fix |
|---|---------|-------------|-------|-------|-----|
| #154 | `listVerifiedTitleCandidates` (rails populaire / genre / because) | Home ×5 | **>90 s** (timeout) | **0,3 s** | `idx_cloud_titles_home_verified` (partiel `match_status='provider_verified' and variant_count>0`, ordonné `synced_at desc`) |
| #155 | `list_media_items_deduped` (grille Movies/Series) | Movies/Series (tri/filtre/all) | **3,3 s** | **14–67 ms** | `catalog_item_estimate()` (routage par estimation planner, instantané) + `total=null` sur gros comptes + `idx_cmi_sort_rating` |
| #156 | rail « Ajouts récents » (`listTitleRail`, tri `created_at`) | Home ×2 | tri complet **188k** | **19 ms** | `idx_cloud_titles_recent` (partiel `variant_count>0`, ordonné `created_at desc`) |
| #156 | garde `cloud_genre_bucket_counts` | Movies/Series ×2 | `count(*)` **~3,8 s** | **47 ms** | garde par `catalog_item_estimate()` |
| #158 | grille plate dédup — comptes moyens (~20–60k) | Movies/Series (tri/filtre) | **~31 s** (jeremy 53k) | **47 ms** | `is_dedup_primary` précalculé (voir §1) |
| #160 | `refresh_admin_dashboard()` (dashboard admin) | cron ×1/10 min | timeout **120 s** (~9 échecs/24 h) | **~40 s** | `idx_ctv_id_source` (`(id) INCLUDE source_id`) → couverture + rollup en index-only (voir §3) |

### La technique clé : `catalog_item_estimate()`

Compter un sous-ensemble d'un compte à 380k lignes coûte plusieurs secondes (index scan
complet), et c'est pire pendant un import (visibility map sale → heap fetches). Or les deux
usages du comptage — (a) décider « gros/petit compte » pour router, (b) le libellé cosmétique
« N titres » — n'ont pas besoin d'exactitude. `catalog_item_estimate()` lit l'estimation du
**planner** (`EXPLAIN … → Plan Rows`, via `pg_statistic`) : **instantané**, **~5 % près**
(365 687 estimé vs 383 634 réel), robuste pendant l'import. Le libellé exact est abandonné
sur gros comptes (« N+ titres », déjà géré côté client) plutôt que payé en scan.

## Vérifié sain (pas de correctif nécessaire)

- `top_viewed_titles` (rail populaire) : **91 ms** — le fix LATERAL de #146 tient.
- Rails de genre (×15/chargement Movies/Series) : bornés par le GIN `genre_buckets @>`
  (~6k lignes/bucket action) → ~100–300 ms/bucket, acceptable.
- Fan-out variantes (`listVariantsByTitleIds`) : servi par `idx_cloud_title_variants_title_cost`.
- Facettes de langue (25 `count(*)`/chargement à froid) : mémoïsées 60 s serveur + client, et
  sur un **endpoint séparé non bloquant** (la grille s'affiche sans les attendre).

## §1. Grille plate dédup — comptes moyens (~20–60k items) — RÉSOLU (#158)

`list_media_items_deduped` dédupliquait **au moment de la lecture** (scan de tout le compte,
`distinct on dedup_key`). Mesuré sur `0b971271` (jeremy, 53 393 films) : **~31 s pendant 3
imports concurrents** (saturation I/O) → dépassait le statement timeout. (Pré-existant, non
régressé ; et ce n'est pas le chemin par défaut — Movies affiche les rails de genre, la grille
plate ne sort qu'au tri/filtre.)

**Fix propre choisi (option B) : drapeau `is_dedup_primary` précalculé.** Un représentant par
groupe `(user, item_type, dedup_key)` est marqué ; la grille par défaut le filtre → **index
scan borné à toute taille**, dédup exact conservé. Détails :

- Colonne `is_dedup_primary` (défaut `true` = ne cache jamais de contenu ; rollout sûr).
- Trigger `cmi_set_sort_cols` : early-exit → updates de drapeau gratuits (était ~7–10 ms/ligne).
- `norva_recompute_dedup_primary()` (backfill idempotent borné) + recalcul **incrémental**
  des groupes touchés dans le drain reconcile `norva_backfill_media_identity` (maintenance).
- `total` = null sur ce chemin (le client affiche « N+ titres » puis le compte exact groupé
  une fois chargé) → aucun scan de comptage.
- **Nuance** : le primary est un représentant **global**, donc incompatible avec un filtre
  **source/genre** (qui partitionne les copies d'un film) ; ces vues gardent le routage par
  estimation de #155.

Mesures : jeremy 31 s → **47 ms** (default), 10,8 s → **111 ms** (rating) ; c5be5ac4 séries
48k → **18 ms**. Backfill + convergence (0 bad group) sur les 3 comptes.

### 2. Compteurs de genres sur gros comptes

Le sélecteur de genres ne montre pas de compteurs pour les gros comptes (garde qui renvoie
0). Les **rails** de genre et la grille par genre fonctionnent (GIN). Restaurer les compteurs
demanderait un cache de comptages (même stratégie que B ci-dessus).

## §3. Dashboard admin — timeouts éliminés (#160, 2026-07-05)

`refresh_admin_dashboard()` (cron `admin-dashboard-refresh`, toutes les 10 min) échouait
~9×/24 h en `statement timeout`. Sa requête de **couverture** et son **rollup par source**
résolvent chacun le « panel » d'un titre via `default_variant_id → cloud_title_variants.source_id`.
Sans index couvrant, le planner construisait son hash à partir d'un **seq scan complet du heap
des ~755k variantes** (larges) — l'I/O dominante — et sous la contention des imports la fonction
dépassait son budget.

**Détail piégeux** : le `set local statement_timeout='180s'` **interne à la fonction est
inopérant** — `statement_timeout` est armé au *début* de l'instruction cron, avant l'exécution
de la fonction → le vrai budget est celui du rôle cron (**~120 s**, les échecs tombent pile à
120,1 s). Pour le rendre effectif, il faudrait le poser **côté commande cron**
(`set statement_timeout='300s'; select …`) ; un `set local` interne ne le pourra jamais.

**Correctif** : `idx_ctv_id_source = (id) INCLUDE (source_id)` → la couverture **et** les CTE
`tc`/`vc` du rollup passent en **Index Only Scan** (~25 Mo vs heap). Mesuré live, imports en
cours : couverture **100 s+ → ~10 s**, rollup **~21 s**, **fonction complète ~40 s** (2× sous le
budget). `source_id` est insert-only sur les variantes → maintenance d'index négligeable.
`idx_cmi_sort_rating`-style : construit en `CONCURRENTLY`, migration `IF NOT EXISTS`.

## Enrichissement / crons (contexte connexe)

Pendant cet audit, deux causes du dashboard « CRONS : 40 échecs / 24 h » ont aussi été traitées
(match TMDB Ninja épinglé sur un compte drainé + garde-fou cron cassé). C'est du **runtime
pg_cron**, documenté séparément dans `CATALOG-ENRICHMENT-CRONS-RUNBOOK.md` § « Incident
2026-07-05 » (dont : pourquoi l'enrichissement **audio** à « 266 j » est de l'**anti-ban
volontaire**, pas un bug).

## Portée Android

Tout est côté DB / edge → s'applique identiquement au web, à l'app Android TV et Android
mobile (même bundle web, mêmes edge functions). Aucun code natif concerné.
