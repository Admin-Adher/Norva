# Provider Access — durable rollout observation gate

Date: 2026-08-25

Status before the production-clone replay:

```text
PHASE_16_DURABLE_OBSERVATION_GATE_DB_PROVED
PHASE_16_REAL_CONCURRENCY_RACE_PROVED
PRODUCTION_INSTALLATION_PENDING_FRESH_CLONE
PRODUCTION_ACTIVATION_BLOCKED_UNTIL_CACHE_NOT_BEFORE
```

## Defect closed

The original Phase 16 control plane used revision CAS and a synchronous P0
check, but it did not persist a time-bounded observation decision for each
rollout rung. A later operator could therefore promote from a cohort without a
database-verifiable observation window.

Migration
`20260825012308_provider_access_rollout_observation_gate_v1.sql` adds a durable
observation bound to the exact rollout revision and stage. The database now
requires an `accepted` observation before every upward transition after
`OFF -> INTERNAL`.

The authority is split deliberately:

```text
revision CAS             = which rollout configuration is current
observation row          = what was measured, for how long, and with which evidence
promotion trigger        = whether that exact revision may advance
feature flags            = projection only, never a bypass
```

Direct `service_role` INSERT/UPDATE/DELETE privileges are removed from the
rollout singleton, allowlist and audit tables. All mutations must pass through
the existing SECURITY DEFINER RPCs and their revision checks.

## Server-owned windows and thresholds

```text
INTERNAL   1 hour
1%         6 hours
5%        12 hours
20%       24 hours
50%       48 hours
100%      72 hours
```

Every completion requires:

```text
qualifying cohort activity                    >= 1
staging visibility violations                 = 0
replacement failure rate                      <= 2%
credential rollback rate                      <= 5%
notification dead-letter rate                 <= 1%
explicit evidence reference and approval note present
```

A revision or channel change turns a collecting observation into `stale`.
Rejected observations retain their metric snapshot and reason codes. Nothing
promotes automatically.

## Analytics correction

The notification outbox terminal success state is `delivered`. The former
dashboard queried the impossible state `completed`, so delivered email and push
counts remained zero. Migration
`20260825012611_provider_access_analytics_delivered_state_fix_v1.sql` replaces
all five success predicates with the canonical terminal state.

## PostgreSQL proof

Disposable database: `norva-phase3-proof-b-db`.

```text
progressive rollout pgTap       43/43 PASS, transaction rolled back
analytics dashboard pgTap       16/16 PASS, transaction rolled back
real concurrent starts          exactly one winner, loser STALE
real concurrent completions     exactly one winner, loser STALE
real concurrent promotions      exactly one winner, loser STALE
final concurrent state          1_percent:4:1:1
post-proof cleanup              off:1, zero observations, zero flags
```

The existing B volume had received an earlier draft before direct rollout DML
was revoked. Its first replay correctly failed assertion 6. After synchronizing
that disposable volume with the final ACL statements, the complete 43-test
transaction passed. A fresh production-clone replay remains mandatory because
only a new clone can prove the final migration installs those ACLs in one pass.

Supabase CLI `2.115.0` lint reported no issue for any of the new observation or
analytics functions after the observation-metrics helper was correctly marked
`VOLATILE`. The full historical schema still exposes unrelated pre-existing
lint findings; they are not represented as clean by this scoped result.

## Repository proof

```text
full Node suite      2666 tests / 2664 passed / 0 failed / 2 expected skips
focused contracts   26/26 passed
bash syntax          PASS
git diff check       PASS
```

The Settings duration UI covered by the same regression keeps `Duration` and
`Unit` on one compact row, binds them to an activation/purchase date and updates
an accessible clickable calendar preview in both directions.

## Immutable inputs before commit freeze

```text
observation migration SHA-256
28a4e699c8407ab2e3fe93d7bc7dec2f88971706bb28fb7b3ac6cc23968c685e

analytics migration SHA-256
ae4f1ea68d7e0f17bde5168481ff05f6114126d1d7221032c4b6c540e0e0118e

concurrency harness SHA-256
16d3f0e20819652f9a347b9c0e3ecd06041603d9af7c011566fd8cb5dc57b3b0

production installer SHA-256
dbdbb34bd9fe09a47527403dafc1fc8a791b7b65fa641a27fc0c3a10b302239c
```

The commit SHA and production evidence paths will be appended only after the
fresh clone, dormant installation and current-state replay succeed.

## Production boundary

Installation is additive and must preserve:

```text
rollout stage OFF, revision 2
9 Provider Access flags OFF
one pre-approved internal allowlist member
zero Provider Access crons
zero observation rows
cache epoch phase installed, not completed
P0 safe true
```

No observation can start while the rollout remains OFF. The hard cache gate
still prevents internal activation before
`2026-08-31 10:12:57.166559 UTC`. This migration does not shorten or bypass
that boundary.
