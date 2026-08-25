# Phase 3.2 — active catalog refresh worker production proof

Date: 2026-08-25

Status:

```text
ACTIVE_CATALOG_REFRESH_WORKER_V3_RUNTIME_PROVED
ACTIVE_CATALOG_REFRESH_WORKER_V3_PRODUCTION_DEPLOYED
ACTIVE_CATALOG_REFRESH_WORKER_HEARTBEAT_RENEWAL_PROVED
PROVIDER_ACCESS_ROLLOUT_STILL_OFF
PRODUCTION_ACTIVATION_BLOCKED_UNTIL_CACHE_NOT_BEFORE
```

## Gap closed

PostgreSQL already required the exact worker protocol
`credential-transition-worker-v3-active-catalog-refresh` and the exact refresh
contract `active-catalog-refresh-checkpoint-prune-v1`. The deployed Edge
runtime still announced the v2 title-cleanup protocol and no durable scheduler
renewed the ten-minute capability row. Consequently
`norva_active_catalog_refresh_contract_ready()` correctly returned `false`.

Commit `b05296889871793e4e5b32eedcc80d5a2b0d9a96` closes both sides:

- the authenticated worker drain registers the exact v3 contract before any
  claim and fails closed on any missing, stale or malformed registration;
- the claimant uses that same v3 protocol;
- an explicitly installed one-minute pg_cron heartbeat invokes the existing
  doubly authenticated drain route;
- the heartbeat installer is service-only and independent of rollout flags;
- the Edge deployment verifier compares the Provider Access source digest in
  every runtime replica.

The lease still grants only the right to attempt work. Feature flags, durable
transition state, job leases and credential/catalog generations remain the
authorities for claims and writes.

## Disposable SQL proof

The migration was applied to the isolated current-state production clone
`norva-phase123-prod-clone-observation-postinstall-bfab5f56-db`. Because Vault
ciphertexts from production are intentionally not decryptable in the clone,
the two required secret names were replaced there only with disposable test
values. The installer was then called inside a transaction.

```text
installer result       installed=true, schedule=* * * * *
route                   internal/worker/drain
worker protocol         credential-transition-worker-v3-active-catalog-refresh
refresh contract        active-catalog-refresh-checkpoint-prune-v1
service_role execute    true
authenticated execute   false
transaction result      ROLLBACK
persisted cron jobs     0
```

## Repository proof

```text
full Node suite         2666 tests / 2664 passed / 0 failed / 2 expected skips
focused worker tests    36/36 passed
Bash syntax             PASS
git diff check          PASS
```

## Dormant production deployment

The migration was installed first, then the two Edge replicas were recreated
sequentially from the exact detached worktree:

```text
worktree /home/adrien/norva-deployments/active-refresh-worker-b0529688
commit   b05296889871793e4e5b32eedcc80d5a2b0d9a96
report   /var/lib/norva-phase3-proof/active-refresh-worker-production-b0529688
```

Both replicas expose the exact source digest:

```text
expected                 0ce97cc04bd57d089150fb6ad641a18d5e1ba622e37d43e0803a19b84b720a9c
norva-edge-functions     0ce97cc04bd57d089150fb6ad641a18d5e1ba622e37d43e0803a19b84b720a9c
norva-edge-functions-2   0ce97cc04bd57d089150fb6ad641a18d5e1ba622e37d43e0803a19b84b720a9c
```

The first cron tick registered at `2026-08-25 02:36:00.726233 UTC`. A second
independent tick renewed the row at `2026-08-25 02:37:05.448193 UTC`, extending
expiry to `02:47:05.448193 UTC`. Both cron executions succeeded and the second
snapshot returned `norva_active_catalog_refresh_contract_ready() = true`.

No Provider Access work was manufactured by the heartbeat:

```text
rollout                  off, revision 2, cohort 0
Provider Access flags    9 total, 0 enabled
nonterminal jobs         0
active transitions       0
cache epoch              installed, not completed
worker cron              active, every minute
worker contract          ready=true
```

## Evidence hashes

```text
preinstall schema        44ba2304c3d396b598864484266484a7b90fa1ba6601360ffdefba59065ba75b
preinstall state         93010f37401607f7a8917bd489903183654f908f8682f6843fd40ed681fcc6a3
postmigration contract   d8132271a4d9fa7cc2dbf28e203c834aea506ae5c69defcf178268eb664c51f5
heartbeat proof          4ec3539ef2a19061dc37a289d16f2ffacba6822621b368f121f163d4bd43f192
final state              b10c7e82b8693da5e58a63ea7c433120d5c0556269e44c1a75207b761e5c37f7
artifact manifest        641371b8f22cdd7589ce25194c8575fbfe3655e79187b20f9da89867fa4058eb
```

## Remaining gate

This proof closes the runtime-worker readiness defect; it does not authorize
the internal canary. The cache epoch observation window still has the hard
database not-before boundary `2026-08-31 10:12:57.166559 UTC`
(`12:12:57.166559 Europe/Paris`). Until it is completed through its explicit
operator gate, the Provider Access rollout and all nine feature flags remain
OFF.
