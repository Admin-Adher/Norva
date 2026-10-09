# NorvaEngine : analyse initiale bornée, fluidité encore non validée

9 octobre 2026, suite de PR754/755. **Candidat de révision 49, non déployé.** La production reste en révision 48. Preuves résumées dans le JSON homonyme ; reçus locaux sous `.codex-artifacts/web-engine-demux-20261009/`.

## Question et résultat

Sur Conclave, la révision 47 avait consacré 8,156 s à `avformat_find_stream_info`, dont deux lectures réseau de 1 Mio. Ce temps ne représente pas du calcul CPU seul. Le budget total de 15 s expirait avant une première image.

Le candidat garde FFmpeg et ses parseurs, mais borne sa première analyse à 65 536 octets de paquets uniquement lorsque les en-têtes Matroska décrivent déjà une vidéo H.264 et des pistes AAC-LC cohérentes. La [fonction FFmpeg d'analyse](https://github.com/FFmpeg/FFmpeg/blob/n8.0/libavformat/demux.c) peut continuer à lire pour compléter les paramètres et estimer les horloges. Cette borne n'est ni une taille maximale de requête réseau ni une garantie de temps : la lecture d'un paquet ou d'un bloc peut la dépasser.

Sur les deux essais réels, l'analyse prend 13 puis 18 ms sans lecture supplémentaire pour cette étape. Les premières images arrivent en **6,732 et 12,432 s depuis le clic**. Toutefois, des interruptions de plusieurs secondes persistent, dont une pause de **45,164 s** au second essai. **La première image plus rapide ne suffit pas à valider l'activation.** Ce candidat reste en préversion et n'est pas fusionné ni publié.

## Gardes du candidat

- En-tête EBML présent dans les données déjà reçues ; autres conteneurs traités par le helper existant.
- Une seule vidéo H.264, dimensions renseignées, tableaux SPS/PPS complets ; AAC-LC avec fréquence et canaux cohérents avec sa configuration. HE-AAC, PCE, AC-3, HEVC, pièces jointes et types non couverts gardent l'analyse complète.
- Sous-titres texte et bases de temps valides ; aucune piste retirée. Après l'analyse courte, vérification des paramètres découverts, de la configuration et de l'identité des pistes.
- En cas de paramètres incomplets ou modifiés, restauration de la borne FFmpeg initiale de 5 000 000 octets et seconde analyse sur le même contexte. Le tampon de paquets FFmpeg est conservé. Une erreur de lecture interrompt le parcours ; un refus 458 ne déclenche pas une seconde analyse.
- Contexte attribué immédiatement au moteur pour son nettoyage, même en cas d'échec. Une restauration d'option refusée arrête le parcours.

Budget initial de 15 s, tailles des fenêtres, sérialisation des lectures, protocole Range, refus des réponses partielles, audio choisi, capture des sous-titres et routage inchangés. La révision 49 reste dans la branche de travail, pas dans le manifeste publié.

## Essais locaux

**114 tests ciblés réussis**, dont 22 contrôles nouveaux. Cas négatifs : SPS tronqué, PPS absent, mauvais type NAL, dimensions absentes, HEVC/AC-3, HE-AAC/PCE, fréquence ou canaux discordants, piste inconnue, base de temps invalide, vidéo supplémentaire, changement des paramètres, repli complet, refus réseau et restauration d'option.

Avec le véritable module LibAV livré, comparaison avant/après sur fichiers synthétiques :

| Cas | Résultat |
| --- | --- |
| H.264 sans B-frames, AAC 48 kHz stéréo, SRT | Métadonnées identiques ; sortie MP4 identique octet pour octet au témoin à zéro et après reprise à 12 s |
| H.264 avec B-frames, AAC 44,1 kHz stéréo, SRT | Même résultat à zéro et après reprise à 12 s |
| AAC 5.1, sous-titres ASS | Même résultat à zéro et après reprise à 12 s |
| Deux pistes AAC, seconde commençant plus tard et explicitement sélectionnée | Repli complet réellement exécuté ; même sortie et mêmes sous-titres aux deux positions |
| AC-3 | Analyse complète conservée ; paramètres et paquets démuxés identiques |

Soit **huit paires de sorties identiques** (ce ne sont pas huit VOD réelles). Tous les paquets audio et sous-titres comparés restent identiques. Dans les deux premiers cas, 32/34 valeurs DTS intermédiaires vidéo diffèrent après l'analyse courte : certaines valeurs inconnues deviennent connues plus tôt. Les modes d'horloge existants du moteur produisent malgré cela exactement les mêmes octets de sortie. Cette différence est conservée, pas masquée sous une affirmation d'identité de tous les paquets d'entrée.

Huit sorties candidates décodées localement : AAC-LC, stéréo 44,1/48 kHz ou 5.1 48 kHz, aucun diagnostic audio. Pas d'acceptation à l'écoute.

Navigateur : AAC stéréo depuis zéro, première image 322 ms, fin 30,016 s sans intervalle vidéo supérieur à 250 ms mesuré. Reprise à 12 s avec B-frames : sous-titre traversant observé, fin atteinte. Code final révision 49 avec AAC 5.1/ASS : première image 340 ms, fin 30,649 s, mais un intervalle initial de 727 ms entre images ; aucune erreur média. Les sorties de ce cas sont identiques au témoin et le contrôle n'est pas présenté comme intégralement fluide. Onglets muets. Aucun rendu WebView ni lecteur Android natif modifié ; aucune nouvelle matrice émulateur revendiquée.

## Deux sessions réelles, séquentielles et bornées

Copie exacte Conclave — Dino, départ à zéro, profil technique inchangé, compte libre avant chaque admission. Sessions Edge ordinaires authentifiées, heartbeat, claim et expiration ordinaires. Pas de connexion opérateur parallèle, aucun changement de route ou de garde.

| Mesure | Prototype instrumenté | Code final révision 49 |
| --- | ---: | ---: |
| Première image depuis clic | 6,732 s | 12,432 s |
| Analyse des pistes | 13 ms | 18 ms |
| Premiers 512 Kio | 2,424 s | 3,657 s |
| Plage suivante de 1 Mio | 2,238 s | 7,189 s |
| Plus longue plage complète de 4 Mio | 39,256 s | 45,248 s |
| Plus longue pause waiting → playing | 33,472 s | 45,164 s |
| Position au dernier relevé | 45,320 s après 99,056 s murales | 6,261 s après 72,674 s murales |

Premier essai : quatre interruptions reprises, environ 4,062 / 33,472 / 8,473 / 0,992 s. Dernière réserve disponible jusqu'à 84,922 s, sans certifier la suite non lue. Un sous-titre ASS collecté sur l'une des deux pistes ; aucune couverture exhaustive des deux pistes revendiquée.

Second essai : interruption à 0,300 s, reprise après 45,164 s, nouvelle attente à 6,261 s au moment de l'arrêt. La dernière requête partielle, marquée `network_error` au retrait, est annulée par **l'arrêt opérateur** ; elle n'est pas comptée comme un nouveau défaut réseau autonome. Les erreurs média 4 initiale/finale correspondent au retrait de `src` dans le banc. Aucune erreur de décodage intermédiaire observée dans ces courtes séquences.

Les essais ne sont pas simultanés, et la réception varie fortement. On ne peut pas attribuer la totalité des différences de délai au code. Le raccourcissement de l'analyse est mesuré ; la réception irrégulière et les pauses demeurent. Livraison fournisseur et relais restent non départagés. Aucun nouvel essai Abduct n'est fait pour répéter la corruption déjà démontrée.

## Clôture et prochaine question

À **23:25:40 Paris**, les deux sessions sont expirées, zéro claim actif du propriétaire, deux Gateways sains, zéro session/pompe, image `e7520bec…` inchangée. Contrôleur et tunnel arrêtés. Marqueurs des deux essais consommés : ne pas rejouer.

La préparation plus rapide expose aussi plus tôt le lecteur au manque de données. Il reste à comparer, sur une trace de réception contrôlée, la restitution progressive d'une plage entrante avec son attente complète actuelle. Ce parcours devrait conserver un seul transport, des positions exactes, l'annulation et l'exclusion des données partielles du cache durable. **Ce second changement n'est ni implémenté ni validé dans ce rapport.** Aucune promesse qu'il compense une réception durablement inférieure au débit du fichier.

Production inchangée ; aucun déploiement Web, Gateway ou Edge pour ce candidat. CI et nettoyage local seront consignés avant clôture de la préversion.
