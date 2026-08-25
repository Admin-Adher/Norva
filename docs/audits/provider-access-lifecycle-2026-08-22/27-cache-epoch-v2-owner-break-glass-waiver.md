# Catalog cache epoch v2 — accountable-owner break-glass waiver

Date: 2026-08-25

Status:

```text
BREAK_GLASS_DESIGN_IMPLEMENTED
ISOLATED_POSTGRES_RUNTIME_PROVED
ISOLATED_TWO_SESSION_CONCURRENCY_PROVED
PRODUCTION_NOT_YET_EXECUTED
```

## Owner decision

Adrien Hernandez explicitly authorized accepting the shortened cache observation
risk so Norva can begin its advertising launch before the normal cache epoch v2
deadline on 2026-08-31.

Durable production approval reference:

```text
NORVA-CACHE-EPOCH-V2-WAIVER-ADR-20260825
```

Exact one-line risk reason supplied to the production RPC:

```text
Adrien Hernandez, accountable Norva owner, explicitly accepts shortening the seven-day incompatible-cache observation window to begin advertising before 31 August 2026; rollout remains INTERNAL-first, external channels stay OFF, and every later observation window remains unchanged.
```

Actor:

```text
adrien-owner-via-codex
```

Confirmation contract:

```text
WAIVE_CACHE_EPOCH_V2_OBSERVATION_FOR_AD_LAUNCH
```

## What the waiver changes

It permits only the early transition:

```text
cache epoch v2 installed
→ cache epoch v2 complete
→ one global visibility epoch bump
```

It does not:

- backdate `installed_at`;
- change the database clock;
- replace or weaken the normal seven-day completion RPC;
- enable any Provider Access flag;
- activate email, push or automatic detection;
- skip `INTERNAL → 1% → 5% → 20% → 50% → 100%`;
- skip any durable observation required after cache completion.

The true values remain durable:

```text
installed_at
normal_not_before = installed_at + 7 days
waived_at < normal_not_before
approval_reference
risk_reason
actor
rollout_revision
global_epoch_before
global_epoch_after = global_epoch_before + 1
```

## Fail-closed implementation

The separate RPC
`norva_waive_catalog_cache_epoch_v2_observation(...)` requires:

1. `service_role` authority;
2. exact cache contract and immutable manifest hash;
3. exact rollout revision CAS;
4. rollout stage `off` and cohort `0`;
5. all nine Provider Access flags `OFF`;
6. no Provider Access notification/detection cron;
7. `norva_assert_provider_access_rollout_safe().safe = true`;
8. an approval reference, bounded one-line risk reason and actor;
9. the exact confirmation contract;
10. execution strictly before the normal deadline.

The waiver table is RLS-enabled, force-RLS, inaccessible directly to API roles,
and protected by an immutable `BEFORE UPDATE OR DELETE` trigger. Exact retries
are idempotent. A changed retry is a completion conflict.

## Isolated PostgreSQL runtime proof

Target:

```text
container=norva-phase123-prod-clone-observation-postinstall-bfab5f56-db
database=postgres
production_mutations=0
```

Initial state:

```text
cache_phase=installed
installed_at=2026-08-24T10:12:57.166559Z
normal_not_before=2026-08-31T10:12:57.166559Z
rollout_stage=off
rollout_revision=2
enabled_flags=0
global_epoch=3
```

Transactional runtime assertions:

```text
BREAK_GLASS_RUNTIME_PRECONDITIONS_PASS
BREAK_GLASS_NORMAL_GATE_STILL_REFUSES_PASS
BREAK_GLASS_BAD_CONFIRMATION_REFUSED_PASS
BREAK_GLASS_STALE_REVISION_REFUSED_PASS
BREAK_GLASS_EXACT_COMPLETION_PASS
BREAK_GLASS_IDEMPOTENT_REPLAY_PASS
BREAK_GLASS_IMMUTABLE_EVIDENCE_PASS
BREAK_GLASS_RUNTIME_ROLLBACK_PASS
```

The transaction snapshot showed:

```text
cachePhase=complete
rolloutStage=off
rolloutRevision=2
enabledFlags=0
waiverRows=1
globalEpoch=4
```

The rollback restored:

```text
cache_phase=installed
completed_at=NULL
rollout_stage=off
rollout_revision=2
enabled_flags=0
waiver_rows=0
global_epoch=3
```

## Two-session concurrency proof

Two real PostgreSQL sessions invoked the exact same waiver concurrently.

Results:

```text
session winner: idempotentReplay=false
session loser:  idempotentReplay=true
completed_at:   identical
waiver rows:    1
epoch:          3 → 4 exactly once
rollout stage:  off
enabled flags:  0
P0 safe:        true
```

The normal deadline was preserved as
`2026-08-31T10:12:57.166559Z`; the isolated waiver timestamp was
`2026-08-25T19:16:11.915537Z`.

## Production execution gate

Before production execution:

1. publish the exact migration, operator and tests;
2. require green CI/deployment;
3. run the immutable internal, rollout, legal, observation and global-cron
   preflights again;
4. verify physical Play build readiness;
5. capture a pre-deployment production dump and hashes;
6. apply the migration with every Provider Access flag still `OFF`;
7. run the new operator preflight;
8. execute with the exact revision, approval, reason, actor and confirmation;
9. prove one waiver row, one epoch bump and zero enabled flags;
10. only then activate `INTERNAL` and start its durable one-hour observation.

Any unexplained divergence remains an immediate `NO-GO`.
