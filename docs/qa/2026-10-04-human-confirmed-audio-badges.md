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

En cours : tests ciblés de projection et d'affichage réussis. La validation SQL
isolée, l'exécution Android WebView, les versions déployées et la vérification
visuelle des cinq badges seront consignées après exécution.
