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

The scoped operator is `ops/hetzner/scripts/deploy-unknown-first-language-edge.py`.
Its binder takes a read-only copy of the five explicitly hashed live baseline
files and creates Git-bound archives for six paths, including the new helper.
Run `bind-sql`, `stage <commit>`, then
`launch activate-only-owned-language-edge-six-files` in its fresh private root.
The operator pins the existing idle/drain/retained-container recovery helper,
checks both the installed owned-language SQL and prior supplier-parser proof,
and performs no SQL writes or switch activation. `status` must confirm both
replicas and restored cron state. Never reuse a closed or failed attempt.
If the bounded drain expires before any activation, the pinned no-activation
closer first proves both original replicas, no candidate/retained containers and
a dead failed runner, then restores only the original cron bits. It cannot stop
transcriptions or bypass the idle requirement for an actual Edge replacement.

### Explicitly approved 60-minute retry (14 September)

The user separately approved a pause of the planned drivers for up to 60 minutes,
without cancelling current work. `deploy-owned-language-maintenance-60m-20260914.py`
uses a fresh, fixed private root and pins the safely closed six-file release at
`d7dacab268c7ad1b10f349811dadb6a38b766efa`. New unrelated playback changes on main
are not part of that payload. Its Git-bound operator is published separately.
The only timing change is an immutable 3,600-second launch deadline. The existing
run loop reserves the last 120 seconds for activation or recovery. Idle, watchdog,
SQL, ownership, exact-file, retained-container and no-activation closure checks
are unchanged; no transcription, storyboard or playback is cancelled.

Use `bind-owned-language-maintenance-60m.cjs` to create the operator artifacts.
In the new private root run `prepare`, `bind-sql`, `stage <sourceCommit>`, then
`launch pause-planned-jobs-at-most-60m-no-cancellation`. Recheck `status` through
completion and verify original cron bits are restored. Never extend its saved
deadline or reuse the failed or closed attempt. A remaining queue does not grant
permission to interrupt jobs or relax admission conditions.

### Post-VOD baseline (coordinated final runtime)

The prior attempt was closed without activation for the user's VOD priority.
After the VOD task confirmed completion and nine storyboard requeues, read-only
checks matched its final Gateway image and both 160-file Edge trees. The shared
language helpers and catalog entrypoint are unchanged; the live playback entry
is now `c4d9d9a046ecf15f5ba9fbfd331c8bab092df143814503f235906364977cd589`.
Its difference from the new candidate is only the already reviewed language
intake/metadata code. VOD timing, finite-TS, diagnostics and storyboard behavior
are preserved. Gateway files are read/hash-checked and are not deployed here.

Use the binder's explicit `post-vod` profile and the fresh fixed operator
`deploy-post-vod-language-edge-20260914.py`. It pins the six candidate hashes,
the prior reviewed adapter and the approved 60-minute timing helper. Stage
requires the coordinated Gateway image/file hashes and both whole-tree hashes.
Idle/recovery gates and the no-cancellation boundary remain unchanged. Do not
reuse the coordination-closed directory, cancel the nine requeued storyboards,
or deploy main's complete runtime tree. The metadata flag still requires its
separate post-rollout verification and activation.

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
