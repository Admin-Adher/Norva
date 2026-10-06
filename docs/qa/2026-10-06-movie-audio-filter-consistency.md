# Movie audio filter consistency — 6 October 2026

## Reproduced defect

The active account displayed Mindiyum Paranjum (Lion) with a Malayalam badge inside the unidentified-audio filter. A fresh authenticated catalogue response confirmed the contradiction for one exact visible variant. Its two cached audio tracks were tagged ml; status was probed/observed, not strict voice verification. The owned variant profile and owned observation were empty. The SQL filter projection did not read the exact provider-file cache that the card projection already used.

## Correction

Migration `20261006190000_movie_exact_cache_language_filters.sql` adds the exact Xtream file track cache to the existing movie audio projection. Current visible owner/source/generation, verified provider identity, media type and exact file ID are required. Canonical track languages are used; filenames, posters and TMDB do not identify audio. Owned observations and current owned declarations retain precedence. Exact cached evidence precedes weaker provider title hints.

Filters, counts and cards now have the missing shared evidence path. No evidence or job rows are written, no strict validation is invented, and no provider media request is needed. Non-Xtream and series projections are unchanged.

## Verification before deployment

- Schema-only isolated PostgreSQL 17 clone, network none, synthetic data only: defect reproduced before migration; 31 new SQL assertions pass after migration.
- Existing movie declaration rollout: 13 assertions pass.
- 42 JavaScript tests pass across language filters, facets, presentation, aliases and exact track handling.
- Production repeatable-read temporary candidate, rolled back: all-source query 1,839 ms; Lion-only 1,300 ms, both within the existing 8-second limit. Earlier samples 2,054/1,414 ms.
- Candidate has Malayalam for the exact reported variant. No variant loses all languages. Ten variants have weaker hint rows replaced by exact cache languages; these are projection corrections, not new speech recognitions.
- Isolated fixture adjustments: restored production-equivalent reader ACL after a no-privileges schema export; malformed tracks are rejected by the actual storage constraint; verified identity absence is tested by removing the synthetic association because verified_at is non-nullable.

Migration SHA-256: `a5808b6105dc7bd38a694f65b5aa8efdef29985496398e7a5cd61d0f5fe8de31`.
Expected function MD5: `284f244bb312f11b22df373364be5002`.

## Deployment

Applied at 18:40:08 UTC (20:40 Paris), independently rechecked at 18:40:18 UTC. The target function matches the tested fingerprint. All 1,305 other public functions/procedures and their ACLs, target attributes, evidence tables and jobs match within the same repeatable-read snapshot. No rows written, no provider media calls, no service restart or admission pause.

The first operator attempt rolled back before replacing the function: its JSON aggregation of the full evidence snapshot exceeded PostgreSQL's 256 MiB value limit. A read-only preflight proved the original function remained active. The operator was changed to aggregate compact per-row hashes; a separate admission marker was used and both attempts are retained. The product migration itself was unchanged.

Both authenticated Edge APIs returned HTTP 200: Mindiyum + unidentified count 0; Mindiyum + Malayalam count 1 with the exact variant; unfiltered count 1, still probed/observed rather than strict verified. Vivid still returns two unknown results. Request durations 1.66–3.84 seconds.

Real browser after reload: Mindiyum absent from unidentified; a focused unknown-language search returns no film; Malayalam search shows its correct card. The unidentified list shows 6,270 titles, Malayalam facet 1,415. These are current projection counts, not newly completed speech validations. Browser restored to the user's unidentified filter with no search and no playback started.

PR 672 merged as b5c278071bb040529904843b20926f6bf0fedf42, code 01ce7026a178b01b6b924b2d3a188e77eb328845. Cloud contracts, Edge types, disposable DB, mocked journey, notice checks and Android packages passed before final documentation; remaining checks tracked separately. Proof container stopped. No UI assets or media runtime changed.

Safe receipts and screenshots: `.codex-artifacts/catalog-audio-filter-20261006/`. PR attachment was rejected at the existing 100-attachment limit; none were removed.
