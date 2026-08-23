# Phase 3.2 — rapport de preuve local

Statut : **NO-GO**. Ce document est un état de preuve, pas une approbation de
déploiement. Toutes les exécutions ci-dessous utilisent PostgreSQL local ; aucun
flag de production n'a été activé et aucun déploiement n'a été effectué. Le
seul flag temporaire employé par un fixture isolé de promotion est signalé plus
bas et rétabli à `false` avant le nettoyage du fixture.

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
| Promotion / cancel | candidate classifié | deux sessions | — | CAS candidat/version/HMAC | `94f2c301`; harness provider rejoué localement | PASS sous-graphe provider |
| Swap / rollback | READY_TO_SWITCH | deux sessions | — | génération monotone, worker stale | `94f2c301`; harness provider rejoué localement | PASS sous-graphe provider |
| Snapshot I/U/D | owner snapshot | deux sessions | — | snapshot avant/après writer seulement | harness snapshot existant | PASS |
| Snapshot I/U/D réel | 6 comptes isolés, generation active et baseline owner | deux backends `dblink` : writer-first / activation-first pour INSERT, UPDATE, DELETE | publication ou writer sérialise ; writer-first rejoue `40001` lorsque nécessaire | chaque snapshot contient soit l'écriture commise, soit son absence durable ; aucun troisième état | `catalog_background_owner_snapshot_concurrency_smoke.sql`, 6/6 sur PostgreSQL isolé | PASS isolé |
| Archive légale réelle | politique juridique opérationnelle | configuration contrôlée | — | durée/base légale réellement approuvées | politique non configurée dans le dépôt | PENDING external config |
| Crash après Auth delete avant ack | Auth absent, tombstone CLAIMED | cron reconcile | n/a | tombstone COMPLETED sans second delete | `836c4fa8`; `account_deletion_finalization_concurrency_smoke.sql` | PASS |
| Crash matrix complète | autres points listés dans le contrat | interruption/reprise | — | convergence PostgreSQL seule | non exécuté exhaustivement | PENDING |
| Reaper source x transition | source active / transition active | deux sessions | — | overlap, source fence et reprise reaper | `94f2c301`; harness provider rejoué localement | PASS sous-graphe provider |
| Refresh actif post-swap complet | `COMMITTING`, génération B active, job `post_switch_verify` | refresh → checkpoints bornés → catégories/média/titres/variants → prune/réconciliation → clôture | n/a | aucune écriture sans snapshot/génération active ; prune seulement après la preuve complète | `provider_credential_transition.sql`, 72/72 sur PostgreSQL isolé | PASS isolé |
| Crash/reclaim entre pages refresh | job post-switch, checkpoint page `live_categories` | W2 checkpoint puis requeue durable ; W3 reclaim | W3 = lease 3 ; W2 = `40001 credential_job_lease_changed` | W2 ne peut plus écrire ; W3 reprend le même run et produit le checkpoint 3 | preuve PostgreSQL isolée du 2026-08-23, run `ea9f4135-8511-4767-908e-45989c5ec197` | PASS isolé |

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
| pendant premier sync post-swap | aucun prune destructif avant preuve ; reprise sur checkpoint durable | `provider_credential_transition.sql` 72/72 ; W2 → W3 avec lease 2 → 3 et checkpoint 2 → 3 | PASS isolé |
| avant/après rollback | rollback N+1 vers N+2 ; N et N+1 `STALE` | harness provider Phase 3 | PASS sous-graphe provider |
| pendant drain de suppression | provider permits actifs bloquent la finalisation | `provider_account_delete_concurrency_smoke.sql` | PASS local |
| pendant purge analytics | checkpoint keyset/rollups repris sans double comptage | `account_deletion_paywall_analytics_smoke.sql` | PASS local |
| pendant archive légale | archive/déliage atomiques et replanifiables | `account_deletion_legal_billing_retention_smoke.sql` ; politique runtime absente | PENDING external config |
| pendant purge produit | batch FK borné et reprise vers `READY_TO_FINALIZE` | `account_deletion_product_reaper_smoke.sql` | PASS local |
| après DELETE Auth, avant ack | tombstone CLAIMED devient COMPLETED sans second delete | `account_deletion_finalization_concurrency_smoke.sql` | PASS local |

Les lignes `PENDING` ne peuvent pas être assimilées à une couverture par les
tests voisins. Elles maintiennent le statut **NO-GO**.

## Preuve complémentaire refresh/reclaim 2026-08-23

Le harness `provider_credential_transition.sql` a terminé à **72/72** sur le
PostgreSQL isolé. Il couvre maintenant le chemin post-swap réel : bind du run,
checkpoints avant chaque écriture, writers catégories/média/titres/variants,
prune après réconciliation, preuve durable et état terminal `COMPLETED`.

Une exécution inter-transactions a ensuite simulé une interruption entre deux
pages. W2 a écrit le checkpoint 2 et libéré sa lease (`requeued=true`). W3 a
réclamé le même job avec `lease_sequence=3`, puis a écrit le checkpoint 3. Une
tentative tardive de W2 avec sa séquence 2 a échoué avec SQLSTATE `40001` et la
raison `credential_job_lease_changed`. Cette preuve confirme que la lease
autorise la tentative, tandis que le fence de génération/snapshot et la
séquence durable autorisent le commit.

Cette preuve concerne uniquement l'instance PostgreSQL isolée. Elle ne change
pas le statut de production : le flag provider reste désactivé et la Phase 2
reste bloquée par `global_visibility_epoch_v2_required`.

Après le correctif de FK de purge de la preuve de remplacement, le harness
complet `provider_credential_transition.sql` a été rejoué sur ce même schéma
isolé : **72/72**, suivi de son `ROLLBACK` transactionnel. L'assertion finale
confirme à nouveau que `provider_credential_transition_v1_enabled` est OFF.

Le contrat applicatif de l'adaptateur `norva-account-delete` a aussi été rejoué
localement via `node --test tests/account-deletion-email-delivery.test.js` :
**20/20**. Il confirme notamment que la requête utilisateur persiste la demande
et retourne un état durable, que le cron avance au plus un batch borné avec CAS,
et que le seul `auth.admin.deleteUser()` est dans le finaliseur après son claim
et ses préconditions PostgreSQL — jamais dans le chemin de demande initiale.

Les smokes SQL suivants ont enfin été rejoués consécutivement sur
`norva-phase3-proof-db`, tous avec `ON_ERROR_STOP=1` et sans erreur :

```text
account_deletion_paywall_analytics_smoke.sql
account_deletion_legal_billing_retention_smoke.sql
account_deletion_product_reaper_smoke.sql
account_deletion_finalization_concurrency_smoke.sql
```

Ils confirment respectivement le checkpoint keyset et les rollups sans double
compte, la copie/déliage légal idempotent et la purge à échéance, la purge
produit bornée, puis le claim final concurrent et la reprise après Auth delete
avant acknowledgement. La configuration métier réelle de conservation reste
cependant un prérequis externe distinct : ces fixtures ne peuvent pas la
remplacer.

`provider_account_delete_concurrency_smoke.sql` a également été rejoué sur la
base isolée. Les deux sessions PostgreSQL réelles ont confirmé : le permit
revalidé est refusé après `account_deletion_pending`, le reaper diffère une
source sous transition active, et les reprises W1 → W2 → W3 font passer la
lease/révision à `1/1`, `2/2`, `3/3`. Les tentatives tardives de W1 sur run,
settle et checkpoint retournent toutes `40001`; aucun ancien worker ne peut
committer après reprise.

La matrice `catalog_background_owner_snapshot_concurrency_smoke.sql` a été
rejouée également : les six courses INSERT/UPDATE/DELETE × writer-first /
activation-first ont convergé. Les writers sont soit bloqués derrière
l'activation, soit rejetés `40001` avant leur retry durable; les snapshots
retournent alors exactement 0 ou 1 titre suivant le DELETE ou INSERT, et le
UPDATE expose toujours le titre V2. Aucun état intermédiaire n'a été observé.

## Matrice deux-sessions rejouée 2026-08-23

Les harnesses ont été rendus portables entre une installation `dblink` dans le
schéma `public` et une installation dans `extensions`: les appels de test
résolvent désormais les fonctions `dblink_*` via le `search_path`, sans modifier
la machine de production.

`catalog_background_owner_snapshot_concurrency_smoke.sql` a passé les six
courses suivantes sur PostgreSQL isolé : INSERT, UPDATE et DELETE, chacun avec
`writer_first` et `activation_first`. Les courses writer-first ont soit observé
la sérialisation puis inclus l'écriture, soit reçu `40001` avant retry durable;
les courses activation-first ont observé le writer bloqué derrière l'activation.
Le tableau final contient six snapshots actifs, les epochs finals attendus et
aucun membership résurrecté.

`provider_account_delete_concurrency_smoke.sql` a aussi passé dans le même
environnement : suppression compte contre writer, permit contre begin,
transition contre reaper, rollback de reaper, et reclaim W1 → W2 → W3. Dans le
dernier scénario, les opérations tardives de W1 (run, settle et checkpoint) ont
toutes retourné SQLSTATE `40001`; W3 a laissé un état durable `dead`, révision
4, sans lease active. Ces résultats sont des preuves d'absence de double
autorité, pas une activation de flag ou un déploiement.

## Correctif de purge de génération 2026-08-23

La reprise d'un fixture post-swap a détecté que le reaper account-delete ne
pouvait pas effacer les projections de titres d'une génération `READY`: le
trigger de révision de génération refusait le batch, même lorsque le worker de
suppression détenait la lease durable. La migration
`20260823193000_account_delete_generation_revision_guard.sql` traite ce seul
cas : l'exception est limitée à un `DELETE` dont les lignes appartiennent au
compte porteur d'un contexte account-delete encore valide. Les writers, les
seals et les purges hors workflow restent strictement refusés.

Le fixture a ensuite convergé par le protocole réel `begin → stop → drain →
analytics → product purge → finalization`, et l'utilisateur de fixture a été
confirmé absent. Enfin, `provider_credential_transition.sql` a été rejoué sur
le schéma déjà contracté et s'est terminé à **72/72**. Son assertion historique
sur l'ancienne unicité est désormais explicitement portée par le test de
migration online ; le harness Phase 3.2 vérifie à la place que cette contrainte
historique est bien absente, ce qui le rend réexécutable sur une base modernisée.

## Consolidation PostgreSQL 2026-08-23

Les huit smokes suivants ont été rejoués consécutivement sur
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

## Course de promotion de remplacement et purge 2026-08-23

Une transition de remplacement réelle a été amenée jusqu'à
`READY_TO_SWITCH` dans `norva-phase3-proof-db`, puis deux sessions PostgreSQL
ont appelé `norva_promote_source_replacement_v2` simultanément avec les mêmes
CAS de source (`0`), transition (`3`) et tête candidate (`0`). Une seule a
produit `COMPLETED`, avec une tête candidate `0 → 1`. L'autre a été refusée
après la clôture parce que ses entrées de promotion ne correspondaient plus au
replay terminal : elle n'a effectué aucune écriture supplémentaire.

L'état durable observé après la course était `transition=completed`, ancienne
source `replaced/hidden`, candidate `active/visible`, et une seule preuve v2
liant la génération candidate à la révision `0 → 1`.

Cette preuve a révélé un défaut du chemin de suppression de compte : sa FK
`RESTRICT` vers la génération candidate empêchait le reaper borné de supprimer
la génération. La migration
`20260823194000_replacement_promotion_proof_account_delete.sql` remplace cette
FK par `ON DELETE CASCADE`. Après application sur la base isolée, le même
workflow réel de suppression (`begin → stop → drain → purges → finalisation`)
a convergé : l'utilisateur fixture et sa preuve v2 étaient tous deux absents,
et le flag temporaire de remplacement de la base isolée a été rétabli à
`false`.

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

## Audit epoch cache global v2

Le garde SQL `norva_provider_access_flag_visibility_changed` bloque toute
activation de `provider_access_visibility_v1_enabled` avec
`global_visibility_epoch_v2_required`. Cette décision reste correcte : les
caches client et Edge actuels sont seulement scellés par
`cloud_user_catalog_visibility_epochs` (scope utilisateur). Le dépôt ne
contient ni table, ni RPC, ni contrat de réponse, ni test de cohérence nommé
« global cache epoch v2 ». Les caches `catalog_titles` globaux ne peuvent donc
pas être assimilés à ce contrat sur la base de leur nom ou de leur existence.

Avant toute proposition de levée du garde, il faut spécifier et prouver : la
source d'autorité globale, les lecteurs/écrivains concernés, la monotonie, les
clés de cache affectées, les invalidations lors d'un changement de visibilité,
la compatibilité des clients pendant rollout et les courses deux-sessions. En
l'absence de ces éléments, retirer ou contourner le garde serait une régression
de sécurité ; aucun flag n'a été modifié.

## État exact du lot 82782/82783

Les fichiers présents confirment la chaîne locale suivante :

```text
82780–82783  schéma, fonctions, guards et contrat provider/account-delete
82784        adaptateur durable `norva_begin_account_deletion_workflow`
82785–82789  purge analytics, archive légale, orchestrateur, reaper produit,
             puis finalisation Auth
```

`82782` et `82783` ne constituent donc pas une activation autonome : ils restent
indissociables de l'adaptateur et des purges durables qui suivent. Le flag
`provider_access_visibility_v1_enabled` est encore refusé par la migration
foundation avec `reason=global_visibility_epoch_v2_required`; aucune migration
de ce lot ne contourne ce garde et aucun flag n'a été activé.

Le harness historique `provider_access_lifecycle.sql` ne peut pas être rejoué
sur l'instance isolée déjà `contracted` : ses seeds raw sont volontairement
refusés par `norva_catalog_generation_write_guard` avant les assertions de
migration. Ce refus est correct; adapter le test avec un bypass rendrait la
preuve invalide. Sa validation doit être exécutée sur une base reconstruite à
l'étape pré-contraction, en plus des harnesses post-contraction déjà verts.

## Pré-requis d'intégration du lot gateway-stop

Les migrations de ce lot supposent que le sous-graphe Phase 3 déjà développé
est présent avant elles, notamment `cloud_provider_transport_stop_actions`,
`cloud_provider_account_delete_preparations` et
`cloud_source_provider_account_affinities`. Ce dernier est fourni par le lot
Phase 3 non commité dans le worktree utilisateur ; il n'a pas été copié dans
cette branche isolée. Le test local a matérialisé la même définition pour
exécuter la course, et l'ordre de cherry-pick devra donc conserver ce prérequis.
