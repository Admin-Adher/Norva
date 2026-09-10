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

At this pre-publication checkpoint, the candidate is validated but **not deployed**.
The authorized release must still pass Git publication/CI, idle deployment checks and a small
new internal-account multi-provider pilot through the existing worker. No old quarantines or
pending jobs are manually revived. Pilot outcomes must separate extraction, usable evidence,
window acceptance and final exact-file certification; this small sample cannot prove 99% accuracy.
