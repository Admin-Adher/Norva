# Préparation de l'extension des reprises récentes et poursuite de Conclave

## Portée demandée

Préparer l'extension aux comptes actuels et futurs et poursuivre l'optimisation des copies lentes. L'activation générale en production reste distincte de cette préparation. Le code est intégré dans PR690, tête `aa409ef569a91d6e61d1721ccba06d2e3ce09f4b`, fusion `1c1333d1038e2be739ea5d7cdc3c36c2655be61c`.

## Extension préparée

Le nouveau drapeau explicite `PRIVATE_RESUME_RECENT_SAMPLES_ALL_AUTHENTICATED_OWNERS=true` retire uniquement la restriction de déploiement aux propriétaires pilotes. Le mode par défaut exige une liste pilote configurée ; une liste absente ou invalide n'active plus implicitement tous les comptes. Les propriétaires continuent à provenir des demandes authentifiées Edge. La liaison propriétaire/source/révision/fichier/profil/pistes, les quatre prélèvements frais, la taille exacte et la cible restent exigés.

Le fichier `ops/hetzner/recent-resume-rollout.env.example` prépare la configuration, sans être chargé automatiquement. Avant activation générale, vérifier que le cache privé de base est lui aussi éligible sur les deux Gateways et que leurs versions et réglages concordent. Conserver la liste pilote pour revenir au mode restreint avec le drapeau global à false ; désactiver seulement `PRIVATE_RESUME_RECENT_SAMPLES_ENABLED` permet d'arrêter les reprises fondées sur les prélèvements récents. Toute recréation passe par le drainage naturel et la priorité aux lectures.

Les plafonds restent 256 Mio agrégés par Gateway, 64 Mio par entrée et dix minutes de validité récente. Ils ne sont pas multipliés par le nombre de comptes. Les tests font passer 24 propriétaires différents dans un budget fixe et vérifient l'absence d'accès croisé ainsi que la révocation propre à chaque propriétaire. Les évictions peuvent réduire le taux de réussite du cache sous forte demande ; elles doivent mener à la lecture ordinaire. Cache local au processus : redémarrage ou changement de Gateway peut également entraîner une absence de cache. Aucun partage de données entre propriétaires ni routage nouveau.

Relevé read-only après déploiement à 02:15:12 UTC : deux Gateways sains, zéro session, plafonds 256/64 Mio, limites des conteneurs 10 Gio chacune ; environ 29,1 Gio disponibles sur l'hôte au snapshot. Cela confirme une marge à cet instant, pas un essai de charge simultanée de tous les utilisateurs. La portée générale est exercée uniquement dans le canary isolé. Aucun compte client supplémentaire n'est utilisé pour un essai média.

## Optimisation Conclave

PR687 avait démontré le changement de chemin de livraison et évité trois prélèvements inutiles. Il restait une duplication : les 64 Kio frais lus durant ce contrôle étaient jetés, puis le démarrage normal relisait l'en-tête et la redirection.

PR690 transfère uniquement cet en-tête frais, après drainage, dans une capacité opaque en mémoire, utilisable une seule fois pendant dix secondes, liée à l'objet session courant, à la source exacte, à la taille et au user-agent. La lecture suivante est épinglée sur la même cible courante. Tout changement ultérieur de cible demeure une erreur ; les anciennes données du cache refusé ne sont pas réutilisées. Une absence, expiration, annulation ou invalidité du transfert garde le chemin ordinaire disponible. Aucun codec, seuil de réserve, limite fournisseur ou bail modifié.

## Vérifications avant production

- 153 tests ciblés réussis, cinq ignorés ; 40 tests supplémentaires d'isolation/cache/sous-titres réussis, groupes recoupés.
- Test HTTP réel : une seule connexion, en-tête courant exact, aucune seconde redirection d'entrée ; un changement ultérieur de cible est refusé.
- Canary UID1000/GPU réel, réseau none et stockage séparé : 33 contrôles réussis, mode tous les propriétaires exercé, aucun média fournisseur, canary arrêté et retiré.
- Contrats cloud réussis avant fusion ; état des paquets et preuves de déploiement/relecture consignés ci-dessous à leur observation.

Reçus locaux : `.codex-artifacts/recent-resume-rollout-20261007/`. Les URL, identifiants, jetons de livraison et contenus fournisseur privés ne sont pas publiés.

## Déploiement du pilote, portée générale désactivée

Image `sha256:6b1547abb52e10ca2bd490bbcac7205f58d611b93dc50cdd05e2ee355a4951e7`, arbre `d9abec424a46594540b451a0ebf2efffc1a2b9b256f5b615bf3b5c52204337ff`. Trois sources modifiées et une ajoutée ; 83 fichiers conservés sur 87. Edge, Web et Android inchangés.

Pause admissions UTC 02:12:32.508946–02:14:56.850998, soit 144,342 s, comprenant l'attente naturelle du travail loué. Aucun bail forcé. Remplacements à 02:14:53 et 02:14:56, admissions/cron/worker restaurés, même dispatcher conservé. Les 87 empreintes sont vérifiées sur les deux Gateways sains à 02:15:08. Le nouveau drapeau global est explicitement false, la liste pilote est préservée ; health indique `owner-allowlist`. L'exemple de configuration globale n'a pas été appliqué. Marqueur apply consommé, ne pas rejouer.

## Second diagnostic Conclave : couverture et horloge

Après PR690, premier lancement à 860 s : lecture à 14,321 s, première image mesurée à 15,589 s, progression normale. À l'arrêt, capture HLS refusée `subtitle-coverage-or-revoked` ; aucune reprise accélérée ne peut être revendiquée pour ce passage.

Un second lancement ordinaire à 901 s démarre en 10,303 s (première image 11,343 s). À 02:19:45 UTC, la première piste de sous-titres reste un bootstrap de 0,001 s, l'autre couvre 84,710 s et la vidéo 102,019 s. À 02:21:17, la piste provisoire persiste et la playlist vidéo a glissé à la séquence 78. Le lecteur avance jusqu'à 103,894 s relatives, ready4/pausedfalse/errornull. Ce constat local ne justifie pas de fabriquer des sous-titres vides ou de prétendre qu'ils couvrent la vidéo.

PR691 ajoute un repli sur les données d'entrée pour les MKV dont le plan de sous-titres est complet mais dont la fenêtre HLS n'est pas réutilisable à l'arrêt. Le plan audio/sous-titres ordinaire est reconstruit. Une fenêtre HLS admissible reste prioritaire et n'entraîne pas une seconde validation. Le budget et les quatre preuves fraîches restent inchangés ; une révocation pendant la capture asynchrone empêche de remplir à nouveau le cache. Le cache HLS refuse aussi une playlist glissante dont la somme des durées ne permet plus de rattacher le premier segment restant à l'origine de session. Les données d'entrée n'exigent pas ce repère HLS.

190 tests ciblés réussis, cinq ignorés, incluant cache/sous-titres/broker/transfert frais ; groupe préalable 49/49 recoupé. Les cinq checks de PR690 sont désormais réussis, paquets inclus. Aucun diagnostic audio perceptif n'est déduit du seul contrôle AAC-LC.

## Déploiement du repli sous-titres

PR691 tête `519e02f04b83c78798249e5fc6957e4081a1ff5a`, fusion `71e5349abb4deb29c8ad8afd8bc8c032414cfc04`. Canary isolé UID1000/GPU réel : 36 tests, aucun appel fournisseur, retiré ensuite. Image `sha256:2736371da88c24789dd760a86260ed8d0632f5dd7b59c2eef8ca531ac446fc99`, arbre `62b57e58f1821a20b86597664ce345a2c4350a80cec6df9c763bc5100df35679` ; deux sources modifiées, 85 autres fichiers préservés.

Pause admissions 02:25:35.599724–02:26:12.159707 UTC, 36,560 s, drainage naturel du travail en vol. Deux Gateways remplacés à 02:26:09 et 02:26:11 ; 87 empreintes vérifiées à 02:26:19. Edge inchangés, admissions/worker/cron restaurés, dispatcher conservé, aucun bail forcé. Portée propriétaire pilote maintenue, activation générale false. Reçus `.codex-artifacts/recent-resume-fallback-20261007/receipts/` ; marqueur apply consommé, ne pas rejouer.

La première capture réelle après ce déploiement conserve 64 Mio d'entrée à 02:27:13 UTC malgré le rejet HLS `sliding-playlist-unbound-clock`. Zéro HLS publié avec une horloge supposée. Aucun accès fournisseur supplémentaire pour constituer cette entrée : elle provient du broker de la lecture ordinaire qui vient d'être arrêtée.

## Rejeu réel après les deux correctifs

| Essai même copie Conclave | Position | Création → lecture | TTFF télémétrie | Serveur prêt |
|---|---:|---:|---:|---:|
| Sans entrée récente après redémarrage | 1005 s | 10,968 s | 11,404 s | 9,368 s |
| Reprise, cache refusé mais en-tête frais transmis | 1032 s | 11,828 s | 13,003 s | 10,686 s |

La reprise précédente documentée avec PR687, à une autre position (814 s), demandait 21,552 s avant lecture. Les positions et conditions réseau diffèrent : il ne s'agit pas d'un benchmark prouvant un gain constant de 9,724 s. Le nouveau rejeu prouve directement la suppression de la duplication : validation 1,354 s, `target-changed`, 65 536 octets courants transmis ; première requête du broker normal à l'octet 65 536, cible courante réutilisée, zéro nouvelle redirection dans ce broker. La validation initiale a toujours sa propre requête et sa redirection ; ce n'est pas zéro redirection sur l'ensemble de la reprise. Les 64 Mio de l'ancien cache ont été refusés et ne sont pas consommés.

À 02:28:10 UTC, un segment produit est contrôlé localement sans nouvelle lecture fournisseur : AAC-LC 48 kHz stéréo, H.264 High, 48 images, intervalle maximal 42 ms, zéro intervalle supérieur à 100 ms et zéro ligne d'erreur de décodage. Ce contrôle borné ne certifie pas tout le film ni la perception sonore.

La lecture avance de 32,769 s à 100,900 s puis 137,728 s relatives à 02:30:00 UTC, pausedfalse/ready4/errornull, avec réserve vidéo disponible. Plus de deux minutes sont ainsi observées après la reprise ; pas de blocage observé dans ces relevés. Les tentatives de capture d'écran de l'outil navigateur ont échoué ; les relevés DOM, reçus serveur et contrôle local sont conservés, aucune capture d'écran réussie n'est revendiquée. Navigateur revenu Films et lecture arrêtée normalement.

Les cinq contrôles de PR691 sont tous réussis, paquets Phone/TV/Windows compris. Les correctifs sont déployés sur le pilote ; la configuration d'extension à tous les comptes est préparée, testée en isolation et réversible, mais non activée en production. Les cas à cible instable restent sur une reprise ordinaire désormais sans la lecture redondante de l'en-tête courant. Aucun engagement de rapidité identique pour toutes les VOD ni validation de charge globale.

## Procédure d'ouverture préparée

1. Relire l'image/arbre actifs, les deux portées de cache, l'état des lecteurs et des travaux, et les plafonds 256/64 Mio. La cible préparée est l'image PR691 ci-dessus ou une version ultérieure conservant les correctifs, jamais une image historique.
2. Appliquer les variables de l'exemple sur les deux Gateways après drainage naturel, en conservant la liste pilote pour retour arrière. Seul le drapeau de portée récente change ; les comptes actuels et futurs passent par le même propriétaire authentifié, sans inscription manuelle individuelle.
3. Vérifier `recentOwnerScope=all-authenticated-owners`, santé, budgets, restauration des admissions et dispatcher, puis les premières reprises autorisées. Comparer les événements de première image/lecture, erreurs, hits/misses/invalidations/évictions, mémoire et réservations. Une absence ou éviction de cache doit laisser réussir le chemin ordinaire.
4. En cas de régression reproductible de lecture, de dérive du budget ou de portée, repasser le drapeau global à false avec drainage, sans supprimer de preuve ni changer les gardes fournisseur. Un défaut propre à la validation récente peut être neutralisé par le drapeau recent enabled, séparé des caches historiques.

Cette procédure et les réglages sont prêts ; les étapes d'ouverture générale ne sont pas exécutées ici. Le relevé final 02:31:17 UTC confirme les deux Gateways sains, zéro session, portée pilote, zéro octet réservé en attente, une entrée de 64 Mio dans le plafond de 256 Mio sur le secondaire. Environ 28,6 Gio disponibles sur l'hôte à ce snapshot. Aucun test média sur un autre compte ni test de charge simultanée globale.
