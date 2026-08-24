# Phase 4 replacement proof — 2026-08-24

## Scope

Private integration branch: `codex/phase123-production-integration`

Crash proof checkpoint: `ab9af426`

Deterministic concurrency harness: `e57759722642f08e936d802669d4e1f85b5df465`

Production flags remained OFF. No real customer source or credential was used.
All SQL evidence below ran against disposable PostgreSQL proof containers on
Hetzner.

## Deterministic contract evidence

| Proof | Result |
|---|---:|
| Replacement A→B, atomic promotion, rollback, bounded reaper and terminal cleanup | 30/30 PASS |
| Replacement build failure, idempotent terminal failure and cleanup scheduling | 7/7 PASS |
| Provider Edge and visibility contracts | 44/44 PASS |
| Fresh `20260824113000_provider_replacement_cleanup_v1.sql` application on proof B | PASS |
| Bundled `norva-provider-access` Edge function | PASS (912.4 KiB) |
| Transaction crash matrix | 8/8 boundaries PASS |

The cleanup proof includes:

- hidden `PURGE_PENDING` before the first delete;
- DELETE-only generation guard authority bound to the exact due cleanup job;
- bounded source reaper convergence;
- irreversible candidate ciphertext/config-hint sanitization;
- terminal `PURGED` lifecycle state;
- retained transition and generation audit metadata;
- cleanup execution even when rollout flags are OFF.

## Real two-session concurrency evidence

Every first operation was paused inside PostgreSQL after it had entered the
critical transaction. A second independent PostgreSQL session was then started
and observed blocked until the barrier was released.

| Race order | First result | Second result | Final invariant |
|---|---|---|---|
| promotion → cancel | `COMPLETED` | cancellation CAS rejected | B visible, exactly one active visible source |
| cancel → promotion | `CANCELLED` | promotion CAS rejected | A visible, exactly one active visible source |
| promotion → account deletion | `COMPLETED` | deletion prepare `PENDING` | exactly one visible source, deletion durable |
| account deletion → promotion | deletion prepare `PENDING` | provider-delete fence rejected promotion | A remains the sole visible source |
| rollback → account deletion | compensating transition `COMPLETED` | deletion prepare `PENDING` | A restored, one reversal, one visible source |
| account deletion → rollback | deletion prepare `PENDING` | provider-delete fence rejected rollback | B remains the sole visible source |

Final database snapshot:

```text
933...0601 | completed       | visible_count=1 | deletion_pending=true | reversals=0
934...0601 | completed       | visible_count=1 | deletion_pending=true | reversals=1
935...0601 | ready_to_switch | visible_count=1 | deletion_pending=true | reversals=0
936...0601 | completed       | visible_count=1 | deletion_pending=true | reversals=0
```

All temporary barrier triggers/functions were dropped after the snapshot.

The six orders are now encoded in
`supabase/tests/provider_replacement_concurrency_matrix.sql`. Each execution
uses two independent `dblink` sessions. The first winner pauses after entering
its critical transition while the second is mechanically observed waiting on a
PostgreSQL lock owned by that transaction. The harness then releases the
winner, collects both durable results and checks the final database snapshot.

Two complete series passed on distinct committed fixtures:

```text
series A: 960, 961, 966, 967, 968, 969
series B: 970, 971, 972, 973, 974, 975
```

| Race mode | Winner | Loser/continuation | Durable result |
|---|---|---|---|
| `promotion_cancel_promotion` | promotion | cancel `40001` | B visible, transition `completed` |
| `promotion_cancel_cancel` | cancel | promotion `40001` | A visible, transition `cancelled` |
| `promotion_delete_promotion` | promotion | deletion succeeds after serialization | deletion observes B visible |
| `promotion_delete_deletion` | deletion | promotion `40001` | A visible, transition remains `ready_to_switch` |
| `rollback_delete_rollback` | rollback | deletion succeeds after serialization | A visible, exactly one reversal |
| `rollback_delete_deletion` | deletion | rollback `40001` | B visible, zero reversal |

Both series produced `visibleCount=1` for every fixture. No race produced two
visible sources, a double reversal or a transition resurrection.

## Reproducible transaction crash evidence

`provider_replacement_transaction_crash_matrix.sql` was run against a new
`READY_TO_SWITCH` fixture (`952...`) in the disposable proof B database. The
harness uses independent PostgreSQL backends, real `pg_terminate_backend`
crashes and explicit post-COMMIT acknowledgement barriers.

| Boundary | Recovery evidence |
|---|---|
| cancel before COMMIT | transition remains `READY_TO_SWITCH` |
| promotion before COMMIT | A remains the only visible source |
| promotion after COMMIT / lost acknowledgement | exact replay returns `replayed=true`; B is visible |
| rollback before COMMIT | no compensating transition survives; B remains visible |
| rollback after COMMIT / lost acknowledgement | one reversal survives; exact replay returns it with `replayed=true`; A is visible |
| cleanup preparation before/after COMMIT | pre-COMMIT crash leaves no tombstone; committed state is durably resumable as `PURGE_PENDING` |
| bounded reaper during catalogue drain | deleted rows roll back with the crash; restart reaches `provider_deletion_pending=true` and zero catalogue rows |
| final credential sanitization before COMMIT | restart clears ciphertext/config hints, reaches `PURGED` and completes the cleanup job |

Terminal marker:

```text
PHASE4_REPLACEMENT_TRANSACTION_CRASH_MATRIX_PASS
boundaries=8 visible_sources=1 reversals=1
```

The complete eight-boundary matrix was replayed on a second new fixture
(`976...`) and produced the same terminal marker. Its final snapshot was:

```text
transition=completed
visibleCount=1
visibleSource=A
reversals=1
candidateLifecycle=purged
candidateCredentialsCleared=true
```

The harness separates cutover, reaper and final sanitization into distinct
transactions. This is required because the production reaper deliberately uses
`FOR UPDATE SKIP LOCKED`; the proof must not retain an orchestrator row lock
while asking a new worker to claim the tombstone. Reaper singleton claims are
retried for a bounded 15-second window, while every non-singleton error remains
terminal.

## Phase 4 core closure

```text
PHASE_4_DURABLE_STATE_MACHINE_FORMALLY_CLOSED
PHASE_5_CROSS_SURFACE_E2E_PENDING
PRODUCTION_ROLLOUT_NO_GO
```

The durable replacement state machine, its cancellation/rollback/deletion
serialization, bounded cleanup and crash recovery are formally proved at the
PostgreSQL and Edge-contract layers. Phase 5 must now prove the complete A→B
journey across every product surface and cache; that separate E2E gate is not
implied by this database closure.

After the proof snapshot, all Provider Access, credential-transition and
replacement flags in the disposable database were restored to `false`.
Production rollout remains forbidden until the later visibility, legal-policy,
canary and rollout gates are satisfied.
