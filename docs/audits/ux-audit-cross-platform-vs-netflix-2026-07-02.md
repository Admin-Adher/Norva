# Audit UX cross-platform vs Netflix — Web / APK mobile / APK Android TV (2026-07-02)

Audit mené par 4 agents parallèles (web, mobile, Android TV, benchmark features), chaque constat
vérifié avec preuve `fichier:ligne`. 79 constats au total : **4 bloquants, ~30 majeurs, le reste
mineurs**. Ce document est la synthèse consolidée et classée ; il sert de backlog UX.

> **Décision owner 2026-07-02 : Tizen est HORS PÉRIMÈTRE.** Les supports retenus sont le web,
> l'APK Android mobile et l'APK Android TV. Les constats Tizen (bloquants 1-2, chantier Lot 2 #6)
> sont conservés ci-dessous pour trace mais ne sont pas à traiter. Restent donc **2 bloquants**
> (casting, PWA) et le backlog des 3 supports.

Complète l'audit interne existant `docs/audits/mobile-ux-audit-vs-netflix.md`.

---

## Verdict global

| Surface | État | Résumé |
|---|---|---|
| **Web (`public/`)** | Socle solide, moments Netflix absents | Recherche/SPA/reprise/versions excellents ; zéro preview/trailer, billboard statique, grille 500k non virtualisée, scroll perdu au retour. |
| **APK mobile** | La plus aboutie | Player natif, téléchargements complets, PiP, billing OK ; **aucun casting**, `app.html` n'est pas une PWA, barre d'état masquée partout. |
| **APK Android TV** | Bon player, intégration plateforme vide | Seek D-pad accélérant + appairage cloud = parité Netflix ; mais BACK cassé sur Home, pas de MediaSession/Watch Next/voice, focus trop faible. |
| **Samsung Tizen** | **Inutilisable à la télécommande** | L'iframe ne passe ni `?tv=1` ni UA TV → D-pad mort ; pas de player natif → codecs KO. |
| **Transversal** | Fondations manquantes | i18n FR/EN mélangé systémique, apparence sous-titres non réglable, recherche titre-seul, pas de PIN parental, pas d'ABR VOD, a11y clairsemée. |

---

## BLOQUANT (4)

1. **Tizen : la navigation D-pad ne s'active jamais.** L'iframe charge l'URL brute sans `?tv=1`
   ni UA `NorvaTV` (`clients/samsung-tizen/js/app.js:31`), donc `tvNavigation.js:14-16` sort
   immédiatement ; les cartes `<div>` ne sont pas focusables → les flèches ne font rien.
   *Fix : 1 ligne — ajouter `?tv=1` au src de l'iframe (ou détecter l'UA Tizen dans tvNavigation).*
2. **Tizen : aucun player natif.** Pas de bridge `NodeCastNative`/`NorvaTVCloud` → lecture HTML5
   du webview Tizen : MKV/EAC3/HEVC échouent exactement comme le WebView Android avant le passage
   au natif. *Fix : player AVPlay Tizen (chantier), ou documenter Tizen HLS/MP4-only.*
3. **Aucun casting nulle part (Chromecast / AirPlay).** Ni `media3-cast` côté APK
   (`clients/android-phone/app/build.gradle:64-71`, `PlayerActivity.java:232-239`), ni Cast
   SDK / Remote Playback API côté web. Feature cœur Netflix, 100 % absente.
4. **`app.html` (mobile web) n'est pas une PWA.** Pas de `<link rel="manifest">`, pas de
   `theme-color`, aucun `serviceWorker.register` sous `public/` (`public/app.html:6-9`).
   Le `clients/mobile-pwa` n'est qu'une redirection avec un SW network-only (4 assets).

---

## MAJEUR — Web (11)

1. **Pas de hover-preview / carte étendue** (l'interaction signature Netflix) — seul un
   play-overlay statique (`HomePage.js:1131`, `MoviesPage.js:1219`).
2. **Fiche sans trailer** — backdrop statique uniquement (`MoviesPage.js:1652`) ; TMDB `videos`
   jamais exploité.
3. **Fiche sans casting/réalisateur** (ni « % match ») — `metaParts` = année/durée/genres/qualité
   (`MoviesPage.js:1669-1678`).
4. **Billboard Home statique unique** — 1 item, image fixe, pas de rotation ni vidéo
   (`HomePage.js:944-980`).
5. **Grille 500k titres non virtualisée** — l'infinite scroll accumule les nœuds DOM sans
   recyclage (`MoviesPage.js:1158-1190`).
6. **Scroll perdu au retour sur une grille** — `show()` re-render tout, `filterAndRender` remet
   scrollTop à 0 ; le router ne sauvegarde rien (`app.js:1597-1635`).
7. **Aucun réglage d'apparence des sous-titres** — `::cue` figé en CSS
   (`main.css:10212-10219`). *(= gap benchmark #11.)*
8. **Pas de « Passer l'intro / le récap »** — seul un seuil générique de fin existe
   (`WatchPage.js:4016-4029`).
9. **La récupération d'erreur de lecture = reload complet de la page**
   (`WatchPage.js:4558`, auto-refresh `:4610`) alors que `releasePlaybackPipelineForRetry` existe.
10. **Pas de miniatures de seek** (storyboard/sprite) sur la barre de progression.
11. **Posters sans `srcset` ni placeholder LQIP** — une seule taille TMDB, pop de layout
    (`HomePage.js:1128`).

## MAJEUR — APK mobile (6)

1. **Onglet Téléchargements invisible à zéro téléchargement** (`app.js:1091-1109`,
   `app.html:118`) — Netflix l'affiche toujours.
2. **Barre d'état masquée dans toute l'app** (`Theme.NoTitleBar.Fullscreen`,
   `AndroidManifest.xml:23`) — l'immersif ne devrait concerner que le player.
3. **Pas de gestes glisser = luminosité/volume** dans le player natif
   (`PlayerActivity.java:476-516` : tap + double-tap seulement).
4. **Pas d'App Links https** — seul `norva://pair` est déclaré ; un lien de titre partagé
   n'ouvre jamais l'app (`AndroidManifest.xml:38-43`).
5. **~1,8 Mo de JS non minifié chargé d'emblée** — `WatchPage.js` 374 Ko, `AdminPage.js` 76 Ko
   pour tout le monde (`app.html:1875-1905`).
6. **Pas de Media Session web** — aucun contrôle écran verrouillé pour la lecture mobile-web
   (le natif l'a via ExoPlayer).

## MAJEUR — APK Android TV (9)

1. **BACK sur Home ne quitte pas : il recycle l'historique SPA.** `pushState` rend
   `canGoBack()` vrai, donc `MainActivity.java:654-663` re-navigue au lieu d'afficher un dialog
   « Quitter ? » quand `handleBack()` répond `'exit'`.
2. **Pas de MediaSession** → Assistant (« pause »), carte « en lecture » et touches transport
   système morts (aucune occurrence dans `clients/android-tv`).
3. **Pas de canal Play Next / Watch Next** sur l'écran d'accueil Android TV (pas de
   `androidx.tvprovider`).
4. **Pas de recherche vocale / recherche globale** (aucun intent-filter `SEARCH`).
5. **Player natif sans épisode suivant / skip-intro / liste d'épisodes** — `STATE_ENDED` →
   `finish()` sec (`PlayerActivity.java:285`). Le binge séries est nettement sous Netflix.
6. **Anneau de focus trop faible pour du 10-foot** — scale 1.04 + 3px bleu moyen
   (`main.css:10225-10239`) vs bordure blanche épaisse + ~1.1 chez Netflix.
7. **Aucun focus initial au chargement d'une page** — rien n'est focus avant la première flèche
   (`tvNavigation.js:253-262`).
8. **Pas de restauration du focus au retour du player** (`MainActivity.java:471-488`) — la carte
   d'origine perd son anneau.
9. **Pas de marges overscan/title-safe** — `env(safe-area-inset-*)` vaut 0 sur TV
   (`main.css:76-79`) ; navbar et cartes de bord rognées sur les TV qui croppent.

## MAJEUR — Transversal (benchmark 17 features)

1. **Pas de PIN parental, flag kids non appliqué** — `is_kids` existe mais ne filtre rien
   (`20260622140000_account_profiles.sql:20`).
2. **Recherche titre-seul** — pas d'acteurs, pas de suggestions/typo-tolérance (trigram).
3. **Apparence des sous-titres** (voir Web #7).
4. **Accessibilité** — aria clairsemé (25 occurrences dans `app.html`), pas de gestion focus
   clavier web hors player, pas d'audio-description.
5. **i18n de l'interface inexistante** — FR/EN codé en dur et mélangé partout
   (« A reprendre » `HomePage.js:987` vs chrome anglais ; Admin 100 % FR). Systémique.
6. **Pas d'ABR VOD ni d'indicateur de débit** — le sélecteur qualité ne couvre que les variantes
   live ; `hls.bandwidthEstimate` loggé mais jamais montré (`VideoPlayer.js:2001`).

---

## MINEUR (résumé — détails dans les rapports d'agents)

- **Web (11)** : skeletons partiels, pas de lazy-mount des rails, raccourcis clavier limités
  (pas de J/L/C/N/0-9), suppression Continue Watching sans undo, cache VOD localStorage-only,
  panneau épisode-suivant minimal (10 s fixes, pas de vignette), course `setTimeout(100)` pour
  ouvrir une fiche cross-page, pas de SW/offline web, états vides nus, feedback SWR silencieux.
- **Mobile (13)** : PiP sans boutons transport, pas de verrouillage des contrôles, pas de
  pinch-to-zoom, double-tap web = fullscreen au lieu de ±10 s, pas de choix qualité de
  téléchargement ni smart-downloads, posters w342 fixes, pas de SplashScreen API, pas de
  predictive-back (targetSdk 35), pas de `WebView.saveState`, cibles tactiles < 44 px par
  endroits, manifest/SW PWA squelettiques.
- **TV (8)** : barre d'options découvrable uniquement via Down (chevron non focusable), setup
  avancé caché derrière la touche MENU, saisie URL au clavier leanback, pas de PIP TV, banner
  leanback à vérifier (320×180), position de liste perdue au re-render, `<select>` natifs
  cassant le flow 10-foot, code back web-player mort sur TV.
- **Benchmark PARTIAL** : autoplay suivant sans « toujours là ? », recos sans % match, badges
  « Nouveau » absents des cartes (le slot affiche le nombre de versions), pas de pouce
  haut/bas, onboarding sans taste-picker, notifications = toasts sans inbox, « Ma liste »
  fragmentée (pas de rail unifié films+séries+chaînes).

---

## Points forts confirmés (à ne pas casser)

- **Web** : overlay de recherche instantanée (débounce 250 ms, états propres), routing SPA sans
  reload, Continue Watching précis (offsets serveur, cross-device via `cloud_watch_history`),
  rails Top 10 + personnalisation par langue, sélecteur de versions clair, erreurs de lecture
  déjà user-facing.
- **Mobile** : double-tap ±10 s natif, safe-areas partout (36 usages), PiP, MediaSession
  native, sous-titres mémorisés par titre, téléchargements natifs complets
  (pause/reprise/réordonnancement/Wi-Fi only/stockage), bottom-nav + bottom-sheet une main,
  RevenueCat câblé.
- **TV** : ExoPlayer natif avec seek D-pad accélérant (10→30→60 s, preview à 450 ms) — au
  niveau ou au-dessus de Netflix ; appairage cloud par code = vraie parité « sign in from
  phone » ; dialogs natifs pistes audio/sous-titres navigables à la télécommande ; fenêtrage
  des candidats D-pad (cap 400) qui garde la nav fluide.

---

## Plan de correction proposé (à valider par l'owner)

### Lot 0 — Quick wins (heures→jours, risque quasi nul)
1. Tizen `?tv=1` (1 ligne, débloque toute la surface Samsung).
2. TV : dialog « Quitter Norva ? » sur BACK-Home (`finish()` direct, pas `goBack()`).
3. TV : focus initial au chargement + restauration du focus au retour du player + anneau
   renforcé (scale 1.09, ring blanc 4px, siblings assombris) + marges overscan `.tv-mode`.
4. Mobile : onglet Téléchargements toujours visible (UA APK) ; barre d'état rétablie hors
   player ; chevron options-bar focusable (TV).
5. Web : undo-toast sur suppression Continue Watching ; retry in-place au lieu de
   `location.reload()` ; raccourcis J/L/C/N/0-9 ; skeletons partout.
6. Media Session API sur le player web (lockscreen mobile-web).
7. `manifest.json` + `theme-color` + SW app-shell minimal sur `app.html`.
8. `srcset` posters (w185/w342/w500) web+mobile.
9. Badge « Nouveau » sur cartes (`added_at < 14 j`).

### Lot 1 — Structurant (jours→semaines)
1. **Casting** : `media3-cast` + MediaRouteButton (APK) ; Remote Playback API / Cast sender (web).
2. **TV plateforme** : MediaSession media3 + canal Watch Next (`androidx.tvprovider`) + intent
   recherche vocale.
3. **Player TV séries** : overlay « Épisode suivant » sur `STATE_ENDED` + liste d'épisodes.
4. **Apparence sous-titres** : panneau taille/couleur/fond/position → CSS custom props sur
   `::cue`, persisté par profil (profite aussi aux sous-titres IA).
5. **i18n** : catalogue de chaînes `t()` + locales FR/EN, extraction des strings codées en dur.
6. **Recherche** : acteurs + suggestions trigram côté `norva-catalog`.
7. **PIN parental** : `pin_hash` + enforcement `is_kids` sur les requêtes catalog + modal PIN.
8. **Perf web** : virtualisation de la grille + restauration du scroll ; minification/split du
   bundle (lazy AdminPage/WatchPage, hls.js différé).
9. Mobile : gestes luminosité/volume, App Links https, sélecteur qualité téléchargement.

### Lot 2 — Chantiers lourds
1. Trailers TMDB : fiche + hover-preview + billboard rotatif vidéo.
2. ABR VOD (ladder HLS multi-qualités côté gateway) + indicateur débit.
3. Miniatures de seek (storyboard généré serveur).
4. Passe accessibilité complète (focus web, aria, audio-description).
5. Offline web réel (SW précache + fallback).
6. Player natif Tizen (AVPlay) — ou décision assumée de sortir Tizen du périmètre.

---

*Rapports d'agents source : web 22 constats, mobile 21, Android TV 19, benchmark 17 items —
preuves `fichier:ligne` détaillées dans chacun.*
