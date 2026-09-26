# Progressive capture rollout

## Purpose

The previous controls were global activation or an exact, expiring grant restricted to internal accounts. A real two-track capture/reuse job completed on an internal account on 26 September: both tracks verified in 268.306667 seconds, six provider acquisitions for twelve track/windows, zero additional provider acquisitions on the second track. This did not prove ordinary-account coverage.

This migration adds a stable owner cohort independent of internal status. It installs at zero. Forward stages are 1%, 5%, 20%, 50%, and 100%; rollback may go directly to any lower stage. The service-only setter compares the expected revision under a row lock and records the actual previous/new stages and operator note. Repeating the same current stage does not generate another event.

The existing global flag and scoped internal grants retain their existing behavior. Setting the cohort to zero disables this new path only: an independently enabled global flag or scoped grant remains authoritative. Check all three controls during rollback.

## Boundaries

- Membership selects the existing capture path; it does not grant playback, provider access, a lease or language evidence.
- Live owner/source, nonterminal job and quarantine checks precede membership. The actual worker still revalidates entitlements, ownership, exact profile, source generation, provider activity, account/file leases and drain receipts.
- No provider URL, credentials, audio or transcript enters the rollout registry. Configuration and events have forced RLS, no client access and no direct service-role writes.
- Installation changes no feature flag, job, retry/circuit deadline, cron or Gateway configuration.
- Before selecting any cohort, both Gateways must be deployed with the matching capture implementation, private bounded storage and explicit `fleet` admission. Keep the SQL cohort at zero until runtime readiness is verified. Existing legacy work remains available outside the cohort.
- Observe actual eligible jobs, playback priority, buffer bounds, drain and cleanup at every stage. Advance only after checking those results. No membership count alone is a successful runtime replay.

## Verification

Migration SHA256: `52f694de3772cd1b8a7b41fb40d73b629d89680c25ed3bcf74c6b702be0ffc49`.

- 35 assertions passed in disposable PostgreSQL 17.6, network disabled, synthetic rows only. Covers inert installation, ordinary and internal owner membership, stable same-owner cohort, different cohort, auth/source/quarantine/terminal exclusions, RLS/ACLs, runtime service-role requirement, invalid/skipped stages, idempotency, revision checks, audit, rollback and unchanged jobs.
- Two concurrent setters with revision 6: exactly one accepted, one stale request rejected. Disposable database removed; production database untouched.
- 68 existing actual-worker/access/handoff tests passed, zero skips. They cover revoked/fraud/refunded owners, revalidation, local cache lookup before provider acquisition, drain-before-inference, lost ACK, signed exact-file actions and unchanged manual-job restrictions.
- The first full CI run caught an application conflict using PostgreSQL's retryable serialization code. The setter now uses Norva's `PT409` revision-conflict contract. All 35 SQL checks and the concurrent race passed again, plus the four application-conflict regression tests.
- The SQL fixture stubs the pre-existing global/internal gate and role helper. It tests the new migration's behavior, not the complete inherited billing schema. Existing scoped-gate tests and actual worker tests retain that separate coverage.

Integration, production installation and staged activation remain separate work. No global readiness or native startup improvement is claimed here.
