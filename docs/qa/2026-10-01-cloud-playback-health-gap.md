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

## Emulator readiness fix

Head137e4697 passed cloud contracts and both Android build jobs. Both TV
emulator configurations passed. The phone gesture/130% job110230892246 again
exited255 before instrumentation, at the initial HOME readiness command after
font/navigation setup; the emulator ADB transport was unavailable. This was
not a playback assertion failure and is not counted as a successful test.

The readiness harness now tolerates failed transport observations only within
its existing45-second deadline, resets its stable-focus count, and still
requires three successful HOME observations, completed setup and no ANR.
It never retries instrumentation, reboots the emulator, or clears a dialogue.
24 readiness/unlock tests passed under Linux in a disposable, network-disabled
container using mocked ADB and the real shell function (zero skips). Windows
did not have Bash; its21 skipped shell tests were not counted as validation.

Read-only deployment preparation is retained at
`/home/adrien/.norva/cloud-playback-health-137e4697/plan.json`.
The production Edge SHA7302a021 matches repository basee7be0aed. The migration
is absent. No production schema/configuration/service was changed. The health
runtime payload remains identical to137e4697; final rollout must also account
for the readiness harness commit and its exact-head test results.

## Current validation handles (7b68fbe3)

Exact head:7b68fbe3781e8f0991468510cf62d47df53b26e3. Build run36819914790;
Android run36819914758. TV jobs110233067748(font130%) and110233068044(font100%)
succeeded. Phone jobs110233067988,110233068009,110233068179 were still running
at the last check. Do not restart them on an observation timeout.

Phone three-button/130% job110233067844 failed during the second catalogue
fixture. The XML has an empty failure and incomplete65-test run. Diagnostic
logcat exited255 at05:32:21 (not killed by the harness); capture pull failed at
05:32:22 then recovered. AppPID3889 was still present at05:32:27 and05:32:32,
and captures grew from6 to12files before UTP cleanup. This is evidence of a
transport interruption during instrumentation, not proof of a product crash.
No test assertion was weakened. A targeted rerun remains pending until the
workflow is terminal. Artifact11143250936 is retained locally under TEMP
`norva-532-7b68-three13`; raw job log `norva-health-532-7b68-three13.log`.

Deployment operator/payload remain prepared remotely at
`/home/adrien/.norva/cloud-playback-health-137e4697/`; no apply was executed.
The runtime files are unchanged by7b68fbe3. Local staging in TEMP
`norva-health-release-137e4697` also contains `verify-readback.py`: after rollout,
it requests a real ordinary-QA session, decodes5frames, records that actual
first-frame event, verifies health readback, ignores a deliberately late status,
checks another authorized owner's denial, and expires the session. It has not
run and is not evidence of natural UI or physical-device playback.

## Overlapping client reads

A new regression test reproduced an error in the candidate's merge logic:
when two health reads started together, the second response could ignore a
newer recovery because the first response had already changed the local Map.
Entries now pass through the server sequence/timestamp ordering instead of
being discarded based on object identity. Protection against a snapshot erasing
an in-flight report is retained. The failing test now passes;13 health tests
pass in total. The phone/TV WebView fixture covers the same overlap. Backend
Edge and migration bytes remain identical to137e4697 and their passing checks;
the updated frontend requires fresh exact-head validation before publication.

The7b68fbe3 TV artifacts11143505435 and11142744022 each contain a successful,
non-skipped PlaybackHealthWebViewTest (0.207s and0.160s). Those results prove
the previous fixture only, not this newly added overlap assertion.
