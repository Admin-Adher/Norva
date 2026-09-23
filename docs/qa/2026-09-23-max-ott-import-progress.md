# MAX OTT — import and first catalogue checks

## Scope and status

The user added their first new Xtream service through the Codex browser. The
recorded purchase period is 2026-09-20 through 2027-09-20 (12 months). Import is
still in progress; this report does not certify a complete catalogue or playback.
Credentials are not included in this report.

## Why 213 differs from 37,272

The screenshot's 37,272 is the number of movie entries found so far during
discovery (22% progress). The language facet's 213 is the number of distinct
Spanish titles already published to the browsable catalogue.

Read-only production observations on 2026-09-23, UTC:

| Time | Progress | Raw movie entries | Visible movie titles | Visible variants |
| --- | --- | --- | --- | --- |
| 13:31:40 | 27%, discovering | 53,849 | 213 | 215 |
| 13:38:52 | 37%, discovering | 151,728 | 213 | 215 |
| 13:41:38 | 45%, discovering | 158,384 | 213 | 215 |
| 13:44:13 | 48%, waiting_for_provider | 158,384 | 213 | 215 |

The final observation also had 63,128 raw series entries and 10,839 live entries.
`sync_status` remained `syncing`, `browseReady` was true, and `sync_error` was null.
Progress and raw-row counts can differ slightly while concurrent batches write.

Inspection of the deployed `xtream-sync.ts` confirms `projectFirstCinemaBatch`
publishes only the first batch once for each cinema type. The durable finalizer
publishes the rest after discovery. The discrepancy is therefore explained by
two different stages and by entry/variant versus distinct-title counting. It is
not evidence that the remaining entries were discarded. Completion must still
be checked. Movies currently gives no clear indication that its facets describe
a partial preview; that is a remaining UX issue.

## Browser checks

- MAX OTT source selected; audio facet showed Spanish 213, unknown 0.
- Selecting Spanish produced a grid explicitly labelled 213 titles.
- Opening the Tokyo Drift entry and choosing Play reached the player, but failed
  before the first frame. A retry also failed; video time stayed 0 and readyState
  stayed 0. The player was closed afterwards.
- Gateway logs in the same interval included a provider HTTP 403 while preparing
  finite MKV input. This is a diagnostic lead, not a fully correlated root cause.
- Console also reported a probe response containing HTML instead of JSON and a
  telemetry reconciliation warning. Full playback diagnosis remains open.

## Import modal correction deployed

The provider wizard left `provider-access-wizard-modal` on the shared modal and
left its footer hidden when transitioning to import progress. The correction
clears that layout, restores the footer, and adds a scoped progress layout:

- Wider desktop modal with 24px body padding.
- 16px mobile padding and a counter grid adapting to viewport and enlarged text.
- Milestone text wraps and the background action remains outside the scroller.
- The progress class is removed on close; focus restoration is retained.
- Updated asset references for the two changed frontend files.

Verification: 46 source-health and account/profile accessibility contract tests
passed, including a behavioral wizard-to-progress transition test. A browser
fixture using the actual SourceManager, NorvaModal and CSS was inspected at
1280px and 390px; enlarged 130% root text had no horizontal overflow or clipped
counters, and closing restored focus to the trigger. This fixture is not an
Android font-scale test and does not certify provider data or translations.

The fix was integrated on current production main rather than deploying the
older checkout. The full regression suite, generated locale checks, region
model, JavaScript syntax and Pages Functions compilation passed in the
[production deployment](https://github.com/Admin-Adher/Norva/actions/runs/35871527892).
The deployed SourceManager and main.css hashes are `f397fee0df` and `42c9814c8c`.

The [Android replay](https://github.com/Admin-Adher/Norva/actions/runs/35870728161)
passed on API 35 with three-button and gesture navigation, system font scale
1.3, WebView text zoom 100/130%, and 390x844, 360x640 and 844x390 viewports. It
checks counter wrapping, horizontal overflow, footer visibility, button targets,
background inertness and focus restoration. This is a focused modal test, not
certification of Android playback or the whole application.

## Progressive cinema publication deployed

The old one-time preview guard is removed: each discovered movie/series category
now contributes a bounded early page. Once cinema discovery is complete, a
durable database-only publisher walks all current-version cinema rows before
starting the Live TV discovery. It does not open an extra provider connection.
Publication checkpoints only after successful projection, is bound to the exact
source generation and import run, and resumes within the Edge time budget.

Existing title projection and exact-file cache guards are retained. The normal
finalizer still enriches the visible catalogue after provider identity is
resolved and performs Live materialization, pruning and the READY transition.
No second bulk import was launched against this one-connection account.

Verification: **60 focused tests passed**, including paging, failed writes,
continuation, superseding and cache/generation contracts. Both production Edge
containers were checked after sequential restart; source-sync and cloud health
passed. The patch was applied to the exact live baseline, preserving its prior
catalogue epoch fixes. Receipts: `ops/hetzner/media/max-ott-import-20260923/`.

This MAX OTT import had already entered the existing finalizer when the patch
landed. Its increasing counts must not be attributed to the new publisher, and
a fresh large-provider onboarding latency measurement is still outstanding.

| Time UTC | Raw movies | Visible movie titles | Visible movie variants | Stage |
| --- | --- | --- | --- | --- |
| 14:17:30 | 158,384 | 28,551 | 28,645 | building_titles, 77% |
| 14:23:06 | 158,384 | 35,872 | 36,021 | building_titles, 78% |

## Playback diagnosis and replay

- The original Spanish Tokyo Drift entry consistently returned HTTP 403 from
  the provider media endpoint, with no video bytes. The account API reports an
  active, authenticated account with zero active connections before the probe;
  its VOD metadata declares MKV. Range/no-Range, normal player user agents and
  the existing CONNECT/forward paths did not change that result. No credentials,
  proxy settings or provider restrictions were changed.
- A different MAX OTT title, **FR| Iron Man 2**, returned HTTP 206 and Matroska
  bytes through the same account route. Its first browser attempt failed before
  a frame; the retry played successfully (`readyState=4`, videoWidth=640,
  advancing media time above 31 seconds). The first failure is not fully
  attributed; a one-off successful retry is not proof of universal reliability.
- Seeking to about **6:13**, leaving the player and using **Resume** restored
  that position. After pressing Play, the timeline advanced beyond 6:40 with
  decoded video. Playback was closed afterwards to release the account slot.
- Therefore the whole provider is not unplayable. The original entry remains
  unavailable upstream and cannot be repaired by changing Norva's decoder.

## Remaining QA

1. Observe completed import and compare final visible titles/variants with raw
   entries, accounting for grouping and catalogue exclusions.
2. Verify source/category/language filters and refresh after publication.
3. Replay another cold movie start and series/live playback; resolve the
   provider-side Tokyo Drift refusal with the provider if that title is needed.
4. Measure a fresh import with the progressive publisher; Android playback is
   separate from the completed modal layout replay.
5. Import the second new provider after the user enters its credentials.

The 100-reader campaign remains deferred at the user's request.
