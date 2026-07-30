# Norva Partners — preuve de préparation du pilote

Le dépôt contient le socle P0 en mode fail-closed. Ce document évite de
confondre « code livré » avec « pilote activable » et « versements
généralisables ».

## Artefact

Copier `ops/partners/pilot-release.example.json` dans un journal de release
privé, puis remplir uniquement des références de preuve. Ne jamais y inscrire
nom, e-mail, UUID utilisateur, code public de parrainage, document KYC,
identifiant de paiement, token ou payload fournisseur.

Le programme, les juridictions, les devises et l'allowlist restent configurés
par les RPC Admin auditées. Le JSON n'est pas une source d'autorité et ne doit
jamais contenir les identités des 20 à 50 pilotes ; il ne conserve que leur
nombre.

Valider la structure :

```bash
node scripts/validate-partners-release-evidence.js \
  <journal-prive>/partners-pilot.json
```

Exiger toutes les preuves avant l'ouverture :

```bash
node scripts/validate-partners-release-evidence.js \
  <journal-prive>/partners-pilot.json \
  --require-pilot-ready
```

Exiger en plus les deux premiers cycles supervisés et rapprochés avant toute
généralisation :

```bash
node scripts/validate-partners-release-evidence.js \
  <journal-prive>/partners-pilot.json \
  --require-generalization-ready
```

L'artefact versionné de disclosure P0 est
`ops/partners/disclosures/partners-disclosure-v1.txt`. Calculer et consigner les
empreintes du fichier déployé et de `public/partners-terms.html`, par exemple
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

Un simple code HTTP `200` n'est pas suffisant.

## Sémantique des états

- `draft` : état normal du dépôt ; les flags peuvent tous rester faux et les
  dépendances externes sont encore absentes.
- `pilot_ready` : au moins une juridiction a ses cinq portes approuvées,
  l'allowlist contient 20 à 50 personnes, les providers et preuves runtime sont
  vérifiés, `partners_enabled`, `partners_invite_only` et
  `partners_shadow_mode` sont vrais, mais `partners_payouts_live` reste faux.
- `generalization_ready` : les mêmes portes restent valides et les deux cycles
  de versement portent l'état `supervised_and_reconciled` avec une preuve de
  rapprochement.

Le validateur refuse un état prêt qui contredit ses preuves. Il ne contacte
aucun fournisseur et ne modifie ni Supabase, ni Didit, ni un rail de versement.

## Preuves externes obligatoires

Le dépôt ne peut pas créer ces preuves à la place de l'opérateur :

1. avis juridique et fiscal écrit pour chaque pays/subdivision ;
2. versions et empreintes SHA-256 des Conditions Partners et de la disclosure,
   plus preuve que les trois surfaces juridiques publiques servent réellement
   ces documents ;
3. compte Didit KYC-only, workflow et webhook signés testés en sandbox ;
4. contrat fiscal Web et rail de versement individuel sélectionnés et testés ;
5. livraisons sandbox Google Play, RevenueCat et Revolut vérifiées ;
6. run GitHub Actions Partners vert, lint et Advisors verts ;
7. backup offsite R2 récent, chiffré avec `BACKUP_AGE_RECIPIENT`, dont les
   checksums ont été vérifiés ;
8. restauration isolée réussie avec
   `ops/hetzner/backup/verify-partners-restore.sql` ;
9. cron, heartbeats, réconciliation shadow et cycle alerte/rétablissement
   observés sur l'environnement déployé ;
10. approbations distinctes Legal, Risk, Finance et Operations.

Une absence reste un blocage explicite. Elle ne doit jamais être convertie en
zéro, en succès implicite ou en validation manuelle non tracée.
