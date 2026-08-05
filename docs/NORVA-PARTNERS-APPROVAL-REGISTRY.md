# Registre d’approbation Partners

Le booléen d’une release gate n’est plus une preuve. Une gate Partners n’est
effective que si elle est liée à un package d’approbation privé, immuable,
versionné, non expiré et encore identique au contrat qu’il approuve.

## Périmètre scellé

Chaque package est lié à :

- une gate et une version monotone ;
- une version précise du programme et son empreinte canonique ;
- les couples pays/subdivision approuvés et l’empreinte de chaque policy ;
- les SHA-256 des documents exigés par la gate ;
- le commit Git livré ;
- l’environnement, l’identifiant et le SHA-256 de preuve du déploiement ;
- le manifeste de déploiement courant, lui-même immuable et versionné ;
- une échéance de réévaluation, comprise entre cinq minutes et 366 jours ;
- l’opérateur pseudonymisé, l’heure serveur et la justification auditée.

Les documents eux-mêmes restent dans le coffre d’évidence approprié. La base
ne reçoit que leurs noms canoniques et leurs SHA-256 ; aucun document, donnée
d’identité, UUID d’opérateur ou justification n’est renvoyé dans la vue Admin.

Pour `privacy_approved`, le package exige notamment les empreintes de l’AIPD,
de l’auto-évaluation RGPD, du registre des traitements et de la notice Privacy.
Elle exige séparément l’empreinte du texte de consentement biométrique déployé,
afin de relier sans ambiguïté la `disclosure_version` à la preuve approuvée.
L’existence d’un fichier ou d’un template ne vaut jamais approbation : un
opérateur Risk en session AAL2 doit fournir les empreintes des pièces réellement
complétées et approuvées.

## Mutation auditée

La seule surface d’activation est :

```sql
public.admin_partners_release_gate_approve(
  p_gate_key,
  p_program_version_key,
  p_jurisdictions,
  p_document_hashes,
  p_source_commit_sha,
  p_deployment_environment,
  p_deployment_key,
  p_deployment_evidence_sha256,
  p_expires_at,
  p_justification
)
```

Avant toute approbation, le release manager en AAL2 enregistre le déploiement
exact et l’ensemble de ses preuves avec
la RPC suivante :

```sql
public.admin_partners_deployment_manifest_register(
  p_deployment_environment,
  p_source_commit_sha,
  p_deployment_key,
  p_deployment_evidence_sha256,
  p_document_hashes,
  p_justification
)
```

Un nouveau manifeste
pour le même environnement rend automatiquement les anciens packages caducs ;
il faut renouveler les gates contre le commit et les documents réellement
déployés.

La RPC applique la capacité propriétaire déjà définie par Partners (Risk,
Finance ou release manager), vérifie une session TOTP AAL2 vivante, résout les
policies côté serveur, calcule les snapshots et enregistre package, binding,
gate et événement dans une seule transaction. L’ancienne action
`admin_partners_control('set_gate', ..., true, ...)` échoue désormais si aucun
package courant n’est lié. Elle reste la surface auditée de révocation ; la
révocation supprime le binding actif, jamais le package historique.

Exemple de scope d’entrée :

```json
[
  { "country_code": "FR", "subdivision_code": null }
]
```

Les hashes doivent être des SHA-256 hexadécimaux minuscules. Les noms requis
diffèrent par gate ; toutes exigent `approval_record` et `deployment_proof`.
Les empreintes toutes à zéro et les valeurs dupliquées sont refusées côté
serveur. `deployment_proof` doit être strictement égal à
`p_deployment_evidence_sha256` ; la validation de l’interface n’est jamais la
seule autorité.
Une erreur liste les pièces obligatoires manquantes, sans accepter une valeur
par défaut ni fabriquer une approbation.

Pour `legal_and_tax_approved`, l'adhésion individuelle mondiale avec cash
limité au pilote France peut reposer sur une acceptation interne explicite du
risque par le propriétaire, mais le package doit alors
sceller séparément `legal_tax_review`, `owner_risk_acceptance`,
`partners_terms`, `partners_disclosure` et `tax_operating_policy`. L'interface
la nomme « position juridique/fiscale et risque propriétaire » ; elle ne doit
jamais la présenter comme une consultation ou une signature professionnelle.

## Séparation préproduction / production

Les packages sont autoritaires uniquement dans l’environnement qu’ils
scellent. La vérité appelée sans environnement explicite signifie toujours
`production`. Un package `preproduction` peut donc alimenter le préflight et la
fenêtre de certification Didit supervisée, lorsque tous les chemins live sont
fermés, mais il ne peut ni activer un programme/pays, ni autoriser un payout,
ni satisfaire une gate de production. Un passage en production exige un
nouveau manifeste et de nouveaux packages liés aux preuves de production.

## Invalidation et renouvellement

- Une expiration, une modification du programme ou une modification de policy
  rend immédiatement la gate ineffective dans `release_gates_satisfied`.
- L’activation d’un programme et l’adhésion sans KYC exigent que
  `legal_and_tax_approved` et `membership_privacy_approved` soient liés à ce
  même programme. La gate `privacy_approved` reste distincte et protège
  uniquement le parcours cash Didit.
- L’ouverture d’une policy exige que les packages Legal, Privacy et Country
  couvrent exactement son couple pays/subdivision.
- Une mutation substantielle déjà approuvée est bloquée : il faut révoquer les
  gates concernées, créer la nouvelle version du contrat, puis enregistrer de
  nouveaux packages.
- Un renouvellement ne modifie jamais l’ancien package. Il crée la version
  suivante et remplace atomiquement le binding actif.
- La limite AIPD du pilote est appliquée dans PostgreSQL : un verrou
  transactionnel refuse le 51e membre actif, y compris via une écriture
  concurrente ou privilégiée.

## Préactivation

`ops/hetzner/scripts/check-norva-partners-pilot-preactivation.sql` valide les
gates effectives, leur scope pilote, le commit, l’environnement, les preuves de
déploiement et l’absence de package périmé. Une gate enregistrée à `true` mais
sans package apparaît `missing` dans Admin et fait échouer le préflight.
La commande exige aussi `NORVA_PARTNERS_CANDIDATE_COMMIT_SHA` et
`NORVA_PARTNERS_DEPLOYMENT_ENVIRONMENT`. Elle vérifie que chaque package actif
vise exactement ce commit, cet environnement et l’unique couple
pays/subdivision pilote ; une simple forme SHA valide ou un package multi-pays
ne suffit pas.

La configuration Admin expose seulement : état effectif production, état
effectif préproduction, état enregistré, statut
`not_satisfied|missing|expired|stale|current_preproduction|current`, version,
SHA du package,
programme, pays/subdivision, noms de pièces, commit, environnement, SHA du
déploiement et dates. Les pseudonymes, justifications et empreintes de policy
restent privés.
