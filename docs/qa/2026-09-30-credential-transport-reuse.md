# Address-only catalogue reuse — 2026-09-30

## Change
An Xtream server-address change with identical credentials can reuse the active catalogue. The Gateway computes a complete, order-independent inventory digest while streaming the provider response into its existing encrypted spool. PostgreSQL compares it with actual active movie, series and live rows. An incomplete, duplicate or different inventory uses the existing import path.

Apply preserves the generation, media IDs, episode memberships and owner snapshot. Revision and lease checks fence concurrent writers. Post-switch account verification releases the temporary write seal; recovery authenticates the previous connection before restoring it. Provider pressure defers recovery without consuming failure retries.

## Evidence
- 59 focused JavaScript tests passed, including fragmented streaming, authenticated manifest corruption/rebuild and worker paths.
- Transactional PostgreSQL fixtures passed for success, restoration, both-address failure and inventory mismatch. Every fixture and migration DDL was rolled back after verification.
- Fixtures verify owner isolation, lease rejection, stale transition rejection, idempotent apply, unchanged media IDs and absence of reconstruction/purge work.
- Full regression suite and production rollout pending at this checkpoint.

## Separate remaining work
The existing Strng transition uses the previous full-refresh protocol. This change does not claim to complete it. Gateway codec-probe startup latency and Android playback still need runtime validation.
