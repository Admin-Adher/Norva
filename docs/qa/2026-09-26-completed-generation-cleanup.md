# Nettoyage après renouvellement de catalogue

## Défaut reproduit

Un renouvellement réel du fournisseur synthétique QA a terminé la bascule et
le contrôle automatique d'accès a restauré ses 40 titres. Le travail de
nettoyage de l'ancienne génération restait cependant en attente, avec
`terminal generation purge CAS failed`.

La migration des clôtures de routines historiques avait remplacé la procédure
complète par une version limitée aux candidats annulés ou en échec. Elle ne
reconnaissait plus l'ancienne génération d'un renouvellement terminé, notamment
la génération initiale sans `transition_id`.

## Correction

La migration `20260926015500` restaure le contrat complet de nettoyage :

- génération remplacée rattachée à une transition terminée du même propriétaire
  et de la même source ; une autre génération doit être active ;
- conservation du verrou de compte, des permissions serveur et des refus PT409 ;
- refus explicite de toute génération encore désignée comme active ;
- budget commun pour les lignes média, variantes, catégories et projections ;
- conservation de la provenance et des références métier avant suppression
  éventuelle d'une coquille de titre ;
- résultat idempotent lorsqu'un travail reprend après le dernier lot validé.

## Preuves avant déploiement

- Base jetable isolée, transactions annulées : défaut reproduit avant migration ;
  **88 assertions SQL réussies après correction**.
- Refus du mauvais propriétaire, de la génération active et des budgets invalides ;
  conservation exacte des titres et d'une autre source ; compteur visible et
  pointeur actif conservés ; répétition après succès sans nouvelle suppression.
- **45 tests Node ciblés réussis**. Le contrat de nettoyage contrôle désormais
  la migration effective, au lieu de relire seulement la définition historique.
- Répétition en transaction annulée sur le catalogue QA concerné en production :
  80 lignes anciennes nettoyées (40 médias et 40 variantes), zéro coquille de titre
  supprimée, 40 titres courants conservés. Annulation vérifiée par les compteurs,
  l'état et l'empreinte de la procédure. Aucun changement persistant de ce test.

Ce rapport ne prouve pas encore le déploiement ni la reprise du travail normal ;
ces deux contrôles doivent être ajoutés après la fusion.
