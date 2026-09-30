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
## Follow-up: stop demonstrably late token recovery

The WebView now bounds work for one native recovery token from its first JS
dispatch: **65 seconds on Android phone**, **30 seconds on Android TV**. These
values are the existing `PLAYER_RECOVERY_TTL_MS` constants in each native
`MainActivity`, including the phone code40 / TV code35 clients. No native class
or timeout was changed. The bounds apply to Live and VOD.

`MainActivity` starts its native clock **before** dispatching the JavaScript
callback. The JS deadline can therefore be later by the unknown dispatch delay.
This is a conservative stop for manifestly late automatic work, **not** an
acknowledgement that the native player accepted a replacement and not a guarantee
of cancellation at the Activity's 60-second / 25-second timeout. The phone
Activity can defer its own timeout across background/foreground transitions;
its host token TTL remains absolute. A precise native cancellation signal or
bridge acknowledgement would still be required to close that smaller gap.

- A retry with the same token keeps its first deadline. Replacing a token or
  ending its intent retires it; a bounded set of the last 64 retired tokens
  prevents delayed callbacks from rearming those requests.
- `performance.now()` supplies the monotonic clock when available. Older shells
  without it use one `Date.now()` deadline; wall-clock changes in that fallback
  environment are a remaining timing limitation.
- Tokens without a recognized phone/TV user-agent contract and tokenless legacy
  recovery receive no invented timeout. Their existing retry limits remain.
- The guard runs before scheduled work, after session release and catalogue
  preparation, after URL resolution, and at the native bridge. An exact owned
  receipt returned too late is expired without registering or launching it.
- Expired work cannot schedule another automatic retry or show a late recovery
  error. Existing strict release, route, intent and source ownership guards stay
  in place. The earlier exact-expiry failure / server TTL limitation still applies.

Verification: **151 tests passed, zero skipped** across the same six suites above,
including 21 new executable VM cases. The independent reviewer also ran those
21 cases successfully. Coverage includes both platform bounds; expiry while a
timer, strict release or resolver is suspended; before-bound delivery; same-token
retry; old/new-token isolation; retired-token dispatch; unknown/ambiguous platform;
tokenless legacy; final bridge refusal; monotonic clock under wall-clock jumps;
wall-clock fallback; and VOD release/preparation/resolution cleanup. These are
deterministic WebView bridge tests, not a substitute for the production phone replay.
