# Enrichment: input waits and passive readiness diagnostics

## Scope

This lot instruments the existing bounded MKV input pump and avoids allocating
a passive scratch workspace before the planned speech window has arrived in
the player's local segments. It does not enable passive collection, add a
provider request, alter proxy routing, change playback buffering, or relax
language verification, quarantine, account or global acquisition limits.

`vodInputProgress` separates the time spent awaiting provider open/read/close,
downstream writes, retries and finalization. It reports fixed counters for
received/preloaded/forwarded bytes and opened/reopened ranges. Timings describe
the existing pump's waits, not measured wire throughput. Preopened-header costs
remain in the existing startup diagnostics. Public session responses do not
include these metrics; the existing authenticated debug route and a final
sanitized log record do. The latter contains a hashed session key, no URL,
credentials, account ID, title, transcript or audio.

Passive misses use fixed internal reason codes. A future window is reported as
`window-not-ready`, not a speech recognition failure. Private workspace
creation waits for that window; reservations, source/profile matching, process
closure, resource admission, retention and adoption constraints remain intact.

## Why this is not a QoS acceptance

The earlier one-file Atlas HU canary had three post-first-frame interruptions,
before any passive extraction occurred. Its first planned speech window had
not yet arrived. No causal attribution to collection is supported. This lot
adds the missing diagnostic separation; it does not claim that the interruptions
are fixed or that fleet activation is safe.

## Validation and deployment gates

- Both full-suite runs passed 4,639 tests, with 21 skipped and zero failures.
  The second run includes the synthetic fixture's resource correction (104.59 s).
- Nine offline Python operator tests cover ownership/source/runtime checks,
  rejection of failed native evidence, dormant-only configuration, exact archive
  scope, binary fixture preservation, capacity guards, network isolation and
  stopping only the owned synthetic test container if a viewer arrives.
- Native run 1: 150 cases, 149 passed, one failed while generating a synthetic
  MKV (`pthread_create failed`). The evidence is retained.
- Native run 2: 150/150 passed, no skips, using the exact deployed Linux image,
  network disabled, 0.5 CPU, 512 MiB RAM, 64 PIDs and a 64 MiB tmpfs. The fixture
  generator now explicitly limits its filter thread pools and test CPU count;
  production FFmpeg arguments are unchanged. [FFmpeg thread-pool options](https://ffmpeg.org/ffmpeg.html#Main-options)
- Native source hashes: `index.js`
  `7f9447cd5434cf15f8c47efb73aa0a9c69d0088fe5a4128427aedf98eca3e78c`;
  `passive-lid-capture.js`
  `5f0b156ef1bdc56ab192a87701c3347ce30e9014c23c3ad5f78fc97fdb30cb21`.

The deployment operator accepts only that passing native proof and the matching
two-module archive, builds from the exact live image, and uses the unchanged
idle-only retained-container recovery supervisor. No subtitle-stop override is
present. It preserves previous successful and failed evidence and restores the
two recorded cron states. Publication, deployment and real playback acceptance
must each be recorded separately after completion.

Native proof: `/home/adrien/.norva/passive-qos-diagnostics-native-20260913-r2/`.
Deployment attempt: `/home/adrien/.norva/passive-qos-diagnostics-20260913/`.
The prior native attempt and negative live canary must not be overwritten.

## Full objective still pending

Do not equate this dormant diagnostic release with the complete enrichment
pipeline. Actual passive extraction/adoption with playback QoS, an eligible
Selection feed/host trial, real multiple-unknown-track acquisition, and
controlled fleet/new-provider activation remain to be demonstrated. The
metadata-first lane, exact-file reuse and positive provider drain must retain
their existing integration constraints throughout that validation.
