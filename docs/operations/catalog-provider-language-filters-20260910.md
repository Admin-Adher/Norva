# Unified catalogue audio filters

Public UI shows language names only; provider provenance remains internal. The
`catalog-*` audio choices combine exact observed languages and bounded supplier
declarations for all visible movie/series providers. Counts deduplicate titles,
not versions. A usable observed language overrides contradictory supplier tags;
an inconclusive observation is not evidence that no audio exists. Nordic stays
one regional grouping and never invents five audio tracks.

Ordered playback tracks, speech verification, preferences and strict ISO queries
are unchanged. Subtitles still require an exact observation on the same variant.
Provider hints never enter observations, verified flags or ordered track maps.

## Deployment order

1. Apply `20260910152938_catalog_provider_language_facets.sql`. It creates an
   indexed private projection and import/update triggers, without changing the
   existing filtered-page RPC. No catalogue payload is rewritten.
2. Run `cloud_catalog_backfill_provider_language_hints(null, 2000)` as the trusted
   service role. Use the returned `after` as the next cursor until `scanned=0`.
   Commit each bounded call; keep a durable cursor and retry transient lock errors.
   Share locks prevent races with import updates and deletes. Do not enable the
   new reads before reaching EOF. Analyze the new projection after backfill.
3. Apply `20260910154554_activate_catalog_provider_language_filters.sql`.
4. Roll both Edge replicas forward with `norva-catalog/index.ts`,
   `_shared/selection-provider-languages.mjs` and the new
   `_shared/provider-catalog-language.mjs`. Preserve unrelated live files,
   environment, container images and mounts.
5. Publish scoped public assets. Existing 60-second facet caches expire normally.
   Saved ISO audio options upgrade to the unified option and refresh membership.

Rollback of reads: restore the prior definition of
`cloud_catalog_visible_title_ids_by_source_languages` and the prior Edge overlay.
The additive private projection can remain; removing it is not needed to recover.
Keep a hash-fenced copy of the old SQL definition and Edge overlay before cutover.

## Checks

- `node scripts/build-provider-language-parser.cjs --check` verifies the generated
  Edge parser and SQL alias dictionary against the browser grammar.
- `tests/catalog-provider-language-filters.test.js` covers parser parity,
  observation priority and SQL ownership/count/filter contracts.
- Run real PostgreSQL fixtures: duplicate titles across sources, hidden variants,
  other accounts, conflicting and inconclusive observations, audio/subtitle on
  different siblings, trigger updates and deletion cascades.
- In production, reconcile every nonzero audio facet against the filtered title
  count for each visible user/type/source scope and for all sources. Record query
  timing separately from endpoint/rendering time.
- Validate the actual web UI and Android WebView at text scales 100/130%, including
  both source/category reset orders with IME in gesture and three-button modes.

All projection tables and RPCs are unavailable to anon/authenticated clients.
The Edge derives the user ID from its existing verified session; all joins retain
user/source/variant identity and the visible-generation view. No public endpoint
accepts arbitrary account IDs for these service-only reads.
