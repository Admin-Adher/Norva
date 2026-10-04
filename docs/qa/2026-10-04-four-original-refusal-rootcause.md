# Four original MULTI-SUB files — refusal investigation

## Scope and current result

4 October 2026, UTC. This continues the [initial startup report](2026-10-04-four-featured-vod-launch.md) for the **exact original MAX OTT MULTI-SUB files** of HIT: The Third Case, MMA Cop, Shadow Force and Shadow of Vengeance. The [sanitized receipt](2026-10-04-four-original-refusal-rootcause.json) preserves the source comparisons, independent reads and production replay telemetry. No source URL, credentials or account identifiers are included.

**The four-file issue remains open.** HIT still returns an empty HTTP 403. The other three original files subsequently delivered media and started in the production browser with their original target hashes unchanged, but all three produced invalid-input or decode diagnostics during playback. Shadow of Vengeance also showed visible image corruption. Successful startup does not establish fluid playback, and these later successes do not explain the earlier refusals.

This investigation introduced no application deployment, codec change, source edit, route-policy change or concurrency increase. Ordinary temporary playback claims, heartbeats and expiry were used for the explicitly authorized diagnostics. No retry deadline, lease, circuit or quarantine was reset. The permanent language dispatcher continues separately.

## Exact file and provider authority checks

Read-only provenance checks found one current owned variant and one matching media row for each original, with the same external identifier, movie type, source and active generation. The URL built from the configured source and stored file tuple matches the recorded failed sessions and the target retained by the fresh metadata diagnostic. The source is an HTTP origin without a base path, query or fragment; credential encoding round-trips, and the generated movie path has the expected segments. No malformed URL, cross-generation substitution or wrong stored extension was demonstrated.

Two distinct provider API responses corroborate the imported coordinates:

- `get_vod_info`, 17:49 UTC: all four return the same stream identifier, name and MKV extension; `movie_data.direct_source` is empty.
- Category-scoped `get_vod_streams`, 18:53 UTC: the 2025 category returns 1,092 entries and contains HIT, MMA Cop and Shadow Force; the 2024 category returns 809 entries and contains Shadow of Vengeance. The exact four entries again match identifier, title, category and MKV extension. `direct_source` and `custom_sid` are empty; the other inspected playback-URL fields are absent. The owner/source/generation context was unchanged across these reads.

These are two API representations from the same provider, not independent proof that its media objects are healthy. They corroborate the stored file tuples and provide no alternative authoritative media URL; they do not independently validate every serialization detail of a constructed URL. The category response bodies were bounded to 8 MiB/45 seconds, then removed; only the four complete target objects and their scope remain in private mode-0600 diagnostic files.

The retained `get_vod_info` evidence is a deliberately reduced subset: stream identifier, name, extension, direct source and public movie identity. Its original body was removed, so unretained duration, track, availability, update or serving-node fields cannot be declared absent from that original response. The four **complete** category objects have only 12 ordinary catalogue fields and no explicit availability, duration, track, update or serving-node field. Their `added` dates are 2 June 2025; those dates do not establish current object availability or a recent update.

## Transport and User-Agent comparisons

The deployed policy has `PROVIDER_HTTP_FORWARD_ALL_COMPATIBLE_MEDIA=true`: plaintext MP4/TS uses forward mode, whereas MKV retains CONNECT. Consequently the earlier successful MP4 alternatives did **not** prove equivalent HTTP proxy modes. The subsequent comparison used each exact original URL, the same configured proxy credentials and slot, a fixed production-default User-Agent, and one request at a time.

| Original file | CONNECT result, UTC | Forward result, UTC | Retained body comparison |
| --- | --- | --- | --- |
| HIT: The Third Case | 18:51:00 — 403 | 18:51:11 — 403 | Both empty; no media-prefix comparison possible |
| MMA Cop | 18:52:12 — 302 then 200 | 18:51:48 — 302 then 200 | Identical 65,536-byte Matroska prefixes |
| Shadow Force | 18:52:16 — 302 then 200 | 18:51:52 — 302 then 200 | Identical 65,536-byte Matroska prefixes |
| Shadow of Vengeance | 18:52:21 — 302 then 200 | 18:51:56 — 302 then 200 | Identical 65,536-byte Matroska prefixes |

CONNECT's tunnel-establishment 200 responses are separate from the media response. The complete status chains remain in the receipt. Successful responses were deliberately stopped at 64 KiB; their curl termination code is the expected bounded stop, not a complete-file transfer. A valid identical prefix is not proof that the remainder decodes correctly.

The diagnostic field `providerRequests=1` counts one operator/curl download invocation, **not every HTTP request sent on the network**: a followed 302 entails an additional sequential request. The recorded status chains retain those redirects. No concurrent fetch, automatic application retry or route rotation was added.

The fixed A/B User-Agent is the Gateway's configured-code default (Chrome 126 with the Norva token). Its use does **not** establish the User-Agent of the original browser attempts, which was not retained. Two additional controlled reads at 18:58 showed MMA still delivering the same prefix with the earlier minimal Mozilla header, while HIT still returned an empty 403 with the Chrome 123 client-preset header. These tests do not support attributing the observed recovery to that header change. They do not certify every possible header or prove the cause of the historical refusals.

Both Gateways have the same single configured HTTP proxy slot. **Matching proxy configuration is not an independent measurement of the exit IP used by each request.** No IP measurement or rotation was performed. The current results exclude a CONNECT-only explanation for HIT at these timestamps, and neither mode was required for the three later successful prefixes. They do not distinguish internal provider routing, a common relay intervention, object availability or another upstream cause.

Every operator read used a shared-account guard across Norva owners, ordinary owned direct-session claim/drain, 0.5-second heartbeats with a one-second fail-closed timeout, and normal expiry. The metadata requests fetched no media. An unrelated reader on the primary Gateway was left running. Whole response bodies, headers and stderr were removed after the bounded safe receipts; exact source coordinates stayed private.

## Production replay of the original three files

Each replay below retained the exact original MULTI-SUB target hash, emitted both `first_frame` and `play_started`, and expired normally before the next file was played. There were no `gateway_error` or `playback_error` telemetry events for these sessions; decoder logs provide additional evidence that those counters do not cover.

| Original file | First-frame timestamp UTC | Reported TTFF | `play_started` UTC | Observed browser media time |
| --- | --- | ---: | --- | --- |
| MMA Cop | 18:56:09.666 | 6.655 s | 18:56:08.971 | 24.458 → 84.0066 s; readyState 4, playing, no media-element error |
| Shadow Force | 19:00:24.766 | 8.460 s | 19:00:31.223 | 27.244 → 69.8608 s; readyState 4 |
| Shadow of Vengeance | 19:02:43.026 | 4.438 s | 19:02:42.431 | 58.5269 s; readyState 4; visibly corrupted image; final media time not collected |

`play_started` can precede the first decoded frame, as it does for two sessions. TTFF and readiness alone must not be presented as a fluidity certification. The three local screenshots preserve the observed frames; no full-film, seek, audio-language or all-device validation is claimed.

### Input and decode diagnostics

The following are counts of exact-session **tagged log lines**, not unique corrupted frames or expanded repeat counts. Untagged multiline continuations are not attributed. The previous provisional label “process failure” for MMA's five messages was corrected: those messages concern resynchronization, not five FFmpeg processes exiting.

| Original file | Invalid EBML lines | Video reference errors | Audio diagnostics | Resynchronization failures | Period containing tagged diagnostics, UTC |
| --- | ---: | ---: | ---: | ---: | --- |
| MMA Cop | 39 | 47 | 0 | 5 | 18:56:06.913–18:57:33.920 |
| Shadow Force | 22 | 30 | 9 | 2 | 19:00:19.544–19:01:41.711 |
| Shadow of Vengeance | 25 | 33 | 5 | 0 | 19:02:41.061–19:03:50.768 |

All three had diagnostics before the first frame and during the main playback interval, outside the final 15 seconds before Gateway expiry. In that middle interval alone, MMA had 33 invalid-EBML lines and 41 video-reference errors; Shadow Force had 21/30 plus eight audio diagnostics; Vengeance had 22/30 plus five audio diagnostics. These cannot all be explained as shutdown-only messages. The final-15-second bucket is purely temporal and does not assign a shutdown cause to any message.

The EBML messages identify malformed input reaching the demuxer; they are not solely browser-rendering symptoms. The session logs alone did not establish where the bytes became malformed. No source-integrity conclusion is inferred from a 64 KiB prefix. The older Bolt/Lost raw-byte investigations remain separate evidence and do not automatically certify these three files.

### Independent 8 MiB reads and offline software decoding

At 19:19–19:20 UTC, the operator fetched the first 8 MiB of each of these three exact originals with system libcurl, outside Norva's media reader, using the reviewed proxy and ordinary account claim. Each body began with the identical 64 KiB already observed in its successful A/B test. The connection was closed and its claim expired before offline decoding. The decoder then ran without network or GPU in an isolated container, on the first video/audio streams only, with a 45-second media limit and 90-second wall limit.

| Original file | Independent read UTC | Invalid EBML offsets in the 8 MiB body | Offline diagnostic counts |
| --- | --- | --- | --- |
| MMA Cop | 19:19:03 | 543,262; 2,885,794; 5,259,309; 7,604,068 | 4 EBML; 8 video |
| Shadow Force | 19:19:27 | 1,065,380; 3,411,097; 5,800,522; 8,127,467 | 4 EBML; 17 video; 5 audio; 4 corrupt-packet |
| Shadow of Vengeance | 19:19:58 | 532,133; 2,904,466; 5,264,759; 7,605,967 | 4 EBML; 8 video; 1 expected truncated-prefix/EOF diagnostic |

The diagnostic categories can overlap and must not be summed as unique damaged frames. All twelve reported EBML offsets precede the final 64 KiB of their bounded body, so they are not merely the intentionally cut final boundary. A zero decoder exit code means the bounded job finished; it does not erase those errors or certify fluid playback.

**Malformed input is therefore also present in bytes obtained independently of Norva's media-reading and conversion code.** This narrows the fault location for these prefixes but leaves the common proxy path, provider routing and stored media unresolved. It does not identify which upstream component caused either the malformed bytes or the earlier 403s. No other proxy route was invented or substituted. The three private bodies, HTTP headers and decoder logs were removed after hashing and safe receipts; all three offline containers were removed.

At the final replay audit, 19:04:52 UTC, both Gateways returned HTTP 200/`ok`; the secondary had no remaining reader, and the primary had one global reader not attributed to these expired test sessions. The Gateway image remained `sha256:d0d85e0facb866c7ba194bff84c9e716282232790c2a430a5fe88028be8599cc`. Its log windows start at 18:05:56/18:05:59 and do not replace earlier history.

## HIT playlist authority and exact-URI check

The first bounded `get.php` diagnostic at approximately 19:05 received HTTP 200 headers, but curl rejected the advertised content length as exceeding 64 MiB and exited with code 63 before returning body bytes. The initial receipt's `invalid_header` outcome is misleading: **no playlist header was inspected**, so this attempt establishes neither a malformed playlist nor a missing HIT entry.

A separately marked second attempt at 19:07:09 removed the advertised-total-size rejection while retaining an actual streamed-byte cap of 64 MiB, a 45-second deadline and the existing account/heartbeat guards. It found the exact HIT entry after 6,393,856 bytes, 59,007 lines and 29,503 entry pairs, stopping deliberately after 23.287 seconds. The playlist header, exact stream identifier, raw title, movie path and MKV extension match. Its returned URI differs textually only by an explicit default HTTP port `:80`; hostname, effective port, path, query and fragment match. Removing that explicit default port makes the URI identical to the constructed one. The complete playlist was never stored.

The operator then requested the **exact returned playlist URI**, without changing its extension or substituting another film:

| UTC | Controlled request | Media response | Body |
| --- | --- | --- | --- |
| 19:21:06 | Exact playlist URI, reviewed CONNECT proxy and fixed production-default User-Agent | 403 after 1.164 s | Empty |
| 19:21:36 | Same URI and proxy; only the request User-Agent changed to the existing historical VLC fallback | 403 after 1.234 s | Empty |

These reads used a normal claim for the same account and file, preserved the shared-account guards, and expired normally. Local loopback comparisons on Windows and the server also observed identical curl CONNECT and GET requests for absent versus explicit default port; those comparisons made no provider request. The exact-provider-URI test is the direct evidence that retaining `:80` does not resolve this refusal. No source rewrite or new User-Agent policy was deployed.

The playlist now provides a third provider representation corroborating this HIT address. An HTTP-200 listing is still not proof that the listed media can be delivered. The internal reason for its HTTP 403 remains unestablished; the evidence does not justify a speculative path, port, extension, route or header change.

## Account snapshot and final operational state

The previous persisted account check was at 00:01:02 UTC and reported active access with a future expiry. It did not retain current connection counts. A single guarded account-info request at **19:22:02 UTC** returned HTTP 200, authenticated `true`, status `active`, **zero active connections out of a maximum of one**, and a parseable expiry date of today or later. Its raw account profile was removed; only these allowlisted values and expiry booleans remain.

This is the provider's instantaneous account report after the file tests. It does not establish its state during the earlier failures or prove the provider's connection counter is perfectly current. It provides no evidence of an expired/banned account or an active connection occupying that one slot at 19:22. No application access state was overwritten and the mono-connection policy remains in force.

The final read-only audit at **19:23:52 UTC** found both Gateways HTTP 200/`ok` with the same image, zero live playback claims or Gateway readers for this provider account across Norva owners, and no current language-validation or exact-file-probe lease for that account. One unrelated global reader remained on the primary Gateway and was preserved. The single permanent language dispatcher was running and healthy. The account/lease result is a snapshot; subsequent ordinary background scheduling remains allowed.

## Verification and remaining work

- Existing focused tests: 21 passed; the bounded diagnostic parser has eight offline checks passed. These verify the relevant existing logic and diagnostic tool behavior, not media availability or a new production repair. No new implementation test or production change is claimed by this report.
- The historical [23 September Tokyo Drift investigation](2026-09-23-max-ott-import-progress.md#playback-diagnosis-and-replay) also recorded an unavailable MKV despite Range, User-Agent and CONNECT/forward comparisons, while another MKV played. It contains no causal repair applicable to these files.
- HIT still refuses its exact provider-returned address despite a current active account report. Establishing why requires attributable evidence from the upstream delivery path; the internal reason for its 403 remains unknown.
- The three resumed originals deliver independently reproducible malformed input and need verified continuous playback before they can be called repaired. The common proxy path and provider media delivery have not been separated. No silent switch to an EN alternative is made.
- The existing error-presentation repair, slow EN MP4 resume investigation and permanent language campaign remain distinct. None is closed by this report.
