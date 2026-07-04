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
