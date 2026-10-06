# Promax — attente de reprise après les corrections de démarrage

## Périmètre

Suivi des deux copies anglaise et arabe de *March of the Penguins* testées dans `2026-10-05-promax-penguins-startup-fix.md`. L'ancien relevé reste inchangé : environ 138 s et 47 s jusqu'à la lecture effective, respectivement. Les positions de reprise sont celles du lecteur ; des positions différentes ne forment pas un benchmark contrôlé de gain global.

## Causes et corrections vérifiables

### Ancienne continuation MP4 après une nouvelle plage

Les traces de la copie arabe montrent quatre ouvertures d'anciennes plages, annulées 108–140 ms après leur ouverture, sans octet reçu. Le délai local précédant la mise en file avait déjà expiré pendant la réception d'une plage plus récente. À la libération du mutex, l'ancienne continuation repartait avant que le démultiplexeur ferme son lecteur. Chaque véritable interruption conserve le délai fournisseur de 2,5 s.

Le correctif donne à cette seule ancienne continuation la même grâce locale bornée après l'acquisition du mutex, une fois par nouvelle demande. Une réponse locale toujours utilisée reste complète. Aucun délai fournisseur, abandon forcé de lecteur ou concurrence supplémentaire.

Le test reproduit l'ouverture avant correction. Après correction, deux seules requêtes distantes suffisent et aucune n'est interrompue. Une seconde variante conserve l'ancien lecteur et vérifie sa réponse complète. La première fixture utilisait un fichier inférieur au minimum du bloc atomique : son assertion ne reproduisait pas le défaut ; elle a été corrigée avant la reproduction valide.

### Petits blocs maintenus pendant toute une lecture MKV

La copie anglaise utilisait des blocs distants de 2 Mio, même après la résolution de l'index et le début d'une lecture continue. Les requêtes ont chacune un coût de réponse. Le correctif conserve ces petits blocs au démarrage de chaque demande et autorise le bloc ordinaire de 8 Mio après 4 Mio consommés dans la même réponse locale, uniquement pour un MKV à piste audio unique. TS, MP4, multi-audio et acquisition LID ne reçoivent pas cette adaptation.

Test réseau isolé : mêmes 20 Mio rendus octet pour octet, dix requêtes avant contre quatre avec croissance. Un nouveau saut recommence avec deux blocs de 2 Mio ; une seule connexion distante maximale et zéro interruption dans les deux variantes. Cette réduction de requêtes ne démontre pas à elle seule un facteur de vitesse en production.

## Vérifications

- Code `9a70c6e78c02a8a18b311cc044883474ba931547`, PR 671.
- Tests ciblés : 238 tests, 232 réussis, zéro échec, six ignorés.
- Canary réel : onze réussis, zéro échec, réseau isolé, UID 1000, GPU réel, stockage distinct ; aucun appel fournisseur. Conteneur arrêté et supprimé après preuve.
- Seul `src/index.js` change dans les 84 fichiers Gateway ; 83 autres fichiers conservés. Edge et client inchangés.
- Réserve de démarrage, seuil de cadence, timeouts, circuit fournisseur, quotas et mono-connexion inchangés.

CI Linux du code : 5 993 tests, 5 963 réussis, zéro échec, 30 ignorés. Ces groupes se recoupent et ne s'additionnent pas. Les paquets Android/Windows sont suivis séparément ; aucun nouveau client, émulateur ou bundle Play n'est nécessaire pour ce changement serveur seul.

## Déploiement

Image `sha256:9ccffd8627995d88b483ace06dbbf1e84d98b789e2ad6c8c4491fde694c967d0`, arbre des 84 fichiers `1f82eb80402c57d26627d4df151646d2c21d84d7950f387182397034e8619482`.

Pause d'admission du 6 octobre à 01:02:36.044–01:02:57.174 UTC (03:02 Paris), soit 21,130 s. Les deux Gateways ont été remplacés séquentiellement après drainage naturel. Aucun bail forcé ; même dispatcher, cron, admission et worker restaurés. Santé et 84 empreintes par Gateway vérifiées à 01:03:05 UTC. Les deux Edge restent inchangés. Les canaries et le test isolé précèdent l'application ; la suite cloud termine avec succès avant la clôture de ce déploiement.

Reçus privés et sûrs séparés sous `.codex-artifacts/promax-resume-latency-20261006/`. L'attachement Codex de PR 671 est refusé à la limite de 100 ; aucune pièce supprimée.

## Reprises réelles

Les mesures de lecture effective et de continuité ci-dessous proviennent des événements serveur et du DOM du navigateur, sans clic Lecture forcé. Une première image ne vaut pas début de lecture ; les compteurs de préparation serveur sont figés après l'état prêt.

### Arabe — reprise à 395 secondes

Session créée à 01:03:23.351 UTC (03:03 Paris), serveur prêt en 19,484 s, lecture automatique à 01:03:44.174, soit 20,823 s après création. Première image télémétrique 21,595 s ; cette métrique utilise une origine différente de la création DB et peut être enregistrée après `play_started`.

DOM : temps média 1,699128 à 01:03:45.464 puis 55,730581 à 01:04:39.495 et 124,488127 à 01:05:48.252. Progression de 122,788999 s en 122,788 s réelles ; `paused=false`, `readyState=4`, erreur nulle aux trois observations. Réserve finale 53,537983 s. À 01:05:53 : 44 lectures distantes terminées, zéro interruption, trois ouvertures évitées. Les quatre interruptions du précédent démarrage ne se reproduisent pas sur cet essai. Retour normal à la fiche avant de sélectionner l'anglais.

### Anglais — reprise à 185 secondes

Session créée à 01:06:28.143 UTC (03:06 Paris), serveur prêt en 32,577 s, première image en 33,930 s. Lecture automatique à 01:07:43.725, soit 75,581 s après création. La cadence initiale 0,419× ne qualifie toujours pas le démarrage rapide serveur. Le navigateur dispose ensuite de suffisamment de croissance et de réserve selon sa politique adaptative existante, sans modification de seuil ni clic Lecture forcé.

Les traces confirment deux petits blocs après la plage initiale puis des blocs de 8 Mio dans la même lecture continue, avec zéro interruption au relevé de démarrage. Deux blocs de 8 Mio mettent encore 12,470 et 17,940 s à arriver, puis un suivant 5,703 s : la variabilité du transfert subsiste. Ces durées ne permettent pas d'attribuer la cause interne au fournisseur plutôt qu'au relais commun.

DOM : temps média 12,958421 à 01:07:56.553 UTC, 65,011167 à 01:08:48.605 puis 144,818102 à 01:10:08.413. Progression de 131,859681 s en 131,860 s réelles ; `paused=false`, `readyState=4`, erreur nulle aux trois observations. Réserve finale 69,227231 s. Dernier relevé en lecture : 36 requêtes distantes, 35 terminées, une en cours, zéro interruption. Retour normal à la fiche, puis première version française sélectionnée sans lecture.

## État final

Les cinq check-runs du code réussissent, paquets Android Phone/TV et Windows compris. Aucune relance CI. Santé et empreintes finales vérifiées ; les deux Gateways n'exposent aucune session à 01:10:56 UTC (03:10 Paris), après les fermetures normales. Les traitements permanents sont restaurés et actifs. Le JSON associé conserve les mesures ; capture de la fiche finale dans `closed-player.jpg`, reçus sous le répertoire indiqué ci-dessus.

## Limites

Les défauts Norva reproduits sont corrigés. Une reprise anglaise reste de l'ordre de 76 secondes ; l'attente n'est pas supprimée. Les positions de reprise diffèrent de celles du rapport précédent et les transferts fluctuent : aucun facteur global de gain n'est revendiqué. Aucun changement des copies, doublages, sous-titres, codecs, routes ou accès pour obtenir ces résultats. Les autres incidents distants décrits dans les rapports précédents restent distincts.
