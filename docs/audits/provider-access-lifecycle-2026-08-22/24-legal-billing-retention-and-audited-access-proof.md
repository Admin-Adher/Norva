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

Suite Node complète après intégration :

```text
tests     2634
pass      2632
fail      0
skipped   2 (fixtures runtime documentées)
```

## Hashes SHA-256

```text
20260824172000_legal_billing_retention_policy_v2.sql
db8b75f8e5b10fa17ef242d709f4cb2ba15e368852dd5c02d464380efe18c038

20260824173000_legal_billing_archive_audited_access_v1.sql
acce40d4ea0a9c32b4766cc62fcf9e653c6e4633a4247a22d88709e5e0a04a9d

account_deletion_legal_billing_retention_smoke.sql
da92f8aa37f99ba761589b0345d2809ef83847fc8d580d8957553d207dc764ec

legal_billing_archive_access_smoke.sql
15ec9669bf41055ea9879b1c4be7cd9ea05fc4e0ccedacbe2a32560630032ff5

run_legal_billing_policy_v2_race.sh
4214221dbc07e561bda13533bc76f213c6dec0ef3e9b04b1434c4fb871f25e03

legal-billing-retention-policy-v2.test.js
28d29587460b8ab6ec508f17f5e0d86b689f1c2a841242c715e7a1ae1eecfb9e
```

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
