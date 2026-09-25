# Mobile production verification — 25 September 2026

## Published version and physical device

- Play Console submission 20: **Norva Mobile 1.3.22 (35)**, published 25 September at 10:43 (Console display).
- Xiaomi 2412DPC0AG, Android 16, USB debugging authorized by the owner.
- Replaced the formerly sideloaded Google-signed APK through **Update from Play**. Android now reports both installer and initiating package `com.android.vending`; the application opens successfully and retains its account/catalogues.
- The Play account remains enrolled as an internal tester. Version 35 is also publicly released; this is not proof of acquisition by a new customer outside the testing program.

## Observed playback

- South Park Guerras do Streaming: two actual native first-frame events at 10:45:21 and 10:48:23 UTC, measured by Media3 at **1,658 ms and 1,017 ms from native player launch**. Both sessions use the direct provider route.
- Second Continue Watching touch at device epoch `1790333301.551`; ExoPlayer initialization at `1790333302.511`; first video output rendered at `1790333303.324`: **1.773 seconds touch to first decoder frame**. The actual display was also inspected.
- The owner independently exercised timeline jumps and reported instantaneous response. Those manual seeks are not attributed to automation or used as controlled timing samples.
- A newly imported, owned 60-second synthetic MKV also plays in the production application: **1,091 ms native launch to first frame**, actual moving test pattern inspected.
- Pressing Home during that synthetic playback and reopening the application preserves playback in Android's floating picture-in-picture window; the moving test pattern remains visible above the catalogue. Full-screen expansion was not included in this observation.

## Confirmed HTML refusal fix

The prior physical MAX OTT test returned HTTP 206 with an HTML refusal page. The native recovery ladder treated its parse failure as recoverable and delayed the terminal UI.

- Inspect at most 256 bytes only when the HTTP response declares HTML/XHTML.
- Require an actual HTML document prefix before rejecting it. Replay all peeked bytes unchanged when a real video was mislabeled HTML; normal media responses incur no prefix read.
- Surface the existing actionable provider-no-playable-data message, preserve explicit Retry and Back, and stop automatic Media3/provider session retries for this confirmed refusal.
- Do not follow another route to evade provider restrictions.

Verification: **38 JVM tests passed**, plus four API 35 instrumentation tests, at font scale 1.3: ordinary H.264/AAC first frame, playable video mislabeled HTML, player controls, and HTML terminal state with one request, explicit retry with exactly one additional request, and Back. Final instrumentation result: **4 passed in 48.818 s**. Early emulator runs during boot were unstable; one process crashed and subsequent strict latency checks failed under system-wide boot broadcast contention. Waiting for the Android broadcast queue to become idle made the unchanged latency gate pass.

This native fix is prepared as **1.3.23 (36)** in [PR #414](https://github.com/Admin-Adher/Norva/pull/414), separate from the installed Play version 35; publication has not yet been completed.

## Cache verification: concrete remaining blocker

The current phone account has no active real-film R2 binding. Its previous synthetic test binding was revoked during prior cleanup. The direct South Park results therefore do **not** validate R2 playback on this phone.

An owned synthetic source **Test mobile Norva** was imported through ordinary source APIs. The playlist explicitly declares its movie type. No database cache binding, entitlement, catalogue profile or rollout flag was manufactured or altered for this test.

Preparation requests fail with `PROVIDER_CONNECT_TIMEOUT` (502). The same public synthetic asset is readable directly from both Gateway containers (HTTP 200, 2,848,920 bytes, Matroska magic verified). Through the configured HTTP relay, both requests time out; a TCP connection to that relay also fails. There is currently one configured relay endpoint. The relay needs recovery before this can be counted as a physical shared-cache success.

The runtime Compose labels identify the September 19 NodeMaven deployment. The existing NodeMaven console confirms one active HTTP proxy subscription, due October 16, 2026. Its own **Check proxy** action also reports **Timed out connecting to the proxy or probe host**. The configured endpoint matches the subscribed endpoint. One free IP swap is available; replacing it is pending the owner's decision. No proxy credentials or routing configuration have been changed.

The temporary source is retained only while the active test is being resolved. Native Google Play promotion campaigns remain deferred, and no paid subscription or renewal was activated.
