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
| Retry gateway déjà drainé | endpoint gateway isolé, aucune session active | deux POST identiques avec le même hash opaque | deux réponses `providerDrained=true`, protocole 1 | un retry après arrêt ne ressuscite aucun transport ni ne rend un reçu incompatible | gateway local port 18111, processus arrêté après preuve | PASS local |
| Suppression compte répétée | compte actif, préparation/action absentes | deux appels `norva_begin_account_deletion_workflow` | n/a | une préparation, une action transport et un epoch unique ; le second appel est une reprise | `account_deletion_transport_stop_concurrency_smoke.sql` | PASS local |
| Gateway absent / non conforme / indisponible | action processing | settle `retry` CAS, sans receipt | `STALE` si la lease a changé | le workflow reste DRAINING ; aucun retry ne dépend de l'expiration seule | adaptateur Edge ; test ciblé `account-deletion-transport-stop-edge.test.js` | PASS contrat |
| Purge analytics | provider ready, deux raws | deux batches keyset | n/a | rollups anonymes exacts, raws absents | `account_deletion_paywall_analytics_smoke.sql` | PASS |
| Archive légale | workflow ARCHIVING_LEGAL | archive idempotente sous politique | n/a | aucune FK Auth/identifiant produit | `5f1ce722`; contrôle catalogue local | PASS structurel |
| Purge produit | workflow PURGING_PRODUCT | relation FK puis batch | n/a | aucune FK publique directe résiduelle avant READY | `account_deletion_product_reaper_smoke.sql` | PASS |
| Delete Auth final | READY_TO_FINALIZE | claim, delete Auth, ack | n/a | guard revalide provider + produit; tombstone completed | `account_deletion_finalization_smoke.sql` | PASS |
| Double finalisation + crash ack | READY_TO_FINALIZE | deux connexions dblink; Auth delete sans ack; cron reconcile | un claim; un no-op | tombstone CLAIMED puis COMPLETED, aucune fixture résiduelle | `836c4fa8`; `account_deletion_finalization_concurrency_smoke.sql` | PASS |
| Promotion / cancel | candidate classifié | deux sessions | — | CAS candidat/version/HMAC | `94f2c301`; harness provider rejoué localement | PASS sous-graphe provider |
| Swap / rollback | READY_TO_SWITCH | deux sessions | — | génération monotone, worker stale | `94f2c301`; harness provider rejoué localement | PASS sous-graphe provider |
| Snapshot I/U/D | owner snapshot | deux sessions | — | snapshot avant/après writer seulement | harness snapshot existant | PASS |
| Archive légale réelle | politique juridique opérationnelle | configuration contrôlée | — | durée/base légale réellement approuvées | politique non configurée dans le dépôt | PENDING external config |
| Crash après Auth delete avant ack | Auth absent, tombstone CLAIMED | cron reconcile | n/a | tombstone COMPLETED sans second delete | `836c4fa8`; `account_deletion_finalization_concurrency_smoke.sql` | PASS |
| Crash matrix complète | autres points listés dans le contrat | interruption/reprise | — | convergence PostgreSQL seule | non exécuté exhaustivement | PENDING |
| Reaper source x transition | source active / transition active | deux sessions | — | overlap, source fence et reprise reaper | `94f2c301`; harness provider rejoué localement | PASS sous-graphe provider |

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
| après stop gateway, avant settle | action reste `processing`, retry stop idempotent puis settle unique | retry gateway local et reclaim SQL prouvés séparément ; crash Edge non injecté | PENDING |
| avant/après `READY_TO_SWITCH` | candidate version/HMAC et transition déterminent la reprise | harness provider Phase 3 | PASS sous-graphe provider |
| avant/après COMMIT swap | génération N/N+1 et état transition déterminent l'unique continuation | harness provider Phase 3 | PASS sous-graphe provider |
| pendant premier sync post-swap | aucun prune destructif avant preuve | contrat provider ; injection exhaustive non enregistrée | PENDING |
| avant/après rollback | rollback N+1 vers N+2 ; N et N+1 `STALE` | harness provider Phase 3 | PASS sous-graphe provider |
| pendant drain de suppression | provider permits actifs bloquent la finalisation | `provider_account_delete_concurrency_smoke.sql` | PASS local |
| pendant purge analytics | checkpoint keyset/rollups repris sans double comptage | `account_deletion_paywall_analytics_smoke.sql` | PASS local |
| pendant archive légale | archive idempotente et minimale | test structurel, politique runtime absente | PENDING external config |
| pendant purge produit | batch FK borné et reprise vers `READY_TO_FINALIZE` | `account_deletion_product_reaper_smoke.sql` | PASS local |
| après DELETE Auth, avant ack | tombstone CLAIMED devient COMPLETED sans second delete | `account_deletion_finalization_concurrency_smoke.sql` | PASS local |

Les lignes `PENDING` ne peuvent pas être assimilées à une couverture par les
tests voisins. Elles maintiennent le statut **NO-GO**.

## Bloquants NO-GO

1. Configurer et valider la politique de conservation légale réelle.
2. Exécuter la crash matrix complète hors crash après Auth delete avant l'ack,
   désormais couvert par la reprise cron.
3. Produire les lignes de résultat complètes pour toutes les courses provider,
   source, compte et snapshot demandées par le contrat.
4. Compléter les scénarios runtime du transport stop : crash après l'effet
   gateway avant settle (le retry endpoint est idempotent, mais le crash Edge
   complet n'est pas encore injecté) et suppression source/compte répétée.
   L'expiry de lease versus settle est couvert localement.

## Pré-requis d'intégration du lot gateway-stop

Les migrations de ce lot supposent que le sous-graphe Phase 3 déjà développé
est présent avant elles, notamment `cloud_provider_transport_stop_actions`,
`cloud_provider_account_delete_preparations` et
`cloud_source_provider_account_affinities`. Ce dernier est fourni par le lot
Phase 3 non commité dans le worktree utilisateur ; il n'a pas été copié dans
cette branche isolée. Le test local a matérialisé la même définition pour
exécuter la course, et l'ordre de cherry-pick devra donc conserver ce prérequis.
