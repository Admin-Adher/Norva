# Catalogue Edge runtime reconciliation — 24 September 2026

## Baseline and risk

The live `norva-catalog/index.ts` on the shared Edge mount had SHA-256
`bab75fd856b1a3fe1c8ae91ee71a8ba55e5abbc69ae82dcd9917a71be3ee16fb`.
The previous Git version had different catalogue language and Discovery features,
but omitted the production bounded flat-media hydration and the indexed
supplier-language facet path. Replacing production with that Git version would
have restored a broad `cloud_catalog_visible_titles` scan for a small grid page.
The live implementation also lacked Git's exact episode-language write and
Selection file-identity safeguards. Neither side was a faithful replacement.

## Reconciled behavior

- Flat media rows resolve their exact owned variants and active generation in
  bounded pages. Their hydrated titles are reused for language, art, and
  progressive title binding without a second TMDB-filtered visible-title scan.
- Progressive-generation rows are enriched once by the generation binder. A
  full editorial card cannot add runtime or rating while the full overlay flag
  is disabled. Foreign, ambiguous, or stale ownership remains fail-closed.
- Language menus use the production indexed audio/unidentified helpers and
  subtitle union, with concurrent reads and source/visibility-epoch cache keys.
  Supplier subtitle declarations retain `catalog-` facets and source-scoped
  filtering. The newer exact episode membership and file-identity handling is
  preserved.
- Health exposes catalogue version 8 and both the existing production
  bounded-hydration/language-facet markers and the newer exact-track marker.
  The full Edge deployment verifier now requires all four markers.

The eight direct shared-module imports introduced by the Git catalogue match
the current production modules after normalizing CRLF to LF. No dependency
content changes are required for a scoped catalogue rollout.

## Production deployment and verification

PR #388 merged as `d8f504b64192159eb1fd2b9fecfb3f67d444c5ea`. Its Build
Norva run `35958143972` completed successfully: 5,092 cloud regression tests
passed, 20 were skipped, and none failed; Android Phone, Android TV, and Windows
build jobs also passed. A local catalogue suite passed 272 tests, skipped one,
and failed none. TypeScript syntax parsed with esbuild and `git diff --check`
passed.

Beginning at 05:08:06 UTC, the guarded one-module rollout replaced
`norva-catalog/index.ts` on the shared Edge mount. Each replica was restarted
in sequence and returned healthy catalogue version 8 and healthy `norva-cloud`.
Public `https://api.norva.tv/functions/v1/norva-catalog/health` returned HTTP
200 with `flatCodecProfileProtocol=1`, `catalogLanguageFacetProtocol=2`,
`boundedMediaHydrationProtocol=1`, and `exactTrackPersistenceProtocol=2`.
Rollback backup:
`/home/adrien/.norva/catalog-reconcile-20260924/backup-20260924T050806Z`.
The production file SHA-256 is
`d3f4b8afae725cc46212fd2b31eacf42a1eded968d8d07ed71c02d4a0eb3ed06`
(Windows CRLF checkout). Its LF-normalized bytes exactly match the merged Git
blob SHA-256 `66c2b67817a233c2281b89e17f9475d5b71058d159bdf9d585d3af5c85988873`.

After a fresh page load, the ordinary, non-internal QA account showed Norva
Selection movie rails. Selecting its Action category returned 956 titles;
switching back to All Sources reset the category. The English audio facet
showed 183 titles and its filtered grid returned 183, including cards visibly
labeled English. Source, audio, and category filters were restored to their
defaults after the check. This proves the live web catalogue/filter path for
that account; it does not prove playback. That account still lacks a trial
entitlement because the earlier USD 0.50 authorization was cancelled manually
by the customer. A fresh customer-controlled card check and successful
entitlement are required before ordinary-account playback and automatic hold
release can be validated.
