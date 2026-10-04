# Explicit language requests and automatic backlog

4 October 2026, UTC. Evidence: `2026-10-04-language-campaign-heartbeat-1755.json`.

## Demonstrated failure

At 15:57, Innocent Voices pass three was rejected with `LANGUAGE_AUTOMATIC_QUEUE_FULL`. The queue held 32 automatic jobs. The same provider had two automatic jobs and no manual job, so neither its four-file bound nor the owner's manual budget explained the rejection. The resampling RPC created manual jobs but called the automatic global queue predicate. No new job was created by this rejected request.

Ochi's initial operator helper met the same automatic bound. An ordinary authenticated manual request, using the normal entitlement, exact-profile, ownership and quota checks, returned HTTP 202 at 15:58:37. It subsequently deferred for provider occupancy with zero captures. No occupied provider lease was bypassed.

## Narrow correction

Migration `20261004160000_manual_language_resampling_admission` gives explicit resampling the existing manual budget: two active manual jobs per owner and 20 starts per 24 hours. It retains four outstanding jobs per provider identity across owners and the existing global admission lock. The automatic global queue stays bounded at 32. The execution governor, claims, provider locks, playback priority, evidence, minimum confidence and manual authorization requirements are unchanged.

An exact definition guard prevents patching an unexpected function. SQL ACLs and the definitions of the ordinary/automatic starters, queue predicate, execution predicate, claim and verification functions match before and after deployment.

## Proof and production

- The new regression test fails on the previous function: a manual request cannot enter behind 32 automatic jobs.
- After the migration, 23 SQL assertions pass in a networkless schema-only database with synthetic records and full rollback. They cover automatic queue preservation, two manual jobs, shared-provider four-job bound, daily limit, zero execution capacity, active lease, old receipts/retries, exact ownership, quarantine, incomplete/error outcomes, bounded passes and service-only ACLs.
- Deployed transactionally at **16:07:55 UTC**, with the resulting function identical to the isolated proof. SHA-256: `18c266ce14f1369d80c47ecf9f62bed307be9a9e8f29db36b7f09538f99251a0`.
- No service restart, provider call, direct job mutation or admission pause during migration.
- At **16:08:09**, Innocent Voices pass three was admitted and selected naturally. At 16:09 it still had zero receipts. Ochi also remained at zero receipts after an occupancy deferral. Admission is not a completed analysis.

## Outstanding cases

All six requested exact files remain without a confirmed audio language at this observation. Innocent Voices passes zero through two retain their inconclusive evidence and retry dates. Prey's pass one expired after the playback investigation; it is not a completed consensus. Lost retains one receipt in an expired job. Bolt's old job ended on profile change, while its current exact profile is available. Mars still needs its exact profile. No old job or circuit was forcibly reset to fill these gaps.

The earlier MULTI-SUB stutter investigation remains separate and unresolved for the defective copies; this admission correction changes no playback codec, route or selected version.
