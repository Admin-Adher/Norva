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

## Verification and limits

The focused catalogue/privacy/language suite passed 102 tests before the last
fixture refinement; rerun results and CI will be recorded with the merge.
TypeScript syntax parsed with esbuild and `git diff --check` passed. No live
catalogue module has been replaced by this change yet. A guarded deployment,
per-replica health checks, and ordinary-account filter/reading checks remain
required before claiming production parity or improved user experience.
