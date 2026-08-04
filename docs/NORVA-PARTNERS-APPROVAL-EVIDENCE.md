# Norva Partners — approbations Legal, Membership Privacy, Cash Privacy et Country Policy

Ce document définit le paquet privé qui doit exister avant de lever les gates
`legal_and_tax_approved`, `membership_privacy_approved`, `privacy_approved` et
`country_policy_approved`.
Le validateur ne signe rien, ne contacte aucun fournisseur et ne modifie ni
PostgreSQL, ni les flags, ni les gates. L'adhésion publique possède sa décision
Privacy propre, bornée aux données de compte, au referral et au ledger. Le
pilote cash France, limité à une allowlist de 20 à 50 comptes, conserve une
décision Privacy distincte avec AIPD Didit obligatoire. Les deux décisions
sont visées par le responsable interne désigné dans le dossier privé. Ce rôle
opérationnel n'est pas une désignation officielle de DPO.

Le paquet distingue deux couches. L'adhésion, le lien, l'attribution,
l'accumulation et la maturation des commissions, ainsi que leur conversion en
accès Norva, ne requièrent ni KYC/Didit, ni profil fiscal, ni corridor de
virement. Les preuves Didit, fiscales et corridor ne conditionnent que la
capacité optionnelle de demander et recevoir un virement cash. Aucun validateur
ou gate de payout ne doit être réutilisé pour bloquer la couche sans KYC.

Le contrat courant est `schema_version=4`. Il autorise l'adhésion publique tout
en maintenant les virements cash France en `allowlist_only`, avec un plafond de
50 participants et `cash_public_release_eligible=false`. Étendre le cash à un
autre pays ou au-delà de cette cohorte exige un nouveau contrat, une nouvelle
évaluation et les contrôles de généralisation décrits dans
`NORVA-PARTNERS-RELEASE-EVIDENCE.md`.

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

Le paquet lie les quatre décisions au même :

- commit candidat et déploiement cible, identifié sans ambiguïté comme
  `preproduction` ou `production` ; le mode `sandbox` reste réservé aux preuves
  fournisseur et n'est jamais un environnement de déploiement Norva ;
- adhésion publique sans KYC et, séparément, virements cash
  `allowlist_only`, France uniquement, 50 participants au maximum et
  inéligibilité explicite du cash à une ouverture publique ;
- programme individuel versionné : 20 %, attribution 30 jours, maturation
  J+45, commission récurrente tant que l'abonnement du filleul reste actif,
  frais absorbés par Norva et seuil de référence `USD=1000` unités mineures ;
- catalogue versionné de crédit d'accès : quote autoritatif, conversion
  irréversible du solde disponible, durée d'accès, pauses provider,
  remboursements, chargebacks, corrections et contre-écritures ; le crédit est
  limité contractuellement à un accès Norva, sans transfert, paiement d'un tiers
  ni remboursement cash ; cette description factuelle ne préjuge pas de sa
  qualification juridique, qui reste à valider selon le droit applicable ;
- pour la couche virement uniquement : pays, subdivision éventuelle, âge
  minimum, capacité, workflow Didit, fiscalité, corridor et devises de versement ;
- versions et SHA-256 des Partners Terms, de la disclosure et de la Privacy,
  avec quatre preuves distinctes pour le déploiement et les trois surfaces ;
- snapshot de configuration et preuve de données financières exactes pour le
  programme ; preuve Didit live et preuve corridor payout pour autoriser la
  couche virement seulement.

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
4. la conversion irréversible d'un solde disponible en accès Norva, le quote
   serveur, l'absence de transfert, de paiement d'un tiers ou de remboursement
   cash, la qualification juridique applicable sans présumer qu'elle est déjà
   tranchée et le traitement d'une contre-écriture après conversion ;
5. le seuil mondial de référence, les seuils locaux figés et l'absorption des
   frais par Norva ;
6. la qualification et les obligations fiscales du partenaire et de Norva,
   applicables à la demande de virement et non à l'adhésion ou au crédit d'accès ;
7. les sanctions, destinations interdites et restrictions pays ;
8. les versions exactes des Conditions Partners et de la disclosure publique.

Toutes les cases `decisions.legal_and_tax.checks` doivent être explicitement
vraies. Une absence ou une réserve non résolue reste `false` et bloque la gate.

## Décision Membership Privacy pour l'adhésion publique

Avant d'ouvrir l'adhésion, le responsable `privacy_accountable_owner` doit
produire une évaluation documentée sans donnée personnelle et Risk doit
l'approuver sous session AAL2. Cette décision alimente uniquement la gate
`membership_privacy_approved`; elle ne vaut ni validation Didit, ni autorisation
de virement cash. Le paquet exige :

1. une notice Privacy Partners versionnée et son SHA-256 ;
2. une entrée ROPA versionnée couvrant adhésion, lien, attribution,
   accumulation, maturation, ledger et conversion en accès Norva ;
3. une revue de minimisation versionnée démontrant que pays de payout, profil
   fiscal, destination bancaire, document d'identité et biométrie sont exclus
   de ce parcours ;
4. des vues Admin, preuves et journaux sanitisés, sans e-mail, UUID, IBAN,
   identifiant Didit ou charge utile fournisseur ;
5. les durées de conservation, droits des personnes, suppression et
   contre-écritures documentés.

Les trois artefacts `notice`, `ROPA` et `minimisation` ont chacun une version,
un SHA-256 et une référence immuable distincte. La décision conserve
`approval_control=risk_aal2` et
`assessment_method=documented_membership_privacy_assessment`. Elle peut être
approuvée avant l'AIPD cash, précisément parce qu'elle exclut Didit, la
biométrie, la fiscalité et le payout.

## Auto-évaluation Cash Privacy interne du pilote

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
8. les notices KYC/payout, leur déclenchement uniquement après choix d'un
   virement, la Privacy publique et la réponse aux incidents ;
9. l'analyse documentée des critères rendant une désignation de DPO
   obligatoire, sans transformer ce contrôle en désignation ;
10. une AIPD/DPIA complète et obligatoire du KYC Didit avant toute collecte
    live dans le parcours de virement. Le traitement remplit au moins deux
    critères CNIL : données sensibles/hautement personnelles (biométrie) et
    exclusion du bénéfice d'un droit, service ou contrat (le virement cash),
    sans conditionner l'adhésion, le lien, l'attribution, la maturation ou le
    crédit d'accès ;
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

L'AIPD est obligatoire avant d'activer Didit pour un virement même si la
cohorte cash reste limitée à 50 personnes. Cette
limite est uniquement pertinente pour l'analyse de la « grande échelle » liée
à la désignation d'un DPO. Pour ce seul traitement cash borné et non public, le
traitement sensible n'est pas à grande échelle et ne déclenche donc pas, à lui
seul, une désignation obligatoire. Le présent contrat ne conclut pas à une
exemption générale : il conserve `dpo_designated=false` et exige une
réévaluation des autres activités de Norva ainsi qu'à chaque changement
d'échelle ou de finalité.

Le retrait du consentement biométrique bloque une nouvelle vérification Didit
et tous les virements cash tant qu'il reste retiré. Il ne révoque aucune
adhésion, aucun lien, aucune attribution ni commission ; il ne stoppe pas la
maturation et ne bloque pas la conversion du solde disponible en accès Norva.
Le paquet doit prouver cette séparation dans les notices, les contrôles et les
tests bout en bout.

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

## Limite avant ouverture publique du cash

L'auto-évaluation Cash Privacy satisfait uniquement la gate `privacy_approved`
du pilote cash France sur allowlist. Elle ne limite pas l'adhésion publique,
qui dépend de `membership_privacy_approved`. Le journal de généralisation cash
exige une preuve distincte
de revue Privacy qualifiée et indépendante, postérieure aux 45 jours
d'observation et aux deux cycles rapprochés. Cette revue n'implique pas une
désignation officielle de DPO ; elle empêche qu'une auto-attestation pilote
soit réutilisée silencieusement pour une ouverture publique.

## Ce que Risk doit approuver pour le pays

La décision Country Policy vient après les décisions Legal et Cash Privacy et après
les quatre preuves techniques du paquet. Risk doit vérifier :

1. la correspondance exacte avec les approbations Legal/Tax et Privacy ;
2. la disponibilité de l'adhésion sans KYC et les restrictions/sanctions qui
   peuvent réellement imposer une suspension de compte ;
3. pour le virement seulement, l'âge minimum, la capacité, la règle KYC
   individuelle et la couverture Didit live du pays ;
4. pour le virement seulement, le corridor et chaque devise de versement ;
5. la couverture des données financières exactes ;
6. les restrictions et sanctions ;
7. les versions Terms/disclosure, l'allowlist pilote et les dates d'effet.

Le validateur exige que la décision Country Policy soit strictement postérieure
aux décisions Legal/Privacy et aux preuves Didit, payout, configuration et
données financières pour autoriser le paquet complet incluant les virements.
Cette exigence de preuve payout ne doit jamais être interprétée comme une gate
KYC de l'adhésion ou du crédit d'accès.

## Validation

La validation de structure d'un brouillon doit réussir tout en affichant les
bloqueurs :

```bash
node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-public-membership-france-cash-pilot-v4.json
```

Validation ciblée avant chaque gate, avec le SHA exact du commit candidat :

```bash
node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-public-membership-france-cash-pilot-v4.json \
  --require-legal \
  --expected-commit-sha=<40-hex-minuscules>

node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-public-membership-france-cash-pilot-v4.json \
  --require-membership-privacy \
  --expected-commit-sha=<40-hex-minuscules>

node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-public-membership-france-cash-pilot-v4.json \
  --require-privacy \
  --expected-commit-sha=<40-hex-minuscules>

node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-public-membership-france-cash-pilot-v4.json \
  --require-country-policy \
  --expected-commit-sha=<40-hex-minuscules>
```

Le paquet complet ne passe qu'avec `status=approved` et les quatre décisions :

```bash
node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-public-membership-france-cash-pilot-v4.json \
  --require-all \
  --expected-commit-sha=<40-hex-minuscules>
```

Après une validation verte, un opérateur autorisé doit encore ouvrir chaque
artefact, recalculer son SHA-256 et corréler le contenu avec la configuration
réelle. La mutation de gate reste une action Admin/AAL2 séparée et auditée.
L'auto-évaluation ne contourne jamais le TOTP, la fraîcheur du JWT AAL2, les
capacités Risk ni le journal append-only de la mutation.
