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
| Capture then compute | Private bounded expiring store, attested drain and account release before inference, durable retry without new download; restart/expiry/lost-ACK tests | Pending |
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
- New executable route tests verify network drain BEFORE local inference and
  retention of the reservation on uncertain cleanup. The **distributed account
  lease is still held through the response** until the capture protocol lands;
  this is not yet the complete capture/compute separation.
- Both Gateway `LANGUAGE_METADATA_LANE_ENABLED=1` and private database flag
  `language_metadata_lane_enabled` are required for activation. They remain off.
  Selection must receive its new capacity-defer client before enabling the
  Gateway gate, so local saturation cannot consume its provider retry budget.
