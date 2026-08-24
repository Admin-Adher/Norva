# Phase 0 — Modèle de données cible pour accès fournisseur et remplacement de source

Date : 2026-08-22  
Statut : **spécification cible, implémentation NO-GO**  
Dépendance : décision de `03-staging-isolation-adr.md`  
Nature : modèle conceptuel et contraintes ; aucun SQL de migration n'est autorisé par ce document.

Toutes les références `fichier:ligne` sont relatives à la racine absolue `C:\Users\AdrienHernandez\Documents\Norva repo`.

## Objectifs du modèle

Le modèle cible doit garantir simultanément :

- séparation stricte entre accès fournisseur, santé de synchronisation et visibilité catalogue ;
- import complet de B sans exposition avant promotion ;
- décision d'identité traçable et fail-closed ;
- promotion A → B atomique et idempotente ;
- conservation réversible de A pendant une fenêtre de rollback ;
- préservation logique des favoris, historique et progression ;
- notifications durables, dédupliquées par cycle d'accès ;
- plafonds de sources appliqués atomiquement en base ;
- purge uniquement après un état terminal et une date explicite ;
- contrôle des lectures directes, RLS, grants et chemins `service_role`.

## Constats structurants du schéma actuel

`cloud_sources.sync_status` mélange seulement la mécanique d'import avec un état `disabled`; il n'exprime ni l'accès fournisseur ni la visibilité : `supabase/migrations/20260613150937_cloud_core_playback.sql:49-64`.

Les media et variants sont déjà source-scopés :

- `cloud_media_items.source_id` : `supabase/migrations/20260613150937_cloud_core_playback.sql:66-84` ;
- `cloud_title_variants.source_id` : `supabase/migrations/20260615122000_cloud_vod_titles_projection.sql:32-58` ;
- live channels et variants : `supabase/migrations/20260614120231_cloud_live_materialized_catalog.sql:8-58`.

En revanche, `cloud_titles` est partagé par identité logique et utilisateur, sans source : `supabase/migrations/20260615122000_cloud_vod_titles_projection.sql:7-30`. Son rollup actuel intègre tous les variants : `supabase/migrations/20260615122000_cloud_vod_titles_projection.sql:86-124`.

La base contient déjà des primitives utiles :

- import versionné et prune explicite : `supabase/migrations/20260630160000_layer3_catalog_versioning.sql:1-54` ;
- registre d'identité fournisseur : `supabase/migrations/20260701000000_provider_identity_resolution.sql:22-45` ;
- lien fiable source → identité canonique : `supabase/migrations/20260719180000_dynamic_enrichment_fleet.sql:18-34,78-160` ;
- upsert causal d'historique : `supabase/migrations/20260719150000_watch_history_causal_upsert.sql:10-103` ;
- outboxes avec lease/CAS/dead-letter : `supabase/migrations/20260721230000_import_notification_delivery_outbox.sql:11-77,84-216` et `supabase/migrations/20260721235400_branded_email_delivery_outbox.sql:141-222,224-298,605-783` ;
- feature flags fail-closed : `supabase/migrations/20260701190000_admin_feature_flags.sql:5-73`.

## Agrégats métier

Le modèle cible est organisé autour de sept agrégats distincts :

1. **source et visibilité** ;
2. **snapshot courant d'accès fournisseur** ;
3. **cycles d'accès fournisseur** ;
4. **transition de credentials ou de remplacement** ;
5. **preuve d'identité fournisseur** ;
6. **projection catalogue visible** ;
7. **événements, notifications et purge**.

La séparation est obligatoire : aucune valeur de `sync_status` ne doit activer ou désactiver implicitement la visibilité, et aucune erreur d'accès ne doit supprimer le catalogue.

## 1. Source et visibilité

### Entité cible `cloud_source_lifecycle`

Entité service-owned en relation 1:1 avec `cloud_sources`. Elle peut être matérialisée dans une table dédiée ou dans des colonnes strictement protégées de `cloud_sources`; une table dédiée est préférable tant que le CRUD authentifié direct existe.

| Champ conceptuel | Type logique | Rôle |
|---|---|---|
| `source_id` | UUID, PK/FK | Référence la source |
| `user_id` | UUID, non null | Redondance contrôlée pour contraintes et audit |
| `source_lifecycle_state` | enum contrôlé | `active`, `staging`, `replaced`, `purge_pending`, `purged` |
| `catalog_visibility` | enum contrôlé | `hidden` ou `visible` |
| `replacement_root_id` | UUID | Chaîne logique de renouvellement |
| `replaces_source_id` | UUID nullable | A remplacée par cette source |
| `replaced_by_source_id` | UUID nullable | B devenue active |
| `activated_at` | timestamptz nullable | Commit de promotion |
| `hidden_at` | timestamptz nullable | Retrait du catalogue visible |
| `rollback_until` | timestamptz nullable | Fin de conservation réversible |
| `purge_after` | timestamptz nullable | Date minimale de purge physique |
| `state_version` | bigint | CAS et observabilité |
| `created_at`, `updated_at` | timestamptz | Audit |

### Rôles catalogue et transitions permises

`source_lifecycle_state` n'est pas la machine d'état du remplacement. Il décrit uniquement la place d'une source dans le catalogue pendant que `cloud_source_transitions.state` porte les huit états canoniques exacts du workflow.

| État courant | Transitions autorisées | Visibilité obligatoire |
|---|---|---|
| `staging` | `active` au commit, ou `purge_pending` après `FAILED`/`CANCELLED` | `hidden` |
| `active` | `replaced` par promotion contrôlée | `visible` |
| `replaced` | `active` par transition compensatrice, ou `purge_pending` | `hidden` |
| `purge_pending` | `purged` | `hidden` |
| `purged` | aucune | `hidden` |

Invariants :

- `catalog_visibility = visible` implique `source_lifecycle_state = active` ;
- `staging`, `replaced`, `purge_pending` et `purged` impliquent `hidden` ;
- une seule source `active/visible` par `replacement_root_id` ;
- les deux extrémités d'un remplacement appartiennent au même utilisateur ;
- `purge_after >= rollback_until` ;
- `deleted_at` ne doit pas être posé avant `purge_pending` ;
- `enabled = false` peut cacher une source active mais ne change pas son lifecycle ;
- `sync_status` reste indépendant et décrit seulement le travail d'import/refresh.

Une erreur d'accès ou de refresh ne change donc jamais le rôle catalogue d'une source. Elle met à jour `provider_access_status`, `sync_status` ou l'état de la transition concernée, tandis que le dernier catalogue validé reste intact sauf si une preuve d'accès confirmée impose de le masquer.

Ces invariants doivent être garantis par contraintes et indices uniques partiels, pas uniquement par le code Edge.

## 2. Snapshot courant d'accès fournisseur

### Entité cible `cloud_source_provider_access`

Snapshot service-owned en relation 1:1 avec `cloud_sources`, conforme au modèle demandé dans le rapport de référence.

| Champ conceptuel | Type logique | Rôle |
|---|---|---|
| `source_id`, `user_id` | UUID | Source et propriétaire |
| `provider_access_status` | enum contrôlé | État courant exact, défini ci-dessous |
| `provider_access_started_on` | date nullable | Début de la période courante |
| `provider_access_expires_on` | date nullable | Fin attendue ou rapportée |
| `provider_access_expiry_source` | enum nullable | `user_entered`, `provider_reported`, `inferred` |
| `provider_access_manual_override` | booléen | Saisie/validation manuelle explicite |
| `provider_access_reminders_enabled` | booléen | Opt-in des rappels |
| `provider_access_last_checked_at` | timestamptz nullable | Dernière tentative de contrôle |
| `provider_access_last_confirmed_active_at` | timestamptz nullable | Dernière preuve positive |
| `provider_access_last_detected_at` | timestamptz nullable | Dernière détection d'état |
| `provider_access_hidden_at` | timestamptz nullable | Masquage dû à une preuve confirmée |
| `provider_access_restored_at` | timestamptz nullable | Dernière restauration confirmée |

### Allowlist canonique `provider_access_status`

Les seuls statuts métier sont :

| Concept canonique | Valeur SQL admise | Effet de visibilité |
|---|---|---|
| `UNKNOWN` | `unknown` | Catalogue visible ; aucune date ou preuve fiable |
| `ACTIVE` | `active` | Catalogue visible |
| `EXPIRING` | `expiring` | Catalogue visible avec rappel |
| `EXPECTED_EXPIRED` | `expected_expired` | Catalogue visible avec avertissement ; date dépassée sans preuve technique suffisante |
| `EXPIRED_CONFIRMED` | `expired_confirmed` | Catalogue masqué immédiatement, jamais supprimé |
| `ACCESS_UNAVAILABLE_CONFIRMED` | `access_unavailable_confirmed` | Catalogue masqué ; la cause n'est pas nécessairement une expiration |
| `CHECK_FAILED_TEMPORARY` | `check_failed_temporary` | Ne masque jamais le catalogue à lui seul |
| `RESTORING` | `restoring` | Conserve la visibilité du catalogue précédent ; B reste cachée pendant un remplacement |

Toute autre valeur est refusée par l'allowlist DB.

Contraintes du snapshot :

- `provider_access_expires_on >= provider_access_started_on` lorsque les deux dates existent ;
- `provider_access_expiry_source` suit son allowlist exacte ;
- une date utilisateur dépassée produit `EXPECTED_EXPIRED`, jamais `EXPIRED_CONFIRMED` ;
- timeout, DNS, 502/503 ou indisponibilité temporaire produisent `CHECK_FAILED_TEMPORARY` et ne masquent pas le catalogue ;
- seuls `EXPIRED_CONFIRMED` et `ACCESS_UNAVAILABLE_CONFIRMED` imposent un masquage pour motif d'accès ;
- `provider_access_status` ne modifie pas artificiellement `sync_status` ;
- masquer ne pose ni `deleted_at` ni une demande de purge.

## 3. Cycles d'accès fournisseur

### Entité cible `cloud_source_access_cycles`

Un cycle représente une période d'accès fournisseur et ses alertes. Il ne pilote jamais directement la visibilité du catalogue.

| Champ conceptuel | Type logique | Rôle |
|---|---|---|
| `id` | UUID PK | Identifiant du cycle |
| `source_id`, `user_id` | UUID | Propriété |
| `started_on` | date nullable | Début de la période |
| `expires_on` | date nullable | Fin de la période |
| `term_value` | entier nullable | Quantité de la durée annoncée |
| `term_unit` | enum nullable | Unité dans une allowlist DB dédiée |
| `origin` | enum | `provider_reported` ou `user_entered` |
| `status` | enum | `active`, `superseded` ou `ended` |
| `created_at` | timestamptz | Création du cycle |
| `superseded_at` | timestamptz nullable | Date de supersession |

Contraintes :

- un seul cycle `active` par source, défendu par indice unique partiel ;
- `term_value > 0` lorsqu'il existe ;
- `term_unit` suit une allowlist DB explicite ;
- `expires_on >= started_on` lorsque les deux dates existent ;
- une prolongation crée un nouveau cycle `active`, passe l'ancien à `superseded` et supersède ses notifications pending ;
- un remplacement passe le cycle de A à `ended` et ouvre le cycle `active` de B ;
- les credentials et réponses fournisseur brutes ne sont jamais stockés dans le cycle.

Le schéma actuel `provider_account_activity` est centré sur un `account_key` host+username et la concurrence d'utilisation : `supabase/migrations/20260710170000_provider_account_activity.sql:24-91`. Il ne remplace ni ce cycle d'accès ni l'identité logique de catalogue.

## 4. Transitions de credentials et de remplacement

### Entité cible `cloud_source_transitions`

Une seule table peut porter les deux workflows à condition que `transition_kind` les distingue sans ambiguïté :

- `CREDENTIAL` : nouveaux credentials pour le même catalogue logique et le même `source_id` ;
- `REPLACEMENT` : source candidate B et promotion A → B.

| Champ conceptuel | Type logique | Rôle |
|---|---|---|
| `id` | UUID PK | Transition |
| `idempotency_key` | texte/UUID unique | Rejeu sûr |
| `user_id` | UUID | Propriétaire |
| `transition_kind` | enum | `CREDENTIAL` ou `REPLACEMENT` |
| `old_source_id` | UUID | A, source active ; aussi source cible d'un swap de credentials |
| `candidate_source_id` | UUID nullable | B, obligatoire pour `REPLACEMENT`, nul pour `CREDENTIAL` |
| `state` | enum exact | `VALIDATING`, `STAGING`, `IMPORTING`, `READY_TO_SWITCH`, `COMMITTING`, `COMPLETED`, `FAILED`, `CANCELLED` |
| `identity_decision` | enum nullable | `SAME_CATALOG`, `DIFFERENT_CATALOG`, `AMBIGUOUS`; nul avant décision |
| `decision_origin` | enum nullable | `automatic` ou `manual`, sans créer d'autre valeur de décision |
| `candidate_secret_ref` | référence chiffrée nullable | Obligatoire pour `CREDENTIAL`; jamais de secret dans `config_hint` |
| `previous_secret_ref` | référence chiffrée nullable | Ancienne configuration conservée jusqu'au premier refresh réussi |
| `readiness_check_id`, `readiness_passed_at` | référence/timestamp nullable | Preuve de readiness sans seconde machine d'état concurrente |
| `expected_catalog_version` | bigint | Empêche la promotion d'un snapshot obsolète |
| `import_counts` | JSON borné | Compteurs par type |
| `validation_summary` | JSON borné | Résultat sans données sensibles |
| `started_at`, `ready_at`, `committing_at`, `completed_at` | timestamptz | Audit des états canoniques |
| `rollback_until` | timestamptz | Fenêtre réversible |
| `reversal_of_transition_id` | UUID nullable | Référence une transition compensatrice sans étendre l'allowlist d'états |
| `failure_code` | texte contrôlé | Diagnostic opérateur |
| `created_by`, `approved_by` | identités contrôlées | Audit et éventuelle revue manuelle |

Contraintes :

- une seule transition non terminale par `old_source_id` ;
- les états terminaux sont exactement `COMPLETED`, `FAILED` et `CANCELLED` et ne redeviennent jamais pending ;
- un `candidate_source_id` n'appartient qu'à une transition `REPLACEMENT` non terminale ;
- A doit être `active/visible` au démarrage ;
- B doit être `staging/hidden` pendant `STAGING`, `IMPORTING` et `READY_TO_SWITCH`, puis jusqu'au commit de visibilité en `COMMITTING` ;
- pour `CREDENTIAL`, `READY_TO_SWITCH` exige validation passée et décision `SAME_CATALOG` ;
- pour `REPLACEMENT`, `READY_TO_SWITCH` exige import terminé, validation passée et décision `DIFFERENT_CATALOG` ; un choix utilisateur explicite après `AMBIGUOUS` fixe la décision finale à `DIFFERENT_CATALOG` avec `decision_origin = manual` ;
- `DIFFERENT_CATALOG` route vers le workflow `REPLACEMENT`; `AMBIGUOUS` interdit toute promotion destructive automatique ;
- le workflow `REPLACEMENT` suit `VALIDATING → STAGING → IMPORTING → READY_TO_SWITCH → COMMITTING → COMPLETED`, avec sortie possible vers `FAILED` ou `CANCELLED` avant completion ;
- le workflow `CREDENTIAL` suit `VALIDATING → READY_TO_SWITCH → COMMITTING → COMPLETED`, avec sortie possible vers `FAILED` ou `CANCELLED` ;
- aucune autre valeur ne peut être ajoutée implicitement à l'allowlist ;
- une transition ne peut pas franchir deux états critiques par un simple CRUD utilisateur.

Le stockage SQL peut utiliser les minuscules `validating`, `staging`, `importing`, `ready_to_switch`, `committing`, `completed`, `failed`, `cancelled`; le mapping est strictement un-à-un vers les concepts canoniques majuscules ci-dessus. De même, `same_catalog`, `different_catalog`, `ambiguous` sont les représentations SQL admises des trois décisions d'identité et aucune quatrième valeur n'est permise.

Pour une transition `CREDENTIAL`, la configuration candidate et l'ancienne configuration restent chiffrées. Le swap atomique se produit en `COMMITTING`; la transition ne devient `COMPLETED` qu'après le premier refresh réussi. En cas d'échec, une transaction restaure l'ancienne configuration et termine la transition en `FAILED`. Le rollback est un événement et un résultat audité, jamais une neuvième valeur d'état.

Pour une transition `REPLACEMENT`, B est une source distincte cachée. Une annulation termine en `CANCELLED`; un échec d'import ou de validation termine en `FAILED`; A reste intacte dans les deux cas.

`config_hint` est owner-editable et ne doit porter ni décision de sécurité, ni état canonique, ni identité ; cette limite est déjà documentée dans `supabase/migrations/20260719180000_dynamic_enrichment_fleet.sql:18-22`.

## 5. Preuves et décision d'identité

### Réutilisation des tables existantes

`provider_identities` et `catalog_source_provider_identities` restent les identités canoniques. Le résolveur existant échantillonne les IDs, exige au moins 32 éléments et applique un seuil Jaccard de 0,5 : `supabase/migrations/20260701000000_provider_identity_resolution.sql:63-157`.

L'enregistrement courant est toutefois best-effort et n'empêche pas la synchronisation en cas d'erreur : `supabase/functions/_shared/xtream-sync.ts:99-145`. Il intervient après écriture dans les tables live actuelles. Il ne peut donc pas être le gate de promotion sans nouveau contrat.

### Entité cible `cloud_source_identity_assessments`

| Champ conceptuel | Type logique | Rôle |
|---|---|---|
| `transition_id` | UUID PK/FK | Une évaluation stable par transition/version |
| `old_identity_id`, `candidate_identity_id` | UUID nullable | Résolution canonique |
| `algorithm_version` | texte | Reproductibilité |
| `sample_size_old`, `sample_size_new` | entier | Qualité de preuve |
| `overlap_count`, `similarity_score` | métriques | Résultat borné |
| `secondary_signals` | JSON borné | Hôte normalisé, catégories, compteurs, sans secret |
| `automatic_decision` | enum | `SAME_CATALOG`, `DIFFERENT_CATALOG`, `AMBIGUOUS` |
| `final_decision` | même enum | Résultat final ; l'origine automatique/manuelle est séparée |
| `decided_at`, `decided_by` | audit | Traçabilité |

Règles :

- moins de 32 éléments ou absence d'identité fiable donne `AMBIGUOUS`, jamais `SAME_CATALOG` ;
- erreur du résolveur donne `AMBIGUOUS` ;
- les seuils sont versionnés ;
- une décision manuelle exige acteur, justification et immutabilité de l'évidence ;
- les preuves sont calculées sur B cachée et n'alimentent aucune projection visible.

## 6. Catalogue visible

### Tables source-scopées

B peut être importée dans les tables suivantes avant promotion, à condition que toutes les lectures soient fermées par l'abstraction :

- `cloud_media_items` ;
- `cloud_title_variants` ;
- `cloud_live_logical_channels` ;
- `cloud_live_variants` ;
- autres inventaires dont chaque ligne porte un `source_id` fiable.

Le contrat commun d'éligibilité source est : propriété utilisateur, `active`, `visible`, `enabled`, `deleted_at IS NULL` et ligne disponible.

### Projections non source-scopées

`cloud_titles` ne doit plus être considéré comme directement visible par sa seule appartenance utilisateur. Le modèle cible doit choisir l'une de ces deux formes :

1. projection physique maintenue uniquement depuis les variants visibles, avec génération/version et rebuild contrôlé ;
2. projection logique visible dérivée de `cloud_visible_title_variants`, séparée du stockage d'enrichissement partagé.

Dans les deux cas :

- `default_variant_id` doit pointer vers un variant visible ;
- `variant_count` doit compter uniquement les variants visibles ;
- un titre sans variant visible n'apparaît pas ;
- la disparition de A et l'apparition de B deviennent cohérentes au même commit logique ;
- les facettes, rails et recherches consomment la projection visible, jamais la table de base brute.

### Vues/RPC canoniques

Le catalogue utilisateur doit être servi exclusivement par :

- `cloud_visible_sources` ;
- `cloud_visible_media_items` ;
- `cloud_visible_title_variants` ;
- `cloud_visible_titles` ;
- `cloud_visible_live_logical_channels` ;
- `cloud_visible_live_variants` ;
- RPC de liste, recherche, facettes, home, top-viewed et playback construits sur ces ensembles.

Les caches et matérialisations doivent enregistrer la `source_generation` ou `visibility_epoch` ayant servi à leur calcul, afin de détecter un résultat périmé lors de la bascule.

## 7. RLS, grants et rôle de service

### Problème actuel

Le CRUD authentifié direct sur sources/media/favoris/historique est visible dans `supabase/migrations/20260613150937_cloud_core_playback.sql:402-422`. Les titres/variants sont directement sélectionnables : `supabase/migrations/20260615122000_cloud_vod_titles_projection.sql:146-170`. Les politiques finales n'ajoutent aucun lifecycle : `supabase/migrations/20260628095500_rls_initplan_fix.sql:23-55`.

### Matrice cible

| Objet | `authenticated` | `service_role` | Exposition attendue |
|---|---|---|---|
| `cloud_sources` | lecture/mutation limitée par RPC | contrôle encadré | Pas de mutation directe des champs lifecycle |
| lifecycle/transitions/access/identity evidence | aucune table directe | fonctions métier seulement | Service-owned, auditables |
| tables catalogue de base | aucun `SELECT` user-facing direct | écriture/import, lecture technique bornée | Invisibles au client |
| vues catalogue visibles | `SELECT` selon RLS | lecture user-facing | Contrat unique |
| RPC de promotion/rollback | aucune exécution utilisateur ordinaire | exécution autorisée explicitement | `SECURITY DEFINER`, search path fixe |
| outboxes | aucune table directe | claim/CAS par worker | Écriture transactionnelle via fonction |

Les vues doivent être conçues avec une sémantique RLS explicite et testée. Les fonctions `SECURITY DEFINER` révoquent `PUBLIC`, fixent leur `search_path`, qualifient leurs objets et vérifient l'acteur. Le rôle de service n'est pas dispensé du prédicat de visibilité lorsqu'il produit une donnée destinée à l'utilisateur.

## 8. Promotion et rollback atomiques

### Préconditions de promotion

- transition `REPLACEMENT` en `READY_TO_SWITCH` ;
- A encore `active/visible` et version attendue inchangée ;
- B `staging/hidden`, import complet et contrôles passés ;
- identité finale `DIFFERENT_CATALOG`, avec origine automatique ou manuelle auditée séparément ; une identité `SAME_CATALOG` doit utiliser le workflow `CREDENTIAL` sur le même `source_id` ;
- aucune autre transition non terminale sur A ou B ;
- plafond et entitlements revalidés ;
- aucun job de finalisation critique non terminé ;
- outbox et remap prêts à être inscrits sans I/O externe.

### Unité atomique

Un CAS préalable réserve la transition en `COMMITTING` sans modifier la visibilité. La fonction métier de promotion doit ensuite, dans une transaction courte et récupérable de façon idempotente :

1. acquérir un verrou transactionnel stable pour A et verrouiller transition/A/B dans un ordre déterministe ;
2. relire et revalider toutes les préconditions ;
3. incrémenter la génération/epoch de visibilité ;
4. passer B à `active/visible` ;
5. passer A à `replaced/hidden` ;
6. enregistrer liens, timestamps et fenêtre de rollback ;
7. terminer la transition en `COMPLETED` ;
8. créer événements, tâches de remap, invalidations et notifications dans les outboxes ;
9. retourner l'état final après commit.

Aucun appel fournisseur, email, push, import, copie bulk, calcul de fingerprint ou rebuild complet ne doit être exécuté sous ces locks.

Un remplacement déjà `COMPLETED` ne change plus d'état. Le rollback A/B est une **transition compensatrice** portant `reversal_of_transition_id` et parcourant la même machine canonique jusqu'à `COMPLETED`. Il reste autorisé tant que `rollback_until` n'est pas dépassé et que A n'a pas été purgée. Si B a déjà produit de nouvelles progressions, leur fusion utilise les primitives causales plutôt qu'un écrasement.

Pour `CREDENTIAL`, `COMMITTING` couvre le swap chiffré puis le premier refresh sans conserver de lock DB pendant l'I/O. Le succès termine en `COMPLETED`; un échec restaure l'ancienne configuration dans une transaction courte et termine en `FAILED`.

## 9. Favoris, historique et progression

Le schéma actuel lie les favoris à une source avec cascade : `supabase/migrations/20260613150937_cloud_core_playback.sql:86-96`. Le reaper les supprime explicitement : `supabase/migrations/20260707180000_reap_reliable_timeout_via_cron_command.sql:62-70`.

L'historique met `source_id` à `NULL` : `supabase/migrations/20260613150937_cloud_core_playback.sql:98-114`. Une migration documente déjà les doublons issus d'une suppression ou d'un « renewal » : `supabase/migrations/20260717160001_watch_history_null_source_dedupe.sql:4-33`.

Le modèle cible ajoute une référence logique stable, par exemple `title_id` ou une identité catalogue canonique, et un ledger de remap A → B :

- les favoris sont attachés à l'identité logique, avec une préférence de variant/source séparée ;
- l'historique conserve son identité logique et sa provenance ;
- la progression reste fusionnée selon `watched_at` et l'upsert causal existant ;
- un élément non apparié reste conservé mais indisponible, jamais supprimé par défaut ;
- le remap est idempotent et auditable ;
- la purge de A attend la fin ou l'abandon explicite du remap.

## 10. Limites de sources et admissions

La valeur par défaut actuelle inclut `sources: 2` : `supabase/migrations/20260616122103_cloud_entitlements.sql:14-22`. L'implémentation Edge compte puis insère sans transaction unique : `supabase/functions/norva-cloud/index.ts:863-905`.

Le modèle cible distingue :

- sources commerciales actives ;
- candidates de remplacement cachées ;
- sources remplacées en rétention.

Une candidate ne consomme pas un deuxième slot commercial pendant une transition autorisée, mais les contraintes imposent :

- une candidate par ancienne source ;
- une borne par utilisateur ;
- une taille/import budget maximum ;
- aucun usage général d'une candidate comme source gratuite additionnelle ;
- admission et création dans une même fonction DB atomique, avec lock par utilisateur/entitlement.

## 11. Événements, notifications et feature flags

### Événements métier

Une table append-only `cloud_source_lifecycle_events` doit enregistrer les changements significatifs : changement de `provider_access_status`, cycle `active`/`superseded`/`ended`, staging créé, import validé/échoué, décision `SAME_CATALOG`/`DIFFERENT_CATALOG`/`AMBIGUOUS`, passage en `COMMITTING`, completion, échec, annulation, transition compensatrice et purge.

Chaque événement possède une clé de déduplication stable et un payload minimal sans secrets ni réponses fournisseur brutes.

### Notifications

L'outbox email générique existante est réutilisable. Les alertes d'accès ne doivent pas surcharger l'unicité import `(source_id, kind)` de `cloud_import_notifications`; elles doivent être dédupliquées par `access_cycle_id + event_kind + channel`.

L'enqueue email/push est écrit dans la même transaction que l'événement métier. Le worker possède seul l'I/O, le lease, les retries et le dead-letter. Les tests contractuels existants couvrent ces primitives : `tests/import-notification-delivery.test.js:12-113,171-207` et `tests/branded-email-delivery.test.js:21-38,98-152`.

### Flags

Flags canoniques séparés, tous OFF par défaut :

- `provider_access_v1_enabled` ;
- `provider_access_auto_detection_v1_enabled` ;
- `provider_access_notifications_v1_enabled` ;
- `provider_access_visibility_v1_enabled` ;
- `provider_credential_transition_v1_enabled` ;
- `provider_replacement_v1_enabled`.

Ils doivent permettre notamment `metadata ON`, `notifications OFF`, `visibility OFF` et `replacement OFF`. Le rollback et la purge restent des contrôles opérateur fail-closed, pas des états supplémentaires de transition.

Le lecteur public actuel ne whitelist que la maintenance : `supabase/migrations/20260701200000_public_flags_reader.sql:1-18`. Les flags critiques restent server-side et ne constituent jamais l'unique barrière de sécurité : les contraintes DB et la visibilité fail-closed restent actives même si un flag est mal configuré.

## 12. Purge, rétention et confidentialité

La purge actuelle démarre dès que `deleted_at` est non null et tourne toutes les dix minutes : `supabase/migrations/20260707180000_reap_reliable_timeout_via_cron_command.sql:39-70` et `supabase/migrations/20260708093000_reap_frequency_10min.sql:12-15`.

Le modèle cible impose :

- A reste avec `source_lifecycle_state = replaced` et `catalog_visibility = hidden`, sans `deleted_at`, durant la fenêtre de transition compensatrice ;
- `purge_pending` exige `now >= purge_after`, transition terminale, remap terminé et aucune référence bloquante ;
- la purge est bornée, relançable et idempotente ;
- les credentials chiffrés de A sont conservés uniquement pendant la durée justifiée par le rollback ;
- les payloads d'évidence et notifications sont minimisés et ont une rétention documentée ;
- l'état `purged` conserve un tombstone minimal d'audit, pas les secrets ni le catalogue. Ce tombstone doit survivre à la suppression des lignes lourdes : soit la ligne source devient elle-même un tombstone, soit l'audit terminal est copié dans une table append-only sans `ON DELETE CASCADE`.

## 13. Alias, caches et EPG

Les alias de source sont actuellement dans `localStorage` : `public/js/api.js:247-275`. Ils ne peuvent pas être modifiés atomiquement par PostgreSQL. La promotion doit donc émettre une invalidation durable après commit ; les clients doivent résoudre l'identité logique ou la chaîne de remplacement au lieu de dépendre d'un UUID périmé.

Aucun schéma EPG/XMLTV/programme n'a été trouvé dans les migrations ; seule la valeur `source_type = epg` existe dans `supabase/migrations/20260613150937_cloud_core_playback.sql:49-54`. L'EPG doit être considéré comme un domaine non couvert : soit ses données deviennent source/génération-scopées et suivent la même visibilité, soit l'Option A reste NO-GO pour cette surface.

Tous les caches externes doivent être nommés par `source_generation`/`visibility_epoch` ou invalidés via outbox. Une expiration temporelle seule ne prouve pas l'invisibilité de B.

## 14. Séquence de migration conceptuelle

Cette séquence reprend les gates stricts du rapport ; elle ne décrit pas du SQL exécutable.

| Phase | Portée | Gate de sortie |
|---:|---|---|
| 0 | Audit complet des sources, catalogues, identités, favoris/historique, EPG, fleets, caches et alias | Cycle de vie actuel documenté ; aucun changement produit |
| 1 | Abstraction centrale de visibilité, vues/RPC, instrumentation, shadow reads, fermeture progressive des grants directs | Toutes les surfaces, projections et fleets passent par le contrat fail-closed ; flag OFF |
| 2 | Modèle des transitions `CREDENTIAL`/`REPLACEMENT`, états canoniques et contraintes DB | Machines et invariants validés en base |
| 3 | Nouveaux credentials pour le même catalogue : candidate, validation, `SAME_CATALOG`/`DIFFERENT_CATALOG`/`AMBIGUOUS`, safe swap et restauration de l'ancien secret en cas d'échec | Parcours `CREDENTIAL` et récupération prouvés ; aucune notification |
| 4 | Nouveau fournisseur : B `STAGING`, import, `READY_TO_SWITCH`, switch atomique, soft-delete retardé et cleanup | A reste intacte sur tout échec ; aucune notification |
| 5 | E2E Provider A → B | A disponible avant switch, B invisible avant switch, B seule visible après switch, aucun mélange ; **ne pas continuer tant que ce gate n'est pas totalement vert** |
| 6 | Snapshot `provider_access_status` et `cloud_source_access_cycles` | Modèle Provider Access validé ; notifications toujours OFF |
| 7 | Détection automatique Xtream | Données fournisseur extraites et normalisées sans confondre échec temporaire et preuve confirmée |
| 8 | Visibilité liée à l'accès | `EXPECTED_EXPIRED`, `EXPIRED_CONFIRMED`, `ACCESS_UNAVAILABLE_CONFIRMED` et hide/unhide validés |
| 9 | Onboarding | Date, durée et opt-in rappels intégrés |
| 10 | Settings | Écrans Provider Access et Restore catalog access intégrés |
| 11 | Outbox notifications | Queue, cron, idempotence par cycle et supersession validés ; première phase où le rail notifications peut être activé séparément |
| 12 | Email | Déploiement email contrôlé |
| 13 | Push | Branchement FCM contrôlé |
| 14 | In-app | Bannière et écran d'état |
| 15 | Analytics et dashboard | Parcours, violations et transitions observables |
| 16 | Rollout | Interne, puis 1 %, 5 %, 20 %, 50 % et 100 % avec gates |

Les notifications restent explicitement **OFF pendant les Phases 0 à 10**. Elles ne sont ni activées avec la comparaison d'identité, ni avec le staging/promotion. Leur travail ne commence qu'après le gate E2E Phase 5, et leur activation reste séparée jusqu'à la Phase 11.

La purge retardée ne peut être activée qu'après preuve du rollback, du remap et du gate E2E A → B.

Une fois des transitions réelles enregistrées, le rollback de déploiement doit passer par flags, vues compatibles et forward-fix. Il ne doit pas supprimer les nouvelles colonnes/tables ni perdre l'audit.

## 15. Invariants de validation obligatoires

Avant GO, les tests PostgreSQL et applicatifs doivent prouver :

- aucune ligne de B n'est visible par `authenticated` ;
- aucune ligne de B n'est renvoyée par une RPC `SECURITY DEFINER` ;
- aucun titre/facette/rail/cache utilisateur ne change pendant l'import B ;
- aucun crawler/fleet partagé ne prend B comme candidate avant promotion ;
- la promotion concurrente ne peut produire deux sources visibles ;
- une répétition avec la même clé d'idempotence rend le même résultat ;
- une erreur à chaque étape de la transaction laisse A visible et B cachée ;
- un échec `CREDENTIAL` après le swap restaure l'ancienne configuration et termine en `FAILED` ;
- une transition compensatrice restaure A sans muter une transition `COMPLETED` ni perdre les progressions plus récentes ;
- un remplacement bloqué en `COMMITTING` est détecté et récupéré de manière idempotente ;
- le plafond de sources résiste à plusieurs créations concurrentes ;
- le reaper ignore toute source encore dans la fenêtre de rollback ;
- les favoris et historiques non remappables sont conservés ;
- les notifications ne partent qu'une fois par cycle/canal et tolèrent un ack ambigu ;
- les rôles `anon`, `authenticated`, `service_role` et les propriétaires de fonctions ont les privilèges attendus ;
- la base réellement déployée possède les mêmes politiques, grants, fonctions et contraintes que le modèle validé.

## Conclusion

Le modèle cible rend l'Option A viable uniquement parce qu'il transforme la visibilité en invariant central de base et non en convention de filtrage client. Tant que les grants directs, le rollup global de `cloud_titles`, les projections partagées et les fleets ne sont pas fermés, **la création d'une source B dans les tables actuelles reste NO-GO**.

Si cette fermeture exhaustive ne peut pas être démontrée, la seule solution acceptable est l'Option B avec isolation physique/générationnelle et promotion par pointeur atomique.
