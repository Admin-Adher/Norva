# Storyboard persistence: production renewal and rollout

## Fresh production check, 25 September 2026

Both production Gateways run version 169 and image `sha256:62a8a0a8e01b96f7df184059911c9b54b9f7c87b67f281843d4a6443a1162e5e`. Their 67 JavaScript source files are identical. Storyboard persistence is disabled on both. The main node has its private storyboard volume mounted, but no configured directory; the alternate node retains a source canary without a configured directory.

The Edge renewal route and owner/source enqueue context are already deployed. An authenticated request for a nonexistent job returns 410. This supersedes the deployment dependency in the 24 September report.

## Actual production Edge and disposable Gateway replay

A 30-second generated video was uploaded to a temporary QA bucket and imported through the normal M3U source API into the existing **non-internal commercial QA account**. Its explicit movie metadata produced one visible film. No entitlement override or production feature flag was changed.

The test seeded only that synthetic film's processing job, then ran a disposable Gateway using the production image against the **deployed** Edge renewal, source admission, Storage upload and terminal callback endpoints. The container used one CPU, 1 GiB memory, 96 PIDs, no Linux capabilities, and the operator's unprivileged UID. No customer Gateway was restarted and no real provider connection was consumed.

Observed results:

- Invalid authentication: 401; a different owner: 410; current authorized owner: 200 with an exact-source grant.
- The first Gateway process committed three JPEG frames, then was killed with SIGKILL.
- A second process restored the job and its three byte-identical committed frames, renewed through the production Edge, assembled and uploaded the sprite, and completed the real database job.
- Renewing the completed job returned 410.
- The ordinary account's normal storyboard API returned `ready`, three tiles, ten-second intervals; the public sprite was HTTP 200 and a complete 13,774-byte JPEG.

The first fixture preparation needed explicit `media-type="movie"`; filename extension and a Movies group alone are deliberately insufficient VOD evidence. This was a fixture correction, not a change to product classification.

Private fixture state remains under `/home/adrien/.norva/storyboard-global-20260925`; local non-secret tooling is under `.codex-artifacts/storyboard-global-20260925`. Tokens and source credentials are excluded from reports.

## Progressive rollout implementation

`STORYBOARD_DURABLE_ROLLOUT_BPS` adds a stable owner cohort (0–10,000 basis points). It requires an absolute `STORYBOARD_PRIVATE_DIR`. Existing `STORYBOARD_DURABLE_SOURCE_IDS` permits bounded source canaries. Default remains disabled. Invalid configuration fails closed.

At 10,000 basis points, persistence admits valid authenticated owners without an internal-account or source exception. Admission does not grant data access: the existing source ownership, revocation, exact-file renewal, import/viewer priority, signed checkpoint and source-pinning checks remain in the execution path.

33 focused tests passed, including stable and monotonic cohorts, malformed configuration, global admission, source pinning in global mode, restart recovery, foreign-owner denial, source removal, import and viewer priority.

## Remaining before global activation

Replay the new global admission against the real Edge, deploy and verify both routes, observe the thumbnail in the application, and verify persisted deployment configuration. The completed runtime replay alone does not certify application rendering or global activation. Android startup optimization remains a separate release: 1.3.26 (39), still under Google review at the latest check.
