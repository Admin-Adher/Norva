# Durable storyboards: recovery repair and remaining dependency

## Confirmed implementation gaps

The Gateway writes HMAC-signed storyboard checkpoints but never called `StoryboardStore.load()` during startup. Stored records also omitted `sourceId`, which is required by source activity and revocation checks. Renewed grants did not restore it either.

A separate integration gap remains: `renewDurableStoryboard` calls `POST /storyboard-renew`, but the current Edge router has no such endpoint. `catalog_storyboards` enqueue also does not persist enough owner/source/target context for safe renewal. **Do not activate durable storyboards until this backend dependency and the actual application journey are implemented and tested.**

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
