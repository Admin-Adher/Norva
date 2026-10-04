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

Local targeted verification: **57 tests passed**, covering the observed 0.880333 offset, short reserve, deep reserve, larger gaps, pending seeks, pause, stale HLS, mutated TimeRanges, audio selection and recovery. The shared Android WebView fixture includes the positive timestamp regression. Production replay and emulator verification are pending at this initial report revision.

At 15:21 UTC both Gateways returned healthy, no viewer sessions remained, and the permanent language dispatcher was running/healthy. No Gateway, Edge, codec, language or provider-route configuration was changed by this diagnosis.

## Remaining limits

The original MULTI-SUB bytes remain corrupted and the independent upstream origin remains unproven. The existing EN Lost version remains a separately confirmed fluent alternative, not an automatic replacement or a repair. This frontend correction must not be described as fixing all stutter or all MULTI-SUB media.
