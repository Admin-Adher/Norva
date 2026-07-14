# Audit compte à rebours / épisode suivant — Web, mobile, TV (2026-07-14)

## Verdict court

Norva avait déjà les briques fonctionnelles : bouton « épisode suivant », panneau « Up Next », autoplays, garde-fou « Are you still watching? », pont natif Android et overlay Android TV. Le ressenti n'était toutefois pas encore Netflix-grade : apparition trop tardive, compteur numérique brut, layout peu premium sur mobile/TV, et fortes différences entre web, mobile natif et TV.

## Web desktop

### État observé

- `WatchPage.updateProgress()` affichait le panneau seulement 10 secondes avant la fin, donc souvent au dernier plan / générique final plutôt qu'au début des crédits.
- `showNextEpisodePanel()` lançait un `setInterval` sans nettoyer explicitement un interval précédent à l'ouverture.
- Le compte à rebours était un texte simple (`10`) sans anneau/progression visuelle.
- Le panneau contenait déjà titre, still et synopsis, mais le style restait compact et moins premium.

### Correctifs appliqués

- Apparition anticipée à 28 secondes restantes quand l'autoplay est activé.
- Countdown par défaut à 15 secondes, visuellement rendu par un anneau `conic-gradient`.
- Nettoyage de l'interval avant chaque nouvelle ouverture.
- États ARIA (`aria-live`, `aria-hidden`) pour rendre le compte à rebours compréhensible.
- Boutons renommés en « Play next » / « Watch credits ».
- Garde anti-null si aucun épisode suivant n'est disponible au moment du clic ou du timer.

## Mobile web / PWA / Android phone shell

### État observé

- Le shell web utilise le même `WatchPage` que desktop, donc il profite du panneau corrigé.
- Le CSS mobile existant mettait le panneau en wrap, ce qui pouvait pousser les boutons et donner un rendu instable sur petits écrans.
- Le player natif Android phone (`clients/android-phone`) ne possède pas de panneau natif premium : à la fin naturelle, il ferme `PlayerActivity` et notifie le WebView (`__norvaNative.onEnded`), puis la fiche série web affiche son propre prompt.

### Correctifs appliqués

- Layout mobile stabilisé : panneau pleine largeur, still compact, synopsis masqué sur petit écran, actions alignées.
- Le shell web garde maintenant le même niveau de polish que desktop pour les lectures web/PWA.

### Reste à faire

- Ajouter un vrai overlay natif Android phone dans `PlayerActivity`, au lieu de revenir au WebView avant de proposer l'épisode suivant. C'est le dernier écart majeur avec Netflix mobile natif.

## Android TV / mode TV

### État observé

- Le web en `tv-mode` utilisait le même panneau que desktop, sans taille/espacement 10-foot dédiés.
- L'APK Android TV a déjà un overlay natif `Up next` avec compteur et bouton, mais son rendu reste très basique : panneau vertical, pas de still/synopsis, wording « Back » au lieu de « Watch credits », pas d'anneau de progression.

### Correctifs appliqués

- Ajout de règles CSS `html.tv-mode` : panneau plus large, textes et boutons agrandis, still plus grande, compteur circulaire plus lisible au D-pad.
- Le web TV / cloud TV bénéficie du même flow anticipé que desktop.

### Reste à faire

- Porter le design premium côté `clients/android-tv/app/src/main/java/tv/norva/tv/PlayerActivity.java` : still, synopsis, anneau de progression, labels homogènes et focus D-pad visuellement plus fort.

## Risques / points à surveiller

- Les épisodes dont la durée est inconnue ou trop courte (< 180 s) ne déclenchent pas l'affichage anticipé ; ils gardent le fallback à `ended`.
- Les métadonnées d'épisode dépendent de `seriesInfo`. Si la série est incomplète ou si l'épisode courant n'est pas dans la liste, aucun « next » ne doit apparaître.
- Le natif phone reste fonctionnel mais pas premium : audit volontairement noté comme dette, car le changement demande une UI Java dédiée.
