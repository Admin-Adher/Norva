# Norva Partners — approbations Legal, Privacy et Country Policy

Ce document définit le paquet privé qui doit exister avant de lever les gates
`legal_and_tax_approved`, `privacy_approved` et `country_policy_approved`.
Le validateur ne signe rien, ne contacte aucun fournisseur et ne modifie ni
PostgreSQL, ni les flags, ni les gates. Pour le pilote France sur invitation,
la décision Privacy repose sur une auto-évaluation RGPD interne documentée et
visée par le responsable interne désigné dans le dossier privé. Ce rôle
opérationnel n'est pas une désignation officielle de DPO.

Le contrat courant est `schema_version=3` et ne peut autoriser que le pilote
France `invite_only`, limité à 50 participants. Il porte explicitement
`public_release_eligible=false`. Toute ouverture publique ou tout autre pays
exige un nouveau contrat, une nouvelle évaluation et les contrôles de
généralisation décrits dans `NORVA-PARTNERS-RELEASE-EVIDENCE.md`.

## Règle de conservation

Copier `ops/partners/approval-evidence.example.json` hors du dépôt, dans le
stockage privé des preuves. Ne jamais y inscrire de nom, e-mail, UUID, IBAN,
document d'identité, donnée fiscale, identifiant Didit ou identifiant bancaire.

Chaque `evidence` est uniquement une référence immuable : URL HTTPS sans query
ni fragment, identifiant de run, SHA-256 de l'artefact et date de vérification.
Le document signé ou visé reste dans le système du professionnel concerné ou
dans le stockage privé prévu à cet effet. Pour Privacy, copier et compléter
`ops/partners/gdpr-self-assessment.example.md` hors Git, mener l'AIPD Didit
obligatoire, figer les deux versions visées, puis publier leurs références
immuables distinctes dans le paquet.
`reviewer_reference_sha256` est une référence pseudonymisée vers le dossier du
reviewer, jamais son identité en clair.
Elle doit être calculée à partir d'un identifiant de dossier aléatoire conservé
dans le stockage privé prévu, jamais à partir d'un nom ou e-mail,
qui seraient devinables par force brute.

## Socle commun à figer

Le paquet lie les trois décisions au même :

- commit candidat et déploiement cible, identifié sans ambiguïté comme
  `preproduction` ou `production` ; le mode `sandbox` reste réservé aux preuves
  fournisseur et n'est jamais un environnement de déploiement Norva ;
- périmètre `invite_only`, France uniquement, 50 participants au maximum et
  inéligibilité explicite à une ouverture publique ;
- programme individuel versionné : 20 %, attribution 30 jours, maturation
  J+45, commission récurrente tant que l'abonnement du filleul reste actif,
  frais absorbés par Norva et seuil de référence `USD=1000` unités mineures ;
- pays, subdivision éventuelle, âge minimum, capacité, workflow Didit et
  devises de versement ;
- versions et SHA-256 des Partners Terms, de la disclosure et de la Privacy,
  avec quatre preuves distinctes pour le déploiement et les trois surfaces ;
- snapshot de configuration, preuve Didit live, preuve corridor payout et
  preuve de données financières exactes.

Un changement de l'un de ces éléments exige un nouveau paquet versionné. Il ne
faut jamais réinterpréter une ancienne approbation.

Le template utilise `preproduction`. Le mode CLI `--require-all` reste réservé
à un paquet `production` complet : il ne transforme jamais une validation de
préproduction ou une preuve sandbox Didit en autorisation de mise en service.

## Ce que Legal et fiscal doivent approuver

Le professionnel juridique/fiscal produit un artefact distinct couvrant :

1. le programme réservé aux personnes physiques et l'absence de KYB dans ce
   périmètre initial ;
2. le taux récurrent de 20 % et sa durée exacte ;
3. l'attribution 30 jours, la maturation J+45, les remboursements,
   chargebacks et contre-écritures ;
4. le seuil mondial de référence, les seuils locaux figés et l'absorption des
   frais par Norva ;
5. la qualification et les obligations fiscales du partenaire et de Norva ;
6. les sanctions, destinations interdites et restrictions pays ;
7. les versions exactes des Conditions Partners et de la disclosure publique.

Toutes les cases `decisions.legal_and_tax.checks` doivent être explicitement
vraies. Une absence ou une réserve non résolue reste `false` et bloque la gate.

## Auto-évaluation Privacy interne du pilote

Norva ne désigne pas officiellement de DPO par ce parcours. Le responsable
interne `privacy_accountable_owner` produit et vise un artefact distinct
suivant `ops/partners/gdpr-self-assessment.example.md`. Il doit couvrir :

1. le registre des traitements, l'inventaire des données et les finalités ;
2. les bases légales et les responsabilités ;
3. les sous-traitants et destinataires réellement utilisés, notamment Hetzner,
   Cloudflare, Resend, Didit, Revolut, Google, RevenueCat et Telegram ;
4. les transferts internationaux et garanties associées ;
5. les durées de conservation et la suppression ;
6. l'exercice des droits ;
7. la minimisation, les vues Admin sanitisées et les journaux redacted ;
8. les notices KYC/payout, la Privacy publique et la réponse aux incidents ;
9. l'analyse documentée des critères rendant une désignation de DPO
   obligatoire, sans transformer ce contrôle en désignation ;
10. une AIPD/DPIA complète et obligatoire du KYC Didit. Le traitement remplit
    au moins deux critères CNIL : données sensibles/hautement personnelles
    (biométrie) et exclusion du bénéfice d'un droit ou contrat (éligibilité au
    programme et aux versements) ;
11. la description systématique du traitement et de ses finalités,
    l'évaluation de sa nécessité et de sa proportionnalité, les risques pour les
    droits et libertés, les garanties, le plan d'action et le risque résiduel ;
12. la validation datée de l'AIPD par le responsable de traitement et la
    décision explicite sur une consultation préalable de la CNIL. Un risque
    résiduel élevé, une consultation requise ou une décision indéterminée bloque
    `privacy_approved` ;
13. les déclencheurs de réévaluation avant changement de pays, de fournisseur,
    d'échelle ou ouverture publique.

Références CNIL autoritatives :

- https://www.cnil.fr/fr/ce-quil-faut-savoir-sur-lanalyse-dimpact-relative-la-protection-des-donnees-aipd
- https://www.cnil.fr/fr/gerer-les-risques
- https://www.cnil.fr/fr/securite-analyse-de-risques
- https://www.cnil.fr/fr/le-delegue-la-protection-des-donnees-dpo/devenir-delegue-la-protection-des-donnees

L'AIPD est obligatoire même si le pilote reste limité à 50 personnes. Cette
limite est uniquement pertinente pour l'analyse de la « grande échelle » liée
à la désignation d'un DPO. Pour ce seul pilote borné et non public, le
traitement sensible n'est pas à grande échelle et ne déclenche donc pas, à lui
seul, une désignation obligatoire. Le présent contrat ne conclut pas à une
exemption générale : il conserve `dpo_designated=false` et exige une
réévaluation des autres activités de Norva ainsi qu'à chaque changement
d'échelle ou de finalité.

Toutes les cases `decisions.privacy.checks` doivent être explicitement vraies.
La décision conserve exactement :

- `reviewer_role=privacy_accountable_owner` ;
- `assessment_method=documented_internal_gdpr_self_assessment_with_mandatory_dpia` ;
- `dpo_designated=false` ;
- `dpia_required=true` ;
- `dpia_outcome=residual_risk_acceptable` ;
- une date de validation du responsable et une `dpia_evidence` immuable,
  distincte de la preuve globale de l'auto-évaluation ;
- `public_release_eligible=false` ;
- une `evidence` immuable distincte et un
  `reviewer_reference_sha256` pseudonymisé.

Une simple case cochée, un document modifiable ou une décision non reliée au
commit et aux surfaces juridiques déployées reste bloquant.

## Limite avant ouverture publique

L'auto-évaluation interne satisfait uniquement la gate Privacy du pilote
France sur invitation. Le journal de généralisation exige une preuve distincte
de revue Privacy qualifiée et indépendante, postérieure aux 45 jours
d'observation et aux deux cycles rapprochés. Cette revue n'implique pas une
désignation officielle de DPO ; elle empêche qu'une auto-attestation pilote
soit réutilisée silencieusement pour une ouverture publique.

## Ce que Risk doit approuver pour le pays

La décision Country Policy vient après les deux décisions précédentes et après
les quatre preuves techniques du paquet. Risk doit vérifier :

1. la correspondance exacte avec les approbations Legal/Tax et Privacy ;
2. l'âge minimum, la capacité et la règle KYC individuelle ;
3. la couverture Didit live du pays ;
4. le corridor et chaque devise de versement ;
5. la couverture des données financières exactes ;
6. les restrictions et sanctions ;
7. les versions Terms/disclosure, l'allowlist pilote et les dates d'effet.

Le validateur exige que la décision Country Policy soit strictement postérieure
aux décisions Legal/Privacy et aux preuves Didit, payout, configuration et
données financières.

## Validation

La validation de structure d'un brouillon doit réussir tout en affichant les
bloqueurs :

```bash
node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-france-invite-pilot-v3.json
```

Validation ciblée avant chaque gate, avec le SHA exact du commit candidat :

```bash
node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-france-invite-pilot-v3.json \
  --require-legal \
  --expected-commit-sha=<40-hex-minuscules>

node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-france-invite-pilot-v3.json \
  --require-privacy \
  --expected-commit-sha=<40-hex-minuscules>

node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-france-invite-pilot-v3.json \
  --require-country-policy \
  --expected-commit-sha=<40-hex-minuscules>
```

Le paquet complet ne passe qu'avec `status=approved` et les trois décisions :

```bash
node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-france-invite-pilot-v3.json \
  --require-all \
  --expected-commit-sha=<40-hex-minuscules>
```

Après une validation verte, un opérateur autorisé doit encore ouvrir chaque
artefact, recalculer son SHA-256 et corréler le contenu avec la configuration
réelle. La mutation de gate reste une action Admin/AAL2 séparée et auditée.
L'auto-évaluation ne contourne jamais le TOTP, la fraîcheur du JWT AAL2, les
capacités Risk ni le journal append-only de la mutation.
