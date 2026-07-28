# Validation finale Android TV — 12 parcours premium

Date : 27 juillet 2026<br>
Appareil : émulateur Android TV `emulator-5556`, 1920 × 1080, Android 14 / API 34<br>
Application : `tv.norva.tv`<br>
Build validée : `clients/android-tv/app/build/outputs/apk/debug/app-debug.apk`

## Verdict

**12 parcours sur 12 sont classés Premium.** Il ne reste aucun parcours critique, mauvais ou bloqué dans le périmètre audité.

Le classement Premium exige ici :

- un écran toujours peint pendant le lancement, le chargement et les transitions ;
- un focus visible, prévisible et confiné ;
- un retour exact vers l’élément d’origine ;
- des états vide, erreur, reprise et retry explicites ;
- l’accès à toutes les zones utiles avec Haut, Bas, Gauche, Droite, OK et Retour ;
- une présentation TV cohérente avec l’identité Norva.

## Matrice des 12 parcours

| # | Parcours | Santé finale | Preuve principale |
|---:|---|---|---|
| 1 | Lancement → profils → Home | **Premium** | Écran de préparation sans flash noir, sélecteur de profils focalisé et Home prêt : [lancement](./94-final-reinstall-launch.png), [profils](./95-final-profile-or-home.png), [Home](./96-final-home.png) |
| 2 | Rail global, changements de page et mémoire de focus | **Premium** | Entrée/sortie déterministe, retour exact au contenu et bord gauche désormais stable : [bord gauche final](./97-final-settings-left-boundary.png) |
| 3 | Home : chargement, contenu, vide, erreur et retry | **Premium** | États plein écran intentionnels, skeletons non nuls et CTA réversible ; rendu Home final : [Home final](./96-final-home.png) |
| 4 | Live TV : chargement, guide, sortie et mémoire | **Premium** | Catalogue léger, hydration annulable et plafond résident de 4 000 chaînes ; preuves runtime : [entrée Live](./25-live-lightweight.png), [guide chargé](./26-live-ready-or-progress.png) |
| 5 | Movies : All Sources ↔ Categories | **Premium** | Navigation bidirectionnelle et focus visible : [Sources → Categories](./30-movies-sources-to-categories.png), [Categories → Sources](./31-movies-categories-to-sources.png) |
| 6 | Movies : recherche, filtres, Continue, puces et grille | **Premium** | Graphe sémantique complet ; Bas depuis `13 categories` atteint maintenant une carte réelle : [puce](./90-latest-movies-category-chip.png), [grille corrigée](./91-latest-movies-chip-to-grid-fixed.png) |
| 7 | Series : recherche, filtres et grille | **Premium** | Sources/Categories, modale, retour et grille sont reliés sans saut vers Movies : [filtres](./65-series-sources-categories.png), [grille](./68-series-grid-from-filters.png) |
| 8 | Modales Sources/Categories et restauration | **Premium** | Focus piégé dans la modale, Retour ferme puis restaure exactement l’ouvreur : [modale Movies](./33-category-option-focus.png), [retour Movies](./34-category-modal-focus-restored.png), [retour Series](./67-series-modal-return.png) |
| 9 | Settings : onglets, actions, scroll et retour au rail | **Premium** | Entrée sur Account, parcours par lignes, fin de panneau sans fuite, Gauche vers le rail puis no-op au bord : [Account](./79-settings-account-focus.png), [dernière action confinée](./92-latest-settings-contained-last-action.png), [bord final](./97-final-settings-left-boundary.png) |
| 10 | Profils et Notifications | **Premium** | Profils clairement focalisés ; Notifications reste dans le viewport, confine le D-pad et rend le focus à la cloche : [profils](./95-final-profile-or-home.png), [Notifications](./98-final-notification-modal.png) |
| 11 | Fiche Movie/Series et retour exact | **Premium** | Actions de fiche accessibles et Retour restaure la carte sélectionnée : [fiche Series](./70-series-details-page.png), [retour exact](./71-series-detail-exact-return.png) |
| 12 | Lecteur VOD natif : reprise, OSD, choix, erreur et retour | **Premium** | Reprise native, erreur Norva actionnable sans faux chargement, Retry focalisé et retour exact sur Léon : [reprise](./86-latest-movies-final.png), [erreur honnête](./87-latest-player-terminal-honest.png), [retour exact](./88-latest-player-exact-return.png) |

## Défauts réellement trouvés et corrigés

1. **Movies — puce vers grille bloquée.** Les cartes des buckets de catégories utilisent `.genre-bucket-grid .dashboard-card`, alors que le graphe ne reconnaissait que `.movie-card`. Le sélecteur Movies est maintenant unifié et couvert par un test.
2. **Settings — fuite hors panneau.** Bas pouvait atteindre la cloche ou le profil depuis la fin des actions. Settings possède maintenant un graphe limité au panneau actif, avec navigation verticale par lignes et horizontale dans la ligne.
3. **Settings — bord gauche instable.** Après Transcoding, le ruban d’onglets défilé pouvait se retrouver géométriquement à gauche du rail ; une nouvelle pression Gauche réentrait alors dans un onglet hors écran. Le rail est désormais un vrai bord physique : seul Droite entre dans la page.
4. **Lecteur — état terminal contradictoire.** L’erreur finale conservait « Loading the best available stream… » sous la carte d’erreur. L’état terminal masque maintenant ce texte ; Retry restaure explicitement l’état de reconnexion.
5. **Live/Home — pression mémoire.** Home ne déclenche plus le chargement intégral de Live. Les requêtes TV sont légères, bornées, annulables et ne conservent pas toutes les variantes.
6. **États et transitions.** Home, Live, Movies et Series gardent un état peint, intentionnel et récupérable au lieu d’un écran vide.

## Vérifications finales

- Navigation réelle au D-pad ADB sur la dernière APK installée.
- Inspection de `document.activeElement` via le WebView pour vérifier les destinations exactes.
- Notifications : Haut/Bas/Gauche/Droite restent dans la modale ; Retour ferme et restaure `#nav-bell`.
- Settings : depuis Transcoding, Gauche retourne à Settings ; quatre pressions Gauche supplémentaires restent sur Settings.
- Movies : depuis la puce `13 categories`, Bas focalise une carte `.genre-bucket-grid .dashboard-card`.
- Lecteur natif : reprise, récupération, erreur terminale, Retry, Back to Norva et retour exact validés.
- Suite TV ciblée : **62/62 tests réussis**.
- Suite complète du dépôt : **839/839 tests réussis**.
- Android `assembleDebug` + `lintDebug` : **BUILD SUCCESSFUL**, **0 erreur lint**.
- `git diff --check` : **aucune erreur**.

## Limite externe observée

Le fournisseur utilisé pour la validation finale de *Léon* a répondu HTTP 429 sur l’URL directe puis sur le fallback. Cette indisponibilité ne vient pas de la navigation ni du lecteur. Le parcours dégradé est désormais premium : récupération bornée, message compréhensible, Retry prioritaire et retour exact au catalogue. Les commandes OSD, pistes, format, More, seek et boucles de focus restent en plus couvertes par les contrats Android TV.

Les anciennes captures `41` à `43`, prises avant l’activation du lecteur natif actuel, ne font pas partie des preuves finales. Les captures `52` et `53`, qui montraient le blocage Movies avant correction, sont remplacées par la preuve finale `91`.
