# Shared R2 cache: runtime configuration and evidence

## Installed configuration

PR #376 merged as `bec7b3c7d93598f757c269e3b302c7ff0b287571`. All five integration/build checks passed. The encrypted provisioning workflow, run `35936081201`, executed that exact revision successfully.

At 23:58:22 UTC on 23 September, the existing Worker URL, service token, ticket key and coordination key were installed in `cloud_runtime_config`, marked secret. No keys were rotated or displayed. Both Edge replicas independently report Worker, ticket and coordination configuration present. Playback remains revision 83.

Global cache, singleflight and live-join flags remain false; the canary has zero users and stage off. The database admission policy is **shadow**, so it records recommendations but does not authorize publication. Storage configuration alone does not enable the product feature.

## Actual production Worker checks

- Gateway Node runtime authenticated to `/internal/v1/metrics`: HTTP 200, protocol 1. Both Gateways have matching Worker URL, service token and manifest key (compared without exposing values).
- Existing storage-protocol fixture: seven files; cold R2 and hot CDN hits; audio/subtitle bytes preserved; anonymous access denied; corruption quarantine and recovery succeeded; global purge removed eight objects.
- A newly generated six-second 160×90 H.264/AAC clip was encoded using one CPU thread. Its actual full source hash and ffprobe output supplied the object identity. Source size: 113,022 bytes.
- Four real HLS files were published and downloaded from production R2 with identical bytes. FFmpeg decoded **6.037333 seconds** of video and audio.
- Anonymous access returned 401. A ticket for another object returned 403. After session revocation, the previously valid ticket returned 403.
- Five clip/cache objects were purged globally. The intentional session-revocation tombstone remains. No provider catalogue data or customer media was used by these generated fixtures.

The reproducible playable diagnostic is `ops/cloudflare/media-cache-playable-smoke.mjs`. It runs inside the existing Gateway image (`/app/src` modules and FFmpeg), receives dedicated keys through environment/stdin from the deployment host, and purges only its uniquely generated object. Never print the key environment or put it in command arguments.

## Current database authority checks

`ops/hetzner/media/run-media-cache-authority-runtime.sh` copies the current production **schema only** to an isolated PostgreSQL container, with network disabled and no client data. Its fixture executes actual production function definitions.

**16 checks passed:** separate owner bindings for the same global object, successful authorization for both owners, rejection of another owner's session/source/variant, rejection of another object or changed target hash, rejection of withdrawn titles and disabled sources, continued access for the unaffected owner, and grant revocation on session closure.

The schema dump deliberately omits privileges. Effective RPC privileges were therefore verified read-only on production: anonymous and authenticated roles cannot execute the grant RPC; service_role can. An initial fixture failure caused by omitted dump ACLs was corrected in the harness, without changing production permissions. The fixture was also aligned with the actual `cloud_sources.display_name` and `config_hint` columns.

The disposable container and volume were confirmed removed. Production contains zero synthetic users, zero synthetic sources and zero registered cache objects after the tests. Schema-only restoration emitted unrelated behavioral projection warnings due to absent business seed rows; this is not a full application replica.

## Remaining rollout gates

These results prove storage, decoding and specific database authority rules. They do **not** prove the complete Edge producer callback, exact binding publication from a real app session, an ordinary-account application cache hit, application stop/resume, or concurrent live sharing.

The current Edge shared-cache lane is restricted to exact Matroska VOD. Admission must be tested in enforced mode within a controlled account cohort before global activation. Existing native MP4 behavior is outside this shared-HLS lane.

The current browser session is signed out; the request to reconnect the authorized account remains pending. Ordinary-account signup/payment, Android playback/distribution confirmation and the other commercial-readiness requirements remain separate and incomplete.
