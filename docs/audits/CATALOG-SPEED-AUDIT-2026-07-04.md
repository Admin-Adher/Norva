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

## Points restants (non bloquants)

### 1. Grille plate dédup exacte — comptes moyens (~30–60k items)

`list_media_items_deduped` route les comptes < 60k vers le **dédup exact cross-page**, qui
doit lire **toutes** les lignes du compte (heap) pour regrouper par `dedup_key`. Mesuré sur
`0b971271` (jeremy, 53 393 films) : **~1–2 s à froid normal**, mais **~31 s pendant 3 imports
concurrents** (saturation I/O) → dépasse le statement timeout PostgREST.

Nuances importantes :
- **Ce n'est PAS le chemin par défaut** : la page Movies affiche par défaut les **rails de
  genre** (rapides). La grille plate ne se déclenche qu'au tri/filtre/recherche ou « tout voir ».
- Le dédup est **utile** à cette taille (jeremy : 41 297 lignes avec `dedup_key` → 25 214
  distincts, soit ~16k doublons regroupés) — on ne peut pas simplement le supprimer sans
  régression visuelle.
- Comportement **pré-existant** (avant #153 tous les comptes passaient par là), non régressé.

Options si on veut le traiter (décision produit) :
- **A. Baisser le seuil** (p.ex. 60k → ~25k) → comptes moyens sur le chemin rapide borné
  (instantané) + dédup **client** (efficace sur le tri par titre où les doublons sont
  adjacents). Perte : dédup cross-page exact + compteur exact pour les comptes 25–60k.
- **B. Pré-calculer un drapeau `is_dedup_primary`** par ligne (au sync/reconcile) + index
  partiel → la grille devient un index scan borné pour **toutes** les tailles, dédup exact
  conservé. Coût : vraie feature (colonne + backfill + maintenance sync).

### 2. Compteurs de genres sur gros comptes

Le sélecteur de genres ne montre pas de compteurs pour les gros comptes (garde qui renvoie
0). Les **rails** de genre et la grille par genre fonctionnent (GIN). Restaurer les compteurs
demanderait un cache de comptages (même stratégie que B ci-dessus).

## Portée Android

Tout est côté DB / edge → s'applique identiquement au web, à l'app Android TV et Android
mobile (même bundle web, mêmes edge functions). Aucun code natif concerné.
