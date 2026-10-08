# Reprise HLS après glissement de la playlist — 8 octobre 2026

## Périmètre et état

Optimisation autorisée des reprises lentes de Normal, sur le pilote récent du compte contrôlé. Extension générale non autorisée par ce résultat. Sources privées, même fichier/piste, mono-connexion et priorité lecture conservées.

## Blocages établis avant modification

- À 06:13 UTC, le Gateway pilote avait trois refus `sliding-playlist-unbound-clock`. Aucun cache HLS préparé conservé ; quatre réutilisations de données source historiques.
- Rejeu Normal exact à 06:27:42 UTC, position 1336 s : première image 16,647 s selon télémétrie ; `play_started` à 06:28:14.205696, **33,286 s après le clic horodaté 06:27:40.920**. Lecture observée jusqu’à 169,786 s relatives, sans erreur au relevé final. Il ne s’agit pas d’une mesure exhaustive des saccades.
- À 06:30:24, la playlist vidéo avait 64 segments de deux secondes et une séquence 93, soit une origine de 186 s pour ce producteur ; le lecteur était encore en deçà de cette fenêtre. Le navigateur avait téléchargé bien en avance. La politique précédente supprimait aussi les anciens fichiers après sa réserve de 16 segments : corriger l’horloge seule ne couvre donc pas ce cas.
- Après arrêt ordinaire à 06:31:03 : quatrième refus `sliding-playlist-unbound-clock`, aucun cache HLS créé, repli vers 64 Mio de données source. Aucun lecteur restant à 06:32:42.

## Correctifs

1. Suivi des durées réellement publiées après renommage atomique, par producteur et playlist. Aucune multiplication d’un numéro par une durée nominale. Une lacune, un retour en arrière, une durée ou un nom contradictoire invalident ce suivi.
2. Conservation optionnelle des anciens segments sur les seules sessions éligibles du pilote récent : maximum 64 Mio, dans la réservation de sortie existante, métadonnées bornées à 300 s et 512 segments historiques. Les fichiers optionnels sont évincés avant de refuser une écriture ordinaire faute de place. Aucune hausse de la réservation, de la concurrence ou de la durée de vie du cache.
3. Les playlists reprises cessent de promettre EVENT, puisque la continuation finit par glisser. Les séquences média et discontinuité restent cohérentes ; les fragments de sous-titres gardent leurs numéros absolus et leurs horodatages complets.
4. Les contrôles d’identité exacte, d’échantillons frais, du propriétaire, de configuration, de pistes et de révocation restent applicables. Une conservation ou une validation impossible garde le repli ordinaire.

## Vérification avant production

- 139 tests ciblés réussis, deux preuves dépendantes d’environnement ignorées localement ; groupes recoupés avec les 65 premiers tests.
- Canary réel à 06:38 UTC : utilisateur 1000, réseau `none`, stockage temporaire séparé, aucune requête fournisseur. Dix minutes synthétiques encodées via les PUT bornés réels, capture à 320 s alors que la playlist commence à 344 s, puis 280 s de continuation.
- Fenêtre conservée [316,368], sous-titres traversant une frontière conservés, raccord contenant 232 images attendues (116 s à 2 i/s), AAC-LC contrôlé. Chaque voie décodée avec `-xerror`, aucun diagnostic de décodage ; séquence finale 19 / discontinuité 1 après retrait du préfixe.
- Le premier canary a échoué sur le marquage « corrupt input packet » du démultiplexeur FFmpeg 5 lors de la remise à zéro des compteurs TS entre deux encodeurs. Ce diagnostic est conservé. La preuve distingue désormais le contrôle strict de chaque voie, les erreurs de décodage et le nombre d’images du raccord ; le rejeu navigateur reste nécessaire.
- Canary GPU sous UID1000 réussi ; canary arrêté et retiré. 89 empreintes runtime concordantes, 85 fichiers préservés, quatre modules modifiés/ajoutés. Aucune modification Edge.

## Déploiement et preuves réelles

Les deux Gateways utilisent l’image `sha256:6359a11315e1a778bdcc1ef6a6cfed8d63b7f75d15a408765995b47418ee63f8`, arbre `406b30546a657d410b3e3741cd08bc79e07ef0c620c599eeff7e99ddfb1cf07b`. Démarrages à 06:40:30.568 et 06:40:33.203 UTC (08:40 Paris). Les 89 empreintes concordent sur les deux réplicas ; les 194 fichiers Edge restent inchangés.

Pause des admissions **06:40:13.820650–06:40:34.941848 UTC, 21,121198 s**. Drainage naturel, aucun bail forcé, crons/admission/worker restaurés et dispatcher conservé. Canary arrêté. Environnements et liste des propriétaires du pilote inchangés ; aucune généralisation. Marqueur d’application consommé, ne pas rejouer.

### Normal : conservation corrigée, cache HLS encore refusé

| Essai | Position source | Clic UTC | Lecture effective UTC | Clic → lecture |
| --- | ---: | --- | --- | ---: |
| Avant déploiement | 1336 s | 06:27:40.920 | 06:28:14.205696 | 33,286 s |
| Après déploiement, remplissage | 1506 s | 06:42:17.907 | 06:42:51.782378 | 33,875 s |
| Réouverture récente | 1634 s | 06:45:53.027 | 06:46:22.887452 | 29,860 s |

Positions différentes, essais successifs avec livraison variable : **aucun gain causal A/B sur Normal établi**. La troisième lecture réutilise le cache de données source (quatre échantillons, taille et cible concordants), pas les segments HLS préparés. À 06:54:44, temps relatif 502,043 s, `paused=false`, `readyState=4`, erreur nulle, réserve jusqu’à 622,025 s. Ce relevé prouve une lecture avancée au-delà de huit minutes ; ce n’est pas une surveillance exhaustive des gels pendant cet intervalle.

Le correctif de conservation est observable : à 06:43:58, la playlist commence au segment vidéo 61, mais les 125 fichiers vidéo présents comprennent encore le segment zéro. La sortie occupe 118 070 784 octets, sous sa réservation ordinaire de 512 Mio. La capture de fermeture passe désormais le contrôle d’horloge et échoue sur `subtitle-coverage-or-revoked`. Deux captures de Normal après déploiement conservent seulement les données source.

Le contrôle local de sortie à 06:44:48 contient 48 images à 24 i/s, intervalle maximal 42 ms, zéro intervalle supérieur à 100 ms et zéro diagnostic de décodage. Audio AAC-LC, stéréo 48 kHz, contrôle de décodage réussi. Extrait de deux secondes, pas certification du film entier.

### Sous-titres : nouvelle limite isolée, non contournée

Normal expose trois pistes SubRip préparées : français forcé, anglais et français. À 06:47:50 puis 06:50:26, la piste forcée reste au bootstrap de 1 ms ; son prochain fichier de sortie est vide. Le bootstrap n’atteste pas une fenêtre sans dialogue. Il ne doit pas être transformé en preuve d’absence ni omis du graphe mis en cache.

Autre incohérence précise à investiguer dans la couverture : le parseur additionne les `EXTINF` des fragments de sous-titres, alors que les horodatages des répliques incluent leurs silences. À 06:50:26, l’anglais totalise 287,836 s pour 143 fragments, mais sa dernière réplique se termine à 426,713 s ; le français totalise 212,590 s pour 101 fragments et sa dernière réplique se termine à 424,546 s. Les fichiers ouverts suivants ont zéro octet. Une correction doit reconstruire une couverture attestée sur les vrais horodatages, avec bornes de lecture et traitement des répliques traversantes, puis résoudre séparément les pistes rares/forcées. Lire le dernier horodatage ou voir avancer la vidéo ne prouve pas à lui seul l’absence de réplique manquante.

Ces diagnostics n’ont effectué aucun nouvel accès fournisseur. Aucune piste supprimée, aucun bootstrap accepté comme preuve et aucune réserve de démarrage diminuée. **Normal reste non résolu pour la reprise HLS rapide.** Le débit variable de livraison reste également un facteur distinct et non corrigé par ce travail.

### Contrôle MP4

Rejeu de Vice-versa 2 sur sa copie déjà choisie, sans substitution : à 06:59:19, playlist de 64 segments en séquence 58, mais 122 fichiers vidéo présents depuis le segment zéro. Lecture jusqu’à 127,940 s relatives puis fermeture ordinaire à 06:59:43 ; à 06:59:55, première fenêtre HLS réellement conservée après glissement, aucun lecteur restant sur les deux Gateways.

- Sans cache, position 470 s : clic 06:57:05.740, lecture 06:57:36.976304, soit **31,236 s**.
- Réouverture, position 598 s : clic 07:00:02.466, lecture 07:00:07.831057, soit **5,365 s**. Contrôle frais 2,668 s, quatre échantillons/taille/cible concordants ; `privateResumeWindowHit=true`, 50 s préparées, 8 Mio de données source injectés. La continuation est prête en 4,966 s.
- À 07:01:14, le lecteur atteint 69,218 s, au-delà du préfixe en cache, sans pause ni erreur au relevé. À 07:01:24, la playlist de continuation a déjà glissé à la séquence 13. Le raccord puis le retrait du préfixe sont donc exercés réellement, pas seulement en canary.
- Contrôle local à 07:01:45 : AAC-LC stéréo 48 kHz, zéro diagnostic audio ; 48 images, intervalle maximal 41,667 ms, aucun intervalle au-dessus de 100 ms, zéro diagnostic vidéo.
- À 07:03:08, temps relatif 183,400 s, réserve jusqu’à 304,062 s, `paused=false`, `readyState=4`, erreur nulle. Les deux relevés espacés de 114,182 s montrent une progression de 114,182 s : pas de gel cumulé mesurable sur cet intervalle. Pas de certification image par image du film entier.

La réutilisation HLS après glissement est démontrée sur cette copie. Les positions sont différentes et il ne s’agit pas d’un benchmark A/B randomisé : pas de gain universel déduit des deux durées.

## Clôture de cette expérimentation

Lectures arrêtées par retour normal aux films ; zéro session sur les deux Gateways au contrôle final de 07:03 UTC. Deux Gateways sains, 89 empreintes exactes chacun, admission/cron/worker/dispatcher actifs et dates de démarrage inchangées. Aucun fichier média opérateur supplémentaire, canary nettoyé. Les fichiers temporaires de lecture suivent leur expiration ordinaire.

Les cinq contrôles de la tête `d854543a1` réussissent : contrats cloud, Vercel Preview Comments et paquets Phone/TV/Windows. Aucun changement UI ou lecteur natif dans ce correctif serveur ; cette exécution ne constitue pas une validation des décodeurs Android. Les corrections déployées restent bornées par les conditions d’éligibilité existantes du pilote. Aucun réglage réseau, codec, réserve, quota ou durée de vie modifié.

Conclusion : la conservation HLS après glissement et sa continuation fonctionnent sur le contrôle MP4. **Normal ne bénéficie pas encore de ce chemin**. Prochaine correction à étudier : produire un état fiable des sous-titres rares et de leurs silences sur l’horloge média, sans seconde connexion, lecture intégrale anticipée ou piste supprimée. Le cache source reste utilisé pendant ce repli. Le cas réseau historique reste ouvert ; cette expérimentation ne le clôt pas.

## Références

Reçus locaux : `.codex-artifacts/resume-sliding-playlist-20261008/`. PR705. Code applicatif `3ee559aa40ceba9330fc094286a60694a9e65317`, ajustement du test `d854543a1`. L’attachement Codex a été refusé à la limite de 100 ; aucune pièce supprimée.

Règles de continuité et de retrait des segments : [RFC 8216, section 6.2](https://www.rfc-editor.org/rfc/rfc8216#section-6.2).
