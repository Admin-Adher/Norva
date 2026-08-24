# Norva Provider Access — Phases 4–16 dormant production installation

Date: 2026-08-24

Published source: `57af9f761c65676864acc74f665dffeb570877cc`

Status:

```text
PHASE_1_3_PRODUCTION_CORE_INSTALLED
PHASE_4_16_PRODUCTION_SCHEMA_INSTALLED
PHASE_4_16_PRODUCTION_EDGE_INSTALLED
PHASE_9_16_PRODUCTION_WEB_INSTALLED
PROVIDER_ACCESS_ROLLOUT_OFF
PRODUCTION_USER_ACTIVATION_BLOCKED_UNTIL_CACHE_GATE
```

## Safety boundary

This was a dormant additive installation, not a cohort activation. The Phase 16 migration forced all nine Provider Access capability flags OFF and created the rollout singleton at `off`, revision `1`, zero basis points. No notification cron was scheduled and no email, push, provider request, replacement or catalogue mutation was triggered.

## Backup

Pre-deployment logical dump:

```text
/var/lib/norva-phase3-proof/production-deploy-57af9f76/predeploy.dump
size 931323240 bytes
mode 0600
SHA-256 46dd832e69823349738d3d3f459e60342b4cf6442701ca8fef9fcef6c6fc6121
```

The target directory was resolved and restricted to `/var/lib/norva-phase3-proof/production-deploy-57af9f76` before the dump.

## Database installation

The exact reviewed migrations `20260824110000` through `20260824160000` were copied to the production host, hashed against the local source and applied individually with `ON_ERROR_STOP=1`.

Installed boundaries:

- replacement handoff, rollback, cleanup and replay contract;
- Provider Access cycles, detection scheduler and calendar terms;
- durable notification outbox;
- aggregate analytics and P0 assertion;
- progressive rollout control plane.

Post-install production snapshot:

```text
rollout|off|1|0
flags|9|0
replacement_origins|0
replacement_cleanup|0
notification_rows|0
check_jobs|0
nonterminal_transitions|0
sources|10
p0_assert|safe=true, stagingVisibilityViolation=0
```

Invariant artifact:

```text
/var/lib/norva-phase3-proof/production-deploy-57af9f76/post-db-invariants.tsv
SHA-256 0d2293cec596a8933271ca32429a1024eae61916a9db9a4e3f596c26ac75022d
```

All ten migration logs are retained in the same directory with individual SHA-256 hashes.

## Edge installation

The clean production worktree was fast-forwarded to the published commit. Both Edge replicas were recreated from the existing reviewed compose definition and reached `healthy`:

```text
norva-edge-functions|healthy
norva-edge-functions-2|healthy
production worktree changes|0
```

Live negative-auth probes proved the new routes are loaded without revealing protected data:

```text
GET norva-provider-access/v1/rollout without JWT
→ HTTP 401 AUTHENTICATION_REQUIRED

POST norva-provider-access-notify/cron/drain without cron secret
→ HTTP 403 Unauthorized

POST norva-admin/provider-access-analytics without admin JWT
→ HTTP 401
```

## Web installation

GitHub Actions run `32749636836` deployed the Web application successfully to Cloudflare Pages. Public production verification returned HTTP 200 and the generated cache-busted assets contained the rollout-aware client and compact interactive calendar:

```text
provider-access-config.js?v=6012a648c5
cloudApi.js?v=66166ff720
api.js?v=86bd97d2ff
SourceManager.js?v=dcdaff3a87
app.js?v=2479544d89
main.css?v=a07d37b59c
```

The Web UI remains hidden for every user because the authenticated rollout status is `eligible=false` while the stage is OFF.

## Remaining real-production gates

1. Wait for the incompatible cache observation window to end around 2026-08-31 and explicitly complete cache epoch v2 with the reviewed manifest.
2. Record real legal-policy and operational approval references; test fixtures do not count.
3. Explicitly select the internal production account and activate only `INTERNAL`.
4. Observe real metrics with zero P0/invariant breach before each manual promotion.
5. Build and publish the signed Android Phone release before enabling push, because the WebView UI is already delivered but the new native FCM routing is not yet in a Play Store release.
6. Install the independently proved Phase 16 external-channel gate migration.
   Cohort activation must then leave automatic checks, email and push OFF until
   their secrets, bounded workers/cron and individual readiness evidence are
   approved through the channel CAS RPC.

No direct feature-flag edit is an authorized substitute for the Phase 16 RPC and its gates.
