# Gateway v168 production rollout — 24 September 2026

## Version and build

At preflight, both production Gateways ran image `sha256:94e1082e39583680b7ecabfd6d2e37e28d8fd5a10c76d34f7c59c3d399e6b6a5`, source revision `b5e99f8efd3d353fe56f4b3f26d602d067f70058`, health version 167. The pilot already had a persistent `/tmp/resume-pilot` bind mount. Neither container had a `PROVIDER_ADAPTIVE_ROUTE_CANARY_*` environment variable.

Image `sha256:f523bc18cd0571a264a6c00e930502fbe2f728a937f6cb8f04c5362d47e98392` was built on the deployment host from the full `services/media-gateway` Git archive at `adacb6174dd7ec92a0f15410f9f2093d6db21543`, using `Dockerfile.production-reference`, the immutable production codec base, no network, and the package/lock equality gate. Between the deployed source revision and this source revision, the Gateway source changes are limited to the owner-scoped provider route canary in PR #397. A fresh container with no network and no production configuration served health version 168 with zero sessions.

PR #397 and the reusable guarded rollout tool in PR #398 both passed their complete Build Norva CI workflows. The route tests passed locally, including 107 Matroska pump cases after the isolated harness correction. A separate Windows full-suite run had four platform-specific failures; the Linux CI regression job passed.

## Deployment, 07:12–07:18 UTC

The rollout tool's read-only plan passed on both nodes, checking exact current image, source label, idle counters, debug sessions, native grants, and preserved configuration. It reported no environment changes and no additional pilot output mount. The pilot was replaced first, then the main Gateway after its active web QA session had closed. Each replacement passed the target health contract and retained the previous container stopped for rollback.

| Node | Result | Receipt |
| --- | --- | --- |
| `norva-resume-cache-pilot-20260916` | v168, healthy; zero restarts/OOM | `/home/adrien/.norva/gateway-reference-rollout/20260924T071251145134Z` |
| `norva-media-gateway` | v168, healthy; zero restarts/OOM | `/home/adrien/.norva/gateway-reference-rollout/20260924T071543096238Z` |

Both live containers then reported the same exact image and source revision, zero active sessions, a ready VAAPI encoder, and `canaryShadowApply=false`. The pilot's existing output mount remains present. The main Compose override's image pin was changed from the previous image to the new image, with a protected backup retained at `/home/adrien/.norva/gateway-v168-adacb617-20260924/override-before-v168.yml`. Its file hash changed from `92b44f9302c2077bd62ce6fd9b53874f7368347f9a030f4476424451d662691c` to `4d206963e2ba2a1d295600f9d198db4f275ddd3f82d30365f8725137f692e415`. The Compose render command needs deployment variables absent from the SSH shell (`MEDIA_GATEWAY_IMAGE`, then `RENDER_GID`), so a full rendered Compose comparison was not established by that command. The rollout itself compared the complete live Docker configuration, excluding the intended image and labels.

## Customer playback and limits

The ordinary QA account with an active seven-day trial opened an owned Norva Selection film on the web. After the main v168 rollout, it resumed at 0:52, displayed a real video frame, and advanced to 1:03. During playback the main Gateway reported one active session at version 168; the pilot reported zero. Closing the reader returned the main Gateway to zero sessions. This verifies one ordinary-account web playback and resume on main v168, not a film from the newly imported MAX OTT or Dino catalogues.

The pilot v168 has health, identity, mount, and idle proof, but no fresh real-provider playback proof in this rollout. Adaptive provider route recommendations remain observational: no owner canary flags were set or activated, and no global route selection claim follows from this deployment. Shared R2 playback cache, conversion sharing, Android playback, and the postponed 100-reader campaign are outside this rollout's proof.
