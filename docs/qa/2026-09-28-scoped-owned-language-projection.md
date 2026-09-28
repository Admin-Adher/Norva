# Scoped provider language projection

## Defect

The disabled provider declaration projection invokes full-source episode evidence
inside a correlated exclusion per candidate. A single-source diagnostic count
on production data exceeded 12 seconds (all-owner count exceeded 25 seconds).
No flag was enabled for these diagnostics.

## Correction

Add an owner/source/type-bound invoker function, derived from the existing view
with a guarded substitution. Exact episode evidence is materialized once for
the requested scope. Movie calls need no series evidence. Route effective
language filters and movie intake through the scoped function. Keep the original
view as the reference and retain every ownership, active generation, config,
membership fingerprint and exact-observation precedence predicate.

No activation or certification threshold changes. The helper is service-only
and retains an empty search path. An absent owner yields no results.

## Evidence

- Schema-only production clone: network disabled, no production rows copied.
- 59 existing semantic assertions plus repeated bidirectional EXCEPT ALL
  comparisons against the reference view through fixture transitions.
- Covers declarations, contradictory tags, config fencing, exact movie
  observation precedence, episode replacement, empty metadata, retry backoff,
  flag-off equivalence and helper permissions.
- Production-schema compatibility trial rolled back fully.
- Real-source candidate returned 444 rows in 4,299 ms with the helper; baseline
  timed out at 12,000 ms. Earlier query-only prototype took 2,059 ms. These are
  individual database measurements, not browser latency percentiles.

## Deployment

Not yet deployed. The provider metadata flag remains disabled. Broader
commercial, Android and staged rollout gates remain separate.

## Follow-up: avoid repeated scans of the materialized evidence

The first deployed correction still scanned its CTE per candidate. A broader
source check found 12.116 seconds for 23 projected rows. EXPLAIN on another
source showed 5,704 CTE scans, removing 1,622 rows per scan. Therefore the
single-source 4.299-second measurement was insufficient to generalize.

The follow-up migration replaces correlated NOT EXISTS with an uncorrelated
NOT IN over non-null variant IDs, allowing a hashed subplan. The candidate ID
is a primary key; null evidence IDs are explicitly removed. All other fences
and episode-evidence logic remain unchanged. No activation is included.

Query-level measurements on all four sources with stored nonempty declarations:
23 rows / 1,969.778 ms; 444 / 2,554.868 ms; 3 / 1,424.504 ms;
63 / 751.599 ms. These are EXPLAIN ANALYZE timings on real data with the gate
substituted inside a private transaction, not a production activation or UI test.
