# Conservation pendant une lecture ordinaire — 9 octobre 2026

## Conclusion et périmètre

Demande : évaluer la préparation d'une version conservée sans monopoliser une seconde connexion du compte fournisseur. L'essai confirme qu'une lecture peut alimenter sa propre conservation avec une seule acquisition. La fermeture ordinaire libère le compte. **Il ne valide pas une reprise rapide après fermeture avant la fin, ni une compression des copies lourdes.** Aucun code produit, configuration, quota, bail, route ou déploiement modifié.

Reçus : `.codex-artifacts/playback-cache-conservation-20261009/`. Le JSON associé conserve les mesures anonymisées. Image Gateway réellement testée et déjà en production : `sha256:ea9594c68c27ded59edd2c1748893f758820705ab74eb521add99411ad702c40`. Base du dépôt : `b1323824c601cc6d5e49ac39b78e86e5befb1de0` (PR743).

## État actuel, relu avant l'essai

Le cache complet partagé existe déjà : activé sur les deux Edge/Gateways, admission `enforced`, stockage privé, empreinte complète du fichier, topologies audio/sous-titres exactes et manifeste publié en dernier. Il est distinct des caches récents et du décodeur conservé du pilote propriétaire. Deux objets `ready` sont enregistrés, un seul encore valide selon les deux échéances ; aucune nouvelle publication pendant nos lectures publiques.

La conservation complète HLS est bornée aux producteurs admis depuis zéro, MKV exacts, source au plus 768 Mio, durée au plus une heure et sortie au plus 4 Gio. Le stockage HLS ordinaire reste borné à 512 Mio. Normal mesure 13 662 582 623 octets et 5 513,984 secondes : il dépasse les deux bornes d'entrée. Elles n'ont pas été augmentées. L'admission est aussi soumise aux autres gardes ; la taille seule n'autorise pas le traitement.

La continuation sans spectateur initial est déjà limitée à une demande de suiveurs autorisés, préemptable et bornée à trente minutes. Elle n'autorise pas un téléchargement intégral implicite après chaque fermeture. Aucun suiveur n'était présent dans l'essai réel.

## Contrôle isolé : 16 tests réussis, aucun ignoré

Exécution dans l'image Gateway exacte, UID1000, réseau `none`, capacités retirées, stockage temporaire séparé et limites CPU/mémoire. Fournisseur, stockage et callbacks d'autorité simulés en loopback ; vrais Gateway, FFmpeg et client privé de stockage. Aucun média fournisseur ni écriture d'autorité/R2 de production dans ce contrôle.

Le nouveau scénario complet utilise 24 secondes H.264, deux pistes AAC stéréo et six répliques SRT :

- une seule requête source, concurrence maximale un, un seul FFmpeg ; connexion source nulle à EOF ;
- acquisition complète et sortie FFmpeg terminée avant publication ; empreinte complète source concordante ;
- une publication, 44 fichiers et 2 354 017 octets, après une source de 2 107 970 octets ; conserver n'est donc pas nécessairement compresser ;
- récupération de tous les objets via le client privé, empreintes vérifiées, décodage réel des deux pistes AAC et présence des six répliques ; aucune nouvelle requête source pour ce décodage ;
- fermeture ordinaire : ressources libérées, ancien accès refusé (401 ou 404).

Les tests existants complètent le contrôle : dix spectateurs autorisés rejoignent un seul producteur ; détachements indépendants ; interruption avant EOF sans publication ; demande nulle arrêtant le travail ; préemption avec drainage avant reconnexion ; refus des données partielles et des identités non concordantes. Le nouveau scénario ne constitue pas un cache-hit navigateur via l'autorité Edge/PostgreSQL réelle, dont les callbacks restent simulés ici.

Historique des fixtures conservé : profil synthétique initial incomplet refusé ; réservation de 4 Gio incompatible avec la réserve disque par défaut dans le petit conteneur ; confusion entre chemin logique et `objectName` ; attente 401 trop stricte alors que l'accès supprimé retournait 404. Corrections des seuls scripts de preuve, image candidate inchangée. Le plancher disque du conteneur de preuve a été fixé à 1 Gio avec tmpfs plafonné à 8 Gio ; aucun plancher de production modifié. Les 13 tests locaux réussis et trois ignorés sur Windows ne sont pas utilisés comme preuve du runtime Linux. Le conteneur de preuve et ses médias temporaires ont été retirés.

## Deux lectures publiques : Severance S1E1 anglais, Strng

Même copie MKV, 475 790 063 octets, durée 3 434,773 secondes. La carte de série affiche MP4, mais le fichier d'épisode mesuré est MKV ; ce libellé ne prouve pas le conteneur de chaque épisode. Sélection anglaise explicite pour l'essai ; sélection française d'origine restaurée ensuite, sans la lire.

| Mesure depuis le clic | Départ à zéro | Réouverture à 297 secondes |
| --- | ---: | ---: |
| Clic UTC | 15:58:37.942 | 16:04:41.915 |
| Première image | 6,304 s | 53,122 s |
| Lecture effective | 13,146 s | 122,018 s |
| Préparation FFmpeg serveur | 0,508 s | 50,354 s |
| Cache complet / fenêtre de reprise réutilisé | non | non |

Le premier départ est admis comme producteur du cache complet (`enforced`, raison `repeated`, score98), avec conservation HLS activée et un FFmpeg. Une acquisition préouverte, aucune réouverture du pump observée ; à 16:03:56, 32 484 015 octets reçus/transmis. Les segments conservés occupaient 35 037 197 octets. Aucune seconde acquisition dédiée à la conservation.

La progression jusqu'à 297 secondes ne prouve pas une lecture sans interruption : la réserve diminue, `readyState=2` est relevé à 16:04:14 ; les échantillons espacés ne mesurent pas toutes les pauses ni toutes les images. Le premier relevé utilisait par erreur la vidéo live TV cachée : il a été exclu. Les suivants ciblent exclusivement `#watch-video`. Aucun contrôle à l'écoute ni décodage de nouveaux extraits de cette copie effectué.

Fermeture par Retour à 16:04:22.683. À 16:04:34.244 : zéro session/pompe/encodeur sur les deux Gateways et zéro claim du propriétaire. Cache complet non publié, source non terminée, aucune poursuite sans demande. Le cache partiel n'a conservé aucune entrée ; compteur de rejets du secondaire 3→4, dernier motif `session-ineligible`.

La réouverture utilise le parcours ordinaire à 297 secondes. Première image à 16:05:35.037, mais `paused=true` et réserve insuffisante jusqu'à 16:06:29 au moins ; lecture effective à 16:06:43.933. À 16:06:51, temps relatif7,020, `readyState=4`, erreur nulle ; fermeture volontaire à 16:07:00.540, position finale313. Cela valide environ seize secondes de progression après le départ tardif, pas plusieurs minutes de fluidité.

## Limite de coexistence des caches

Le code courant exclut explicitement `session.mediaCacheProducer` de `privateResumeHlsBindingForSession`, `privateResumeRetainedInputBinding` et `tryParkRetainedSession`. Le premier essai était un producteur admis ; après arrêt avant EOF, il ne possède donc ni objet complet publié, ni fenêtre privée, ni décodeur transférable. Les reçus constatent l'absence de ces trois réutilisations. Cette exclusion explique l'absence de cache à la réouverture ; elle ne suffit pas à attribuer les 50 secondes de préparation ou l'arrivée lente des données à une cause réseau déterminée.

La suite utile est d'étudier une conservation privée bornée lors de l'abandon d'un producteur complet, après arrêt/drainage et retrait de son autorité partagée : identité exacte, pistes et couverture de sous-titres conservées, anciens accès révoqués, aucune connexion supplémentaire, aucun partiel publié comme complet. Il faut démontrer une réserve exploitable ; le premier essai finissait presque sans avance, donc autoriser cette coexistence ne garantit pas à lui seul une reprise rapide. Aucun retrait des exclusions ou élargissement de limites appliqué sur cette seule observation.

## Clôture

À 16:07:18.658 UTC (18:07 Paris) : deux Gateways sains, zéro session, zéro pompe, zéro réservation d'encodeur et zéro claim actif du propriétaire. Deux lancements publics au total ; aucun appel média opérateur parallèle. Essais arrêtés, sélection initiale rétablie et navigateur revenu à la grille Séries. Production inchangée. Normal n'a pas été relu et aucun gain supplémentaire n'est revendiqué.
