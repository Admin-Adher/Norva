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

## Bloquants NO-GO

1. Configurer et valider la politique de conservation légale réelle.
2. Exécuter la crash matrix complète hors crash après Auth delete avant l'ack,
   désormais couvert par la reprise cron.
3. Produire les lignes de résultat complètes pour toutes les courses provider,
   source, compte et snapshot demandées par le contrat.
4. Relier l'exécuteur versionné du **transport stop** à son protocole
   `claim/receipt`. Le runner account-delete ne peut volontairement pas
   synthétiser ce reçu ni lancer un appel fournisseur ; sans reçu, le workflow
   reste correctement bloqué en `DRAINING`.
