# Enrichment pipeline implementation ledger

Base: `d86db0e13871f8d5b43d9faf67516b6b2cd0a969`. Isolated worktree;
the user's original checkout is not part of this release.

The objective covers **all five workstreams** below. A unit-tested helper or a
disabled route is not an end-to-end completion. No production activation or
throughput improvement is claimed by this document.

| Workstream | Required implementation and evidence | State |
| --- | --- | --- |
| Fast metadata lane | Independent admission, bounded continuous batches, exact-cache reuse, preserved account locks; SQL contention and stop/permission tests | Implemented, isolated tests pass; production gate pending |
| Mutualized input | Bound header/range reuse, one input for multiple pending tracks, file-change invalidation, independent temporal evidence; fake-provider byte/connection counts | Multi-track extraction and strong-validator cross-window reuse integrated; real-provider acceptance pending |
| Capture then compute | Private bounded expiring store, attested drain and account release before inference, durable retry without new download; restart/expiry/lost-ACK tests | Gateway + Xtream/episode + current audited Selection client integrated locally; live acceptance pending |
| Passive playback capture | Only bytes already received, non-blocking/drop-on-pressure, no second provider request, no implicit phone upload; playback/backpressure tests | Implemented for exact Gateway HLS sessions; native synthetic tests pass, live playback QoS gate pending |
| Authorized parallelism | Trusted Selection feed + host policies, prudent unknown-provider default, account vs file identity separation, bounded adaptive feedback; mono-session and refusal tests | Implemented locally, SQL contention and redirect/adaptive tests pass; approved hosts/configuration and live trial pending |

## Invariants

- Playback is higher priority. A missing drain attestation retains the provider
  lease until its crash-safe expiry. A completed local computation cannot invent
  a provider-release attestation.
- No provider IP/account rotation, TLS bypass, reactivation of terminal failures
  or quarantines, or change to language certification/model thresholds.
- Cache entries bind the exact authorized source/file/profile/protocol. Shared
  catalogue identity is not a provider credential or proof of unlimited sessions.
- New controls are disabled until a scoped release is approved and verified.
  Existing unrelated flags, timers, model files and production mounts stay intact.
- Store only a bounded working buffer of excerpts, never the VOD catalogue.
  Excerpts and receipts are private; logs contain no URLs, credentials or speech.
- Report metadata declarations separately from strict certification and from
  coverage/accuracy measured against independent listening.

## Release gates

1. Focused executable tests for changed modules/routes; real isolated PostgreSQL
   tests for admission, ACLs, lost leases, generation changes and contention.
2. Full repository tests and packaging checks. Record exact hashes and limitations.
3. Explicit production configuration, storage retention and concurrency ceilings;
   reversible deployment, protected quarantine/control-state comparison.
4. Bounded authorized multi-provider live trial on free accounts, with provider
   connection/byte/latency counters and playback-priority checks.
5. Generalization only after the preceding gates; measure distinct completed
   files/hour, not dispatched tasks or acquired samples. No guaranteed ETA.

## Implementation evidence

Not yet deployed. No new provider acquisition has been made for these tests.

- Metadata migration `20260911182400_enrichment_metadata_lane.sql`: 74 SQL
  assertions passed on a networkless PostgreSQL 17.6 fixture, including real
  concurrent claims, ACLs and no-I/O retry debit refunds. Migration SHA-256:
  `9b5b33cff78241459f75a3ea61a990810589476c57d6d73746b914d74b2414b4`.
  Fixture limitations: synthetic data, visibility wrapper, production row
  triggers not copied. Production function definitions stayed unchanged.
- Full Node suite: 4,409 tests, 4,399 passed, 10 skipped, no failures. Receipt:
  `C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/full-tests-final.log`.
  One existing Android workflow was normalized to LF in this worktree for its
  line-sensitive test; this content-equivalent change is excluded from commits.
- The first metadata-lane executable route tests verify network drain BEFORE local inference and
  retention of the reservation on uncertain cleanup. The **distributed account
  lease is still held through the legacy response**. The separate opt-in
  capture protocol below releases it before the inference request.
- Both Gateway `LANGUAGE_METADATA_LANE_ENABLED=1` and private database flag
  `language_metadata_lane_enabled` are required for activation. They remain off.
  Selection must receive its new capacity-defer client before enabling the
  Gateway gate, so local saturation cannot consume its provider retry budget.

## Private capture handoff (local, not activated)

- Gateway's new service-authenticated status/capture/infer/ack routes require
  signed action + stream + exact-window claims. The infer route additionally
  requires a signed SQL release token and has no provider-download fallback.
- AES-256-GCM private records bind user/job/file URL digest/profile/track/window
  and the pinned method/model/runtime digests. Defaults: 64 MiB encrypted buffer,
  at most 32 records, 30-minute TTL; at most two private scratch workspaces.
  Scratch PCM is additional bounded working space, not part of the 64 MiB
  ciphertext budget. With four-track batching each workspace can contain four
  60-second mono 16 kHz PCM WAVs (about 7.7 MB per extraction workspace).
  No VOD, URL, credential, or transcript is in the journal.
- Space is reserved before provider acquisition. Store commit requires positive
  broker drain including release grace. All source reads are closed before the
  SQL handoff transaction deletes only that attempt's account and identity
  leases. Another viewer/worker's lease is never released by a stale owner.
- On retry, exact local lookup precedes provider idle/circuit checks. The worker
  revalidates source access/profile before inference, persists the existing
  window evidence receipt, then ACKs buffer removal. Lost ACK is handled by TTL;
  local failures retry in 30 seconds or 5 minutes, inside the buffer lifetime.
- SQL fixture: **96 assertions passed**, including the earlier 74 metadata/
  admission checks and 22 capture handoff checks. Capture migration SHA-256:
  `d40ef24452cf57f073819a97584f00c7b1b2c4d6544ffa95467cddc98a8432b0`.
  Same synthetic-schema limitations as above; production definitions unchanged.
- Native Linux runtime fixture: **18/18 passed, no skips** in the existing
  runtime image with network `none`, read-only image, no capabilities, no
  production environment or mounts. Includes exclusive flock ownership,
  restart, quota, encryption, private cleanup, failed drain, and no-redownload
  retry. Synthetic audio and injected extraction/inference: this is **not**
  measured model accuracy, provider throughput, or a live playback test.
- Both `LANGUAGE_CAPTURE_PIPELINE_ENABLED=1` on Gateway and private database
  `language_capture_pipeline_enabled` are required. Gateway also requires the
  metadata gate, verified pinned runtime, and an explicitly configured private
  `LANGUAGE_CAPTURE_PRIVATE_DIR`. None is enabled by this branch.
- Remaining gates for this workstream: Selection worker adapter, production
  mount/retention approval, end-to-end real-provider acceptance with byte/socket
  counters, crash/lost-response and playback-priority observations.
- Full repository regression after integration: **4,438 tests; 4,427 passed,
  11 skipped, zero failures** (109.95 s). Receipt:
  `C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/full-tests-capture-final.log`.
  Latest focused rerun after response-code preservation: 32 passed, one
  Linux-only skip on Windows. Native Linux fixture above covers that skip.
  Executable Edge/Gateway tests cover the real worker handoff order, cached
  retry without provider leases, preemption/458, denied handoff, failed evidence
  persistence, lost ACK, signed route claims, and retry timing inside the TTL.

## One input for multiple pending tracks (local, not activated)

- Edge signs up to four remaining exact job audio indices. Gateway validates
  count, uniqueness, primary index and signed action. Only tracks of the same
  job/user/file/profile/window can be prefetched together. Known/verified file
  bypasses remain upstream; this does not alter the strict job evidence model.
- Space is reserved independently for each companion. A full buffer can drop
  optional prefetch but never starves the primary track; a cached companion
  is not downloaded again. One FFmpeg input emits separately mapped PCM WAVs.
  Each enters the same encrypted store only after a single broker drain.
- Future-track audio is neither a new vote nor a certificate. That track must
  reach its normal owned cursor, revalidate access/profile, and pass its own
  existing temporal-window inference/checkpoint/finalization contracts.
- Capture FFmpeg accepts only its loopback broker input and finite demuxers,
  with HTTP/TCP input protocols, bounded stderr/time and no reconnect. A
  disguised playlist cannot open a second resource through its demuxer.
  References: [FFmpeg format whitelist](https://ffmpeg.org/ffmpeg-formats.html),
  [protocol whitelist](https://ffmpeg.org/ffmpeg-protocols.html).
- Native networkless runtime fixture now **26/26 passed**, no skips. On one
  **synthetic** 20-second two-track Matroska file: one combined input served
  1,285,289 bytes in one local request, vs 2,570,578 bytes/two requests for two
  independent extractions. Both WAVs have 20 seconds and distinct hashes; a
  nested HLS playlist was rejected without requesting its child URL.
  This is not an observed 2x speedup on providers or a backlog ETA.
- Full repository: **4,447 tests; 4,435 passed, 12 skipped, zero failures**
  (115.39 s). Receipt:
  `C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/full-tests-multi-capture.log`.
- Selection adapter and bounded real-provider byte/latency comparison remain.
  Passive playback capture and explicit adaptive Selection policies are separate,
  still-unimplemented workstreams.

## Cross-window range reuse (local, not activated)

- Process-private fragments bind user digest + exact source URL digest + profile
  fingerprint + exact file size. Each new broker performs a current exact 206
  check with the same **strong ETag and effective target identity** before it
  can serve retained bytes. Weak/missing validators never seed this cache.
  Target/size/validator drift and provider rejections invalidate it; no retry,
  new account, proxy/IP change, or relaxed range validation is introduced.
- Missing ranges end only at an already retained fragment, not at arbitrary
  small chunk boundaries. An optional 512 KiB prefix collector copies bytes
  already received. Intentional seeks may retain a valid prefix after teardown;
  failed/truncated/invalid responses cannot publish it. Header/tail-index
  fragments are retained preferentially over interior bytes.
- Hard defaults: 32 MiB total, 4 MiB per exact file, 16 files, 64 fragments/file,
  ten-minute fixed TTL, 30-second expiry sweep. This is memory-only, separate
  from the encrypted audio buffer; restart simply discards these fragments.
  The existing opt-in capture route is its only acquisition integration.
- Native networkless runtime fixture: **100/100 passed, zero skipped** using
  actual Gateway broker functions and actual FFmpeg. On the synthetic chirp
  file, two distinct 20-second windows produced byte-identical PCM with/without
  reuse: 5,866,351 vs 4,024,538 media bytes read by the broker; 5 vs 6 local HTTP
  requests. The extra conditional request matters on high-latency providers;
  this is neither wire-level billing, guaranteed time savings nor a fleet ETA.
  All provider traffic in this fixture stayed on isolated loopback.
- Full repository: **4,456 tests, 4,443 passed, 13 skipped, zero failures**,
  112.27 seconds. Receipt:
  `C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/full-tests-range-reuse.log`.

## Refreshed production inventory (read-only, 2026-09-11 21:11-21:12 UTC)

- Xtream: 526,651 exact keys; 38 certified; 84,227 complete declared profiles;
  442,386 residual candidates (434,433 unprobed and 7,953 partial).
- Selection: 7,695 distinct external-id + URL-digest keys across 82,162 catalogue
  copies; 9 certified, 1,503 other complete profiles, 6,183 residual candidates.
- Combined: 534,346 distinct keys; **448,569 candidates** after deduplication,
  not 507,916 catalogue-level candidate entries. The difference of 59,347 is
  redundant Selection copies, not successful new detections. Residual count
  decreased by 51 since the 17:00 UTC snapshot (10 since 19:50 UTC); these local changes did not cause
  that production progress. Candidate counts are not proof of current admission,
  file accessibility, speech presence or independent language accuracy.
- There are 47 certified cache keys and 85,730 other complete declared profiles.
  Completeness of a declared cache profile is not a speech certificate or a new
  end-to-end revalidation of every URL. In particular, Selection's legacy
  complete profiles need not carry the current URL digest in their certificate.

## Selection capture adapter (local, not activated)

- The immutable audited Selection file registry now signs the same four separate
  capture actions. It cannot submit a different URL, profile or track to this
  protocol. It checks local status before any capture; up to four still-unknown
  tracks may share acquisition. Declared tracks continue to bypass inference.
- Successful provider drain precedes a SQL CAS checkpoint against the exact
  Selection job, URL digest, work lease, profile and track/window cursor. The
  installed owner lookup also rechecks current media availability/identity and
  matching media/variant generation. The independent **job work lease** remains
  for compute; no fictitious provider-account lease is created for Selection.
- Only a returned SQL token permits the signed inference call. Only the normal
  durable window checkpoint permits ACK deletion. Lost ACK is TTL-cleaned;
  local status/handoff/compute failure retries in 30 seconds with the existing
  eight-attempt ceiling. Real provider rejection retains its original backoff,
  and terminal failures are not revived. Receipt finalization is unchanged.
- Activation requires the worker's `SELECTION_CAPTURE_PIPELINE_ENABLED=1`, both
  private database capture flags and the prepared Gateway capture runtime.
  All remain disabled. This adapter does not expand the audited registry or add
  unsupported HLS acquisition; it does not yet authorize Selection parallelism.
- Migration `20260911200200_selection_audio_capture_handoff.sql` SHA-256:
  `c5902aab99e12afa73e103e4522243332e605134368ff1d52cbf95ed4ac56094`.
  Real isolated PostgreSQL fixture now **121 assertions passed** (25 new):
  installed service guard, Selection identity/owner functions, RLS/ACL, lease
  CAS, expiry, file/profile/cursor fences, removed media, generation mismatch,
  resumability, retention, terminal ceiling and FK cleanup. Production unchanged;
  synthetic rows/visibility wrapper/no production row triggers remain limitations.
- Full repository **4,460 tests; 4,447 passed, 13 skipped, zero failed**, 113.89 s.
  Receipt: `C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/full-tests-selection-capture.log`.

## Passive capture adapter (local, not activated)

- Gateway already has a bounded in-band header tee (`maybeCaptureHeaderBytes`
  and `captureBoundedMkvHeaderBytes`). These collect metadata, not certified
  audio excerpts; do not claim this workstream is complete on that basis.
- `localViewerTranscriptionSource` and `hlsMediaPlaylistTargetsForSession` can
  locate audio already produced by a playback process. Reusing those local
  artifacts is promising, but the existing transcription extractor is not an
  automatic strict-LID adapter: provenance, actual source stream mapping,
  original timeline and complete closed segment coverage must first be checked.
- A passive adapter must accept only controlled complete local segments or
  immutable already-received ranges, have NO network fallback, enforce local
  resource/memory/disk limits, never wait in the playback byte pump, and never
  request/upload data from an Android client. Unknown mapping/timeline must
  remain a miss, not an inferred independent window.

- Implemented a bounded timer outside the playback pump. It only snapshots
  complete local EVENT/VOD MPEG-TS segments already produced by an origin-started
  ready Gateway session with exact file/profile/actual audio stream mapping.
  No provider transport, forced seek, Android upload or acquisition fallback.
  Direct/native/raw/live/uncertain timeline/mapping remains ineligible.
- A private local-only FFmpeg (file/pipe + MPEG-TS whitelist, one thread, 8 s
  deadline) prepares the existing 20–60 s search region. At most one passive
  operation, a 24 MiB plaintext snapshot and two existing WAV workspaces; the
  passive admission stops at eight total retained entries or 16 MiB ciphertext,
  reserving the remaining shared 64 MiB/32-entry store for active jobs.
  Startup/foreground/resource pressure aborts preparation; uncertain child
  teardown blocks further passive preparation until restart. Playback files
  are never modified. No transcripts are stored here.
- Deterministic private binding includes owner digest, URL digest, full exact
  protocol-2 profile, track, independent window and pinned method/runtime.
  Only an already authorized exact user/job may adopt it through the existing
  status route. Adoption preserves the original expiry, then uses the same
  durable SQL handoff before inference; no viewer lease is released. This can
  reduce later acquisition, not force compute while playback occupies capacity.
- Opt-in `LANGUAGE_PASSIVE_CAPTURE_ENABLED=1` requires the prepared capture
  pipeline; default is off. CPU/memory/load telemetry must be fresh and low.
  There is no production retention/configuration change in this worktree.
- Actual production-image runtime in a networkless synthetic container:
  **107/107 tests passed**, zero skipped, including native passive extraction,
  Linux private-store restart/ownership and actual Gateway adapter selection.
  The initial fixture used a Node-24-only test helper; it was corrected to run
  the same Edge function body on the production Node 20 image. No product
  behavior was weakened to pass it. Receipt:
  `C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/native-passive-proof.log`.
- Full repository: **4,467 tests; 4,453 passed, 14 skipped, zero failed**,
  117.98 s. Receipt:
  `C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/full-tests-passive-capture.log`.
  Real playback load/QoS and provider yield remain production-canary gates.

## Authorized parallelism and adaptive host admission (local, not activated)

- `selection-enrichment-policy.js` accepts only operator-owned version-1 policy
  for the existing immutable `herbert-tested-vod`, `klysmgt-tested-vod` and
  `sandro-tested-vod` registries. Exact host allowlists, no wildcards, at most
  eight hosts per feed and a ceiling of two. The signed worker capability binds
  feed and file; an imported label, copied object or future provider cannot
  grant an exception. Missing configuration preserves mono-account admission.
- Selection reserves all approved redirect hosts before acquisition. A request
  to an unapproved target, or an HTTPS downgrade, is refused before sending it.
  Ordinary capture reserves each actual redirect destination before contacting
  it and holds earlier reservations until confirmed drain. Thus different
  accounts/aliases/feeds cannot bypass a shared CDN ceiling or cooldown.
- Metadata and legacy direct inference contain opaque FFprobe redirect paths.
  In the new adaptive/Selection-policy mode those acquisitions are exclusive
  with all other provider I/O. This is deliberately conservative; their local
  compute can still overlap drained acquisition. Do not claim that every
  metadata request can use both slots concurrently.
- The shared Gateway ceiling remains two, across capture and metadata. An
  unknown host starts at one; eight successful drained acquisitions permit up
  to two, never above its configured ceiling. The same ordinary account remains
  limited to one. Refusals reduce concurrency, preserve Retry-After and impose
  at least 60 seconds of quiet; values over a day require operator attention.
  Old successes cannot cancel a newer refusal. Separate metadata/capture EWMA
  latency measurements reduce concurrency on drift rather than comparing a
  short header request to a full audio window. Playback/resource pressure is
  still authoritative. Feedback is bounded to 128 hosts and process-local;
  restart starts conservatively, not with a learned concurrency allowance.
- Selection's new task pool owns at most two work leases and can refill while
  another file computes offline. SQL independently caps running jobs at two
  across worker replicas. The worker default remains one and requires both
  capture activation and the private parallel flag before expansion. Current
  eight-attempt ceilings and terminal/failed jobs are unchanged.
- New exact-file leases separate shared catalogue identity from provider
  account occupancy. ASR and metadata first claim the current mono-account,
  then one exact identity/type/external-id key. Different authorized accounts
  may process different files; the same file cannot be downloaded twice and
  the same account cannot own two file leases. Legacy identity-wide workers
  and new workers block one another throughout a rolling deployment. Current
  playback, source entitlement, profile/generation and quarantine checks stay
  in force. SQL capture handoff atomically releases only its own exact file and
  account leases before local inference.
- Private flags `selection_parallel_capture_enabled` and
  `language_exact_file_admission_enabled` default false. Service-only functions,
  forced RLS, fixed search paths and ownership-CAS apply to new state. The due
  job dispatcher narrows identity-wide exclusion only while the exact-file flag
  and its prerequisite capture/metadata flags are enabled.
- Migration SHA-256:
  - `20260911204152_selection_parallel_capture_admission.sql`:
    `6291ba8f78638dd1912fdab32b5fe2e84a8b09e1a5402b70aab6fabdf05c3a5f`.
  - `20260911204928_exact_file_account_enrichment_admission.sql`:
    `79e88eebb2ce9a25df66c2bf1702f4b928b1fa046550d5818ae8a131453c544e`.
- Real isolated PostgreSQL: **171 assertions passed**, including simultaneous
  clients testing global ceilings, same-account exclusion, exact-file dedup,
  legacy/new contention, ACLs, expired/stolen leases, viewer preemption and
  handoff ownership. Production function definitions remained unchanged.
  Synthetic data/visibility wrapper/no production row triggers are limitations.
- Final native runtime: **122 passed, zero skips/failures**, using production
  image digest `sha256:1dfab969dd9707bfb1adb94402439899a6fe6b5b575f9b8c415715f072dd860c`
  in a networkless, resource-limited container with no production mounts/env.
  Receipt: `C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/native-final-host-guards.log`.
- Final full suite: **4,489 tests; 4,475 passed, 14 skipped, zero failed**, 112.86 s.
  Receipt: `C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/full-tests-final-host-guards.log`.
  Whole Edge TypeScript parse, Gateway/worker syntax and packaging paths also
  pass. A test harness initially omitted the new admission helper; it now loads
  the real function and exercises disabled, enabled, missing-flag, occupied-file
  and drained-refusal paths. No product guard was weakened to make it pass.

## Approved 20-file release (11 September, deployment verification pending)

The user explicitly approved publication and deployment of this lot for exactly
20 files, at most two acquisitions, one per mono-session account, and a private
64 MiB working-audio budget with a 30-minute retention limit. This supersedes the
proposed limits below, not the requirement for separate live verification.

- The Gateway now has a default-disabled admission mode. Pilot mode requires
  exactly 20 distinct opaque file keys, bound into authenticated metadata calls
  and signed capture capabilities, with a maximum 24-hour pilot lifetime.
  Missing, malformed or expired configuration cannot expand into fleet mode.
- The current cohort has 20 previously untried files across seven provider
  identities/seven sources; ten have a track map and ten are unprobed. Only
  existing authorized internal-account sources were selected. A source is not
  assumed to be a distinct credential account; production account leases decide.
- Selection has no nonterminal jobs available (192 completed, 523 failed).
  Those jobs are not reset. Its verified new package will be deployed dormant;
  no Selection host exception or parallel flag is activated for this cohort.
- Passive capture stays off. Encrypted records are capped at 32 MiB/16 records,
  reserving the other 32 MiB for the two bounded PCM/inference workspaces.
  The buffer remains private, encrypted, owner-locked and limited to 30 minutes.
- The authenticated retry dispatcher supports only a named list of at most two
  jobs. The pilot operator submits its immutable cohort jobs, not the general
  queue. Two ordinary intake crons are paused recoverably during the pilot.
  SQL job/quarantine, access and provider occupancy checks still apply.
- A pre-release executable test exposed an out-of-scope `captureIndices` in the
  real Edge token generator, previously hidden by test stubs. It is fixed and
  the actual signed/decoded capture capabilities now have regression coverage.
- Full suite: 4,500 tests, 4,486 passed, 14 skipped, zero failures. Final native
  production-image fixture: 125 passed, zero skips/failures. Its test-process
  concurrency is explicitly one to fit the unchanged 64 PID fixture ceiling;
  production ceilings were not raised. Refreshed SQL proof: 171 assertions.
- Selection static import closure: 11 modules, no omitted task-pool dependency;
  package tests exercise actual import in the deployed directory layout, with
  network forbidden. Deployment scripts clone existing container configuration
  and retain previous containers/trees rather than overwriting live files.

### Publication and live activation (12 September, Paris)

- Application series published through `a220bd7ad815e720af90d3746ebc5a2512ab1bd6`;
  scoped Selection deployment correction published in `1756e48f4a2aca05c376ee681832be6bf74b8e72`.
  Build Norva, Partners integration, Relay and Pages CI all succeeded for that
  published revision. The final local full rerun also passed 4,486/4,500,
  14 skipped, zero failures (111.76 seconds).
- All five migrations applied with new flags initially false. Live checks:
  13 service-only SECURITY DEFINER functions, zero anon/authenticated execute
  grants; all three new private tables use RLS and prohibit client reads.
  The protected quarantine's complete-row hash was unchanged.
- Gateway, both Edge replicas and the Selection worker were replaced with
  retained rollback containers. Installed source/model digests, full Edge
  function-tree hashes and container configuration were compared. Existing
  Selection helper versions differ from main: those live dependencies were
  preserved, only worker + task pool + gateway adapter were replaced. The
  actual resulting Selection import graph and 2,329-file manifest loaded in
  a networkless fixture using its production image (zero provider requests).
- An initial candidate inventory included already complete cache entries. No
  pilot I/O or job dispatch had occurred. The superseded private sample and
  unused Gateway container were retained; a guarded before-I/O correction
  selected exactly 20 genuinely incomplete files, ten inventoried and ten
  without inventory, across seven providers. No failed sample was replaced.
- Pilot started at 22:09 UTC with its immutable file fence. The old cron health
  reports inactive by design during this isolated run. The operator uses a
  fresh authenticated named-dispatch health check instead; SQL admission and
  provider occupancy checks are unchanged. Only due owned cohort jobs can be
  scheduled, so a cooling early sample cannot starve later samples.
- A separate bounded end-of-pilot watcher waits for playback, owned work and
  temporary audio to drain/expire, then disables only the new pilot flags and
  restores the two original cron active bits. New code remains installed;
  this is NOT automatic promotion of new enrichment behavior to the fleet.
  Its actual completion is a future verification, not claimed here.
- Private operational evidence is under
  `/home/adrien/.norva/enrichment-pilot20-20260911/` (never publish private plans,
  container Env or provider coordinates). Aggregate progress is produced by
  `run-enrichment-pilot20-20260911.py status`.

The pilot has started, not finished. Initial busy accounts and HTTP 502 inventory
failures are kept in its denominator, not retried with replacement files. No
throughput improvement, 100% success or new certified language is claimed from
these first partial observations.

## Earlier release proposal and bounded acceptance

Nothing in this ledger authorizes a production write. The original dirty
checkout, deployed code, feature flags, protected quarantine and old failed
Selection jobs have not been changed by this local implementation.

Proposed first release, subject to explicit approval:

1. Publish only this isolated commit series after checking current `main` and CI.
   Preserve the unrelated Android workflow normalization. Apply the five new
   migrations with all new flags disabled before deploying the new Edge code;
   unavailable admission RPCs intentionally fail closed.
2. Package the whole Gateway `src/` and both Selection runner modules, including
   `selection-audio-task-pool.mjs`, into its bind-mounted release `runner/`.
   Keep existing credentials, runtime/model digests and unrelated flags intact.
3. Approve a dedicated private persistent directory for
   `LANGUAGE_CAPTURE_PRIVATE_DIR`, owned only by the Gateway runtime, mode 0700.
   Bound encrypted storage to the implemented 64 MiB/32 records/30-minute TTL.
   Scratch PCM and the optional 24 MiB passive TS snapshot are additional
   bounded private working space. No public route, backup/export, transcript
   log or client upload. No token rotation during a retained-audio trial.
4. Initially allow at most two provider acquisitions globally, one per ordinary
   mono-session account and one per host before adaptive warmup. Configure
   Selection exceptions only for explicitly approved, independently verified
   feed + effective-host pairs, at most two; never set a blanket Selection
   exemption. The new automatic host mode is
   `LANGUAGE_HOST_ADAPTIVE_ADMISSION_ENABLED=1`. Keep passive capture separately
   gated until playback-priority and resource checks pass.
5. Run a bounded **20-distinct-file** trial on free, authorized accounts, split
   between current eligible Selection feeds and ordinary providers, without
   reviving failed/quarantined files. Compare the same exact workload and
   definitions of completion. Record acquisitions/bytes, provider hold time,
   local compute time, retries, final-host refusals, private buffer hit/expiry
   and distinct complete files/hour. No model-quality inference from throughput.
6. Stop new admissions on a provider refusal or playback regression, retain
   owned in-flight locks through positive drain, and inspect before resuming.
   Disable new admissions/flags and let owned work drain before rollback;
   retain SQL compatibility guards until old leases expire, never forcibly
   clear a viewer or another worker's reservation.

Coverage limits remain explicit: Selection HLS feeds `babuperumana-vod` (5,551
keys) and `sulthanpamenan-vod` (40) are not added to the finite-file registry.
The 523 failed Selection queue rows are not revived. Passive capture covers
only exact eligible Gateway HLS playback, not native/direct/raw/live flows.
No estimate for finishing the fleet, guaranteed speedup, or zero-ban guarantee
is warranted before the authorized live trial and sustained measurements.
