# Selection editorial metadata — investigation and correction

## Production evidence

Outlook owner's enabled Norva Selection movie titles: 5,941 distinct titles; 1,008 with GitHub credit text in overview; 418 with no poster URL; 1,013 with no TMDB ID. This does not count broken nonempty poster URLs.

The Selection importer generated a three-line source credit and assigned it to `metadata.plot`, including for series parents. Title projection copied this into overview. Source provenance was therefore displayed as if it were a synopsis.

The current TMDB matcher was executed against the real API for three affected titles. All returned no accepted automatic match. For `O Ultimo Duelo`, live search returned multiple distinct movies: IDs 887767, 617653 and 60539 all have the Portuguese title `O Último Duelo`. The catalogue entry has no year or poster. Its missing match is an ambiguity, not missing API credentials. The current source search worker applies a 90-day failed-attempt interval; this entry was last attempted September 23. Other missing artwork still needs diagnosis and repair; do not assume all unmatched titles are ambiguous.

The three sampled titles also remain unmatched across 40 owner variants each. Cross-owner reuse cannot supply an already verified match for them.

## Changes

- New Selection imports preserve source credits under attribution, not plot.
- Public catalogue and cloud serializers exclude the exact historical three-line credit pattern from synopsis fields, including nested metadata and variants. Stored provenance remains intact.
- TMDB synopsis preference skips legacy credit text and retains genuine editorial fallback text.
- Genuine synopses mentioning GitHub or containing URLs remain unchanged.

## Verification and remaining work

36 targeted tests pass, including source imports, nested public payloads, real synopsis retention, TMDB fallback, owner isolation and synopsis overlays. Integration, deployment and live catalogue replay remain pending. This correction does not invent missing TMDB matches or posters. Continue the artwork investigation, repair confidently identified records through the existing ownership/generation gates, and inspect rendered production fiches.

## Other active work

The capture rollout was advanced from revision 4 / 50% to revision 5 / 100% via its service-only CAS setter after the PR438 deployment and full six-window Dino processing. Both Gateways healthy, no local inference failures after deployment; ordinary-account runtime replay remains to be completed. Metadata batching and owned-provider metadata declaration flags are still off; they are distinct from capture activation. Android version 39 startup validation remains pending official installation/review.

## Portuguese title matching follow-up

Two live TMDB matches were rejected because the supplier omitted one interior Portuguese article. The matcher now tolerates exactly one such omission only against a Portuguese TMDB translation with at least five provider title tokens. All other words, their order, sequel numbers and year checks remain required. The automatic confidence threshold is unchanged.

Read-only live API replay with the corrected matcher accepted `Como Treinar seu Dragão 3` as TMDB 166428 and `As Crônicas de Narnia - Viagem do Peregrino da Alvorada` as TMDB 10140, both at confidence 0.923, with a poster and French synopsis available. `O Ultimo Duelo` remains correctly unresolved. No production catalogue rows were changed by this proof.

Six matcher regression tests pass, including wrong sequel, conflicting year, non-Portuguese translation and existing movie/series aliases. Twelve combined matcher/editorial/import tests pass. Deployment and controlled historical reprocessing still pending.

## Production deployment — 2026-09-26 06:36 UTC

PR #439 merged as `38534d79a2552f1eabe70d8ccb7b2c4c04c98d24`, source `d391dfb2406b1ef44fa256ae534b17299396a1f1`. Build run 36223898141 passed cloud contracts and Windows/Android phone/Android TV builds; Partners run 36223898073 passed. All seven changed shared modules were deployed with exact before/after SHA-256 checks and backups. Both Edge replicas restarted sequentially and are healthy. No mobile binary change is required for this backend correction.

The real production browser fiche `Anjos da Noite 4` displayed the GitHub credit text before deployment. After reload, it displays `Aucun résumé disponible pour le moment.` The missing match for that title remains unresolved; removing false credits is not equivalent to recovering a synopsis.

Historical reprocessing was authorized through the existing service-role `norva_requeue_catalog_search_for_source` RPC, respecting the inactive lease/empty-inflight gate and preserving durable owner cursors/snapshots. All 32 enabled, ready Selection catalogues were requeued: 33,445 owner-specific title rows reset and 33,445 snapshot rows ready. These are not 33,445 distinct films. The scheduled search worker resumed with 100 inflight entries. At the follow-up check, the two positively proven Portuguese titles had not yet been persisted and no Selection match had yet been recorded since deployment. Do not report the historical poster repair as completed.

Additional audit: 4,928 verified movies include 13 without a poster; all 13 referenced TMDB entries currently return HTTP 200 but no poster and no French synopsis. 1,013 unmatched movies include 405 without a poster and 1,008 with old GitHub credits. Those 13 existing identities need disambiguation before any reassignment: same-name TMDB entries are not proof of the supplier's intended film. Existing nonempty provider poster URLs have not all been checked for HTTP/rendering failures.

Evidence on host: `/home/adrien/.norva/enrichment-readiness-20260926/selection-editorial-release-d391dfb2/` contains merge/deployment manifests, backups, and per-source requeue results; sibling `selection-tmdb-corrected-live-proof.jsonl` and `selection-matched-no-poster-docker.jsonl` contain bounded live API proofs without credentials.

## Explicitly confirmed film identities

The owner supplied exact TMDB pages for `Anjos da Noite 4` (52520, Underworld: Awakening, 2012) and `South Park Guerras do Streaming` (974691, 2022). Live API validation returned posters and French synopses for both. The qualified Selection inventory now stores those provider TMDB IDs and artwork without changing title/feed/tvgId/group, stable external IDs or playback targets. Regression coverage checks imported IDs/artwork, stable playback identity, and separation from South Park Part 2. Existing records will be corrected through the existing owner/generation/visibility/payload CAS writer as an explicit editorial correction, not a lowered automatic matching threshold.
