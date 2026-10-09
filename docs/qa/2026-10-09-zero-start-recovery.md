# Démarrage à zéro et réserve du lecteur — 9 octobre 2026

## Demande et périmètre

Vérifier pourquoi les copies récemment testées ne démarrent plus de façon fiable, puis contrôler un départ réel à zéro. Le pilote reste limité au compte autorisé. Les essais fournisseur sont séquentiels avec les claims, heartbeats et expirations ordinaires. Aucun changement de route, d’IP, de timeout de production ou de réserve.

## Comparaison antérieure et nouveau contrôle

Deux contrôles isolés du Robot Sauvage à 660 secondes ont été réalisés avant le test à zéro :

- Ancienne image PR682, déjà utilisée lors des succès du 7 octobre : échec à la limite serveur de 60 secondes, retour API après 62,595 secondes. Un simple retour à cette image n’a pas rétabli cette reprise à froid.
- Image actuelle PR732 dans un banc disposant temporairement de 150 secondes : préparation en 51,855 secondes, donc **avant la limite habituelle de 60 secondes**. Ce succès ne valide aucune augmentation du timeout. Production inchangée.

La reprise publique suivante à 660 secondes a démarré : première image déclarée après 40,588 secondes, serveur prêt en 37,077 secondes. Des pauses utilisateur ont été enregistrées ; ce passage ne constitue pas une certification de continuité.

## Départ public du Robot Sauvage à zéro

Bouton « Recommencer depuis le début » cliqué le **9 octobre à 11:09:53,601 Paris** (09:09:53,601 UTC). Nouvelle session à 09:09:58,049 UTC ; le serveur confirme seek/start/resume = 0.

- Prélecture des en-têtes MP4 : 4 167 681 octets, 47,531 secondes ; préouverture totale 49,948 secondes.
- Préparation FFmpeg : 51,245 secondes ; préparation serveur totale 101,319 secondes.
- Première image : **107,081 secondes** selon l’événement navigateur, après le clic.
- Au démarrage, seulement 16 secondes de vidéo disponibles. Politique serveur non qualifiée pour démarrage rapide : production mesurée 0,286×.
- De 09:11:58,651 à 09:13:30,534, la position avance de 15,953 à 47,964 secondes, soit seulement 32,011 secondes de vidéo en 91,883 secondes réelles. Les instantanés initial/final sont non pausés, readyState 2 au bord de la réserve. Aucune pause manuelle n’est enregistrée dans cet intervalle ; pause de clôture à 09:13:30,811.

**Le départ à zéro aboutit, mais il est lent et interrompu. Il n’est pas validé fluide.** Les 107 secondes ne sont pas un échec à la limite FFmpeg de 60 secondes : la prélecture des en-têtes précède cette limite.

## Défaut Norva démontré

`restartFromStart()` attendait `seekToTime()`, puis appelait directement `video.play()`. La résolution du saut signifie que le nouveau flux est attaché ; la barrière asynchrone du manifeste HLS peut encore attendre la réserve. L’appel supplémentaire jouait donc les premiers segments disponibles et faisait sortir la barrière par son exception réservée à une lecture déjà en cours.

Le bouton transmet maintenant son intention de lire à la nouvelle session Gateway ; seule la barrière normale déclenche la lecture. Une pause explicite pendant l’attente est conservée. Les déplacements locaux dans les données déjà disponibles et les autres moteurs gardent leur parcours.

Aucun seuil de réserve n’est abaissé. Ce correctif empêche une lecture prématurée ; il ne répare pas le débit réseau ni ne garantit un départ plus rapide.

## Vérification du correctif

- La nouvelle régression échoue avant correction : `restart bypassed the replacement startup gate`.
- **71 tests ciblés réussis**, zéro échec : états initialement pausé/en lecture, réserve non prête puis prête, pause explicite, tentative devenue obsolète, préparation refusée. La même fixture est exécutée dans Android WebView.
- PR734, code `ea4794e98db430b00f6ab5bb7f1ea224c8d9fcdc`, manifeste d’assets `8b2de2bf3`.
- Premier contrôle cloud arrêté sur un manifeste d’assets non régénéré ; corrigé par la génération normale, sans modification fonctionnelle supplémentaire.
- Première matrice manuelle `37910388455` annulée : nom de classe TV incorrect dans la demande opérateur. Matrice corrigée `37910437421`, même code : les quatre configurations téléphone et les deux configurations TV réussissent. La fixture WatchPage est exécutée sur téléphone ; les tests TV consentement/D-pad ne certifient pas le décodeur TV.
- Attachement Codex refusé à la limite de 100 ; aucune pièce retirée.

## Conclave

Le clic sur la fiche « Reprendre » à 09:14:36 UTC a conservé la position 1222 secondes : cette tentative n’est **pas** un départ à zéro. Elle échoue à 60 secondes, sans image. Deux contrôles distincts à zéro sont exécutés dans des Gateways temporaires, avec claims réels, cœur de configuration conservé, même copie, mode remux, cache séparé vide et connexion unique :

| Image | Début UTC | Préouverture | Résultat |
| --- | --- | --- | --- |
| PR732 actuelle | 09:21:22,569 | 10,272 s | Zéro segment ; limite FFmpeg 60,034 s ; retour API 72,893 s. |
| PR682 ancienne | 09:23:09,330 | 10,662 s | Zéro segment ; limite FFmpeg 60,033 s ; retour API 73,280 s. |

Aucun défaut de heartbeat. Les deux conteneurs sont arrêtés, retirés et les claims expirés normalement. Ces échecs précèdent le lecteur et le raccord de décodeur. Ce contrôle ne valide pas une réparation par retour arrière, ni une attribution précise au relais ou au fournisseur.

## Limites et traces

Reçus locaux : `.codex-artifacts/startup-recovery-20261009/`, avec échantillons DOM, reçus Gateway et événements publics. Aucun accès, identifiant client ou URL média n’est publié.

La fiabilité des départs à froid et la fluidité des sources lentes restent ouvertes. Le cache récent n’avait aucune fenêtre HLS réutilisable dans ces essais. Aucun succès d’écoute AAC n’est revendiqué. Les anciens incidents et preuves sont conservés dans [le rapport du pilote](2026-10-09-retained-owner-pilot.md) et [celui de PR732](2026-10-09-finite-seek-priority.md).

## Intégration

PR734 fusionnée par `4bbf7767cfac2702c38c392a29c266b3d0e0fb9e`. Suite CI Linux : **6 171 réussis, 31 ignorés, zéro échec** ; suite SQL séparée 40 assertions, non additionnée. Contrats cloud et matrice Android réussis avant fusion. Les paquets étaient encore en construction à la fusion ; les quatre contrôles de la tête, paquets Phone/TV/Windows compris, réussissent à la relecture de 09:32 UTC.

Publication Web `37910998685` réussie à **09:25:47 UTC** (11:25:47 Paris). Le navigateur rechargé utilise `WatchPage.c63fc098ed19fd16.js`. Aucun déploiement Gateway/Edge ni remise à zéro supplémentaire de cache.

## Premier contrôle après publication et clôture à 09:32 UTC

La réouverture publique du Robot Sauvage crée une session à 09:26:46,740 UTC, à la position historique **48 secondes**. Elle échoue avant la première image : limite FFmpeg 60,008 secondes, zéro segment, `PLAYLIST_TIMEOUT` à 09:27:47,047 UTC et événement public d'échec à 09:27:49,668. Les deux premières plages reçues totalisent 1 Mio ; la troisième plage de 8 Mio est encore incomplète avec 2 854 753 octets reçus à la clôture du diagnostic. Aucun statut de refus distant n'est établi par ce relevé.

Cette tentative **n'est pas un départ à zéro après correctif**. Le raccourci zéro essayé une fois dans l'écran d'erreur n'a pas déclenché de session supplémentaire. Le départ public à zéro mesuré à 107 secondes reste antérieur au correctif du bouton. Le correctif est publié et validé par la régression locale/WebView ; sa réussite sur une lecture réelle à zéro avec réserve suffisante n'est pas démontrée ici.

À **09:32:30 UTC** (11:32:30 Paris), les deux Gateways sont sains, avec les mêmes images, environnements et dates de démarrage. Zéro session média et zéro pompe active sur ces deux Gateways ; zéro claim de lecture non expiré pour le propriétaire testé. Admission, cron, worker et dispatcher audio restent actifs. Quatre réservations d'encodeur globales sont visibles ; aucun blocage de capacité n'est démontré par ce seul nombre.

Les quatre conteneurs temporaires sont absents. Onze fichiers temporaires d'essai, totalisant 7 460 903 octets, ont été supprimés dans leurs seuls répertoires de banc ; aucun fichier de production touché. Navigateur revenu à Films, essais arrêtés. Reçus `postdeploy-final.safe.json`, `closeout.safe.json` et `cleanup.safe.json`.

**Conclusion : le démarrage à zéro n'est pas validé fiable.** Le Robot Sauvage a démarré lentement puis s'est interrompu ; Conclave ne produit aucun segment dans les deux contrôles à zéro, ancienne et nouvelle image. La cause précise du délai de réception/préparation reste ouverte. Le pilote reste limité au compte autorisé ; aucune baisse de réserve, hausse de timeout ou généralisation n'est effectuée sur ces résultats.

## Reprise demandée : retrouver les lancements rapides et auditer les PR

Adrien demande explicitement de revenir aux réussites antérieures et de vérifier les changements intégrés. Inventaire des **57 PR 678 à 734**, intégrées sur la première branche parentale de `main` ; les changements de lecture sont distingués des preuves documentaires et des publications Android. Cet inventaire n'est pas une affirmation de revue exhaustive ligne par ligne de chaque PR. La comparaison technique porte sur les chemins de démarrage à froid, les caches, le lecteur et les configurations réellement déployées.

Les réussites antérieures sont confirmées par les événements conservés, et non effacées par les échecs récents. Les trois identités ci-dessous sont reliées par égalité propriétaire/source/type/fichier entre les sessions du 7 et du 9 octobre. Aucun remplacement par une autre version du titre.

| Copie exacte, départ à zéro | 7 octobre : session créée → lecture | 9 octobre : session créée → lecture | 9 octobre : clic → lecture | Observation actuelle |
| --- | --- | --- | --- | --- |
| Le Moment de vérité / Karate, Selection MKV | 2,553 s | 1,976 s | **4,068 s** | Position 17,377 → 58,471 s en 41,079 s réelles ; aucune interruption cumulée mesurable dans cet intervalle. |
| Silo MULTI-SUB S1E1, MAX MKV | 4,206 s | 4,695 s | **5,507 s** | Démarre rapidement, puis recharge. Position 16,021 → 31,043 s en 39,103 s réelles ; premier instantané pausé par le lecteur, sans pause opérateur. |
| Severance FR S1E1, Strng MKV | 5,869 s | Pas de `play_started` | Toujours sans lecture à **125,677 s** | Première image déclarée à 40,799 s, seulement 13,995 s de vidéo disponibles au dernier contrôle ; arrêt normal du test. |

Les mesures historiques « session → lecture » ne sont pas des délais depuis le clic. Le départ actuel de Karate passe bien par le bouton corrigé « Recommencer depuis le début », après une première ouverture à 279 secondes. Celui de Silo et celui de Severance utilisent « Lire depuis le début » sur la fiche de série. Les événements et le Gateway confirment la position zéro.

### Comparaison du code et des environnements

- Image PR691 des réussites historiques : `2736371d…`. Image actuelle PR732 : `9e6f0849…`. Les réglages de transport/proxy et les limites hôte n'ont pas changé dans les quatre snapshots de déploiement comparés. Seules l'activation du décodeur conservé et sa liste d'un propriétaire ont été ajoutées aux variables d'environnement.
- Huit fonctions du parcours MKV à froid sont textuellement identiques à PR691 : ouverture réseau bornée, pompe, lancement de pompe, prélecture d'en-tête, instrumentation de progression, admissibilité du profil, création de pompe et enrichissement du profil depuis l'en-tête. Empreintes conservées dans `cold-transport-code-comparison.safe.json`.
- La neuvième fonction, `preopenBoundedMkvInputPump`, ajoute un transport jetable uniquement sous `drainExactRange && retainedRequestBinding`. Cette branche ne s'applique pas aux départs à zéro observés.
- Severance utilise deux pistes audio et la pompe à froid, sans broker de seek ; la nouvelle horloge des sous-titres du pilote est désactivée sur ce parcours. Cela limite les hypothèses de régression, sans prouver l'absence de tout défaut Norva.

Sur le Severance public actuel, le premier en-tête de 257 186 octets prend **4,935 s**, contre **0,564 s** dans le reçu historique. Après ouverture, 79,664 s sur 79,833 s de pompe sont passées à attendre les données entrantes, contre 88 ms à écrire vers le décodeur. Le relevé ne départage pas le relais, la livraison ni un effet du contexte de connexion.

### Comparaison isolée ancienne image / image actuelle sur Severance

Deux tests séquentiels sur la même copie et le même début, avec le même hint public, le même mode transcode, les mêmes réglages réseau/hôte, un cache temporaire vide et une connexion source unique. Claims Edge ordinaires, heartbeat indépendant toutes les 0,5 s avec timeout d'une seconde et arrêt immédiat en cas d'échec. Aucun lecteur public attaché à ces deux bancs ; les nombres mesurent la disponibilité des premiers segments serveur.

| Image | Début UTC | Préparation API | En-tête | Préparation FFmpeg | Données entrantes sur la fenêtre de suivi |
| --- | --- | --- | --- | --- | --- |
| PR691 ancienne | 09:51:12 | **2,925 s** | 256 043 octets en 0,637 s | 0,780 s | 4 958 091 octets en 30,542 s ; 30,099 s en attente de lecture réseau. |
| PR732 actuelle | 09:52:31 | **3,905 s** | 256 043 octets en 0,643 s | 1,534 s | 2 635 547 octets en 31,473 s ; 31,168 s en attente de lecture réseau. |

Les deux images peuvent encore préparer rapidement cette copie. Les transferts suivants sont insuffisants dans ces fenêtres ; aucun des deux essais ne valide une lecture continue. Ces deux observations séquentielles ne constituent pas un benchmark statistique et ne permettent pas d'attribuer l'écart à la version de code. Le banc démarre dans un nouveau processus, contrairement au Gateway public ; cette différence reste explicitement une limite.

### Cache : activé, mais aucune nouvelle fenêtre vidéo réutilisable

À 11:54:43 Paris, le cache privé HLS est activé et le mode de revalidation récente reste limité au propriétaire autorisé. Il contient **zéro fenêtre HLS/récentes**, avec trois refus de capture et le dernier motif `unverified-input`. Deux préfixes MKV sont présents, pour 8 000 000 octets ; un préfixe ne constitue pas une réserve vidéo permettant une reprise immédiate.

Les départs à froid MKV avec validateur faible ne créent pas les échantillons ni les fenêtres du broker de seek requis par le cache récent. Les comparaisons du code montrent cette limite déjà présente avant les derniers changements. Les données privées récentes sont liées au processus et à une durée limitée (10 minutes pour le chemin échantillonné) : elles ne survivent pas aux redémarrages Gateway. Les réussites historiques à chaud ne prouvent donc pas la présence de données réutilisables après les déploiements actuels.

Une réouverture publique supplémentaire de la copie Vice-versa 2 déjà utilisée pour les preuves de cache est effectuée à 11:56:24 Paris, position 779 s. Elle échoue avant toute image : **60,010 s de préparation FFmpeg, zéro segment**. Une plage de 786 432 octets prend 20,792 s ; au timeout, la plage média suivante de 8 Mio n'a livré que 1 669 981 octets. Le cache n'était pas disponible avant cette ouverture et une préparation échouée ne l'alimente pas. **Aucun nouveau succès de reprise avec cache n'est revendiqué.** Pas de réessai en boucle ni de changement des gardes de validation.

## Clôture après les comparaisons historiques

À **11:58:01 Paris** (09:58:01 UTC), les deux Gateways sont sains, sans session média ni pompe active ; zéro claim vivant pour le compte testé. Images, environnements et dates de démarrage inchangés. Six réservations d'encodeur globales sur huit restent visibles pour les autres travaux, sans attente d'admission dans les essais. Maintenance audio, cron, admission et dispatcher actifs.

Les deux nouveaux conteneurs de comparaison sont absents ; 70 fichiers temporaires, 850 642 octets, ont été retirés uniquement de leurs répertoires de sortie/cache. Les preuves sûres et marqueurs consommés restent conservés. Navigateur revenu à Films, filtres de séries restaurés ; aucun test ne reste en lecture.

**Résultat : les anciens lancements rapides sont confirmés, et deux démarrages publics à zéro restent sous six secondes. Un défaut du bouton de reprise est corrigé et publié par PR734. La continuité de Silo, le démarrage public de Severance et les échecs Robot/Conclave/Vice-versa 2 restent ouverts.** Les contrôles comparatifs ne justifient ni un retour global à une ancienne image, ni une attribution exclusive au fournisseur ou au relais, ni une déclaration de fiabilité rétablie.
