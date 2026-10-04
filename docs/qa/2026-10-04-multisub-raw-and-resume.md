# MULTI-SUB input corruption and positive-timestamp resume

## Scope and input evidence

4 October 2026. Follow-up to `2026-10-04-featured-multisub-stutter.md`, on the exact controlled-account Lost and Bolt MULTI-SUB files. This is not a whole-catalogue certification.

At 15:03 UTC, sequential 8 MiB / 16 MiB samples were read through the primary Gateway's raw passthrough, bypassing the finite native range broker, native byte cache, HLS conversion and browser. Each read used the ordinary owned native recovery session/coordinator and account registration. A 90-second operator-only loopback capability was scoped to that same session, owner and exact resolved file; the unused native broker was never opened. Normal expiry closed each session. No provider limit, account lease or quarantine was overridden.

Both SHA-256 hashes exactly match the earlier samples obtained through the finite native transport. This rules out that broker/cache as introducing the differences in these sampled bytes. Raw passthrough still uses the Norva HTTP client and pinned proxy route: provider storage versus that shared upstream transport is **not independently isolated**.

| File | Sample | Offline software decode | After recovery remux |
| --- | ---: | --- | --- |
| Lost MULTI-SUB | 8 MiB | 1 EBML diagnostic, 1 corrupt frame | EBML diagnostic removed, corrupt frame remains |
| Bolt MULTI-SUB | 16 MiB | 4 corrupt frames, 7 AAC errors | 4 corrupt frames, 7 AAC errors remain |

Decode windows: 18 and 40 seconds. Networkless container, one CPU, same production FFmpeg image. Recovery remux used `+genpts+discardcorrupt`, `ignore_err` and stream copy, then a normal software decode. This does not repair damaged coded pictures/audio. Zero FFmpeg exit codes do not certify clean media. The earlier Bolt receipt counted three frames under its previous decoding conditions; it remains preserved rather than overwritten.

All four temporary raw/remux media samples and short-lived diagnostic session replies were removed. Aggregate receipt: `2026-10-04-multisub-raw-and-resume.json`. No source URL, account identifier or capability is published. The initial diagnostic setup briefly entered automatic transcode before an assertion stopped it; the correct POST expiry closed it. A second setup stopped before I/O on ambiguous route matching and expired normally. Neither failed setup is a successful sample.

## Separately reproduced Norva resume defect

The real Movies Continue Watching action resumed Bolt at 66 seconds. It produced a first rendered frame after 20.988 seconds, but no sustained `play_started` event. The browser was paused at media time zero. A subsequent explicit Retry reproduced:

- `readyState=4`, `currentTime=0`, paused;
- actual buffered range `[0.880333, 18.899333]`, later `[0.880333, 94.392333]`;
- the startup gate measures only a range containing zero (with 0.25-second tolerance), so it reported no usable reserve despite the loaded media;
- the first reproduction was later torn down; the next reproduction was stopped explicitly after collecting the above evidence.

This demonstrates a startup deadlock independent of the corrupted frames. The historical generic broker 503 at teardown alone did not establish an upstream provider failure. First-frame telemetry while paused must not be presented as successful playback.

## Correction and validation

The HLS startup gate now aligns a fresh paused origin to the first buffered sample only when it is positive and at most one second, and the **entire existing startup reserve** is already buffered. It preserves pending seeks, user pause intent, prior playback, source versions, audio/subtitle selection and provider connection limits. It never bridges a later gap or lowers the 6/12/96-second policies.

Local targeted verification: **57 tests passed**, covering the observed 0.880333 offset, short reserve, deep reserve, larger gaps, pending seeks, pause, stale HLS, mutated TimeRanges, audio selection and recovery. The shared Android WebView fixture includes the positive timestamp regression.

PR [630](https://github.com/Admin-Adher/Norva/pull/630) is integrated in main at `51e42e0601828bbbe62d701e4ae40550e88932b5`. Code `85b63ca9f7cd0f458a5b293e61677224ee6fcd28`; the subsequent `86d08c7ba32ea687fe5130189746a545bf2c6ac4` regenerates the required asset manifest only. The first cloud CI check caught this stale manifest; the repaired check passed. Cloudflare production workflow [37213129857](https://github.com/Admin-Adher/Norva/actions/runs/37213129857) succeeded at 15:30:17 UTC. The reloaded application DOM loads `WatchPage.js?v=7ae15195bc`.

Android emulator workflow [37212828932](https://github.com/Admin-Adher/Norva/actions/runs/37212828932): all six jobs succeeded. The phone ran `GatewayLateRecoveryInstrumentedTest` in gesture and three-button navigation, at font scales 1 and 1.3. The TV consent D-pad smoke also passed, but is **not** a TV video-decoding proof. The first dispatch was cancelled after an incorrect TV class name was noticed; only the corrected run is counted. Phone/TV package builds and cloud contracts passed. Windows packaging was still running at the initial merge check.

Production replay used the actual Movies Continue Watching control on the **same Bolt MULTI-SUB version**, resuming at 66 seconds. `play_started` was recorded at 15:31:35.087838 UTC, then `first_frame` at 15:31:35.432672 UTC (21.556 s from the user action). The browser was actually playing: `paused=false`, `readyState=4`, `error=null`; media time advanced from 29.83898 to **114.286586 seconds**, beyond the former startup timeout. Buffered range at the later observation: `[82.921333,192.906333]`. This validates the startup/resume repair, **not visual smoothness**: the user reported remaining stutter. The test was then closed normally.

At 15:21 UTC both Gateways returned healthy, no viewer sessions remained, and the permanent language dispatcher was running/healthy. No Gateway, Edge, codec, language or provider-route configuration was changed by this diagnosis.

## Independent investigation after the user reported remaining stutter

A new bounded 16 MiB sample at 15:35 UTC reproduced the exact Bolt hash from the earlier raw and finite-broker samples. All following comparisons used this same local input, without a provider connection, in the deployed production image `sha256:b65be379d436eb6d32287374704524424c5e55c89619b213272e3b6ef665fb6a`. No decoder, route or production configuration was changed.

### Source timing and decoder comparison

An independent EBML element/block parser, without FFmpeg, confirms discontinuities already stored in the received Matroska bytes. For example, audio jumps from **12.841 to 20.480 seconds**; video block timestamps also jump across this interval. These are not a browser buffer measurement or an HLS-only anomaly. The final partial cluster is expected because the diagnostic deliberately downloads only a prefix; earlier gaps are well inside that prefix.

Three 40-second output pipelines used the production encoding options, including `-fps_mode passthrough` and the already-deployed `-enc_time_base:v 1:90000`, normal AAC resampling, and two-second HLS targets:

| Decode / encode | Frames in generated output | Gaps over 65 ms | Largest image interval | AAC diagnostics |
| --- | ---: | ---: | ---: | ---: |
| Software / software | 515 | 9 | 7.924 s | 7 |
| Software / VAAPI | 515 | 9 | 7.924 s | 7 |
| VAAPI / VAAPI | 515 | 9 | 7.924 s | 7 |

All three have the same output presentation-time distribution. VAAPI does not print the four corrupt-frame messages seen with software decoding; **absence of those messages does not establish a clean picture**. A single duplicate timestamp is adjusted by the TS muxer in each output. Encoding times in the receipt were measured under a fixed two-CPU diagnostic cap and are not production capacity measurements. The source `ffprobe` window and the complete output have different boundaries; their frame totals must not be subtracted as a dropped-frame count.

### Reader outside Norva media code

At **15:48 UTC**, system libcurl independently read the first 8 MiB of the same owned Bolt file, through the **same HTTP CONNECT proxy slot**, without the Norva Gateway HTTP client, finite broker, byte caches, FFmpeg or browser. The ordinary owned `mode:direct` session performed the usual provider claim and background drain. A native heartbeat every 0.5 s, with a fail-closed one-second timeout, preserved takeover handling; the configured native takeover grace was at least three seconds. One sequential media request, no retries, no route/IP rotation; normal expiry closed the session.

Result: HTTP 206, 8,388,608 bytes in 17.880 s, SHA-256 `2c2b713f1efafaafa24389152ebd4d684331ecb371993c63521e539519c39ed7`, **byte-for-byte identical** to the first 8 MiB received through Norva raw passthrough. This puts these particular missing data/timestamp intervals upstream of Norva's media processing. The common proxy path remains in both reads, so the test does not distinguish the provider's stored file from that upstream relay. No independent second proxy transport is configured in this Gateway; no unverified replacement route was introduced.

At 15:50:37 UTC all new source/output clips and the temporary raw-session reply were removed (66 files); no diagnostic MKV, TS or M3U8 remained. Both Gateways returned healthy with zero viewer sessions. The permanent language dispatcher remained running and healthy. Aggregated timing, byte-comparison and cleanup receipts are included in the adjacent JSON.

## Remaining limits

The exact MULTI-SUB files have not been repaired. The remaining sampled Bolt freezes are present in the independently received input; the provider-storage versus common-proxy distinction is still unproven. The existing EN Lost version remains a separately confirmed fluent alternative, not an automatic replacement or a repair. No version, dubbing or subtitle selection was silently changed. This frontend correction must not be described as fixing all stutter, every VOD, or every MULTI-SUB file. These diagnostic prefixes do not certify either full film or all rendering behavior on the user's device.
