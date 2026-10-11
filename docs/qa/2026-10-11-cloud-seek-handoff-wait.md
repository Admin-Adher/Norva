# Cloud VOD seek: remove the duplicate wait before session creation

## Scope

Requested follow-up: reduce the pre-session wait, then replay Minnal Murali (TS) and Vermines (native MP4) on the existing owner pilot. No general rollout of the cache, TS finder, retained decoder or startup preparation is authorized by this report. Network routing is unchanged.

## Diagnosis and correction

The earlier accepted-point Minnal seek took 11.467 seconds, including approximately six seconds outside Gateway readiness. A new baseline action at 09:16:27.538 UTC created the cloud row at 09:16:32.650 and Gateway session at 09:16:32.843: **5.305 seconds before Gateway creation**. This baseline used the old public WatchPage; its exact later first-progress latency was not sampled.

PR773 changes only the shared WatchPage lifecycle and its tests:

- Committed Gateway scrub coalescing: 900 to 200 ms. Scrub previews still do not create sessions; only the latest committed target is resolved.
- Strict authenticated expiry must settle before creating the replacement. The redundant 900-ms client cooldown is omitted only after at least one confirmed cloud close. Legacy/local cleanup keeps that delay. Gateway transport drain, its release grace and server provider admission remain unchanged.
- Concurrent seek cleanup joins the ongoing barrier, including the interval where local session identifiers have already been cleared. Failure prevents replacement creation and preserves the failed identifiers for explicit retry.
- Exact title/episode identity, requested viewing position, autoplay intent, buffer admission and subtitle warmup remain covered by runtime tests.

This removes **1.6 seconds of fixed sequential client waits on a normal confirmed cloud seek**, not every component of the observed 5.305 seconds. It does not make a slow provider response instantaneous.

## Verification before publication

- 89 focused tests passed, plus the shared Node/WebView runtime regression and 14 selected-subtitle lane tests.
- Generated locale manifest refreshed; locale check, syntax and diff checks passed.
- Android emulator run 38128191088: all six configurations passed: four phone API 35 configurations (three-button/gesture, font scale 1.0/1.3) and TV API 34 at both font scales. The phone replay exercised the exact changed WatchPage/fixture bytes from revision 9f339d763; later revisions change only the generated manifest and source-contract expectation.
- Release head d53b9efae615891d08dbf1521d73425018ba5f5a: CI cloud suite **6,384 passed, 35 skipped, zero failed**. PR773 merged as c3818d64aafc74ea8fea4803439d06a273b1ebf0. Main build, Relay and Cloudflare workflows all succeeded.

Initial CI failures were resolved before release: a stale generated asset manifest, then a source-contract assertion expecting the former no-argument cleanup call. Neither failure was ignored.

## Public replay

The public WatchPage asset is `/js/pages/WatchPage.app-v2.6e5b578f827b17df.js`, SHA256 `6e5b578f827b17df7c18b6b2a378118136f5cbb96f178b59d2914fd22ca4a472`. Its delivered bytes match the Git object exactly. The agent's production tab was reloaded and its actual script source checked before the following replay.

### Minnal Murali — TS, initial Gateway candidate unchanged

Two seeks to the same 6,672-second target lay before the current resource's starting point; they were outside the browser buffer. Each old resource was observed reset to zero before counting progression.

| User action | Before Gateway creation | First progressing browser sample | Current-point verification | Gateway readiness |
| --- | ---: | ---: | ---: | ---: |
| Seek 09:35:15.323 UTC | **1.151 s** | **10.074 s** | 7.233 s | 7.906 s |
| Repeat 09:40:17.109 UTC | **1.445 s** | **20.034 s** | 16.297 s | 17.210 s |

Both used the same complete fresh witness and two reads totalling 2,359,296 bytes. The approximately five-second pre-creation baseline was reduced, but the transfer time of the verification ranges varied. These are not matched-position A/B measurements against the 6,251-second baseline and do not isolate the entire improvement to the frontend.

The first resource reached local time 133.807 s at elapsed 143.495 s; the second reached 161.524 s at elapsed 180.973 s. One-second samples in observed windows had readyState 4, no media error or paused observation and continued past the initial twelve-second buffer. Three finalized segments decoded as AAC-LC, 48 kHz stereo, without decoder error bytes. Human listening and frame-drop acceptance were not performed.

A normal reopening progressed at 9.955 s using a fresh witness, not a private prepared-HLS cache hit. Another opening's exact first-progress latency was not sampled; its fresh cache verification returned a 502 before any completed sample. Do not present the latter as a fast cache result.

### Vermines — native MP4, existing cache correction

The native MP4 route and its cache code were unchanged by PR773 or the later TS-only candidate. These measurements used the delivered frontend and pilot image 154bf5323e before the TS-only image update.

| Action | First progressing browser sample | Continuation |
| --- | ---: | --- |
| Opening with no seeded input | **35.257 s** | No blocked sample in the final 30-second observed window |
| Warm reopening 1 | **6.702 s** | Backward and forward jumps progressing within **1.337 / 1.283 s**; progression to 143.484 s after the forward jump |
| Warm reopening 2 | **7.729 s** | 124 seconds of media progression by elapsed 132.646 s |

The two warm close receipts each report **33,554,432 seeded bytes**, with 266 and 248 cache hits; both also fetched new data. Seeded byte counts are not a claim that every byte was consumed. The cold opening had zero seeded bytes and zero cache hits. Subsequent progression passed the original disjoint browser ranges, with no paused, low-readiness or error sample in the observed windows. Tool-call gaps prevent an exhaustive no-stutter guarantee; no frame-drop or listening claim follows.

## Additional owner-pilot TS experiment

Already cached, complete real TS bytes were reparsed without an additional provider fetch. A 512-KiB response around a known IDR could satisfy the existing exact packet offset, PTS/DTS, current origin/program graph, complete IDR and two seconds of surrounding A/V proof. A 256-KiB response could not satisfy those conditions in that sample. The full 2-MiB comparison extended outside the locally supplied diagnostic window, so its incomplete result is not evidence that a full provider response would fail.

Revision **fcd2a55bde86d56d68f5618d6fd49153cc4b8490** therefore tries a complete 512-KiB current witness response, expanding at the same position to 2 MiB when proof is insufficient and the scheduling budget allows another read. No proof condition, codec mapping, buffer threshold, provider admission or route is relaxed. Cached prefixes are reused by the serialized broker on expansion. Unknown positions keep ordinary seeking. The nine-second scheduling budget still does not impose a hard deadline on a running HTTP transfer.

- Focused TS/range/native MP4 checks: **83 passed, four optional skips**.
- CI run 38130273896: **6,404 passed, 35 skipped, zero failed**; all Android/Windows packaging jobs succeeded.
- Isolated final-image health, exact source hashes and GPU encode checks passed, with zero provider requests.
- Owner pilot image `sha256:80c3556e1697864a966b6fe0d7a78b682c25c91a93ffbcc529b65d9fcec157e1` deployed at 09:59:41 UTC after existing leases drained naturally. Main Gateway, both Edge replicas and routing were preserved. Cache scope remains one owner; existing unrelated routing allowlists were not rewritten.

### Real replay of the smaller witness

| Minnal action | First progressing sample | Before Gateway creation | Finder / FFmpeg readiness |
| --- | ---: | ---: | --- |
| Cold opening at 7,010 s, no witness optimization used | **62.563 s** | Not separately measured | Ordinary seek; Gateway ready at 58.315 s |
| Seek to 7,006 s | **25.990 s** | **3.644 s** | **13.382 / 7.390 s** |
| Same seek repeated | **11.679 s** | **1.247 s** | **3.286 / 5.392 s** |
| Normal reopening at 7,177 s | **22.172 s** | Not separately measured | 7.623 s failed cache validation, then 4.635 s finder and 5.668 s FFmpeg readiness |

Both 7,006-second seeks used `fresh-witness` with **786,432 bytes across two reads**, compared with the previous 2,359,296-byte witness path. This proves less verification I/O, **not reliably fast startup**. On the first seek the 512-KiB witness response itself took **11.586 s**; a subsequent 2-MiB continuation took 16.134 s, then another 2-MiB continuation only 3.001 s. A larger or smaller fixed request alone does not guarantee the target delay.

The first seek reached 171.406 s of new-resource media time at elapsed 196.602 s; the repeat reached 170.450 s at elapsed 181.167 s. The reopening reached 124.470 s at elapsed 145.381 s. Observed one-second windows had no blocked sample and passed the initial twelve-second browser buffer. Three finalized output segments decoded as AAC-LC, 48 kHz stereo, without error; their first A/V start difference was approximately 27 ms. These are decoder checks, not human listening acceptance.

The 22.172-second reopening had a real prepared-window candidate, but verification was unavailable: response 502, zero completed fresh samples. The cache was correctly not leased; ordinary input took over. The internal reason for the failed delivery response is not established. It must not be called a cache miss due to expiry or attributed specifically to the supplier or proxy.

## Closure and remaining limits

PR773's lifecycle correction is public. PR772 remains a draft; its smaller-witness Gateway candidate is active only on the existing owner cache pilot. Vermines shows repeated usable input caching; Minnal still fails the requested rapid/repeatable latency target. No general rollout is justified by these results.

All test playback was stopped via Home and the agent-created tab closed. Both Gateways are healthy with zero active sessions/raw pumps, both Edge replicas healthy, public live sessions zero, admissions unpaused, dispatcher STOP absent and selection worker running. A legitimate background validation lease remains active and was not cleared.

## Evidence

Sanitized delivery/CI controls are under `.codex-artifacts/seek-handoff-20261011/`. Gateway timing, cache-hit, decode and final health receipts remain under the startup-cache worktree's `.codex-artifacts/startup-cache-20261010/`: `fresh13-stage.safe.json`, `fresh13-deployment.safe.json`, `handoff-production-replay.safe.json` (preserved pre-update measurement and replay boundaries), `handoff-native-history.remote.py.safe.json`, `fresh-window-times.remote.py.safe.json`, `fresh-audio.remote.py.safe.json`, `fresh-time.remote.py.safe.json` and `final-status.remote.py.safe.json`. Diagnostic filenames reused during replay contain their latest snapshot; earlier action measurements are preserved explicitly in the tables above. These directories also contain private operational helpers; credentials, provider addresses and account identifiers must not be published.
