# Récupération d'une vérification fournisseur partielle

## Défaut constaté

L'ancien catalogue QA est resté `COMMITTING` après un échec `catalog_unhealthy`
au point de reprise 15 : 40 titres avaient déjà été traités. Le mécanisme réservé
aux runs vides le refuse correctement. Réinitialiser cette tâche ferait perdre
les preuves de son échec et réutiliserait un inventaire partiel.

## Correction

`norva_rebuild_failed_credential_refresh` est une opération de maintenance réservée
au serveur. Elle exige les identifiants et versions exacts du propriétaire,
de la transition, des accès, du catalogue actif, de l'ancien run et du point de
reprise. Elle refuse une compensation, une vérification déjà terminée, une autre
tâche active et les erreurs d'authentification fournisseur.

Une nouvelle tâche et un nouveau run relisent tous les inventaires par les
procédures ordinaires. L'ancienne tâche, ses catégories, ses empreintes et ses
points de reprise sont conservés. Aucun titre n'est effacé par cette opération ;
la vérification exhaustive du nouveau run reste nécessaire pour terminer.
Un événement audite la demande et rend les répétitions idempotentes.

## Vérifications

- 90 assertions SQL : écritures VOD partielles réelles dans la base jetable,
  conservation exacte des données au moment de la demande, refus des versions
  périmées et d'un autre propriétaire, absence d'accès client, répétition unique,
  refus d'une tâche concurrente et d'une preuve provenant de l'ancien run.
- Nouvelle lecture complète et passage à `COMPLETED` avec les procédures normales.
- Répétition annulée en production : 40 titres conservés, historique inchangé,
  nouvelle tâche distincte ; après annulation, fonction et données revenues à
  leur état initial. Aucun accès fournisseur n'a été changé.

Le déploiement et l'exécution réelle restent à consigner. Ce correctif SQL ne
mesure pas le démarrage vidéo Android et ne modifie aucun drapeau de déploiement.
