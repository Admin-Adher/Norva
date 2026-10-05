# Promax — corrections de format, démarrage et reprise

Suivi du diagnostic [des cinq versions](2026-10-05-promax-penguins-launch-audit.md). PR 670. Heures UTC ; Paris = UTC+2.

## Périmètre

Les trois copies françaises, la copie anglaise et la copie arabe de « March of the Penguins » sont conservées, avec leur fichier et piste sélectionnés. Les libellés de langue de ces essais ne sont pas une nouvelle reconnaissance linguistique. Aucun accès fournisseur, adresse, source ou route proxy modifié. Essais UI séquentiels, fermeture normale avant chaque changement de version et avant déploiement.

## Défauts établis et corrections

1. **Première correction MKV → MP4 refusée par le reçu Edge.** La cible préparée après observation de format authentifiée et CAS réussi est transmise au contrôle final. L'identité initiale du coordinateur reste immuable ; propriétaire, source, génération, configuration, visibilité, annulation et drainage restent contrôlés. Une seule adaptation bornée. Les tests exécutent le vrai contrôle et la vraie branche de récupération. Les observations déjà persistées en production n'ont pas été effacées pour simuler artificiellement un démarrage à froid.
2. **Démultiplexage MP4 à pistes éloignées.** Première fenêtre Gateway MP4 d'au plus 1 Mio, reçue et libérée entièrement avant transmission de son premier paquet au démultiplexeur ; cache privé des fenêtres terminées, délai initial de démultiplexage borné à 500 ms avant continuation. Les fenêtres continues restent bornées à 8 Mio et transmettent toujours leurs données progressivement ; le cache reste à 64 Mio. Mono-connexion, validation de contenu/plage/taille, annulation, timeouts et libération normale inchangés. Le circuit de reconnaissance linguistique n'est pas activé par ces options. Le relais natif conserve ses premières fenêtres de 256 Kio transmises progressivement.
   Le test prolongé a aussi mis en évidence la perte des préfixes reçus lors d'une fermeture volontaire du démultiplexeur. Après teardown ordinaire, ces seuls octets sont conservés dans le cache privé de la session, avec ETag fort, plage et identité déjà validés. Pas de publication inter-session, ni validation complète de plage revendiquée ; aucun préfixe conservé après timeout, erreur de plage/identité ou interruption réseau non planifiée.
3. **En-têtes H.264 absents en début de segments copiés.** Le graphe MP4/H.264 copié convertit les paramètres du démultiplexeur en Annex B puis les préfixe aux paquets. Les erreurs locales « non-existing PPS » et « no frame » ont été reproduites sur les segments générés puis supprimées par cette correction. Le test synthétique FFmpeg conserve 50 images décodées et leurs horodatages. Aucun nouveau téléchargement fournisseur pour cette comparaison locale.
4. **Audio précédant la vidéo après reprise MP4.** Avec profil exact, taille vidéo au plus 1080p, une piste simple et VAAPI prêt, le graphe décode à partir de l'image clé précédente et encode les deux pistes au point de reprise demandé. L'admission GPU existante reste nécessaire. Le point de reprise n'est ni arrondi ni déplacé. Test GPU isolé : saut à 1,37 s entre images clés, premier audio/vidéo séparés de moins de 100 ms, décodage sans erreur.
5. **Changement de circuit après réchauffement du profil.** Une copie corrigée de MKV vers MP4 garde le Gateway utilisé pour sa correction. Elle ne bascule plus automatiquement vers le relais MP4 natif au seul motif que son profil vient d'être acquis. Les MP4 normalement déclarés et les modes explicites restent inchangés.
6. **Preuve de démarrage non utilisée pour le MP4 fenêtré.** Les segments HLS finalisés peuvent désormais passer la preuve locale existante de décodage, continuité et cadence. Les seuils et réserves normales restent ceux des politiques existantes. L'encodeur utilise la politique VAAPI existante après mesure ; une simple admission du transport ne constitue pas une preuve.

## Blocage de cache reproduit sans fournisseur

Un MP4 synthétique valide a été construit avec les pistes audio/vidéo séparées par 16 Mio, puis lu par le vrai FFmpeg à travers le broker extrait du code de production. Réseau du conteneur isolé, serveur HTTP loopback seulement, latence/chunks contrôlés, même délai de libération distant de 2,5 secondes. Avant correction : expiration après 45 secondes, 25 ouvertures comptées, 18 interruptions, progression locale quasi bloquée. Les traces montrent une ouverture spéculative suivie de la fermeture locale 1–2 ms plus tard, répétée toutes les 2,5 secondes.

Cause : `serveStrictLidBrokerRange` attendait la libération fournisseur avant de servir même une réponse entièrement en cache. FFmpeg attendait cette réponse pour fermer la lecture précédente ; l'ancienne continuation avait alors le temps de rouvrir une connexion. Correction : les octets déjà validés dans le cache de la session sont servis immédiatement ; toute vraie requête distante attend toujours le mutex, le drainage et le même délai. Après correction du seul ordre d'attente : décodage réussi en 10,941 secondes, neuf fenêtres distantes terminées et trois interruptions ; aucun délai fournisseur raccourci. Le test est intégré au canary avec vérification d'une seule connexion distante au maximum.

La première fixture sans séparation suffisante était déjà rapide : ce n'était pas une reproduction du défaut. La fixture distante, ses résultats avant/après et les traces instrumentées sont conservés dans `promax-penguins-prefix-20261005/demux-*`.

## Vérifications intermédiaires conservées

- Premier rejeu arabe après adaptation des blocs : `codec_probe_timeout` encore observé, sans détail FFprobe. Sa cause interne n'est pas attribuée. Un diagnostic borné des lectures a été ajouté, sans augmenter le timeout.
- Reprise français 3 avant les dernières corrections : serveur 32,626 s, première image 35,599 s, lecture vers 74 s. Ce résultat ne constitue pas une clôture.
- Premier Gateway arabe copié : paramètres H.264 manquants ; correction prouvée indépendamment sur les segments locaux.
- Trois essais du relais natif arabe ont montré des progrès insuffisants malgré l'amélioration des petites fenêtres. Ils ne sont pas présentés comme fluides.
- Premier Gateway arabe après maintien du circuit : en-têtes corrigés mais première image retardée par rapport à l'audio ; segments suivants décodables.
- Reprise arabe après alignement : serveur 20,779 s, trois premiers segments vérifiés, départ automatique. Le test prolongé a ensuite détecté une réserve insuffisamment renouvelée : 256 Kio à chaque nouvelle lecture distante et requêtes spéculatives interrompues. Un agrandissement expérimental des fenêtres a été testé, puis retiré après les contrôles prolongés ci-dessous.
- Les fenêtres agrandies ont exposé deux défauts : préfixes abandonnés perdus puis cache bloqué par le délai distant. Les deux sont corrigés. Le rejeu après ces corrections démarrait mais rechargeait encore après environ une minute ; l’agrandissement a donc été retiré. La comparaison synthétique finale avec petits blocs réussit en 9,907 s, 16 fenêtres entièrement reçues, zéro interruption, contre 10,941 s et trois interruptions avec agrandissement. Ce test ne remplace pas le rejeu de production.
- Le rejeu arabe à 22:27:21, après correction du cache mais avec blocs 256 Kio progressifs, démarre puis recharge à 47,979 s. À 22:28:47, 44 lectures distantes / 32 terminées / 11 interrompues ; plusieurs annulations surviennent 109–134 ms après ouverture, avant les premiers octets. Les petits blocs et la grâce seuls ne suffisent donc pas. La variante suivante reçoit le premier bloc borné avant d'en exposer le premier paquet ; le test reproduit l'annulation par le démultiplexeur après ce paquet et prouve une fenêtre terminée, zéro interruption et réutilisation exacte sans seconde connexion.
- Une fixture de canary initiale essayait de copier sur un rootfs en lecture seule : corrigée par entrée standard, aucun affaiblissement du conteneur. Trois tests de contrats ont ensuite nécessité l'inclusion du nouveau helper dans leurs extractions VM ; la production n'était pas concernée. La fixture de croissance des fenêtres attendait initialement une requête unique traversant une frontière de cache : corrigée pour tester une plage alignée. Les résultats initiaux restent dans les reçus.

## Déploiements et protections

Les déploiements ont eu des pauses d'admission avec drainage naturel, sans bail forcé. Crons, worker et même dispatcher restaurés après chaque étape. Chaque image conserve les 83 autres fichiers Gateway ; chaque déploiement Edge conserve les 193 autres fichiers et permissions. Canaries UID 1000, GPU réel, réseau isolé pour Gateway, stockage vide distinct, sans accès fournisseur. Canaries arrêtés et retirés. La santé Edge est testée sur son réseau normal, sans média.

Incident de déploiement conservé : pause 22:22:22.878–22:25:33.548, attente de deux baux naturels puis timeout de santé de cinq secondes. Aucun Gateway remplacé ; crons/admission/worker restaurés et même dispatcher confirmé. Les deux contrôles de santé suivants répondent HTTP 200. Une nouvelle tentative distincte, après préconditions intégrales, réussit pendant la pause 22:26:36.761–22:26:57.705 ; les anciens reçus et marqueurs ne sont pas réécrits. Une invocation de canary avant la fin de la construction suivante échoue faute de manifeste d'image, avant création de conteneur ; l'invocation après construction réussit.

Reçus dans `.codex-artifacts/promax-penguins-*20261005/`. Les journaux et correspondances contenant des coordonnées sont privés. Les modifications sont serveur uniquement ; aucune nouvelle interface WebView ni version Play publiée dans ce correctif.

## Résultats finaux

Les cinq copies ont été reprises successivement sur le même compte, sans substitution de fichier. Première image et lecture effective sont distinguées : une première image peut rester en pause pendant le remplissage normal de la réserve.

| Copie sélectionnée | Première image | Lecture effective | Continuité mesurée |
| --- | ---: | --- | --- |
| Français 1 | 9,505 s | 22:41:26 UTC | 13,614 → 64,398 s en 50,784 s réelles ; réserve finale 113,634 s |
| Français 2 | 12,941 s | 22:37:40 UTC | 23,863 → 67,228 s en 43,364 s réelles ; réserve finale 120,822 s |
| Français 3 | 12,713 s | 22:39:37 UTC | 20,375 → 63,909 s en 43,534 s réelles ; réserve finale 120,163 s |
| Arabe | 31,949 s | 22:34:52 UTC, environ 47 s après création | 7,713 → 127,817 s en 120,104 s réelles ; réserve 28,313 → 62,209 s |
| Anglais | 39,871 s | 22:45:11 UTC, environ 138 s après création | 21,903 → 128,382 s en 106,478 s réelles ; réserve finale 89,665 s |

Sur ces intervalles, `paused=false`, `readyState=4`, erreur vidéo nulle ; progression conforme au temps écoulé. Pour l'arabe, 51 lectures distantes, 47 terminées et quatre interruptions de démarrage au dernier relevé ; le nombre d'interruptions reste à quatre pendant toute la lecture mesurée. Les trois françaises ne montrent aucune interruption fournisseur dans leurs fenêtres d'observation. Les compteurs de segments/startup du serveur sont figés à la préparation ; la réserve réelle ci-dessus provient du DOM du lecteur.

**Limite conservée : démarrage lent de certaines reprises**, particulièrement l'anglais. Sa cadence initiale 0,51× ne qualifie pas la politique rapide ; le lecteur remplit sa réserve ordinaire avant de partir automatiquement. Aucun seuil de réserve abaissé, timeout allongé ou clic Lecture forcé pour contourner cette attente. Ces essais confirment le démarrage et la continuité des passages observés, pas la lecture intégrale des cinq films ni une absence universelle de défaut réseau/fichier.

## Tests et livraison du code

Code serveur `f549a2931fe494e42dd7f1a47e2755f842a993e9` : 194 tests ciblés, 188 réussis, zéro échec et six ignorés ; canary réel huit réussis, zéro échec et 97 non sélectionnés ; CI Linux 5 989 tests, 5 959 réussis, zéro échec et 30 ignorés. Ces groupes se recoupent et ne s'additionnent pas. Les cinq check-runs du code passent, dont les paquets Android Phone/TV et Windows. Pas de nouvelle interface mobile ni de publication Play dans ce travail.

Le statut externe `Vercel – norva` est limité par le quota de déploiement (réessai proposé dans 24 h), tandis que `Vercel – norva-pwa` réussit. Ce statut de preview n'est pas une erreur des tests et ne commande pas le déploiement Gateway/Edge de ce correctif serveur. Aucune rafale de relances Vercel.

Image finale `sha256:06cfcac1d73702cfd754cbbb9ab063902cb30eb04087eddd1ece0d402bc4f78f`, arbre des 84 fichiers `58df4b3e453f7231d2487081b0b0207e61e093ecf6700e54a4f9f3033c6e4f4d`. Remplacements 22:33:23.503 / 22:33:26.037, pause 22:33:10.599–22:33:26.407. Admission/crons/worker et même dispatcher restaurés ; aucun bail forcé. Les Edge conservent le runtime `promax-startup-route-20261005/edge/runtime-functions`, playback SHA-256 `a5c22919c4ca9aebbabd616d17985ebc1acac12d5ecce75037257fe8281cb0a7`.

Les anciens refus/réponses vides d'AtlasPro, l'en-tête nul de Rust et les défauts de fichiers d'autres copies ne sont pas réparés par ce changement. Le correctif du reçu initial MKV→MP4 est vérifié par les tests du vrai code, sans effacement d'une observation de production pour fabriquer un nouveau cas à froid. La cause interne du premier `codec_probe_timeout` arabe n'est pas attribuée rétroactivement.

Clôture des cinq essais : retour normal à la fiche, première version française sélectionnée, aucune lecture opérateur laissée active. Les cinq sessions finales sont expirées normalement ; vérification des deux images, des 84 empreintes, de la santé et de la restauration des traitements après fermeture. Le JSON associé conserve les mesures DOM et les pauses ; les reçus détaillés sont dans `.codex-artifacts/promax-penguins-atomic-20261005/`.
