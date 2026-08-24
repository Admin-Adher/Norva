# Phase 4 replacement proof — 2026-08-24

## Scope

Private integration branch: `codex/phase123-production-integration`

Implementation checkpoint: `2fb832f5`

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

The harness separates cutover, reaper and final sanitization into distinct
transactions. This is required because the production reaper deliberately uses
`FOR UPDATE SKIP LOCKED`; the proof must not retain an orchestrator row lock
while asking a new worker to claim the tombstone. Reaper singleton claims are
retried for a bounded 15-second window, while every non-singleton error remains
terminal.

## Remaining Phase 4 gate

The deterministic core and the eight transaction crash boundaries are proved.
Formal Phase 4 closure still requires a committed, cleanly replayable two-session
concurrency harness for the six race orders above, followed by a second clean
determinism run and the signed closure snapshot. Production rollout is separate
and remains forbidden while the relevant feature flags are OFF.
