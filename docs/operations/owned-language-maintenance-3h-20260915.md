# Three-hour owned-language activation window

The user explicitly authorized a new pause of at most three hours on 15 September
2026. This is a fresh, non-renewable attempt, not a reopening of a closed
60-minute attempt. Publication alone starts no pause and activates no flag.

## Scope and invariants

- Only cron 84 (`norva-dynamic-enrichment-fleet`) and cron 159
  (`norva-playback-language-validation-worker`) may have their active bits
  temporarily changed. Snapshot-bound IDs and the digest of all other cron
  fields protect their names, owners, schedules and commands.
- Existing playback and media work are not cancelled, interrupted or bypassed.
  The existing idle gates and retained-container recovery remain unchanged.
- The six Edge payload files, exact baseline tree, Gateway image/source/binary
  checks and SQL prerequisite checks are unchanged from the reviewed post-VOD
  release. No Gateway replacement, provider-limit change, quarantine change or
  metadata/capture flag activation occurs in this operator.
- Unrelated cron jobs, including 180, 181 and 182, are outside its scope.

## Fixed deadline and independent restoration

`post-vod-3h` binds a fresh
`post-vod-language-edge-3h-20260915-<UTC timestamp>` directory to the committed
operator, six Git-LF payload hashes, 10,800 seconds and the acknowledgement
`pause-planned-jobs-at-most-3h-no-cancellation`.

Launch writes the immutable start/deadline before any scheduler pause. It refuses
expired stages, drift, prior launches and closed attempts. The pause watchdog
must identify its process and finish initialization, recording a deadline-bound
ready receipt within 30 seconds. Then the retained-runtime watchdog starts,
and only then may the release runner start.

The pause watchdog is independent of media idleness. It restores the two original
active bits on normal closure or 90 seconds before the deadline, reserving time
for bounded database operations. After an uncertain response it rereads state
before retrying. A database outage or changed cron definition is recorded as a
failure; it never renews authority or claims a late restoration was on time.
The separate runtime watchdog retains its existing ownership/idle recovery gates.

The readiness handshake proves initialization, not immunity to a later host,
process or database failure. Operators must verify the closure receipt and actual
cron state. Restoration failures require attention, not a new pause.

## Export and acceptance order

1. Commit reviewed changes and run offline tests before exporting artifacts.
2. Export with `bind-unknown-first-language-edge.cjs <baseline> <artifacts>
   post-vod-3h`; transfer only the bound artifacts into the new private directory.
3. Run read-only `bind-sql`, then `stage`, then acknowledged `launch` within five
   minutes. Reread the real deadline, both watchdog identities and scheduler bits.
4. Require a successful six-file Edge closure, restored schedulers, healthy
   replicas and dead runner/watch/pause-watch before metadata activation.
5. Bind a fresh activation operator to this exact attempt. Its preflight,
   transaction-rollback rehearsal and compare-and-swap flag enable remain separate
   steps. Other language pipeline flags remain off.

Tests simulate clock boundaries, helper initialization failure, ownership drift,
uncertain restoration responses, immutable attempts and profile/hash mismatches.
They make no provider requests and do not prove real provider audio accuracy,
passive playback quality, fleet throughput or a reduction in unknown variants.

Local validation on the isolated worktree based on `6913282e`: 4,864 JavaScript
tests, 4,846 passed, 18 skipped, zero failures (130.9 seconds); 57 language
operator Python tests passed; syntax, generated i18n, region and whitespace
checks passed. CI and runtime acceptance must be recorded separately.
