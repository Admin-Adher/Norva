# Gateway rolling-window audio recovery — 24 September 2026

## Observed production failure

On the internal Google-authenticated account, Creed II (Norva Selection, PT/EN MKV) displayed decoded video at 0:40. Selecting English while paused timed out after eight seconds. Resuming advanced to 604 seconds without a viewer seek. The main Gateway had matching 64-segment audio/video playlists, media sequence 439, approximately 128 seconds of retained media, without EVENT/VOD playlist type. The web player allowed up to 600 seconds of forward buffering. This establishes that downloaded video can outlive the corresponding alternate-audio window; it does not prove that every audio failure has this cause.

## Deployed code

- Cap Gateway forward-buffer growth at its configured 120 seconds (local transcoding retains its existing policy).
- Before an audio switch, detect a rolling video or selected-audio window whose first retained fragment is after the current position.
- In that case, use the existing serialized exact-track Gateway restart and provider release barrier, with an explicit absolute-position/autoplay snapshot.
- An unconfirmed switch uses the same captured snapshot instead of trusting a position potentially changed by hls.js. The snapshot also protects resume/history writes while the old media clock is unreliable.
- A confirmation accompanied by a timeline jump cannot promote the requested track as active; it initiates the same recovery.
- Successful in-window switches keep the existing session and exact stream mapping.

## Evidence

69 focused tests passed across watch-gateway-multi-audio, watch-hls-back-buffer, watch-gateway-startup-buffer and vod-selected-subtitle-lane. New regressions cover paused/playing intent, nonzero session offsets, expiry before selection, timeout after a jump, a confirmation after a jump, and prevention of a false resume/history position during recovery. The actual Gateway restart method is also checked against a captured position differing from the current media position.

PR #379 was already merged as `e4448b2f3ad2f4773021d584e6799dac6fa48c4e`.
Its Build Norva `35943022415`, Partners integration `35943022390`, and Android
emulator QA `35943022375` workflows passed. The emulator job ran phone tests
under three-button and gesture navigation and TV tests; its WebView case
exercises the switch/recovery contract with a simulated HLS window, not
decoded provider playback. Cloudflare Pages workflow `35943585274` completed
successfully for the merge. The live `/app` page references
`/js/pages/WatchPage.js?v=0221513b25`; that versioned URL serves the recovery
code and its hash matches the merged Git file. An unversioned direct asset URL
can still return an older immutable CDN object, but the application does not
reference it.

## Still required

The code is deployed, but the original Creed II failure has not yet been
replayed successfully in the real application. Repeat paused and playing
language switches, confirm the requested track and stable timeline, then
stop/resume. Replay decoded playback on Android as well. The non-internal QA
account still lacks an entitlement pending its customer-controlled payment
check, so its catalogue/filter success cannot establish this playback result.
A recovery requiring a new provider session may be slower than an in-window
switch. The buffer cap alone is not a guarantee that every target remains in
the server window; recovery is still required.
