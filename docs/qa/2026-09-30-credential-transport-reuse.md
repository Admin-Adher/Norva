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

## Production and subsequent runtime checks
- PR484 merged as 8bcc498935d308484e6eaf10a7cde1923883795e; Linux cloud-contract gate 36669477402 passed.
- Migration committed; both Gateways have index SHA256 6e69d9c9a3a9e17007423fcd3ca8ebb67b8942d5caf6f24d8056a4410b910482. Both Edge replicas have Provider Access SHA256 74d512116b7235f137dfd53d5d94aa829ce5b03662a67dadefde04e4f5173b33; health HTTP200/ok.
- Strng A Very Merry Bridesmaid: MKV cold Gateway preparation 2627ms; real image and advancing playback confirmed. Seek at 1010 seconds produced exact requested/actual offset, preparation 7822ms, advancing playback confirmed.
- Same film Nordic TS version: retained input reports format ts; Gateway preparation 2823ms, decoded startup proof and advancing 1920x1080 browser video confirmed. Stopped all own playback afterwards.
- ADB currently lists no device. Android results cannot be inferred from these web checks.
- Local Windows full-suite run had host-specific bash/timing failures and the conflict SQLSTATE failure subsequently fixed. Linux CI passed on the corrected commit.

## Legacy refresh optimization in progress
The already-running Strng transition still uses full post-switch refresh. Bounded batches retain the existing durable lease for up to 16 independently checkpointed slices / 40 seconds, yielding immediately for pending provider work. This removes repeated scheduler gaps without changing SQL proof, ownership, deletion or provider-admission checks. 43 focused tests passed; deployment pending.
