# Minnal: discard less position work and recover from refused private delivery hints

## Scope and measurements

Continue the existing owner-only startup/resume pilot on real catalogue Minnal Murali (MPEG-TS) and Vermines (native MP4). The requested outcome is a short restart/seek followed by sustained progression beyond retained input. No general rollout, provider credentials, relay changes or shared media cache are included.

Browser latency is measured from the public UI click to consecutive one-second samples with progressing media time, readyState at least three, no media error and no paused state. Observation gaps are explicitly a limitation: sampled progression is not human audio acceptance or exhaustive frame-drop/stutter monitoring. Gateway readiness and validation timings are reported separately from browser latency.

## Diagnosis and code corrections

### TS search before and after HLS validation

Session creation prepared a TS position before testing its matching sampled private HLS candidate. The fresh validation then drained that broker. It performed another position search before acquiring the already prepared output, although the cached continuation uses a different splice boundary. Both searches could therefore be discarded.

- Revision 37e0837a acquires a fully freshly validated HLS window before deciding whether another position search is needed. Only a real acquired cache lease permits deferral; misses keep ordinary current-point verification. An early lease is released on preparation error, missing broker or revocation.
- Revision defdff6f1 also defers the **initial** search, only when the admitted owner has an exact matching sampled HLS candidate at the requested position. It still creates the serialized broker. The normal current search is restored after failed validation. Missing, mismatched, legacy, non-admitted, startup-job and zero-offset cases do not gain this deferral.

The cache never authorizes media solely because a candidate exists. Fresh current file size, target identity and all four sample digests still decide acquisition. Single provider ownership, drain/release grace and buffer admission are retained.

### Refused retained delivery addresses

Production diagnostics distinguished the local validation response 502 from the supplier response **509**, before any fresh sample completed. Ordinary source opening then succeeded. This identifies a failed retained-address shortcut; it does not establish why the supplier refused it or blame the relay.

- Only a genuine consumed private routing hint, a drained validation broker, zero completed ranges and a numeric upstream 509 can record a refusal.
- Initially the refusal was bound to one delivery identity. The repeated production opening still tried another refused retained address. The revised ten-minute bounded refusal is tied to the same private owner/source/file-size/user-agent/route binding, so rotating delivery paths cannot repeatedly incur that failed shortcut.
- A subsequent claim starts at the normal source on the same route. It must still validate the fresh target and complete all current samples. There is no second validation attempt on the failed claim, no media authorization from the refusal and no failure label applied to the supplier catalogue.
- Hashes and timestamps alone are retained, maximum 64 refusal entries. Other owners, sources, sizes, user agents and routes remain isolated. Other status codes do not trigger it.

### Smaller complete origin read

Revision a7eef4cea tries a **complete 64-KiB current TS header**, extending to a complete 256-KiB header only when the program graph/origin proof is insufficient and the scheduling budget allows another read. A partial range cannot authorize a position. The exact IDR packet location and PTS/DTS, current PID graph, complete IDR and surrounding A/V proof remain required. The normal 512-KiB witness plus header totals 589,824 logical bytes rather than 786,432. This is less verification I/O, not a guarantee of faster delivery.

## Intermediate real replay: not successful cache acceleration

| Revision | Minnal opening | First progressing sample | Observation |
| --- | --- | ---: | --- |
| 37e0837a | Warm | 30.237 s | Retained hint refused 509; zero samples; ordinary input fallback |
| a7eef4cea | Cold | 16.767 s | No private HLS hit |
| a7eef4cea | Warm 1 | 25.993 s | 9.083 s unavailable validation, then 6.007 s current finder |
| a7eef4cea | Warm 2 | 21.153 s | 6.767 s unavailable validation, then 3.742 s current finder |

The first cold 37e0837a action was not sampled until 21.612 seconds; its 22.664-second first consecutive progress sample is **not** an exact startup measurement. The warm 37e0837a run also has unobserved gaps and excess elapsed time relative to media progression; do not present it as uninterrupted playback. Positions differ across these openings.

These measurements led to defdff6f1; they do not validate rapid Minnal cache reuse. Safe timing snapshots and replay boundaries are in the private worktree artifact directory.

## Verification before the final pilot replay

- Focused tests on the complete-header finder, private routing hints, cache validation, actual strict HTTP broker, startup cache and bounded input: **379 passed, seven optional skips, zero failed**.
- Actual HTTP regression: a drained 509 hint refusal is followed by a normal-source claim even when its retained path rotates; all four current samples match, maximum one provider response at a time. Separate changed-target and altered-sample fences remain tested.
- Isolated final-image canary passed health, exact source hashes and GPU encode, with zero provider requests.

Final production replay and closure receipts are recorded below after completion.

## Intermediate deployed defdff6f1 replay

The owner pilot image `sha256:c76761b663939580171393475d6682d875460888b41b924e91ac07e719bccc41` was deployed at 10:57:57 UTC. CI run 38133632777 passed **6,412 tests, 35 skipped**, plus 41 contracts. Existing work drained naturally; routing, main Gateway and Edge replicas were unchanged.

| Minnal action | First progressing browser sample | Server observation |
| --- | ---: | --- |
| Initial opening at 7,967 s | 18.965 s | Ordinary input; Gateway 15.732 s |
| Immediate Home reopening at 7,967 s | 15.459 s | Requests the earlier position; no HLS candidate; Gateway 8.957 s |
| Refreshed-history reopening at 8,092 s | 29.178 s | Prior exit rejected capture for insufficient ahead; Gateway 23.965 s |
| Seek to known cached position 8,038 s | Exact latency not sampled | Hint refused 509; validation plus current finder 7.994 s; Gateway 41.232 s |
| Repeat seek to 8,038 s | Exact latency not sampled | Refused shortcut **not reused**; current normal header in 1.489 s; changed target rejected; Gateway 27.181 s |

The immediate Home reopen occurred before fresh history was displayed and requested the old 7,967-second position, whereas the prior explicit exit had retained output around the later viewed position. After Home refresh, the next request used the newer saved 8,092-second history. This test is not a demonstrated HLS cache hit. The newer capture was rejected as `insufficient-ahead`, retaining the previous usable window rather than publishing inadequate coverage.

The 8,092-second resource subsequently paused during the observed window: at elapsed 116.418 s it was paused at local 74.015 s with readyState 4. It fails continuity acceptance. The first cached-position seek was unobserved between 29.861 and 68.126 s; its 69.178-second first consecutive progressing sample is only an upper observation bound. The repeat was last sampled empty at 30.075 s, then observed at local 200.468 s before close; its exact browser start was not measured. Neither is described as fast or continuously monitored.

### Additional current-header observation correction

The repeat did correctly bypass the refused hint: `recentDeliveryTargetUsed=false`, normal header received in 1.489 s, then `target-changed` with only the path differing. The older HLS window remained rejected. This confirms recovery of the routing shortcut, not authorization of old media on the changed target.

Its fresh header was handed to the ordinary broker, but **not** to passive TS navigation observers. During the earlier long replay, the ten-minute initial-origin hint expired; subsequent body observations had no origin. `hasNearby` was then false and ordinary FFmpeg performed the remote position search despite possessing a current complete header.

Revision **54ab028cf** passively observes only the same claim's complete, freshly drained, successfully seeded header. Source/size/user-agent/scope/age/target binding of the one-use handoff remains mandatory. Metadata receives a detached copy; observation failures do not interrupt playback. This restores navigation origin from current bytes, without reviving an expired trusted point or approving old HLS media. The resulting seek still reads and verifies the current origin and complete IDR witness before using its byte offset.

Focused verification: **380 passed, seven optional skips**. Actual HTTP callback receives the current rejected-cache header, mutation cannot alter the playable input, and a subsequent changed delivery response still fails. The navigation expiry test restores the clock with a current header, then verifies that invalid current origin bytes still refuse playback authorization.

## Deployed 54ab028cf production replay

Owner pilot image `sha256:f0a12208ab99bfee6cf8dd141604a714714a77f1a48dbc23ca88fa4e70acdb9f` was deployed at 11:17:54 UTC. A legitimate validation lease drained naturally for approximately 132 seconds. Main Gateway, Edge replicas, routing and the existing pilot audience were unchanged. CI run 38134774923 passed **6,413 tests, 35 skipped**, plus 41 contracts; Android phone, Android TV and Windows packaging jobs also succeeded.

### Vermines native MP4

| Public action | First consecutive progress / first ready seek sample | Continuation evidence |
| --- | ---: | --- |
| Cold opening around 2,708 s | 53.952 s | First 1-MiB range required 15.577 s; no input seed or cache hit |
| Warm reopening | **6.472 s** | 18,239,686 input bytes seeded, 50 actual cache hits, 55,033,451 new provider bytes |
| Back 10 s | **0.340 s** first ready sample at expected position | Target reached; no paused/error/low-ready sample in the short seek window |
| Forward 10 s via keyboard | **0.286 s** first ready sample at expected position | One initial readyState-one sample, then progression |
| Second warm reopening | **5.477 s** | 32 MiB input seed, 195 cache hits, 36,821,966 new provider bytes |

The first warm replay continued for 123.468 wall seconds after the last successful seek, with media time progressing from 2,861.934 to 2,985.391 s. Three observed windows (90 one-second samples) contained no pause, error, low readiness or identical-time pair. An intentional short pause used to reveal controls is excluded. An attempted click on the hidden forward button did not execute and is excluded from results.

The second warm replay progressed about 150 media seconds after startup, beyond its initially observed browser range. Later sampled windows were also free of pause/error/low readiness. Sampling gaps remain; this is not an exhaustive frame-drop analysis or listening validation. The cold opening remains a real limitation, not a warm-cache result.

### Minnal MPEG-TS

- Cold opening at 8,238 s failed preparation without a first image; the public terminal state appeared after the preparation deadline. The initial broker had already begun reading. No reusable window was available for this claim.
- A second opening at the same position used a freshly verified IDR witness. Its complete 64-KiB header took **6.267 s** and complete 512-KiB witness **12.360 s**. Finder time was **18.695 s**; before-FFmpeg time **18.725 s**; overall Gateway readiness **68.682 s**, with measured subsequent media production only **0.697x**. Exact browser startup was not sampled. The player later exhausted its reserve: 30 samples from elapsed 245.954–275.845 s remained paused at local 110.061 s despite readyState four. This opening fails continuity acceptance.
- After this resource recovered and accumulated usable ahead, its explicit close saved progress 8,427 s and a new HLS window. A Home refresh loaded that exact saved position.
- **Fresh cached reopening at 8,427 s started in 5.700 s.** All four current sample digests completed in 752/832/851/689 ms; total validation **3.128 s**, Gateway readiness **3.170 s**. A real private HLS hit exposed **49.009 s** of cached ahead and seeded **8 MiB** of current-validated input. Continuation became ready after **9.398 s**.
- Three sampled windows followed to elapsed 196.994 s / local 194.944 s without a paused/error/low-ready or identical-time sample after startup. The explicit close later observed local 279.403 s with readyState four. This proves continued new input beyond the original 49-second cached window, with unobserved gaps explicitly retained.
- Three already-prepared HLS segments from the earlier ready resource were independently probed and AAC-LC decoded, 48 kHz stereo, without decoding errors. This is not human listening acceptance or an audio-raccord test of the later cached reopening.

The warm-cache success does not validate a rapid uncached seek or cold opening. Delivery behavior varied significantly within these tests; no attribution to supplier or relay is established.

### Fresh-origin expiry boundary

The successful cached replay again reported `originKnown=false` after receiving a fresh header. The hint batch's original ten-minute clock can expire just after a current header is re-observed. Subsequent body observation then discarded that current origin with old body points.

Revision **871da44b2** records the timestamp of a valid current zero-offset origin separately. At batch expiry, old body clocks/points are discarded; only an origin genuinely observed within its own ten-minute lifetime is retained. New body data cannot extend an expired origin. It is still passive navigation metadata: the current complete header and IDR witness remain required before playback uses an offset.

The regression first failed on the preceding implementation, then passed with this correction. It proves that old points are discarded, a current origin survives the boundary, corrupted current headers still refuse seek authorization, and subsequent expiry drops the origin. Focused suite: **381 passed, seven optional skips**. Final-image canary verified health, exact source hashes and GPU encode with zero provider requests.

## Deployed 871da44b2 replay and next bounded-size refinement

Owner image `sha256:adf6cce82e16a81d9a52b096882e2a2f88ac04c91944485720484c92698699a0` was deployed at 11:46:42 UTC after natural background drain. CI run 38136585533 passed **6,414 tests, 35 skipped**, plus the separate contracts; Android phone/TV packaging passed. Main Gateway, Edge replicas and routing remained unchanged.

The first reopening after replacing the pilot had **no reusable HLS window**: it is a cold measurement, not a cache claim. At requested 8,703 s, first consecutive browser progression was **27.345 s**, Gateway ready **25.008 s**. Before-FFmpeg time was only 66 ms; ordinary input/position reading dominated.

A public timeline seek requested **9,004 s**, outside the browser's current source coverage (maximum roughly 8,879 s). A rejected 94.16 slider value did not execute; the actual accepted 94.2-percent action is the measured seek. Old-resource samples before the first empty-resource reset are excluded.

- First consecutive progression on the new resource: **15.497 s**.
- Current IDR witness used, preroll **1.522 s**, fresh finder **8.279 s**, before-FFmpeg **8.331 s**, Gateway ready **12.758 s**.
- Complete 64-KiB origin response **2.514 s**; complete 512-KiB witness **5.697 s**. No provider slot wait in those ranges.
- The later observed window at elapsed 325.023–354.911 s progressed from local 310.228 to 340.087 s, readyState four, not paused, no error or identical-time pair. Explicit close observed local 419.771 s. The large unsampled gap prevents a claim of continuous frame monitoring.

This validates the fresh temporal witness but remains above the intended rapid seek target. A later AAC helper could not acquire its required ready-session state, so no additional decode/listening success is claimed for this resource.

### Read-only proof on already received real TS bytes

The current header and exact witness were reread from the same local broker's completed cache: **zero new provider fetches**, four local cache hits. An in-memory diagnostic of the unchanged finder compared complete smaller witness lengths, without editing production code:

| Current witness length | Exact current origin/IDR/A/V proof |
| --- | --- |
| 192, 256, 320 KiB | Insufficient; refused |
| **384 KiB** | Accepted, same IDR and 1.522-s preroll |
| 512 KiB | Accepted, same IDR and preroll |

Revision **c1f165c60** records bounded A/V coverage as a **read-size hint only**, alongside existing metadata-only navigation points. It chooses a complete 128–512-KiB response, rounded to 64 KiB. The current origin, graph, exact point and two seconds of A/V still authorize the point. Insufficient current coverage expands at the same position to 512 KiB, then the existing 2 MiB limit if the scheduling budget permits. Complete prefix bytes are reused by the serialized broker. Malformed size hints cannot expand the request; changed, partial or unsupported current evidence remains refused.

Origin freshness is also checked independently of the newer body batch's timestamp. New body observations cannot make an expired origin appear current. Focused suite: **384 passed, seven optional skips**; includes insufficient-hint expansion, invalid-size fences and independent origin expiry. Final-image canary passed exact source hashes, health and GPU encode with zero provider requests. Production replay of this final revision follows below.

## Final c1f165c60 owner-pilot replay

Image `sha256:b776cd5fb13d7d471765817ffe249a5661fa99587332a8515bd18c06af191904` was deployed at **12:02:53 UTC on 11 October**. Existing background ownership drained naturally; all admission workers were restored. Main Gateway, Edge replicas, public WatchPage and routing were preserved. Rollback image/container retained.

Code CI run **38137504445** completed successfully on all four jobs: **6,417 passed, 35 skipped**, plus 41 contracts. Android phone/TV and Windows packages succeeded. Only Gateway/server modules and their focused tests changed during this follow-up; there is no UI change.

### Exact-copy identification and measurement method

The public catalogue groups multiple files under the same translated film title. An initial selection opened the different MA/Dino MKV, size 1,098,446,805 bytes, five audio tracks and one subtitle. It remained in preparation during its 30 sampled seconds and was stopped normally. This is **excluded** from the MPEG-TS comparison. An attempted Home lookup and a rejected `91.0` slider value also performed no measured seek and are excluded.

Searching the exact provider title `MA - Minnal` exposed the distinct Dino TS variant. Its public play button item digest matched the existing private target; the current Gateway confirmed **927,773,232 bytes**, requested positions and the TS route. Provider identifiers are omitted. The initially selected other MKV and the TS variant were distinguishable by the public TS version label and Home history-card item digest; title alone was not sufficient.

Final confirmed browser latency below requires **two consecutive samples**, at most two seconds apart, both unpaused, without error and with readyState at least three, with more than 0.25 seconds of media progression. Old-resource samples preceding the seek's first empty-resource reset are excluded. Initial positioning or one isolated progressing sample is insufficient. This is intentionally more conservative than first-image or first-positive-clock timing. The earlier commentary's sub-ten-second observation at 8,698 s becomes **10.402 s** with this complete confirmation criterion.

| Public action on the exact TS copy | Confirmed browser progression | Current Gateway proof |
| --- | ---: | --- |
| First restart from zero | **6.601 s** | Gateway 3.218 s; no reused HLS window |
| Second restart from zero | **6.550 s** | Ordinary zero-start route; not a warm-HLS claim |
| First seek to 9,004 s, no nearby point | Exact latency not sampled | Gateway **29.169 s**, before FFmpeg 25 ms; ordinary serialized position reading |
| First seek to 8,698 s, no nearby point | Exact latency not sampled | Gateway **25.953 s**, before FFmpeg 42 ms; ordinary serialized position reading |
| Return to known 9,004 s outside current browser coverage | **13.440 s** | Fresh witness **2.671 s**, current 64-KiB origin + **384-KiB witness**, 1.522-s preroll; Gateway 7.593 s |
| Return to known 8,698 s after restarting from zero | **10.402 s** | Fresh witness **2.706 s**, 393,216 total bytes (64-KiB origin + 320-KiB witness), 6.274-s preroll; Gateway 6.622 s |
| Home reopening at saved 8,857 s | **6.402 s** | **Real private HLS hit**, 49.022 s cached ahead, **8 MiB** validated input seed; Gateway 3.265 s |

The first cold seeks were last sampled empty at about 30 seconds and next sampled already progressing around 46–48 seconds. The 46.847/48.984-second confirmed samples are observation upper bounds, **not exact browser startup latencies**. There is an intervening tool-call gap. These openings were still demonstrably slow at the Gateway and are not presented as successful rapid seeks.

The return to known 9,004 s had **zero input-range reuse and no HLS-window hit**. Its current complete origin took 1.585 s, the complete 384-KiB witness 1.025 s, with no provider slot wait. Its verification consumed less current data than the previous 512-KiB witness but delivery conditions differ; no fixed gain is promised. The explicit close at 89.862 s observed local 77.922 s, readyState four, playing, without error. The unsampled interval prevents exhaustive continuity acceptance for that case.

The second known-point return at 8,698 s had **90 one-second samples** in three observed windows. After startup, **78 samples** showed no pause, error, low readiness or stalled consecutive pair. The last sampled media clock was 140.043 s at elapsed 148.492 s; explicit close observed local 159.632 s at elapsed 168.053 s, readyState four and playing. This validates more than two minutes of progression after this uncached point recovery, with observation gaps preserved.

### Real HLS-cache reopening and continuation

After normal close and Home refresh, the exact TS history card requested **8,857 s**. The distinct MKV card was excluded by its different item digest and remaining-time label.

- All four fresh sample digests completed in **741/784/761/935 ms**; total sampled validation **3.225 s**. The weak/absent strong validator remains explicit: this is `sampled-recent-v1`, not a strong ETag validation claim.
- The acquired private HLS window contained **49.022 seconds ahead**, plus an **8-MiB** input seed. No discarded position search ran before acquisition.
- The continuation became ready after **12.393 s**, while the cached video was already playing.
- **90 samples** in three observed windows; **82 samples** after the initial startup interval contained no pause, error, low readiness or stalled consecutive pair. Last sampled local time was **161.331 s** at elapsed **162.973 s**.
- Explicit close before the deliberate screenshot pause observed local **222.997 s** at elapsed **224.586 s**, readyState four, unpaused and without error. The browser range reached local **344.078 s**. This proves substantial new data after the original 49-second window; the unsampled gaps do not certify every frame.

Three prepared TS segments from the initial 9,004-second resource were independently probed and AAC-LC decoded at 48 kHz stereo without errors. This is decode acceptance for those excerpts, **not human listening or a complete audio-raccord validation** of the warm replay.

### Vermines applicability

The earlier two real native-MP4 warm replays (6.472/5.477 s, back/forward first-ready samples 0.340/0.286 s, continued new input beyond two minutes) remain relevant: the final two revisions change only the TS hint/finder module and its tests. The native MP4 transport/cache implementation was not changed. No additional optional MP4 replay is counted as new evidence.

### Closure and remaining limits

Tests were stopped through normal Home navigation; the agent-created test tab was closed. Both Gateways and both Edge replicas were healthy. There were **zero active playback sessions, zero raw pumps and zero live cloud claims**. Background admissions were enabled, dispatcher STOP absent and the selection worker running. No background lease was force-cleared. One dispatcher task was legitimately in flight at the closure observation.

**The final revision remains an owner-only pilot, with PR772 in draft.** Fast real HLS reuse is demonstrated. Current-point recovery is faster than blind position reading, but **10.4–13.4-second confirmed returns and 26–29-second Gateway cold seeks remain insufficient for a general rapid-start guarantee**. Cold delivery failures and interruption cases earlier in this report remain material limits. There is no general rollout, route substitution or supplier-wide performance label, and no human listening acceptance is claimed.

Safe evidence is retained under `.codex-artifacts/startup-cache-20261010/`: `c1f165-public-replay.safe.json`, `c1f165-replay-summary.safe.json`, `c1f165-known-9004.gateway.safe.json`, `c1f165-known-8698.gateway.safe.json`, `c1f165-cached-8857.gateway.safe.json`, `c1f165-current-ts-audio.safe.json`, `final-status.remote.py.safe.json`, and `c1f165-minnal-cached-continuation.png` (voluntary pause after the test). Private upstream URLs, credentials and tickets are excluded from the report.
