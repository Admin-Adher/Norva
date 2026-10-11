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
