# Four featured VOD startup refusals

> Later evidence, 19:04 UTC: the [exact-original follow-up](2026-10-04-four-original-refusal-rootcause.md) records that three original MULTI-SUB files subsequently started but produced input/decode errors; HIT still refused access. The observations below retain their original test window and are not a current claim that all four remain inaccessible.

## Result and scope

4 October 2026, controlled account, real production browser. The requested copies of **HIT: The Third Case, MMA Cop, Shadow Force and Shadow of Vengeance**, all MAX OTT `[MULTI-SUB]`, remain inaccessible. This report does **not** certify those copies repaired. Each has a separately selected MAX OTT `EN` MP4 copy that started and continued playing in this test.

| Explicitly selected alternative | First-frame telemetry | Last observed media time | Browser state |
| --- | ---: | ---: | --- |
| EN HIT: The Third Case, MAX OTT MP4 | 5.384 s | 96.283 s | playing, readyState 4, no media error |
| EN MMA Cop, MAX OTT MP4 | 5.392 s | 112.286 s | playing, readyState 4, no media error |
| EN Shadow Force, MAX OTT MP4 | 6.408 s | 96.968 s | playing, readyState 4, no media error |
| EN Shadow of Vengeance, MAX OTT MP4 | 5.859 s | 139.963 s | playing, readyState 4, no media error |

Each alternative also emitted `play_started`; none emitted `gateway_error` or `playback_error` in its test session. Back closed each session normally before the next test. These are startup and short continuous-playback observations, not full-film, decoder-quality, dubbing-language or all-device certification. `EN` identifies the provider version selected, not a new audio-language verification.

## Exact failure and independent checks

The four original browser attempts began at 17:34:35, 17:36:00, 17:39:11 and 17:39:39 UTC. Each failed before FFmpeg and before a first frame: the secondary Gateway's initial file request received HTTP 403. Norva discarded that distinction and returned generic `gateway_502` / “Playback failed”. Historical failures around 17:07 predate the latest human-language badge deployment; they are not evidence of a badge regression.

An independent system libcurl reader used the same exact resolved URL (hash equality checked) and pinned HTTP CONNECT proxy slot, outside Norva's media reader, byte broker, FFmpeg and browser. HIT failed both with the original bounded Range and without Range. The other three failed without Range. All five responses were empty HTTP 403 responses with nginx server headers, zero retained media bytes and no redirect to a replacement file. This excludes the large Range as the explanation for HIT. It does not distinguish the provider from the common upstream proxy path, or establish the reason for refusal.

Fresh `get_vod_info` requests for all four returned HTTP 200 at 17:49 UTC. Each declared the same stream identifier, title and MKV extension as Norva; none supplied an alternative `direct_source`. No evidence justified guessing extensions, replacing credentials, rotating an IP or changing codecs.

These nine independent requests were strictly sequential. Each used an ordinary owned direct-session claim and background drain, heartbeat every 0.5 seconds with a one-second fail-closed timeout, and normal expiry. No media was fetched during a metadata request. Metadata responses were bounded to 1 MiB, transient body/header/log files removed, and only minimal authoritative fields retained privately. No secret, source URL or account coordinate is in the public receipt.

## Norva correction

PR [639](https://github.com/Admin-Adher/Norva/pull/639), application code `9f0f7682d7bc8258adcfa23f8bdeb38a49b102f8`, test-contract follow-up `9c5729ba07fd075784649f01de6034932a09638e`, merged in `aa3524d43388851b036eb04003bf37a5f47012ce`.

- Finite VOD startup preserves a typed `PROVIDER_FILE_REFUSED` response for the exact upstream 401/403 failure. The public response contains a fixed neutral message, not the raw upstream body or credentials.
- The browser uses the existing unavailable-stream translation in all ten languages. It no longer asserts that a 401/403 proves a datacenter block or that the native app will necessarily succeed.
- Refusal remains terminal for that attempt. Retry is explicit; the selected file, source, audio and resume position are not silently replaced. Provider busy, proxy authentication, 404, container self-healing and cancellation handling remain intact.
- No numeric 401/403 is newly propagated to legacy clients, whose old classification could mistake it for account concurrency. The exact status remains in server diagnostics.

This repairs error classification and presentation, not the upstream media refusal. The four working alternatives were already playable before this deployment.

## Verification and deployment

Focused local runs passed: 36 playback/startup tests, the Gateway review's 65 provider/circuit/container tests, and 25 circuit/refusal tests after updating an existing source-contract assertion. These overlapping runs must not be added as unique-test totals. The first full CI run exposed that outdated assertion; the next regression suite and cloud contracts passed.

Android workflow [37222338155](https://github.com/Admin-Adher/Norva/actions/runs/37222338155), attempt 2: all six matrix jobs passed. Phone WebView error behavior was exercised with gesture and three-button navigation at font scales 1 and 1.3. TV D-pad consent smoke passed; it is not TV media decoding evidence. The initial gesture/font-1 job lost ADB before any test (zero tests executed); only that infrastructure-failed job was rerun. Redundant automatic matrices were cancelled.

Both Gateways were rebuilt from all 84 repository source/package files against immutable runtime `sha256:6ab34980137d60f028d5ddbde6869987867178182f8a9f066cc0e7fd88c787e2`. A source inventory proved exactly the two intended Gateway changes against production. Image `sha256:d0d85e0facb866c7ba194bff84c9e716282232790c2a430a5fe88028be8599cc`; complete source-tree hash `f6950f3dceec16d3a6f2ee93b3725200981b09155150ccb8f6fc52c814987446`.

The canary ran as user 1000:1000, network disabled, read-only root and empty temporary storage, no production volumes. VAAPI health passed; no provider requests or sessions were created. The canary was stopped and removed.

Controlled admission pause: 18:05:08.714–18:06:01.973 UTC. Existing background work drained naturally. Primary and secondary Gateway replacements completed at 18:05:57.744 and 18:06:01.557, with all source hashes and health checked. Edges were unchanged. Admission, strict cron and worker were restored; the permanent dispatcher retained its process and counters. No lease, retry deadline, circuit or quarantine was reset.

Web workflow [37223057548](https://github.com/Admin-Adher/Norva/actions/runs/37223057548) succeeded at 18:07:26 UTC. The real browser subsequently loaded `WatchPage.js?v=bf6f519584`. Windows packaging and both Android packages also completed successfully on the application/test head. The cancelled redundant emulator matrix is separate from the six successful targeted jobs above.

### Post-deployment error-envelope defect

A fresh HIT MULTI-SUB attempt at 18:11:54 UTC still displayed the generic playback error. Server telemetry already contained `PROVIDER_FILE_REFUSED`, while the authenticated Edge response sanitizer removed this newly added code because it was absent from its exact public allowlist. Thus the first deployment did **not** establish end-to-end error presentation. This was detected in the real user path, not counted as successful UI verification. The follow-up correction adds only this safe fixed code to the existing allowlist and exercises the real authenticated error envelope before the reader mapping; unknown codes and raw provider details remain redacted.

Follow-up PR [640](https://github.com/Admin-Adher/Norva/pull/640), code `612103be62f6d5eba18336796f70035265de3737`: 28 tests passed, including the first public envelope, authenticated visibility finalization and epoch recheck, the actual cloud client, and the reader's French message. There is no further frontend or Android runtime change. The helper SHA-256 is `6dde13f1e4b904f92a45ac949c4d6faf7cddf4281f53b86dc4e9bbcb0221cf4c`.

Both Edges received this one-file change at 18:21:12.062 and 18:21:15.640 UTC. The other 192 files and their permissions were preserved; all 193 hashes matched. The isolated, network-disabled sanitizer proof and health-only Edge canary passed; the canary was stopped. Admissions paused from 18:20:34.804 to 18:21:18.867, with natural drain and verified restoration. Gateways and dispatcher were unchanged. New Edge log windows begin at these replacement times and do not erase previous errors.

At 18:22:03 UTC the real browser retried the same original HIT MULTI-SUB copy once. The UI now displayed “Ce flux est temporairement indisponible. Veuillez essayer une autre version ou réessayer dans quelques instants.” The fixed refusal code was also present in the second Edge's public error diagnostic. No automatic replacement or retry occurred. A local screenshot preserves this UI proof. The selected file itself still failed before media delivery.

### Slow alternative resume remains open

The subsequent explicit EN MP4 HIT resume was clicked at 18:23:01.441, requesting 96 seconds. Unlike the earlier start-from-zero test, it was slow: `first_frame` at 18:23:34.884 reported 32,050 ms, then `play_started` at 18:24:34.906. Actual automatic playback began roughly 93.5 seconds after the click; the first-frame counter alone would conceal the additional minute paused.

Browser evidence: at 18:23:38 and 18:24:11, media time stayed at 5.208332 with readyState 4 and no error while the buffered end grew from 17.536 to 38.997 seconds. It subsequently started without manual Play and advanced from 25.290 at 18:24:54 to 76.037 at 18:25:45. A screenshot shows a decoded image. Navigation back to Films closed the session normally. This proves eventual playback, **not a fluid resume**.

Gateway evidence: ready at 18:23:33.405, FFmpeg readiness 29,862 ms, three segments / 17.5 seconds, sustained media-production rate 2.069×, remux/H.264/audio-copy graph. This is not a VAAPI encode-speed benchmark. Late input/loopback shutdown diagnostics after navigation are not attributed to corruption during playback.

The client uses a 96-second reserve when it cannot validate a fast-start policy; the observed paused local time would need a buffered end of approximately 101.208 seconds to pass that fallback. Code review also found that the Gateway can request `finite-mp4-buffer-observation` whereas this client only recognizes `encode-rate-below-minimum` for adaptive observation, and restricts that observation to local media time <=0.25 seconds. However the exact policy emitted for this now-expired session was not retained in its DB rows or telemetry. These code paths are candidates for the delay, not a proven session-specific diagnosis. No threshold, reserve or seek behavior was changed on that assumption.

The upstream 403 root cause for the four original files remains unknown. Independent reads share the same pinned proxy and cannot distinguish its intervention from the provider's origin. Further attribution needs a reason from the upstream service or an authorized independent route; this report does not claim those inputs exist. Four alternatives starting successfully does not repair the four requested copies.

## Separate limit found while testing alternatives

Dino's `EN - Shadow of Vengeance (2024)` also failed, but with a different cause: `INVALID_MKV_INPUT`, at 17:51:14 UTC. Its MP4 declaration is coherent; the common finite-input prefix checker did not recognize the received bytes. The generic Matroska error wording does not prove that the requested extension was wrong. No byte evidence yet distinguishes malformed input, a non-media response or an unsupported prefix. The MAX OTT EN copy above is the verified alternative. This Dino copy remains unverified and unrepaired.

The older Bolt/Lost MULTI-SUB corruption and the permanent language campaign are separate work; these startup tests do not close them.
