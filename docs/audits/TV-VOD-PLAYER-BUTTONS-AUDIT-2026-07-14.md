# Audit TV — boutons du lecteur VOD

Date: 2026-07-14
Surface auditée: lecteur natif Android TV (`PlayerActivity`) utilisé pour les VOD/épisodes depuis le shell TV Norva.

## Boutons vérifiés

- Transport: retour 10s, lecture/pause, avance 10s.
- Ligne de gestion: Video, Audio, Subtitles, Aspect, Speed, Sleep, Version, Next, Episodes/List.
- Navigation télécommande: D-pad haut/bas/gauche/droite, OK/Enter, Back, touches média.
- Retour vers le web shell: progression, fin naturelle, épisode suivant, réouverture de la fiche/liste d'épisodes.

## Problèmes identifiés

1. **Crash possible sur les boutons de la ligne de gestion**
   - Chaque bouton exécutait directement son action (`action.run()`).
   - Si une action rencontre un état non prévu côté TV (manifest sans piste compatible, métadonnées absentes, dialogue impossible à ouvrir, état Activity en fermeture), l'exception pouvait quitter brutalement le lecteur.
   - Le bouton `Episodes / List` était particulièrement sensible car il ferme l'Activity puis renvoie la main au WebView pour rouvrir la fiche.

2. **Bouton `Aspect` / zoom peu fiable**
   - Le changement de format dépendait uniquement de la taille vidéo déjà connue (`videoW/videoH`).
   - Si l'utilisateur appuyait avant la première remontée `onVideoSizeChanged`, le bouton semblait ne rien faire.
   - Le SurfaceView n'était pas remis explicitement dans un état neutre avant chaque recalcul, ce qui rendait certains cycles Fit → Zoom → Stretch incohérents sur TV.

3. **List/Episodes sans garde fonctionnelle**
   - Le raccourci était affiché pour les épisodes, mais l'action ne validait pas les identifiants nécessaires (`sourceId`, `itemId`) avant de fermer le lecteur.
   - En cas de payload incomplet, MainActivity ne pouvait pas reconstruire l'action web attendue.

## Corrections appliquées

- Ajout d'un wrapper `runBarAction()` autour de tous les boutons de la ligne TV: une erreur bouton est journalisée, un toast court est affiché, et la lecture reste ouverte.
- Remplacement de l'action inline `Episodes/List` par `openEpisodesList()`, avec validation stricte du contexte épisode + identifiants avant fermeture.
- Renforcement de `applyAspect()`:
  - garde `root/surfaceView`;
  - support du mode `Stretch` même avant disponibilité des dimensions vidéo;
  - remise à zéro scale/translation avant chaque changement;
  - `requestLayout()` explicite après redimensionnement.

## Points à valider sur vraie TV

- Appuyer plusieurs fois sur `Aspect` pendant les 5 premières secondes d'une VOD puis après chargement: Normal, Zoom et Stretch doivent alterner visiblement.
- Appuyer sur `Episodes/List` depuis un épisode: le lecteur doit se fermer proprement et rouvrir la fiche/liste sans crash.
- Appuyer sur `Video`, `Audio`, `Subtitles` sur une VOD avec peu/pas de pistes alternatives: un message doit s'afficher, pas de crash.
- Vérifier Back: un premier Back ferme la barre secondaire si ouverte; sinon il quitte le lecteur en sauvegardant la progression.
