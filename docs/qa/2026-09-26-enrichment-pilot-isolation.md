# Enrichment pilot isolation — 26 September 2026

## Production observation

During the bounded Selection capture trial, ordinary Dino language jobs outside the immutable pilot manifest were deferred with `LANGUAGE_ENRICHMENT_CAPACITY_BUSY`. The original Gateway was restored and temporary capture approval revoked. Global accelerated capture remains disabled.

The metadata flag attached a strict pilot admission callback to legacy probe and language routes. Its file assertion rejected unrelated baseline jobs. Explicit capture should reject such files; ordinary legacy jobs should keep their existing admission path.

## Correction

- Legacy probe and both legacy language entry points use the new lane only for admitted pilot files. Expired or unrelated pilot files retain baseline playback/extraction guards.
- Explicit capture retains strict admission; no fallback authorizes out-of-scope or expired captures.
- Fleet mode still applies shared network limits to all files.
- Early provider drain before inference requires an actual network lease, preserving baseline broker lifetime when no new lane was entered.

## Local verification

Six focused suites: 143 tests, 141 passed, zero failures, two skipped. These cover pilot isolation, metadata admission, provider broker behavior, capture handoff and network handoff. Behavioral cases include exhausted pilot capacity, expired manifests, same-account serialization and foreground/background reader exclusion for unrelated probes.

This is not a production replay or a mobile startup measurement. Deployment, production isolation replay and multi-track capture completion remain to be verified.
