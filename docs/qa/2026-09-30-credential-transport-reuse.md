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

## September 30 follow-up fixes
- PR488: transient snapshot conflicts defer under the exact current worker lease. They do not consume provider failure attempts. SQL regression verifies permissions, affinity and stale-lease rejection.
- PR489: page confirmation accepts an exact refreshed title payload once a current-run variant exists; other variants can occur on later pages. Final inventory/prune proof still requires all surviving variants. Rollback runtime fixture rejects stale payload timestamps and premature completion.
- SQL statement/lock timeouts and deadlocks now defer safely. Signed provider pages remain 250 items; database variant writes are split into 100/100/50 with epoch handoff. Changing the signed page size was tried and reverted after spool validation rejected it.
- Two terminal refresh jobs were retained. Audited replacement jobs inherited their run/checkpoint and attempt budget; checkpoint and action-ledger ownership moved atomically. No media or proof reset was performed. The current job has four recorded provider attempts, including one Gateway-restart interruption; keep services stable while it finishes.
- PR489 merged as e564133a92939132e41f65ab222fbde37fba0afe. Provider Access SHA256 on both replicas: fe0bbedde3880acb93622dfb29e2e7ddbff5d71b72b8e5de83e1add198de8d7b.

## Native browser MP4 resume
Sharte Ezdeva uses the raw MP4 broker (no HLS transcoding). Before correction, browser header/tail discovery was followed by a speculative prefix continuation aborted after 341–377ms with no bytes. This incurred provider release delay before the actual resume range.

PR490 gives finite MP4 continuation the existing 500ms seek grace. 111 focused tests passed, two skipped; CI 36675960523 passed. Merged as bbe3ebf7d3c480cb9e96488f5bfda7d7c011bdc1. Both Gateways now use index SHA256 b9ced65fcd355d472bc044519873dd415eef1fad6b442bef1c2b170d95030e48.

After deployment, real browser resume displayed advancing 1280x720 video by the 17.574s observation. The transport trace confirms the speculative prefix request was eliminated. This observation is an upper bound, not a precise first-frame measurement. The provider still required 6.1s for the 3.66MB tail metadata. The server admission/grant phase was 612ms. All own playback was closed after verification.

## Rollup dependency optimization
A rollback measurement of 100 real Strng title rollups took 2408.555ms. Proof-only variant updates were unnecessarily running these scans. The trigger now skips updates only when all membership and ranking dependencies are unchanged: variant ID, title, owner, source, generation, playback cost, observed startup time and creation order. Inserts/deletes and changes to those inputs still recalculate.

The rollback SQL fixture checks hidden/active/legacy visibility, other-owner isolation, title and generation moves, all ranking dependencies, and irrelevant metadata writes. It passed before deploying the migration without service restarts. Throughput measurement and full legacy completion remain in progress.

## Remaining runtime observations
Concurrent catalogue writes have caused fail-closed visibility-epoch conflicts in browser search/history; manual retry after writes quieted succeeded. Do not weaken epoch/ownership validation to mask these errors. Android remains untested in this session because ADB reports no connected device.

## Follow-up database and navigation measurements
- Parent proof used a bad estimate (one media row versus 74,948 actual rows for a catalogue version), causing about two million nested-loop comparisons for 50 variants. A parameterized unique-ID lateral lookup retains every owner/generation/version/run check. Read-only lookup measurement: 100 parents in 3.056ms. Full rollback writer fixture: 50 accepted variants in 194.64ms; invalid parent rejected. Production migration 20260930101000 committed.
- Legacy credential refresh now uses the ordinary importer compatibility/ranking seed instead of setting every version to unknown/500. No old codec evidence is trusted implicitly. 49 focused tests passed; the full contract harness was updated for the shared imports and its 44 focused tests passed. Provider Access SHA256 361e7f4fbcf779c6dea0321ad01727ec4ed4a40200e2a851aa67f74ef975801a; shared projection SHA256 ed3ed6b45ffe0bd44777731e6cb69cb2e87de7bd9fbc9a758c98c980b97d71b6 on both replicas.
- The series view still reproduced a visibility conflict during live writes. A discarded authenticated GET/HEAD now requests an owner-scoped 10-second retry window only when a legacy post-switch refresh is pending/processing. The RPC takes the same epoch lock as the payload writers; their priority check runs after that lock. The stale body is still discarded, mutations are never retried, and an unavailable optional RPC preserves the existing fail-closed response.
- Reader-window rollback fixture passed expiry, owner isolation, unchanged epoch and service-only permissions. Thirty visibility/cache tests passed. Shared finalizer SHA256 1f07d62be84434ed54e7c1f04c94ca326d7c781f98e6798d78df188ee19d6973 deployed on both healthy Edge replicas.
- Real series retry rendered Monkey Wrench during Strng refresh; the database recorded the reader window, it expired, and refresh resumed without increasing provider attempts. Films search also rendered during writes. This corrects the reproduced navigation conflict; continue checking final transition state.
- Single-scan title rollup retains the exact active/legacy/visible-owner filters and ranking, calculating count with a window aggregate. The 100-title rollback measurement fell from 2408.555ms to 1199.205ms. SQL fixture passed active, legacy, hidden, foreign-owner, inactive-generation, ranking and empty-result cases. Migration 20260930103000 committed without restarting services.

## Final PR491 rollout
PR491 merged as e46f5eb1f95ad8df318d4d9eadea6645e74b188f after all four gates in CI 36680612364 passed (cloud contracts, Android phone, Android TV and Windows). This is build/contract evidence, not Android device playback evidence.

Home now reserves the same bounded owner reader window before assembling its rails; other routes request a window only after a discarded read. Thirty-one visibility/cache tests passed. Final shared visibility module SHA256 on both healthy Edge replicas: 5e1982efff6cc765fa2c54f7bc9cbbaab39ef9c9d97f43663cfcf9c8b6255c23.

A full production Home reload started at 06:57:18.893 UTC, rendered the Erik le viking hero, film/series rails and history, and produced no new Dashboard error. The reader window expired at 06:57:31 and refresh resumed by 06:57:36 without increasing provider failure attempts. This is a successful navigation observation, not a precise first-render timing. The legacy transition remains under observation at this checkpoint.

## Additional live playback evidence, 07:13–07:19 UTC
- Sharte Ezdeva MP4: first attempt resumed at 289 seconds. Browser video-frame callback reports 11700ms TTFF; resume lookup 163ms, session resolution 1324ms, attachment 1329ms. Real 1280x720 image and advancing playback confirmed.
- Monkey Wrench S1E1: first attempt resumed around 18 minutes. Frame callback reports 29169ms TTFF; resume lookup 507ms, session resolution 28398ms, attachment 28400ms. Real 1920x1080 image and advancement confirmed. Gateway preparation was 25828ms, including 19060ms to first segment and 23080ms FFmpeg readiness. Its exact current bounded header was parsed before spawning (109ms), but the demux still used the full input-probe budget.
- TF1 HD selected explicitly under the Strng source: real 1280x720 television image confirmed on first attempt. All own streams were stopped afterwards; account activity admission temporarily defers the legacy background refresh without consuming its failure budget.

## Current-header demux correction awaiting rollout
The reduced FFmpeg discovery budget now also accepts a Gateway-parsed bounded Matroska header bound to the same session ID and unchanged exact profile fingerprint. Unknown/historical metadata, another session, a changed profile/file size and a missing requested audio track remain ineligible. Full-probe retry remains available; video-copy and cache-publication proofs are unchanged. Twelve startup tests and 41 related MKV/resume tests passed, with three environment-dependent skips. Runtime benefit is not yet claimed. Gateways must not restart while the legacy signed spool is still needed.
