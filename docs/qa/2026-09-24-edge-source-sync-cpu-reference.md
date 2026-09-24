# Edge source-sync CPU reference — 24 September 2026

The running Edge `main/index.ts` has a source-sync-specific CPU policy absent
from the repository. It keeps normal worker reuse, sets a 10-second soft CPU
limit and a 120-second hard CPU limit for `norva-source-sync`, and leaves the
other functions on their existing defaults. This protects the bounded
Xtream discovery and import-finalization loops from a premature isolate
retirement before they checkpoint and hand off. Rebuilding the old Git
dispatcher would remove that production behavior.

The production dispatcher was read again from the shared mount used by both
Edge replicas. Its SHA-256 is
`30d8acdd483ee23833055894b1e8801aaff5923fa4a3398a50bf45fba59d3cb9`.
The versioned file now matches those exact bytes. Its TypeScript parsed with
esbuild, and a focused contract test verifies the source-sync-only policy,
bounded values, reuse setting, and application at worker creation.

This change records current production code; it does not redeploy Edge or
establish a new import-speed result. MAX OTT and Dino finalization and
ordinary-account first-playback timings remain separate QA requirements.
