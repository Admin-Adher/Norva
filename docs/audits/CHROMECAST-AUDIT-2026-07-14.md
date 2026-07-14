# Audit Chromecast / télé connectée — 2026-07-14

## Symptôme utilisateur

Le bouton Chromecast apparaît côté web, mais le lancement vers une TV connectée / Chromecast built-in échoue ou retombe sur « Cast unavailable for this title ».

## Audit technique

### 1. Réutilisation fragile de l'URL de lecture locale

`WatchPage.startCasting()` pouvait envoyer au récepteur l'URL déjà utilisée par le lecteur local quand elle semblait « safe » (`mp4`, `webm`, `m3u8` ou URL gateway sans extension). Sur une TV connectée, ce choix est fragile :

- le récepteur Cast télécharge le média depuis la TV, pas depuis l'onglet ;
- l'ancienne session cloud/relay peut être attachée au lecteur local ;
- les fournisseurs IPTV single-slot refusent souvent la deuxième connexion quand le navigateur garde encore son flux ;
- un MP4 « safe par extension » peut encore contenir HEVC/AC3 non décodable par le Default Media Receiver.

### 2. Interruption locale avant annulation du sélecteur

L'ancien flux libérait parfois le pipeline local avant que le choix du device soit confirmé. Si l'utilisateur fermait le sélecteur, la lecture locale devait être relancée.

### 3. API sender trop monolithique

`NorvaCast.castMedia()` ouvrait le sélecteur et chargeait le média dans la même méthode. Le player ne pouvait donc pas :

1. demander la TV ;
2. attendre la confirmation ;
3. seulement ensuite libérer le flux local ;
4. créer une session HLS dédiée Cast.

## Correctifs appliqués

- Ajout de `NorvaCast.requestSession()` pour ouvrir le sélecteur Cast séparément du chargement média.
- `WatchPage.startCasting()` demande d'abord la TV sans toucher à la lecture locale.
- Une fois la TV choisie, Norva libère le pipeline local, attend brièvement la libération du slot fournisseur, puis crée une session HLS transcodée dédiée au Cast.
- Le récepteur reçoit maintenant une URL HLS fraîche, en H.264/AAC, au lieu de réutiliser l'URL locale potentiellement incompatible.
- Clarification de `NorvaCast.isCasting()` pour éviter toute ambiguïté de précédence booléenne.
- Cache-busters mis à jour dans `app.html` pour `castSender.js` et `WatchPage.js`.

## Vérification manuelle recommandée

1. Ouvrir Norva Web dans Chrome/Edge desktop sur le même réseau que la TV.
2. Lancer un film/série.
3. Cliquer l'icône Cast.
4. Annuler le sélecteur : la lecture locale doit continuer/reprendre sans erreur.
5. Relancer Cast, choisir la TV : la barre Cast Norva doit apparaître et la TV doit charger le média.
6. Tester pause/play, seek, arrêt, puis reprise locale.

## Reste à surveiller

- Si la TV ne voit aucun appareil, vérifier le réseau local/mDNS, VPN, isolation AP et que Chrome autorise Cast.
- Si la TV charge puis coupe après quelques secondes, vérifier les logs gateway/transcode et la compatibilité du Chromecast built-in avec HLS long-running.
- Le Default Media Receiver reste moins contrôlable qu'un receiver Norva custom. Un receiver Cast dédié permettrait un meilleur diagnostic à l'écran et une gestion d'erreurs plus précise.
