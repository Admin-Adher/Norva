# NorvaEngine : démarrage, lectures concurrentes et limite de décodage

9 octobre 2026, suite de PR752/753. Preuves résumées dans le JSON homonyme ; reçus locaux sous `.codex-artifacts/web-engine-startup-20261009/`. PR754, code `67aafad1c`. Les corrections sont intégrées et publiées ; les limites des copies réelles restent ouvertes. Voir la clôture ci-dessous.

## Deux défauts Norva observés

1. **Fragment complet retenu dans le tampon de sortie FFmpeg.** Sur Abduct, le démuxeur est ouvert en 694 ms environ après le premier préchargement, dont 16 ms pour l'analyse des pistes. Pourtant, à la limite de 15 s, seuls 262 144 octets du premier fragment ont été transmis, alors que son `mdat` déclaré contient 513 610 octets. Le reste attend de nouvelles lectures d'entrée. Le candidat configure `flush_packets=1` avant chaque en-tête de muxer. Selon la [documentation FFmpeg](https://ffmpeg.org/ffmpeg-formats.html), ce réglage vide le tampon d'E/S après les paquets ; il ne remplace ni les fragments ni les contrôles transactionnels des écritures.
2. **Index de saut chargé en concurrence avec la vidéo.** Le timer de 2,5 s relisait 4 Mio depuis zéro, alors que la lecture vidéo demandait simultanément sa propre plage de 4 Mio. Les deux requêtes du premier candidat prennent 23,110 et 23,289 s. Un délai fixe ne démontre pas que la liaison est disponible. Désormais, l'indexation de fond utilise exclusivement les données déjà présentes ; le saut explicite garde sa lecture à la demande. Toutes les lectures de plages passent par une file séquentielle avec nouvelle vérification du cache, de l'annulation et des refus terminaux 401/403/458.

Révision candidate 48. Taille des plages, budget initial de 15 s, quotas, routes, générations, claims et choix des pistes conservés. Le moteur web reste une voie existante ; cette correction ne généralise pas son emploi à la place du Gateway.

## Parcours réels bornés

Six sessions ordinaires authentifiées, séquentielles, sur les deux copies exactes, toutes depuis zéro. Les marqueurs du contrôleur sont consommés et ne doivent pas être rejoués. Aucune lecture opérateur parallèle, aucune admission de langue ni relance de cache de production.

| Copie et variante | Première image | Suite observée |
| --- | ---: | --- |
| Conclave — moteur 47 instrumenté | aucune, limite 15 s | 512 Kio en 4,249 s ; analyse des pistes 8,156 s incluant les lectures réseau ; dernière plage incomplète |
| Abduct — moteur 47 instrumenté | aucune, limite 15 s | ouverture rapide ; fragment retenu dans le tampon de sortie |
| Abduct — sortie vidée, sans sérialisation | 8,883 s | deux lectures de 4 Mio concurrentes ; pauses longues, essai arrêté vers 16,9 s de vidéo |
| Conclave — sortie vidée | aucune, limite 15 s | les premiers 512 Kio prennent 9,860 s ; ouverture encore en attente de données |
| Abduct — candidat 48 | 7,108 s | pauses de 30,339 et 11,036 s ; erreur vidéo à 17,292 s ; récupération ordinaire du banc également en dépassement de délai |
| Abduct — même candidat avec prélèvement borné | 7,471 s | pauses de 27,848 et 28,236 s ; erreur vidéo à 17,288 s, arrêt immédiat et expiration ordinaire |

Les essais se succèdent : la variabilité réseau empêche d'attribuer chaque différence de durée au code. Une première image rapide ne vaut pas lecture fluide. Les événements `error=4` au retrait de la source dans le banc sont distincts de l'erreur réelle `PIPELINE_ERROR_DECODE` à 17,3 s.

## Comparaison des octets déjà reçus

Le dernier essai conserve temporairement les plages d'entrée entièrement reçues et les écritures de sortie validées. Assemblage du préfixe d'entrée : 19 312 954 octets, recouvrements de 85 702 octets strictement identiques, aucun trou dans ce préfixe. La lecture séparée de fin de fichier n'est pas concaténée à travers la zone non acquise. Sortie fMP4 : 11 332 890 octets, positions contiguës. Empreintes dans le JSON.

Décodage logiciel local, sans réseau ni GPU : sept erreurs EBML intérieures à l'entrée et sept images corrompues ; les mêmes diagnostics H.264 se retrouvent dans la sortie. **579/579 charges utiles vidéo et 1 137/1 137 charges utiles audio de sortie existent à l'identique dans l'entrée**. Les tailles et nombres totaux des deux préfixes ont des bornes différentes ; leur soustraction ne mesure pas des images perdues.

Ces faits établissent des données endommagées avant le remuxage NorvaEngine. L'acquisition utilise toujours le relais et la livraison habituels : elle ne départage pas leur responsabilité. Les avertissements du muxer `null` de FFmpeg sont conservés dans le JSON et ne sont pas assimilés à des erreurs de décodage supplémentaires. Le retour FFmpeg 0 n'efface pas ses diagnostics de corruption.

Deux replays locaux, sans aucun nouvel appel fournisseur : la version 47 échoue au parseur MSE dès le démarrage, avec une boîte `moof` de taille zéro ; la version 48 démarre en 295 ms puis reproduit l'erreur vidéo vers 17,287 s. Les erreurs ne sont pas identiques : ce contrôle ne prétend pas reproduire le même chemin d'échec dans les deux versions. Le 416 ultérieur du serveur de replay borne l'extrait non acquis ; il n'est pas un refus du fournisseur. Le candidat dispose encore de données jusqu'à 31,291 s lorsqu'il échoue à 17,287 s.

## Régressions contrôlées

- 92 tests ciblés réussis, zéro échec : file de lectures, partage d'une plage reçue, refus et annulation, aucune insertion partielle, indexation sans réseau, saut explicite après indexation de fond, vidage FFmpeg et refus d'option invalide, transactions de mux et erreurs fournisseur.
- Fichier synthétique H.264/AC-3/SRT de 180 s : première image 380 ms ; sauts 90 s puis 170 s ; fin réelle à 180,009 s ; sous-titre 89–95 s conservé ; aucun intervalle d'image supérieur à 250 ms mesuré sur les séquences observées.
- Aucune acceptation à l'écoute ni certification de films entiers. Aucun nouveau rendu WebView ni lecteur natif modifié ; pas de nouvelle matrice Android revendiquée.

## État opérationnel

À 22:52 Paris, les six sessions sont expirées normalement, zéro claim actif du propriétaire testé, deux Gateways sains, zéro session/pompe, image `e7520bec…` inchangée. Contrôleurs et tunnels des essais fournisseur arrêtés. Aucune modification de serveur, de relais, de limite ou de tâche permanente. Les preuves de nettoyage des extraits et l'état CI/publication seront ajoutés après clôture.

Conclave reste limité par l'arrivée des données et Abduct par des pauses et une erreur de décodage sur l'extrait reçu. Ces deux copies ne sont pas déclarées réparées.

## Compléments de clôture

AAC copié sur le MKV synthétique multipiste de 60 s : première image 277 ms, saut dans le buffer vers 50 s, fin à 60,010 s, aucune erreur ni intervalle vidéo supérieur à 250 ms. L'audio a été contrôlé techniquement ; l'onglet reste muet, aucune écoute humaine revendiquée.

À 22:54:55 Paris, 60 fichiers temporaires de prélèvement, sortie et diagnostic détaillé supprimés (62 193 981 octets). Reçus de tailles, empreintes, erreurs et comparaison des paquets conservés ; aucune copie média diagnostique restante. Onglet de preuve fermé après le dernier contrôle synthétique.

Première CI : le contrôle « Notification channel policy » échoue avant les tests sur la limite de téléchargement anonyme Docker Hub. Aucun échec fonctionnel de ce contrôle n'est démontré. Une demande de relance ciblée est refusée par GitHub car le workflow tourne encore : aucune relance effectivement commencée à ce stade. Les autres contrôles poursuivent leur exécution. Attachement de PR754 refusé par Codex à la limite de 100 ; aucune pièce retirée.

### Disponibilité de l'image de preuve CI

Le même quota Docker Hub échoue sur la tête documentaire suivante. Vérification indépendante des deux registres : [miroir officiel Supabase ECR](https://gallery.ecr.aws/supabase/postgres) et Docker Hub retournent des index, manifeste Linux/amd64, configuration et 29 couches strictement identiques pour 17.6.1.136. Manifeste `sha256:5a4314708484bec672de2c09653a5c01fb1c84a998564ac231b0325e2238ed5b`, configuration `sha256:f519727303f0af6862882be2a30f420e28710d4209226e681aaddb2c01d12d9b`.

Le job CI des notifications tire désormais le miroir officiel par ce digest immuable, vérifie l'ID de configuration puis lui donne le même tag local attendu par le script. Tests SQL, réseau isolé, mémoire, utilisateur et script inchangés. Aucun registre ni conteneur de production modifié. Cela répare un téléchargement de dépendance ; aucun contrôle n'est supprimé ni considéré réussi avant exécution.

## Intégration et publication vérifiée

PR754 fusionnée par `d42e4d8680af4b366cc6b04f7e9c0d1255373dcd`, tête `90a1784fc` (code moteur `67aafad1c`, complément documentaire `754b316a0`, disponibilité CI `90a1784fc`). Contrats cloud, types Edge, parcours web/mobile, base isolée, notifications et tests Android réussis avant intégration. Suite : **6 314 tests, 6 280 réussis, 34 ignorés, zéro échec**. Les 92 tests ciblés sont inclus, pas additionnels. Les paquets Android Phone/TV réussissent ; le paquet Windows est encore en construction au contrôle de publication, aucune nouvelle préversion Windows n'est publiée ici.

Cloudflare `37991131023`, job `114025274196` : réussite. Publication à **23:06:08 Paris**, vérification des octets servis à 23:06:09. Contrôle indépendant à 23:06:31 : révision 48, SHA-256 `ec21b67c217d6407e0f3d37eaa0d8991fe77cc0f4b5b3e693c096c6b3f007f78`, URL immuable `/js/norvaEngine.ec21b67c217d6407.js`, intégrité du shell conforme, 60 entrées du manifeste comparées aux octets Git. Le vérificateur Node confirme également les 60 réponses publiques. Sa première invocation locale avait omis le manifeste généré (ENOENT local) ; l'argument du fichier récupéré et comparé à Git a été fourni, sans modification du contrôle ni incident de production.

À **23:06:29 Paris**, deux Gateways sains, image de production inchangée, zéro session/pompe et zéro claim actif du propriétaire testé. Six essais expirés normalement ; contrôleurs, tunnels et serveur local stoppés, onglet de test fermé. Pas de déploiement Gateway ou Edge. Le routage n'a pas été élargi, aucune copie remplacée, aucune langue ou réserve de démarrage modifiée.

**Conclusion bornée :** le moteur évite deux attentes Norva démontrées. Abduct atteint une première image en 7,1–8,9 s dans les essais du code livré mais conserve des pauses et une erreur de décodage ; Conclave dépasse encore 15 s en attendant les données. Les replays ont été réalisés sur le candidat dont les octets sont ensuite vérifiés publiés ; aucune nouvelle lecture fournisseur n'a été faite après publication uniquement pour répéter ces échecs connus. Aucune fluidité globale ni validation à l'écoute revendiquée.
