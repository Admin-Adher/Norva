# Selection hydration: exact-profile conflict and owner fan-out

## Production diagnosis (read-only)

The single audited recovered job is still completed with hydration pending.
It is the replacement recorded in the existing private recovery receipt, not
a new recovery or reset. Its immutable analysis profile was probed at
2026-09-30T21:04:41.538Z. Its result's top-level verification contains only
method, status, tracks, URL digest and profile fingerprint: probe timestamp
and byte size are absent at that level.

Seven source-scoped cache entries for this external ID have older observed
profiles (September 15–29). All have the same 2,550,218,022-byte size, duration
6274.095 seconds, audio index 1, AAC and six channels. Fingerprints differ.
This equality of selected attributes alone is NOT authority to rebind a
certificate to a different fingerprint or bypass the exact-profile guard.
The old observations retain container/default-track fields that the Selection
normalizer omits. Do not infer those missing fields from an old observation.

The publication RPC writes the new certificate but leaves observed profile
fields untouched. `guard_catalog_observed_profile_certificate` therefore
correctly rejects the write. Disabling that guard or clearing the old profile
would destroy the stale-result protection and is not a fix.

## Worker correction

- Include the analyzed profile's probe timestamp and byte size in new result
  certificates. This does not mutate previously completed results.
- Isolate snapshot and hydration failures by owner; visit later owners even
  when an earlier one fails. Re-read ownership visibility/generation on retry.
- Throw a bounded aggregate error after the pass, retaining the successful
  count. The durable hydration flag remains pending until the pass succeeds.
- Preserve successful publication count if the final acknowledgement fails.
- Never repeat capture, inference or finishing because publication failed.

Validation: 36 worker/Gateway tests passed, none skipped. Added runtime tests
cover both snapshot and publication errors, successful later owners, an owner
removed between retries, changed generation, partial counts and lost ACK.
These tests exercise the repository against mocked HTTP; they do not prove
the SQL migration or catalogue UI.

## Remaining work

The worker correction alone does not resolve the seven profile conflicts.
Implement and test the SQL publication contract against the actual observation
guard: exact durable result/profile/evidence binding, missing legacy top-level
fields, monotonic observed versions, newer/equal-time conflict rejection,
unchanged ownership/generation/URL fences, concurrent observation and isolation.
Do not manufacture a container or re-sign an unrelated profile. Then deploy
the reviewed correction, replay the same pending job, verify ordinary QA
catalogue publication and acknowledgement, and record UI evidence.

No production writes or new provider requests occurred in this diagnosis.
