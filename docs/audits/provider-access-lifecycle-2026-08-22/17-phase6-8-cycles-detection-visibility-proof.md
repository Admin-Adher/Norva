# Norva Provider Access — Phases 6–8 proof

Date: 2026-08-24

Git base: `6c08aa6ad757c11ef0c6b440c7df000593c403d7`

Scope: access cycles, conservative Xtream detection, durable scheduler, and catalogue visibility policy.

Production state: **not deployed or activated by this proof; all production flags remain OFF**.

## Result

```text
PHASE_6_ACCESS_CYCLES_PROVED
PHASE_7_PROVIDER_DETECTION_PROVED
PHASE_8_VISIBILITY_POLICY_PROVED
PRODUCTION_ACTIVATION_PENDING
```

The implementation separates three authorities:

- user-entered calendar cycles are durable expectations and never hide a catalogue;
- only a non-contradictory provider observation can hide or restore a catalogue;
- a durable PostgreSQL job lease authorizes a worker attempt, while the access revision and lease sequence authorize its commit.

No raw Xtream `account_info` payload is stored. Events and snapshots contain only bounded decisions, reason codes, dates, counters, and versions.

## Implemented contracts

### Phase 6 — access cycles

- At most one active cycle per source.
- Create, complete update, and end are idempotent PostgreSQL RPCs.
- Every mutation uses an access revision CAS; stale callers receive no repair path.
- Historical cycles are retained and supersession is explicit.
- A manually entered past date becomes `expected_expired` and remains visible.
- A new future date on a hidden source becomes `restoring`; it does not restore visibility without provider proof.
- Cycle changes do not start a source sync and do not mutate catalogue rows.

### Phase 7 — automatic provider detection

- The Xtream extractor is pure, versioned, and conservative.
- Missing or unlimited expiry values do not manufacture an expiration.
- Contradictory status/date/auth/counter evidence becomes `check_failed_temporary` and cannot hide.
- Durable jobs are queued, leased, reclaimed, retried, completed, or dead-lettered.
- Claims use `FOR UPDATE SKIP LOCKED`.
- Every reclaim increments `lease_sequence`.
- Detection commits are bound to `job_id + lease_sequence` and the claimed access revision.
- A stale worker receives SQLSTATE `40001` and cannot repair or overwrite the winner.
- Cron installation is an explicit production operation; applying the migration does not schedule network traffic.

### Phase 8 — visibility

- Only `expired_confirmed` or `access_unavailable_confirmed` with `hideEligible=true` can hide.
- Timeouts, invalid payloads, contradictions, and user-entered dates remain visible.
- A hidden source retains its hidden authority across ambiguous observations.
- A confirmed active provider observation restores visibility and records the restoration.
- Hiding retains source metadata and catalogue data; it does not perform destructive pruning.
- Visibility changes bump the global cache epoch through the existing v2 contract.

## Reproducible evidence

### Pure extractor and Edge/SQL contract tests

```text
node --test
  tests/provider-access-state.test.js
  tests/provider-access-lifecycle-contract.test.js
  tests/norva-provider-access-contract.test.js

67 tests
67 passed
0 failed
```

The extractor itself accounts for 22/22 cases, including boundary dates, unlimited expiry, contradictions, invalid counters, and input immutability.

### Lifecycle SQL proof

Harness: `supabase/tests/provider_access_cycles_detection_visibility.sql`

```text
Proof PostgreSQL A: 37/37
Proof PostgreSQL B: 37/37
Proof PostgreSQL A after durable scheduler integration: 37/37
```

The harness runs in a transaction and rolls back fixtures, rollout completion, and feature-flag changes.

### Real concurrency and crash/reclaim proof

Harness: `supabase/tests/provider_access_detection_scheduler_concurrency.sql`

The database was reconstructed twice from a fresh `template0` database plus the current proof schema. Two independent PostgreSQL sessions were synchronized with `dblink` for the claim race.

```text
Run 1: 22/22
Run 2: 22/22
```

Proved outcomes:

- exactly one of two concurrent claimers wins;
- an expired lease is reclaimed with a higher sequence;
- the pre-crash worker cannot commit;
- a retry uses a new lease-bound idempotency identity;
- retry convergence leaves no open work;
- no cron is installed implicitly;
- service role remains the only queue authority;
- raw Xtream payload fields are absent from durable scheduler state.

### Full repository regression

```text
npm test
2596 tests
2594 passed
0 failed
2 skipped (pre-existing runtime-fixture skips)
duration: 45.74 s
```

### Edge bundle

```text
npx esbuild supabase/functions/norva-provider-access/index.ts \
  --bundle --format=esm --platform=neutral --external:npm:* \
  --outfile=.codex-functions-build/norva-provider-access-phase8.js

225.4 kb
success
```

The build output is local evidence only and is intentionally excluded from Git.

## Remaining rollout gates

- This proof does not deploy the two new migrations or the updated Edge Function to production.
- Public and automatic Provider Access capability flags must remain OFF until the production rollout step.
- Before enabling automatic checks, validate the production `pg_net` signature, install the two dedicated Vault secrets, then explicitly call the cron installer.
- Activation must use a bounded reversible canary after the previously recorded seven-day cache-compatibility window.
- Phases 9–10 must still implement and validate the web/phone/TV user experience over this durable contract.
