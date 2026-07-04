# Refonte de la fiche Série — journal complet (2026-07-04)

Ce document capture **tout ce qui a été fait** sur la fiche Série (et le contexte
Home/catalogue qui l'entoure) pendant la session du 2026-07-04. Détail des crons
d'enrichissement : `CATALOG-ENRICHMENT-CRONS-RUNBOOK.md`. Détail Movies/Series (dédup,
sous-titres) : `MOVIES-SERIES-PAGES-AUDIT.md`.

## 0. Contexte & problème de départ

Plainte utilisateur : sur la fiche Série, **les variantes/langues d'une série n'étaient
pas accessibles** (contrairement aux fiches Film), et la sélection d'épisodes
n'était « pas intuitive/ergonomique/moderne ». Audit initial par 9 agents parallèles
(workflow `series-ux-brainstorm`) → un seul point réellement **bloquant** + une liste de
polish.

**La nuance structurelle** (pourquoi c'était non trivial) : côté Film, une « version » =
un **flux jouable** (`stream_id`) → basculer est gratuit. Côté Série, une version = une
**arborescence saisons/épisodes entière** (un autre `series_id`, chargé à la demande via
`seriesInfo`). Basculer = re-fetch réseau + re-render, et les arbos de deux versions ne se
correspondent pas (numérotation/nombre de saisons différents). Le bon modèle est donc
« changer de version **ré-ouvre** la fiche sur cette version », pas un toggle par épisode.

## 1. Correctifs de contexte (avant la refonte)

| PR | Sujet |
|----|-------|
| #146 | **Home** ne chargeait plus (skeletons infinis). Causes : (a) le drain global `reconcile` saturait l'I/O → rendu résilient (advisory-lock, batché, savepoints, fenêtré nuit) ; (b) `top_viewed_titles()` faisait un **seq scan de 755k variantes** à chaque chargement → réécrit en LATERAL (>60 s → ~105 ms). |
| #147 | **Aperçu au survol** des rails Movies/Series affichait la **mauvaise série** (collision de resolver global `.dashboard-card` avec la Home). Corrigé en épinglant `__norvaHover` par carte dans `GenreRails` + garde sur le resolver Home. |

## 2. La refonte fiche Série (P0 + P1 + P2)

Fichiers principaux : `public/js/pages/SeriesPage.js`, `public/app.html`,
`public/css/main.css`, + un endpoint edge `norva-catalog`.

### Wave 1 — sélecteur de versions in-fiche + ergonomie (PR #148)

Le cœur : rendre les versions **atteignables et changeables depuis la fiche**.

- **`renderSeriesVersions()`** — liste de versions dans la fiche (section
  `#series-versions-section`), **libellés langue d'abord** (VF/VOSTFR/EN · qualité ·
  source). Rendue **synchroniquement** depuis `currentSeriesGroup.items` (en mémoire),
  donc elle survit même si le fetch d'épisodes échoue. Cliquer une version appelle
  `showSeriesDetailsV2(item, group, {isVersionSwitch:true, manualPick:true,
  rememberOnSuccess:true})` → recharge son sous-arbre d'épisodes.
- Atteignable depuis **tous** les points d'entrée (grille, recherche `openByItem`, rails
  `openRailItem`, reprise/restore) — car c'est la fiche elle-même qui la rend. Le badge
  « N versions » de la grille **deep-link** dans la fiche (`openGroup(..,{focusVersions:true})`)
  et scrolle jusqu'au sélecteur (l'ancienne modale `showVersionPicker` a été supprimée).
- **Mémorisation** : `rememberVersionChoice` / `getRememberedVersion` (localStorage
  `norva.series.versionChoice`, clé `tmdb:<id>` sinon `dk:<dedup_key>`) — persistée
  **uniquement quand les épisodes se chargent** (`rememberOnSuccess`), jamais un choix
  cassé.
- **Auto-récupération** : `tryNextHealthyVersion` — si la version auto est vide/cassée,
  bascule sur un sibling sain au lieu de « No episodes ». Un choix **explicite** (manualPick)
  est respecté (pas de redirection silencieuse).
- **Ergonomie** : « Reprendre · N min left » + bouton « **Play from start** »
  (`playEpisode({fromStart})`, offset 0) ; épisode **« Up next »** surligné ; lignes
  d'épisode **focusables clavier/télécommande** (`role=button tabindex=0`, Enter/Espace,
  avec garde `e.target !== ep`) ; barre de saison **collante**.
- **Robustesse** : garde anti-race `_detailToken` (succès **et** échec) — un vieux
  `seriesInfo` lent ne peut pas écraser une fiche plus récente ; un switch de version
  saute le repaint hero/plot/MoreLikeThis/extras (même titre) et ne recharge que les
  épisodes.
- **Revue adversariale** (9 agents + 5 vérificateurs) : 1 major + 4 minors corrigés,
  3 faux positifs écartés.

### Wave 2a — pills de saison (PR #149)

- Le `<select>` de saison → **tablist de pills** (`#series-season-tabs`) : nom de saison
  + **compteur d'épisodes**, saison 0 = « **Specials** ». Collant, `role=tab`,
  `aria-selected`, **roving tabindex**, navigation flèches ←/→. Pleine largeur scrollable
  sur mobile.
- État déplacé vers `this._activeSeason` ; `applySelectedSeason` + `setActiveSeason`.
  Toutes les saisons restent dans le DOM (CSS-hide) → le « next episode » cross-saison,
  l'autoplay natif et le téléchargement par saison restent intacts (**zéro régression**).

### Wave 2b — enrichissement TMDB par épisode (PR #150)

Supprime la « colonne de posters identiques » — le plus gros tell « ça fait daté ».

- **Backend** : nouvel endpoint `GET /tmdb-episodes?tmdbId&season&lang` dans
  `norva-catalog` (`getTmdbEpisodes`). Proxie TMDB `/tv/{id}/season/{n}` (clé côté
  serveur), renvoie par épisode `{episode_number, name, still_path, air_date, overview,
  runtime, vote_average}`, cache mémoire par `(tmdbId, season, lang)` + CDN 24 h. Isolé
  du cache series-info (qui porte des credentials).
- **Client** : `NorvaCloud.media.tmdbEpisodes()` + `SeriesPage.enrichSeasonWithTmdb()` —
  **lazy par saison active** (au rendu + au changement de pill), mémoïsé, gardé par
  `_detailToken`, `try/catch`. **Politique** :
  - **vignettes TMDB → toujours** (le vrai fix visuel) ;
  - **titre** → seulement en *promotion* d'un « Episode N » générique (jamais d'écrasement
    d'un vrai titre provider → pas de régression FR→EN) ;
  - **année** ajoutée en pill discrète ;
  - **synopsis** → remplit une description **absente** depuis TMDB (jamais d'écrasement) →
    un épisode se lit pareil quelle que soit la version, même si un provider ne fournit
    aucun plot. (Ajouté après le retour utilisateur du 2026-07-04.)
  - Langue dérivée de `preferredLanguage` / `navigator.language`.

### Wave 2c — marquer vu / non-vu (PR en cours)

- **Par épisode** : bouton `.episode-mark` (révélé au survol desktop, toujours visible au
  toucher). `setEpisodeWatched()` persiste une ligne d'historique **complétée**
  (progress = duration) via `API.history.save({id, type:'episode', …data:{seriesId,
  currentSeason, currentEpisode}})` — **même forme** que le `saveProgress` du player — ou
  `API.history.remove()` pour dé-marquer, puis miroir local dans `this.historyItems`.
- **Par saison** : bouton « **Mark season as watched / unwatched** » (`.season-mark-all`)
  qui boucle les épisodes de la saison (séquentiel, doux) ; le libellé reflète l'état.
- **`repaintEpisodeWatchState()`** : patch **en place** des markers / barres de progression
  / surbrillance « Up next » / boutons mark / bouton primaire — sans re-fetch ni
  re-render complet.

## 3. Android TV & Android mobile — applicable ?

**Oui, tout s'applique.** L'app Android (TV **et** mobile) est un **wrapper WebView** qui
charge **le même bundle web** (`public/js/*`) et injecte un pont natif
`window.NorvaTVCloud` (cf. `nativeDownloadBridge()`), plus des événements natifs
(`norva-native-ended` dans `utils/standalone.js`) et la navigation D-pad
(`utils/tvNavigation.js`, qui pose la classe `tv-mode` sur `<html>`). Il n'y a **pas** de
code de fiche Série dupliqué côté natif → chaque changement front est déployé partout via
Cloudflare Pages.

Points spécifiquement **favorables à la TV** issus de cette refonte :
- Les lignes d'épisode sont désormais **focusables** (`role=button tabindex=0`, Enter/Espace)
  → navigables à la **télécommande** (avant : inaccessibles sans souris).
- Les **pills de saison** (roving tabindex + flèches ←/→) et les **chips de version** sont
  des `<button>` → atteignables au D-pad.

Nuances TV à surveiller (non bloquantes) :
- Le bouton « mark watched » est un `<button>` imbriqué dans une ligne `role=button`. Il
  est révélé au `focus-within` et affiché sur `@media (hover:none)`, mais son
  **atteignabilité fine au D-pad** dépend de `tvNavigation.js` (focus des enfants). À
  valider sur un vrai Android TV ; au pire il reste marquable via la lecture (un épisode
  terminé se marque tout seul).
- L'app native gère l'autoplay « À suivre » via `onNativeEpisodeEnded` (préservé).

## 4. Caveat connu — qualité des données provider

Constat utilisateur (Doom Patrol) : la **Version 1 (AtlasPro)** a 15 épisodes propres avec
synopsis ; la **Version 2 (IPTV Ferran)** a une liste **abîmée côté provider** (31 entrées,
épisodes « Episode 08…15 » **dupliqués**, vignettes répétées, pas de synopsis).

- Les **synopsis manquants** sont désormais remplis par TMDB (Wave 2b, fill-if-missing) →
  cohérence de présence entre versions.
- Les **doublons/épisodes fantômes** de la Version 2 viennent des **données du provider**
  lui-même (mauvais `get_series_info`) — Norva n'invente pas d'épisodes. L'enrichissement
  TMDB matche par `episode_number` : les épisodes réels (1-15) sont enrichis, les entrées
  fantômes mal numérotées ne le sont pas. Le **sélecteur de versions** est justement là
  pour qu'on préfère la Version 1 quand une source est de meilleure qualité.

## 5. Récap des PR (toutes squash-mergées sur `main`)

| PR | Wave | Déploie |
|----|------|---------|
| #146 | Home fix + reconcile résilient | front + DB (migrations) |
| #147 | Aperçu survol rails | front |
| #148 | Sélecteur de versions in-fiche + ergonomie | front |
| #149 | Pills de saison | front |
| #150 | Enrichissement TMDB épisodes | front + **edge** (`/tmdb-episodes`) |
| (en cours) | Mark watched/unwatched + fill synopsis TMDB | front |

Validation à chaque étape : `node --check`, `npx esbuild …` (edge), `node --test` 38/38.
