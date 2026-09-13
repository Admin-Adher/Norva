# Scoped capture adoption pilot

## Real passive collection observed

The separate R2 Atlas HU canary ran on diagnostic release `9f1a13bc` without
changing a global SQL flag. Its exact file, current source/generation, unknown
track and absence of an older job were checked read-only. The ready origin
playback received a service-only grant bound to its actual observed profile.

Over 549.618 seconds wall time and 541.929 seconds of media, 550 samples recorded
no lost frames (13,555 frames at the final sample). The first frame arrived at
7.426 seconds. One 14.9 ms waiting interval accompanied the initial 0.1-second
seek; no later waiting, stalled, pause or error was recorded. The client buffer
settled around 120 seconds. This is one real file, not a fleet QoS guarantee or
proof of a causal performance improvement over the older negative canary.

One real 60-second first window was collected from 10,024,536 bytes of local
segments, using no provider transport. The authenticated private record held
1,920,078 WAV bytes, encrypted to 2,561,036 bytes, with exactly a 30-minute TTL.
The first positive readback's three misses were future windows not yet ready.
No inference, commercial-content audio export or language certification occurred.

Normal service was restored at epoch `1789276491.9606414`; both crons resumed,
the operator and recovery guard exited, and zero playback sessions remained.
Only the canary's encrypted audio and empty owner lock were removed. Earlier
negative evidence and all other audio/data were preserved.

Aggregate local evidence: `qos-passive-r2-summary.json` under the task's private
audit directory. Server evidence: `/home/adrien/.norva/passive-qos-canary-r2-20260913/`.

## Remaining integration boundary addressed by this lot

Previously the Edge lookup and SQL handoff both required the global capture
flag. A Gateway-only one-file pilot could collect audio but could not exercise
the real handoff without also changing the route used by unrelated requests.

The new service-only registry authorizes an existing internal-account job and
its exact profile for at most one hour, with no more than twenty active grants.
An identical request is idempotent; replay cannot extend expiry. Revocation is
an exact job/profile/expiry compare-and-delete, not cancellation of the real job.
Deleted/banned users, disabled/deleted sources, profile drift, terminal jobs,
quarantine and expiry make a scoped grant ineffective. The worker still performs
its full existing access and profile checks, and the Gateway file fence remains
mandatory. No track, language evidence, provider lease or model threshold is
changed by an approval.

The existing global mode is preserved. With it disabled and no grant, jobs use
their existing path. Installation creates an empty registry: it does not grant
any job, enable fleet capture or activate Selection host exceptions.

## Validation

- Focused Node/actual-worker tests: 21 passed, no skips or failures.
- Full Node suite: 4,664 cases, 4,643 passed, 21 skipped, zero failures (108.599 s).
- Actual release-operator functions: seven offline Python tests passed.
- PostgreSQL proof: 38 assertions passed, including forty concurrent approval
  requests with exactly twenty accepted and twenty refused. Real installed
  handoff and role-helper definitions were executed against synthetic rows;
  production table constraints/triggers were not copied, while new migration
  constraints were tested. The database had no network, ports or production
  mounts; it was removed after testing. Zero provider requests/production writes.
- SQL proof migration SHA-256:
  `5b5fea73501443b75e3019737b963a14556d682895778fb6814c81ad0b1d4987`.

Publication and production installation are separate gates. The installer
changes one Edge RPC call, retains both old replicas, preserves the Gateway,
flags and protected quarantine, pauses/restores only the two recorded crons,
and runs a separate recovery guard. SQL response loss is rechecked against the
actual atomic DDL, never presumed to mean rollback.

Real-job adoption/inference is still a separate next pilot. The first passive
record expired/was removed normally, rather than being retained past its budget.
The full enrichment goal, including Selection, a real multiple-unknown-track
case and controlled future-provider rollout, is not complete.
