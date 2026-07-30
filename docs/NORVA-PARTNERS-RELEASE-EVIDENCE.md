# Norva Partners — preuve de préparation du pilote

Le dépôt contient le socle P0 en mode fail-closed. Ce document évite de
confondre « code livré » avec « pilote activable » et « versements
généralisables ».

## Artefact

Copier `ops/partners/pilot-release.example.json` dans un journal de release
privé, puis remplir uniquement des attestations structurées qui pointent vers
des preuves conservées ailleurs. Ne jamais y inscrire
nom, e-mail, UUID utilisateur, code public de parrainage, document KYC,
identifiant de paiement, token ou payload fournisseur.

Le format courant est `schema_version=2`. Un ancien journal v1 à preuves texte
est volontairement refusé : repartir du template v2 et rattacher les artefacts
réels, sans convertir automatiquement des chaînes historiques non vérifiables.
Le schéma est fermé récursivement : toute clé inconnue est refusée, y compris
dans un objet imbriqué. Le journal relie aussi la décision à
`repository=Admin-Adher/Norva`, au `candidate_commit_sha` Git exact, à
`target_environment` (`sandbox` ou `production`) et à un `deployment_id`
immuable. Un état prêt exige l'environnement `production` et ne tolère aucune
de ces informations de traçabilité manquante.

Le programme, les juridictions, les devises et l'allowlist restent configurés
par les RPC Admin auditées. Le JSON n'est pas une source d'autorité et ne doit
jamais contenir les identités des 20 à 50 pilotes ; il ne conserve que leur
nombre. La cible 20–50 est une gate de release opérée par ce journal. Elle est
volontairement distincte de la précondition DB minimale `>= 1`, qui permet le
dogfood technique sans ouvrir le pilote.
Les devises de payout doivent être des codes ISO 4217 monétaires effectivement
versables : unités de compte, métaux, codes de test et `XXX` sont refusés même
s'ils figurent dans le registre ISO.

Chaque champ `evidence` utilise le même objet strict :

```json
{
  "url": "https://evidence.norva.tv/partners/<artefact>",
  "run_id": "github-actions:<run-id>/<attempt>",
  "sha256": "<64 caractères hexadécimaux minuscules>",
  "verified_at": "2026-07-30T08:00:00Z"
}
```

L'URL doit être HTTPS, sans credentials, query string ni fragment. Le
`run_id` doit identifier un run ou une décision immuable et le SHA-256 doit
porter sur l'artefact téléchargé depuis cette référence. Les domaines
d'exemple, localhost, valeurs `replace-me`, `run-123`, hashes répétés et autres
placeholders sont refusés, y compris dans un journal encore `draft`.
Les réseaux privés, loopback, link-local, metadata, `.internal` et `.local`
sont également refusés. Les segments `.`/`..`, `//` et antislash sont interdits
dans les run IDs. `verified_at` est un véritable timestamp UTC calendaire,
jamais plus de cinq minutes dans le futur. Les observations et périodes de
cycle satisfont `début <= fin <= maintenant`, et leur preuve doit être vérifiée
après la fin.
Les quatre approbations du pilote doivent être strictement postérieures à la
plus récente preuve juridique, de configuration fournisseur/DB, App Link,
Financial Reports, CI/restore et runtime shadow. L'approbation de généralisation
doit ensuite être strictement postérieure à la fin et à la preuve du pilote,
aux deux cycles rapprochés et aux quatre approbations du pilote. Une ancienne
décision, même syntaxiquement valide, ne peut donc pas approuver une nouvelle
configuration. Les deux cycles doivent être ordonnés, sans chevauchement et
entièrement compris dans la fenêtre d'observation du pilote : un cycle
historique antérieur au pilote ne compte jamais.

Valider la structure :

```bash
node scripts/validate-partners-release-evidence.js \
  <journal-prive>/partners-pilot.json
```

Exiger toutes les attestations structurées avant l'ouverture :

```bash
node scripts/validate-partners-release-evidence.js \
  <journal-prive>/partners-pilot.json \
  --require-pilot-ready \
  --expected-commit-sha=<sha-git-40-caracteres>
```

Exiger en plus 45 jours d'observation, l'approbation de généralisation et les
deux premiers cycles supervisés et rapprochés avant toute généralisation :

```bash
node scripts/validate-partners-release-evidence.js \
  <journal-prive>/partners-pilot.json \
  --require-generalization-ready \
  --expected-commit-sha=<sha-git-40-caracteres>
```

Les deux modes stricts sont mutuellement exclusifs. Toute option inconnue,
plusieurs fichiers, un SHA absent/mal formé ou différent du journal font
échouer la commande. `--require-pilot-ready` exige aussi exactement
`status=pilot_ready` ; `--require-generalization-ready` exige exactement
`status=generalization_ready`. Un journal encore `draft` ne peut donc jamais
faire passer un gate protégé, même si ses autres champs ont été préremplis.

Le workflow manuel
`.github/workflows/partners-release-gate.yml` exécute cette validation dans
l'environnement GitHub protégé **Partners Release**. Cet environnement doit
avoir des reviewers obligatoires et le secret d'environnement
`PARTNERS_RELEASE_EVIDENCE_B64`. Le workflow décode ce journal privé dans un
fichier temporaire mode `0600`, ne l'affiche ni ne l'archive, le lie au
`GITHUB_SHA`, puis le détruit. Il refuse tout repository autre que
`Admin-Adher/Norva` et tout ref autre que `refs/heads/main` avant de décoder le
secret. Les règles de déploiement de l'environnement GitHub doivent elles aussi
restreindre **Partners Release** à la branche protégée `main`. Le workflow normal
`partners-integration.yml` ne valide que le template `draft` commité : il ne
constitue jamais une preuve autonome de readiness.

L'artefact versionné de disclosure P0 est
`ops/partners/disclosures/partners-disclosure-v1.txt`. Calculer et consigner les
empreintes de l'artefact de build déployé et de
`public/partners-terms.html`, par exemple
avec `sha256sum` sous Linux ou `Get-FileHash -Algorithm SHA256` sous PowerShell.
La version et l'empreinte consignées doivent être celles acceptées par le
programme réellement configuré.

La présence des fichiers dans Git ne prouve pas leur publication. Avant le
pilote, vérifier depuis l'extérieur que `/terms.html`, `/privacy.html` et
`/partners-terms.html` servent chacun le document attendu — contenu et titre
distinctifs, pas une réécriture vers la landing page — puis consigner dans
`legal.public_surfaces` :

- l'horodatage UTC de la vérification ;
- la référence immuable du déploiement ;
- une preuve de contrôle de contenu pour chaque URL.

Un simple code HTTP `200` n'est pas suffisant. Le hash brut de la réponse HTTP
publique n'est pas stable lorsque Cloudflare Email Address Obfuscation
randomise `data-cfemail` et `/cdn-cgi/l/email-protection`. Les références
`legal.public_surfaces.*_evidence` doivent donc hasher un artefact de
déploiement normalisé et archivé, accompagné du contrôle externe des marqueurs,
jamais le body live non normalisé.

La première preuve technique de publication, attachée au déploiement Pages du
30 juillet 2026, est archivée dans
`docs/audits/partners-legal-production-2026-07-30.md`. Elle confirme les
surfaces et leurs marqueurs, mais ne remplace aucune approbation juridique.

## Sémantique des états

- `draft` : état normal du dépôt ; les flags peuvent tous rester faux et les
  dépendances externes sont encore absentes.
- `pilot_ready` : au moins une juridiction a ses cinq portes approuvées,
  l'allowlist contient 20 à 50 personnes, le snapshot DB couvre programme,
  policies, devises, routes, allowlist, flags et gates, les providers et preuves
  runtime sont vérifiés, l'App Link a été rejoué depuis l'AAB signé par Google
  Play, `providers.individual_payout.provider` vaut explicitement `airwallex`,
  l'import Financial Reports est lié au même provider et au contrat
  `airwallex-financial-reports-2024-04-30-transaction-reconciliation-v1.1.0`,
  puis a été rapproché, et
  Didit porte trois preuves indépendantes — sandbox, live et isolation
  d'environnement — avec `environment=live`, le
  `config_fingerprint_sha256` exact de la configuration non secrète déployée et
  le `workflow_version` Didit positif. L'artefact live doit citer ce même
  fingerprint et cette même version ; l'artefact d'isolation doit démontrer à
  la fois qu'une décision sandbox reste non autoritaire et qu'un conflit
  environnement/fingerprint est mis en quarantaine. Le template `draft` garde
  ces trois nouveaux champs à `null`, et
  `partners_enabled`, `partners_invite_only`, `partners_shadow_mode` et
  `partners_tv_relay_enabled` sont vrais. `partners_payouts_live` reste faux.
- `generalization_ready` : les mêmes portes restent valides et les deux cycles
  de versement portent l'état `supervised_and_reconciled`, des périodes
  ordonnées non chevauchantes et des preuves de rapprochement distinctes ; le
  pilote possède exactement le nombre de jours UTC réellement écoulés (au
  moins 45), et la gate `general_release_approved` possède une décision
  référencée et causalement postérieure à ces preuves.

`generalization_ready` représente un snapshot de décision **pré-bascule** :
après les cycles supervisés, l'opérateur revient en état sûr
`partners_shadow_mode=true` et `partners_payouts_live=false` pour constituer et
faire approuver le journal. La bascule ultérieure reste une transaction Admin
séparée et n'est jamais déclenchée par le validateur.

Le validateur refuse un état prêt qui contredit ses attestations. Il vérifie
formats, cohérence, durée et présence des références, mais ne télécharge pas
les artefacts, ne contacte aucun fournisseur, ne lit pas Supabase et ne modifie
ni Didit ni un rail de versement. Un humain ou une CI de release doit corréler
chaque URL, `run_id` et SHA-256 avec l'artefact et le snapshot DB réels.

## Preuves externes obligatoires

Le dépôt ne peut pas créer ces preuves à la place de l'opérateur :

1. avis juridique et fiscal écrit pour chaque pays/subdivision ;
2. versions et empreintes SHA-256 des Conditions Partners et de la disclosure,
   plus preuve que les trois surfaces juridiques publiques servent réellement
   ces documents ;
3. compte Didit KYC-only, workflow et webhook signés testés en sandbox puis
   live ; fingerprint/config/version corrélés à la preuve live et preuve
   distincte de non-autorité sandbox + quarantaine sur conflit ;
4. replay `/r/{code}` avec l'application installée depuis Google Play et signée
   par Play App Signing ;
5. snapshot DB sanitisé et immuable couvrant programme, policies pays,
   métadonnées devise, routes payout, volume allowlist, flags et release gates ;
6. contrat fiscal Web et rail de versement individuel sélectionnés et testés ;
   le champ `providers.individual_payout.provider` rend le choix vérifiable ;
7. import autoritatif Airwallex Financial Reports, lié par
   `payout_reconciliation.provider` et
   `payout_reconciliation.contract_version`, contrôle de complétude
   bancaire et rapprochement distinct ;
8. livraisons sandbox Google Play, RevenueCat et Revolut vérifiées ;
9. run GitHub Actions Partners du commit candidat vert, lint et Advisors verts ;
10. backup offsite R2 récent, chiffré avec `BACKUP_AGE_RECIPIENT`, dont les
   checksums ont été vérifiés ;
11. restauration isolée réussie avec
   `ops/hetzner/backup/verify-partners-restore.sql` ;
12. cron, heartbeats, réconciliation shadow et cycle alerte/rétablissement
   observés sur l'environnement déployé ;
13. 45 jours calendaires de pilote, deux cycles rapprochés et approbations
    distinctes Legal, Risk, Finance et Operations.

Les quatre approbations et les deux rapprochements utilisent des URL, run IDs
et hashes distincts. Une même référence exacte ne peut servir à plusieurs
gates critiques. Ces objets restent des attestations vérifiables, pas une
preuve autonome : le reviewer protégé doit ouvrir l'artefact et corréler son
hash avec le commit, le déploiement et l'environnement consignés.

Une absence reste un blocage explicite. Elle ne doit jamais être convertie en
zéro, en succès implicite ou en validation manuelle non tracée.
