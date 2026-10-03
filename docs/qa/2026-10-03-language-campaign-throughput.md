# Accélération de la campagne des langues — 3 octobre 2026

## Demande et périmètre

Réduire le délai de la campagne de 56 751 versions initialement sans langue sur les quatre catalogues contrôlés. La cible demandée est une à deux heures. Cela exigerait environ 28 000 à 57 000 versions examinées par heure. Le premier relevé unique donnait 295 versions en 43,4 minutes, soit 408 par heure ; ce débit inclut les métadonnées techniques et les profils, pas uniquement une analyse vocale complète.

## Correction déployée à 17:15:11 UTC

Le dispatcher avait un seul délai par source, alternait une requête de métadonnées et deux requêtes de profil, et soumettait toutes ces requêtes au créneau réservé aux profils. Ainsi une file d'analyse stricte pleine suspendait aussi les vérifications de métadonnées, qui n'ont pas besoin d'ajouter un travail à cette file.

Le format d'état 2 sépare les échéances des métadonnées et des profils. Les métadonnées peuvent avancer en dehors du créneau des profils. Les profils conservent leur priorité dans ce créneau. Les lots finis tournent entre fournisseurs. Les compteurs antérieurs sont conservés lors de la migration.

Une seule requête de campagne reste en vol. Les limites SQL et Gateway, les baux fournisseur, les contrôles de visibilité/propriétaire, les quarantaines et la priorité de lecture sont inchangés. Une occupation fournisseur réelle ou une issue HTTP incertaine suspend toujours les deux voies. Le worker strict existant garde sa place dans la limite réseau de production.

Empreinte du worker déployé : `73ae1152d3d62d1551e6bb86ce9d82f6d05a1dbcf4770d49cbfa1d2a3bb9ea73`.

## Vérification

`node --test tests/language-campaign.test.mjs tests/provider-audio-metadata-batch.test.js` : **20 tests réussis**. Couverture : migration avec bail incertain, absence de doublon d'admission, blocage fournisseur commun, file audio pleine sans suspension des métadonnées, rotation des fournisseurs, créneau de l'analyse, plafonds et temporisation des requêtes fournisseur.

Le seul conteneur relancé est `norva-language-campaign`. L'arrêt a attendu la requête en cours ; aucun bail n'a été supprimé. La sauvegarde du programme précédent et de l'état existe dans le répertoire privé de campagne. L'état 2 est effectivement chargé, le conteneur est sain et une seule requête est observée en vol.

## Mesures

Le script en lecture seule `ops/hetzner/scripts/language-campaign-progress-20261003.py` recoupe le manifeste initial avec les horodatages des déclarations fournisseur, des profils et de la progression d'analyse stricte. Il compte l'union des versions distinctes ayant reçu au moins un contrôle depuis le début. Les reports de capacité et répétitions ne gonflent pas ce total.

À 17:15:10 UTC, juste avant déploiement : **309 versions contrôlées**, en 51,1 minutes depuis le début. La fenêtre de mesure après modification conserve ce point de départ. Une langue déjà enregistrée puis rendue visible par une correction n'est pas comptée comme une nouvelle sonde.

La cible d'une à deux heures n'est pas validée. Le parcours actuel limite les métadonnées à une requête par seconde et par compte fournisseur, avec deux opérations réseau au maximum ; la campagne garde une place pour les captures strictes. Les médias sans déclaration demandent encore leurs extraits et leur consensus. La capacité théorique des simples requêtes n'est donc pas une promesse de délai d'identification complète.

La campagne et sa supervision horaire continuent. La clôture reste conditionnée à la classification de chaque version, avec distinction entre langue identifiée, résultat inconclusif et erreur de transport.
