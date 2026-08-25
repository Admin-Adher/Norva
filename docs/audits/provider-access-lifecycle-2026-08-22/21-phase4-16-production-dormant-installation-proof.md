# Norva Provider Access — Phases 4–16 dormant production installation

Date: 2026-08-24

Initial published source: `57af9f761c65676864acc74f665dffeb570877cc`

Current dormant production source: `d7d8725bec5d9c4a5e64efd1ea2feeb39d1bf26f`

Status:

```text
PHASE_1_3_PRODUCTION_CORE_INSTALLED
PHASE_4_16_PRODUCTION_SCHEMA_INSTALLED
PHASE_4_16_PRODUCTION_EDGE_INSTALLED
PHASE_9_16_PRODUCTION_WEB_INSTALLED
PHASE_16_EXTERNAL_CHANNEL_GATES_PRODUCTION_INSTALLED
CACHE_EPOCH_V2_SEVEN_DAY_DB_GATE_PRODUCTION_INSTALLED
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

### Independent external-channel gate follow-up

On 2026-08-25, migration
`20260824170000_provider_access_rollout_channel_gates_v1.sql` was installed
after its `33/33` PostgreSQL acceptance and real two-session CAS proof. Its
installation only forced automatic detection, email and push to `false`; it did
not activate a cohort or create work.

```text
migration SHA-256
e2c54199501086b8a92d6b211d1fb61b25affa4a1e4144dabc5585dd2cea7e83

pre-deployment dump
/var/lib/norva-phase3-proof/production-deploy-d7d8725b/predeploy.dump
size 909699445 bytes
mode 0600
SHA-256 45c9d2ee6352df08137b54c0b4856887d03d9b393b4f202467453c4159e59d9c

migration log SHA-256
86f918ce129d61542b16452cd9eb14f78b743c979bf66a3c1b1c1d662245098d

post-install invariant artifact
/var/lib/norva-phase3-proof/production-deploy-d7d8725b/post-db-invariants.tsv
SHA-256 f8079e9342dd330bc02a502c6fa07ffef3dc6b4fe9911326029078fa7776ef12
```

The post-install production snapshot was:

```text
cache|installed|manifest NULL|completed_at NULL
rollout|off|1|0
flags|9|0
external_flags|3|0
channel_table|present
channel_rpc|present
channel_events|0
replacement_origins|0
replacement_cleanup|0
notification_rows|0
check_jobs|0
nonterminal_transitions|0
p0_assert|safe=true, stagingVisibilityViolation=0
```

### Database-enforced cache observation follow-up

Source `6e5a21c49aa7a741372a28a35383c00f7ae1a3e7` installed the
seven-day minimum directly in
`norva_complete_catalog_cache_epoch_v2_rollout(...)`. Production derives the
exact boundary from its real row:

```text
installed_at 2026-08-24 10:12:57.166559+00
not_before   2026-08-31 10:12:57.166559+00
```

Both the read-only production preflight and a direct transaction-scoped
service-role call refused early completion. Backup and evidence are recorded in
`23-cache-epoch-v2-observation-gate-proof.md`.

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

1. Wait until the database-enforced boundary
   `2026-08-31 10:12:57.166559+00`, then explicitly complete cache epoch v2
   with the reviewed manifest.
2. Record real legal-policy and operational approval references; test fixtures do not count.
3. Explicitly select the internal production account and activate only `INTERNAL`.
4. Observe real metrics with zero P0/invariant breach before each manual promotion.
5. Build and publish the signed Android Phone release before enabling push, because the WebView UI is already delivered but the new native FCM routing is not yet in a Play Store release.
6. Cohort activation must leave automatic checks, email and push OFF until
   their secrets, bounded workers/cron and individual readiness evidence are
   approved through the now-installed channel CAS RPC.

No direct feature-flag edit is an authorized substitute for the Phase 16 RPC and its gates.

## Incremental production-clone rehearsal after notification scheduling

The current production database was replayed into a fresh disposable Supabase
bootstrap, then advanced through the notification-cron migration. The harness
now freezes and reapplies the exact effective API ACLs, preventing bootstrap
default privileges from being mistaken for production grants.

```text
commit 84f8879f0aa3133b3f2877aa4350fc62dc8b8a2b
result PHASE123_PRODUCTION_CLONE_REHEARSAL_PASS
mode incremental
artifact /home/adrien/norva-phase3-proof/artifacts/prod-clone-notify-cron-v4
migration tree SHA-256
35f40d803a8905f8fb08341d49c4056cf64e6f941b15da96297772e09f38af93

production ACL snapshot SHA-256
5f0843d893bf34db7033bc33e46becc05a83f981a309079bda7763c6dc18ff5e
clone ACL snapshot SHA-256
5f0843d893bf34db7033bc33e46becc05a83f981a309079bda7763c6dc18ff5e
ACL diff SHA-256 (empty)
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

Final clone state stayed dormant: policy/access migrations present, zero legal
rows and grants, rollout `off`, nine flags with zero enabled, cache epoch still
`installed`, and zero Provider Access cron jobs.
