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

## Legacy refresh optimization deployed
The already-running Strng transition still uses full post-switch refresh. Bounded batches retain the existing durable lease for up to 16 independently checkpointed slices / 40 seconds, yielding immediately for pending provider work. This removes repeated scheduler gaps without changing SQL proof, ownership, deletion or provider-admission checks. 43 focused tests passed. PR485 merged as cc5cc270b07822324285c5190319fd0d2dfd5b75; Linux cloud-contract gate 36670053908 passed. Both Edge replicas now have Provider Access SHA256 b4241dea5b448a71d551e6595e07bf7066823ca800cae51318eca0aeb24ffcdf.

## Background admission during verification
The provider's single connection was repeatedly marked busy by background media work. The background pre-generation gate now yields while credential work is pending or processing, including work owned by another Norva account with the same provider-account affinity. Viewer playback admission is unchanged. Already-running background tasks finish normally.

The initial PR486 direct-table read was rejected by the real service-role ACL; production was rolled back immediately. PR487 replaces it with a service-only SECURITY DEFINER boolean RPC, without exposing the private jobs table. PR487 merged as 8634199a7e89e951558cacaa2fb538515cb689d4; all jobs in CI run 36671738419 passed. Both Edge replicas have Playback SHA256 54dd4cc60f215cf9c7653bf2f18858e238ceb9c6405206bb1d20c74d109e1402 and healthy responses.

Real pre-generation HTTP requests for both owners sharing Strng return `defer:true, reason:connection-check`. The rollback-only PostgreSQL fixture `supabase/tests/credential_background_priority.sql` verifies actual service-role execution, same-owner and shared-affinity protection, unrelated-owner admission, completed-work release, and absence of anon/authenticated RPC access or service-role table SELECT grants. It passed on 2026-09-30; all synthetic rows were rolled back.

After the five-minute activity fence elapsed, the current transition's durable refresh checkpoint advanced to all 57,443 live entries. The legacy job's old `progress` field does not reflect this refresh; use `cloud_source_catalog_title_refresh_checkpoints` scoped to the transition. Completion and movie/series verification are not yet claimed at this checkpoint.

## Rejected speculative startup changes
Neutral tail-moov MP4 benchmarks showed no meaningful benefit from either smaller range windows (2769 vs 2753ms) or smaller ffprobe analysis limits (2757 vs 2754ms). Neither change was deployed. Real cold MP4 codec-probe timeouts still require a measured fix.
