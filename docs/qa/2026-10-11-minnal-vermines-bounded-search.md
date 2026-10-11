# Minnal / Vermines — bounded-search pilot, 11 October 2026

## Scope and status

Owner-only production pilot, PR772, revision `66a8bf12ffe087a8aabcafaffaab78c6a095ff5e`.
The candidate reduces the first MPEG-TS seek window to 256 KiB for eligible pilot owners. Lookbehind, exact-range validation, one provider connection and subsequent sequential growth remain in place. No MP4 change was deployed in this iteration.

This does **not** resolve the requested latency target. PR772 remains a draft. The candidate is running on the owner-only pilot; the main Gateway and both Edge deployments are unchanged.

## Production observations

### Minnal Murali, MPEG-TS

- At the same requested position, 4,444 seconds, Gateway readiness was 14,168 ms versus the preceding 15,177 ms. First segment: 13,508 ms. Provider interruptions: zero at inspection. The first resumed browser transition was not sampled, so no exact click-to-play value is claimed for this run.
- The video subsequently reached 145 seconds locally, with readyState 4 and continuous progression throughout the sampled 135–145 second interval. This is sampled continuity, not exhaustive freeze detection.
- A second, different out-of-cache seek (40% of the timeline) resumed at the first progressing sample at 20,073 ms. The prior playing resource was excluded from this measurement: it reset to time zero at 1,277 ms. At 114,020 ms after the action, local playback had reached 94.224 seconds, readyState 4, no media error and buffer through 214.065 seconds.
- Smaller reads reduced individual binary-search ranges but did not remove the serial position search or demonstrate a substantial user-visible latency gain.

### Vermines, MP4

- Warm reopening: first progressing sample at 10,193 ms. About 25.5 MB of input were seeded from cache.
- Progress was continuous in the sampled initial interval and again from elapsed 94.665 to 131.104 seconds; no media error. The unsampled interval prevents an exhaustive no-stall claim.
- The browser briefly exposed separated buffered ranges; these merged during the earlier opening. A buffered-range hole alone is not evidence of a playback stall.
- Transport traces show additional reads at the beginning of the MP4 before the browser requests the resume position. One speculative initial request was superseded after receiving approximately 1.17 MB; only complete validated windows are retained.
- Incomplete metadata retention is a hypothesis, not yet proven. Do not retain arbitrary partial HTTP responses or weaken file revalidation on that basis.
- The 10.2-second result cannot be attributed to a new MP4 fix: cache warmth, position and delivery variability differ.

## Checks and evidence

- Focused regression tests: 174 passed, six optional skips.
- CI run 38118048023: cloud contracts, Android phone, Android TV and Windows packaging all succeeded.
- Image canary and GPU encode passed before pilot deployment.
- Pilot image: `sha256:af207134067f495e533de902103d18c25d0ef4de84d27c5cb93529eb1ee3de8d`.
- Previous pilot retained as rollback container `norva-resume-cache-pilot-20260916-rollback-small-ts-20261011`.
- Local sanitized transport receipts: `.codex-artifacts/startup-cache-20261010/continuity-debug.remote.py.safe.json`, `small-mp4-traces.remote.py.safe.json`, `small-ts-apply.remote.py.safe.json`, `final-status.remote.py.safe.json`.

At closure, the agent exited playback through Home. Both Gateways and Edge replicas were healthy, public sessions and raw pumps were zero, background admissions were restored and the language worker was running. No support message, proxy change or global rollout was performed.

## Remaining work

Confirm the MP4 metadata byte boundaries before changing initial-read caching. For TS, measure how much of the remaining time belongs to serial timestamp search versus delivery; a validated position index would avoid searches only where suitable evidence exists. Neither item is claimed repaired by this iteration.

## Follow-up: complete MP4 metadata windows (same day)

Revision `00a9dcba34c808ef58b7c27a3c5f75eea874fee3` adds a bounded top-level `moov` scheduling boundary. On the native MP4 pilot route only, an exact provider response finishes at that boundary before reading media speculatively. It does not accept partial responses, weaken validators or infer playable coverage from a declared box size. Split headers, unsupported layouts and byte-identical full/cached broker reads are tested: 167 tests passed, five optional skips.

After CI contracts and the isolated image/GPU canary succeeded, the owner-only Gateway was updated to image `sha256:c368c08efa3471e267dccc13bd4f54f592f1cf6f61d8d76162ed688b0a3ec152` at 06:46 UTC. Edge code had independently changed and its routing listed two owners; those changes were preserved. The Gateway cache flags still list one owner. Neither Edge replica nor the main Gateway was redeployed.

### Vermines: real metadata loss confirmed and repaired

The first production read now completes bytes 4,456,448–5,558,469 (1,102,022 bytes), exactly finishing the metadata. Previously a larger range at that location was superseded before completing, so its metadata suffix was not retained. Speculative bytes after the metadata can still be abandoned normally.

- Cold post-restart opening: first progressing browser sample at 31.323 seconds (telemetry first frame 31.142 seconds). This remains slow and is not a cache-hit result.
- Warm reopening: first progressing sample at **5.523 seconds**, with **12,112,070 cached bytes seeded** and 62 cache hits by closure. The initial metadata suffix was not fetched again; the first subsequent provider range begins at byte 5,558,470.
- Playback advanced from 1392.271 to 1507.608 seconds by elapsed 120.857 seconds. All post-start samples had readyState 4, with no equal-time pairs. Sampling has gaps between tool calls; this is not an exhaustive event-based guarantee.
- Initial cached/read-ahead buffer ended around 1446 seconds, so the observed progression extends beyond it.
- A buffered 10-second backward seek was already progressing at the first sample, **320 ms** after the action.

### Minnal: still not resolved

A post-restart opening took **21.353 seconds**. A subsequent out-of-cache seek to exactly 4,444 seconds first progressed at **16.859 seconds**. Gateway readiness was 10.681 seconds, first segment 10.161 seconds, with zero interrupted provider ranges at inspection. The same multi-step timestamp search remains; shorter network responses contributed to the difference from the preceding 20-second run. No new TS acceleration is claimed from this MP4-only correction, and no general rollout is justified.

PR772 remains a draft. The production pilot contains the MP4 correction; remaining latency and broader repeatability are still open.
