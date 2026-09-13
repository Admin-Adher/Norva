# Enrichment pipeline implementation ledger

Base: `d86db0e13871f8d5b43d9faf67516b6b2cd0a969`. Isolated worktree;
the user's original checkout is not part of this release.

## 13 September — deferred storyboard admission correction

The real NL playback triggered a normal full-film storyboard pass. The process
was followed to completion, not killed. The first passive-job attempt never
activated and restored its owned cron pause without interrupting that pass.
Afterwards, ordinary intake created an ASR job for the same file before the
next pilot could stage. The new pilot refused it; no prior job was reset.

Inspection and an executable reproduction identified another admission gap:
automatic storyboards use explicit service priority 1. Even after the queue
had checked and deferred them, they still blocked passive local processing.
Only a `storyboard` in the transcription queue, with explicit integer service
priority and the internal confirmed-deferral marker, now yields that capacity.
Uninspected jobs, viewer requests, other services, malformed priorities, OCR,
translation, admission checks and all executing operations remain blocking.
Real viewer presence still prevents new enrichment provider connections.

The correction changes one Gateway module. Its release preserves every flag,
model, route, SQL definition, job, quarantine and retained file; the existing
idle-only deployment/recovery supervisor is reused. It does not activate fleet
capture or claim to complete the passive-to-ASR production acceptance.

Validation: 4,671 application tests, 4,650 passed, 21 skipped, zero failures
(103.517 seconds). A first Windows run retained two CRLF-only fixture failures;
normalizing those two physical input files to LF produced no tracked semantic
change. Native exact-image validation: 45/45, zero skipped, network disabled,
synthetic audio only, 0.5 CPU, 512 MiB RAM and a 64 MiB temporary filesystem.
Six new release-guard tests and ten inherited recovery tests also pass.
Native receipt: `/home/adrien/.norva/deferred-storyboard-native-20260913/native-proof.json`.
Publication and live deployment remain separate acceptance steps.

## 13 September — precise foreground admission, validated before deployment

The 00:48–01:04 UTC read-only checks distinguish actual production state from
the older pilot ledger: no pilot/release operator process is alive, the two
permanent enrichment crons remain active, and metadata/capture/passive/adaptive
host lanes remain disabled. The current Gateway is the separately attested
`initial-playback-topology-20260912` release (`119b0270`), not the older dormant
image below. A real subtitle FFmpeg process was followed by a new extraction
and Whisper process with advancing subtitle rows. It must drain normally;
an old row timestamp or a momentarily zero inference counter is not idle proof.

Code-level defect reproduced: `transcribeBusy`/`ocrBusy` cover the queue's drain
loop, including its admission sleep. Enrichment previously counted those
sleeping schedulers and all deferred jobs as executing foreground work.
The new diagnostic distinguishes executing operations, asynchronous admission
checks, pending priority jobs and confirmed deferred background jobs. Only an
explicit priority-2 automatic job already inspected and deferred may yield the
enrichment lane. Uninspected jobs, unknown priorities, viewer/service requests,
translation backlog and actual operations remain blocking. The benchmark's
stricter idle guard is unchanged. Health reports counts only, no job or source
identifiers. All four enrichment admission callers use the same diagnostic.

Validation before publication: 4,625 application tests passed, 21 skipped,
zero failures; 32 Gateway queue/QoS/latency tests passed in the exact production
image with networking disabled, no skips and no media/provider operations.
The first native attempt preserved two failures because its unchanged Edge
test harness requires Node 24's `stripTypeScriptTypes`; these Edge tests pass
in the full application suite, while the revised native run explicitly scopes
the unchanged Node 20 image to Gateway tests. Neither runtime was replaced and
no test was silently disabled. Nine release-specific verification tests and ten
existing recovery/ownership tests also pass. The scoped operator installs only
`index.js`, retains the previous container, waits for real idle and restores
the recorded cron state; staging is not evidence of deployment.

Private audit evidence (no credentials or provider URLs):
`C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-audit-20260913/`.
The 01:04 snapshot's 71 verified voice job rows are a table-state count, not a
measured VOD-language success rate. Full five-lane completion still requires
live passive playback/QoS acceptance, fresh authorized Selection acceptance,
real multiple-unknown-track batch evidence and controlled wider activation.
The approved two acquisitions / one per mono account, 64 MiB working audio,
thirty-minute TTL, viewer priority, certification thresholds and terminal-job
protections are unchanged. No old failed Selection job is reopened for a test.

## Historical state — 12 September, authorized post-pilot follow-ups

The user explicitly authorized publication and deployment of the current and
future in-scope enrichment corrections. This does not widen the approved two
acquisitions / one per mono account, 64 MiB working audio / thirty-minute TTL,
playback priority or no-quarantine-reset limits. Real acceptance remains a gate
for activating each new lane, not another publication-permission request.

Profile rejection diagnostics (`e79f6df3`) and the next operator's same-job
expired-lease recovery (`750a747e`) are published. On 12 September at 06:56 UTC,
both Edge replicas were updated to SHA-256
`f6052c3e7416a4740db990d0517f8229e72ddbb211a72a34bf4e504386bb1d49`.
Fresh production verification confirms both healthy, both original crons
restored, 158 unrelated Edge files preserved, Gateway/runtime/model/proxy
unchanged and flags/quarantines preserved. The new operator is installed in a
separate namespace, not launched over the completed pilot. The recovery helper
and eight executable guard tests are published as `76381818`; all three CI
workflows succeeded. Application suite: 4,499 passed, fourteen skipped, no failure.

The passive patch adds optional exact-account + URL + structural-profile passive
canary grants to the already bounded, expiring file admission manifest. No
grant means no passive pilot. Invalid/foreign/expired grants remain denied;
public health exposes counts only. This avoids needing fleet activation for a
real playback trial. The private encrypted store is capped at 32 MiB in both
modes; the single concurrent passive TS snapshot is capped at 16 MiB, retaining
the approved 64 MiB total working-audio envelope with the shared workspaces.
This is a private working-file limit, not a process-RSS claim.

Current patch validation: 4,503 application tests passed, fourteen skipped,
zero failures (104.02 seconds). Sixteen tests also passed with real FFmpeg in
the exact production image, with networking disabled, no skips, no provider
requests and no production mutation. Native proof:
`C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/scoped-passive-native-proof-20260912.json`.
Published application commit `73913e4fe5a443f9afcb3e6024b6ca0658804575` was deployed
dormant at 07:24:32 UTC, using image
`sha256:89d5c5063412c7417ecd840c8bd025ba002146adc25d122162d4a83d9b4bf7a7`.
Its three changed modules match the native-test source hashes. Fresh verification
at 07:24:48 confirms the exact image, eleven attested modules, preserved runtime,
models, proxy, Edge replicas, Selection worker, flags and protected old evidence.
Both crons are restored, both release processes exited and no provider request
was issued by this deployment. The old container is retained. Operational helper
`b0ce9ecc336b548dc2df60eabb0baaf14d490889` includes ten executable recovery tests,
including interruption between container renames and refusal to stop active work.
All three CI workflows succeeded for both commits.

Sanitized production proof:
`C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/scoped-passive-production-proof-20260912.json`.
Passive capture is still disabled. Real playback/QoS validation requires the
user to reconnect the test account; no credentials or login link should be
shared with the agent. At 07:27:25 UTC the immutable Selection registry and
current queue were also rechecked, without provider I/O: 2,329 files, 715
initially unknown (192 completed, 523 failed), zero unknown without a job and
zero nonterminal jobs. The other 1,614 already have declared language metadata;
they are not newly enriched results. No old failed Selection job was restarted
and no blanket feed/host exception was configured. Readiness proof:
`C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/selection-readiness-postrelease-20260912.json`.
Selection acceptance and full five-part goal completion remain pending; the
completed pilot and all old failed jobs remain immutable. Historical statements
below describe their dated release state, not the latest active images.

## Historical result — 12 September, independent pilot closed and verified

Final verification at 04:22:13 UTC: **16 of the unchanged 20 VOD enriched**,
ten by complete declared-track inventories and six by speech validation (four
English, two Arabic). The six job certificates agree with the exact shared
cache. Four technical header/profile operations failed before speech analysis;
they remain in the denominator and were not reopened. One of those four was
already partially inventoried before the pilot and is not counted as a success.
The 80% enrichment rate is not a human-reference language-accuracy estimate.

The retained exact pilot container reports 36 successful captures and 36 local
inferences, each with positive provider-drain attestation. Capture median:
23,950.5 ms, range 16,883–158,496 ms; inference median: 2,951 ms, range
1,630–4,428 ms. Every capture returned approximately sixty seconds of audio,
not necessarily sixty seconds of dialogue. Last active strong-validator range
reuse: 93 hits, 8,314,994 reused bytes. Peak concurrent brokers: two; peak
encrypted storage: 2,561,004 bytes. All six speech jobs had a single track, so
this cohort does not prove real multi-track batching or passive playback QoS.

The one-shot expired-lease recovery described below completed the same final
job, without a reset or modified live runner. At 04:21:22 UTC the watchdog
closed the pilot. Fresh verification confirms the same published Gateway image,
four services, restored original cron specifications, all five new flags off,
zero retained working audio, operator/watchdog exited, old evidence and
quarantines unchanged. The installed code is retained dormant; no fleet,
Selection or passive-capture expansion occurred.

The profile-diagnostic follow-up and expired-job operator correction are local
only, not published/deployed. Global acceptance still needs authorized real
passive-playback/QoS validation and an eligible Selection cohort plus exact
feed/host policy. Do not mark the five-part objective complete from this pilot.
Sanitized final evidence:
`C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/independent20-final-closure-20260912.json`.

## Deployment history — 12 September, independent pilot launched

The explicit new approval has been executed: application fix `4a77a5ca` and the
independent operator `6f67d892bafa31012935e27404e608611ad2b534` are on `main`.
All three CI workflows for each commit succeeded. Gateway image
`sha256:7b27b71ea57b0494a898ac59415a85a7d1ba305ecb7955fc6c3ccea4c8dfb052`
was deployed after ordinary work drained naturally. At 03:26:47 UTC, all four
services, eleven Gateway modules, runtime/binaries and protected old terminal
jobs/evidence verified. The new twenty-file fence and metadata/capture/exact-file
flags are active; Selection capture/parallel flags and passive playback capture
remain disabled. No old job or provider cooldown was reset.

The distinct lot spans four providers and five source accounts; 115 distinct
prior-cohort files and three cooling providers were excluded. Its immutable
deadline is 2026-09-13T03:23:29Z. A mistyped commit argument in the first staging
attestation was corrected before any provider I/O, after matching the two source
hashes; the prior attestation is retained and the cohort/deadline did not change.
The independent operator and watchdog are alive. Limits remain two acquisitions,
one per mono-session account, 64 MiB private working audio and thirty-minute TTL.

At 03:29:55 UTC: four newly complete declared-track inventories (two French,
one Arabic, one English), two partial inventories including the initial partial
file, fourteen not yet inventoried; zero speech-certified files. One attempted
file failed the exact-profile completeness contract (application HTTP 502), and
busy accounts were deferred. This is not a final cohort result, ASR accuracy,
proxy-failure diagnosis or fleet-throughput proof. Full-objective acceptance
remains incomplete. Sanitized local report:
`C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/BILAN-PILOTE-INDEPENDANT-20-20260912.md`.

### Follow-up observations and local diagnostics, not another deployment

The immutable cohort's metadata pass reached all twenty files: ten complete
declared-track inventories, six admitted to speech validation, four unsuccessful
or uncertain header operations. The exact-cache totals differ: one failed
operation was the initially partial file, so there are seven partial inventories
and three still absent. Old failures and quarantine hashes remain unchanged.

A read-only activity audit found five fresh `catalog-refresh` ledger rows, no
active playback and no provider-account/exact-file leases at that instant. Four
of the five cohort source accounts could be matched via their recorded playback
account hashes: all four were blocked by the foreground-validation RPC but not
by the catalogue-refresh RPC. This is the existing five-minute activity grace,
not evidence of a live viewer or an upstream provider refusal. It was not
disabled or shortened. Once it elapsed, real acquisitions began naturally.

At 03:44:12 UTC the Gateway had completed two captures of approximately sixty
seconds: 22.586 s and 37.689 s including positive provider drain. The first local
inference completed in 4.428 s after that drain; one strict temporal window was
checkpointed and the next was running. This strengthens the capture-before-CPU
evidence, but is still not a complete VOD certificate, independent accuracy
measurement, multi-track reuse measurement or passive-playback QoS proof.

One rejected metadata response failed at `exact-profile-validation`; another
at `gateway-profile-probe`. Their generic application HTTP 502 alone cannot
establish which provider/proxy/file property failed. A **local, not deployed**
follow-up adds fifteen fixed-vocabulary profile rejection reasons (missing or
oversized maps, invalid or duplicate indices, provenance, incomplete in-band
metadata, container, duration, size and timestamps). It does not relax the
acceptance predicate or expose these reasons in public errors. The actual route
test confirms that only the fixed reason is logged privately and that the
drained lease is released. Compatibility/boundary tests preserve the previous
predicate; no retry or new provider request was made for this diagnosis.

Validation of this local follow-up: 22 focused tests passed; full suite 4,513
tests, 4,499 passed, 14 skipped, zero failures, 104.883 s. Full log:
`C:/Users/AdrienHernandez/.codex/tmp/norva-enrichment-pipeline-20260911/full-tests-profile-diagnostics-20260912.log`.
It remains separate from the unchanged live pilot and its source attestation.

### Five voice certificates, expired-job recovery and Selection readiness

At 04:14:44 UTC, the independent cohort had ten complete declared inventories,
five voice-verified files (three English and two Arabic), four header/profile
failures and one ongoing voice job. All five certificates were also present in
the exact cache. These are pipeline results, not human-reference accuracy.

Two simultaneous acquisitions were observed, and the live exact-file lease
table's unique provider-account constraint and supporting index were verified.
At 04:14:44 UTC, strong-validator range reuse had 69 hits and avoided 6,779,390
repeated response-body bytes. The earlier zero-hit observation was temporary;
no validator relaxation or speculative cache change was made.

The last voice job had remained `running` with an expired five-minute work lease
since 03:42:48 UTC, zero provider attempts and no capture started. The scoped
operator only selected queued/retry-wait jobs, unlike the ordinary durable
worker which also reclaims expired running/finalizing jobs. At 04:11:49 UTC,
after checking ownership, the unchanged immutable plan, deadline, idle Gateway,
old evidence, lease expiry and zero provider attempts, one authenticated request
woke that same job. Its private exclusive intent/receipt prevents duplicate
recovery after an uncertain response. No SQL row was reset, no failed job or
quarantine reopened, no cohort/deadline or live runner hash changed. By 04:15:51,
four acquisitions had started and three temporal windows were checkpointed.

A local-only operator correction adds database-confirmed expired running and
finalizing leases to the exact cohort SELECT. It preserves the two-job maximum,
ownership/start-intent checks, quarantine exclusion and atomic server admission.
Six executable regressions cover expiry boundaries, live/missing leases,
terminal/foreign/unowned work and due-time ordering; four failed before the
correction and all six pass afterward. All 25 focused operator/resume tests
pass. The live runner is intentionally unchanged while its attested pilot runs.

Read-only Selection inventory at 04:03:14 UTC matched 2,329 exact manifest files
from three supported feeds: 715 initially unknown, 192 completed jobs, 523
failed jobs, zero nonterminal jobs and zero unknown files without a job. The
three feeds each currently resolve to one manifest origin host. No provider
request, job reset, manifest change or exception activation was made. This is
not permission/rights evidence. A fresh Selection acceptance workload and the
explicit feed+host policy still need a separate authorized decision. Passive
playback capture likewise remains disabled pending real playback/QoS acceptance.

## Earlier state — after the maintenance deployment

The sections below retain earlier implementation/release observations; their
"local" or "not deployed" labels describe those earlier observations, not the
current entire release. Current production was reverified against the private
release plan for `b2c21b5b6921ec21b097f044b88dd4f7a3daa280`: all four services,
Gateway source/runtime hashes and protected terminal/quarantine rows match.
Its image is `sha256:0a8278bc5b08db316d2cd47b7fa8b2890939da4f05246b158296e643c0a46487`.
All three CI workflows for that published commit succeeded.

The user-authorized interruption preserved the first subtitle job, which finished
naturally with 604 segments, and interrupted only the second still-pending job.
A CRLF/LF attestation mismatch triggered a successful rollback before the final
normalized-source deployment. The replacement and later pilot closure succeeded.
No partial VTT was discarded or promoted to a completed result by the operator.

Only original sample 20 remained admissible in the authorized nine-file subset.
Its existing provider probe circuit expires at 2026-09-12T23:28:17Z, after the
original pilot deadline, 2026-09-12T22:00:15Z. The subset made zero provider
acquisitions. Its exact idle operator was stopped and its watchdog closed it:
ordinary crons restored, all five new flags disabled, no retained audio, and new
code left installed. No deadline extension, replacement sample or reset of a
failed/quarantined job. Selection currently has 192 completed and 523 failed
queue entries, with no nonterminal queue entry for an immediate continuation.
Three provider probe circuits are currently open. These are admission facts,
not proof of inaccessible media or of model accuracy.

### Published follow-up: passive eligibility agrees with the server

The passive adapter incorrectly treated `mis`, `nar` and unsupported three-letter
tags as known, while regional/whitespace variants such as `en-US`, `pt_BR` and
` ENG ` could be needlessly collected. A test of the actual Gateway adapter
reproduced the exclusion of `mis`. Eligibility now follows the existing Edge
`normalizeIsoLang` contract, without changing that contract or publishing any
language result. A differential test executes the actual Edge function over
its full alias map, all 676 two-letter combinations, nonlanguage markers,
regional suffixes, case and whitespace variants. This is compatibility coverage,
not validation that every syntactically accepted tag names a real language.

Validation: 60 focused tests passed, two native-only skips on Windows; full suite
4,494 passed, 14 skipped, zero failures (119.52 s). Native production-image copy:
133 passed, no skips/failures (12.49 s), network none, 0.5 CPU ceiling, no
production environment/mounts and zero provider requests. The initial native
preflight waited for ordinary work to finish; nothing else was interrupted.
This follow-up was published on `main` as `4a77a5ca177ba1af68b9996b1c657044c01dfed8`
after explicit approval. At the start of this new operation the current Gateway
is still the verified `b2c21b5b` release; passive capture remains disabled.

### Authorized independent pilot — 12 September

The user's latest approval explicitly authorizes publication/deployment and a
**new distinct twenty-file pilot**: global acquisitions <=2, one per mono-session
account, private audio working budget <=64 MiB, retention <=30 minutes. Its new
immutable window is at most 24 hours, never an extension of the old pilot.
`deploy-independent-pilot20-20260912.py` uses a separate root, plan, state, image
and retained rollback pair. Selection first excludes the original twenty and
the earlier hundred-file cohort, all existing validation jobs, already-complete
metadata and open provider/file cooldowns. Every actual operation still rechecks
production playback, source and account admission.

The operator reuses the audited capture runner and its stop-on-quarantine/refusal
rules, starts its watchdog before pausing exactly the two enrichment intake crons,
and waits for genuine idle before replacing the Gateway. Closure disables only
the five new flags and restores the original cron states. Old plans and terminal
job rows are hash-protected. No old failures/quarantines are reset; no Selection
host exception or passive playback collection is activated. Twelve executable
Python tests cover selection, cooldowns, file/account identity, bounded scope,
idle checks, private-audio closure and preservation of the existing baseline.
Preparation is read-only with respect to providers; launch/results require their
own later live receipt and must not be inferred from these tests.

### Full-objective acceptance is still incomplete

| Requirement | Strongest evidence available | Missing acceptance evidence |
| --- | --- | --- |
| Fast metadata queue | Implemented, SQL/admission tests and one new declaration in the original pilot | Representative successful live batch and measured throughput; new lane currently off |
| Reuse headers/ranges and one input for multiple tracks | Real FFmpeg synthetic byte comparisons; bounded exact-file reuse tests | Successful representative provider batch, not a synthetic speedup extrapolation |
| Release provider before local inference | One real 60-second capture, positive drain, SQL handoff, local inference; restart/ACK tests | Complete file-level outcomes across an accepted live batch |
| Reuse ongoing playback with no second provider stream | Actual adapter tests, synthetic local HLS extraction/adoption and corrected eligibility | Separately authorized real playback/QoS canary; passive flag remains off |
| Authorized Selection/ordinary/future-provider concurrency | Policy, redirect, contention, refusal and conservative-default tests; original peak two acquisitions | Fresh eligible Selection cohort and explicit host policy, then bounded live acceptance; no host exception currently enabled |

The new distinct pilot window/cohort is now explicitly authorized; the original
twenty remain in their historical denominator. Real passive playback acceptance
and Selection host-policy activation are separate gates, not implied by a new
ordinary-provider cohort. The full five-part goal must not be marked complete
from these tests or the deployment alone.

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

## Pilot diagnostic follow-up, 12 September (UTC+2)

The original 20-file cohort remains immutable. Before the diagnostic pause,
16 file-probe slots had been consumed: one new English track declaration,
eight failed/inconclusive inventories, seven files in validation and four still
waiting. One validation window reached a durable checkpoint; this is not a
completed/certified file. Pre-existing French/Japanese track labels are not
counted as pilot discoveries. The observed network peak reached two brokers,
with no more than one exact-file lease per ordinary account.

Existing Edge diagnostics place seven inventory failures at the Gateway probe
and one at strict profile validation. The Gateway's latest probe classifier is
`codec_probe_file_unavailable`; this does not retrospectively classify all
seven failures. Capture failures were flattened to a generic Gateway error.
The exact idle operator was therefore stopped, without interrupting Edge work,
viewers or FFmpeg and without resetting jobs, attempts or sample membership.

The follow-up changes only two Gateway helpers to emit closed internal
diagnostics: capture stage/result and bounded FFmpeg failure categories. Raw
stderr is transient (at most 8 KiB), never returned or logged. No provider URL,
account, capability handle, title, transcript or language prediction is emitted.
Logger failures cannot affect admission, cleanup or retry decisions. The
deployment retains the immutable original plan, old image/container and exact
cohort/deadline. A separately validated revision updates only these two module
hashes and the image; the closure watchdog reads the revision after restart.

Validation: focused Node tests 43 passed/2 native-only skipped; deployment tests
8 passed; isolated native runtime tests 127 passed/0 skipped, network disabled,
zero provider requests. The first full parallel run had one existing
complete-cache abort-timing failure (4,487 passed, 14 skipped); its focused
rerun passed 39/39 runnable tests. The complete rerun with four concurrent test
processes passed **4,488 tests, 14 skipped, zero failures** (136.87 seconds).
No media or test threshold was weakened. The initial offline image build failed
before creating an image; staging now explicitly tags and verifies the already
local base image, as in the original deployment, and resumes only identical
two-file build inputs. No running container was changed by that failure.

### Capture-duration contract correction

Diagnostic revision `2e0e107a` was published, deployed and verified on all four
services; its image was
`sha256:58e47fc42ce86963a7a2b023020e556ca4a3ce6a211163a72af12a025c42b7ea`.
The unchanged cohort resumed, then its idle operator was paused again when a
real capture reached confirmed provider drain but failed at storage with
`LID_CAPTURE_DURATION_INVALID`. Another extraction failed earlier and remains
unclassified; neither is silently counted as a detected language.

The concrete contract mismatch is in the new store: it required the exact full
search-window duration, whereas the established speech selector already uses
available audio up to that search limit and still requires a complete 20-second
selected sample. The correction accepts decoded samples between that existing
minimum and the planned maximum, using integer PCM sample counts. It adds no
padding, changes no origin/stratum, performs no extra fetch and lowers no speech
or language-consensus threshold. The unchanged selector still rejects an
unavailable fallback anchor or invalid VAD selection. Storage reads enforce the
same bound, hash, file/account binding, encryption and original expiry.

The regression test retains a 59.95-second source byte-for-byte across restart,
then selects exactly 320,000 PCM samples (20 seconds). A 19-second capture and
audio beyond the planned region are refused. A 20-second partial without a
usable anchor/speech selection still fails downstream. Internal diagnostics
now record the requested and actual durations, never content or identities.

The independent synthetic timing lab (AAC/MP4, AC3/MKV, MP3/AVI, FLAC/MKV) did
not reproduce a timestamp-reset defect; no speculative FFmpeg timestamp filter
was adopted. All eight synthetic comparisons returned 60 seconds with identical
shared PCM. This is not a reproduction of any real provider file.

Validation of the duration correction: **4,489 tests passed, 14 skipped, zero
failed** (116.71 seconds); native isolated proof **128 passed, no skips**, using
the deployed image with candidate modules mounted read-only and network disabled.
The release revision is limited to the store and capture pipeline. It preserves
the prior diagnostic revision, all original plans, sample/job counters, runtime
binaries, two acquisitions maximum, mono-account serialization and 30-minute TTL.

### Explicit decoded-sample ceiling

The duration-contract correction was deployed as `d7237ffd`, image
`sha256:e6b3832af954d0ba6246aef7b1ecb3e49785e7c211c6433d0273d003ca2609b1`.
Its first real two-track attempt still failed the duration bound. Both measured
durations exceeded the previous 60,000 ms diagnostic display ceiling: they were
not short excerpts. The partial-search correction was legitimate but did not
resolve this separate overshoot. No language success is claimed from that run.

The next change makes each output's PCM budget explicit after 16 kHz resampling:
`aresample=16000,atrim=end_sample=<planned sample count>`. The existing timestamp
limit is retained as well. No timestamp reset, padding, new input, reconnect or
additional temporal region is added. Internal duration reporting now covers the
parser's existing 90-second range so an overshoot is not hidden as a null value.
The output store still refuses audio outside its approved temporal/sample bound.

The native runtime advertises `atrim.end_sample` as the first sample excluded
from the output. Native tests pass **128/128**; the negative-timestamp fixture
produced 320,000 samples both before and after this guard, so it is explicitly
not a reproduction of the real overshoot. The real pilot must demonstrate the
effect. It remains the same 20 files, with no reset of failed probes or attempts.
The full suite also passes: 4,489 passed, 14 skipped, zero failed (118.78 seconds).

### Pilot closed automatically — 23:06:49 UTC, 11 September

Code `3e47d2a5` was published and deployed. A real capture saved 60,000 ms after
confirmed provider drain (25,492 ms acquisition/closure), followed by a completed
local inference (5,428 ms). This is not a complete ASR-certified file.

The exact cohort then stopped on its first newly quarantined sample: eight
provider attempts without a completed window. Final operator snapshot: 1 new
English track declaration, 9 failed/inconclusive inventories, 1 quarantined,
8 partial/pending validations and 1 unprobed file (20 total, 19 probe slots
consumed). No failed sample was replaced and no job/attempt/quarantine reset.

Closure was independently verified at 23:08:16 UTC: both original intake crons
exactly restored, five new flags false, pilot mode disabled, private directory
containing only `owner.lock`, zero remaining audio bytes. The new code remains
deployed as image
`sha256:56131749e03ffeaa8672d7994864a8e19d279bccbba7890a8a40c15528186344`.
All four services/configurations/hashes and the protected original quarantine
were verified. The original deadline and cohort were never extended.

The observed network peak was two; observed exact leases never exceeded one
per mono account. Peak encrypted bytes sampled by the operator: 2,561,001 (not
an exhaustive maximum measurement). No active provider playback circuit was
present; the latest circuit update remained 6 September, not this pilot.
The pilot is **not accepted**, new logic is **not promoted to fleet**, and any
resumption requires a new controlled decision. Remaining extraction failures
are not claimed fixed by the sample-bound change.

### Post-closure diagnosis — local only

All three CI runs for deployed code `3e47d2a5` are now successful. The pilot
remains authoritatively stopped/closed; its new feature flags are disabled and
the original crons restored. No pilot acquisition or quarantine reset has been
performed during this follow-up.

Read-only aggregation of the four retained Gateway releases found ten transport
failure events: all before provider response headers, zero progress bytes,
`UND_ERR_ABORTED`, no recorded deadline expiry, 1,429–1,571 ms. These are events,
not ten distinct files. Their logs do not preserve the original error messages,
so they cannot establish whether a proxy refusal caused the real failures.

Local regression tests exposed two diagnostic omissions: FFmpeg's generic
`Server returned 5XX` wording was unclassified, and the broker's fixed
`PROVIDER_FETCH_FAILED` code was omitted from the capture diagnostic allowlist.
Both are corrected locally without modifying retry or networking behavior.

The bundled Undici implementation also maps a refused CONNECT response to
`UND_ERR_ABORTED`. A real local synthetic CONNECT proxy returning 502 reproduces
that code with one CONNECT request and no provider request. The candidate
diagnostic records the exact fixed-envelope proxy status separately from the
provider HTTP status; it does not serialize messages, URLs, credentials or
stacks. This distinguishes a possible origin of the failure but is **not** proof
that the real provider path failed that way. No route/IP/credential rotation,
certificate bypass, extra acquisition or quarantine retry was introduced.

Focused tests: 98 passed, three native-only skipped. Native isolated runtime:
131 passed, no skips, network disabled, zero provider requests. This follow-up
has not been deployed or used to restart the closed pilot.
Full local suite: **4,492 passed, 14 skipped, zero failures** (112.89 seconds).
The changes are retained in the isolated branch only, not published to `main`.

Full-goal acceptance remains incomplete:

| Requirement | Current evidence | Remaining gate |
| --- | --- | --- |
| Fast metadata lane | Implemented/tested; one new declaration in the pilot | Reliable real batch/throughput acceptance; currently disabled |
| Exact-file byte and multi-track reuse | Isolated tests and some real range-cache reuse | Representative successful batch; no fleet speed claim |
| Release provider before local compute | Real 60-second capture, drain, durable handoff and local inference | Complete file-level validation across the pilot |
| Passive reuse of eligible playback | Implemented/tested, flag disabled | Authorized real playback/QoS acceptance; no second provider flow |
| Trusted Selection exceptions and conservative future providers | Explicit-policy/admission tests; no blanket exception | Authorized eligible real Selection pilot, then deployment decision |

The full objective is not complete. Resuming the stopped pilot or expanding its
activation needs a new controlled decision; already failed/quarantined samples
must not be reset to improve the reported result.

### Explicitly authorized remaining subset — 12 September

The user authorized publishing/deploying the diagnostic and resuming only the
nine nonfinalized samples, preserving quarantines, two global acquisitions, one
per mono-session account, 64 MiB private working space and a 30-minute audio TTL.
Fresh SQL at 01:56:45 UTC found that ordinary background processing had already
made eight of those nine terminal: two verified, two newly quarantined and four
strict-consensus-inconclusive failures. Only original sample 20 remains eligible.
These later results are **not** attributed to the previously closed new-pipeline
pilot. The original twenty-file denominator and all old receipts remain intact.

`resume-enrichment-pilot9-20260912.py` prepares a separate private, hash-bound
continuation plan. It copies existing attempts/receipts and the original expiry,
excludes current terminal/external/uncertain work, protects terminal job rows by
full-row hashes and never replaces an excluded file. The server fence now accepts
an explicitly enumerated nonempty subset of at most twenty files; its runtime
fence and operator must agree on the exact subset size. Empty/malformed/expired
configurations still fail closed. The nine authorized originals, actual subset
and original denominator are separately recorded. An independent watchdog waits
for operator exit, provider drain and private audio cleanup before disabling the
new flags and restoring the original crons. No fleet or Selection expansion.

Executable offline operator/configuration proofs: 16 passed. Full application
suite: 4,493 passed, 14 skipped, zero failures (121.72 seconds).
Native isolated runtime: 132 passed, zero skips/failures, with networking
disabled and no provider requests (8.66 seconds).

The user's additional Oxylabs diagnostic made ten sequential requests to its
official `https://ip.oxylabs.io/location` endpoint: all five configured HTTP slots
and all five corresponding SOCKS5 slots returned HTTP 200 with valid IP replies,
648–2,312 ms, 14,298 total response-body bytes. HTTP and SOCKS5 used the same exit
IP for every matching slot. No provider VOD was requested, and no proxy setting,
credential, affinity or route was changed. The routing/credential environment is
identical to the retained 5 September Gateway and 16 other retained releases.
Two older 2 September configurations differ in routing options; the configured
proxy credential pools themselves were not exposed in this report.

This excludes a general authentication/outage/configuration regression at test
time, not intermittent or destination-specific refusals, throughput issues or
account quota exhaustion. The earlier ten `UND_ERR_ABORTED` events still cannot
be assigned conclusively to Oxylabs without the new per-request diagnostic.
Reference: [Oxylabs ISP connection test and response codes](https://developers.oxylabs.io/help-center/getting-started/start-using-isp-proxies).

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

## Live passive canary preparation — 13 September

The preceding goal turn made production progress: the two explicitly approved
subtitle jobs were stopped through an identity-bound maintenance guard; 276
partial segments were preserved. Commit `9af661b6` deployed the queue-admission
fix, with both permanent cron bits restored and no quarantine reset. Its Build,
Pages and Relay CI checks succeeded. This did not activate the new pipeline.

An authorized real browser baseline then played the previously selected exact
Atlas HU file. First browser frame was 7,830 ms after the click; 203.16 seconds
of media played, with 204 one-second samples, no post-first-frame waiting,
stalled/error/pause events, and zero dropped frames out of 5,082 counted.
The corresponding Gateway session reached readiness in 2,859 ms. The passive
collector was disabled. This is a baseline, NOT a measured collector speedup
or proof of no QoS impact. Test playback was closed normally and its temporary
browser measurement hooks removed.

The actual origin-started session was eligible, with one unknown mapped track
and an observed in-band profile. Its first existing stratified search window is
570.453–630.453 s into the two-hour file: a short opening playback cannot supply
this window unless those bytes have already been received naturally.

A real resume reused the profile, but a fresh origin start renewed its
`probedAt`. Comparing the two private session receipts confirmed that this was
the ONLY changed protocol-2 fingerprint input. A pre-restart static profile
grant would therefore silently miss the canary. Removing the timestamp would
weaken evidence identity, so the correction keeps the full fingerprint intact:

- Optional immutable `passiveTargets` pins at most 20 exact owner/URL/file-key
  triples from the existing pilot file allowlist. It grants no collection.
- A service-bearer-only POST can bind the current ready origin session's
  observed full profile after verifying owner, URL, local output, mapping and
  unknown audio. A stale profile or different source is rejected.
- The resulting exact-profile grant cannot extend the pilot deadline, add a
  file, overwrite a conflicting mapping or exceed 20 grants. Disabled and fleet
  modes reject this canary endpoint. Response/error data contains no identity.
- Granting opens no provider request, causes no seek/restart/inference and does
  not weaken the existing timer, closed-segment, resource or retention gates.

Validation: 4,655 application tests, 4,634 passed, 21 skipped, zero failed;
40/40 native-image cases including real synthetic FFmpeg, no skipped tests,
network disabled, 0.5 CPU, 512 MiB RAM and a 64 MiB temporary filesystem. Five
dormant-release guard tests and ten recovery tests also passed. Native receipt:
`/home/adrien/.norva/passive-live-canary-native-20260913/native-proof.json`.
Browser and private-session summaries are in the local `norva-enrichment-audit-20260913`
directory. The actual live with-collector comparison and adoption proof remain
pending; neither fixture success nor the dormant release closes those gates.
