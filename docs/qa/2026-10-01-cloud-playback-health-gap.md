# Cloud playback health: persistence gap and identity constraints

Audit 2026-10-01, source20f6dbf7 (web deployed via PR531).

## Confirmed behavior

- public/js/api.js:2498 answers GET /playback-status with [] and all mutations
  with success:true/cloud:true, without a backend request.
- PlaybackHealth.report falls back to a local Map entry and broadcasts it.
  A later load replaces that state with the empty cloud response.
- WatchPage.getPlaybackHealthTarget reports movie identity correctly, but an
  episode as itemType=series and seriesId. Persisting this payload unchanged
  could hide an entire series after one episode failure.
- The real POST /playback/events route separately writes cloud_playback_events.
  This must not be described as absent telemetry. It verifies source/device
  ownership, records session-linked or late unlinked events, and also refreshes
  the provider activity signal. A new status adapter must not forge first-frame
  events or duplicate commercial/engagement events just to persist UI state.

## Required correction constraints

Persist owner-scoped, source-scoped exact media identity, including episode
identity and current source revision; never expose another owner's state.
Success after recovery must supersede failure; a late stale failure must not
win over a newer session. Technical/network/account-busy failures must not
hide the catalogue. Unsupported format on web must not condemn native playback.
Do not map one failed episode to its parent series. Return truthful write
acknowledgments and propagate backend errors rather than invent success.

The existing event route is not itself a ready-made catalogue status ledger:
its client fields and late-event semantics are designed for diagnostics.
No production migration, policy or status data was changed during this audit.
Implementation and owner-isolation/runtime proof remain outstanding.

## Implementation in review (not deployed)

Branch `codex/cloud-playback-health-20261001` replaces the empty cloud adapter
with authenticated, paged reads and acknowledged writes. Identity comes from
the owned playback session, including an insert-time source revision snapshot.
The ledger records exact episodes rather than their series. Existing native
first-frame/error events project into the same ledger without fake analytics.
Only safe failure categories are stored; client errors are not a global verdict
that a title is unavailable. A later session wins; once a session has decoded a
first frame, delayed startup failures cannot overwrite that success.

Frontend writes must return an actual entry, and stale responses cannot erase
a newer recovery. Account/token or catalogue-visibility changes clear the cache
and invalidate in-flight results. The local-hub path also refuses to pretend an
unindexed title was updated.

Executed locally: 11 new runtime tests (client, adapter, edge handler), plus
existing first-frame/loading/private-cache/language-facet regressions. The
larger focused command passed 52 tests before the two adapter tests were added;
the final health suite passes all 11. The live-loading suite separately passes
15 existing tests. Locale generation/check and JS syntax checks pass.

Executed the migration and assertion fixture in a disposable PostgreSQL database
`norva_health_qa_20261001` on the existing database container: ownership/device
rejection, exact episode, category redaction, native event projection, stale
session ordering, recovery, source revision replacement, unbound old sessions,
and SQL privileges all passed. No production schema or data was migrated.
The disposable database was subsequently dropped successfully.

Added a required CI SQL test and a shared phone/TV WebView runtime test; these
have not run yet. Remaining: CI/emulator verification, review, deployment of
migration then playback edge then web assets, and authenticated production
cross-device/readback proof. Pre-migration sessions intentionally remain
unbound rather than being assigned an invented historical source revision.

## Concurrency review and CI

PR532 initial head `950f7703` passed the required SQL and full cloud-contract
regression job110229096286. Phone gesture/130% job110229096325 failed before
instrumentation: ADB became offline after emulator boot/navigation setup.
The other jobs were still running; GitHub rejected a targeted rerun with403
because the workflow was active. No rerun was started and no assertions changed.

Review then replaced timestamp/UUID ordering with a server-assigned sequence:
equal timestamps and arbitrary UUID order cannot let an older session win.
The client preserves this ordering as a decimal string/BigInt, including values
beyond Number.MAX_SAFE_INTEGER. The expanded12-test health suite passed.
The updated migration and SQL fixture (equal timestamps, reversed UUID order)
also passed in disposable PostgreSQL `norva_health_qa_20261001_v2`.
This refinement needs fresh exact-head CI/emulator evidence; the initial head's
results do not certify the refined version. Production remains unchanged.
