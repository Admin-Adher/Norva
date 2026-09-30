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
