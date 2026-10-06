# Home stale delivered JavaScript — 6 October 2026

## Reproduced incident

The user returned with Home's terminal error panel and no carousel after PR674/675. Clicking the real Retry action recorded `Home fast rails timed out` at 19:17:08 UTC, attributed by the browser to `HomePage.js?v=f9041e3f63`. That label belongs to the new implementation, but the error label exists in the previous implementation.

Independent public HTTP reads confirmed the discrepancy: `/js/pages/HomePage.js?v=f9041e3f63` returned HTTP200 / CF-Cache-Status HIT (Age311) with actual SHA prefix **d3c5be7b97**, without `firstUsableHomeRails` or `fastTasks`. The unversioned resource returned HTTP200 / MISS and actual SHA prefix **f9041e3f63**, containing both. Thus the prior deployment upload and DOM script URL were insufficient evidence that the corrected bytes reached the browser. The prior live validation is superseded on that point. No particular zone cache rule is claimed as the internal cause.

Cloudflare documents that additional custom-domain caching can serve stale Pages assets and recommends content hashes in immutable filenames: https://developers.cloudflare.com/pages/configuration/serving-pages/ .

## Correction

The production build now copies every local initial JS/CSS asset in app.html to a real filename containing its SHA-256 prefix, preserves the source directory (and relative CSS asset paths), adds a full SHA-256 integrity attribute, and records the exact bytes in a build manifest. Application modules and styles are unchanged. The source HTML remains suitable for native/local packaging; this transformation runs in the Cloudflare publication pipeline only.

A post-publication gate reads the actual custom-domain app shell and all 59 referenced assets, checking the full SHA-256 of each. It rejects an old shell, missing integrity, or old bytes behind a new label. Four static fetches maximum run concurrently. Propagation retries are bounded at six with ten-second spacing; failure is surfaced as a failed deployment check. Web publication jobs are serialized to avoid overlapping shell publication.

## Verification

Three delivery tests pass, including exact-byte/idempotence/CSS-path checks, changed-content URL separation, preserved previous copies in the build, wrong-byte and stale-shell rejection, and collision refusal. Together with the Home scheduling and catalogue performance contracts: 32 tests passed. Locale inventory check passes.

An isolated build from Git's LF blobs generated 59 assets. The HTTP verifier checked all 59 successfully against a local fixture server. Chromium loaded the real Home renderer using the fingerprinted script and SRI; the empty-cache scheduling fixture displayed its real carousel while series remained unresolved (71 ms with a synthetic immediate API, not a production timing claim). Application Home bytes remain those already tested in four visible Android WebView configurations and two TV smoke jobs, run37515427600; no new native behavior.

Production rollout and repeated user-account verification pending. No provider media request, Edge/Gateway restart, language guard change, or cache/account-data deletion was used.