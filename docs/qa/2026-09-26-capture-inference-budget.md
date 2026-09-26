# Captured audio inference budget — 26 September 2026

## Production observation

The naturally queued Dino job `f67ae772-4dd8-4987-b4d3-55be6c7a5c9a` entered the 50% capture cohort without a pilot grant. Its first capture took 12,764 ms and attested provider drain. Local inference then failed repeatedly at approximately 50,044 ms; the Gateway's quality-fallback failure counters increased. The job retained its first encrypted capture and retried inference with its provider-attempt counter unchanged at seven. No window had completed at the latest observation.

This identifies the fixed local inference deadline as the immediate failure boundary. It does not prove that a longer budget will successfully classify this file. The rollout remains at 50%; no 100% activation is justified by this observation.

## Proposed correction

- Bound local capture inference to 100 seconds, including sample preparation and the existing full-model quality fallback.
- Align the Gateway request deadline to 105 seconds and Edge fetch deadline to 110 seconds, still capped by the existing worker task deadline.
- Retain playback preemption, provider release before inference, strict evidence evaluation, access/profile checks, and encrypted capture reuse.
- No changes to the playback startup path or provider extraction timeout.

## Verification

Focused Node tests: 77 passed, one Linux-only test skipped on Windows. The new test executes the production capture inference callback with the real strict-inference coordinator and simulated model durations: five seconds of preparation, twenty seconds for VAD inference, sixty seconds for full-model fallback. The strict accepted result completes at 85 simulated seconds. Existing cancellation, timeout, conflicting evidence, drain and capture reuse tests pass.

This is not a real-media performance measurement. Integration, deployment and replay of the affected production job remain pending. Do not claim the issue resolved until runtime replay succeeds.
