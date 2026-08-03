# Norva Partners — approbations Legal, Privacy et Country Policy

Ce document définit le paquet privé qui doit exister avant de lever les gates
`legal_and_tax_approved`, `privacy_approved` et `country_policy_approved`.
Le validateur ne signe rien, ne remplace aucun professionnel, ne contacte aucun
fournisseur et ne modifie ni PostgreSQL, ni les flags, ni les gates.

## Règle de conservation

Copier `ops/partners/approval-evidence.example.json` hors du dépôt, dans le
stockage privé des preuves. Ne jamais y inscrire de nom, e-mail, UUID, IBAN,
document d'identité, donnée fiscale, identifiant Didit ou identifiant bancaire.

Chaque `evidence` est uniquement une référence immuable : URL HTTPS sans query
ni fragment, identifiant de run, SHA-256 de l'artefact et date de vérification.
Le document signé ou visé reste dans le système du professionnel ou dans le
stockage privé prévu à cet effet. `reviewer_reference_sha256` est une référence
pseudonymisée vers le dossier du reviewer, jamais son identité en clair.
Elle doit être calculée à partir d'un identifiant de dossier aléatoire conservé
dans le système privé du professionnel, jamais à partir de son nom ou e-mail,
qui seraient devinables par force brute.

## Socle commun à figer

Le paquet lie les trois décisions au même :

- commit candidat et déploiement de production ;
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

## Ce que Privacy doit approuver

Le professionnel Privacy/DPO produit un artefact distinct couvrant :

1. l'inventaire des données et les finalités ;
2. les bases légales ;
3. les sous-traitants et destinataires réellement utilisés, notamment Hetzner,
   Cloudflare, Resend, Didit, Revolut, Google, RevenueCat et Telegram ;
4. les transferts internationaux et garanties associées ;
5. les durées de conservation et la suppression ;
6. l'exercice des droits ;
7. la minimisation, les vues Admin sanitisées et les journaux redacted ;
8. les notices KYC/payout, la Privacy publique et la réponse aux incidents.

Toutes les cases `decisions.privacy.checks` doivent être explicitement vraies.

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
  /chemin/prive/partners-france-p0-v1.json
```

Validation ciblée avant chaque gate, avec le SHA exact du commit candidat :

```bash
node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-france-p0-v1.json \
  --require-legal \
  --expected-commit-sha=<40-hex-minuscules>

node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-france-p0-v1.json \
  --require-privacy \
  --expected-commit-sha=<40-hex-minuscules>

node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-france-p0-v1.json \
  --require-country-policy \
  --expected-commit-sha=<40-hex-minuscules>
```

Le paquet complet ne passe qu'avec `status=approved` et les trois décisions :

```bash
node scripts/validate-partners-approval-evidence.js \
  /chemin/prive/partners-france-p0-v1.json \
  --require-all \
  --expected-commit-sha=<40-hex-minuscules>
```

Après une validation verte, un opérateur autorisé doit encore ouvrir chaque
artefact, recalculer son SHA-256 et corréler le contenu avec la configuration
réelle. La mutation de gate reste une action Admin/AAL2 séparée et auditée.
