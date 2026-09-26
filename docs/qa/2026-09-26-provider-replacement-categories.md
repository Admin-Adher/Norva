# Catégories et réponse de décision lors du remplacement

## Constats du rejeu QA en production

- Une décision explicite « autre catalogue » a été enregistrée, mais sa réponse
  HTTP contenait encore l'état et la révision précédents. La lecture suivante
  montrait correctement `CANCELLED / DIFFERENT_CATALOG`.
- Le remplacement créé ensuite a atteint `IMPORTING`, puis son travail a échoué
  avant la première catégorie. L'ancien catalogue conserve ses 40 titres visibles ;
  le nouveau reste masqué et vide.
- Le traitement des catégories insérait `transition.old_source_id` alors que la
  génération préparée appartient à la nouvelle source. Le contrôle de cohérence
  en base rejette correctement cette association.

## Correction

La migration `20260926023000` modifie précisément les trois fonctions existantes,
avec contrôles de forme avant modification et exécution idempotente :

1. Les catégories utilisent la source de la génération vérifiée par le bail.
2. Le résultat d'une décision manuelle est lu après l'instruction UPDATE. Le getter
   SQL stable appelé dans RETURNING voyait encore la version antérieure de la ligne.
3. Le nettoyage d'un candidat consommé par un remplacement accepte la preuve
   durable `cloud_source_replacement_origins`, en plus d'une annulation explicite.
   Les contrôles de propriétaire et de génération active restent présents.

## Vérification avant publication

- Erreur d'insertion de catégorie reproduite sur une base jetable avant correction.
  Le scénario historique utilisait uniquement des listes de catégories vides.
- Réponse périmée reproduite par une nouvelle assertion du scénario de décision.
- Après migration : **30 assertions du remplacement et 73 du renouvellement réussies**.
  Les tests vérifient une catégorie non vide appartenant à B, l'absence d'écriture
  dans A, la réponse initiale de décision et le nettoyage idempotent du candidat.
- Les dépendances de remplacement manquantes de l'ancienne base de preuve ont été
  chargées dans la même transaction annulée ; aucune garde de production n'a été
  désactivée. Les marqueurs d'activation appartiennent uniquement aux fixtures.
- Migration répétée sur les trois définitions actuelles de production, puis
  annulée. Les définitions antérieures sont identiques après annulation.

Le travail de remplacement en échec est conservé. Le rejeu après déploiement devra
utiliser un nouveau parcours, sans réinitialiser la tâche terminale.
