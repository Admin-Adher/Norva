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

## Import modal correction prepared locally

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

The additional provider-access UX suite has two existing failures from hardcoded
asset version expectations (including `provider-access-config.js?v=1` and an old
CSS hash). No full-suite pass is claimed.

No Android SDK/adb was available locally. Repository AGENTS.md requires an Android
emulator replay for WebView UI changes; that gate remains pending. The modal
correction has **not been deployed**.

## Remaining QA

1. Observe completed import and compare final visible titles/variants with raw
   entries, accounting for grouping and catalogue exclusions.
2. Verify source/category/language filters and refresh after publication.
3. Diagnose the failed movie and replay successful movie/series/live playback.
4. Android replay and deploy the scoped modal correction after validation.
5. Import the second new provider after the user enters its credentials.

The 100-reader campaign remains deferred at the user's request.
