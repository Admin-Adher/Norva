# Parité UX Netflix — implémentation des 28 corrections (2026-07-02)

Suite de l'audit `docs/audits/ux-audit-cross-platform-vs-netflix-2026-07-02.md`
(Tizen hors périmètre). Les 28 constats bloquants/majeurs des 3 supports (web,
APK Android mobile, APK Android TV) ont été implémentés en 8 commits.

## Bloquants

1. **Casting Chromecast** —
   *Web* : `utils/castSender.js` (SDK Cast lazy, Default Media Receiver) + bouton
   cast dans le player. Les URLs serveur (HLS gateway, MP4 relay) sont castées
   telles quelles ; les titres moteur (MSE) sont re-résolus en transcode gateway
   à la position courante. La lecture locale est libérée AVANT la connexion du
   receiver (1 connexion provider). CORS gateway : origin `https://www.gstatic.com`
   ajouté (le receiver CAF fetch avec cet Origin ; le token de session garde tout).
   *APK mobile* : `CastSupport.java` (cast framework + mediarouter sans AppCompat,
   picker AlertDialog), bouton quand des appareils sont détectés, hand-over
   pause locale → receiver (même IP résidentielle), bandeau + Arrêter.
2. **PWA réelle** — `public/manifest.json` (id/scope/maskable/shortcuts),
   `theme-color`, `public/sw.js` network-first (les déploiements gagnent
   toujours ; cache seulement hors ligne ; API/gateway/flux jamais interceptés),
   enregistrement sauté dans les WebViews APK.

## Android TV (9)

3. BACK sur Home → dialog « Quitter Norva ? » (`MainActivity.showExitDialog`) —
   plus de recyclage d'historique pushState.
4. MediaSession media3 sur le player TV (Assistant, carte en lecture).
5. Canal Watch Next du launcher (`WatchNextHelper`, publish/remove selon
   progression, clic → `norva://open` → `__norvaNative.openItem` → reprise via
   l'historique cloud).
6. Recherche vocale : intent `ACTION_SEARCH` → `__norvaNative.openSearch`
   (gsearch préremplie). *(La recherche catalogue au niveau launcher exige un
   feed Google Media Actions — programme partenaire, hors client.)*
7. Overlay natif « À suivre » en fin d'épisode (compte à rebours 10 s, Lire
   maintenant/Retour) + raccourcis barre d'options Suivant/Épisodes ; le web
   chaîne l'épisode suivant sans re-prompt (`detail.immediate`). Le label du
   suivant est calculé au lancement (`SeriesPage.nextEpisodeLabel`) et passé au
   bridge JSON `playVideoJson` (poster inclus pour l'art Watch Next).
8. Focus ring 10-foot : blanc 4 px + halo, scale 1.09, siblings assombris.
9. Focus initial posé au chargement de chaque page (observer `.page.active`).
10. Focus restauré au retour du player natif et après re-render (carte mémorisée).
11. Marges overscan `.tv-mode` 48/27 px (navbar + cartes jamais rognées).

## APK mobile (6)

12. Onglet Téléchargements toujours visible (UA APK), zéro-état natif.
13. Barre d'état rétablie en navigation (`Theme.Material.NoActionBar` +
    `statusBarColor`), immersif réservé au player (`PlayerTheme`).
14. Gestes verticaux player : gauche = luminosité, droite = volume.
15. App Links https `norva.tv` (autoVerify) + `launchMode=singleTask` +
    `onNewIntent`. ⚠ **Owner** : remplacer le SHA-256 placeholder dans
    `public/.well-known/assetlinks.json` (empreinte release, Play Console).
16. Bundle : AdminPage (76 Ko) lazy à la première entrée `#admin` (gating via
    RPC `is_admin` léger), hls.js (~400 Ko) injecté à l'idle / navigation
    playback. *(La minification complète exige une étape de build Cloudflare
    Pages — chantier séparé.)*
17. Media Session API sur le player web (écran verrouillé mobile-web).

## Web (11)

18. Hover-preview (desktop) : portail flottant (`utils/hoverPreview.js`) — art
    16:9, titre/méta, Play (action primaire auto) / More info. Jamais TV/tactile.
19. Fiches : bouton ▶ Trailer (lightbox YouTube nocookie) via `GET /tmdb-meta`
    (norva-catalog proxy TMDB `videos+credits`, clé serveur, cache 24 h).
20. Fiches : casting (6 noms) + réalisateur/créateurs sous le synopsis.
21. Billboard rotatif : reprise + 6 titres à backdrop, crossfade après décodage,
    9 s (pause hover/onglet caché), dots, bouton Trailer.
22. Virtualisation grilles : fenêtre ~360 cartes, recyclage haut → spacer
    hauteur-stable, rematérialisation au scroll-up depuis `filteredCards`.
23. Scroll restauré : par page (router) + par grille (retour <5 min = DOM
    conservé + position, plus de re-render-retour-en-haut).
24. Apparence sous-titres : panneau Taille/Fond/Couleur (menu captions) via
    variables CSS `--norva-sub-*` sur `::cue` (pistes embarquées/IA/OCR).
25. « Skip intro » crowd-learned : le seek avant précoce est signalé
    (`POST /intro-signal`, 1/lecture, borné client+serveur), médiane servie dès
    3 spectateurs (`GET /intro-markers`, table `catalog_intro_signals`), bouton
    overlay qui saute à la fin d'intro. Zéro connexion provider, auto-correctif.
26. Erreur de lecture : retry EN PLACE (release → slot → URL fraîche →
    loadVideo, échelle de fallback ré-armée) — reload seulement en ultime secours.
27. Miniatures de seek : sprite JPEG unique par titre (gateway v62,
    `-skip_frame nokey` + `tile=`, ≤200 tuiles 212 px) → bucket public
    `norva-storyboards` (upload signé), `GET /storyboard` (cache cross-user,
    enqueue au 1er playback, différé pendant le visionnage), hover/scrub sur la
    timeline. Table `catalog_storyboards`.
28. `srcset` TMDB w185/w342/w500 sur toutes les cartes (`MediaUtils.tmdbSrcset`).

## Migrations appliquées manuellement

- `20260702210000_intro_signals.sql`
- `20260702220000_storyboards.sql` (+ bucket `norva-storyboards`)

## Vérifications post-déploiement

- Gateway Railway : `GET /health` → `version: 62`.
- Edge : norva-catalog (tmdb-meta/intro-*) et norva-playback (storyboard*)
  redéployés par le workflow au merge.
- TMDB : `/tmdb-meta` exige le secret de fonction `TMDB_API_KEY` (déjà en place
  pour l'enrichissement).
- APK : builds via `.github/workflows/android-release.yml`
  (TV 3.8.0 versionCode 13, phone 1.2.0 versionCode 3).

## Hors périmètre assumé (documenté)

- Tizen (décision owner).
- Recherche launcher TV (Google Media Actions).
- Minification/bundling complet du front (étape de build à introduire).
- Cast des chaînes live depuis le web (le pairing cloud « lire sur TV » couvre
  déjà le cas ; le VOD est couvert par le sender).
