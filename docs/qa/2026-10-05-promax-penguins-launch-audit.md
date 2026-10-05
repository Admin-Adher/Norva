# Promax — La Marche de l’empereur : diagnostic des cinq versions

Date : 5 octobre 2026, soirée (heures UTC ci-dessous ; Paris = UTC+2).

## Périmètre et méthode

Les cinq copies de la fiche « March of the Penguins » du compte fourni ont été identifiées dans leur ordre visuel : français 1/2/3, anglais, arabe. Correspondance source/compte fournis vérifiée côté serveur sans divulguer les accès. Lectures ordinaires via Norva, séquentielles, fermeture par Retour avant la suivante. Les libellés de langue sont ceux de l’interface ; ces essais ne constituent pas une nouvelle validation linguistique.

Aucun changement de code, déploiement, configuration, garde, quota ou source. Les écritures de sessions, historique et observations de format sont celles des lectures ordinaires. Aucun fichier fournisseur réparé ou remplacé.

## Résultats

| Copie | Essai et résultat | Limite |
|---|---|---|
| Français 1 | Reprise créée 20:44:16 ; première image 6,302 s ; vidéo 47,918 → 87,098 s, lecture active, readyState 4, aucune erreur vidéo | Vrai Matroska/H.264/AAC. Essai court avec reprise, pas certification du film entier. |
| Français 2 | Création 20:35:25 ; première image 7,143 s ; vidéo 15,656 → 78,166 s, lecture active, readyState 4, aucune erreur | Premier essai utilisateur sans première image à 20:31:36 ; format découvert pendant cet essai. |
| Français 3 | Premier essai 20:37:26 : serveur prêt, puis HTTP409 et fermeture. Second essai 20:46:38 : première image 41,601 s ; vidéo 17,025 → 61,841 s, lecture active, readyState 4, aucune erreur | Démarrage lent malgré succès du second essai ; aucune correction déployée. |
| Anglais | Création 20:38:51 ; première image 4,313 s ; vidéo 32,050 → 57,013 s, lecture active, readyState 4, aucune erreur | Vrai Matroska. Essai court, langue non vérifiée à l’écoute par cet audit. |
| Arabe | Premier essai 20:40:13 : échec gateway_500 à 20:40:36, codec_probe_timeout | Un en-tête MP4 a été identifié ; ce n’est pas une preuve de fichier vide. Second contrôle : échec gateway_502, détaillé ci-dessous. |

## Défaut Norva démontré pour la correction de conteneur

Les copies françaises 2 et 3 sont annoncées MKV alors que l’en-tête détecté est MP4 (preuve iso-bmff-ftyp-v1). Les observations ont été écrites respectivement à 20:31:48.266906 et 20:37:28.364173. Leurs tailles annoncées sont 1 381 255 572 octets ; cette égalité ne certifie pas à elle seule des fichiers identiques.

La session française 3 initiale conserve l’empreinte de l’adresse `.mkv`. Le mécanisme existant `createGatewaySession` reçoit le diagnostic de conteneur, persiste l’observation, attend la libération ordinaire et fait sa reprise bornée vers `.mp4`. À 20:37:36.410, le Gateway est prêt : trois segments, 23,565 secondes de réserve, décodage de démarrage réussi. Il a réellement reçu 7 993 405 octets avant son arrêt. Le navigateur reçoit pourtant HTTP409 à 20:37:39 et aucune première image.

Le contrôle final `bindPreparedPlaybackReceipt` résout à nouveau la cible, désormais `.mp4`, et compare son empreinte à l’ancienne `.mkv` conservée dans `createPlaybackSessionCore`. La cible corrigée par le Gateway n’est pas transmise comme résultat validé à ce contrôle. Il rejette alors la préparation et ferme la session prête. C’est une incompatibilité entre l’auto-correction de format et le contrôle final de l’identité du fichier.

Reproduction locale sans réseau à partir du code réellement déployé : même propriétaire/source/génération valides simulés ; MKV inchangé accepté, MKV→MP4 rejeté HTTP409 « Playback item changed during preparation » avec une fermeture, MP4 déjà connu accepté. Les contrôles d’autorisation sont simulés pour isoler ce prédicat ; cette reproduction n’est pas un appel de production. Le rejeu réel français 3 avec observation déjà présente démarre ensuite. Le scénario français 2 est concordant avec ce mécanisme, sans conservation du corps privé exact de son erreur historique.

Code Edge déployé et fichier local identiques SHA-256 `bb6c34ff53c1ba81da6bdf9a8c7133b1eb6e80accf22e05e883c8bc6b1d59717`. Références : `norva-playback/index.ts` résolution initiale et hash (2423), garde finale (2729), reprise de conteneur (9014 et suivantes), retour Gateway ne transmettant pas la cible corrigée (9277 et suivantes).

Une correction durable devra relier la seule adaptation serveur attestée au reçu de lecture, en conservant les gardes propriétaire/source/génération/configuration/fichier, le drainage et la borne d’un seul nouvel essai. Supprimer la comparaison de cible ou accepter arbitrairement une autre adresse ne serait pas approprié. Aucun correctif n’est revendiqué dans cet audit.

## Arabe : cause distincte à ne pas confondre

Une observation MP4 a été obtenue à 20:40:15.540963, taille annoncée 1 195 560 086 octets. Le premier essai échoue ensuite à 20:40:33.997 avec `codec_probe_timeout`, sans détail FFprobe (`ffprobeLog` et `logTail` vides). Edge retourne HTTP500 à 20:40:36.605. Cela prouve un délai dépassé d’analyse, pas son origine interne, ni zéro octet, ni une corruption démontrée. Ne pas reprendre les conclusions AtlasPro pour ce cas.

## Preuves

Répertoire local `.codex-artifacts/promax-penguins-20261005/` : audits horodatés, correspondance des cinq boutons, observations de conteneur, copie du code déployé, reproduction isolée `reproduce-receipt.mjs` et résultat, captures de lecture et erreurs. Données de correspondance et journaux bruts privés sur serveur, non inclus dans ce rapport. Les reçus contenant des empreintes techniques ne doivent pas servir à publier les coordonnées privées.

## Dernier contrôle arabe et clôture de l’audit

Second essai arabe créé à 20:48:31.160 avec le conteneur MP4 déjà mémorisé. Échec à 20:49:38.525 : `gateway_502`, « Playlist was not generated », aucune première image, soit environ 67 secondes. FFmpeg signale `stream 1, offset 0x3f95cadd: partial file` puis une connexion loopback refusée et un segment HLS impossible à ouvrir. L’ordre des messages au moment de l’arrêt ne démontre pas que le refus loopback est la cause initiale : il peut être une conséquence du nettoyage. Aucun décodage complet indépendant de ces mêmes octets n’a été réalisé ; l’origine du fichier partiel reste non établie. La présence de l’en-tête MP4 initial distingue ce cas d’une réponse vide sans aucun octet.

Les sept lancements UI opérateur sont terminés : français 2, français 3, anglais, arabe, reprise français 1, nouvel essai français 3, nouvel essai arabe. Les deux essais français 3 / arabe correspondent à une comparaison avant et après la reconnaissance ordinaire du conteneur, pas à une boucle de relance. Chaque lecture précédente a été fermée par Retour. Fiche finale sur français 1, aucune lecture laissée active. Contrôle de clôture : deux Gateways en fonctionnement et zéro session dans leurs réponses debug au snapshot (reçu `closeout.safe.json`).

Bilan : quatre copies ont effectivement commencé à jouer lors des essais, avec réserve sur le démarrage lent de français 3. L’arabe reste en échec. Un défaut Norva de première correction MKV→MP4 est reproduit et expliqué ; son correctif durable reste à implémenter et valider. Les autres causes, notamment le délai de 41,6 secondes et l’échec arabe, ne sont pas assimilées à ce défaut sans preuve.


## Correctifs ultérieurs

Cet audit décrit l'état avant modification. Les corrections, incidents intermédiaires et rejeux finaux sont consignés dans [le rapport de correction](2026-10-05-promax-penguins-startup-fix.md). Les constats et limites historiques ci-dessus sont conservés.
