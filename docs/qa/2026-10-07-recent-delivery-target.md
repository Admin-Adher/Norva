# Recent delivery target — 7 October 2026

## Scope and current status

Candidate follow-up to PR 693. The recent-resume pilot remains owner-scoped. No broad rollout, timeout increase, buffer reduction, proxy change, parallel provider connection, codec change, or extension of the ten-minute cache lifetime.

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
- Server canary, deployment and real VOD results: pending; do not infer a speed gain from synthetic tests.

Private operator evidence: `.codex-artifacts/resume-transport-proof-20261007/` and `.codex-artifacts/recent-delivery-target-20261007/`. Consumed transport operator must not be replayed.
