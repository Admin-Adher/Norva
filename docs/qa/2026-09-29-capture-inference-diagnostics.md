# Capture inference diagnostic gap — 29 September 2026

At 20% metadata/exact-file rollout, natural processing reported LANGUAGE_CAPTURE_INFERENCE_DEFERRED. Main Gateway diagnostics recorded four inference failures after 4.710–5.169 seconds, all UNCLASSIFIED with providerDrained=true. No production failure cause is established yet.

Extend the fixed diagnostic allowlist for strict receipt validation and private workspace integrity errors; include only a fixed set of JavaScript error types. Arbitrary error codes, names, messages, stack traces, URLs and transcripts remain excluded. No changes to retry limits, capture lifetime, inference decisions, provider admission or evidence requirements.

Focused tests: 27 passed, one Linux-only lock test skipped on Windows. Added runtime tests exercise failed local computation with retained encrypted audio, zero provider reads, cleanup and redaction. This is diagnostic preparation, not a claimed fix. Production replay and actual root-cause resolution remain required; keep metadata rollout at 20%.
