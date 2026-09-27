# Physical Android genre paging — 27 September 2026

Phone: Xiaomi 2412DPC0AG, Android, production Norva 1.3.26 (39), installer com.android.vending. USB authorized. Initial font scale 1.0 and three-button navigation. App launched through its normal Activity; no APK installed and no credentials changed.

Films -> Action -> Voir tout produced a persistently blank grid with the header present. Production authenticated genre-items returned 500 after 8.044 seconds for movies/action and 8.031 seconds for series/comedie. Database authenticator statement_timeout is 8s. The existing page resolves every language-title ID and display owner before filtering the selected genre (235,369 candidate IDs, 570,820 visible variants, 2,591,303 shared-buffer hits for this account). Frontend catch silently disabled pagination.

Candidate SQL is tested through a transaction-local pg_temp function, then rolled back; no production function has been changed for these measurements. It materializes owned visible variants once, prefilters a superset of base/projection genre identities, then retains the exact existing effective-generation filters, ordering and language semantics. Measured function execution 2,116 ms; literal-query plan 2,031 ms vs 4,024 ms for old literal query. These are DB timings, not phone paint or end-to-end API latency.

Six old/new comparisons matched exact ordered title IDs and exact counts: all-source movies/action 15,601; series/comedie offset36 5,485; source-scoped hidden-genre/name-sort 1,343; ordinary owner/action 1,458; source-scoped observed Spanish/action 52; foreign-source/ordinary-owner 0. All evaluated under service_role. Function execution remains service-only with invoker permissions and existing visible-variant gates.

Frontend changes add a loading announcement, translated terminal empty/error state and explicit retry retaining existing cards and pagination offset. Stale failures cannot clear the new bucket's loading state. 24 focused tests passed, including executable failure/retry/stale-request coverage.

Native gfxinfo captured only two frames for the early failing bucket; it is insufficient to certify scroll performance. A separate gfx/view/webview/input trace is retained locally, but renderer frame timing remains to be analyzed. A successful physical replay and deployment proof are still required.

## Production replay and runtime reconciliation

PR446 merged as 2bea337e after all checks passed. Guarded SQL deployment committed successfully. Direct service-role SQL takes 2,182 ms, but API still returned 500 at 8s. pg_stat_activity proved the deployed Edge runtime uses the old direct cloud_catalog_visible_titles count/select, not the page RPC. Runtime SHA256 before patch: 5d88b673e1d8eaa99cbac13afa398a09a08b8230bf2e5432c5b17e2b8f9cf2fc.

The targeted runtime patch in ops/hetzner/patches/20260927-genre-page-runtime.patch copies the main-branch page RPC helper and bounded hydration branch for genre requests without strict language filters. Other deployed runtime behavior is preserved. Expected output SHA256: f03bd93f13676d639869da9ee21b40bcc55d01fc6a1a4b0edf58f936b39de13c. This patch is for the recorded production snapshot; main already contains the equivalent path. Verify the base hash, apply once, reload replicas sequentially, then replay the real endpoint. Do not claim the initial SQL deployment alone fixed the physical flow.
