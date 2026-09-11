# Enrichment pipeline implementation ledger

Base: `d86db0e13871f8d5b43d9faf67516b6b2cd0a969`. Isolated worktree;
the user's original checkout is not part of this release.

The objective covers **all five workstreams** below. A unit-tested helper or a
disabled route is not an end-to-end completion. No production activation or
throughput improvement is claimed by this document.

| Workstream | Required implementation and evidence | State |
| --- | --- | --- |
| Fast metadata lane | Independent admission, bounded continuous batches, exact-cache reuse, preserved account locks; SQL contention and stop/permission tests | Implemented, isolated tests pass; production gate pending |
| Mutualized input | Bound header/range reuse, one input for multiple unknown tracks, file-change invalidation, independent temporal evidence; fake-provider byte/connection counts | Pending |
| Capture then compute | Private bounded expiring store, attested drain and account release before inference, durable retry without new download; restart/expiry/lost-ACK tests | Gateway + Xtream/episode worker integrated locally; Selection client and live acceptance pending |
| Passive playback capture | Only bytes already received, non-blocking/drop-on-pressure, no second provider request, no implicit phone upload; playback/backpressure tests | Pending |
| Authorized parallelism | Trusted Selection feed + host policies, prudent unknown-provider default, account vs file identity separation, bounded adaptive feedback; mono-session and refusal tests | Pending |

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
  ciphertext budget. No VOD, URL, credential, or transcript is in the journal.
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
