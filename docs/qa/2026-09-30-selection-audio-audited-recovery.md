# Selection audio: bounded operator recovery

## Purpose and explicit budget change

Existing failed jobs exhausted eight attempts and the normal seeder deliberately
does not reset them. A documented infrastructure/pipeline repair can require a
fresh analysis of the same exact file. The new service-only operator RPC grants
one additional run of at most eight attempts per external ID and URL digest,
for a maximum of sixteen attempts across original and recovered runs. It is
not automatic, unlimited retry or a way to claim that historical failures passed.

The repair revision is an operator-supplied provenance reference, not a database
verification that the referenced source is deployed or fixes the original cause.
Before invoking it, the operator must establish that repair and validate the
intended worker capture configuration. This migration invokes no recovery.

## Controls

- Capture admission must be enabled. Only failed jobs with all eight attempts
  exhausted, a matching ID/completion timestamp, at least 24 hours of age, and
  Gateway-rejection/attempt-limit failure codes qualify.
- Complete original row and capture history are archived in a private RLS table.
  Service clients cannot mutate that table directly. Customer roles cannot
  execute recovery or read the archive.
- The existing global worker advisory lock serializes recovery with claims.
  Canonical seeding rechecks visible owner, active generation, exact URL match,
  availability and incomplete audio inside the same transaction. Failed seeding
  rolls back deletion, including cascaded captures.
- A new job identity starts without old profile, checkpoints, receipts or
  results. Ordinary claiming, viewer priority, work leases, capture admission
  and hydration fences continue to apply.
- A replay of the same successfully committed recovery returns the recorded
  replacement ID. Another recovery of that exact file is refused permanently.

## Executed tests

The PostgreSQL/WASM fixture executes the actual recovery migration, canonical
seeder, source identity, language normalization, owner lookup and claim SQL.
Its visibility view uses reduced fixture tables, not the full production view.
21 tests passed, zero skipped, including the previous 40 capture SQL assertions.
Cases cover private access, flags, incorrect state/budget/cause, stale completion,
recent failure, source removal, generation/URL drift, already-complete audio,
rollback, archive preservation, new identity, normal claim, idempotent response
replay and refusal of a second recovery. Real concurrent transactions still
require a PostgreSQL integration check before applying the migration.

No production migration, flag or queue change has been made for this recovery.
Real extraction, local inference, hydration and user-visible results remain
necessary before enabling the accelerated Selection path broadly.

## PostgreSQL concurrent-session verification

Executed on PostgreSQL 17.6 in a separately created scratch database, removed
after the test. Two independent sessions verified that a claim transaction
blocks recovery, recovery blocks claiming, and concurrent recovery returns
`SELECTION_RECOVERY_BUSY`. After the first recovery commits, replay returns the
same replacement UUID. Exactly one queued job and one archive remain in the
fixture, with attempt count zero. No production catalogue row was modified.

This concurrency fixture executes the actual recovery migration and claim
function with reduced synthetic owner/seeder dependencies. The canonical
seeder and visibility checks are covered separately by the SQL/WASM fixture
above. It does not simulate provider media or claim a successful audio replay.
Receipt: `/home/adrien/.norva/selection-recovery-concurrency.safe.json`.

## Migration publication

PR #517 merged as `df0b33bb4dfa19ba7509de03bffc558e0ac860be` after Build Norva
36779206231, Partners 36779206267 and customer-service notices 36779206253
succeeded. Production migration SHA256:
`56f9044040bd97146ae9b18813242b05813e935e99f7c1e1742d91a4d68be55d`.

The installed RPC and archive exist; customer execution and archive access
are denied. Before/after counts match (192 completed, 523 failed), both Selection
flags remain false and zero recoveries have been invoked. Receipt:
`/home/adrien/.norva/selection-audio-recovery-migration.safe.json`.
Real capture/inference/hydration replay remains outstanding.
