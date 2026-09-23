# Gateway production reference — 24 September 2026

## Scope

Reconcile the deployed Gateway source and playback Edge entry point with main. Source snapshots came from the existing production deployment; this change does not activate features or deploy services.

- Gateway: 31 substantive source differences after CRLF normalization (23 missing modules, eight changed modules).
- Playback Edge: restored native MP4 grants, private resume identity, HLS cohort routing, M3U episode resolution and deployed receipt behavior with four missing shared helpers.
- Deployment health gate: exact playback version 82, matching the candidate.
- Existing tests now execute the corresponding current modules. Preserve provider ownership, serialized upstream access, terminal errors, abort/drain ordering and opaque grants.

## Verification

- Gateway/playback regression: 992 tests; 984 pass, zero fail, eight skipped. Runtime: 90.6 seconds. Native/platform-specific skips are not production evidence.
- Four additional M3U ownership tests pass: visible owned source, same-generation parent, URL hash and source-type binding, unavailable/wrong-owner rejection, database failure closed.
- No runtime deployment performed by this reconciliation.

## Remaining gates

Review the complete source diff and CI; inspect all imported-module dependencies against production; reconcile container build inputs and both server mounts/configurations; rebuild and compare before deploying. The tests do not certify commercial signup/payment, ordinary-account real playback, Android distribution, shared-cache activation or capacity beyond the existing 20-viewer evidence.

## Complete-CI reconciliation follow-up

The first complete Linux run reported 28 failures among 5,057 tests. These were reviewed rather than treating the narrower regression run as sufficient.

- The deployed capture store/pipeline/passive collector lacked main's two-slot primary headroom. Restored these three files from main `257499b8`: speculative captures must not fill the same budget needed by the next current windows. This is an intentional correction beyond the runtime snapshot, not a test relaxation. The two-job, 48-window interleaving now completes with 32 synthetic acquisitions and 28,170,067 peak stored bytes. Capture/passive suites: 39 pass, zero fail, two platform skips.
- Updated exact version gates to 82, and isolated-function harnesses to import the actual added dependencies. Updated native heartbeat assertions for the narrow server-owned native-MP4 marker; entire provider hints remain forbidden. Series receipt assertions cover the generalized receipt fence and all five call sites.
- The route benchmark test now waits up to one second for the server to observe all peer socket closes after the dispatcher closes locally. Drain failure remains fail-closed; no timeout or release policy changed in production. Linux replay is required.
- Added the remaining deployed M3U parser dependency, including quoted commas and bounded fractional durations. All 47 transitive playback files now match the collected runtime manifest after line-ending normalization; none are missing.
- Replay of the previously failing suites: 220 tests, 216 pass, zero fail, four skips. A subsequent retained-TS profile regression plus M3U parser run: 13 pass, zero fail, one native FFmpeg skip.

No production deployment has been made for this follow-up. CI, build reconciliation, configuration harmonization, and the commercial end-to-end requirements remain open.
