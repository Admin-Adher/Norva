# NorvaEngine — fin complète et sous-titre traversant un saut

Date : 9 octobre 2026, Europe/Paris. Suite du [comparatif PR750](2026-10-09-web-engine-comparison.md). Code moteur : révision 47. Ce travail ne remplace pas le Gateway et ne modifie ni les comptes, ni les routes, ni les réserves, ni la limite de préparation de 15 secondes.

## Corrections

### Fin tronquée

`av_write_trailer` émet aussi le dernier fragment vidéo/audio. L'ancien moteur supprimait toutes ses écritures pour éviter les métadonnées finales MP4, perdant ainsi les quatre dernières secondes du fichier synthétique. Le muxer utilise désormais `skip_trailer`, qui retire seulement les index finaux. Ses écritures de finalisation passent par la même transaction que les paquets : retour vérifié, aucun octet partiel après erreur, aucune publication d'une ancienne génération après arrêt, destruction ou saut. Une finalisation échouée ne marque jamais une fin normale.

Référence primaire : [FFmpeg, fragmented MP4 et skip_trailer](https://ffmpeg.org/ffmpeg-formats.html).

### Sous-titre déjà commencé avant la cible

Le fichier test contient une réplique de 89 à 95 secondes. Un saut vidéo à 90 secondes ignorait son paquet. L'index Matroska indique sa position et sa durée, mais le moteur ignorait `CueDuration` et ne conservait qu'une position par point. Il conserve désormais toutes les positions valides et leurs durées connues. Lorsqu'un bloc traverse la cible, la recherche vidéo recule vers son horodatage avec le drapeau BACKWARD. Le même démuxeur et le même transport lisent les données ; aucune connexion fournisseur supplémentaire.

Le premier prototype de recherche par octets récupérait la réplique, mais conservait un état interne ancien du démuxeur et relisait depuis 56 secondes. Il est écarté. Le code retenu utilise une recherche temporelle, qui réinitialise cet état et commence ici à 88 secondes. Les index tronqués sont refusés ; une durée absente n'est jamais inventée. Les constructions simultanées de l'index partagent la même lecture.

Référence primaire : [Matroska, CueTrackPositions et CueDuration](https://www.matroska.org/technical/elements.html).

**Limite :** cette correction exploite des durées réellement présentes dans un index utilisable. Elle ne certifie pas tous les sous-titres de fichiers sans index ou sans durée.

## Vérification locale

- 85 tests ciblés réussis : muxage, horloges audio/vidéo, finalisation, arrêt, générations, garde réseau et index de sous-titres.
- MKV synthétique H.264/AC-3/SRT de 180 secondes : départ à zéro en 0,567 seconde ; saut hors réserve depuis 12,087 vers 90 secondes, reprise en 0,633 seconde.
- La réplique 89–95 est réellement active dans la piste texte du navigateur entre 90,277 et 94,275 secondes. La réplique 120–125 apparaît ensuite, sans doublon. Plus de 71 secondes parcourues après saut ; aucun intervalle d'image supérieur à 250 ms hors saut demandé.
- Reprise indépendante à 170 secondes : première image à 0,752 seconde ; fin naturelle à 180,009375 secondes, contre 176,016 dans le témoin PR750. Aucun gel ou erreur média mesuré sur cette fin.
- Contrôle supplémentaire H.264/AAC/SRT avec deux pistes audio : reprise à froid à 23 s en 0,392 s, sous-titre 22,021–25,021 conservé, fin naturelle 60,031 s, aucun gel >250 ms ou erreur média.
- Audio synthétique transcodé vers AAC-LC par le moteur existant. Navigateur muet pendant ces essais : aucune validation à l'écoute revendiquée.

Les fichiers de preuve et le banc local sont sous `.codex-artifacts/web-engine-recovery-20261009/`. Les mesures sûres sont dans le [JSON associé](2026-10-09-web-engine-eof-subtitle-recovery.json).

## Démarrages réels : blocage toujours présent

Deux sessions authentifiées ordinaires, séquentielles, mêmes copies et départ à zéro ; aucune capture opérateur parallèle ou lecture concurrente.

| Copie | Résultat | Attente observée |
| --- | --- | --- |
| Conclave — Dino | Limite moteur de 15 s, aucune première image | 512 Kio en 2,973 s, fin du fichier en 0,660 s, 1 Mio en 2,627 s, puis 1 Mio encore incomplet au bout de 8,700 s. Ouverture du démuxeur inachevée ; aucun muxer/SourceBuffer. |
| Abduct — MAX OTT | Limite moteur de 15 s, aucune première image | 512 Kio en 9,023 s, fin du fichier en 1,851 s ; muxer initialisé vers 10,910 s, puis plage de 1 Mio incomplète à l'expiration 4,084 s plus tard. Aucun fragment média utilisable. |

L'essai Abduct avait d'abord été bloqué **avant admission** par le contrôle du profil. Seuls `probedAt` et `probeMs` avaient changé ; identité et faits techniques étaient identiques. Le manifeste privé du banc a été actualisé après cette comparaison. Les marqueurs consommés précédents sont conservés. Ce refus préliminaire n'est pas une lecture fournisseur supplémentaire.

Les événements `MEDIA_ELEMENT_ERROR: Empty src attribute` du banc proviennent de son retrait d'ancienne source ; ils ne prouvent aucune corruption du fichier. Les erreurs réseau finales correspondent ici à l'interruption par la limite globale, pas à un refus HTTP du fournisseur établi.

Ces mesures localisent l'attente dans les lectures de plages. Elles ne départagent pas le relais et la livraison fournisseur. Le correctif de fin/sous-titre ne peut pas rendre disponibles des octets encore absents. Aucun gain réel de démarrage n'est annoncé.

## Expérience supplémentaire non intégrée

Une variante `flush_packets=1` a été comparée uniquement sur un fichier synthétique H.264/AAC/SRT avec chaque réponse GET retardée de 2,8 secondes. Départs 5,91 s et 5,73 s, soit aucune accélération substantielle démontrée. Une pause de 0,77 s dans le témoin n'apparaît pas dans le court essai candidat. Cette seule observation n'établit pas la fluidité générale ; le réglage reste hors du code livré. Aucun nouvel essai fournisseur de cette variante n'a été nécessaire : les deux échecs réels précédaient l'émission d'un fragment média.

## Clôture des essais réels

À 22:12:39 Paris : les deux sessions sont expirées normalement, zéro claim actif du propriétaire testé, zéro session et zéro raw pump sur chacun des deux Gateways. Les deux sont sains, image `e7520bec…` inchangée. Le contrôleur et le tunnel temporaires sont arrêtés. Aucune garde, limite, quarantaine ou tâche de maintenance modifiée.

Les corrections de cette PR concernent le moteur web. Le lecteur natif Windows publié et la lecture native Android ne sont pas remplacés. Le déploiement web et son contrôle d'empreinte sont consignés ci-dessous.

## Intégration

PR752. Le premier contrôle CI a arrêté le parcours sur le manifeste i18n généré devenu obsolète, après 40 assertions SQL réussies. Manifeste régénéré par la commande habituelle et référence HTML calculée sur les octets Git LF ; le code moteur reste identique. Aucun déploiement issu du contrôle échoué.

PR752 fusionnée par `b2269b0b0eecddee64e20afe7fa33d2c6f388275`, tête `e800f4508` : les dix contrôles réussissent, paquets Windows et Android inclus. Suite CI : 6 307 tests, 6 273 réussis, 34 ignorés, zéro échec. Les 85 tests ciblés appartiennent à cette suite ; ils ne s'y ajoutent pas. Aucun nouveau rendu WebView ni lecteur natif modifié : aucune nouvelle matrice émulateur revendiquée.

## Publication web et contrôle indépendant

Cloudflare `37986319029`, tentative 1 : suite de régression réussie et publication achevée à 20:22:30 UTC (22:22 Paris). Le contrôle final échoue ensuite : premier relevé de shell ancien, puis cinq réponses dont les octets diffèrent pour `provider-access-config.js`, fichier inchangé. Attendu `6012a648c52566b8f93cf9b1e1d2ab58b638de8ad1c23f0fdc77ba5dd8159a2a` ; reçu `eac9c55386f87ed3d0cd4ab657642a3baca9cb4b7f5a40da1ffd836e57510436`, 117 501 octets. Le corps inattendu n'est pas conservé par le runner ; sa cause n'est pas établie. Le contrôle reste strict et cet échec n'est pas effacé.

Contrôle indépendant à 22:25–22:26 Paris : le même vérificateur Node valide les 60 fichiers réellement livrés par `norva.tv`. Le manifeste publié est ensuite comparé aux octets Git de la tête intégrée : 60 concordances, sans utiliser uniquement le manifeste distant comme référence. Le shell contient l'URL immuable et l'intégrité attendues du moteur révision 47 ; son contenu livré correspond exactement à Git, SHA-256 `161d18badd601f8e758409168f51c71ffe0539b23752ce8598115ddd1680e8a3`. Le petit fichier de configuration est également conforme en lecture depuis le serveur. Aucune requête fournisseur requise pour ces contrôles.

Une seule relance du workflow est demandée après ces observations favorables. **Tentative 2 réussie**, job `114011380514` : publication à 22:28:03 Paris, vérification du shell et des 60 fichiers réussie à 22:28:04. Nouvelle lecture indépendante à 22:28:58 : empreinte du moteur et manifeste toujours conformes à Git. Aucun changement de code, d'intégrité ou de contrôle pour obtenir ce réessai. La cause de la réponse incorrecte initiale reste inconnue ; le succès ultérieur ne l'efface pas.

À 22:26:55 Paris : les deux Gateways sont sains, zéro session/pompe et zéro claim actif du propriétaire testé ; les sessions d'essai restent expirées. L'onglet et le serveur local de test sont fermés, contrôleur et tunnel déjà arrêtés. Aucun déploiement Gateway. Les lenteurs de Conclave et Abduct restent ouvertes, sans gain réel ni validation à l'écoute revendiqués.
