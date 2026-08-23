# Phase 3.2 — rapport de preuve local

Statut : **NO-GO**. Ce document est un état de preuve, pas une approbation de
déploiement. Toutes les exécutions ci-dessous utilisent PostgreSQL local ; aucun
flag provider n'a été activé et aucun déploiement n'a été effectué.

| Scenario | Initial state | Sessions / action | Winner / loser | Final invariant | Evidence | Status |
|---|---|---|---|---|---|---|
| Index historique projection | index quatre clés homonyme | renommage conservateur + création concurrente | n/a | index canonique cinq clés, ancien préservé | `993118a6`; trois formes exécutées localement | PASS |
| Demande de suppression | compte Auth actif | Edge appelle `norva_begin_account_deletion_workflow` | n/a | réponse 202, aucun delete Auth inline | `15acc3a0`; `account-deletion-email-delivery.test.js` | PASS |
| Runner durable borné | workflow persistant non terminal | cron claim → advance CAS → un batch de purge au plus | CAS obsolète = no-op | aucune progression ne dépend de l'isolate Edge | `21adfc88`; migration `82791`; test Node 20/20 | PASS local |
| Course scheduler durable | workflow `PURGING_PRODUCT` | deux connexions `dblink`, A garde son verrou, B claim | A = révision 1 ; B = aucune ligne | `SKIP LOCKED` interdit une seconde autorité de batch ; teardown par finalizer gardé | `c9a6c217`; `account_deletion_workflow_claim_concurrency_smoke.sql` | PASS local |
| Crash après claim scheduler | claim durable sans RPC suivante | B reclaim la révision supérieure ; A reprend tardivement | A = `40001 STALE`; B continue | aucune reprise ne dépend d'une lease ou mémoire du premier worker | `598ed2d9`; `account_deletion_workflow_claim_smoke.sql` | PASS local |
| Transport stop normal | workflow DRAINING, action pending | claim → revalidation durable → gateway opaque → receipt → settle CAS | un seul owner | le gateway ne reçoit que des hashes d'affinité ; aucun passage à READY sans preuve SQL | `3466e56b`, `e2290280`, `fe295228` | PASS contrat/local |
| Claim transport concurrent | action transport pending | deux sessions PostgreSQL réelles, A claim puis B claim | A = processing ; B = `40001 STALE` | B ne reçoit aucune autorité pour appeler le gateway | `c6af7799`; `account_deletion_transport_stop_concurrency_smoke.sql` | PASS local |
| Fence juste avant gateway | action A processing puis workflow bump | A revalide ; changement durable d'état ; A revalide tardivement | A tardif = `40001 STALE` | epoch, état, lease owner/séquence, révision et expiration sont vérifiés avant tout `fetch` | migration `20260823182793`; test SQL deux sessions + Node 4/4 | PASS local |
| Crash après claim transport | A claim, puis lease expirée dans une transaction commitée | B reprend depuis PostgreSQL ; A tente un settle tardif | B = nouvelle leaseSequence/révision ; A = `40001 STALE` | aucune mémoire ni lease A ne peut compléter l'action ; B revalide et settle seul | `account_deletion_transport_stop_concurrency_smoke.sql` | PASS local |
| Crash Deno après stop gateway | worker Deno A, stop gateway accepté, aucune écriture settle | A est tué ; B réclame lease/révision 2, refait le stop et settle | A = aucun settle ; B = unique settle | l'effet externe peut être rejoué sans résurrection ; seul le worker récupéré commit | `account_deletion_transport_stop_crash_runtime_test.ts`, deux exécutions | PASS local runtime |
| Retry gateway déjà drainé | endpoint gateway isolé, aucune session active | deux POST identiques avec le même hash opaque | deux réponses `providerDrained=true`, protocole 1 | un retry après arrêt ne ressuscite aucun transport ni ne rend un reçu incompatible | gateway local port 18111, processus arrêté après preuve | PASS local |
| Frontière gateway opaque | gateway isolé | sans bearer ; hash invalide ; stop valide | 401 ; 400 ; 200 | aucune URL, credential ou action destructive non authentifiée ne traverse la route | gateway local port 18111, processus arrêté après preuve | PASS local |
| Suppression compte répétée | compte actif, préparation/action absentes | deux appels `norva_begin_account_deletion_workflow` | n/a | une préparation, une action transport et un epoch unique ; le second appel est une reprise | `account_deletion_transport_stop_concurrency_smoke.sql` | PASS local |
| Stop transport ↔ suppression source | action claimée avec une affinité, puis ligne source supprimée | revalidation après suppression de l'affinité vivante | n/a | le scope opaque snapshoté avec l'epoch reste inchangé ; aucun reçu vide ne contourne le gateway | migration `20260823182794`; smoke transport | PASS local |
| Reaper ↔ transport stop non terminé | workflow `stopping`, action transport `pending` | advance/reaper avant le stop | n/a | le workflow reste `draining` avec `nextAction=provider_drain`, sans atteindre une purge | `account_deletion_transport_stop_concurrency_smoke.sql` | PASS local |
| Gateway absent / non conforme / indisponible | action processing | settle `retry` CAS, sans receipt | `STALE` si la lease a changé | le workflow reste DRAINING ; aucun retry ne dépend de l'expiration seule | adaptateur Edge ; test ciblé `account-deletion-transport-stop-edge.test.js` | PASS contrat |
| Purge analytics | provider ready, deux raws | deux batches keyset | n/a | rollups anonymes exacts, raws absents | `account_deletion_paywall_analytics_smoke.sql` | PASS |
| Archive légale fail-closed + batch | ledger non vide, politique absente puis fixture | refus `55000`, copie/déliage premier batch, reprise | n/a | aucune progression sans politique ; `INSERT ... RETURNING` lie la copie au déliage sans retry intermédiaire | migration `20260823182796`; `account_deletion_legal_billing_retention_smoke.sql` | PASS local |
| Purge archive légale échue | archive expirée + archive encore retenue | deux reapers séquentiels bornés | premier supprime 1 ; second 0 | seul `retention_until <= now()` est purgé, reprise idempotente | migration `20260823182795`; `account_deletion_legal_billing_retention_smoke.sql` | PASS local |
| Purge produit | workflow PURGING_PRODUCT | relation FK puis batch | n/a | aucune FK publique directe résiduelle avant READY | `account_deletion_product_reaper_smoke.sql` | PASS |
| Delete Auth final | READY_TO_FINALIZE | claim, delete Auth, ack | n/a | guard revalide provider + produit; tombstone completed | `account_deletion_finalization_smoke.sql` | PASS |
| Double finalisation + crash ack | READY_TO_FINALIZE | deux connexions dblink; Auth delete sans ack; cron reconcile | un claim; un no-op | tombstone CLAIMED puis COMPLETED, aucune fixture résiduelle | `836c4fa8`; `account_deletion_finalization_concurrency_smoke.sql` | PASS |
| Permit ↔ suppression compte | permit direct fallback / compte actif | deux sessions dans les deux ordres | permit-first puis `begin`, ou `begin` puis permit refusé | aucune capacité ne subsiste ; revalidation après begin = `account_deletion_pending` | `provider_account_delete_concurrency_smoke.sql`, SHA-256 `D35C3FC2…1E7C`, replay 2026-08-23 | PASS local |
| Promotion / cancel | candidate classifié | deux sessions | — | CAS candidat/version/HMAC | le smoke `provider_credential_transition.sql` n'est pas vert sur une base de provenance cohérente | PENDING |
| Swap / rollback | READY_TO_SWITCH | deux sessions | — | génération monotone, worker stale | le smoke `provider_credential_transition.sql` n'est pas vert sur une base de provenance cohérente | PENDING |
| Snapshot I/U/D | owner snapshot | deux sessions | — | snapshot avant/après writer seulement | course atteinte, mais teardown Auth historique refusé par le guard durable | PENDING fixture |
| Archive légale réelle | politique juridique opérationnelle | configuration contrôlée | — | durée/base légale réellement approuvées | politique non configurée dans le dépôt | PENDING external config |
| Crash après Auth delete avant ack | Auth absent, tombstone CLAIMED | cron reconcile | n/a | tombstone COMPLETED sans second delete | `836c4fa8`; `account_deletion_finalization_concurrency_smoke.sql` | PASS |
| Crash matrix complète | autres points listés dans le contrat | interruption/reprise | — | convergence PostgreSQL seule | non exécuté exhaustivement | PENDING |
| Reaper source x transition | source active / transition active | deux sessions dblink, dans les deux ordres | source verrouillée puis concurrent bloqué ; perdant = `55000` | overlap observé, aucune transition créée après fence ; rollback reaper libère le verrou | `provider_account_delete_concurrency_smoke.sql`, SHA-256 `D35C3FC2…1E7C`, replay 2026-08-23 | PASS local |

## Invariants actuellement matérialisés

- La lease permet d'essayer ; le CAS génération/état autorise les écritures.
- Les raws paywall sont agrégés puis supprimés dans une transaction keyset.
- La finalisation Auth exige `FINALIZING`, une lease de finalisation valide,
  la preuve provider et l'absence recalculée de résidu produit.
- Le tombstone de finalisation ne possède pas de FK ni d'UUID utilisateur : il
  permet de reprendre l'ack après l'absence Auth sans réémettre le delete.
- Le cron ne possède pas d'autorité implicite : il réclame une révision, appelle
  une RPC CAS, puis exécute au plus un batch analytics ou produit. Une collision
  `40001` est `STALE/no-op`.
- Le stop gateway est un effet externe opaque : le claim est revalidé dans
  PostgreSQL juste avant le `fetch`, sur l'epoch, l'état DRAINING, le propriétaire
  de lease, sa séquence, la révision et son expiration. Un `40001` interdit
  l'appel au gateway. Le settle réutilise les mêmes fences et exige l'absence de
  capability active avant de produire le reçu durable.

## Crash matrix — état exact de la preuve

| Frontière | Reprise attendue depuis PostgreSQL | Évidence actuelle | État |
|---|---|---|---|
| après claim scheduler | nouvelle révision, ancien runner `STALE` | `account_deletion_workflow_claim_smoke.sql` | PASS local |
| après claim transport | lease expirée, nouvelle séquence/révision, ancien settle refusé | `account_deletion_transport_stop_concurrency_smoke.sql` | PASS local |
| après stop gateway, avant settle | action reste `processing`, retry stop idempotent puis settle unique | processus Deno A tué après réponse gateway ; B lease/révision 2 refait le stop et settle seul | PASS local runtime |
| reaper pendant transport stop pending | le reaper conserve `DRAINING` et redemande `provider_drain` | `account_deletion_transport_stop_concurrency_smoke.sql` | PASS local |
| avant/après `READY_TO_SWITCH` | candidate version/HMAC et transition déterminent la reprise | harness provider Phase 3 | PASS sous-graphe provider |
| avant/après COMMIT swap | génération N/N+1 et état transition déterminent l'unique continuation | harness provider Phase 3 | PASS sous-graphe provider |
| pendant premier sync post-swap | aucun prune destructif avant preuve | contrat provider ; injection exhaustive non enregistrée | PENDING |
| avant/après rollback | rollback N+1 vers N+2 ; N et N+1 `STALE` | harness provider Phase 3 | PASS sous-graphe provider |
| pendant drain de suppression | provider permits actifs bloquent la finalisation | `provider_account_delete_concurrency_smoke.sql` | PASS local |
| pendant purge analytics | checkpoint keyset/rollups repris sans double comptage | `account_deletion_paywall_analytics_smoke.sql` | PASS local |
| pendant archive légale | archive/déliage atomiques et replanifiables | `account_deletion_legal_billing_retention_smoke.sql` ; politique runtime absente | PENDING external config |
| pendant purge produit | batch FK borné et reprise vers `READY_TO_FINALIZE` | `account_deletion_product_reaper_smoke.sql` | PASS local |
| après DELETE Auth, avant ack | tombstone CLAIMED devient COMPLETED sans second delete | `account_deletion_finalization_concurrency_smoke.sql` | PASS local |

Les lignes `PENDING` ne peuvent pas être assimilées à une couverture par les
tests voisins. Elles maintiennent le statut **NO-GO**.

## Consolidation PostgreSQL 2026-08-23

Les neuf smokes suivants ont été rejoués consécutivement sur
`norva_phase3_owner_matrix_0823` et se sont tous terminés avec succès :

```text
account_deletion_workflow_claim_smoke.sql
account_deletion_workflow_claim_concurrency_smoke.sql
account_deletion_product_reaper_smoke.sql
account_deletion_finalization_smoke.sql
account_deletion_finalization_concurrency_smoke.sql
account_deletion_paywall_analytics_smoke.sql
provider_account_delete_concurrency_smoke.sql
account_deletion_transport_stop_concurrency_smoke.sql
account_deletion_legal_billing_retention_smoke.sql
```

Le harness actuel `provider_account_delete_concurrency_smoke.sql` a de nouveau
été rejoué avec succès le 23 août (SHA-256 `D35C3FC2…1E7C`) : helpers,
triggers, tables de fixture et connexions dblink étaient ensuite tous à zéro.
Le dernier smoke a été exécuté une seconde fois avec succès après son correctif
de teardown (`0890f113`), ce qui prouve aussi sa reprise de fixture. Les
avertissements `Norva signup Telegram immediate wake failed (SQLSTATE 42P01)`
proviennent de l'infrastructure locale absente du fixture ; aucun script n'a
échoué ni continué après une erreur.

Le test Deno `account_deletion_transport_stop_crash_runtime_test.ts` a aussi été
exécuté deux fois avec Deno portable 2.9.5. Il lance la routine TypeScript réelle
dans un processus enfant isolé, tue A dès que le gateway local confirme le stop,
puis vérifie que B seul settle la reprise. Les clés, URL et RPC sont des fixtures
locales ; aucun Edge, provider ou secret de production n'est appelé.

## Rejeu lecture seule des courses utilisateur

`catalog_background_owner_snapshot_concurrency_smoke.sql` a été rejoué depuis
le worktree utilisateur sans modifier ce worktree. Les six courses
INSERT/UPDATE/DELETE × writer-first/activation-first ont atteint leur phase de
course, mais le script n'est **pas vert** : son teardown historique exécute
`DELETE FROM auth.users` directement à la ligne 681. Le guard durable le refuse
avec `account_deletion_not_ready_to_finalize`. Ceci est une incompatibilité de
fixture, non une preuve de snapshot valide : elle doit être corrigée dans le
troisième worktree d'intégration, après toutes les assertions, par le même
bypass de teardown explicitement limité (`session_replication_role=replica`)
que les autres smokes de fixtures. Aucune donnée ou test utilisateur n'a été
modifié ici.

Le smoke `provider_credential_transition.sql` ne peut pas être exécuté sur la
même base locale : il demande
`norva_create_credential_transition(..., text)` à neuf paramètres, tandis que
PostgreSQL ne possède que l'ancienne surcharge à huit paramètres. La table
`cloud_source_direct_fallback_leases` est déjà présente mais les routines
d'affinité correspondantes et l'entrée `20260823174000` de l'historique local
sont absentes. La base est donc partiellement migrée ; cette preuve provider est
**PENDING**, et il serait dangereux de rejouer une migration utilisateur non
idempotente par fragments pour la faire passer. Le troisième worktree doit
appliquer le graphe Phase 3 complet à une base de test propre avant ce smoke.

Une autre base locale (`norva_phase3_fullproof_0823`) possède la signature v9,
mais ne valide pas non plus ce smoke : les assertions pgTAP 7, 15 et 22 échouent
(projection terminale, échantillon d'identité borné, rollup variant), puis le
guard refuse l'activation avec
`provider_account_affinity_backfill_incomplete`. Cette base est donc elle aussi
un état de migration antérieur/incomplet, et confirme que la couverture
promotion/swap/rollback reste **PENDING**, sans masquer les défauts par un flag
ou un backfill forcé.

Un clone temporaire de cette base a confirmé que la parité ne peut pas être
réparée en rejouant un seul fichier :
`20260823180000_provider_catalog_generation_online_rollout.sql` rollback sur
`cloud_catalog_generation_contract_indexes already exists`, alors que cette
relation n'a pas l'historique de migration attendu. Le clone sans connexion a
été supprimé juste après l'essai. Il faut une base provisionnée depuis une
chaîne de migrations cohérente, non un patch d'objets déjà présents.

## Réparation de l'index historique de projection

La migration indépendante
`20260823121950_cloud_titles_projection_selector_index_online.sql` a été
exécutée contre deux clones PostgreSQL jetables de
`norva_phase3_durable_compile`, avec les six flags provider toujours à `false`.

| Forme initiale | Résultat constaté | Statut |
|---|---|---|
| index historique `idx_cloud_titles_projection_verified` à quatre clés `(user_id,item_type,synced_at DESC,updated_at DESC)` et prédicat `provider_verified` | renommé en `idx_cloud_titles_projection_verified_legacy_without_id`, puis création concurrente de l'index canonique à cinq clés, avec `id` terminal ; second passage idempotent | PASS |
| même nom mais prédicat volontairement erroné `match_status='manual'` | arrêt fail-closed : `title projection selector index homonym has wrong shape` | PASS |

Les définitions ont été vérifiées dans `pg_indexes`, pas seulement par nom. Les
deux clones ont été contrôlés sans connexion puis supprimés. Cette migration
préserve donc l'index vivant historique et prouve bien la forme finale exacte ;
elle ne rend pas pour autant le graphe provider complet vert.

Le 23 août, une reconstruction supplémentaire
`norva_phase3_provider_validation_0823` depuis le snapshot local
`durable_compile` a appliqué, sans flag activé, les prérequis d'affinité
(`72800` à `74000`), de génération (`79800` à `80000`), de projection titre
(`22000` à `22040`) et de seal (`22100` à `22120`). Elle fait passer les
assertions 10 et 15, mais conserve des versions antérieures sous les mêmes
signatures SQL : le gate V3 constate que
`norva_claim_credential_transition_jobs(text,integer,integer,text)` et
`norva_begin_credential_swap(...,text,text)` n'ont pas les corps attendus.
`82800_active_catalog_refresh_worker_v3_gate.sql` refuse donc avec
`active catalog refresh worker v3 gate drift`. C'est une preuve négative de
provenance : ne pas la contourner par une capability artificielle. Une base
vierge appliquant le graphe versionné complet, avec historique fiable, reste
nécessaire avant les courses provider finales.

Une tentative de reconstruction intégrale depuis une base locale nouvellement
créée a aussi échoué dès `001_ecosystem.sql` : ce serveur crée ses bases depuis
un `template1` déjà partiellement peuplé (relations `hubs`, `pair_requests`,
etc.) mais sans la publication `supabase_realtime` exigée par cette migration.
La base temporaire `norva_phase3_fresh_0823`, vérifiée sans connexion, a été
supprimée. Le prochain essai doit donc partir d'un bootstrap Supabase cohérent
(rôles, schémas et publication), et non du `template1` local contaminé.

## Suite JavaScript consolidée

Exécution locale : `node --test tests/*.test.js` avec les dépendances locales
déjà disponibles. Résultat : **2371 passés, 2 ignorés, 1 échec**, en 26,7 s.

L'échec est hors périmètre gateway/account-delete :
`norva-partners-revolut-payout.test.js` attend un JSON de son helper sandbox,
mais Node 24 renvoie une chaîne `node:internal…` que le test tente de parser.
Le même lancement valide les contrats account-delete, transport stop et le test
historique `media-gateway-mkv-bounded-reconnect` après correction de sa
frontière d'extraction. Cet échec externe ne transforme toutefois pas la suite
complète en verte et le statut global reste **NO-GO**.

## Bloquants NO-GO

1. Configurer et valider la politique de conservation légale réelle.
2. Exécuter la crash matrix complète hors crash après Auth delete avant l'ack,
   désormais couvert par la reprise cron.
3. Produire les lignes de résultat complètes pour toutes les courses provider,
   source, compte et snapshot demandées par le contrat.
4. Compléter les autres points de la crash matrix provider, notamment le premier
   sync post-swap sans prune destructif. Le crash runtime transport après gateway
   est couvert, ainsi que l'expiry de lease versus settle, la suppression source
   post-claim et la suppression compte répétée.
5. Adapter le teardown historique de
   `catalog_background_owner_snapshot_concurrency_smoke.sql` avant de considérer
   ses six courses snapshot comme une preuve finale verte.
6. Reconstituer une base PostgreSQL de test avec le graphe provider Phase 3
   complet (dont `20260823174000`) avant de rejouer
   `provider_credential_transition.sql` et ses courses promotion/swap/rollback.
   Les bases partielles actuelles ne sont pas une substitution :
   `norva_phase3_fullproof_0823` échoue déjà des assertions de contrat et le
   guard de backfill.

## Pré-requis d'intégration du lot gateway-stop

Les migrations de ce lot supposent que le sous-graphe Phase 3 déjà développé
est présent avant elles, notamment `cloud_provider_transport_stop_actions`,
`cloud_provider_account_delete_preparations` et
`cloud_source_provider_account_affinities`. Ce dernier est fourni par le lot
Phase 3 non commité dans le worktree utilisateur ; il n'a pas été copié dans
cette branche isolée. Le test local a matérialisé la même définition pour
exécuter la course, et l'ordre de cherry-pick devra donc conserver ce prérequis.
