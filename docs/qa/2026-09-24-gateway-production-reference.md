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

## Rebuilt runtime reference

`services/media-gateway/Dockerfile.production-reference` replaces the entire application source tree on the immutable production codec image. It rejects package/lock drift before replacing any source. This preserves the deployed native dependencies instead of silently switching to the different current generic Dockerfile toolchain.

Build verified on the deployment host from Git archive `cfc5115c9e8631c06c95a2267e4463e646109405`:

```sh
DOCKER_BUILDKIT=0 docker build --pull=false --network=none \
  --build-arg NORVA_SOURCE_REVISION=cfc5115c9e8631c06c95a2267e4463e646109405 \
  -t norva-media-gateway:reference-cfc5115c \
  -f services/media-gateway/Dockerfile.production-reference services/media-gateway
```

- Built image: `dbfaaea9a69b` (local tag above).
- All 71 source files match the repository after LF normalization. The older count of 67 covered JavaScript files only; four Python files are also included.
- Against the immutable base image, substantive changes are the runtime `index.js` snapshot and the three primary-headroom fixes. FFmpeg, ffprobe, whisper-cli and the Whisper model SHA256 values match the base exactly.
- A fresh container, `--network=none --memory=512m --cpus=1`, successfully served health version167 with zero active sessions. No production configuration, owner data or mounts were passed to this startup check. This is not a playback/VAAPI validation.
- The digest is a local Docker image ID, not a registry manifest. The host's classic builder resolves it without contacting a registry. The first BuildKit attempt correctly failed to resolve a registry manifest; it did not build or deploy an alternative image. Rebuilding on another host requires saving/loading this immutable base image. A future builder migration must preserve this dependency explicitly; the classic builder is deprecated.

This build-stage statement is superseded by the production rollout below. Feature configuration differences remain open.

## Production rollout — 23 September 2026, 22:47–22:51 UTC

Both production Gateways now run image `sha256:dbfaaea9a69b41d58543f00086427963a3d75e7bafd1e8e7718a27547ab67118`, built from the reference source above. PR #372 is merged. Health version 167, VAAPI availability and encoder capacity eight were verified after replacement. The previous containers are retained stopped for rollback.

- Pilot replacement: `287fd8862e57c71507301de837adeaeda480a712ad330c86f02552bf6d958d93`.
- Main replacement: `b460b3aa4225a0568331efab5439e3d71627402f689bd18598710adf0a14b67c`.
- Environment and existing mounts were preserved. The pilot additionally persists `/tmp/resume-pilot` in a host bind mount; its old disk output was copied while stopped. This does not make the RAM-backed private HLS resume cache persistent across restarts.
- Main Compose image was updated and its rendered environment and mount set compared exactly with the running container. Protected backups containing deployment credentials remain only on the server.
- The deployment refused to stop main while a Whisper/LID worker was active, and proceeded after idle verification. The check-to-stop interval is not an atomic admission fence; do not claim a zero-race drain guarantee.

### Real post-deployment private resume

Two authorized internal owners were tested on each Gateway with their actual source profiles, without QA metadata overrides. All four cases passed private-cache validation, exact requested-offset reconstruction, cached-to-live segment continuity and cleanup of only the sessions created by these tests.

| Gateway | Owner A resume API | Owner B resume API |
| --- | ---: | ---: |
| Pilot | 2,242 ms | 7,550 ms |
| Main | 2,220 ms | 8,053 ms |

These are Gateway API and segment checks, not ordinary-account UI playback or Android end-to-end certification. They do not establish multi-audio coverage (each tested target had one audio track), shared R2 use, full feature/configuration parity, or a new concurrency capacity claim.

### Operational tools

`ops/hetzner/media/rollout-reference-gateway.py` defaults to a read-only plan; `--apply` performs this exact baseline-to-reference replacement. It preserves the deployment configuration, checks positive idle evidence, retains the previous container and does not retry ambiguous mutations. Four safety tests cover configuration preservation, drift detection, missing/busy counters and active viewer/native grants. The separate Compose persistence script is a one-time operation for the existing protected override.