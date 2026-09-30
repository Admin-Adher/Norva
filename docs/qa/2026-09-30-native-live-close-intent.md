# Native Live: cancel pending recovery when the viewer closes playback

## Observed defect

The phone trace on 2026-09-30 showed a TF1 HTML refusal followed by an unresolved
recovery request. After the native terminal screen and Back at approximately
16:06:40 UTC, another cloud session was created without a new viewer action.
A later automatic retry became ready but was never rendered. This change does
not claim to repair the provider or the independent native 60-second timeout.

`releasePreviousLiveSession` removed the session from the active Live registry
before awaiting the replacement. Unlike VOD, Live kept no durable association
between that outgoing session and its launch intent. `onPlaybackClosed` could
therefore expire the old UUID without invalidating the pending Live launch.
The Live resolver also lacked post-await intent checks; its retry catch checked
only a nonempty recovery token.

## Changes

- Retain at most 64 Live session-to-intent associations after registry removal.
- Check the exact intent, route and recovery token before and after asynchronous
  release/resolution; expire a stale replacement by its exact owned session ID.
- Prevent retries after a cancelled intent, including legacy requests with no
  recovery token. Keep the existing retry limits and the strict release barrier.
- Expire a returned session before retrying when its URL is missing or the local
  native launch guard refuses it; register only an accepted native launch.
- Clear the closed Live intent's Playing state while preserving the guide's
  preview selection. A later Play is protected even if it reuses the same channel
  object. Retire a cancelled initial pending selection before ChannelList can
  commit it after `play()` settles.

Current phone and TV close policies emit `closed`, `recovery_abandoned`,
`terminal`, `offline`, `ended` or navigation reasons. The TV close policy has
never supported a `retry` reason, including its introduction in `fbebb1a7`.
The earlier VM fixture's close-then-retry scenario was replaced with an old
Activity's close followed by the newer intent's recovery. Its exact-expiry
barrier is still asserted. Legacy TV recovery without a close remains tested.

## Verification

130 Node tests executed successfully, zero skipped:

```text
tests/native-live-close-intent.test.js
tests/native-playback-recovery.test.js
tests/android-phone-native-session-contract.test.js
tests/android-tv-player-contract.test.js
tests/live-loading-feedback.test.js
tests/live-browse-intent.test.js
```

The 18 new VM scenarios execute the production standalone bridge. They cover
Back before the timer, during release and during resolution; successful and
rejected late responses with or without a token; route/token replacement; old
close versus newer source and reused channel object; exact cleanup failure;
refused/missing-URL launch cleanup; and legacy recovery. The initial cancellation
test also executes the real ChannelList commit/failure methods. Whitespace checks
passed. No provider request, phone operation or production change was used for
these tests. Runtime replay remains a deployment gate.

## Remaining boundaries

- Native `playVideoJson` returns void. A native recovery timeout at 60 seconds
  does not yet notify JavaScript that its token has been abandoned while the
  Activity remains open. The Back tests do not validate that separate case.
- If exact expiry of an undelivered late receipt fails, it is not acknowledged
  and automatic retries stop, even while the viewer's intent is still active.
  Since Android never received that UUID, its
  durable close queue cannot retry it; the server TTL remains the final cleanup
  fallback. The failure test asserts isolation from newer sessions.
