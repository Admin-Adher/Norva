# Reprises Normal / Severance : contrôle du soir

7 octobre 2026, 19:04–19:12 Paris (17:04–17:12 UTC). Suite de `2026-10-07-recent-resume-slow-copies.md`. Deux lectures séquentielles autorisées, aucune relance automatique, aucun changement de code, déploiement, route, seuil ou délai.

## Résultat réel

Le gain observé le matin ne garantit pas les reprises suivantes. Les deux copies exactes Strng échouent cette fois avant première image :

| Copie | Création UTC | Diagnostic terminal UTC | Préparation FFmpeg | Segments prêts |
|---|---|---|---:|---:|
| Normal 4K FR HDR | 17:04:41.212 | 17:05:44.359 | 60,018 s | 0 |
| Severance FR S1E1 | 17:08:24.672 | 17:09:28.647 | 60,010 s | 0 |

Le diagnostic conservé `/debug/failures` donne `PLAYLIST_TIMEOUT` pour chacun. Le message client est générique et la session porte `gateway_502`. Aucun événement de première image ni de lecture réussie. Les 80 observations DOM espacées d'environ 500 ms pour chaque essai ne montrent aucun buffer disponible ; elles ne couvrent pas seules toute la durée de la préparation, le diagnostic serveur fournit le résultat terminal.

Les données ne sont pas absentes : le broker a achevé six plages pour Normal et cinq pour Severance, avec une plage supplémentaire encore active au snapshot terminal. Sur Normal, deux acquisitions de 2 Mio durent 6,523 et 14,841 s ; celle de 8 Mio suivante n'a reçu que 2 954 234 octets au moment de l'arrêt. Sur Severance, deux plages de 2 Mio durent 2,618 et 14,275 s ; la suivante a reçu 7 759 093 octets sur 8 Mio. Leurs en-têtes arrivent bien plus tôt : 0,287–0,760 s pour ces quatre plages de 2 Mio. L'attente est surtout dans l'arrivée du corps média sur ces requêtes, avant le buffer navigateur. Cela ne départage pas stockage/livraison, proxy commun et effets du transport local ; aucun test réseau indépendant ne l'attribue au fournisseur seul.

Normal présente ensuite dans FFmpeg une fin prématurée, HTTP 503 sur le broker loopback et des refus de connexion **127.0.0.1** après nettoyage. Ces refus locaux ne sont pas une preuve de refus distant et le 503 ne doit pas être attribué au serveur fournisseur. Le diagnostic terminal conservé est l'expiration de la préparation. Aucun bail forcé, aucune nouvelle tentative opérateur sur ces copies.

## Cache et piste de réserve

À 17:04:23, le cache récent est vide sur les deux Gateways. Les reprises précédentes datent d'environ dix heures et le TTL reste dix minutes : ces essais sont hors fenêtre récente. Ils ne démontrent donc ni un nouveau refus `target-changed`, ni une régression d'un hit chaud. Le refus de cible observé le matin reste documenté séparément.

La lecture du code trouve une piste sur le gate adaptatif : avec des segments de deux secondes, une interruption d'ajouts au buffer supérieure à 2,5 s réinitialise l'observation. Les fenêtres source peuvent pourtant arriver par lots. Mais les nouveaux essais n'atteignent pas ce gate et ne valident pas cette attribution sur Normal/Severance. Aucun seuil abaissé ni correctif de réserve livré sur cette hypothèse. Prolonger simplement le délai de 60 s ne constituerait pas une reprise rapide.

## État final

À 17:12:35 UTC, Gateways sains, zéro session active, image PR693 `sha256:63717edee76af73f1916d7b564050bcb394359d4d83d174843d8f593375c19e2`, dates de démarrage inchangées. Pilote limité à la liste autorisée, extension globale désactivée. Navigateur revenu aux Films. Aucun nouveau test de décodage AAC ne peut être revendiqué puisque aucune sortie n'a été produite. Les preuves antérieures restent valides dans leur périmètre, mais une fiabilité générale n'est pas démontrée et aucun nouveau correctif n'est déclaré.

Reçus privés/sûrs : `.codex-artifacts/resume-buffer-cadence-20261007/`. JSON voisin : diagnostics techniques sans URL, accès ni identité de compte. Capture de l'erreur : `severance-error.png`.
