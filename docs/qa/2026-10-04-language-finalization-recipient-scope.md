# Finalisation audio : sélection des destinataires

## Incident constaté

Le 4 octobre à 05:11:31 et 05:11:37 UTC, le diagnostic limité de la finalisation retourne **57014**, en **8 002 et 8 003 ms**. Les codes proviennent de deux occurrences naturelles, sans reprise forcée. Le lecteur de logs a été adapté aux clés entre guillemets et aux couleurs ANSI ; seules les catégories, codes autorisés, dates et durées sont conservés.

Le compteur générique `database-statement-timeout` reste à zéro, mais ne couvre pas ce nouveau diagnostic : il ne permet pas de conclure à l'absence d'erreur SQL. L'ancien incident du 3 octobre et le travail Strng reporté au 5 octobre restent documentés.

Un échantillonnage en lecture seule (90 relevés entre 05:24:22 et 05:25:59) n'a rencontré aucun appel actif. Il ne prouve rien sur les verrous au moment des échecs. Les statistiques cumulées ne couvrent que les appels SQL réussis. **L'étape exacte interrompue lors des deux erreurs n'est pas établie.**

## Coût confirmé et correction

La sélection des destinataires des observations, dans `record_catalog_file_audio_verification`, entrait dans toute la vue des variantes visibles avant de réduire le périmètre au fournisseur concerné. Sur les coordonnées privées du travail Strng déjà suivi, un `EXPLAIN ANALYZE` en lecture seule mesure :

| Requête | Exécution | Accès aux blocs déjà en mémoire | Destinataires |
| --- | ---: | ---: | ---: |
| Production avant correction | 1 917,982 ms | 1 328 081 | 1 |
| Périmètre fournisseur préalable | 557,969 ms | 188 074 | 1 |
| Périmètre et générations explicites | **4,542 ms** | **427** | **1** |

La première version parcourt 53 voies de sources. La dernière utilise l'index naturel existant : source, génération, type et référence du fichier. Aucun nouvel index n'est créé. Les temps ne sont ni une moyenne ni une mesure du RPC complet : ils démontrent le coût évitable de cette requête précise.

La migration `20261004054500_scope_audio_verification_recipients` change uniquement la sélection des destinataires des films :

- Périmètre des sources lié à l'identité fournisseur, avec repli privé inchangé.
- Vue canonique visible conservée ; génération active et branche historique nulle séparées sans chevauchement.
- Les variantes virtuelles Selection conservent leurs contrôles de génération, de configuration, de publication et de propriétaire.
- Même déduplication et même ordre des destinataires ; branche épisodes, écritures et droits inchangés.
- Aucun changement des seuils vocaux, reçus, baux, délais, quarantaines, admission ou priorité des lectures.

## Vérification

**23 assertions SQL réussies**, dont huit comparaisons d'ensembles sur 35 combinaisons identité/fichier chacune, dans un schéma isolé sans données clients et sans réseau. Elles couvrent deux propriétaires, fournisseur commun ou différent, source privée, génération active ou ancienne, source masquée/supprimée/désactivée, absence de tête, variantes virtuelles et changement de configuration/publication Selection.

Les contraintes de génération sont temporairement relâchées uniquement dans la transaction de test annulée pour couvrir la branche historique nulle de la vue. Les états de visibilité de la fixture sont semés directement ; il ne s'agit pas d'un test des transitions du cycle de vie. Aucun de ces aménagements n'est appliqué en production.

Le harnais vérifie que seul le bloc de sélection attendu change, avec ACL et fonctions de validation, admission, sélection du travail, fusion et marquage inchangées. Quatre comparaisons supplémentaires en lecture seule en production — une coordonnée par catalogue — trouvent exactement les mêmes destinataires, sans appel fournisseur.

## Déploiement

Déploiement transactionnel le **4 octobre à 05:45:39 UTC**, après contrôle de la définition avant/après. SHA-256 de la fonction :

`83bc052b380c5db8b4e7e188999491fd913f81619a8aa74f191ae666bd5fbc8d`

Ni redémarrage ni suspension du dispatcher, aucune mutation directe de travail et aucun appel fournisseur. Le conteneur isolé de preuve est arrêté. Les deux Gateways sont sains à 05:46 ; admission et cron actifs, STOP absent, **850 lots métadonnées terminés**.

Cette optimisation est justifiée par un coût mesuré. **Elle ne certifie pas à elle seule la disparition de toutes les expirations de finalisation.** Le travail Strng du 4 octobre à 02:22 conserve son report au **5 octobre à 02:22:08 UTC**. La poursuite naturelle doit confirmer le comportement complet.

Preuves agrégées : `2026-10-04-language-campaign-heartbeat-0720.json`. Aucun identifiant de compte ni URL média n'est publié.

## Premier contrôle après publication

À **05:50 UTC**, aucune nouvelle erreur de finalisation n'est journalisée ; les deux erreurs de 05:11 restent conservées. L'audit strict compte 27 validations réussies et 57 analyses complètes indéterminées avec profil courant correspondant. Les quatre clôtures indéterminées supplémentaires depuis 05:20 ont eu lieu **avant** le déploiement (au plus tard 05:35), elles ne lui sont donc pas attribuées.

À **05:51:54**, le dispatcher a produit 17 événements et dix lots avec tentatives depuis le déploiement. **Aucune nouvelle capture stricte n'est prouvée dans cette fenêtre de six minutes**, marquée par des reports de capacité et d'occupation fournisseur. La reprise des métadonnées est confirmée ; la validation complète du prochain finaliseur naturel reste attendue.
