# Unknown-first language intake and owned stream declarations

## Scope and evidence

The 14 September audit counted 142,274 unknown variants, including 105,058
movies and 37,216 series. This is a dated baseline, not a promised reduction.
About 84% of sampled intake jobs were already identified by provider hints.
104,345 unknown movies had no canonical audio probe. A >10,000 improvement is
an objective to measure after processing, not a prevalidated mapping.

This release makes no country-to-audio inference. Subtitle tags, TMDB original
language, translated titles and bare platform/country tags are not audio proof.
It introduces no public "Audio à vérifier" text and no new LID certificate.

## Pipeline

1. The existing dispatcher reserves nine eligible pages for unknown movies per
   validation page. Independent cursors also let a resting lane yield. This is
   a scheduling ratio, not a guarantee of nine successful provider calls.
2. Reuse genuinely exact, profile-bound audio evidence and hydrate its owned
   filter observation when missing. Never hydrate a host-only legacy cache.
3. When the new switch is enabled, retrieve fresh `get_vod_info` through the
   existing Gateway. One bounded metadata operation per claim, with the same
   visibility, provider circuit, viewer-priority and distributed exclusion.
4. Only languages explicitly named inside technical audio stream objects become
   provider declarations. A multilingual set requires distinct stream objects;
   contradictory aliases within one stream fail closed.
5. Empty metadata is recorded as attempted; a later eligible tick can use the
   existing exact probe/strict LID path. Attempt limits and quarantine remain.
6. Successful owned episode registration captures the same declarations inside
   the existing fenced transaction. Old unknown inventories get one refresh
   after six hours, respecting all failure/provider cooldowns.

Declarations bind user, source, generation, current config/visibility, verified
provider identity and exact external file. Series additionally bind membership
and the response fingerprint. No episode declaration is presented as proof of
every episode, and no stream index or track layout is invented.

## Publication and activation gates

Use the isolated checkout and explicit changed paths. A Git commit is not a
runtime deployment. Apply SQL only with the bound operator in this directory:
`ops/hetzner/scripts/deploy-unknown-first-language-pipeline.py`.

The operator requires a private commit/hash manifest and proceeds through
`inspect`, `rehearse` (transaction rolled back), `apply`, then `verify`.
It records existing definitions, checks drift, preserves existing flags/crons,
and leaves `owned_provider_language_metadata_enabled=false`.
The priority scheduler can run on the previous Edge code. The SQL capture hook
may collect future successful series responses, but their projection stays off.

The new Edge code must be rolled out separately using an exact-file, retained
container deployment. Include this release's two Edge entrypoints and shared
helpers, and account for prior authorized shared-parser changes not yet running.
Do not replace the complete production runtime with a repository snapshot.
The existing idle/drain gate must pass; queued/running transcription work is not
authorization to kill jobs, change admission switches or bypass that gate.

Only after both replicas, owner-isolation checks and catalogue label/filter
parity are verified may the new metadata/projection switch be enabled. Keep the
independent `language_metadata_lane_enabled` and exact-file admission settings
unchanged. Compare unknown variant IDs before/after, provider by provider, and
separately report declarations, exact observations, certificates and failures.

## Verification and recovery

- Node contract/unit suite plus focused owned-pipeline and original-cache tests.
- Bundle both changed Edge entrypoints to check imports and TypeScript syntax.
- Python release-binding/control tests.
- SQL regression against a production-schema-only PostgreSQL container with
  no network and synthetic rows, all rolled back. Tests cover 9:1 priority,
  cursor independence, ownership/config rejection, exact observation priority,
  subtitle exclusion, series membership replacement and preserved cooldowns.
- The proof-container reset validates its exact name, purpose label and
  `network=none` before resetting its synthetic database. Never run against
  production or copy production rows into it.

The SQL operator's rollback restores original function bodies and retains new
columns and captured declarations as inert evidence. It never deletes evidence,
resets attempts/quarantine, or changes cron state. Recheck runtime definitions
after any uncertain response before attempting a new operation.
