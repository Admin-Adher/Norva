# Recent delivery target — 7 October 2026

## Scope and current status

Follow-up to PR 693, integrated by PR 696 and deployed on the existing pilot. The recent-resume pilot remains owner-scoped. No broad rollout, timeout increase, buffer reduction, production proxy change, parallel provider connection, codec change, or extension of the ten-minute cache lifetime.

## Evidence

The evening Normal and Severance failures are preserved in `2026-10-07-resume-evening-recheck.md`: both failed before a first frame, with zero generated segments after sixty seconds. The earlier recent entries had expired. The internal cause of delivery variability remains unassigned.

At 17:24–17:25 UTC, two sequential bounded reads of the exact 2 MiB Normal range were performed under an ordinary direct claim, pinned HTTP CONNECT slot, independent 0.5-second heartbeat, fail-closed one-second timeout, and normal expiry. System libcurl: 5.050663 seconds. Isolated production Undici: 2.82840439 seconds. Both delivered identical bytes, SHA-256 `dbc0fa8dcb5298e8e2db87171a7cf174eef2555180b504b841401f87e12069dd`. The same range previously took 14.841 seconds. This is evidence of variable transfer time, not proof that the proxy or Norva is the root cause. Both comparisons share the same network path. Two initial GET invocations, not necessarily two HTTP requests including redirects. Temporary media, headers, helper and ordinary claim were cleaned up/expired.

## Candidate correction

The earlier strict rejection of a newly minted delivery path remains correct. Instead of weakening that check, retain the previously authorized resolved URL privately in the existing owner-bound cache, for at most ten minutes and one validation attempt. It is an opaque in-memory handle, never returned by diagnostics or public APIs. Owner, source URL, current source/configuration/profile binding, exact file size, user agent and pinned route must match. The current ordinary playback claim is still required.

Revalidation uses four fresh serialized 64 KiB ranges and the existing eight-second budget, matching the same delivery target and exact file size. Only the existing cache lease can approve the four byte samples. An expired/refused/changed target, changed body, timeout or cancelled session cannot authorize old bytes. Ordinary playback resumes after drainage on a miss.

The freshly read header and validated target are handed to the continuation broker after all four reads drain. This avoids resolving a second temporary URL between validation and the actual input continuation. A fresh header is not proof that old cache data may be reused.

## Verification before deployment

- Focused local suite: 293 tests, 287 passed, six skipped, zero failures. Groups overlap older tests.
- Fifteen selected local tests pass, including actual loopback HTTP with rotating targets, changed bytes, changed size, expiry, redirect rejection, single active request, and normal fallback after an expired hint.
- Initial local failure was a VM fixture missing the newly extracted route helper; fixture corrected, production code unchanged for that repair.
- No provider request from these tests.
- Server canary: fifteen tests passed under UID 1000, isolated network, no production volumes and real GPU. No provider I/O. Removed after proof. All five checks for code `bb25007ed` now pass, including Android Phone/TV and Windows packages. They were still building when the cloud-contract gate allowed integration.

Private operator evidence: `.codex-artifacts/resume-transport-proof-20261007/` and `.codex-artifacts/recent-delivery-target-20261007/`. Consumed transport operator must not be replayed.


## Deployment and real replay, 17:52–18:08 UTC (19:52–20:08 Paris)

PR 696 is integrated by `87a51a59f63f5183142bfc5d0d3c89c12baa6556`. Image `sha256:c8a56fa6dca348a4727c1eee8ccb6145b9c8185b867e54e134b0ffac95ea2c43`. Three existing Gateway sources changed and one module was added; 84 pre-existing files preserved, 88 files verified on both replicas. All 194 Edge files, permissions and container identities remain unchanged. Admission pause **10.641152 seconds**, natural drainage, no forced lease; admission, worker, cron and the existing dispatcher restored. Pilot remains owner-only with the same ten-minute sampled TTL and 256/64 MiB aggregate/entry limits.

| Exact tested copy | Position | First frame | Effective start | Outcome |
|---|---:|---:|---:|---|
| Normal 4K FR HDR, cold | 472 s | 28.163 s | Not reached | After 170.5 s, video still paused at relative zero with 60 s buffered; operator stopped normally. No eligible recent entry, so no claimed warm Normal result. |
| Severance FR S1E1, cold | 927 s | 45.594 s | 101.233 s | Actual play, then normal exit. 64 MiB input entry retained. |
| Same Severance, recent reopening | 992 s | 10.904 s | **11.086 s** | Hint used, exact size/target and all four fresh samples matched in 5.771 s. 64 MiB really seeded. **Subsequent rebuffering occurred.** |

The different positions and variable transfer rates prevent claiming a general speed multiplier. Initial warm preparation was 8.375 s, including 2.524 s FFmpeg readiness. Continued requests reused the same target with no redirect; the broker proceeded beyond the retained input and completed new 6–8 MiB ranges. Eight-MiB responses in the observed continuation varied from 3.572 to 21.833 s. The MKV broker forwards chunks while receiving the range; it already avoids withholding a whole 8 MiB response before decoding. No redundant buffering patch was applied.

**Continuity failed the extended test.** At 18:02:11.883 the browser was paused at 59.933878 s with about four seconds ahead; it later resumed. At 18:06:22.654–18:06:42.202 it remained paused at 145.951 s. This is not a fluid five-minute playback result. A `readyState` of four or no media-element error does not erase those waits. The fast initial production rate (12.012x, fed by retained data) also does not certify the subsequent delivery rate. Do not extend this evidence into a general rollout recommendation or a guarantee of steady streaming.

Local samples from the cold runs: AAC-LC, 48 kHz, stereo; 48 video frames each, maximum interval 42 ms, zero decoder diagnostics. These are short output samples, not a full-film or warm-continuation audio certification. No source copy, audio selection or subtitle selection was silently substituted.

At 18:08:40, all three operator sessions are expired and the browser is back on Movies. Both Gateways are healthy. A separate global session remains active and was preserved; this is not a zero-global-playback claim. The one-shot transport marker remains consumed. No new background test or hourly schedule was created.

The cache-target correction is functional and the faster Severance reopening is measured. Normal cold-start delay and sustained fresh-delivery variability remain unresolved. No diagnosis attributes the latter specifically to provider storage, the common proxy or their route without additional evidence.

## Correlated flow check, 18:20–18:32 UTC (20:20–20:32 Paris)

Three further ordinary browser sessions, serialized on the same exact account and copies, with read-only server/output inspection. No application change or deployment. The previous one-shot raw transport comparison was not replayed. Both code PR 696 and documentary PR 697 now have all five checks successful.

| Exact copy | Requested position | First-frame telemetry | Session creation to actual play | Continuity |
|---|---:|---:|---:|---|
| Normal, cold | 472 s | 83.899 s | Not reached | Still paused at relative zero at 18:26:38 with 53.999 s buffered; stopped normally, before the buffer deadline. |
| Severance S1E1, cold | 1172 s | 29.485 s | 34.298 s | Starved near relative 37.979 s; remained automatically paused while the reserve refilled. |
| Same Severance, recent reopening | 1209 s | 7.692 s | **8.796 s** | Subsequent pauses observed at relative 27.894, 39.938 and 59.927 s. Not a fluid playback result. |

Positions differ, so this is not a controlled same-position speed multiplier. Recent reopening used the retained target, all four fresh validation samples and **67,108,864 input bytes**. Validation took 3.715 s; server preparation 6.039 s including 2.273 s FFmpeg readiness. The initial measured output rate of 11.573x includes cached input and cannot be interpreted as sustained fresh-delivery throughput.

### Where the time goes

Normal's Edge phase record separates **37.613 s of existing catalogue/probe release grace** from 43.887 s spent in the Gateway call (43.845 s FFmpeg readiness). No takeover wait or coordinator wait. This is not a new SQL-timeout diagnosis, and the provider release grace was not shortened.

At 18:26:27, Normal had 23 completed provider windows containing 150,709,220 bytes. Their measured intervals total **275.733 s**, of which 17.781 s precede response headers and 257.952 s follow them, within 282.993 s since Gateway creation. Eight-MiB windows took 5.682–36.648 s. Only 52 s of finalized video was then present on disk; the browser subsequently held 54 s at 18:26:38. The browser was not withholding a much longer already-produced video in these snapshots.

At 18:31:41, warm Severance had received 75,560,692 new bytes in eleven completed windows, taking 120.203 s cumulatively (113.027 s after headers), within 135.947 s since Gateway creation. Eight-MiB responses ranged from 2.049 to 24.971 s. Finalized video/audio covered about 60 s; at 18:31:52 the browser was paused at 59.927 s with about six seconds ahead. It had already resumed after previous refills. Fresh delivery beyond the cached windows was insufficient to sustain uninterrupted playback during this observation.

These intervals are measured inside serialized fetch/body-consumption scopes; they also include local JavaScript execution and are not independent network instrumentation. Code inspection confirms that MKV chunks are forwarded immediately and that local socket drainage waits occur only after an exact provider window is completed. There is no evidence here for a patch that simply forwards those same chunks earlier. Nor do these measurements distinguish provider storage, the common relay, or the route. Previous independent libcurl/Undici tests shared that route. A reliable deeper attribution requires new transport-side evidence, rather than another identical retry or an arbitrary buffer reduction.

### Audio, cleanup and limits

A short already-produced segment from the warm Severance session was checked locally, with no additional provider read: AAC-LC, 48 kHz stereo; 48 decoded video frames, maximum interval 42 ms, zero decoder diagnostics. This is not an audible or full-episode certification. A paused media element with `readyState=4` was counted as an interruption; the helper's zero `noProgressWhilePlaying` counter does not erase automatic pauses.

At 18:32:28 all three operator sessions were expired, the account had zero active readers, and the browser was back on Movies. Both Gateways were healthy on the same PR 696 image. One unrelated global reader remained preserved. No thresholds, cache TTL/size, provider route, codec, lease, account scope or production code changed. Pilot extension remains unvalidated. No new hourly automation was created.

Read-only operators and safe receipts: `.codex-artifacts/resume-flow-diagnosis-20261007/`, notably `normal-rate-analysis.safe.json`, `warm-rate-analysis.safe.json`, `all-phases.safe.json`, `browser-flow.safe.json`, `warm-local-codecs.safe.json` and `final.safe.json`.


## Transport isolation, 18:44–19:01 UTC (20:44–21:01 Paris)

New bounded question: does the poor sustained input rate persist outside the Norva media process, and is it explained by the eight-MiB window or CONNECT tunnel? The tested bytes are **Normal only**, exact range 1,251,999,744–1,268,776,959 of the same 13,662,582,623-byte file. This is not another Severance continuity test.

### Independent receive observation

System libcurl, writing to a private temporary regular file rather than FFmpeg, received the exact **16 MiB in 47.679798 s** (HTTP 206, one redirect, 2.815 Mbit/s). SHA-256 `39d3ab6093b909bcb14510d17a7561a0ccef260ed13063648e8c66ef03301807`. It bypasses the Norva JavaScript media path, cache, demuxer, decoder and browser; the configured proxy route remains common.

Across 92 half-second process snapshots, curl used 0.20 s CPU over the observed 47.481 s and was sleeping in all snapshots, usually in socket polling. Eighty-eight body-socket samples had an empty receive queue, a kernel `rcv_space` value of at least 76,896 bytes, and median TCP RTT 134.116 ms to the proxy. The idle socket left by the initial redirect is excluded from the body-only aggregates. Snapshot sampling cannot exclude short unseen queues; these are not packet captures and do not locate an upstream bottleneck beyond the proxy. They do demonstrate a slow receive outside the Norva media pipeline without a sustained local CPU/receive-queue bottleneck in this test.

The current exact profile reports 5,513.984 s and 13,662,582,623 bytes: a whole-file average of **19.822 Mbit/s**. This includes all muxed tracks and varies by position; it is not an exact requirement for each second. The measured receive rates nevertheless remain far below that average. Transcoding the output to a lower resolution does not itself reduce the original muxed bytes that must first reach the server.

### Window-size control on one authorized target

An isolated helper from the production image used the production Undici/proxy implementation without the broker, FFmpeg, browser or production volumes. A single pinned agent and resolved delivery target were used for four stages over the same bytes, ordered full/split/split/full:

| Stage | Range layout | Total bytes | Elapsed |
|---|---|---:|---:|
| 1 | One 16 MiB response | 16 MiB | 30.105 s |
| 2 | Two consecutive 8 MiB responses | 16 MiB | 27.591 s |
| 3 | Two consecutive 8 MiB responses | 16 MiB | 27.198 s |
| 4 | One 16 MiB response | 16 MiB | 19.458 s |

All four complete hashes equal the libcurl hash. Six serialized media ranges plus one initial redirect; no later redirect or identity relaxation. The helper used 1.865 s CPU in 104.352 s; event-loop delay maximum 22.446 ms with 20 ms monitoring resolution. No multi-second helper event-loop stall was observed. These results do **not** establish a stable advantage for a larger range; time variation remains. The production eight-MiB size was preserved.

### Same configured proxy, HTTP forward control

One final libcurl control used HTTP forward instead of CONNECT, with the same configured proxy endpoint, slot and credentials. The final delivery URL was HTTP. It received the same exact 16 MiB/hash in **44.325739 s** (3.028 Mbit/s), HTTP 206 and one redirect. This is still slow and gives no demonstrated transport-mode fix. The comparison was sequential, not simultaneous, and the exit address was not independently measured. No production routing policy changed.

### Guards and cleanup

The first preflight at 18:44:33 acquired an ordinary direct claim but stopped before any media GET: the global last-route diagnostic referred to another account. Its claim expired normally. The diagnostic was corrected to read the production affinity/slot/forward-policy modules and current shadow policy, rather than treating a global last-observed route as account evidence. A separate consumed marker was used; the original marker was not replayed.

All later reads used ordinary direct claims and independent 0.5 s heartbeats with one-second fail-closed timeout. Production takeover grace was checked; each request drained or would be stopped before expiry. No parallel media request for the account, no forced lease, no route/configuration/codec/cache/buffer change. The eight completed media ranges total **96 MiB** across the curl, window-size and forward controls; three observed initial redirects bring the HTTP count to eleven. There was no whole-file download.

Every temporary media/header/private-output file was deleted; the helper container was removed. All claims expired and the owner-only pilot remains unchanged. The common proxy versus provider delivery boundary is still unresolved; these tests establish that the slow receive also occurs before Norva's media processing. Neither larger cache windows nor an HTTP-mode change has a demonstrated remedy here.

Safe receipts and consumed diagnostic operators: `.codex-artifacts/resume-socket-proof-20261007/`. No browser playback was launched by these transport controls, no new deployment or hourly automation was created.

Final read-only check at **19:04:30 UTC**: four diagnostic claims expired (including the zero-media preflight), zero active readers on the target account, both Gateways healthy on the same image, zero global Gateway sessions at that snapshot. Cleanup at 19:04:31 confirms zero diagnostic containers and zero private temporary media/header/output files. The previously observed unrelated reader was not stopped by these operators.


## Independent network comparison, 19:17–19:34 UTC (21:17–21:34 Paris)

A distinct Windows Wi-Fi path was available. Four new GET invocations were serialized under ordinary claims, using system libcurl and the same original Normal URL, exact file size and 16 MiB range as above. No browser playback or production routing change. The purpose was to separate the server/media process from the shared relay path; no alternative copy was selected.

| Diagnostic path | HTTP | Bytes | Elapsed | Average received rate |
|---|---:|---:|---:|---:|
| Local Wi-Fi, proxy explicitly bypassed | 206 | 16 MiB | **5.056408 s** | **26.544 Mbit/s** |
| Server, proxy explicitly bypassed | 404 | 0 | 0.386404 s | No media |
| Local Wi-Fi, same configured HTTP CONNECT relay | 206 | 16 MiB | **24.048997 s** | **5.581 Mbit/s** |
| Local Wi-Fi, direct control after the relay test | 460 | 0 | 0.213352 s | No media |

Both complete bodies have the same SHA-256 `39d3ab6093b909bcb14510d17a7561a0ccef260ed13063648e8c66ef03301807` and exact Content-Range as the earlier server/relay reads. Each successful response followed one redirect. Curl on Windows explicitly reports `proxy_used=0` for direct reads and `1` for the relay read. The server's curl version does not expose that field; its configuration explicitly disabled the proxy. Source/proxy capabilities remained private, passed through SSH and process stdin, never printed in receipts or command arguments. Temporary bodies, headers and private outputs were deleted.

### What this changes, and what remains unknown

The same content can arrive faster than the whole-file average on a distinct network path. The slow receive also recurs when the local PC uses the configured relay, so the Norva server and media pipeline are not necessary to reproduce it. The preceding server/relay controls took 19.458–47.680 s over these bytes, illustrating variability. The new sequential controls do not prove the relay appliance alone is responsible: relay-to-provider routing, provider treatment of the exit, and time variation remain possible. No exit address or provider delivery logs were available.

The failed direct controls are retained. A server-side direct route returned an empty 404; the later Wi-Fi direct control returned an empty 460. Their internal reason is unknown; neither establishes a missing file, geoblock, concurrency violation or an IP restriction. No automatic retry followed the 460. A single fast 16 MiB direct read is not a full-film throughput guarantee and does not establish a reliable direct fallback. No extra AAC or video decoding claim is made by these byte-only reads.

### Existing routing options and operational outcome

Read-only inspection of both current Gateway configurations found **one HTTP relay entry each**, no SOCKS entries and no explicit account slot override. The existing adaptive policy remains enabled in **shadow mode**. No account or host recommendation/measurement exists for this exact source in the bounded route lookup. Thus there is no measured, configured alternative to activate. The lookup acquired and normally expired one separate direct claim, with zero provider I/O. No route recommendation was fabricated, no pool was scanned and no canary was enabled.

Adrien confirmed that no other relay/proxy is available. The remaining dependency is an available delivery route with adequate sustained throughput, or diagnosis/repair of the current relay-to-provider path. The current evidence does not justify a production code patch, weakening reserve thresholds, extending cache lifetime or a general rollout. The existing cache correction remains deployed on the owner-scoped pilot; Normal and Severance's sustained continuity remains unresolved.

### Guards and closeout

Local reads used a remote ordinary direct claim with an independent 0.5 s heartbeat and one-second timeout. A local watcher stopped curl if the heartbeat was older than 1.75 s or the remote bridge closed/refused it. Curl joined a Windows kill-on-job-close object before receiving its configuration. The existing native takeover grace was checked at at least six seconds. In the observed runs, the controller closed the local reader and sent its closure message before claim expiry. The bridge also treats stdin EOF as closed; that disconnection branch was not exercised and is not certified by these successful transfers. The local job object bounds curl lifetime if the controller exits. Three local watchdog/job-lifetime checks passed without provider I/O. One preliminary fixture incorrectly assumed a killed Windows process must return a nonzero code; its assertion was corrected to check bounded termination instead, before any local provider read.

Four GET invocations plus two observed redirects equal six HTTP requests and **32 MiB** of media received. The two empty responses are not successful captures. Five ordinary claims, including the zero-media routing lookup, expired normally; no forced lease, extra concurrency, codec/buffer/TTL/route change, or deployment.

At **19:33:02 UTC**, the target account had zero active readers and both Gateways were healthy with zero global sessions at that snapshot. Image and starts remain PR 696's `c8a56fa6…` at 17:52:43/45. Cleanup at **19:34:09 UTC** confirms zero temporary media/header/output files on both the local machine and server. Browser state was not changed. No new hourly automation.

Safe receipts and consumed operators: `.codex-artifacts/resume-independent-network-20261007/`. The one-shot Wi-Fi, server-direct, route-read, local-proxy and direct-control markers must not be replayed.
