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

## Suivi à 03:18 UTC et instrumentation à 03:27

Le travail demeure en report, inchangé, sans nouvelle tentative ni capture. La cohorte progresse ailleurs : 22 validations strictes complètes au lieu de 20, notamment une autre version Strng et une Dino. Cela ne démontre pas la cause de l'échec spécifique.

La PR 616, commit de code `77574436cd88be2b184e418212a843401f1c8473`, ajoute un diagnostic limité au RPC de finalisation. Il distingue un résultat vide d'une erreur et ne conserve qu'un code SQL/PostgREST autorisé et une durée. Les arguments, messages bruts et preuves sont exclus ; les règles de reprise et l'erreur fonctionnelle restent inchangées. Quatre nouveaux tests exécutables couvrent confidentialité, erreur SQL, résultat vide, succès silencieux et maintien du contrôle d'empreinte ; **45 tests ciblés passent** au total.

Les deux Edge sont publiés successivement après un drainage de 2 min 28 s des travaux en cours, sans capture annulée ni bail forcé. Admission, cron et dispatcher restaurés à **03:27:22 UTC**. SHA-256 commun : `bfa8f6213a89a512e3ac33610a9a6ee191f3dc968319ab12fb9b4bff558e5bea`. Aucun événement d'échec de finalisation dans la courte fenêtre jusqu'à 03:29. L'erreur initiale reste ouverte et son échéance du 5 octobre est conservée.

Le script en lecture seule `/home/adrien/.norva/language-finalization-runtime.py` extrait les futurs codes agrégés et les dates de début des fenêtres de logs. Reçu complet : `2026-10-04-language-campaign-heartbeat-0518.json`.

## Extension aux consensus de fenêtres — 04:31 UTC

Le contrôle de 04:25 trouve un autre cas : MAX OTT dispose de six reçus pour six fenêtres depuis **03:41:30**, avec bail expiré depuis 03:46. Il est sélectionné dans le lot réel de quatre, mais pas dans celui de deux utilisé par le cron. Son état est encore `running`, avec une piste à terminer : la priorité précédente pour `finalizing` ne s'applique donc pas.

La branche `windowState.position === windowState.count` du worker revalide le profil et les reçus, puis demande au Gateway leur consensus avant toute acquisition de bail fournisseur ou capture. La migration **`20261004043500_prioritize_completed_language_windows.sql`** donne également priorité à ces ensembles complets : protocole 1, quatre ou six fenêtres, reçus complets, piste restante et nombre de preuves correspondant au curseur. Cette priorité ne valide pas les reçus : leur authenticité, leur liaison au fichier et le consensus strict sont toujours contrôlés par le parcours existant.

**34 assertions SQL passent** sur une copie isolée du schéma sans données clients et sans réseau, dont 13 nouvelles couvrant le retard reproduit, quatre/six fenêtres, reçus manquants, fenêtre incomplète, requête manuelle, report futur, quarantaine, baux actifs, exclusion par source et absence de mutation. Les 21 contrôles précédents passent également. Les définitions/ACL de claim, finalisation, checkpoints, capacité et admission par source sont inchangées. Le conteneur de preuve est arrêté après vérification.

Déploiement transactionnel à **04:31:27 UTC**, sans redémarrage ni pause des services. Empreinte du sélecteur avant : `f605e93582acd4fec156a870b0a25db67b47f0a8102f8eaf215c12c68c48a9ea` ; après : **`bee4c49c2932883178091cecb193f4e944980a569b02783be2bc00df8f7312ed`**. Garde sur la définition avant/après, aucune ligne de travail modifiée par la migration.

Le cron exécute le consensus MAX OTT au passage suivant, à **04:32**, et le clôt **indéterminé à 04:32:00.366 UTC**. Les six reçus, sept tentatives fournisseur et la dernière capture de 03:41:30 restent conservés ; aucune langue n'est inventée. Le report normal est conservé, sans relance de ce résultat inconclusif. L'utilisation effective du nouveau tri est prouvée ; cette clôture n'est ni une identification ni une nouvelle version sondée.

La finalisation SQL Strng est distincte et reste inchangée en report. Aucun nouveau diagnostic d'erreur de finalisation ou SQL dans les deux Edge à 04:32. Gateways sains à 04:33. Audits en lecture seule : `language-window-finalizer-audit.py` et `language-window-finalizer-followup.py` sous `/home/adrien/.norva/`. La référence précédente `finalizer-audit.safe.json` n'est pas modifiée. Reçu agrégé : `2026-10-04-language-campaign-heartbeat-0619.json`.
