# Durable storyboards: recovery repair and remaining dependency

## Confirmed implementation gaps

The Gateway writes HMAC-signed storyboard checkpoints but never called `StoryboardStore.load()` during startup. Stored records also omitted `sourceId`, which is required by source activity and revocation checks. Renewed grants did not restore it either.

A separate integration gap was found: `renewDurableStoryboard` calls `POST /storyboard-renew`, but the current Edge router has no such endpoint. `catalog_storyboards` enqueue also does not persist enough owner/source/target context for safe renewal. The branch now adds that route and a migration for the renewal context. **Do not activate durable storyboards until the migration/runtime rollout and the actual application journey have been verified.**

## Recovery repair in this branch

- Restore signed records during bootstrap and on a bounded periodic sweep. Existing queue capacity applies; overflow stays on disk for a later pass. Active/queued IDs are not inserted again.
- Preserve source identity and saved progress across checkpoint/outbox saves.
- Keep transport URLs and upload grants out of checkpoint records.
- Renew source identity for legacy records through the verified backend grant. A grant cannot change a previously pinned source.
- Continue to use the normal scheduler, source admission and viewer-priority gates before any provider read.

## Verification

Five new behavioral tests passed: disk restart/frame recovery, bounded idempotent restoration, tamper/scope/callback rejection, legacy recovery without transport credentials, and renewal source pinning. Existing source-revocation and import-priority tests also passed (nine cases; fourteen distinct cases total).

These tests use actual disk checkpoints and extracted Gateway functions with controlled backend grants. They do not prove a deployed Edge renewal, an application thumbnail, or a real Gateway restart with provider work. No production code or activation changed in this step.

## Next requirements

Persist an owner/source/target-bound renewal context without provider credentials; authenticate the Gateway; recheck the current source and job before renewing short-lived transport/upload grants; invalidate frames on exact-target change; retain viewer/import priority. Exercise restart, source removal, changed credentials, terminal callback retry and actual app rendering on both Gateway routes before gradual activation.

## Backend renewal implementation

The branch now persists owner/source/container/duration at enqueue, without transport credentials. The authenticated renewal endpoint checks the live processing job, source ownership and enabled/deleted state, import and viewer gates, current provider identity and target. The returned grant expires after 15 minutes and hashes the exact URL plus encrypted source configuration into a frame binding. Source and job state are rechecked after grant creation. Temporary target resolution failure returns 503 for retry; revoked/replaced jobs return 410. New jobs use distinct sprite paths to prevent a delayed old upload overwriting the new artifact.

28 targeted tests passed across renewal, disk recovery, source revocation and import priority. Migration and real Edge/Gateway restart remain unverified; no production activation or deployment performed. Migration must be applied before the new Edge enqueue code.

## Current production schema reconciliation and runtime proof

The live database already has `job_user_id`, `job_source_id`, `job_container` and `job_duration`, including SET NULL owner/source foreign keys. The current deployed Edge has no corresponding enqueue writes or renewal route. The initial proposed new columns were replaced with these existing names, and the migration now also creates them on clean installations. No duplicate renewal columns are introduced.

The versioned runner supports `storyboard-renewal` as its argument. It restores only the current production schema into an isolated PostgreSQL container, applies the migration, then executes `storyboard-renewal-runtime.sql`. Result: `STORYBOARD_RENEWAL_RUNTIME_PASS`. Validated RLS enabled with no client policy, context persistence, soft-deleted source exclusion, rejection of nonexistent owner/source references, and the two SET NULL constraint definitions. Physical deletion itself is not claimed: production lifecycle guards require bounded account-deletion preparation, so the fixture uses the actual soft-delete eligibility rule instead.

The temporary container and volume were removed. Primary database healthy, restart count zero. A schema-only behavioral projection warning resulted from omitted business seed data; it did not affect these assertions. Receipt: `.codex-artifacts/commercial-readiness/storyboard-renewal/schema-runtime.log`.

All 28 targeted JavaScript cases passed again after the schema-name reconciliation. Actual Edge/Gateway renewal, process restart and app rendering still require runtime validation before activation.

## Real Gateway restart replay

`ops/hetzner/media/storyboard-restart-runtime.cjs` ran inside the production Gateway image `sha256:dbfaaea9a69b41d58543f00086427963a3d75e7bafd1e8e7718a27547ab67118`, with this branch's `index.js` and `storyboard-store.js` mounted read-only. The disposable container had no external network (`--network none`), one CPU, 2 GiB RAM and 128 PIDs. A local HTTP fixture supplied a generated 30-second clip and signed test grants; no customer source or production secret was used.

Three actual Gateway process starts succeeded:

1. The restored job renewed its grant, extracted two frames and committed the checkpoint. The process group was killed with SIGKILL.
2. A new Gateway process restored and renewed the same job, reused byte-identical frames, assembled/uploaded one sprite, and persisted its successful terminal result when the callback returned HTTP 503. The process group was killed again.
3. A third Gateway process replayed the pending terminal callback successfully and removed the durable record, without reading the media again or uploading the sprite again.

Receipt: 3 process starts, 3 media HTTP requests total (unchanged after the first extraction), 2 renewals, 1 upload, 2 terminal callbacks. Initial fixture failure was traced to missing HTTP Range support in the synthetic server and corrected there; no product workaround was added. The runner kills the complete child process group so FFmpeg cannot survive a simulated server crash.

This proves actual Gateway/FFmpeg restart and outbox behavior against a synthetic backend. It does **not** prove the deployed Edge renewal endpoint, provider access, app rendering, or global activation. Production remains unchanged. Receipt: `.codex-artifacts/commercial-readiness/storyboard-restart/runtime.log`.
