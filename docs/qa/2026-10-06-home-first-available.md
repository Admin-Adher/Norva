# Cold Home first-available rendering — 6 October 2026

## Observed

The user's active browser recorded `Home rails timed out` at 18:44:35 UTC (10-second client budget). Uncached authenticated reads for the same account/profile reproduced unavailable genre materialisations and slow personalized/series reads. A bounded three-request replay at 18:47 UTC returned the direct movie page in 1,417 ms, while the series page ended after 15,394 ms with HTTP 409; personalized Home returned HTTP 409 after 7,315 ms. These server calls bypass client catalogue caches; they are not a full browser navigation benchmark. No provider media was requested.

## Defect and repair

The fast path waited for both media types; its direct fallback also waited for both. One useful movie page therefore remained unavailable to the renderer while an unrelated series request stalled, eventually exceeding the shared 10-second deadline.

Each media type now has its own bounded genre/fallback path. The first non-empty result renders the real hero and cards after the existing health/settings/setup checks. A later successful type completes the provisional rails. Personalized rails retain precedence; empty/failed reads preserve useful cards. Account/profile cancellation and source gates remain enforced. No timeout, concurrency ceiling or visibility fence is relaxed; no server change is required.

## Tests

38 targeted tests pass, including movie-first, series-first, stalled genre reads, source gate and cancellation. The actual Home layout/card/hero code in an isolated Chromium page with zero catalogue cache reproduces the old wait; the corrected version paints while the series promise is still unresolved (24 ms in a synthetic immediate-response fixture, NOT a production network promise). The first fixture assertion used the wrong loading CSS class; corrected to the actual `is-hidden` contract.

A visible Android WebView test runs the same cold-cache fixture at text zoom 100/130. Emulator and production deployment results pending.
