# Catalogue completeness and cross-account public reuse

## September 10 incident

The global durable search checkpoint retained a single `Jogos Vorazes` title
from September 7. TMDB search included deleted entity 1701563; fetching its
details returned HTTP 404. The alias loop threw before inspecting valid
alternatives (including 70160), so the same item was retried indefinitely and
later accounts were never reached. A successful cron HTTP response was not
proof of enrichment progress.

The audit includes all 113 source records, classified by visibility, and all
22 active catalogues (17 containing movies/series and five live-only). Retired
or disabled sources must remain excluded from enrichment. File counts, exact
file evidence, public title metadata and business/account state are distinct.

## Fixes

- Ignore a 404 only for the deleted search candidate, continue the bounded
  alternative list, and retain transient/auth/rate-limit failures for retry.
- Stop distributing requests on dependency failure or deadline. Report
  `searchFailureHalted`, `failureCode`, `publicCacheReused` and
  `exactFileCacheReused`; keep the existing durable lease/ack/visibility CAS.
- Reuse validated public TMDB names and translations, across both Xtream and
  M3U accounts, via `norva_public_catalog_title_candidates`. Exact file reuse
  remains preferred where it exists. Public lookup requires one unique
  candidate, corroborating year or exact TMDB artwork, matching payload ID,
  then per-title runtime validation. Wrong years, ambiguity and editorial
  rejections stay rejected. No inferred soundtrack evidence is created.
- Protect validated shared metadata from a failed filename validation and keep
  existing translations when another validated write lacks those languages.
- Restrict artwork proof to image.tmdb.org or exact bare TMDB paths; paths are
  case-sensitive.

## Deployment order

1. Rehearse `20260910102245_catalog_public_title_reuse.sql` transactionally and
   roll back. Check with the real service role, not only database-owner rights.
2. Apply that migration. Preserve the prior `catalog_titles_keep_best` function
   definition for rollback. This adds no table grants or new elevated reader.
3. Apply `20260910102428_catalog_public_title_alias_index_online.sql` **outside
   a transaction**. Require the index to be valid and ready; never enable the
   new reader on an unindexed large production cache.
4. Reload PostgREST schema, test RPC ACL, and inspect an actual indexed plan.
5. Overlay only the three changed Edge files on the current live mount. Keep
   images, env, workers, unrelated code, Compose layers and dirty checkout
   untouched. Roll one replica at a time and verify policy marker
   `catalog-public-reuse-v6` plus existing health contracts.
6. Verify all-catalogue coverage and worker progress, plus the original eight
   files. A bounded cache-only repair may call the existing background writer
   with a freshly read owner payload/generation/visibility proof. Skip stale
   CAS outcomes; never force the write or reset the global checkpoint.

Do not re-enable retired legacy reconciliation writers, reset imports, or
increase provider probing to make coverage numbers look complete. Existing
provider circuits, live-session reservations and audio verification remain
authoritative. Missing public matches or actual audio evidence stay unknown.

## Tests

`catalog-public-title-reuse-sql.test.js` executes the migration and index
expression in isolated PostgreSQL/WASM (concurrent build rehearsed separately
on PG17). `catalog-public-title-runtime.test.js` replays the actual matcher with
deleted results, transient errors, bounded batches and rejected metadata.
`early-vod-cache-reuse.test.js` preserves early import and exact-file fences.
The optional PGlite tests must be explicitly enabled for the release check;
their skip in ordinary CI is not SQL execution evidence.
