# Conservation du décodeur — déploiement du pilote, 9 octobre 2026

## Résultat à 10:07 Paris

À la demande explicite d'Adrien, le code intégré jusqu'à **PR730** est déployé et la conservation du décodeur est **activée pour le seul compte déjà autorisé au pilote**. Ce compte correspond au compte ouvert dans le navigateur. Ce n'est pas une généralisation ni une validation de fluidité.

Les deux essais publics après déploiement échouent pendant la préparation, avant la première image : **Conclave (Dino)** à 1 222 s et **Le Robot Sauvage (MAX OTT)** à 660 s. La limite serveur de 60 s est atteinte, sans playlist produite. L'API restitue `gateway_502` et le lecteur affiche son erreur. Aucun transfert réussi, gain de reprise ou contrôle à l'écoute n'est revendiqué. La cause précise de ces deux échecs reste ouverte ; aucun A/B au même instant avec l'ancienne image ne permet de les attribuer ou de les exclure du déploiement.

Les essais sont arrêtés. Les deux Gateways et les deux Edge sont sains ; aucun lecteur ni claim actif du compte testé ne reste au contrôle de clôture. L'utilisateur peut essayer le pilote sur son compte, avec ces limites connues.

## Périmètre et garde-fous

- Révision déployée : `56736d049aad28a0342f0a2f2801d4b41c609a37` (fusion PR730 ; dernier code produit `a5668eade645f1ac46158c3b23da007a636df539`).
- Deux variables Gateway ajoutées : activation de `PRIVATE_RETAINED_SESSION_ENABLED` et une unique empreinte dans `PRIVATE_RETAINED_SESSION_OWNER_HASHES`. L'empreinte n'est pas publiée dans ce rapport. Tous les autres paramètres sont comparés à la référence et conservés.
- Le cache récent conserve sa liste de propriétaires existante. Le cache historique avait déjà une garde distincte sans liste spécifique ; elle n'est pas modifiée ni présentée comme une nouvelle ouverture.
- La conservation exige aussi le client compatible, l'identité et la génération exactes, le profil et les pistes, une position disponible et une nouvelle revalidation sous claim ordinaire. Une pause conserve le décodeur au plus dix secondes ; ce mécanisme ne promet pas une reprise rapide après une longue absence ou un saut arbitraire.
- Une seule connexion fournisseur ; anciennes autorisations révoquées, transport fermé pendant la pause, budgets disque et encodeur, délais, réserves de lecture et quarantaines inchangés. Aucune nouvelle route ou instance du dispatcher.

## Vérification avant déploiement

Le code dispose des **6 165 tests CI réussis et 31 ignorés**, ainsi que des six configurations Android déjà consignées dans PR730. Ils ne sont pas recomptés comme de nouveaux tests dans ce déploiement. Les publications Web Cloudflare `37900875000` et Relay `37900875083` de la fusion ont réussi. Le navigateur rechargé utilise `WatchPage.ecb55ad32be8ca41.js` et HLS.js 1.7.3.

Une nouvelle image est construite depuis la référence de production, sans changement de dépendances. **94 fichiers** Gateway vérifiés, dont onze nouveaux ou modifiés et 83 conservés. Les sources sont lisibles par l'utilisateur 1000 ; les permissions des paquets hérités sont conservées.

Canary de cette image à **09:57:29 Paris** : UID1000, réseau `none`, stockage temporaire séparé, GPU réel. Le test de fenêtre glissante avec vidéo/audio/sous-titres et continuation de 280 s réussit. Le canary FFmpeg de la position rendue retrouve les bornes 61/111, une origine de playlist à 96 s pour une position à 101 s, sans dépasser son budget. Les gardes d'activation refusent les autres propriétaires, la liste vide et le mode désactivé. Aucun appel fournisseur ; médias de preuve supprimés et conteneur arrêté/retiré.

Un premier contrôle de la garde utilisait par erreur un nom de fixture brut au lieu de l'empreinte attendue. La fixture est corrigée, sans changement d'image ni de produit, puis le canary complet réussit. Une prélecture opérateur a également été corrigée pour respecter la sémantique déjà déployée du cache historique sans liste ; la nouvelle conservation reste strictement limitée à une empreinte. Aucune mutation de production durant ces deux refus.

Le canary Edge vérifie la santé du runtime candidat avec ses connexions habituelles ; il n'est pas présenté comme isolé du réseau. Il ne lance aucun média. Il est arrêté et retiré avant application.

## Déploiement et restauration

### Edge

Seuls onze ajouts de lignes dans `norva-playback/index.ts` sont déployés : capacité du client courant et normalisation du descripteur de sous-titres publiés progressivement. **193 autres fichiers sur 194 et leurs permissions sont conservés**, y compris les différences de production sans rapport avec cette tâche. Aucune migration SQL.

- Runtime : `/home/adrien/.norva/retained-owner-pilot-20261009/edge/runtime-functions`.
- SHA-256 playback : `60280e24f89fd7f11003638fc26068feef1b769115bf02a56ffb0e18d4747c9d`.
- Démarrages : `07:59:52.741` et `07:59:56.379` UTC.
- Admissions suspendues de `07:58:34.202685` à `07:59:59.864693` UTC, soit **85,662008 s**, drainage compris. Un bail strict a terminé naturellement. Cron, admission et worker restaurés ; dispatcher conservé.

### Gateways

- Image : `sha256:b7daa15239a9e156792eb684601eb8f76fdfd3916ad8217a02e5006484e23624`.
- Arbre des sources : `007b8b28e1276ede6d43b515c66d8b27822251b36feaffc615df58ea9d04cd56`.
- Démarrages : `08:00:40.638` et `08:00:43.251` UTC.
- Admissions suspendues de `08:00:23.855359` à `08:00:44.988100` UTC, soit **21,132741 s**, drainage compris. Aucun bail forcé ni session utilisateur interrompue.
- Anciennes instances conservées arrêtées sous le suffixe `before-retained-owner-pilot-20261009`. Les configurations précédentes privées sont conservées pour le retour arrière. La politique de redémarrage `unless-stopped` est inchangée.

Les 94 empreintes Gateway et les 194 empreintes Edge concordent après application. La restauration des admissions, cron, worker et dispatcher est vérifiée après chaque phase. Ces suspensions sont consignées ; ce n'est pas un déploiement déclaré sans interruption des admissions.

## Contrôle dans le véritable lecteur public

| Copie exacte | Session créée (UTC) | Résultat |
| --- | --- | --- |
| FR - Conclave (2024), Dino | 08:01:58.334 | À 08:02:58.723 : `Playlist was not generated`. Événement public d'erreur à 08:03:01.333. Zéro première image. |
| FR\| Le Robot Sauvage, MAX OTT | 08:04:00.887 | À 08:05:01.465 : `Playlist was not generated`. Événement public d'erreur à 08:05:04.061. Zéro première image. |

Les demandes authentifiées transportent `committedSubtitleDelivery:1`. Conclave reçoit effectivement le descripteur `committed-webvtt / source-pes-v1` pour les pistes 2 et 3 dans le Gateway public. Ce constat prouve le raccordement actif, pas une réplique affichée : le média ne démarre pas. Le Robot Sauvage constitue un contrôle d'une autre copie/format sans ce descripteur ; il ne prouve pas un transfert de décodeur.

Les instantanés intermédiaires montrent des fenêtres encore en réception et aucune playlist. Le diagnostic final de Conclave ne contient pas de détail FFmpeg ; celui du Robot contient l'avertissement DRM `os_same_file_description`, sans cause fatale établie. Ni cet avertissement ni les anciens ralentissements du relais ne suffisent à attribuer ces deux nouveaux échecs. Pas de changement de timeout, de réserve ou de codec pour les masquer.

## Clôture technique et suite

À **10:07:23 Paris**, les deux Gateways ont zéro session active, zéro pompe et zéro réservation d'encodeur occupée sur huit. Le compte testé n'a aucun claim actif. Admission et cron actifs, worker et dispatcher en exécution. Canaries arrêtés ; navigateur revenu au catalogue. Aucun média de diagnostic fournisseur téléchargé par l'opérateur pendant ce contrôle.

**Le déploiement du pilote est effectué ; l'acceptation fonctionnelle reste ouverte.** Il faut obtenir un démarrage réel, une reprise transférée dans l'interface publique, puis mesurer la continuité et recueillir l'écoute. Ne pas généraliser sur la seule réussite des canaries et ne pas annoncer Normal ou Conclave réparés. Les anciens essais et leurs limites restent dans le [rapport cumulatif](2026-10-08-sparse-subtitle-resume.md).

Reçus privés/sûrs séparés sous `.codex-artifacts/retained-owner-pilot-20261009/` : manifestes, canaries, déploiements, santé finale, `first-start.safe.json`, `robot-after-minute.safe.json`, `failure-diagnostics.safe.json` et `public-startup-limit.png`. Aucun identifiant client, accès fournisseur ou URL média n'est publié.

## Suite à 10:53 Paris — cache absent et priorité MP4

[PR732 et son rapport](2026-10-09-finite-seek-priority.md) documentent la comparaison ancienne/nouvelle image, le cache HLS vide après redémarrage et échecs à froid, et le défaut d'une continuation MP4 lente qui retarde le saut demandé. La correction bornée au pilote est intégrée et déployée, avec 6 171 tests CI réussis et un canary isolé. Les paramètres, gardes et périmètres restent inchangés.

Le Robot Sauvage atteint la plage de reprise après correction, mais échoue encore avant première image à la limite de 60 s. Aucun gain de fluidité ni acceptation à l'écoute ; les lectures sont arrêtées, les Gateways sains et les traitements restaurés. Le présent état de 10:07 reste historique ; les nouvelles empreintes et la pause de déploiement sont dans le rapport lié.
