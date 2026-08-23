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
| Gateway absent / non conforme | action processing | settle `retry`, sans receipt | n/a | le workflow reste DRAINING ; aucune progression mensongère | `fe295228`; contrat Edge ciblé | PASS structurel |
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

## Bloquants NO-GO

1. Configurer et valider la politique de conservation légale réelle.
2. Exécuter la crash matrix complète hors crash après Auth delete avant l'ack,
   désormais couvert par la reprise cron.
3. Produire les lignes de résultat complètes pour toutes les courses provider,
   source, compte et snapshot demandées par le contrat.
4. Compléter les scénarios runtime du transport stop : crash après l'effet
   gateway avant settle, retry idempotent du gateway déjà drainé, et suppression
   source/compte répétée. L'expiry de lease versus settle est couvert localement ;
   ces effets restent à rejouer avec un gateway contrôlé.

## Pré-requis d'intégration du lot gateway-stop

Les migrations de ce lot supposent que le sous-graphe Phase 3 déjà développé
est présent avant elles, notamment `cloud_provider_transport_stop_actions`,
`cloud_provider_account_delete_preparations` et
`cloud_source_provider_account_affinities`. Ce dernier est fourni par le lot
Phase 3 non commité dans le worktree utilisateur ; il n'a pas été copié dans
cette branche isolée. Le test local a matérialisé la même définition pour
exécuter la course, et l'ordre de cherry-pick devra donc conserver ce prérequis.
