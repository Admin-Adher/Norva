# Provider Access — durable rollout observation gate

Date: 2026-08-25

Status before the production-clone replay:

```text
PHASE_16_DURABLE_OBSERVATION_GATE_DB_PROVED
PHASE_16_REAL_CONCURRENCY_RACE_PROVED
PHASE_16_DURABLE_OBSERVATION_GATE_PRODUCTION_INSTALLED
PHASE_16_POSTINSTALL_CURRENT_STATE_CLONE_PROVED
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
3e510ea9c36bb217c8c51b13ff597e8350091bbea6513e7ce8d559495d5a01bc
```

## Fresh pre-installation clone

The exact production state before installation was dumped and restored into a
new isolated container. Both migrations were applied exactly once in the clone.

```text
result              PHASE123_PRODUCTION_CLONE_REHEARSAL_PASS
mode                incremental
commit              ef5c41fc979b911c1a06c3792b3b3132de621d5e
report              /home/adrien/norva-phase3-proof/artifacts/prod-clone-observation-preinstall-ef5c41fc
dump bytes          910287958
dump SHA-256        87399fc906b82f31292d614fdbee6985aca40170927be1ca522c6e072517dc26
migration tree SHA  c7948c368e49089cdf7cbf98fa8b19f103ab9a1528b3e61415d88e294f133142
ACL diff SHA-256    e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
final invariant SHA b99683a3903ec36f30835b37b31455e9df57572e7d5cdd5a9d7b33b1fc97c7ad
install test SHA    dd2b44a47075488a0650b7b9139da74c1b207e0a11fd0ff90674433b9f27030b
analytics test SHA  8a26cabac02f9cdfeebb9fe29f7734a4e144f909f6a27ecaa446d04134c50ebf
```

## Dormant production installation

The migrations committed successfully on production. The first installer
process then exposed two shell invocation defects after all database writes had
finished: a readonly environment assignment and direct execution of a tracked
script without its executable bit. Production remained healthy and OFF. The
installer was hardened to resume only when all original backup hashes and the
captured post-install state still match exactly; it then completed the pending
read-only verification without reapplying either migration.

```text
final verifier commit bfab5f564a3ba623a3ec1e9624f365c906b251f2
report                /var/lib/norva-phase3-proof/provider-observation-production-ef5c41fc
completed UTC         2026-08-25T02:06:57Z
status                INSTALLED_DORMANT
schema backup SHA     b23487c5b242cd165cca211a60235475eff727c8580b31bb33a5f85c5fb544a1
control backup SHA    10b7e536fdbdb42553a3bde379f6338d8673cfe04b5b7a9887808777d2521a27
pre-state SHA         c06189b865b96a185af4187e2c3c2a5b0ee382006c16216b7dd4c4ab26a49b8c
post-state SHA        6171c5e198a37a97fc502ca8283e669c6937032639275beed782f0a41adc71cf
contract SHA          56e4b2073e4d789a5a1d1e736e03d608b65044fc3918804d10414ed7a45de494
observation status SHA 470f56732e873d9b3867f5de92d9943356a5242b68f52b8697131dcf925ea687
```

Verified production state:

```text
rollout               off, revision 2, cohort 0
flags                 9 total, 0 enabled
internal allowlist    1
Provider Access crons 0
observation rows      0
cache epoch           installed, not completed
P0 safe               true
service direct DML    false
browser RPC execute   false
analytics delivered   true
legacy completed      false
database health       healthy
```

## Fresh post-installation clone

A second independent dump and new volume proved the exact installed production
state without replaying the migrations.

```text
result              PHASE123_PRODUCTION_CLONE_REHEARSAL_PASS
mode                current-state
commit              bfab5f564a3ba623a3ec1e9624f365c906b251f2
report              /home/adrien/norva-phase3-proof/artifacts/prod-clone-observation-postinstall-bfab5f56
dump bytes          910381364
dump SHA-256        b599cb46498e5fb29b0ad916af81bc88016007ddad383a31961ccf2746924656
migration tree SHA  cb11cb6889a49f4e7080252b2f96784e72e85ff888b453b4b1423371913ac63d
ACL diff SHA-256    e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
final invariant SHA b99683a3903ec36f30835b37b31455e9df57572e7d5cdd5a9d7b33b1fc97c7ad
install test SHA    15ec7f0ccc3a2e43699d514f9f397bfb6ef6178e4b685c3464a1d748680b5079
analytics test SHA  8a26cabac02f9cdfeebb9fe29f7734a4e144f909f6a27ecaa446d04134c50ebf
```

The policy-state SHA and rollout-state SHA are identical before and after the
clone test, and no legal-reader grant, audit event, flag, cron or observation
was introduced.

## Publication and CI

GitHub `main` points to `bfab5f564a3ba623a3ec1e9624f365c906b251f2`.

```text
Build Norva                       run 32800133137 PASS
Deploy Norva Web to Cloudflare   run 32800133158 PASS
Deploy Norva Relay Worker        run 32800133194 PASS
```

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
