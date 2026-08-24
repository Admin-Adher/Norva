# Phase 16 — independent external-channel gates

Date: 2026-08-25

Status:

```text
PHASE_16_EXTERNAL_CHANNEL_GATES_PROVED
PRODUCTION_ACTIVATION_STILL_OFF
```

## Defect closed

The initial progressive-rollout RPC enabled all nine Provider Access flags when
the cohort moved from `OFF` to `INTERNAL`. That coupled the durable product core
to three separately operated effects:

- automatic provider checks;
- email delivery;
- push delivery.

Those effects require different secrets, cron readiness and operational
approval. They must not inherit cohort approval implicitly.

Migration `20260824170000_provider_access_rollout_channel_gates_v1.sql` now
enforces:

1. a cohort stage enables only the six core/in-app flags;
2. automatic detection, email and push remain OFF;
3. `norva_set_provider_access_rollout_channels(...)` is the only rollout RPC
   that can enable those three effects;
4. that RPC uses the same rollout revision CAS, real approval evidence and P0
   safety assertion;
5. `OFF` refuses channel activation;
6. every stage change resets all three external channels OFF;
7. every channel decision is recorded in a separate service-only audit table.

## PostgreSQL acceptance

Disposable database: `norva-phase3-proof-b-db`.

```text
provider_access_progressive_rollout.sql
1..33
33 PASS
0 FAIL
ROLLBACK
```

The proof covers initial OFF, core-only INTERNAL, channel activation, stale CAS,
core preservation, channel reset on `INTERNAL → 1%`, OFF refusal, emergency OFF,
separate audit and owner-only sanitized status.

## Real concurrent sessions

The existing two-session rollout harness now executes two independent CAS
races:

```text
stage promotion
session A exit=3 STALE
session B exit=0 winner
final=internal:3:one-stage-event

channel approval
session A exit=3 STALE
session B exit=0 winner
final=internal:4:one-channel-event:auto-detection-on
```

Cleanup result:

```text
stage=off
revision=1
enabled Provider Access flags=0
stage events=0
channel events=0
```

## Immutable proof inputs

```text
migration SHA-256
e2c54199501086b8a92d6b211d1fb61b25affa4a1e4144dabc5585dd2cea7e83

pgTAP SHA-256
2d3e01175cc8e436c8556b387d65ae1ea6d7f0d67f477fea9406615e5efe7c74

two-session harness SHA-256
866562089b69f477a4a3dc799e0421b14a076d0d280664c37f6d376837e37298
```

## Repository regression

The first full run exposed one unrelated transient Gateway fixture failure
(`PROVIDER_REQUEST_FAILED`). The exact scenario passed alone, then the complete
suite was replayed:

```text
2628 tests
2626 passed
0 failed
2 expected skips
```

This proof does not approve secrets, schedule a cron, complete cache epoch v2,
choose a production account or activate a cohort.
