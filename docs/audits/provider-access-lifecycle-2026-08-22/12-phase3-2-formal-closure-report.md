# Phase 3.2 — Formal closure report

Date: 2026-08-24

Status: `PHASE_3_2_FORMALLY_CLOSED`

This report closes the durable PostgreSQL core only. It does not authorize the
Provider Access visibility flag, a public Edge v3 endpoint, a production
migration, or production traffic. Those rollout gates remain independent.

## Reproducible source boundary

- historical and migration baseline: `e49ae6a5bc4e825774cbfa60061cf1696df33cfd`;
- concurrency and transaction-crash harness commit:
  `020c8ea7f6c350f009df2dd60fc1462c9ec7c567`;
- durable finalization smoke alignment commit:
  `5e97d528fb512745e23b52aa0b0bc87a673b6b99`;
- PostgreSQL image: `supabase/postgres:17.6.1.136`;
- proof container label: `norva.phase3.proof=true`, run `a` or `b`;
- production data, credentials, endpoints and feature flags: not used;
- Provider Access flags: OFF throughout the proof.

The SQL bytes executed on the proof host were SHA-256 checked against the
workspace before the final runs. Candidate binding HMACs remain server-only and
are deliberately absent from logs; the tests use the production RPCs that CAS
the persisted candidate version and binding.

## Mandatory two-session races

| Scenario | Winner | Loser | Generation/head | Final invariant | Result |
| --- | --- | --- | --- | --- | --- |
| promotion ↔ cancel, cancel first | cancel | promotion `40001` | `0 → 0` | cancelled; no swap job/action | PASS |
| promotion ↔ cancel, promotion first | promotion | cancel `40001` | `0 → 1` | committing cannot return to cancelled | PASS |
| swap ↔ deletion, deletion first | deletion | swap `40001`, `reason=provider_account_delete_preparing` | `0 → 0` | no config/head change, job, action or permit | PASS |
| swap ↔ deletion, swap first | swap | deletion observes committed N+1 | `0 → 1` | exactly one post-switch job and swap action | PASS |
| rollback ↔ deletion, deletion first | deletion | rollback `40001` | `1 → 1` | candidate remains active; no rollback job | PASS |
| rollback ↔ deletion, rollback first | rollback | deletion observes committed N+2 | `1 → 2` | post job dead, one rollback job, N+1 stale | PASS |

Authoritative artifacts and SHA-256:

- `promotion-cancel-final-cancel-wins-a.txt` — `da77ab98cf84421dd7f4689dac3192d8bec457717e24939fe00e12ed4d90dda8`;
- `promotion-cancel-final-promotion-wins-b.txt` — `07709a4018bf971ca44ff8712019733ef78e8478e291302960633f8b9b46af91`;
- `swap-delete-final-deletion-wins-a.txt` — `ea680abca681ff5d87f394c349483c7eed77da005e634949d876f5132d8dd5ee`;
- `swap-delete-final-swap-wins-b.txt` — `9683265bc9da492e3fd96cfd4adb795ef36540563a3835e8d4d85e8d526d5c56`;
- `rollback-delete-final-deletion-wins-a.txt` — `396d2c635afdd8291b3e00cbad53591785d6304a7c547f6f9f311144a4e51cec`;
- `rollback-delete-final-rollback-wins-b.txt` — `0ba88fa6eb9b658482415b521e4e946e6308cac01e9e6cc8505d73384b7b77b9`.

## Transaction crash matrix

Real PostgreSQL backends were terminated while production RPCs were paused
inside their transaction. Restart entered only through durable RPCs.

| Boundary | State before commit kill | State reconstructed after restart | Result |
| --- | --- | --- | --- |
| READY | `IMPORTING`, no readiness owner | `READY_TO_SWITCH`, one durable readiness snapshot | PASS |
| swap | config/head `0/0`, no continuation | config/head `1/1`, one job and one action | PASS |
| rollback | config/head `1/1`, N+1 job processing | config/head `2/2`, old generation active, N+1 job dead, one rollback job | PASS |

The final assertion rejects an artificial N+1 writer after N+2. Leases are not
used as the integrity authority. The result marker is:

`PHASE3_TRANSACTION_CRASH_MATRIX_PASS boundaries=6 final_generation=2 final_head_revision=2`

Artifacts:

- fixture — `576fcab1ee19175ee1723724f275186daa967a541228ebd140df8ea4efb917e1`;
- crash matrix — `3eae2474808ac7e1363532ed1c741e6df65d7778498317be1fbe4cc1fa4e6d12`.

## Continuation and deletion crash coverage

The unchanged normal transition path remains `72/72`. It covers candidate
build/seal reclaim, post-swap active refresh pages, checkpoints,
reconciliation, coherence proof, completion, rollback and stale ABA writers.
Artifact SHA-256:
`7582630de88259084d94e8eb99d1d1f1c1f1feb12730a2d4fd254e026f18d469`.

The following current durable smokes passed on the same isolated PostgreSQL
head:

| Boundary | Authoritative smoke | SHA-256 | Result |
| --- | --- | --- | --- |
| provider deletion races, permits and stale reclaims | `provider_account_delete_concurrency_smoke.sql` | `e089a62e9ad44b771958801eec51b155ca3c283bfe8525fe8c5e453ef37e84cb` | PASS |
| legacy prepare path through durable finalization | `provider_account_delete_prepare_smoke.sql` | `dd01a81c227b79026e8b965f8f15691cef0561c1a8dbc94a9d07387c99d2144c` | PASS |
| scheduler crash after claim | `account_deletion_workflow_claim_smoke.sql` | `4e57c7b0f025b4cde4c9732e3ac3850eab36fe6a41aae4f839f7110663ddea44` | PASS |
| concurrent scheduler claim | `account_deletion_workflow_claim_concurrency_smoke.sql` | `bf8c6287768a2f78dd376489949c1544b2791ff881d1d39224287171fcb9c6de` | PASS |
| gateway stop, reclaim and stale settle | `account_deletion_transport_stop_concurrency_smoke.sql` | `56c5c773b6975c71469e0a09681358244070430980bc2f6aac7941488ea5b56e` | PASS |
| analytics rollup/delete replay | `account_deletion_paywall_analytics_smoke.sql` | `1d94f4ef685f78a99afb0b4860ce404b4bce121d512aef394d654e91d9f9d706` | PASS |
| legal archive and retention reaper | `account_deletion_legal_billing_retention_smoke.sql` | `649a9807837a96fdd08b46b3b4204f667684bf5ec7e389e29c6bbd8110817a79` | PASS |
| bounded product purge | `account_deletion_product_reaper_smoke.sql` | `b63ab70c14f4a58f5feb7d6b4299cf74f1740ad66ba293265b34142981c9fdf2` | PASS |
| Auth final delete and durable acknowledgement | `account_deletion_finalization_smoke.sql` | `cb2768162b0ae93f310f4eb89ffcc11416b792cf9a3aec9bf8f13976ca2bc116` | PASS |
| crash after Auth delete before acknowledgement | `account_deletion_finalization_concurrency_smoke.sql` | `eca295fe1676b5fe6853269164f88b5f562252d3e44daaff97d173ee42763fc2` | PASS |

The existing Deno gateway-stop crash runtime proof remains unchanged and is
recorded in `08-phase3-2-proof-report.md`: a recovered worker replays the
idempotent external stop, while only its current lease/revision may settle.

## Final invariants

- one current credential generation can write;
- candidate version and binding are re-CASed at promotion and swap;
- `N → N+1` swap and `N+1 → N+2` rollback are atomic and monotone;
- killed transactions leave no partial config, head, job or action state;
- stale N and N+1 workers cannot write after the corresponding bump;
- post-swap destructive prune remains fenced until durable coherence proof;
- deletion fences new provider effects before drain and bounded purge;
- analytics raws are deleted after idempotent anonymous rollup;
- legal billing data is archived separately under explicit retention;
- Auth deletion is final, bounded and recoverable after a crash before ack;
- PostgreSQL alone determines the next authorized continuation.

Therefore the durable core satisfies the Phase 3.2 closure contract. The next
work is the thin Edge v3 adapter and the separately gated global visibility
epoch needed before any Provider Access production activation.
