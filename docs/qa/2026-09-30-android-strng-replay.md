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
