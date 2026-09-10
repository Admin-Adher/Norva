# Strict LID adaptive evidence — 2026-09-10

## Scope and unchanged safeguards

Gateway v167 adds a bounded no-VAD second pass on the **same local WAV**, only for weak or
insufficient initial evidence. It returns one evaluated result per file window. A credible
cross-pass language conflict is an authenticated veto, not an opportunity to select the higher score.

Durable window extraction searches at most 60 seconds around each existing anchor, within its
own disjoint temporal stratum. The pinned CPU Silero selector chooses one contiguous 20-second
clip by speech occupancy, before language inference. Failure/absence falls back to the original
anchor. Actual sample duration and selection coordinates are checked; no padding or splicing.

Diagnostics distinguish real decoded duration, levels/silence/clipping, measured speech,
word/unique-word evidence, quality fallback and conflicts. Unavailable speech measurement is
`null`, not zero. Logs contain no transcript, provider URL, credentials, account, file key or receipt.

Four independent qualifying windows, probability >=.95, transcript/diversity floors, conflict
vetoes, exact-file/account binding, viewer preemption, 225-second request ceiling, normal worker
retry/quarantine and the 99%/200-file rule-learning decision are unchanged. No migration or
Edge modification is needed. Updated policy/runtime digest prevents mixing old/new receipts.

## Validation before publication

- Windows full suite: 4,139 tests, 4,128 passed, 10 skipped, one existing CRLF-sensitive
  `android-notification-ci-evidence.test.js` file-level failure (unrelated workflow parsing).
- Focused suite: 216 tests, 215 passed, one opt-in real-binary test skipped locally.
- Exact Linux candidate, Node20.20.2/Undici7.29.0, external network disabled: **207/207 passed**,
  including actual Silero on the pinned upstream public JFK fixture, synthetic silence and
  a too-short PCM extraction. These are detector/mechanics tests, not language certification.
- Operator tests: 12 passed; stage creates an image only, deployment requires a separate real
  VAD proof and checks every playback/extraction/inference idle gate before replacement.

Build helper source: `ggml-org/whisper.cpp` commit
`080bbbe85230f624f0b52127f1ae1218247989f9`, target `whisper-vad-speech-segments`.
Binary SHA-256: `0b12f515952eef67d7e4361d051e3311fdd4d13761168de80a4a2f03459215d3`.
Candidate image: `norva-media-gateway:strict-lid-adaptive-evidence-20260910-candidate-1`.
Existing Whisper model/binary, container environment and mounted data are preserved.

The standalone CLI reports centiseconds; the parser converts to seconds, validates cardinality
and bounds output. VAD is CPU-only/two threads/8 seconds maximum and joins the viewer-priority
process ledger. Its budget comes from the existing request ceiling, not an added deadline.

## Production and real-provider pilot

- Published gateway change on `main`: `4b410072465819070c9e3b5f1ed680bca9c217b2`.
- CI `Verify cloud contracts` succeeded, run `34522088450`, job `103021828284`:
  **4,157 tests, 4,147 passed, 10 skipped, zero failures**. Region/locales/syntax passed too.
  Web and Relay deployments succeeded. Android/Windows packaging is separate from gateway proof.
- Candidate v167 deployed after every idle gate passed. All six module hashes, helper hash,
  sampler runtime, original Whisper runtime, environment, Docker configuration and mounts verified.
  Original v166 container retained for rollback; no schema, flag or queue configuration changed.
- Production normalized `index.js` SHA-256:
  `fa92a6c95557ac753131396d98af79396f03c9dcbeac9a1b9a76c76bb461c812`.
- Eligibility audit: 86 new exact files across four providers and three active internal accounts,
  each with one unknown audio track and a gateway profile less than 48 hours old.
- Pilot enqueued **three new files on three providers** using the normal tenant-fenced RPC.
  No previous jobs/quarantines were reset or retimed. All three completed six windows before
  20:00 UTC, with six provider attempts each and no quarantine. All 18 retained receipts were
  authenticated using the deployed binding and real current time; expiry was never bypassed.

| Internal sample / distinct provider | Accepted windows | Weak | Insufficient | Speech selection / anchor fallback | Final decision |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 3 EN | 1 | 2 | 3 / 3 | Pending: three qualifying windows, below four |
| 2 | 4 FR + 1 EN | 0 | 1 | 6 / 0 | Pending: conflicting accepted languages |
| 3 | 2 EN | 0 | 4 | 4 / 2 | Pending: two qualifying windows, below four |

These are model/evidence classifications, not independently human-verified ground truth.
No repeated-evidence or missing-diversity rejection was found in these receipts. **Zero of
three files was newly certified in the shared cache**; the existing next-day retry policy remains.
The pilot validates the collection/selection/checkpoint mechanics, not a certification-rate gain.
Thirteen windows used speech selection; five retained their anchor after zero detected speech.

Since gateway restart, two quality fallbacks ran, with zero recovered qualifying samples,
zero fallback conflicts/failures and zero fallback budget exhaustion. These counters are global
and must not be individually attributed to the pilot. The bounded global diagnostic read found
18 selected audio preparations and no invalid-audio/preparation timeout/failure events.

Final gateway check: v167 healthy, runtime and speech sampler verified, zero active brokers,
WAV extractions, inference processes, viewers, pumps or queue work. All CI packaging jobs for
the gateway-code commit also completed successfully; this is not an Android device proof.

Early waiting was not an extraction failure: one provider's normal five-minute catalogue-refresh
protection expired, then the bounded scheduler resumed it naturally. No stale blocking lease or
active viewer was found by the targeted audit. The other provider's historical activity type
was already replaced in the ledger and cannot be reconstructed with certainty.

Final operator verification: 220/221 focused Node tests passed (one opt-in binary smoke skipped
locally, already passed in the exact Linux candidate), 12 deployment tests and seven read-only
proof tests passed. The packaging test now normalizes Windows CRLF without changing runtime code.

Reproduction: use the adjacent `check-strict-lid-adaptive-evidence-batch-20260910.py` and
`read-strict-lid-adaptive-evidence-proof-20260910.py` operators. Never replay a start intention,
reset an old job or backdate receipt opening. The final sanitized local snapshot is
`norva-adaptive-evidence-live-proof-20260910.json`; it contains metrics, not tokens/transcripts.

Pilot outcomes must separate extraction, usable evidence, window acceptance and final exact-file
certification. This small sample cannot prove 99% accuracy or generalized throughput improvement.
