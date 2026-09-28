# Exact-file admission: scoped rollout candidate

## Purpose

The old exact-file gate depends on global capture and metadata flags. The new
source-bound path has its own audited 0/1/5/20/50/100 percent rollout, intersected
with the metadata owner cohort. No internal-account exception is introduced.
Installation starts at zero. The worker still checks its job-aware capture gate;
metadata probes do not need capture enabled globally.

The new service-only claim RPC binds user/source/file to a visible owned variant
or an active, unexpired, non-quarantined owned validation job (including episodes).
It copies the installed exact-file admission body with a checked replacement of
only the admission predicate/signature. Existing account/file locks, viewer
exclusion, TTL bounds and release protocol are retained. The legacy RPC remains
unchanged for older workers during deployment.

## Evidence

- 24 focused Node tests pass: source/owner arguments, account-first admission,
  release ownership, shared network reservations, drain and viewer preemption.
- Migration applied against the live schema inside a transaction ending in
  ROLLBACK: revision 0, basis points 0, null owner/source rejected and authenticated
  role cannot call the new claim RPC. No production configuration was committed.
- `git diff --check` passes.

## Required before release

Add SQL tests for rollout CAS/stages/rollback, cross-owner and hidden source
rejection, movie and episode bindings, account contention, rolling legacy claims,
and no inference/provider writes on denied admission. Then integrate, deploy SQL
at zero, deploy the matching Edge code through the idle/drain guard, verify parity
and advance progressively with actual provider evidence. This candidate is not
deployed or active. The broader commercial objective remains incomplete.
