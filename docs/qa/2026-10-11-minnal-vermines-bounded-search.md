# Minnal / Vermines — bounded-search pilot, 11 October 2026

## Scope and status

Successive owner-only production pilot experiments, PR772. The first revision below is `66a8bf12ffe087a8aabcafaffaab78c6a095ff5e`; the latest state is recorded in the follow-up sections.
The candidate reduces the first MPEG-TS seek window to 256 KiB for eligible pilot owners. Lookbehind, exact-range validation, one provider connection and subsequent sequential growth remain in place. No MP4 change was deployed in this iteration.

This does **not** resolve the requested latency target. PR772 remains a draft. The candidate is running on the owner-only pilot; the main Gateway and both Edge deployments are unchanged.

## Production observations

### Minnal Murali, MPEG-TS

- At the same requested position, 4,444 seconds, Gateway readiness was 14,168 ms versus the preceding 15,177 ms. First segment: 13,508 ms. Provider interruptions: zero at inspection. The first resumed browser transition was not sampled, so no exact click-to-play value is claimed for this run.
- The video subsequently reached 145 seconds locally, with readyState 4 and continuous progression throughout the sampled 135–145 second interval. This is sampled continuity, not exhaustive freeze detection.
- A second, different out-of-cache seek (40% of the timeline) resumed at the first progressing sample at 20,073 ms. The prior playing resource was excluded from this measurement: it reset to time zero at 1,277 ms. At 114,020 ms after the action, local playback had reached 94.224 seconds, readyState 4, no media error and buffer through 214.065 seconds.
- Smaller reads reduced individual binary-search ranges but did not remove the serial position search or demonstrate a substantial user-visible latency gain.

### Vermines, MP4

- Warm reopening: first progressing sample at 10,193 ms. About 25.5 MB of input were seeded from cache.
- Progress was continuous in the sampled initial interval and again from elapsed 94.665 to 131.104 seconds; no media error. The unsampled interval prevents an exhaustive no-stall claim.
- The browser briefly exposed separated buffered ranges; these merged during the earlier opening. A buffered-range hole alone is not evidence of a playback stall.
- Transport traces show additional reads at the beginning of the MP4 before the browser requests the resume position. One speculative initial request was superseded after receiving approximately 1.17 MB; only complete validated windows are retained.
- Incomplete metadata retention is a hypothesis, not yet proven. Do not retain arbitrary partial HTTP responses or weaken file revalidation on that basis.
- The 10.2-second result cannot be attributed to a new MP4 fix: cache warmth, position and delivery variability differ.

## Checks and evidence

- Focused regression tests: 174 passed, six optional skips.
- CI run 38118048023: cloud contracts, Android phone, Android TV and Windows packaging all succeeded.
- Image canary and GPU encode passed before pilot deployment.
- Pilot image: `sha256:af207134067f495e533de902103d18c25d0ef4de84d27c5cb93529eb1ee3de8d`.
- Previous pilot retained as rollback container `norva-resume-cache-pilot-20260916-rollback-small-ts-20261011`.
- Local sanitized transport receipts: `.codex-artifacts/startup-cache-20261010/continuity-debug.remote.py.safe.json`, `small-mp4-traces.remote.py.safe.json`, `small-ts-apply.remote.py.safe.json`, `final-status.remote.py.safe.json`.

At closure, the agent exited playback through Home. Both Gateways and Edge replicas were healthy, public sessions and raw pumps were zero, background admissions were restored and the language worker was running. No support message, proxy change or global rollout was performed.

## Remaining work

Confirm the MP4 metadata byte boundaries before changing initial-read caching. For TS, measure how much of the remaining time belongs to serial timestamp search versus delivery; a validated position index would avoid searches only where suitable evidence exists. Neither item is claimed repaired by this iteration.

## Follow-up: complete MP4 metadata windows (same day)

Revision `00a9dcba34c808ef58b7c27a3c5f75eea874fee3` adds a bounded top-level `moov` scheduling boundary. On the native MP4 pilot route only, an exact provider response finishes at that boundary before reading media speculatively. It does not accept partial responses, weaken validators or infer playable coverage from a declared box size. Split headers, unsupported layouts and byte-identical full/cached broker reads are tested: 167 tests passed, five optional skips.

After CI contracts and the isolated image/GPU canary succeeded, the owner-only Gateway was updated to image `sha256:c368c08efa3471e267dccc13bd4f54f592f1cf6f61d8d76162ed688b0a3ec152` at 06:46 UTC. Edge code had independently changed and its routing listed two owners; those changes were preserved. The Gateway cache flags still list one owner. Neither Edge replica nor the main Gateway was redeployed.

### Vermines: real metadata loss confirmed and repaired

The first production read now completes bytes 4,456,448–5,558,469 (1,102,022 bytes), exactly finishing the metadata. Previously a larger range at that location was superseded before completing, so its metadata suffix was not retained. Speculative bytes after the metadata can still be abandoned normally.

- Cold post-restart opening: first progressing browser sample at 31.323 seconds (telemetry first frame 31.142 seconds). This remains slow and is not a cache-hit result.
- Warm reopening: first progressing sample at **5.523 seconds**, with **12,112,070 cached bytes seeded** and 62 cache hits by closure. The initial metadata suffix was not fetched again; the first subsequent provider range begins at byte 5,558,470.
- Playback advanced from 1392.271 to 1507.608 seconds by elapsed 120.857 seconds. All post-start samples had readyState 4, with no equal-time pairs. Sampling has gaps between tool calls; this is not an exhaustive event-based guarantee.
- Initial cached/read-ahead buffer ended around 1446 seconds, so the observed progression extends beyond it.
- A buffered 10-second backward seek was already progressing at the first sample, **320 ms** after the action.

### Minnal: still not resolved

A post-restart opening took **21.353 seconds**. A subsequent out-of-cache seek to exactly 4,444 seconds first progressed at **16.859 seconds**. Gateway readiness was 10.681 seconds, first segment 10.161 seconds, with zero interrupted provider ranges at inspection. The same multi-step timestamp search remains; shorter network responses contributed to the difference from the preceding 20-second run. No new TS acceleration is claimed from this MP4-only correction, and no general rollout is justified.

PR772 remains a draft. The production pilot contains the MP4 correction; remaining latency and broader repeatability are still open.

## 07:00 UTC follow-up: smaller TS search experiment rejected

Candidate `aafefc7ae60b7585a06e9d7fe4f7b6828bfd2960` reduced pilot TS lookbehind and first regular slice to 64 KiB. 183 focused tests passed, six optional skips; CI contracts and isolated image/GPU checks passed. It was temporarily deployed only to the owner pilot.

At the same 4,444-second seek target, browser progression started at 20.536 seconds, Gateway ready at 14.443 seconds. The first six provider windows totalled 791,800 bytes versus 2,102,520 bytes in the preceding 256-KiB trace, but network time did not improve reliably: the initial 262-KiB header took 3.089 seconds and a later 2-MiB continuation took 15.262 seconds. Smaller windows did not eliminate the sequential timestamp-search requests. No successful seek acceleration is claimed.

The experiment was reverted in `b722684c1`. At 07:01 UTC production was restored to the previously validated MP4-correction image `sha256:c368c08efa3471e267dccc13bd4f54f592f1cf6f61d8d76162ed688b0a3ec152`, with the original TS settings, admissions restored and Edge/main Gateway unchanged. Sanitized deployment receipts are `ts64-apply.remote.py.safe.json` and `tsrestore-apply.remote.py.safe.json`; search trace is `ts64-search.safe.json` in the local artifact directory.

### Repeated Vermines reopens after restoration

- The cold post-restart opening took 46.952 seconds to the first progressing sample. This reinforces the distinction between cold input and a cache hit.
- First warm reopening: 5.660 seconds. The player advanced from 1537.401 to 1665.157 seconds by elapsed 133.409 seconds. No stall in the samples; initial buffer ended near 1574 seconds, so continuation passed beyond it.
- Second warm reopening: 5.126 seconds. By elapsed 115.522 seconds the player advanced from 1665.096 to 1775.489 seconds, readyState 4 and buffer through 1840.594 seconds. No stalled or low-readiness post-start sample; continuation passed the initial buffer near 1720 seconds.
- The polling intervals have tool-call gaps. These observations support repeatability for these positions and this account, not an exhaustive no-freeze or all-copy guarantee.
- All jobs of CI run 38119678050 succeeded. Its candidate was nevertheless reverted because the real TS latency goal was not met. The successful MP4 correction remains deployed, with no new general rollout.

## Fresh temporal landmarks — continued investigation

The next candidate keeps small, account-scoped timestamp/access-point hints for ten minutes. Hints only choose where to read: playback requires a newly received complete program graph, current origin, duration, complete H.264 SPS/PPS/IDR and audio/video clocks around the point. Every read remains inside the existing serialized provider broker. No additional provider slot or public endpoint is introduced.

Early candidates still fell back to the ordinary FFmpeg timestamp search:

| Revision | Real action | First progressing browser sample | Fresh finder result |
| --- | --- | --- | --- |
| `082765ce0` | seek to 4,444 s | 23.252 s | Scheduling budget exhausted |
| `c748d6bcc` | seek to 4,444 s | 13.866 s | No accepted point |
| `e54f3c4fa` | reopen at 4,524 s | 15.752 s | Points 31–42 s before target, too early |
| `b440a25d6` | reopen at 4,604 s | 12.973 s | Point 1.27 s before target rejected by 2 s margin |
| `01923a2e1` | reopen at 5,016 s | 15.214 s | Short sample lacks usable clocks |
| `01923a2e1` | seek to 4,444 s | 26.950 s | Short sample lacks usable clocks |

These results **do not demonstrate acceleration from landmarks**: none used an accepted point. The nine-second finder budget controls scheduling of additional reads, not a hard deadline on an already-running provider request. Its elapsed time must not be described as guaranteed bounded to nine seconds.

The last seek measurement excludes the old playing resource: it was observed reset to zero/readyState 0 before the first new progressing sample. At elapsed 154.955 s, the new resource reached 128.617 s with readyState 4 and no media error. Tool-call gaps prevent exhaustive freeze detection.

The AAC-only candidate permits a one-second preroll only when the codec is identified by fresh ffprobe data; other codecs retain two seconds. Complete IDR and audio on both sides remain required. A metadata hint never relaxes those checks. A subsequent correction (`d208b7c4e`) retries a short sample lacking program headers at the same offset using the normal larger window, rather than immediately abandoning the finder. Focused tests: 192 passed, six optional skips. Actual use and latency remain to be checked.

Owner-pilot-only receipts and diagnostics are stored under `.codex-artifacts/startup-cache-20261010/`: `fresh*-deployment.safe.json`, `fresh5-reopen.safe.json`, `fresh6-target4444.safe.json` and `fresh7-tests.log`. Main Gateway and both Edge replicas were preserved throughout these pilot experiments. No new general rollout or support message is authorized by these results.

### An accepted real point exposes an AAC clock defect

Revision `d208b7c4e` still took 20.924 s to reopen at 4,572 s without an accepted point: its final sample began almost twelve seconds **after** the requested target. At a subsequent seek to 4,607 s, however, the current graph/IDR/audio clocks were accepted with 4.270 s preroll. The finder took 7.931 s and FFmpeg readiness 3.383 s. This is the first actual `finiteTsIndexUsed=true` result in these experiments.

It did not validate rapid playable output: startup decode verification failed and the first three output segments contained an AAC declaration with no decodable audio. A same-input A/B using 2 MiB already retained by the existing broker opened **zero additional provider responses**. `aresample=48000:async=1:first_pts=0` reported timestamp compensation errors of 4,602.760 and 1,559.646 seconds. Removing `first_pts=0` from that source-clock pipeline decoded 23 frames without error. Both arms used the same trim timestamp; no provider path or codec setting was changed.

`25753cef7` extends the existing source-clock audio filter guard to indexed TS. On the real 4,944-second resume, three finalized HLS segments then decode as AAC-LC, 48 kHz, stereo, with zero decoder error bytes. Their first A/V start difference is approximately 36 ms. The startup decoder proof passed. This validates the demonstrated audio defect correction, **not human listening quality or fast startup**: initial production rate was 1.206x, below the 2x startup gate, and the browser was still paused at elapsed 27.193 s. A later seek to 4,941 s also remained waiting at 26.978 s after the finder rejected its available points. Exact later click-to-play values were not sampled.

### Reuse complete observations instead of repeating cold searches

`5f539d97d` admits the fresh finder only near temporal observations already gathered by the ordinary broker. Unknown positions retain ordinary seeking without the additional cold finder reads. A complete local response assembled from valid cached/new windows also contributes metadata hints; individual network fragments had missed program-header/IDR relationships. A nearby point starts with the normal 2-MiB window rather than an additional serial small sample.

For freshly identified AAC, a complete audio PES up to 250 ms after an IDR may prove the lane, provided its bytes are inside the selected input cut and its clock is at least 500 ms before the trim target. Audio beyond the IDR, two clean video seconds and the existing origin/graph/IDR checks remain required. A 600-ms audio gap cannot authorize that point in the focused test. Other audio codecs keep the prior requirement. This is a narrow current-data proof, not acceptance of an old byte offset.

Focused tests: 238 passed, seven optional skips. The code CI contracts of `25753cef7` passed; final real latency and continuity validation for `5f539d97d` remains pending at this point in the log.

### Real admission diagnostics and exact-point revalidation

`5f539d97d` reopened at 5,158 s in 20.510 s, then the 5,161 s seek remained paused at 26.851 s. Neither used a fresh point. A read-only reparse of the live broker's cached 256-KiB head and one complete 2-MiB window produced a valid origin, 206 video clocks and two points, with a nearby clock for that target and zero parser invalidations. It opened zero additional provider responses. This proves usable metadata in those bytes; it does not establish the earlier admission refusal's exact cause. All four CI jobs of run 38124314071 subsequently succeeded.

Revision `1ab3e46ea` adds protected metadata-only admission diagnostics and isolates the optional persistent-index observer from the hint observer. No source URL, account identifier or bearer token is exposed. The real 5,747 s reopening took 15.394 s. A following seek backward to 5,744 s lay before the browser's buffered interval and actually used a fresh point: finder 5.485 s, FFmpeg readiness 0.865 s, total Gateway readiness 6.381 s, first progressing browser sample 12.926 s. At elapsed 196.712 s the new resource had progressed to 184.514 s, readyState 4, no media error, past its initial 24-second buffer. Sparse tool-call samples cannot prove absence of every short interruption.

The diagnostics showed one matching scope, an unexpired origin, one audio track, 21 points, no full-probe fallback and no observer exception. This confirms correct admission in this particular repeat; the preceding refusal remains unexplained rather than attributed speculatively.

`b8c9784e2` tests a narrower verification path: re-read the old IDR's location, and require the fresh packet offset, PTS/DTS, complete graph/IDR, fresh origin and surrounding A/V clocks to match. The old observation selects only the read. A missing, changed or incomplete point falls back to ordinary seeking. When that direct proof succeeds, a separate remote tail scan and duration-based search are unnecessary. Focused tests: 240 passed, seven optional skips; changed-clock and partial-window refusals covered. Real latency and continuity remain pending at this entry.

On the owner pilot, its cold 5,928 s reopening took 18.681 s and retained ordinary seeking. The subsequent seek to 5,926 s was before the original browser resource's beginning and used `fresh-witness`: two complete reads, 2,359,296 bytes, finder 4.555 s, FFmpeg readiness 1.872 s, Gateway readiness 6.453 s and browser progression at 12.555 s. At elapsed 206.151 s the new resource reached 193.955 s, readyState 4, no media error, beyond the initial twelve-second buffer. This confirms current-point use, but not a reliably sub-ten-second seek.

Click timestamp was 08:44:53.531 UTC; the new cloud playback row was created at 08:44:58.520 UTC and Gateway session at 08:44:58.634 UTC. Thus almost five seconds preceded Gateway creation. WatchPage's processed-seek debounce, awaited pipeline closure and 900-ms cooldown are sequential. The broker also acknowledges its own logical provider release grace before closure completes. This is a quantified follow-up opportunity, not proof that all five seconds can be removed; no frontend/Edge cooldown was changed in this experiment.

After normal closure, the 6,120 s reopening reused a freshly sample-validated private HLS window and seeded 8 MiB input. First progressing sample: 6.638 s. At elapsed 145.410 s, local time reached 140.884 s, readyState 4, no media error; continuation crossed both the initial sixteen-second browser buffer and the roughly fifty seconds of prepared HLS coverage. Three finalized segments decoded as AAC-LC, 48 kHz stereo, with zero audio error bytes. No human listening acceptance is claimed.

The latter live hint diagnostic reported a 30.651-second nearest frame clock despite intact point metadata. Bounded thinning can discard nearby frame clocks while retaining a complete IDR's timestamp. Revision `46465dccd` lets such points admit a fresh read too; they still cannot authorize playback. The focused regression reproduces the thinning case. 241 focused tests passed, seven optional skips. Cloud-contract CI run 38126260499 succeeded; packaging and final production replay are pending at this log entry.

### Final owner-pilot candidate replay

Revision `46465dccd6611e878f5fc86ccf73b9e98cbbd644`, image `sha256:154bf5323efddb6cd75334da5ea27509bc51cfcaddd47ddbe5939bad71295299`, deployed at 08:56:04 UTC after existing background leases drained naturally. No lease was forced; admissions were restored. Main Gateway and both Edge replicas were unchanged.

The first post-restart 6,258 s opening used ordinary seeking and took 16.598 s. A backward seek to 6,251 s lay before that resource's start and used a freshly rediscovered exact witness: two reads, 2,359,296 bytes, finder 4.283 s, FFmpeg readiness 0.887 s, total Gateway readiness 5.206 s, first progressing browser sample 11.467 s. The old resource was observed reset to zero before the new progression; no stale frame is counted as success. Three finalized output segments decoded as AAC-LC, 48 kHz stereo, without decoder error bytes. The approximately six seconds outside Gateway startup remain part of the actual user delay.

At elapsed 168.167 s, that Minnal resource reached 157.070 s, readyState 4, no media error, with its initial sixteen-second buffer long passed. Sixty one-second samples across three observed windows contain no paused, low-readiness, error or stalled interval; there are tool-call gaps between windows. No frame-drop, human-listening or exhaustive no-stutter certification is implied. All four jobs of CI run 38126260499 succeeded.

The native MP4 Vermines follow-up remains distinct: no Gateway HLS session was used. The first post-restart opening still had no playable data at 34.866 s; the next tool observation at 71.228 s was progressing. The unsampled gap prevents an exact cold first-frame value. After closure, first warm progression was observed at 12.342 s. By elapsed 149.062 s it reached 1,983.970 s, roughly 137 s beyond the initial resumed clock, readyState 4, no media error. Fifty one-second samples in two windows contain no stalled or low-readiness interval; data grew past the initial disjoint browser ranges. A second warm reopening starts at 9.997 s; its continuation is pending at this entry. The earlier five-second results cannot be treated as a fixed latency promise for these different positions/network conditions.

The second Vermines reopening reached 2,131.550 s at elapsed 150.130 s, around 140 s of progression after its 1,991 s resume point. Sixty one-second samples in two windows contain no stalled, paused, low-readiness or error observation; continuation passed the initial ranges ending at 2,037.586 s. Native transport close receipts report 16,240,838 and 33,554,432 seeded input bytes with 60 and 195 cache hits on the two warm openings. These are input seeded/cache-hit counters, not a claim that every seeded byte was consumed. Both also fetched new data. The cold opening seeded zero bytes, explaining why it must remain separate from a warm-cache result.

**Closure / retained deployment:** the exact-point TS candidate remains active only for the existing recent-resume owner gate; Vermines retains the validated MP4 correction. PR772 remains a draft and there is no general rollout. Minnal's last out-of-browser-buffer seek is improved in this observed position but still takes 11.467 s from user action; its cold opening takes 16.598 s. The warm HLS reuse at 6.638 s was measured before the last hint-admission fix, on `b8c9784e2`, rather than presented as a repeat measurement of the final image. Warm Vermines repeats are slower than the preceding five-second observations. No guarantee across positions, accounts, files or network conditions follows from these results.

Tests stopped via normal Home navigation. Final checks: both Gateways healthy with zero active sessions/raw pumps; both Edge replicas healthy; owner startup scope remains one; background admissions unpaused, dispatcher STOP removed and selection worker running. Existing background validation work has resumed and its legitimate lease was preserved. No NodeMaven message or network-routing change was made. Sanitized evidence: `fresh12-apply.remote.py.safe.json`, `fresh-lite.remote.py.safe.json`, `fresh-native.remote.py.safe.json`, `fresh-audio.remote.py.safe.json`, `final-status.remote.py.safe.json`, and `fresh12-tests.log` under the local startup-cache artifact directory.

## Follow-up: public seek handoff and bounded witness replay

PR773 is merged and its exact public WatchPage bytes verified. It removes fixed client waits after confirmed strict closure while preserving the provider barrier. The owner TS candidate now verifies a smaller current witness response before growing it. The complete replay, current CI results, cache refusal, measured remaining delays and closure receipts are in [the handoff report](2026-10-11-cloud-seek-handoff-wait.md). Vermines warm opens were 6.702/7.729 s; the new Minnal candidate's same-target seeks were 25.990/11.679 s. The latter is still not a reliably rapid result. PR772 remains a draft and no general rollout is justified.
