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
- **Matcher TMDB réparé pour les titres français** (`_shared/vod-title-projection.ts`,
  PR #127) : `searchTmdbMatch` cherchait en anglais → le candidat renvoyé portait le titre EN
  (« Gang Related »), scoré 0 % contre le titre FR du provider (« Flics sans scrupules ») →
  rejeté AVANT la validation (pourtant déjà multilingue). Fix : recherche en `fr-FR`, année
  extraite du titre quand `release_year` est null, scoring contre le titre localisé ET
  `original_title` (max), 2 passes (avec/sans année). **Prouvé en prod sur les 5 exemples
  utilisateur, tous matchés aux ids TMDB exacts** : 12→20714, Narnia Prince Caspian→2454,
  Le Prince de Sicile→9835, Hooligans 2→15809, Flics sans scrupules→14398. (Les échecs
  observés en test étaient des rate-limits TMDB transitoires dus au bombardement manuel,
  avalés par le `catch` du cron — pas un défaut du matcher.) 458k titres réarmés
  (`search_match_attempted_at=null`) pour repasser sous le matcher amélioré.
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

---

## Lot 4 — doublons de fiches (même film ×N) + posters périmés + versions manquantes (2026-07-04)

Écran utilisateur : un même film en **plusieurs cartes** (souvent une pleine matchée TMDB +
une « fantôme » vide avec un badge brut « PREFIX »), un **poster placeholder** alors que le
film a bien un poster, et **pas de sélecteur de versions** dans la fiche.

### Cause racine (tracée sur « Le Monde de Narnia : Le Prince Caspian », tmdb 2454)
Le provider FR liste réellement certains films **plusieurs fois** (ex. stream `32764` +
`13378`). Deux mécanismes empilés créaient les doublons :

1. **Identité dédoublée dans `cloud_titles`** — le cron search-match résout un `provider_tmdb_id`
   **sans re-clé** : il laisse coexister une ligne `identity_key = tmdb:<id>` (le provider a
   donné l'id) et une ligne `identity_key = norm:<titre>` (matchée après coup). Deux titres pour
   un film → deux cartes dans les rails de genre. Et le cron en **recrée en continu** (mesuré :
   ~770 nouveaux en 20 min pendant le drainage).
2. **Grille plate non dédupliquée** — elle lit `cloud_media_items` (une ligne par entrée
   provider) et ne groupait côté client que par `sourceId:stream_id`. Le jumeau **sans tmdb**
   n'héritait ni du poster ni du synopsis (le search-match n'écrit QUE dans `cloud_titles`,
   jamais dans `cloud_media_items`) → fiche « fantôme » + badge « PREFIX » (un tag de piste
   audio de `parseVersionInfo`, rendu brut faute de langue résolue).

Échelle (compte de vérif) : `cloud_titles` ~1 557 lignes-titres redondantes ; grille plate
**47 644 films → 35 333 après dédup** (~12 000 doublons) ; 7 122 fiches fantômes.

### Correctifs (PR #133, #134, #135)
**A. Canonisation de l'identité** — `norva_canonicalize_titles_for_user(uuid|null)`
(migration `20260704200000`). Fusionne chaque groupe `(user, item_type, provider_tmdb_id)` en
**un seul titre canonique `tmdb:<id>`** : variantes repointées (`cloud_title_variants.title_id`,
seule FK entrante), champs comblés par coalesce, lignes redondantes supprimées, re-clé APRÈS
delete (jamais de collision `(user_id, identity_key)`). Note : ne comble PAS les colonnes
tableau/probe (`audio_languages` text[]…) — re-dérivées par les crons de probe.

**B. Dédup serveur de la grille plate** — colonne **`cloud_media_items.dedup_key`** = identité
du titre lié (lien 1:1 vérifié : 47 644/47 644), index `(user_id, item_type, dedup_key)`
(migration `20260704200500`) + **propagation du tmdb** du titre vers `metadata.providerTmdbId`
(→ enrichit le jumeau fantôme). RPC **`list_media_items_deduped`** (migration `20260704201000`) :
**pagine par film distinct** (`distinct on (dedup_key)` → doublons collapsés même entre pages)
mais renvoie **toutes les lignes-versions** de chaque film de la page (`{items, films, total}`) ;
le client avance son curseur par `page.films` (MoviesPage/SeriesPage), regroupe par
`dedup_key`/tmdb → une carte, sélecteur de versions intact.

**C. Posters périmés** — le poster stocké (`cloud_titles` + `cloud_media_items`) pouvait être
**périmé** : TMDB fait tourner l'image, l'ancien chemin **404** (placeholder). `catalog_titles`
(source enrichie globale) a le bon. Prouvé : `yrVwGlmTrMk0WpDGLIyGDKQ6n6d.jpg` → **404** vs
`qxz3WIyjZiSKUhaTIEJ3c1GcC9z.jpg` → **200** pour tmdb 2454. (La canonisation avait aggravé en
gardant le poster périmé de la ligne canonique.) Fix (migration `20260704203000`, PR #135) :
- `norva_refresh_posters_from_catalog` synchronise `cloud_titles` ← `catalog_titles` (corrige
  aussi **les rails de genre** qui lisent `cloud_titles` en direct, hors overlay) ;
- `norva_backfill_media_identity` propage le poster frais vers `cloud_media_items` ;
- overlay edge (`attachMediaLanguages`) : le poster de `catalog_titles` fait désormais
  **autorité** (remplace), au lieu d'être un fallback derrière le poster périmé de `cloud_titles`.
- Impact compte de vérif : **2 828 posters rafraîchis** ; 3 Narnia matchés → HTTP 200.

**D. Versions absentes de la fiche** — la recherche floue (`search_media_items`, chemin fuzzy)
**dédupliquait en mémoire**, écrasant les versions ; or une fiche ouverte depuis la recherche
**re-fetch ses versions par ce même chemin** (`openByItem`). Fix (PR #135) : le chemin fuzzy
renvoie de nouveau **toutes les lignes**, le client regroupe. Vérifié : Prince Caspian = 2
versions, Passeur d'Aurore = 3, Lion = 2.

**E. Durabilité** — `norva_reconcile_catalog(uuid|null)` = canonicalize → refresh_posters →
backfill_media_identity (tous idempotents, quasi gratuits à vide). Cron pg_cron
**`norva-catalog-reconcile` (`*/10 * * * *`)** répare en continu ce que le search-match recrée,
**sans toucher au chemin critique** du matching. Index partiel `cloud_titles(user_id, item_type,
provider_tmdb_id) where provider_tmdb_id is not null` pour garder le group-by peu coûteux.

### État opérationnel (à généraliser)
Rollout **sûr et progressif** : le dedup serveur est live pour tous, mais n'**agit** que là où
`dedup_key` est rempli → seul le compte de vérif (`jeremy`, `0b971271-…`) est dédupliqué/rafraîchi ;
les autres comptes voient la grille **inchangée** (pas de `dedup_key` → RPC = comportement d'avant,
zéro régression). Crons temporairement **focalisés sur jeremy** : (1) `norva-enrich-search-match`
(job 12, auto-bascule global via le garde-fou job 84 quand le backlog est vidé) ; (2)
`norva-catalog-reconcile` (job 85). **À généraliser** = `norva_reconcile_catalog(null)` en one-shot
+ passage des deux crons en global (retirer `&user=` / le paramètre uuid).

### Doublons restants en recherche = non-matchés (attendu)
Les entrées encore en double portent des clés `norm:` **distinctes** car pas encore matchées
TMDB (ex. « The Chronicles Of Narnia — The Voyage… » vs « Le Monde de Narnia : L'Odyssée… » =
le même film). Elles **fusionnent automatiquement** dès que le search-match les résout (backlog
en cours de drainage + reconcile /10 min).

## Lot 4b — erreur de lecture `RANGE_UNSUPPORTED` sur une version (diagnostic, PAS un bug catalogue)
Symptôme : une version d'un film échoue à la lecture avec `{stage:'load', message:'RANGE_UNSUPPORTED'}`,
snapshot `size:0 / mime:null`, puis le fallback transcode gateway échoue :
`FFmpeg exited with code 1 … http://<host-provider>/… : Input/output error`.

**Diagnostic** : ce n'est PAS un bug Norva ni un problème de dédup/poster. C'est un **flux
provider mort/injoignable** : (1) le chemin moteur WASM a besoin du support **HTTP Range**
(byte-range pour seek-demux) — la source ne le supporte pas / renvoie 0 octet ; (2) le fallback
transcode échoue parce que **FFmpeg ne peut même pas OUVRIR l'URL source** (I/O error =
connexion refusée / 404 / upstream HS). L'autre version du même film (autre flux) lit très bien.
La chaîne de fallback moteur→transcode a fonctionné comme prévu ; les deux échouent quand la
source est réellement injoignable.

**Correctif (PR #137) — auto-bascule implémentée :** l'ossature existait déjà
(`handlePlaybackFailure` → `tryNextVersion` + marquage `PlaybackHealth` `broken`), mais le
chemin d'échec « moteur + transcode HS » appelait directement `handleEngineUnplayable` →
`showPlaybackError` (cul-de-sac). On le route désormais via `handlePlaybackFailure` :
(1) marque LA version morte `broken` (sauf erreur limite-de-connexion 401/403/429),
(2) **bascule automatiquement sur la version suivante**, (3) n'affiche l'erreur que si toutes
les versions sont épuisées. Le chemin 458 « un seul flux à la fois » retourne plus tôt (ne
bascule pas — ne pas ouvrir une 2ᵉ connexion). La grille masque déjà un film **uniquement quand
TOUTES ses versions sont `broken`** (filtre `hideBroken` au niveau version, avant regroupement)
→ le film n'est jamais supprimé, seule la version morte l'est.

**Reste à faire (backlog lecture) :**
1. Latence : `handlePlaybackFailure` retente d'abord 3 stratégies transcode (gateway/relay/full)
   sur la même source morte avant de basculer → la bascule peut prendre ~10-20 s. Optimisation
   possible : basculer immédiatement quand `fallbackEngineToTranscode` a déjà échoué (I/O).
2. Étiquetage de langue des versions parfois faux (deux versions « English » alors qu'une est FR)
   — `parseVersionInfo`/version-language à affiner.
3. « Hide broken » inerte en vues rails/bucket (le serveur ne connaît pas `PlaybackHealth`).

## Lot 4c — sous-titres : ~30 s avant affichage au clic (moteur WASM / MKV)
Symptôme : activer une piste de sous-titres met ~30 s à s'afficher. Objectif : **instantané**.

Le lecteur « Navigateur » (moteur WASM) a **deux chemins** : (a) **in-band** — le moteur capture
les cues **texte** dès le début de lecture (le demuxer court devant la tête de lecture) → une
sélection en cours de lecture affiche les cues déjà bufferisées **instantanément, sans 2ᵉ
connexion provider** ; (b) **gateway-window** — extraction ffmpeg côté serveur (lente).

**Cause racine (PR #142)** : l'énumération des pistes de sous-titres + l'armement de la capture
in-band vivaient à la **fin de `_ensureVideoExtradata()`**, une fonction **spécifique MPEG-TS**
(injection avcC/esds) dont les early-returns sautaient tout le bloc pour **MKV/MP4** (extradata
déjà présent → `return` en tête). Résultat : sur tout MKV/MP4, `_subMeta` restait vide →
`hasInbandSubtitles()=false` → chaque sélection retombait sur le chemin gateway lent. L'in-band
ne marchait QUE pour les MPEG-TS H.264 sans extradata — la niche où le code était rangé.
→ Fix : bloc extrait dans `_enumerateSubtitleStreams()`, appelé depuis `_detectStreams()` (tous
conteneurs, avant le pump). Prouvé sur MKV anime (Oshi no Ko, 2 pistes `ass` idx 3/4) :
`hasInband=true`, `subtitle path: engine-inband (instant)`. Le pump capture les paquets sous-titre
(`_captureSubtitlePacket`, branche pump `_subCapture && _subMeta.has(index)`).

**Correctifs annexes de la même saga :**
- **Latence du fallback gateway** (PR #141) : la 1ʳᵉ fenêtre extraite faisait **900 s (15 min)** en
  une requête (temps d'extraction ∝ longueur) → ~30 s. Désormais **90 s** en 1ʳᵉ fenêtre puis
  extension → 1ʳᵉ cue en quelques secondes même sur le chemin gateway.
- **Classification texte/image** (PR #140) : allowlist stricte de codecs → **denylist d'images**
  (pgs/dvdsub/dvbsub/teletext/xsub) ; tout autre codec de sous-titre = texte (robuste aux variantes
  de noms). Sous-titres bitmap (OCR) restent exclus.
- **Diag** : `this.log('streams: … subs=… inband=…')` au load + `console.log('[WatchPage] subtitle
  path: …')` au clic (conservés en support, non-alarmants).
