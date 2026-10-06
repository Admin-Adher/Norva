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
## Publication and real browser verification

PR676 merged as 1098ca30052f4a27258b93865a3d7262e3062405. Full Linux suite: 6,001 tests, 5,971 passed, 30 skipped, zero failures. Cloudflare run37519139134 succeeded. At 19:32:42 UTC its post-publication gate verified all 59 served assets. A second full byte check from the operator host also verified all 59 against the independently prepared Git-LF manifest.

The active account was reloaded three times. All three produced a visible carousel and 18 catalogue cards, with no terminal Home error panel. The third replay observed the hero 2,783 ms after reload invocation in a single tool call. This is a browser observation including tool overhead, not a guaranteed cold-cache benchmark. The first replay's initial selector wait ended too early; the following DOM inspection confirmed the carousel. The second timing included an inter-tool gap and is not used as a performance figure. Account/catalogue storage was not deleted.

The loaded script is now `/js/pages/HomePage.f9041e3f63f66d27.js`, full expected SHA256 `f9041e3f63f66d273d65e3baa31ca9c99b04fafb51fd13028b5a3f528fc7cdfd`, rather than the poisoned query URL. Repeated final DOM inspection after the request budget expired showed 18 cards, carousel rotation, loading=false and no terminal error.

Personalized Home still timed out at 19:33:56, 19:34:41 and 19:35:00 UTC. The verified implementation preserves the independently loaded cards/hero through those failures. This corrects the wrong-code delivery and blank/error Home path; it does not claim that slow personalized backend reads themselves have been repaired.

Isolated screenshot: `.codex-artifacts/home-runtime-recovery-20261006/fingerprinted-cold-home.png`. Production screenshot capture failed in the browser tool; DOM and delivered-byte checks are preserved instead. The temporary fixture tab/server were closed. The user's browser remains on Home. The earlier report is amended to explicitly retract its URL-only production-code validation.