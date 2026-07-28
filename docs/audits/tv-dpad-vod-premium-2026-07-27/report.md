# Audit Android TV — navigation D-pad et lecteur VOD premium

Date : 27 juillet 2026<br>
Appareil : émulateur Android TV `emulator-5556`, 1920 × 1080, Android 14 / API 34<br>
Application : `tv.norva.tv`, version `3.8.11-hybrid` (`versionCode 24`), `targetSdk 36`

## Verdict

Norva TV est utilisable, mais pas encore au niveau de fiabilité et de finition attendu d'une expérience VOD premium de référence.

- **Navigation D-pad : 5/10.** Les anneaux de focus sont visibles et la navigation locale fonctionne souvent, mais plusieurs transitions entre zones reposent encore sur le calcul spatial implicite. Cela provoque des sauts, des pièges et des changements de page difficiles à prévoir.
- **Lecteur — base technique : 6/10.** Lecture Media3 native, reprise, pistes, seek, récupération et retour catalogue existent réellement.
- **Lecteur — perception premium : 4/10.** Le démarrage noir, les longues attentes, l'OSD très utilitaire, les dialogues Android standards, les libellés tronqués et les erreurs sans changement de version empêchent l'effet « premium cinéma ».
- **Accessibilité D-pad : 4/10.** Le focus est généralement visible, mais il n'est pas toujours contenu par les modales, certains éléments sont inaccessibles au D-pad et plusieurs contrôles sont uniquement iconographiques.

Le couple **All Sources ↔ All Categories fonctionne bien dans les deux sens lorsque le focus est déjà sur la bonne rangée**. Le défaut réel est l'accès à cette rangée depuis la grille et les autres zones, particulièrement dans Series.

## Méthode et limites

Les constats visuels ci-dessous reposent uniquement sur les captures fraîches de cette session. L'audit combine :

1. navigation réelle par commandes D-pad ADB ;
2. captures de chaque état significatif ;
3. observation des délais et transitions ;
4. lecture ciblée du code Android TV ;
5. exécution des tests de contrat TV.

Les scénarios destructifs n'ont pas été activés : Logout a seulement été focalisé. La fin complète d'un film, la carte « Up next », le maintien long sur la timeline, TalkBack et une vraie TV Dolby Vision n'ont pas pu être validés dans cette passe.

## Étapes de l'audit

| # | Parcours | Résultat | Santé générale |
|---:|---|---|---|
| 1 | Validation émulateur, package, version et résolution | App TV correcte sur `emulator-5556` | Bonne |
| 2 | Menu principal vertical : Home, Live TV, Movies, Series, Settings, Logout | Focus très visible et parcours vertical généralement stable | Moyenne |
| 3 | Activation Menu → Home | Contenu noir puis conteneur vide pendant plusieurs secondes, sans état de chargement explicite | Mauvaise |
| 4 | Activation Menu → Live TV et sortie pendant chargement | Guide bloqué sur « Loading guide… » ; Left depuis la source saute vers « Hide unavailable » et ne rejoint plus le menu | Critique |
| 5 | Movies : All Sources ↔ All Categories | Gauche/droite fonctionne dans les deux sens une fois la première rangée atteinte | Bonne localement |
| 6 | Movies : accès filtres depuis grille/Continue Watching | Le focus peut atterrir sur le badge « 13 categories » et ne plus descendre directement vers la grille | Mauvaise |
| 7 | Series : accès filtres depuis première carte | Up saute jusqu'au menu Movies ; Right depuis ce menu revient sur la seconde rangée au lieu de la première | Critique |
| 8 | Dialogues Categories / Sources | Ouverture, navigation verticale et Back fonctionnels ; aspect visuel très système | Bonne fonctionnellement |
| 9 | Settings depuis le menu | Right saute directement au dernier onglet Transcoding et déplace le scroll ; Up rétablit ensuite la page | Mauvaise |
| 10 | Profils | Ouverture, parcours des profils, Add et Manage, puis Back : fonctionnels | Bonne |
| 11 | Notifications | Le panneau s'ouvre presque entièrement sous le bord inférieur de l'écran 1080p | Critique |
| 12 | Catalogue Movies / Series | Plusieurs détails affichent une image cassée, des métadonnées manquantes ou « Audio pending » | Mauvaise pour le premium |
| 13 | Lancement VOD | Une activation peut sembler inactive environ une seconde ; démarrage sur écran noir + spinner, sans affiche ni contexte | Mauvaise |
| 14 | Version 4K de Léon | Échec sur l'émulateur : Dolby Vision / HEVC 4K dépasse les capacités du codec virtuel | Non concluant sur vraie TV |
| 15 | Version FHD de Léon | Lecture réelle obtenue, avec reprise, image, durée et progression | Bonne, mais instable |
| 16 | OSD masqué → OK | Le premier OK révèle l'OSD sans mettre la vidéo en pause | Bonne |
| 17 | Recul 10 s, avance et timeline | Actions fonctionnelles ; timeline focalisable et seek possible, mais sans miniature ni repère de destination | Moyenne |
| 18 | Audio | Focus et retour utilisateur fonctionnent ; « No audio track available » est affiché en anglais | Moyenne |
| 19 | Sous-titres | Dialogue navigable, sélection visible, Back ferme correctement | Bonne fonctionnellement |
| 20 | Format d'image | Le mode change, mais l'état sélectionné n'est pas explicité de façon persistante | Moyenne |
| 21 | Panneau More | Quality, Playback et Sleep navigables ; libellés coupés à `192 Qual`, `1x Play`, `Off Sle` | Mauvaise visuellement |
| 22 | Back depuis More | Ferme le panneau et revient sur Lecture | Bonne |
| 23 | Accès au bouton Retour supérieur | Deux pressions Up depuis Lecture restent sur la timeline ; le bouton Retour supérieur n'est pas atteint | Mauvaise |
| 24 | Erreur et Retry | Retry / Back existent, mais le focus peut s'échapper derrière la modale vers Audio puis CC | Critique |
| 25 | Retour au catalogue | Écran totalement noir environ deux secondes, retour complet autour de six secondes, focus contenu restauré | Moyenne |
| 26 | Home / PiP | Home a quitté le lecteur ; aucun PiP visible sur cet émulateur après sept secondes | Non concluant |
| 27 | Tests de contrat | 9/9 navigation et 13/13 lecteur passent | Bonne couverture statique, preuve runtime insuffisante |

## Preuves principales — navigation D-pad

### Ce qui fonctionne

- Movies : All Categories → All Sources : [01-movies-categories-to-sources.png](./01-movies-categories-to-sources.png)
- Movies : All Sources → All Categories : [02-movies-sources-to-categories.png](./02-movies-sources-to-categories.png)
- Series : All Sources → All Categories : [33-series-sources-to-categories.png](./33-series-sources-to-categories.png)
- Series : All Categories → All Sources : [34-series-categories-to-sources.png](./34-series-categories-to-sources.png)
- Dialogue de source navigué au D-pad : [36-series-source-dialog-down.png](./36-series-source-dialog-down.png)

### Défauts bloquants ou perturbants

- Up depuis la première carte Series saute vers le menu Movies : [30-series-card-up.png](./30-series-card-up.png)
- Right depuis ce menu revient sur la seconde rangée de filtres : [31-series-menu-right.png](./31-series-menu-right.png)
- Live TV : Left depuis la source descend vers « Hide unavailable » : [23-live-source-left-jump.png](./23-live-source-left-jump.png)
- Settings : Right arrive directement sur Transcoding : [39-settings-menu-right.png](./39-settings-menu-right.png)
- Notifications rendues sous le viewport : [48-notifications-after-animation.png](./48-notifications-after-animation.png)
- Home reste sans contenu ni message après plusieurs secondes : [13-home-after-6s.png](./13-home-after-6s.png), [14-home-after-16s.png](./14-home-after-16s.png)

## Preuves principales — lecteur VOD

### Points forts observés

- Lecture FHD réellement démarrée : [80-subtitles-back.png](./80-subtitles-back.png)
- OK révèle l'OSD sans pause : [81-osd-reveal-after-dialog.png](./81-osd-reveal-after-dialog.png)
- Focus Recul 10 s et seek appliqué : [82-seek-back-focus.png](./82-seek-back-focus.png), [84-seek-back-immediate.png](./84-seek-back-immediate.png)
- Timeline focalisable : [85-up-from-rewind.png](./85-up-from-rewind.png)
- Sous-titres navigables : [79-subtitles-down.png](./79-subtitles-down.png)
- Feedback audio indisponible : [88-player-audio-dialog-ready.png](./88-player-audio-dialog-ready.png)
- More navigable et Back restauré sur Lecture : [95-player-more-dialog-retry.png](./95-player-more-dialog-retry.png), [96-player-more-sleep-focus.png](./96-player-more-sleep-focus.png), [98-player-more-single-back.png](./98-player-more-single-back.png)

### Écarts premium et erreurs

- Démarrage noir avec spinner à 0:00 : [69-leon-launch-1s.png](./69-leon-launch-1s.png), [71-leon-launch-20s.png](./71-leon-launch-20s.png)
- Erreur terminale après reconnexion : [92-player-after-reconnect.png](./92-player-after-reconnect.png)
- Focus visible derrière la modale : Back to Norva, puis Audio, puis CC reçoivent le focus : [72-player-right.png](./72-player-right.png), [73-player-right.png](./73-player-right.png), [74-player-right.png](./74-player-right.png)
- Bouton Retour supérieur non atteint après deux Up : [99-player-two-up.png](./99-player-two-up.png)
- Home sans PiP visible sur l'émulateur : [101-player-home-after7s.png](./101-player-home-after7s.png)

## Diagnostic produit

### Navigation

Le problème n'est pas l'absence totale de support D-pad. Il existe, et les composants locaux répondent correctement. Le problème vient de l'absence d'un **graphe de focus explicite et cohérent entre les zones** :

- menu global ;
- filtres rangée 1 ;
- filtres rangée 2 ;
- Continue Watching ;
- badges de filtres actifs ;
- tri ;
- grille ;
- panneau de détail.

Le calcul spatial implicite choisit alors l'élément géométriquement le plus proche, pas l'élément attendu par l'utilisateur. C'est ce qui explique le saut Series → Movies, l'entrée Settings → Transcoding et le piège Live TV.

### Lecteur

Le lecteur est conçu comme un OSD utilitaire de type IPTV. Le code le décrit d'ailleurs comme « TiviMate-style ». Cette orientation explique :

- une ligne dense de commandes ;
- Quality, Playback et Sleep dans More ;
- des barres opaques en haut et en bas ;
- peu de contexte cinématographique ;
- une priorité technique aux pistes et à la récupération.

La base est sérieuse, mais la promesse VOD premium exige une hiérarchie différente :

1. affiche ou backdrop pendant le démarrage ;
2. choix Reprendre / Recommencer ;
3. premier frame avec fondu ;
4. OSD plus léger et moins permanent ;
5. seek avec aperçu et destination ;
6. erreurs qui proposent réellement une autre version ;
7. Up Next avant la fin, Skip intro / recap et garde « Toujours là ? ».

## Forces d'ingénierie confirmées dans le code

- Recovery direct → fallback → nouvelle URL, avec Retry et retour.
- Sauvegarde de progression locale et cloud.
- Préférences audio / sous-titres persistées.
- Cibles de 48 dp, safe area et animation de focus.
- SubtitleView Media3 complet.
- PiP et protections de cycle de vie présents dans le code.

Fichiers de référence :

- `clients/android-tv/app/src/main/java/tv/norva/tv/PlayerActivity.java`
- `clients/android-tv/app/src/main/java/tv/norva/tv/MainActivity.java`
- `public/js/utils/tvNavigation.js`
- `tests/android-tv-navigation-contract.test.js`
- `tests/android-tv-player-contract.test.js`

## Priorités de correction

### P0 — fiabilité de navigation

1. Définir un graphe explicite de focus par page et par zone, avec retour à l'origine.
2. Bloquer le focus dans les modales d'erreur : aucune commande de l'OSD ne doit rester focalisable derrière.
3. Corriger la sortie de Live TV pendant le chargement afin que Left ou Back rejoigne toujours le menu.
4. Positionner le panneau Notifications dans les limites du viewport 1080p.

### P1 — cohérence et perception premium

1. Stabiliser les transitions de route et afficher skeleton, progression ou message au lieu d'un écran noir.
2. Empêcher le sélecteur de profil de réapparaître lors d'un simple changement de page.
3. Faire de la première rangée de filtres la destination verticale déterministe depuis la grille et la seconde rangée.
4. Corriger Settings pour entrer sur le premier onglet logique sans déplacer brutalement le scroll.
5. Ajouter une transition VOD avec poster/backdrop et choix Reprendre / Recommencer.
6. Ajouter « Changer de version » à l'erreur quand le texte le recommande.
7. Rendre le bouton Retour supérieur réellement atteignable, ou le supprimer au profit du bouton Back système.
8. Raccourcir et libeller les éléments More sans troncature.
9. Localiser tous les messages, toasts, erreurs, horloge et écrans de fin.

### P2 — finition premium

1. Remplacer les barres opaques par des gradients contextuels.
2. Ajouter miniatures de seek, horodatage de destination et accélération sur maintien.
3. Ajouter Skip intro / recap, Up Next avant la fin et « Toujours là ? ».
4. Différencier clairement Recul 10 s, Avance 10 s et épisode suivant.
5. Réduire le nombre de contrôles visibles simultanément et afficher des libellés à la demande.
6. Corriger les images cassées et les métadonnées « Audio pending » du catalogue.

## Accessibilité

Cet audit ne constitue pas une certification WCAG ni un test TalkBack. Les risques visibles sont néanmoins nets :

- focus qui fuit derrière une modale ;
- double emphase simultanée entre Lecture blanche et l'élément réellement focalisé ;
- spinner sans libellé ni annonce d'état visible ;
- timeline sans nom ou indication de destination ;
- icônes Audio, CC, Aspect et More sans libellé permanent ;
- bouton Retour supérieur inaccessible au D-pad ;
- messages anglais dans une expérience potentiellement française ;
- texte secondaire du panneau More trop petit et tronqué.

## Lecture des tests

Les commandes exécutées le 27 juillet 2026 donnent :

- `node --test tests/android-tv-navigation-contract.test.js` : **9/9 réussis** ;
- `node --test tests/android-tv-player-contract.test.js` : **13/13 réussis**.

Ces tests valident principalement la présence de garde-fous dans le code. Ils ne valident pas le calcul de focus réel du WebView, le viewport 1080p, les délais réseau, le confinement des modales, TalkBack ou le rendu temporel de la reprise. Les captures runtime doivent donc primer lorsque les deux preuves divergent.
