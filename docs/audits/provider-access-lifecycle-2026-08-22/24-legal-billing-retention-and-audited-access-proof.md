# Provider Access — preuve de rétention légale et accès audité

Date de preuve : 2026-08-25
Périmètre : suppression de compte, archive comptable minimale, politique de
rétention et consultation administrative.
Statut : `TECHNICAL_POLICY_AND_ACCESS_PATH_PROVED / PRODUCTION_POLICY_UNCONFIGURED`

## Décision technique

La migration v2 ne mesure plus la rétention depuis `issued_at`. Elle capture :

```text
legal_basis
policy_reference
retention_years
fiscal_year_end_month/day
policy revision + config hash
retention_basis_date
exclusive retention_until
```

Pour une pièce émise pendant un exercice clos le 31 décembre 2026 avec dix
années de rétention, la première purge autorisée est le 1er janvier 2037 à
00:00 UTC. Une pièce émise le 1er janvier 2027 appartient à la clôture du 31
décembre 2027 et devient purgeable le 1er janvier 2038.

Cette convention suit le principe français de conservation des documents
comptables et pièces justificatives pendant dix ans à compter de la clôture de
l'exercice. Références de revue :

- https://entreprendre.service-public.fr/vosdroits/F10029
- https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006219327/2021-05-04
- https://www.cnil.fr/fr/passer-laction/les-durees-de-conservation-des-donnees

La migration ne configure aucune règle Norva. Une ligne v1, absente, altérée
ou incomplète provoque un refus `55000`. La date réelle de clôture fiscale, la
référence de validation et l'acteur doivent être fournis explicitement avant
le rollout.

## Autorisation de consultation

La table d'archive reste inaccessible directement à `authenticated` et
`service_role`. La seule lecture applicative est une RPC exacte et bornée qui
exige simultanément :

```text
JWT Admin courant
grant legal_billing_archive_reader explicite et révisionné
JWT AAL2
facteur TOTP encore vérifié dans Auth
case_reference contrôlée
motif parmi quatre valeurs fermées
lookup exact par source_ledger_id, provider_payment_id ou order_id
```

Chaque recherche, y compris zéro résultat, insère dans la même transaction un
événement append-only contenant un pseudonyme opérateur et un digest du lookup,
jamais la valeur recherchée ni les données retournées. Les changements de grant
sont eux aussi CAS et append-only. La réponse est limitée à vingt lignes et
signale explicitement une troncature.

Le premier clone de production a révélé que les tables v1 restaurées portaient
encore des grants Supabase historiques directs pour `anon`, `authenticated` et
`service_role`. Elles contenaient zéro ligne, mais le smoke a refusé la preuve.
`20260824174000_legal_billing_archive_acl_hardening.sql` révoque désormais tous
les droits de données sur les six tables et vérifie elle-même chaque couple
`rôle × privilège` avant de committer.

## Preuves PostgreSQL réelles

Environnement : `norva-phase3-proof-b-db`, image
`supabase/postgres:17.6.1.136`.

```text
20260824172000 migration                   PASS
account_deletion_legal_billing_retention   PASS / ROLLBACK
20260824173000 migration                   PASS
legal_billing_archive_access_smoke         PASS / ROLLBACK
policy first-config two-session race       one winner / one STALE
policy race replay revision 2              one winner / one STALE
policy race replay revision 3              one winner / one STALE
```

Le smoke couvre :

- frontières `31-Dec / 1-Jan` et clôture non calendaire `30-Jun / 1-Jul` ;
- configuration absente refusée ;
- CAS de politique obsolète refusé ;
- hash de configuration altéré refusé ;
- archive + unlink atomique et idempotent ;
- reaper borné ;
- audit de politique append-only ;
- refus AAL1 ;
- lecture AAL2+TOTP+grant ;
- révocation immédiate du grant ;
- audit de lecture append-only ;
- absence de lecture directe pour les rôles API.

## Clone et installation production dormante

Le rehearsal incrémental a été rejoué depuis un dump neuf de la production au
commit `2533ba3bd9665ed6c01d35a23e0b56794fae420e` :

```text
mode       incremental
container  norva-phase123-prod-clone-legal-v2-d-db
report     /home/adrien/norva-phase3-proof/artifacts/prod-clone-legal-v2-d
result     PHASE123_PRODUCTION_CLONE_REHEARSAL_PASS
```

Hashes principaux :

```text
manifest.txt
e0957816b1b9fa3f43bb1527ad832cc82619a6df87706703ea0a54a78cccd97c

final-invariants.tsv
1eb3d891410106ca3fb45320608efb5c5043528b5a73793038f97c8643d59dbf

artifact-sha256.txt
eda93395e0701ee250eabb8365b3d345e1e9bec91a729e284ba743c34ac8bf2a
```

Après ce rehearsal, les trois migrations ont été installées sur PostgreSQL de
production sans configurer de politique ni de lecteur. Backup préalable :

```text
/var/lib/norva-phase3-proof/production-deploy-2533ba3b/predeploy.dump
bytes   909734993
mode    600
sha256  973437f5a372f9011e2697a0a028d251cd972fd30448809cff198cd6ecaf0227
```

État post-installation :

```text
policy_v2       true
access_v1       true
acl_hardened    true
policy_rows     0
archive_rows    0
access_grants   0
access_events   0
grant_events    0
rollout         off / revision 1
flags           9 total / 0 enabled
cache_epoch     installed / not completed
```

Preuve post-installation :

```text
post-invariants.tsv
1f0fccb941b67c7621b377da90ba2dc6b1389494e9345566425591cce8b94ea7

migrations.log
a627b0a375bbdae5fe554891dd62cfb7ac0a4e4422679f19c906c3006a2eacd6

timeline.log
f7a4ea42161b428a201855332628c750aef2b2054cefb40273d81654a62d4b4c
```

Les quatre workflows GitHub du commit d'installation sont verts : Build,
Partners, déploiement Web et déploiement Relay.

Suite Node complète après intégration :

```text
tests     2638
pass      2636
fail      0
skipped   2 (fixtures runtime documentées)
```

## Hashes SHA-256

```text
20260824172000_legal_billing_retention_policy_v2.sql
db8b75f8e5b10fa17ef242d709f4cb2ba15e368852dd5c02d464380efe18c038

20260824173000_legal_billing_archive_audited_access_v1.sql
acce40d4ea0a9c32b4766cc62fcf9e653c6e4633a4247a22d88709e5e0a04a9d

20260824174000_legal_billing_archive_acl_hardening.sql
8bd0673a7b47d7e3b51addce0a919eb568925ea0e0564d7d79c124c6581ae6cd

account_deletion_legal_billing_retention_smoke.sql
da92f8aa37f99ba761589b0345d2809ef83847fc8d580d8957553d207dc764ec

legal_billing_archive_access_smoke.sql
15ec9669bf41055ea9879b1c4be7cd9ea05fc4e0ccedacbe2a32560630032ff5

run_legal_billing_policy_v2_race.sh
4214221dbc07e561bda13533bc76f213c6dec0ef3e9b04b1434c4fb871f25e03

legal-billing-retention-policy-v2.test.js
b1ce8c1be7821abca19e9f38cb5103b831692306ab9275e3d0b7320c96fd73ad

run_provider_access_legal_policy_gate.sh
72dcaa2b11faa97a887379cac61d672caee00f6c7db56bec4abd19251dd88ae5
```

Le gate opérateur a été exécuté sur la production en mode `preflight` : politique
non configurée, zéro lecteur, zéro archive, zéro flag actif et zéro privilège
direct. Les deux appels mutateurs sans confirmation exacte ont été refusés avec
exit `64`, puis un nouveau preflight a confirmé un état inchangé.

## Gate de production restant

Avant toute activation :

1. confirmer la date de clôture de l'exercice comptable Norva ;
2. fournir la référence juridique/comptable approuvée ;
3. configurer la politique via la RPC CAS ;
4. désigner explicitement le ou les lecteurs autorisés ;
5. accorder chaque grant par sa RPC CAS ;
6. exécuter une lecture de contrôle avec AAL2/TOTP et vérifier son audit ;
7. conserver Provider Access `OFF` tant que ce gate et le cache epoch v2 ne
   sont pas clos.
