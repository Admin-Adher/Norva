# Priorité de finalisation des analyses audio — 4 octobre 2026

## Constat et portée

À 02:18:55 UTC, un travail Strng possède une piste attendue, un curseur terminé et une preuve de piste. Sa dernière progression est à 01:31:35 ; son bail a expiré à 01:36:01. Le sélecteur réel ne le retourne pas dans son lot de deux. Les captures plus anciennes, dont les étapes réutilisent la date d'origine, retardent la publication d'un résultat déjà capturé.

La branche sans piste restante du worker vérifie la visibilité, les droits, le profil exact et le cache, puis appelle la finalisation SQL avant toute résolution ou ouverture de média fournisseur. Elle reste soumise à l'admission et à la capacité existantes.

## Modification

Migration : `20261004022500_prioritize_completed_language_finalizers.sql`.

Trois remplacements gardés dans la définition existante du sélecteur ajoutent un rang de finalisation : état `finalizing`, curseur égal au nombre de pistes et nombre de preuves égal au nombre de pistes. La priorité s'applique après celle des demandes manuelles, dans la voie et dans le tri global. Elle ne change aucune condition d'éligibilité ni les séparations de sources héritées des migrations précédentes.

Les plafonds, baux, délais de reprise, quarantaines, compteurs, profils, certificats et seuils de confiance ne sont pas modifiés. Une preuve complète au sens du curseur doit toujours passer les validations existantes avant publication.

## Vérification

- Schéma de production copié dans PostgreSQL isolé, réseau `none`, aucune ligne client copiée.
- Retard de finalisation reproduit avant migration.
- **21 assertions SQL réussies** : ordre global et dans une voie, demandes manuelles, finalisation partielle, preuve manquante, reports futurs, quarantaine, baux actifs, voie occupée, absence de mutation, plafonds, ACL et propriétés de sécurité.
- Définitions et ACL des fonctions de claim, finalisation, capacité et admission par source comparées avant/après : inchangées.
- Conteneur de preuve arrêté après vérification.

## Production

Déploiement transactionnel à **02:21:45 UTC**, avec garde sur la définition complète avant et après, sans redémarrage, mutation de travaux ni appel fournisseur.

- SHA-256 avant : `53749523dcb89f15b6545221bc6eae1c3313daa237a8e514f7ac25545cbc0e63`.
- SHA-256 après : `f605e93582acd4fec156a870b0a25db67b47f0a8102f8eaf215c12c68c48a9ea`.
- Reprise naturelle du travail par le cron à **02:22:00 UTC** ; tentative d'exécution passée de 9 à 10.
- Tentatives fournisseur inchangées à 8 ; dernière progression de capture toujours 01:31:35.
- Les deux Gateways sont sains au contrôle de 02:25 ; admission et cron actifs.

## Limite encore ouverte

La finalisation reprise échoue à **02:22:08 UTC** : `LANGUAGE_VALIDATION_FINALIZE_FAILED`, report conservé jusqu'au **5 octobre à 02:22:08 UTC**. Aucun compteur de réussite n'est augmenté pour ce travail.

Les contrôles en lecture seule correspondent pour la source active, le propriétaire, l'identité fournisseur, le catalogue actif, le profil exact, ses indices, sa taille, sa date, son instantané, l'inventaire du cache et les indices de preuve. Ils ne prouvent pas la réussite de la transaction de publication. La cause RPC précise demeure inconnue. PostgreSQL conserve `log_min_messages=fatal` ; aucune erreur exploitable de cet appel n'est retrouvée dans les journaux consultés. Il faudra obtenir un diagnostic limité à cette opération avant un correctif supplémentaire, sans forcer le bail, la quarantaine ou le délai.

La correction d'ordonnancement est utilisée effectivement ; **ce travail strict n'est pas validé**. La campagne continue. Preuves agrégées : `2026-10-04-language-campaign-heartbeat-0415.json`.
