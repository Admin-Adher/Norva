# Recent delivery target — 7 October 2026

## Scope and current status

Follow-up to PR 693, integrated by PR 696 and deployed on the existing pilot. The recent-resume pilot remains owner-scoped. No broad rollout, timeout increase, buffer reduction, proxy change, parallel provider connection, codec change, or extension of the ten-minute cache lifetime.

## Evidence

The evening Normal and Severance failures are preserved in `2026-10-07-resume-evening-recheck.md`: both failed before a first frame, with zero generated segments after sixty seconds. The earlier recent entries had expired. The internal cause of delivery variability remains unassigned.

At 17:24–17:25 UTC, two sequential bounded reads of the exact 2 MiB Normal range were performed under an ordinary direct claim, pinned HTTP CONNECT slot, independent 0.5-second heartbeat, fail-closed one-second timeout, and normal expiry. System libcurl: 5.050663 seconds. Isolated production Undici: 2.82840439 seconds. Both delivered identical bytes, SHA-256 `dbc0fa8dcb5298e8e2db87171a7cf174eef2555180b504b841401f87e12069dd`. The same range previously took 14.841 seconds. This is evidence of variable transfer time, not proof that the proxy or Norva is the root cause. Both comparisons share the same network path. Two initial GET invocations, not necessarily two HTTP requests including redirects. Temporary media, headers, helper and ordinary claim were cleaned up/expired.

## Candidate correction

The earlier strict rejection of a newly minted delivery path remains correct. Instead of weakening that check, retain the previously authorized resolved URL privately in the existing owner-bound cache, for at most ten minutes and one validation attempt. It is an opaque in-memory handle, never returned by diagnostics or public APIs. Owner, source URL, current source/configuration/profile binding, exact file size, user agent and pinned route must match. The current ordinary playback claim is still required.

Revalidation uses four fresh serialized 64 KiB ranges and the existing eight-second budget, matching the same delivery target and exact file size. Only the existing cache lease can approve the four byte samples. An expired/refused/changed target, changed body, timeout or cancelled session cannot authorize old bytes. Ordinary playback resumes after drainage on a miss.

The freshly read header and validated target are handed to the continuation broker after all four reads drain. This avoids resolving a second temporary URL between validation and the actual input continuation. A fresh header is not proof that old cache data may be reused.

## Verification before deployment

- Focused local suite: 293 tests, 287 passed, six skipped, zero failures. Groups overlap older tests.
- Fifteen selected local tests pass, including actual loopback HTTP with rotating targets, changed bytes, changed size, expiry, redirect rejection, single active request, and normal fallback after an expired hint.
- Initial local failure was a VM fixture missing the newly extracted route helper; fixture corrected, production code unchanged for that repair.
- No provider request from these tests.
- Server canary: fifteen tests passed under UID 1000, isolated network, no production volumes and real GPU. No provider I/O. Removed after proof. All five checks for code `bb25007ed` now pass, including Android Phone/TV and Windows packages. They were still building when the cloud-contract gate allowed integration.

Private operator evidence: `.codex-artifacts/resume-transport-proof-20261007/` and `.codex-artifacts/recent-delivery-target-20261007/`. Consumed transport operator must not be replayed.


## Deployment and real replay, 17:52–18:08 UTC (19:52–20:08 Paris)

PR 696 is integrated by `87a51a59f63f5183142bfc5d0d3c89c12baa6556`. Image `sha256:c8a56fa6dca348a4727c1eee8ccb6145b9c8185b867e54e134b0ffac95ea2c43`. Three existing Gateway sources changed and one module was added; 84 pre-existing files preserved, 88 files verified on both replicas. All 194 Edge files, permissions and container identities remain unchanged. Admission pause **10.641152 seconds**, natural drainage, no forced lease; admission, worker, cron and the existing dispatcher restored. Pilot remains owner-only with the same ten-minute sampled TTL and 256/64 MiB aggregate/entry limits.

| Exact tested copy | Position | First frame | Effective start | Outcome |
|---|---:|---:|---:|---|
| Normal 4K FR HDR, cold | 472 s | 28.163 s | Not reached | After 170.5 s, video still paused at relative zero with 60 s buffered; operator stopped normally. No eligible recent entry, so no claimed warm Normal result. |
| Severance FR S1E1, cold | 927 s | 45.594 s | 101.233 s | Actual play, then normal exit. 64 MiB input entry retained. |
| Same Severance, recent reopening | 992 s | 10.904 s | **11.086 s** | Hint used, exact size/target and all four fresh samples matched in 5.771 s. 64 MiB really seeded. **Subsequent rebuffering occurred.** |

The different positions and variable transfer rates prevent claiming a general speed multiplier. Initial warm preparation was 8.375 s, including 2.524 s FFmpeg readiness. Continued requests reused the same target with no redirect; the broker proceeded beyond the retained input and completed new 6–8 MiB ranges. Eight-MiB responses in the observed continuation varied from 3.572 to 21.833 s. The MKV broker forwards chunks while receiving the range; it already avoids withholding a whole 8 MiB response before decoding. No redundant buffering patch was applied.

**Continuity failed the extended test.** At 18:02:11.883 the browser was paused at 59.933878 s with about four seconds ahead; it later resumed. At 18:06:22.654–18:06:42.202 it remained paused at 145.951 s. This is not a fluid five-minute playback result. A `readyState` of four or no media-element error does not erase those waits. The fast initial production rate (12.012x, fed by retained data) also does not certify the subsequent delivery rate. Do not extend this evidence into a general rollout recommendation or a guarantee of steady streaming.

Local samples from the cold runs: AAC-LC, 48 kHz, stereo; 48 video frames each, maximum interval 42 ms, zero decoder diagnostics. These are short output samples, not a full-film or warm-continuation audio certification. No source copy, audio selection or subtitle selection was silently substituted.

At 18:08:40, all three operator sessions are expired and the browser is back on Movies. Both Gateways are healthy. A separate global session remains active and was preserved; this is not a zero-global-playback claim. The one-shot transport marker remains consumed. No new background test or hourly schedule was created.

The cache-target correction is functional and the faster Severance reopening is measured. Normal cold-start delay and sustained fresh-delivery variability remain unresolved. No diagnosis attributes the latter specifically to provider storage, the common proxy or their route without additional evidence.
