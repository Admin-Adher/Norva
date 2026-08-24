# Phase 3.2 — Formal-closure proof matrix

This matrix is the acceptance boundary after the historical-migration proof.
Every scenario below must run against committed synthetic fixtures with two
independent PostgreSQL sessions.  A lease is not accepted as the authority for
any conclusion; final writes must be justified by the durable state, exact
candidate binding, and current credential generation.

## Mandatory concurrency scenarios

| Scenario | Required winner/loser evidence | Terminal invariant |
| --- | --- | --- |
| `promotion_cancel_cancel_wins` | cancellation commits; promotion returns `40001` / `STALE` | no swap job, no generation bump, transition remains `cancelled` |
| `promotion_cancel_promotion_wins` | promotion commits; cancellation returns `40001` / too-late | transition cannot return to `cancelled` |
| `swap_deletion_delete_wins` | deletion pending commits; swap is refused | config and generation do not change; no provider effect starts |
| `swap_deletion_swap_wins` | swap commits exactly once | deletion observes the committed N+1 generation before drain |
| `rollback_deletion_delete_wins` | deletion pending commits; rollback is refused | no old config/source is resurrected |
| `rollback_deletion_rollback_wins` | rollback commits exactly once | N+1 → N+2; deletion drains N+2; N and N+1 writers are stale |

## Mandatory crash boundaries

The crash harness must re-enter only through durable RPCs after each boundary:

- ready proof before/after `READY_TO_SWITCH`;
- swap before transaction commit, after commit, after generation bump, and
  before continuation scheduling;
- post-swap page write, checkpoint, reconciliation, proof and completion;
- rollback decision, commit, N+2 bump, scheduling and terminal settlement;
- deletion pending, gateway stop, permit drain, analytics rollup/delete,
  legal archive, product purge, Auth delete and terminal settlement.

For every run, the proof report records the initial and final transition state,
candidate version/HMAC, credential generation, owner snapshot, jobs and
checkpoints, provider-effect authorization, winner, loser result, and the
exact final invariant query.

All rows were proved green on isolated PostgreSQL runs on 2026-08-24. The
authoritative results, artifact hashes and source commits are recorded in
`12-phase3-2-formal-closure-report.md`; the durable core status is now
`PHASE_3_2_FORMALLY_CLOSED`.

The Provider Access visibility flag, public Edge v3 adapter and production
rollout remain independently blocked until their own gates are green.
