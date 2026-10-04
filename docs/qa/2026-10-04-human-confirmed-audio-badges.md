# Badges des langues confirmées à l'écoute — 4 octobre 2026

## Demande et portée

Adrien demande explicitement de publier les confirmations données dans ce chat.
L'historique serveur du compte contrôlé relie sans ambiguïté les cinq dernières
lectures aux variantes actives, chacune avec une seule piste audio d'index 1.
Les coordonnées privées sont conservées sur le serveur, pas dans ce rapport.

| Copie écoutée | Langue confirmée |
| --- | --- |
| Innocent Voices [SUB] | Espagnol |
| Prey [MULTI-SUB] / Proie | Anglais |
| Sinners [MULTI-SUB] / Pécheurs | Anglais |
| California King [MULTI-SUB] | Anglais |
| Broke [MULTI-SUB] / Amoché | Anglais |

La confirmation est humaine, issue de l'écoute du propriétaire. Elle ne remplace
pas un tag du fichier, une déclaration fournisseur ou un résultat de reconnaissance
automatique. Aucun autre doublage ni compte n'hérite de cette information.

## Implémentation

- Registre séparé `catalog_owned_human_audio_confirmations`, écrit uniquement par
  une RPC de service avec comparaison des coordonnées et du profil courant.
- Limites propriétaire, source, génération active, identité fournisseur,
  configuration, visibilité, fichier et piste. Une nouvelle date de sonde seule
  conserve le badge ; une modification des faits techniques l'invalide.
- Lecture bornée à 200 variantes, sans appel au fournisseur. Les cartes, fiches,
  versions, historique et métadonnées du lecteur reçoivent une provenance
  `human_confirmed` distincte. Les anciennes preuves automatiques restent intactes.
- Les écritures ordinaires d'historique ne peuvent pas introduire de confirmation.
  Une réponse fraîche du serveur retire une confirmation devenue invalide dans
  la mémoire de reprise du lecteur.
- Aucun changement des seuils, connexions fournisseur, baux, quarantaines ou
  compteurs de reconnaissance automatique. Les filtres/comptages automatiques
  des langues restent distincts de cette publication ciblée des badges.

## Vérification et publication

- **53 assertions SQL** réussies sur schéma isolé sans réseau ni données clients.
  Elles couvrent les droits, les mauvaises coordonnées, la non-propagation,
  l'invalidation et la conservation intégrale des preuves automatiques.
- **15 nouveaux tests JS** de projection et d'affichage réussis, avec les suites
  ciblées existantes. Contrats cloud, types Edge, base jetable, parcours client,
  politique de notifications et tests Android réussis en CI.
- Matrice Android `37220208490` : quatre configurations téléphone réussies
  (gestes/trois boutons, polices 1 et 1,3), dont assertions dans le WebView réel.
  Deux contrôles TV de consentement au D-pad réussis ; ce n'est pas une preuve
  du décodeur audio natif. Les matrices automatiques redondantes ont été annulées.
- Le premier contrôle de publication a détecté le manifeste d'actifs généré
  périmé. Il a été régénéré ; le contrôle suivant réussit. Aucun texte traduit
  ni ressource native n'a changé.
- Code `a6bb8bc947fdf1d0cec0e1ea78e37fb68adf05cf`, manifeste
  `a8e2ec8d04f1e98243e7002e9a5da68f4ceec0de`, PR 637 intégrée dans
  `c33ce20aff8509c3ccecd4856bbf4c71861accdf`.
- Migration appliquée à **17:22:11 UTC** ; cinq confirmations écrites à
  **17:22:25 UTC**. SHA-256 de la migration :
  `7163e4246571489670a7c218fbc8211a9a300b75e5b32775164abba2d696e311`.
- Canary réel validé, puis les deux Edge ont reçu les six fichiers identiques à
  **17:24:28 / 17:24:32 UTC**. Pause des nouvelles admissions du traitement
  auxiliaire : **17:24:16–17:24:35 UTC**, restaurées sans bail forcé.
- À **17:25 UTC**, les deux API de rayons retournent les cinq langues attendues,
  statut `human_confirmed` : **2 155 / 2 165 ms**. Les historiques retournent
  aussi les cinq confirmations : **437 / 427 ms**. Mesures ponctuelles de
  lecture, aucun débit général extrapolé.
- Deux Edge sains et deux Gateways HTTP 200/ok, cron et dispatcher permanent
  actifs. Conteneurs de preuve et de canary arrêtés. Aucun appel média effectué.

Publication web Cloudflare **37220559966 réussie**, sur le commit de fusion
ci-dessus. Après rechargement réel du navigateur Codex, le DOM rendu des cinq
cartes affiche **Espagnol** pour Innocent Voices et **Anglais** pour Proie,
Pécheurs, California King et Amoché. Les actifs chargés sont
`mediaUtils.js?v=ae8caf6605` et `MoviesPage.js?v=a66150f975`. Une capture du rayon
Action est conservée localement ; les cinq badges ont été contrôlés dans le DOM.
La vérification n'a démarré aucune lecture fournisseur.

**Publication ciblée terminée pour les cinq copies confirmées.** Les quatre autres
films de la demande initiale, les saccades distinctes et la campagne globale ne
sont pas déclarés terminés par cette publication.

Le [reçu agrégé](2026-10-04-human-confirmed-audio-badges.json) conserve les versions,
mesures et limites sans coordonnées privées.
