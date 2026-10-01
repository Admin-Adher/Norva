# Norva Selection — prepared activation and catalogue visibility

## Scope

Ordinary QA account authorized by the user, with its genuine trial retained.
Only its Selection catalogue was removed and re-added through the normal UI.
No changes to another customer's catalogue, subscription or billing status.

## Delivered architecture

The qualified public raw manifest is reused, together with computed public
title/variant recipes keyed by the exact raw entry hash and revision. Each
activation binds fresh owner/source/generation rows under the existing authority
checks. Preferences, viewing history, owner identifiers and private playback
measurements are excluded from the shared recipes. Misses follow the normal
projection; expired entries cannot authorize reuse.

The first 16 entries (12 movies and four series) are prepared early. Full title
materialization runs in bounded batches, up to 500 only for a sole finalizer with
at least 90% prepared hits in its previous batch. Normal multi-import admission
and database throttling remain in force.

## Visibility regression and correction

The first recipe rollout exposed missing service permissions: the RPC invoked
protected authority tables as the service invoker, causing projection to stop.
This produced raw previews without projected language/category facets or all
navigation sections. Both RPCs now use a fixed empty search path, service-only
EXECUTE, an internal service-role check and all original owner/generation fences.
They do not grant direct access to protected authority tables.

PRs 537 and 538 are merged. Both Edge replicas were hash-verified. Actual
service_role SQL tests, rather than an administrative caller, validate the path.

Browser verification after repair found:

- Movies, Series and Live TV navigation restored.
- Movie language filters: Telugu 2,463, Tamil 1,307, Portuguese 1,300,
  Malayalam 708, Hindi 547, Kannada 289, English 184, Spanish 174,
  Chinese 2, French/Japanese/Polish 1 each. 559 entries remain unidentified;
  no language is invented for these files.
- Populated movie categories, illustrated and described titles, series lists.
- 21 live source entries grouped into 20 logical channels and 11 provider/category groups.
- Seven-day trial indicator still present.

## Continuation defect reproduced and fixed

A 50-file language hydration RPC can advance the owner's cache epoch. Subsequent
chunks incorrectly retained the originally captured fence even after their
authority check refreshed the active snapshot. They failed closed after some
rows were committed, leaving the progress cursor behind. This also affected
cold compilation and was amplified by a stale four-minute advisory heartbeat.

All three hydration helpers now obtain the fence after each authority check.
Changed source/generation/configuration authority still rejects the next write.
Only the current cache epoch is joined by the existing canonical helper.
Finalizer release atomically removes the exact token's advisory heartbeat, under
the same mutex as claim/renew. Late releases cannot clear a successor's heartbeat.
HTTP continuations require a source-bound success receipt; retries are bounded.

## Verification

- 88 focused Node tests passed across nine files, including reproduction of the
  old multi-chunk hydration failure and source-change rejection.
- Real PostgreSQL rollback fixture under service_role passed exact-token release,
  preserved progress/cursor, late-token successor protection and RPC ACL checks.
- Earlier 500-variant cross-owner recipe binding completed in 3.546 seconds in a
  rollback-only fixture; foreign IDs, stale fences, expiry and isolated new row
  ownership passed. No fixture data were committed.
- A broader title-rollup rewrite was benchmarked (99 variants: 491 vs 419 ms) and
  not retained: the modest gain did not warrant extending the change globally.

## Timing runs

1. Original baseline: full import 497.494 seconds (8 min 17 s).
2. First rollout activation at 08:54:29 UTC encountered the permission regression;
   not a valid optimized speed measurement.
3. Warm activation at 09:18:31.053 UTC: illustrated movies and series, synopsis and
   language badges observed within 7.016 seconds. Full import started
   09:18:32.103 and reached READY 09:24:51.136, including the reproduced stale-epoch
   pause. This run does not establish the corrected full-import performance.

4. Final post-correction activation from the visible button at
   **09:29:04.299 UTC**. Enriched starter cards observed by **9.116 seconds**
   (an upper bound from observation, not an instrumented first paint).
   Backend start **09:29:05.417**, READY **09:31:15.427**: **130.010 seconds**,
   or 2 min 10 s, without manual kicks. This is a **73.9% reduction** from the
   497.494-second baseline. TV became visible on completion.
   Final counts: 7,724 movie variants, 276 series variants, 590 episode rows,
   21 raw live channels, 8,611 raw entries total. Foreign owner/source linkage
   mismatches among the bound movie/series variants: zero.

Creed II played while the final run was still importing: at 17.146 seconds after
clicking Play the DOM video was playing, readyState 4, 1150×480, currentTime
11.283 seconds. This is consistent with approximately 5.9 seconds startup;
it is not an instrumented first-frame measurement. Real picture also inspected.

Final UI replay: the Action filter returned 1,460 grouped titles for 1,473 category
variants; series category counts were populated (including Drama 139 and Comedy
37). Movie audio facets showed 12 identified languages plus the unidentified
bucket. The guide listed 20 logical channels, including Red Bull with two variants.
Creed II was stopped at 3:13 and resumed through the normal button: the displayed
timeline reached 3:43 while the resumed HLS media element advanced 30.876 seconds,
confirming the absolute resume offset. Playback and the TV mini-player were closed.

## Final release

PR 539 merged as `70d3bd0762b9cdaa8f86083706fff40a9a2e2c6c`.
Both Edge replicas deployed and verified at **2026-10-01 09:28:30 UTC**.
The SQL lease-release migration is globally active. CI passed cloud contracts,
Deno/Edge type checks, disposable database, mocked web/mobile journeys,
notification policy, GoTrue/customer notice acceptance and both Android compile
and unit-test jobs. No new APK or Gateway image is required for these Edge/SQL changes.

Live LF-normalized SHA-256 receipts:

| File | SHA-256 |
| --- | --- |
| `_shared/vod-title-projection.ts` | `7a3bb6fcd23484b959a3ceae5816b7dd6b088d71a71b1e59ecbd47929156c383` |
| `_shared/selection-audio-results.mjs` | `eedc251c2094bbf858354b0ce3250c57635a249ff3bb0be0c34c6d576bb64072` |
| `_shared/selection-snapshot-tracks.mjs` | `e44215ee03c9b22e8811aba50312fccd9ee50bca04a82cba3d3fca9be32e91c8` |
| `norva-source-sync/index.ts` | `9d32ebc3f14eb5b7553abc0690656036451a8cae4f4801f3b6848f2bb9e11f1c` |

## Limits

Full per-owner materialization is still distinct from the first usable screen.
No claim of instantaneous full import, Android replay, load-test capacity or
global commercial readiness follows from this scoped browser test.
One optional public feed remains unavailable and is not silently counted as imported.
