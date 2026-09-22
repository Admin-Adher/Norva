# Reconcile a committed source creation

An authenticated `POST /sources` can insert a source successfully and then return
`409 CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN` when another catalogue operation
advances the account epoch before the final response. A delayed successful `201`
can also be discarded by the browser's visibility-epoch fence. Previously the
creation form displayed an error despite the new source existing, inviting a
duplicate creation.

The server now records only the exact UUID returned by a successful insert in a
request-local receipt. If the unchanged visibility finalizer returns that specific
409, the error includes `details.sourceCreationReceipt` with contract
`source-creation-receipt-v1`. It still returns a 409; the receipt grants no source
access and contains no source configuration or catalogue data. Failed inserts and
the existing Selection idempotent-conflict branch do not create receipts.

The common web source-create client handles only that receipt, or an exact source
UUID from a stale successful 201. It sends a fresh authenticated `GET /sources`
with `cache: no-store`, and accepts exactly one matching UUID only if the current
source is visible, enabled and not deleted. This fresh read retains all existing
epoch and authorization guards. It never matches by name or host and never
replays the POST. Hidden/deleted/revoked sources, failed reads and older epochs
remain errors. Other callers use the same wrapper without UI changes.

This is response reconciliation, not a general idempotency protocol: a connection
lost before any response arrives or a process killed before producing its receipt
still has an unknown result. Existing general POST retry behavior is unchanged.

## Verification

`node --test tests/source-creation-receipt.test.js` covers ten behavioral cases.
Tests execute the full web client, the real visibility finalizer and the actual
`createSource` function compiled from TypeScript. They cover concurrent account
and global cutovers, strict rejection responses, exact-ID reads despite a warmed
cache, delayed 201/409 responses, deletion/revocation, same-name providers,
malformed receipts, single-POST behavior, and failed/idempotent inserts.

The client baseline matched the served `cloudApi.js?v=9f19eede65` after CRLF/LF
normalization. The production backend contains newer M3U changes than the main
branch at preparation time, so backend changes in the repository are surgical.
The accompanying patch and manifest describe the reviewed overlay against the
exact production baseline; do not replace live functions with an older checkout.

The backend overlay was applied on 2026-09-22 at 09:22:14 UTC, after an isolated
Edge preflight. Checksums matched before and after; a backup and automatic rollback
were prepared. Edge replica 2 restarted before replica 1. On both replicas six
cloud checks returned `sourceCreationReceiptProtocol: 1`, four playback checks
preserved version 82/native-receipt protocol 1, and source-sync preserved the
Xtream/M3U protocols. The 25,000-item QA import stayed READY with no active QA
viewers or QA/M3U import leases before and after the rollout. No new source was
created for this fix. The web client is published separately through the ordinary
static-site pipeline, which must regenerate script asset hashes for all entry pages.
