# Catalogue/audio scheduling — 26 September 2026

## Reproduced problem

A bounded two-track Selection trial never opened media (zero provider attempts). Repeated catalogue refreshes extended the account's five-minute activity fence: expiry changed from 04:09:15 UTC to 04:15:03 UTC while audio validation waited. The trial was cancelled through the normal job RPC, its approval revoked, and the original Gateway restored. No activity row, retry deadline or provider circuit was cleared.

## Correction

The revalidated audio worker requests a short catalogue yield before the existing foreground checks. Only the current job lease can request it. New catalogue requests for that account yield; an existing request or viewer is never stopped by this mechanism.

- Ninety-second renewal lifetime; a dead worker cannot hold catalogue priority indefinitely.
- Maximum ten-minute window shared by all jobs for an account, followed by a two-minute cooldown.
- Cancelled, terminal or quarantined jobs do not block catalogue admission.
- No change to the foreground activity reader or writer, provider-account lease, file-probe lease, exact profile binding, viewer preemption, or provider drain attestation.
- The priority request grants no provider access. An unavailable coordination RPC fails before acquisition. Database migration must precede the Edge deployment.
- Rows follow their job through a cascading foreign key; the existing job retention bounds their lifetime.

## Verification so far

- 166 targeted JavaScript tests passed (62 worker/foreground checks plus 104 exact-file, metadata, adaptive and authorization regressions), including actual worker execution, unchanged two-phase provider admission, cooldown, and coordination failure before I/O.
- 29 SQL checks passed in disposable PostgreSQL 17.6, network disabled, synthetic rows only. Tested stale lease, cancellation, quarantine, expiration, account isolation, raw/hashed lookup, shared maximum window, cooldown, RLS/execute restrictions, and unchanged foreground function fingerprint.
- Proof driver reused `tests/run-conditional-email-postgres-proof.py` with an isolated name/purpose and the three checked-in SQL inputs. Disposable container removed; production database untouched.

Integration/CI, production deployment and a real multiaudio replay remain open. These tests do not establish mobile startup improvements or fleet enrichment readiness.

