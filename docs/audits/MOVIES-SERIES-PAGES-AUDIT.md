# Audit des pages Movies & Series — rails par genre + barre de filtres (2026-07-04)

**Déclencheur.** Capture utilisateur de la page Series : « Carol and the End of the World »
présent dans 3 lignes, plusieurs titres dupliqués entre lignes, lignes Comedy et
Thriller & Crime à 2 cartes alors que le catalogue contient bien plus de VOD par
catégorie. Et une barre de filtres « pas optimale » : les menus Audio/Sous-titres ne
reflétaient pas les pistes réellement disponibles dans le catalogue en temps réel.

**Méthode.** 2 enquêteurs parallèles (MoviesPage.js 2159 l. / SeriesPage.js 2484 l.) +
lecture directe du backend `norva-catalog` (listGenreRails, listGenreItems,
listMediaItems, listLanguageFacets) et de la taxonomie `_shared/genre-taxonomy.ts`.
Les deux pages sont des copies quasi identiques — tous les correctifs sont appliqués
aux deux ; les correctifs serveur profitent aux deux automatiquement.

## Causes racines (écran de l'utilisateur)

| Symptôme | Cause | Fix |
|---|---|---|
| Lignes à 1-2 cartes malgré un gros catalogue | `listGenreRails` scannait **les 2000 titres les plus récemment synchronisés** (une seule requête) ; une ligne = les seuls titres du bucket dans cette fenêtre | scan paginé avec early-exit : on continue de paginer (par 2000, cap 12 000) tant qu'un bucket découvert n'a pas de quoi remplir sa ligne |
| Même titre dans 3+ lignes | `classifyTitleBuckets` est multi-bucket (voulu, façon Netflix) mais **aucun budget de dédoublonnage inter-lignes** : chaque titre était poussé dans TOUTES ses lignes | affectation en 2 passes : passe 1 = 1 ligne par titre (première ligne non pleine) ; passe 2 = complément des lignes courtes, **max 2 apparitions par titre** |
| Lignes « croupions » | une ligne à 1 carte était émise telle quelle | seuil minimal : une ligne < 4 cartes n'est pas émise (le genre reste accessible via le sélecteur de genres, dont les compteurs viennent de `genre-summary`) |
| Ordre des lignes remélangé à chaque resync | tri `synced_at` (bousculé par les resyncs provider) | tri intra-ligne par `created_at` (immuable, « nouveau dans TON catalogue ») — même règle que le fix Home |

## Filtres : constats & correctifs

### Audio / Sous-titres « pas en temps réel »
- Le serveur expose déjà des **facettes dynamiques exactes** (`/media-language-facets` :
  présence réelle par langue via `version_languages` + `audio_languages`, memo 60 s).
- Mais le client empilait 3 caches : localStorage **10 min** + memo serveur 60 s + CDN 60 s,
  et l'intervalle de refresh de la page était **10 min** (le commentaire disait « near-real-time »).
  → localStorage aligné à **60 s**, intervalle page **60 s**. Pire cas ~3 min au lieu de ~20.
- `app.html` embarquait des options **codées en dur (fr/en/ar)** qui restaient affichées
  avant le premier fetch et à jamais en cas d'échec → supprimées ; seul le placeholder
  « Any Audio / Any Subtitles » est statique, les options viennent du catalogue réel.
- En mode local (self-hosted), ces 2 menus étaient des **filtres morts** (aucune donnée de
  langue) → ils sont masqués dans ce mode.

### Year / Rating / Added ne filtraient (presque) rien à l'échelle
- En grille cloud, seuls `type/sourceId/categoryId/sort/q/limit/offset` partaient au serveur ;
  Year/Rating/Added étaient filtrés **côté client sur les pages déjà chargées (120)** :
  sur un catalogue de 100k+, « Rating 8+ » égouttait des pages quasi vides une à une.
  → nouveaux paramètres serveur sur `/media-items` : `year` (décennie), `minRating`,
  `addedDays` — en SQL sur les colonnes dénormalisées (`release_year`, `rating_num`,
  `added_at`), donc sur TOUT le catalogue. Le client ne re-filtre plus ces dimensions en
  cloud (son heuristique année-du-nom pouvait contredire la colonne serveur).
- Dans la vue bucket de genre (« See all ») et la grille langue, Year/Rating étaient
  **ignorés silencieusement** → `media-genre-items` accepte maintenant `year` + `minRating`
  (l'année est aussi pré-filtrée en SQL pour que la fenêtre de 6000 candidats serve au set
  réellement filtrable) ; les params font partie de la clé de re-render du bucket, donc
  changer Year/Rating dans un bucket ouvert recharge la grille.

### Autres défauts UX corrigés
- **« ‹ All genres » effaçait les filtres langue** de l'utilisateur en sortant d'un genre →
  il ne les efface plus (routage via `onFiltersChanged` : genre quitté + audio actif → grille
  « All movies/series » filtrée langue) ; quitter la grille langue elle-même les efface
  (sinon elle se rouvrirait en boucle).
- **Compteur de résultats** : la vue bucket n'affichait aucun compte → affiche le `count`
  exact du serveur. La grille cloud n'affichait le total exact **que sans aucun filtre** →
  affiche le total serveur exact tant que seuls des filtres server-side sont actifs
  (search/sort/year/rating/added) ; « N+ » réservé aux filtres client-only
  (watched/duration/genre TMDB/favoris/hide-broken off).
- **Course d'affichage bucket** : `loadBucketPage` n'avait aucun jeton de requête — changer
  de genre pendant un fetch pouvait mélanger deux genres dans la même grille → jeton
  `bucketRequestId` + garde DOM.
- **Doublons de pagination bucket** : l'offset serveur sur catalogue vivant peut re-servir
  une ligne de bordure → dédoublonnage client par identité de titre (`bucketSeen`).
- **Shell obsolète servi en prod** : `public/app/index.html` (copie figée d'il y a des
  semaines, sans les menus audio/sous-titres ni `lang-match`) était servi sur
  **`norva.tv/app/`** (avec slash — atteignable depuis les liens `/app#home` de
  subscribe/checkout selon la normalisation du navigateur) → supprimé + redirect
  `/app/ → /app` dans `_redirects`. Test `vod-playback-matrix` mis à jour (une seule entrée).

## Lot 2 — cause racine des lignes vides + compteur « 819 mais 4 affichés »

Un signalement utilisateur (« Adventure · 819 » au menu mais 4 films à l'écran) a
révélé la **vraie cause de fond** des lignes quasi vides — plus profonde que la fenêtre
de récence du lot 1. Prouvé en base (compte de 71 007 films) :

- Le **compteur** du menu (`cloud_genre_summary`) agrège **tout** le catalogue. La
  **grille** et les **rails** classaient en mémoire une fenêtre des ~6000 titres les plus
  récemment synchronisés. Des 204 films « Adventure » réels, **181 sont hors de cette
  fenêtre** ; et 96,5 % de la fenêtre récente a `genre_payload = NULL` (titres fraîchement
  synchronisés, pas encore enrichis TMDB) — le signal genre y est donc quasi absent.
  Résultat : ~4-30 affichés vs 351-819 réels. (Le lot 1 atténuait via un scan paginé mais
  restait borné par la récence et détoastait `metadata`.)

**Correctif de fond (migration `20260704160000` + réécriture edge) :**
- Nouvelle colonne dénormalisée **`cloud_titles.genre_buckets text[]`** = l'ensemble des
  buckets d'un titre, calculée par un **port SQL fidèle** du classifieur TS
  (`norva_classify_buckets`, garde-fou exception → jamais de write cassé), **indexée GIN**.
  Grille, rails et compteur filtrent désormais `genre_buckets @> {bucket}` sur **tout le
  catalogue** via l'index (plan BitmapAnd, ~16 ms sur 71k).
- Port **validé sur données réelles** : les comptes par bucket via `norva_classify_buckets`
  égalent le résumé edge (Adventure = **351**, exactement) ; un bug d'append littéral plpgsql
  (`|| 'arabe'` casté en tableau) qui faisait tomber toutes les catégories arabe / animation /
  k-drama en `autres` a été trouvé et corrigé (arabe repassé de 0 à 9777).
- `listGenreItems` : filtre 100 % SQL (`genre_buckets`, langue, année `release_year`, note
  `rating_num`, genres masqués `NOT genre_buckets && hidden`) + **comptage exact** (`count:exact`)
  + pagination réelle (`.range`). Le tri « Best for my languages » garde un rang en mémoire borné.
- `listGenreRails` : une requête indexée **par bucket** (les N plus récents par `created_at`),
  budget anti-doublon inter-lignes conservé, détoast `metadata` limité aux seuls ids retenus.
- `listGenreSummary` : nouvelle RPC `cloud_genre_bucket_counts` (comptes **navigables**,
  `variant_count>0`) → le compteur du menu = ce que la grille affiche réellement.
- Colonne **`rating_num`** dénormalisée (backfillée depuis `catalog_titles`, la note TMDB
  étant thinnée hors de `cloud_titles`) pour que le filtre Note soit un vrai prédicat SQL.
- Trigger `cloud_titles_sync_genre_cols` étendu : recalcule `genre_buckets` + `rating_num`
  à chaque écriture de `metadata` (nouvelles fiches classées à la synchro, sans latence).
- Test de parité `tests/genre-taxonomy-parity.test.js` : verrou anti-drift entre les 3 copies
  du classifieur (TS edge / JS navigateur / SQL). **Backfill : 576 k lignes, index GIN valide.**

## Lot 3 — posters manquants = backlog d'enrichissement TMDB (pas un bug d'affichage)

Une fois le catalogue complet exposé par bucket, beaucoup de cartes montraient le
placeholder « N ». Cause prouvée en base : ce ne sont PAS des images cassées — ce sont des
titres `match_status = 'unmatched'` (aucun rapprochement TMDB → aucun poster / titre pollué
type « 47 Ronin (FHD MULTI) », « Percy Jackson (SD VF) »). Or **459 311 titres navigables
(98,6 % des non-matchés) n'avaient JAMAIS été tentés** par le cron search-match. Ces films
sont pourtant sur TMDB (47 Ronin = id 64686, score de match ~0.92) — ils n'avaient
simplement jamais été atteints, le cron tournant à 300/run × 24/j = ~7,2k/j (≈ 65 j de retard).

**Correctifs :**
- **Cron search-match accéléré** (`norva-source-sync` + migration `20260704180000`) :
  plafonds edge 300→1500 / conc 20→30, filtre `variant_count>0` (zéro appel TMDB gâché sur
  les entrées mortes), planification `limit=1000 conc=15 */5 0-11 * * *` (~144k titres/j) →
  le backlog de ~459k se vide en **~3-4 jours** (budget TMDB ~5 req/s moyen, sous les 50 req/s).
  Le `searchTmdbMatch` nettoie déjà les suffixes (`cleanSearchQuery`), donc ces titres
  matchent dès qu'ils sont atteints. Kick manuel au déploiement pour démarrer tout de suite.
- **Affichage posters-first (non destructif)** dans `norva-catalog` : la grille « See all »
  ordonne les titres AVEC poster d'abord (`poster_url` non-null), la longue traîne
  non-enrichie passe en fin (rien n'est masqué, le compte reste le total navigable) ; les
  **rails** de genre ne montrent que des titres avec poster (aperçu curé). Au fil de
  l'enrichissement, les blancs se remplissent tout seuls.

## Portée : web ET Android (TV + mobile)
Les apps Android sont des **wrappers WebView natifs** (`clients/android-phone`,
`clients/android-tv`) qui chargent le site live `norva.tv`. Donc : (1) les correctifs
**backend/edge** (`norva-catalog`) touchent Android instantanément — même endpoint pour tous ;
(2) les correctifs **frontend** (MoviesPage/SeriesPage/api.js/app.html) arrivent aussi
instantanément dès le déploiement Cloudflare Pages, **sans nouvel APK**, pour le téléphone et
la TV en mode cloud (défaut). Seule exception : le mode TV « standalone » (opt-in avancé) sert
un snapshot de `public/` figé dans l'APK → n'a les correctifs front qu'après un nouveau build.

## Vérifié correct (aucun changement)
Le clic sur une carte de rail réutilise le chemin fiche de la Home (versions groupées) ·
« See all » par genre pagine bien tout le genre (fenêtre 6000) · les facettes serveur
étaient déjà exactes et memoïsées · `hidden_genres` par profil respecté partout (rails,
buckets, summary) · dédoublonnage par `sourceId:stream_id` de la grille plate ·
persistance/restauration des filtres par page.

## Backlog (non bloquant)
1. **Random** ne pioche que dans les cartes déjà chargées (pas tout le catalogue) et reste
   désactivé en vue rails/bucket — un endpoint « titre au hasard » serveur serait mieux.
2. Le MultiSelect de genres n'utilise que la **première** sélection en cloud
   (`buckets[0]`) — multi-genre ignoré silencieusement.
3. « Hide broken » / « Group duplicates » sont inertes en vues rails/bucket (le serveur ne
   connaît pas PlaybackHealth ; les rails sont déjà groupés par titre) — à clarifier dans
   l'UI ou à câbler serveur.
4. Le select « Genre (TMDB) » (`populateGenres`) n'est construit que depuis les pages
   chargées en cloud → liste incomplète/instable ; doublonne le sélecteur de buckets.
5. Filtre **Duration** : exclut les titres sans `tmdb.runtime` quand actif ; pas de
   colonne dénormalisée → reste client-only.
6. `watched`/`favorites` restent client-only (nécessitent l'historique / la liste de favoris
   côté requête serveur).
