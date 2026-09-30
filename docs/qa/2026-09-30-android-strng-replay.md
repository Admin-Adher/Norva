# Android Strng replay — 30 September 2026

## Scope and installed version

Physical USB phone, production account and normal Norva touch navigation. Installed package `tv.norva.phone`: **1.3.26 / code 39**. No APK, application data, subscription or provider credentials were changed during this replay. All tested sessions were closed through Android Back; the final database check found no non-expired session from these tests.

At approximately 10:39 UTC, Google Play Console showed **Mobile 1.3.27 (40), production rollout 100%, published about ten hours earlier**, with no unpublished changes. The user was asked to install that published update before the final replay. The results below must not be presented as a validation of code 40.

## Actual playback evidence

Times below come from native `first_frame` events, backed by visible advancing video on the phone. Native timing does not include all WebView work before opening the Activity and can differ from tap-to-picture time. Its event position defaults to zero and is **not** proof of a reset to the beginning.

| Source / title | Item | Catalogue container | Native first frame | Evidence |
| --- | --- | --- | --- | --- |
| Strng / Monkey Wrench S1E1 | 2120388 | MKV | 8,876 ms; about 17.1 s from the recorded tap | Direct session replaced by relay; advancing image; requested history 1,312 s, final saved position 1,411 s / 1,629 s. |
| Strng / Sharte Ezdeva | 100002 | MP4 | 13,477 ms; about 15.2 s from the recorded tap | Advancing image; initial saved position 311 s, final 334 s / 4,843 s. |
| Strng / A Very Merry Bridesmaid | 1220495 | TS | 16,438 ms | Advancing image; final history 131 s / 4,935 s. This is the TS-labelled catalogue variant; this replay alone does not independently certify the bytes' container. |
| Strng / BE: TF1 HD | 985192 | Live | 9,739 ms | Advancing programme image; direct attempt then server transcode transport; session expired at 10:38:05.462 UTC on Back. |
| MAX OTT / Monkey Wrench S1E1 | 1461413 | Separate provider version | 18,862 ms | Playback from the series detail page; distinct source/history from the Strng version. |

Strng successful session IDs: `614f0b6e-1f76-4383-91a0-f91418ede675` (series), `62c9ff1e-38ff-4310-bb15-2e0c71ea75ab` (MP4), `0d7d9c04-f1f8-4558-a854-0f5b8bc60ee9` (TS-labelled film), `424fb9ae-65a1-469b-b420-e7b63c4cce76` (Live).

## Remaining findings

- Captured native error during the film test: `BoundedRangeDataSource.HtmlResponseException`, confirming that a provider response contained HTML instead of media. No response body, URL or credential was retained in the log output. Successful relay playback is evidence of recovery, not evidence that the direct route works.
- Initial Continue Watching attempts remained on the catalogue despite server session creation. A later source-filtered replay opened correctly and resumed. The intermittent pre-launch behaviour is not explained or declared fixed; no speculative production patch was made.
- A second MAX OTT resume attempt remained loading and was cancelled. Its initial successful playback does not validate every later resume.
- Current phone code contains immediate handling of confirmed HTML refusals; the installed code 39 cannot be assumed to contain every later native change. Re-test code 40 before changing or certifying that behaviour.
- Native decoding, network relay and HLS transcode are distinct paths. VOD successes used relay recovery; TF1's successful session was marked transcode. This run does not establish an all-direct mobile path.
- No WebView FPS certification, TV-device replay, sustained concurrency test or universal startup-time guarantee is implied.

## Next replay

Verify installed code 40, then repeat a single tap from Continue Watching (with the source explicit), exact resume, Back/session release and TF1. Capture errors from the start of the attempt. Investigate any remaining pre-launch silence and the direct HTML response using those current-version observations.

## Code 40 replay — 10:52–11:00 UTC

ADB verified production **1.3.27 / code 40** after the user's update. Every launch below used one normal tap, with no manual retry. These measurements precede the new WebView fixes described below.

| Strng item | Tap UTC | First-frame event UTC | Tap to first-frame event | Native clock | Resume evidence |
| --- | --- | --- | --- | --- | --- |
| Monkey Wrench, MKV episode 2120388 | 10:52:28.325 | 10:52:39.570 | 11.25 s | 8.486 s | History 1411 → 1449 / 1629 s; advancing image |
| Pish Sharte Ezdeva, MP4 100002 | 10:54:14.427 | 10:54:30.732 | 16.30 s | 14.400 s | History 334 → 360 / 4843 s; image obtained |
| A Very Merry Bridesmaid, TS-labelled 1220495 | 10:55:21.978 | 10:55:41.962 | 19.98 s | 18.382 s | History 131 → 170 / 4935 s; advancing image |
| BE: TF1 HD, channel 985192 | 10:59:02.516 | 10:59:09.456 | 6.94 s | 5.210 s | Actual programme image, then Back |

First-frame event receipt includes telemetry delivery latency. Native clock starts once in `PlayerActivity.onCreate` and is not reset by in-place stream recovery. It excludes WebView work before opening the Activity.

VOD relay sessions: `ddbc316c-ad66-42fa-8a5f-ae84f6867b08`, `38bddb3c-0190-41dd-93bf-052301b64a34`, `ef49a706-b53b-4c18-b3f8-d882d8817d5e`. Live transcode session: `6af32c66-9a2f-498e-9eee-b6f9b8871cb2`. All three VOD sessions were confirmed expired after Back. Final Live release is checked separately below.

The direct series attempt again produced confirmed `HtmlResponseException` on code 40. Successful raw relay VOD playback does not imply direct access works. Code 40 changes TS extraction; HTML recovery already existed in code 39.

### Delay breakdown and changes

- Safe Edge startup phases took 478–564 ms; provider takeover/coordinator wait counters were zero.
- MP4 needed 3,780,512 bytes of tail metadata: that provider read took 7,135 ms. The broker streams data immediately; these bytes are not held until a complete 8 MiB window downloads.
- TS-labelled input made several timestamp-seek range reads and interrupted one larger continuation before closing. Increasing its grace timer is only a hypothesis and has not been deployed.
- A VM replay of the actual WebView bridge reproduced an independent bug: navigating away while cleanup/history was pending could launch the abandoned title; an older history result could adopt a newer action. Capture the action claim before the first await and reject stale stages. Four new regressions fail on the previous code.
- Skip the first HTML-confirmed recovery backoff (1,200 ms VOD, 250 ms Live), while still awaiting exact outgoing session expiry. Subsequent backoff, three-attempt budget, token/route/action checks remain enforced.
- 72 focused native-bridge and adjacent history tests pass. The changes are WebView JavaScript and require no new APK; production deployment and a refreshed phone replay remain to be recorded.

## Cross-device replay and bounded cache diagnosis

At 11:03 UTC, one normal click on the web Continue Watching card resumed Strng item 100002 at **360 seconds**, the exact position last saved by Android. A visible advancing 1280×720 image was observed at 376.97 seconds. Web history saved 388 seconds on return to Movies. Session `4f2762af-a3f5-4220-8ea6-913ab7b39bb6` expired at 11:04:25.680 UTC. TF1's prior Android session expired at 11:00:15.539 UTC; no overlapping provider stream was used.

Web first-frame telemetry measured **33,669 ms**. Safe logs on the same main Gateway show Edge preparation 602 ms, all admission/takeover wait counters zero. Prefix transfer took 1,753 ms. Tail metadata required a 131,072-byte read (1,044 ms) followed by 3,660,766 bytes (26,943 ms), compared with 7,135 ms for the phone's 3,780,512-byte tail. No failed startup range or retry explains the difference. Provider throughput on this tail was approximately four times slower during the web sample.

Read-only Gateway health confirms the private byte-range cache is enabled globally, with 30-minute TTL and 8 MiB maximum windows. Main counters: zero stored files/bytes/windows, 10 identity rejections, all attributed to `missingValidator`; other rejection categories are zero. The pilot also has one missing-validator rejection. These provider responses do not provide the required validator. Same-session drained-range reuse remains possible, but cross-session reuse cannot be certified without an identity validator. No expiry/eviction/owner-isolation bug is demonstrated, and no identity guard was weakened. Resume-position synchronisation and reusable media bytes are separate guarantees.

## Global WebView deployment

PR500 merged as `5d8a3cb04aec84b9efe632d50776d89c79637774`. Build run 36706020210 passed all four jobs (cloud contracts, Windows, Android phone and TV). Cloudflare production deployment 36706738989 passed. Public `app.html` references `standalone.js?v=0513e45316`, which matches the validated local script after line-ending normalization and contains both fixes. The unversioned URL still served the prior cached asset; the application's actual versioned URL is correct. The real browser reload also loaded `?v=0513e45316`.

The user was asked to fully reopen Norva on the phone before the final refreshed-code replay because an earlier automatic approval rejected USB app restart. The successful code40 replays above establish playback/resume, but do not yet establish runtime verification of this subsequently deployed JavaScript.

## Refreshed phone replay — remaining failures at 11:22–11:28 UTC

The user reopened Norva; ADB observed a new MainActivity process (PID 19082). A single tap on Strng MP4 item 100002 from Continue Watching created a direct session at 11:22:20.217 UTC and retired it 472 ms later without opening PlayerActivity. The saved web position remained 388 s. The Edge logged a TypeError after creation: a visibility-finalization retry dispatched `handleRequest(req)` again and attempted to consume the same POST body twice. This is a server failure, not evidence of a slow provider or a user cancellation.

A second explicit tap opened PlayerActivity. The direct request returned a confirmed HTML document. Recovery created relay 35983dbf… at 11:26:33.893 UTC, then relay 8fcd1f27… at 11:27:14.306 UTC, but neither rendered a frame. The phone reached its terminal retry screen. Android Back was used to close it; the database subsequently reported no non-expired Strng test session.

Safe Gateway traces isolate a separate slow-start problem. The first relay read the prefix in 1.603 s and the MP4 tail in 2.076 s + 33.883 s; the next relay needed 2.052 s + 68.471 s for the same tail. No video-position range was requested before the retries. Android's 35-second buffering watchdog did not observe positive byte transfers, so it discarded active metadata work and started again. These failed attempts supersede any implication that the refreshed flow is fully validated.

Phone/server clocks are not sufficiently synchronized for precise tap-to-server-event comparisons. Event ordering and same-process durations are used for this diagnosis; no subsecond end-to-end improvement is claimed.

## Receipt fix deployed and phone replay after 11:45 UTC

PR501 merged as `517efe394c7e34d17f696987903243e73c7d5d5f` after all ten checks passed. The Edge artifact SHA256 `1549cd945a6b8ef9c1676d8093281ed86de0015a4218c57266efda002dbe000d` was rolled out sequentially to both replicas with a verified backup, unchanged receipt-authority helper, and healthy checks on each replica. No Gateway media process was restarted. WebView notification deployment follows the production Cloudflare workflow.

The real Deno request wiring regression proves one body read and one creation across multiple visibility-fence retries. Source revocation still rejects the response and closes the exact receipt. Initial native-resolution failure now has the existing translated error toast with an explicit Retry action; route change, cancellation and newer action suppress stale notifications/retries. The action uses a minimum 44px touch height.

On the physical code 40 phone, a single tap at 11:47:00.542 UTC resumed Strng episode 2120388 through a raw relay. Actual video was visible; native first-frame duration was 5.816 s, received by the server at 11:47:08.529 UTC. Saved progress advanced from 1449 to 1496 / 1629 s. Relay `2df9ffc5-80b4-4fbc-9496-013fae6bff53` expired on Back at 11:47:57.516 UTC. Direct access still produced an HTML refusal; this validates recovery, not direct reachability.

Cloudflare production workflow 36711003761 completed successfully. Both the public application and the reloaded browser use `standalone.js?v=c28e4a0326`; the downloaded asset matches the validated source (SHA256 `c28e4a032677ab952ebb656da9f841c64c302fd1dc9ea69ce7d88ace8fd5a722`).

## Android slow-start correction prepared for production

The initial Phone 1.3.28 / code 41 candidate tracks positive reads per media route. It retains the 35 s inactivity deadline and adds a 120 s absolute preparation budget. Active progress no longer restarts metadata work at 35 s. The absolute limit stops playback and leaves explicit Retry instead of automatically repeating the download. Preparation renews its existing session lease only while bounded foreground startup is active. This candidate requests reader shutdown on Back/background, but prompt socket closure failed the emulator verification below and must be corrected before release. Live keeps its previous policy.

Four JVM cases cover active progress, stalled reads, a trickle exceeding the absolute limit and cancelled/old generations. Four instrumented cases use a local media origin and actual Media3 rendering, including 40 s of header transfer, terminal/manual Retry, background/return, and Back. Matroska index Range requests are explicitly allowed and distinguished from a new playback generation. At this stage, release gates and a physical replay of the corrected production version were still required; code 41 was subsequently superseded by code 42 below.

The full Windows regression run reported 5300 passed, 27 skipped and 5 failed: four shell/Git-fixture checks unavailable in that Windows environment and one release-version assertion encountered while preparing code 41. The corresponding Linux server/WebView CI passed, and the two native version gates have been updated and pass their focused suite. This local result is not represented as an all-green full run.

### Release gate results at 12:05 UTC

Build 36711093992 and all contract/database checks passed on PR502 head `5f0f0e77`. Emulator run 36711093607 passed both TV configurations but failed all four phone configurations. The real 40-second slow-header rendering passed in all four phone configurations. Back and background failed the five-second assertion for closing the actual local HTTP reader in all four; terminal/manual Retry also failed that closure assertion in both gesture configurations and passed in the two three-button configurations. Those failures were release blockers; they were not waived as provider variability.

Signed bundle workflow 36710492279 produced code 41 (AAB SHA256 `9237987cf7c17fcc2fde581ed954ff277453899c20acd634056a90fbc60aa716`). It was uploaded and saved as production draft release 27, but was **not submitted for review**. The phone still runs production code 40. The uploaded code 41 must not be described as globally available or as having passed emulator QA.

### TF1 replay at 11:57 UTC did not render

One tap on BE: TF1 HD (985192) at 11:57:51.261 UTC opened the native player, whose direct route again received HTML. Three server recovery sessions were created: `7a4f1dd1-af47-4c4c-b15f-c01ffafebe70`, `7fe535b9-5b56-455c-bfa5-b64bcd1ee23f`, and `07f95b41-4b32-406b-9fda-1a62dd252f91`. No first frame was obtained; Android Back ended the attempt. Gateway traces show remux preparation succeeded in 14.609 s, 4.313 s and 3.810 s respectively, with actual media segments. This does not establish successful delivery to the phone. The earlier successful TF1 replay does not override this failure; diagnosis and final session cleanup are being checked separately.

## Live receipt authority correction — global deployment at 12:19:52 UTC

PR503 merged as `7ed37e02e1095121edc2db325561469c4d72507e`. The exact Live session receipt row is now covered by response-authority verification. The owner, source, source generation and identity-hash checks still fail closed; the change does not bypass receipt validation or authorize another session's media. Verification passed 40 focused tests and 26 adjacent tests.

The server deployment completed at 12:19:52 UTC. Both Edge replicas passed health checks and served the expected `index.ts` SHA256 `40b8d22488782249e0ad3347def12bbe6263a0f0f99d10d584ba22b0c29b33cd`. No Gateway media process was restarted. This correction is deployed globally and does not require an Android update.

### Physical TF1 replay after the server correction

On the still-installed **Phone 1.3.27 / code 40**, one tap at 12:30:24.1409 UTC opened BE: TF1 HD. The direct response was again HTML; recovery obtained HLS session `56daa50b-f6c3-4d2a-a399-208e29e6b5b6`, created at 12:30:33.097 UTC. First-frame telemetry arrived at 12:30:40.148 UTC and reported **7,683 ms** on the native clock. A screenshot confirmed actual TF1 programme video. The recorded tap-to-event interval is approximately 16 s, with the phone/server clock and telemetry limitations already noted above.

Android Back expired the session at 12:31:41.935 UTC. The subsequent check found **zero active Strng sessions**. This is a successful physical replay of the Live recovery and release after the server correction, not a validation of direct provider reachability or of the new code 42 player.

## Code 42 correction and successful release gates

PR502 merged as `ad97f1da2bda4fb664af9b00dd17069278d68a8d`. **Phone 1.3.28 / code 42** supersedes the failed code 41 candidate. It preserves the 35 s inactivity and 120 s absolute startup budgets, and now actively closes the route's reader outside the UI thread when cancelled. Cancellation during connection opening also closes a late-published reader. The first rendered frame ends startup tracking without cancelling healthy playback or subsequent seeks. Cancellation exceptions cannot escape the close worker and crash the app. An online resolver timeout is classified as a terminal reconnection failure, rather than incorrectly reporting that the device is offline.

All release gates passed on head `c66d7672dda005886f96c1fe4fe17fb6d51ac07a`:

- Build run **36713615145**: cloud contracts, Android phone and TV compilation/JVM tests/lint, and Windows build succeeded. The first TV job never started because GitHub could not acquire a runner; the authorized rerun of that job succeeded.
- Emulator run **36713614986**: four phone configurations (gesture and three-button navigation, font scales 1.0 and 1.3) and both TV configurations passed.
- The four new VOD scenarios passed in every phone configuration: **16 successful executions**, with each XML result inspected. The local media origin delivered a deliberately slow 40-second header and actual Media3 rendering was required. No provider stream or simulated first-frame callback was used.
- Signed AAB workflow **36713628920** succeeded. Bundle SHA256: `F83267E2E5173CA45A7603E843509C84D7F740A8B9CE1AF657F30C0DA83581E8`.

| VOD scenario | Evidence on all four phone configurations |
| --- | --- |
| Progressing data beyond 35 s | Actual first frame, unchanged playback generation and no restart from byte zero; legitimate Matroska index seeks remain allowed. |
| Back during startup | Real origin socket closed within the unchanged five-second assertion; lease renewal stopped. |
| Background then return | Preparing reader closed, no background heartbeat, foreground playback rendered, subsequent Back released the connection. |
| Absolute startup limit then Retry | Terminal state and socket closure without an automatic retry loop; only explicit Retry opened and rendered the new attempt. |

### Google Play submission at approximately 12:38 UTC

Code 42 was uploaded to production release 27 with a **100% rollout configured** and submitted to Google Play. The Console confirmed **“Modifications en cours d’examen”**, **Norva Mobile 1.3.28 (42)** and **“Lancer le déploiement complet”**. Quick checks were still running, with the Console indicating up to ten minutes before review. Submission and configured rollout are not evidence of approval or public availability. The physical phone still runs **code 40**.

## Current limits and separate pending work

- The code 42 slow-MP4 watchdog and reader-release correction has passed deterministic JVM/emulator verification, but **has not yet been validated on the physical phone with the real slow Strng MP4**. Repeat playback, exact resume, Back and background/return after the Play update becomes available and its installed code is verified.
- Startup remains variable and is **not instant**. The latest physical TF1 sample was about 16 s from the recorded tap to first-frame event; the earlier MP4 tail transfers demonstrate material provider-throughput variability. Preventing needless restarts does not itself make those metadata transfers faster.
- Confirmed direct HTML refusals still require recovery. Neither the successful HLS Live replay nor raw-relay VOD playback proves all-direct provider access.
- Cross-session byte reuse for the observed Strng files still lacks a required identity validator. No validator or owner-isolation guard has been weakened to turn those samples into cache hits.
- A separate guide UI race is being investigated/corrected. Its fix and runtime validation remain pending and are not included in the playback successes or release evidence above.

## Guide source/search follow-up (PR504, validation in progress)

The observed web guide could automatically resume the previous supplier while a different source was selected during loading. Progressive rendering could also replace visible search results, and both search controllers could merge a late response from the previous source. PR504 ties automatic startup to the entry intent, cancels the exact uncommitted player request and serializes its connection release before the next explicit Play. Confirmed playback and explicit requests remain independent of later browsing. Search and recent/favorite suggestions respect the selected source.

There are 71 passing focused tests, including real `VideoPlayer` queue/stop methods. An independent review verified that the cleanup barrier has no promise cycle and cannot close the next request. A browser replay using production controllers and fixture catalogue data passed `verifyRender`, `verifyRemoteSourceRace` and `verifyMobileRemoteSourceRace`; it also retained TF1 under source B and restored all six fixture rows after clearing source/category filters. These are UI/controller proofs, not provider playback proofs.

The first emulator run, 36717128773, was not accepted as a passing gate. The new fixture cleared its cache before old controlled promises settled, which then repopulated the cache and prevented the intended new request. Commit `4951957dd249aa24964a31445bb8bc3863f6667b` corrects that order without weakening source or query assertions. A gesture/font-1.0 emulator also displayed a Pixel Launcher ANR dialog over Norva; its screenshot explains the blocked touch/IME checks, including failures in existing tests. No IME assertion was relaxed.

The second emulator run, 36718585232, passed both TV configurations but did not complete phone validation. The three-button/font-1.0 image download failed before boot (`ZipFile unknown archive`). Gesture/font-1.3 instrumentation stopped after 31 successful tests, before the new case, with no application stack establishing the cause. The other two phone captures show a Pixel Launcher ANR that occurred before instrumentation and retained input focus. In three-button/font-1.3, the new case failed its first IME assertion and never reached TF1/source verification. These failures are not counted as product successes.

All five fixture scenarios were subsequently replayed successfully in the real browser DOM through explicit local QA controls: render/focus/caret, both remote source races and both source/category orders. This isolates the fixture behavior but does not establish real Android IME behavior. The pending CI stabilization separates compilation from emulator boot and requires a healthy focused launcher before starting instrumentation; product code and assertions remain unchanged.

Google Play subsequently finished its quick checks and still showed code 42 under **“Modifications en cours d’examen”**. No approval or public availability was observed at this check.

### Third guide QA run and web Live replay

Build 36721136462 and Partners 36721136398 passed on `78d526a0`. Emulator QA 36721136600 did not pass. Its new readiness check revealed two distinct infrastructure problems: the filtered `dumpsys window windows` output excludes the display's current-focus field, producing false HOME deadlines; and emulator-runner injects key 82 immediately after `boot_completed`, before a focused window exists. In the gesture/font-1.0 trace, the input arrived at 13:24:46.769, ANR followed at 13:24:51.788, and the first HOME window appeared at 13:24:54.715, before the Norva test script started. The readiness check and upstream unlock step are being corrected without suppressing ANRs or weakening product assertions.

A separate production web replay selected **BE: TF1 HD, Strng item 985192** at 13:33:07.005 UTC. Session `a20e31f0-ea8a-440e-84a7-7a5419ff6d70` encountered a browser `bufferAppendError`; automatic conversion created `34f30f95-5846-409f-9202-0db26e7012a7`. Actual TF1 programme video was then observed at 1920×1080, readyState 4, with playback advancing. This is a successful recovered playback, not a successful initial-format selection or a fast-start result. The mini-player was explicitly closed and a subsequent database check found zero active Strng sessions. Investigation of the initial format mismatch remains open.

The first-frame event for that web recovery was recorded at 13:33:59.523990 UTC, approximately **52.5 s from the tap**. Its reported 485 ms player metric covers attachment of the second stream only. Gateway preparation took 39.040 s for the initial remux and 8.590 s for the subsequent transcode. The initial FFmpeg logs include missing H.264 SPS/PPS and unknown dimensions; the original media segments have since been deleted, so this is a hypothesis for the browser rejection rather than proof of the exact defective bytes.

Run 36723027110 removed the premature key injection and did not report another pre-instrumentation ANR. It exposed a further readiness bug: Android replaces the temporary Google SDK setup HOME with NexusLauncher during first boot, whereas the helper retained the initially resolved setup activity. All four final dumps show a focused NexusLauncher. The helper now waits for the read-only setup/provisioning indicators, resolves HOME on each observation and requires three consecutive focused observations of the same target. Captured focus fragments from all four configurations and explicit negative cases exercise the actual Bash function. Build 36723027176 and Partners 36723027029 passed; the phone instrumentation result remains pending the corrected readiness gate.
