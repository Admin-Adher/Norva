# Cold Home first-available rendering — 6 October 2026

## Observed

The user's active browser recorded `Home rails timed out` at 18:44:35 UTC (10-second client budget). Uncached authenticated reads for the same account/profile reproduced unavailable genre materialisations and slow personalized/series reads. A bounded three-request replay at 18:47 UTC returned 24 direct movie items in 1,417 ms, while the series page ended after 15,394 ms with HTTP 409; personalized Home returned HTTP 409 after 7,315 ms. These server calls bypass client catalogue caches; they are not a full browser navigation benchmark. No provider media was requested.

## Defect and repair

The fast path waited for both media types; its direct fallback also waited for both. One useful movie page therefore remained unavailable to the renderer while an unrelated series request stalled, eventually exceeding the shared 10-second deadline.

Each media type now has its own bounded genre/fallback path. The first non-empty result renders the real hero and cards after the existing health/settings/setup checks. A later successful type completes the provisional rails. Personalized rails retain precedence; empty/failed reads preserve useful cards. Account/profile cancellation and source gates remain enforced. No timeout, concurrency ceiling or visibility fence is relaxed; no server change is required.

## Tests

48 targeted tests pass (38 loading/recommendation tests and 10 catalogue performance contracts), including movie-first, series-first, stalled genre reads, source gate and cancellation. The actual Home layout/card/hero code in an isolated Chromium page with zero catalogue cache reproduces the old wait; the corrected version paints while the series promise is still unresolved (24 ms in a synthetic immediate-response fixture, NOT a production network promise). The first fixture assertion used the wrong loading CSS class; corrected to the actual `is-hidden` contract.

A visible Android WebView test runs the same cold-cache fixture at text zoom 100/130. All four phone configurations passed in a visible WebView. Production deployment verification is recorded below.

## Delivery audit

Both HTTP 409 bodies were privately inspected: `Catalog visibility changed while the response was being prepared`. The visibility protection is preserved. The audit never cleared the active browser's account/session storage; the empty-cache browser proof uses the real renderer with an isolated synthetic API and zero cache entries.

Initial CI stopped at the generated i18n asset inventory, before the regression suite. The inventory was regenerated and `node scripts/i18n/build.cjs --check` passes. A Windows rewrite also damaged two existing middle-dot assertions in the Android fixture; restored before the targeted emulator run. The production JavaScript was unchanged by these fixture/inventory corrections. Unrelated HTML asset hash rewrites were removed from the final diff.

Targeted Android run: 37515427600, code a08f908a36f0e07efe6234c96c3e0442138acb4d. Four phone navigation/font configurations exercise `coldHomeDoesNotWaitForSlowSeries` in a visible WebView; two TV jobs retain consent/D-pad smoke coverage only. Duplicate automatic matrices were cancelled, not counted as passes. PR head f0f6187eb985ae2c5dd98d1ba0050b7f13530dc0 differs only in the generated asset manifest and the static performance contract. The first full regression run failed its literal movie/series URL assertion after the code began parameterizing the type; updated the contract to check both types and the same bound of 12. The behavioral movie-first/series-first tests are retained.

Browser fixture screenshot: `.codex-artifacts/home-cold-20261006/browser-cold-pass.png`. Production verification below.
Full Linux regression on f0f6187eb: 5,998 tests, 5,968 passed, 30 skipped, zero failed. Cloud contracts job 112449249162 succeeds; generated locales and region verification also pass.

All six jobs of matrix 37515427600 passed without a test rerun: four phone navigation/font combinations, two TV consent smoke checks. This proves cold Home scheduling in phone WebView, not native TV Home performance. PR 674 merged as d113e65ed755126a9095660a6854fb0f9d2713a6. Cloudflare run 37516906916 publishes this merge. No Edge/Gateway deployment, provider media request or Google Play release was initiated for this correction.

## Production result and limit

Cloudflare deployment 37516906916 succeeded on merge d113e65ed755126a9095660a6854fb0f9d2713a6. The active browser was reloaded, then returned from Settings to Home. Its DOM loads `/js/pages/HomePage.js?v=f9041e3f63`; the real hero, 36 catalogue cards and hidden loading state were verified. No media playback was started. The hero was observed by 10.536 s after the click, but that interval includes tool/reporting gaps and is NOT a first-paint benchmark; the active account cache was not cleared.

At 19:13:00.230 UTC personalized Home still reached its 10-second budget. Useful genre cards and carousel remained rendered and rotated. Thus the first-available scheduling defect is corrected, while slow personalized backend reads remain a measured limitation. This does not claim that all cold launches or all catalogue APIs now finish within a fixed duration. No visibility check, source gate, account fence or timeout was bypassed.

Two production screenshot attempts failed in the browser tool; the verified DOM receipt and the isolated-browser screenshot remain available. The user browser is left on Home. Temporary fixture resources are closed after verification.
## Subsequent correction of the live verification

The user's later failure and byte-level checks showed that the new query-version URL still served the previous Home implementation from the CDN. The DOM URL and visible carousel above therefore did NOT establish that PR674 executed in production. That conclusion is superseded by docs/qa/2026-10-06-home-delivered-assets.md. PR676 adds real content filenames, SRI and a post-deployment full-byte check. The isolated scheduling tests remain valid; the live deployment claim required this additional correction.
