# Strict CJK receipt evidence — 2026-09-30

## Reproduced defect

The CJK range regex counted punctuation, combining marks and unassigned code points,
but the density denominator counted only Unicode letters. An ordinary synthetic
Japanese sentence containing a middle dot produced accepted evidence with density
1.0238095238095237; the authenticated receipt then rejected it as
`STRICT_LID_WINDOW_BINDING_INVALID`. Separately, 31 kana letters plus a middle dot
incorrectly crossed the minimum of 32 script characters.

The fix intersects script ranges with Unicode letters before all CJK character,
diversity and density calculations. It does not clamp values or relax evidence.
Invalid numeric evidence now reports `STRICT_LID_WINDOW_EVIDENCE_INVALID`;
invalid binding numbers retain `STRICT_LID_WINDOW_BINDING_INVALID`.

The runtime configuration fingerprint advances `cjkEvidenceProtocol` from 1 to 2.
AEAD envelope format remains v1. An old-policy receipt cannot authenticate under
the new fingerprint. The existing Gateway 409 and Edge lease/track/window CAS
reset path handles incompatible receipts; no manual job, budget or quarantine
reset is part of this change.

## Verification

- Three new regression cases failed before the production code change.
- 96 tests passed across strict batch, adaptive wiring, window checkpoint, window
  route and capture handoff suites.
- 30 additional Edge language-validation contract tests passed. The adaptive
  wiring suite was rerun after adding the old/new authenticated receipt test.
- The real evaluator plus real receipt encryption/decryption accepts the natural
  Japanese sample and still cannot certify a track from one window.
- Tests keep 31 letters plus punctuation insufficient, exclude combining marks
  and unassigned range points, prevent punctuation from inflating mixed-script
  density, and keep all numeric bounds strict.
- Independent review: no blocking finding; `git diff --check` passed.

## Production diagnosis and limits

Read-only diagnostics identified repeated `STRICT_LID_WINDOW_BINDING_INVALID`
after local inference, with the provider connection already drained. This error
code alone does not establish a broken file binding: before this fix it also
covered invalid numeric evidence.

The older quarantined target reached quarantine immediately after a provider
HTTP 502; its retained capture has expired. No transcript or stored numeric
evidence proves that its earlier inference failures were caused by this CJK
defect. A different deferred job still had one encrypted sixth-window capture
when inspected. Offline attribution, deployment and natural job outcome are
separate from the local regression proof above.

No provider stream was started, no production setting changed, and no job or
attempt budget was reset during this diagnosis and correction.
