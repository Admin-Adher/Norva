# Adaptive language admission — 11 September 2026

## Scope

Separate user-requested strict language checks from automatic catalogue work.
This changes admission and diagnostics, not the speech method or certification.
No model changes, external AI calls, quarantined-job renewal, historical audio
deletion, credential changes or new provider cron are included.

## Policy

- Manual: retain two outstanding requests and 20 starts per Norva user per
  rolling 24 hours. Automatic jobs no longer spend this budget. Server RPCs set
  the origin; it is not a client parameter. Ambiguous historical rows stay
  `legacy`; their outcomes, timestamps and receipts are not rewritten.
- Automatic: no daily start ceiling. Keep a buffer of at most four outstanding
  jobs per provider identity, and 32 automatic/legacy outstanding jobs globally.
  These are buffer bounds, not promised daily throughput. Source-local identities
  stay private until the existing provider-identity proof permits cache sharing.
- Execution: at most two simultaneous language tasks across both Edge replicas,
  including exact-file intake probes. Running unexpired job leases and leased
  intakes share an atomic admission lock. Queued/retry-wait jobs do not consume
  execution capacity. Provider-account and provider-identity leases still guard
  actual network access and are released only under the existing drain rules.
- Capacity: sample cgroup CPU usage against the container quota, memory usage
  against the container limit, and host load every five seconds. Reduce admission
  from two to one at 60% CPU, 75% memory or 70% normalized host load; pause at 80%,
  85% or 90%, respectively. These conservative starting guards are **not** a
  server throughput benchmark and do not increase container CPU/memory limits.
- Foreground viewers/startups and foreground inference work pause new background
  admission. Existing viewer preemption still wins races after admission.
  Missing/malformed/stale telemetry fails closed. Samples expire after ten
  seconds in SQL; a delayed older report cannot replace a newer one.
- Manual jobs are selected first within provider lanes. An identity with an
  unexpired running job is skipped by the due-job selector. Existing per-minute
  retry batch size, model concurrency, retry delays and attempt ceilings remain.

## Probe diagnostics

`probeCodecProfileUncached` now counts thrown ffprobe errors on all call paths,
not only the playback catch. Timeout, access denied, file unavailable, malformed
media/response, transport and runtime failures have safe categorical codes.
Existing provider-busy 458, proxy authentication and viewer-preemption codes stay
authoritative. Raw stderr, URLs and credentials are not published in diagnostics.
No error is converted into a successful language result or an extra retry.

## Validation and rollout

The release operator first tests the installed production function definitions
against a networkless, memory/CPU-bounded synthetic PostgreSQL fixture. It checks
more than 20 automatic admissions, independent manual quotas, queue bounds,
capacity freshness, lease renewal, privacy/ACLs, preserved quarantines and four
concurrent SQL callers competing for exactly two worker slots. This is a control
plane proof, not a language-accuracy or production-throughput measurement.

Stage retains all unrelated Edge functions and derives the Gateway image from
the exact live image, replacing only the three reviewed JavaScript modules.
Whisper/VAD hashes, environment, Docker limits and unrelated feature flags are
checked before and after. The original containers and trees are retained.

Migration creates `adaptive_language_admission_enabled=false`; new automatic
admissions pause until Gateway and both Edge replicas have passed health/hash
checks and the final explicit `enable` phase. Existing evidence is not reset.
Strict worker claims also wait for fresh capacity telemetry during the rollout;
existing lease renewals and foreground playback are not disabled.
The operator's immutable inputs and private receipts live under
`/home/adrien/.norva/lid-adaptive-quota-20260911`.

For a safety stop, set `adaptive_language_admission_enabled=false` and retain the
capacity-aware code; this pauses new automatic admissions without restoring the
old shared quota. Do not run a destructive down migration or reclassify history.
Container rollback is a separate operator decision; a future broader rollback
must first pause intake and preserve the new schema and existing evidence.
