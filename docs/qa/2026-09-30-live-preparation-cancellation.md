# Live preparation cancellation — implementation in progress

## Observed defect

On the physical phone (Norva 1.3.27/code40), TF1 rendered successfully after the
previous global deployment. A separate Back-before-image replay exposed a
different lifecycle defect:

- Play: 2026-09-30 17:18:49.526 UTC.
- Back: 17:18:52.117, while recovery was still visible without an image.
- The direct session closed 1.413 seconds after Back.
- The HLS request already in flight kept preparing, then returned at 17:19:43.863.
- Its late receipt was rejected and closed at 17:19:44.557, **52.44 seconds after Back**.
- No native first frame, heartbeat or later relaunch occurred. Resources were
  empty during the follow-up observation to 17:20:42.

This is an excessive supplier-slot retention during unresolved creation. The
published intent guard already prevented a late Activity relaunch, but waiting
for the final session receipt was insufficient to release the upstream promptly.

## Client contract

For a cancellable Live resolver, acquire an authenticated preparation receipt
before requesting playback. Back, a newer intent, route departure and recovery
deadline cancel the exact receipt. A subsequent request in the same owner and
device scope waits for explicit producer drainage. A failed cancellation stays
pending and can be retried; a 404 or merely accepted cancellation is not proof
of release. No legacy endpoint fallback is used for this protocol.

User token rotation remains supported for the same principal. Cleanup retains
the original user/device authority; switching accounts neither transfers that
authority nor blocks the new account on an old account's cancellation failure.
Late final receipts are still expired as a second cleanup path.

The native recovery resolver now supplies its AbortSignal. The initial
ChannelList resolver does not yet supply one; no whole-first-click cancellation
claim is made by the client unit tests. VOD creation retains its existing flow.

## Local verification so far

137 focused tests passed with no skips in the combined client/receipt/native
recovery run. One additional account-change-before-prepare-return case was
then added; its 16-test cancellation/authentication set passed. Counts refer to
tests, not device playbacks, and overlapping runs must not be summed.

Covered races include Back before prepare returns, Back while session creation
is unresolved, 202 drainage polling, malformed/missing drainage acknowledgements,
later explicit retry, stale receipts, account/device scope, token refresh,
navigation, newer intent, older Activity close and native recovery deadline.

The combined native recovery group passed 186 tests with no skips. The actual
SQL migration passed 10 PGlite tests. Gateway process, upstream drainage and
restart evidence are recorded separately in `2026-09-30-live-inflight-cancellation.md`.
The complete local regression pass exposed obsolete version/extraction assertions
and Windows tool resolution prerequisites; those are being replayed explicitly,
and the complete Linux CI remains a release gate. Deployment and physical replay
are still pending. This report does **not** claim the correction is live.
