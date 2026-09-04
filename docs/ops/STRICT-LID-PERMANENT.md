# Permanent strict LID

The September 1 strict-publication migration superseded the single-window
ECAPA/sherpa canary. The latter's historical lease was not a lifecycle control
for the active movie/episode pipeline. Do not renew or promote it.

`20260904211500_strict_lid_permanent_supervision.sql` retires its flags and rejects
their accidental reactivation. It retains the policy, audit, attempt history,
audio_lid_enabled, quarantine, provider leases, worker cron and all strict SQL
publication guards. No jobs are enqueued, deleted or unquarantined.

## Inference and fallback

The Gateway uses the already installed, hash-verified native VAD model with the
same full Whisper small engine, auto language and transcript output. It still
requires four diverse agreeing windows and vetoes strong conflicting speech.
VAD is preprocessing, NOT certification or a replacement language classifier.

If VAD/process output fails, retry once WITHOUT VAD on the same local WAVs,
within the ORIGINAL request deadline. An expired budget, abort or viewer
preemption never starts a second attempt. No fallback opens a provider connection.
VAD failures open a five-minute circuit; subsequent requests go directly to full
Whisper. After cooldown a real request can retry VAD. No manual renewal exists.
No cache or persistent transcript/audio storage has been introduced.

Failure of both paths remains a strict failure/pending state; no weak language is
published. Existing sample-order parser, lexical/CJK/diversity rules, signed
receipts, tenant/file binding and SQL finalizer are unchanged.

## Supervision

Existing Ops sweep (15 min) checks `strict_lid_runtime_health` plus the Gateway's
actual `/health` JSON, not mere TCP/HTTP reachability. Missing telemetry is
degraded, never green. Aggregate conditions: worker last completed success less
than five minutes old, expired active job lease beyond 15 minutes, engine runtime
and strict protocol readiness, VAD circuit, recent full-Whisper failure.
`lid_runtime_degraded` routes to Catalogue via existing per-channel incident
deduplication/recovery. No credentials, source identity, transcripts or raw errors
are exposed. Idle/absence of work is not a failure.

## Validation and limitations

Full local suite: 3544 tests, 3536 passed, 0 failed, 8 skipped. Focused tests cover
preserved multi-window proof, failures, same-WAV fallback, deadline, abort,
preemption, circuit recovery and unavailable supervisor inputs.
Migration rehearsed transactionally with rollback; anon execution denied.

Hetzner internal pinned speech fixture (no provider or catalogue writes):
baseline 1452ms, VAD 1395ms; padded speech baseline 1385ms, VAD 1440ms;
missing-VAD-model fallback 1685ms, same English output, circuit open as expected.
The current Gateway already uses Vulkan/Radeon. These measurements show no
significant VAD speed gain, and are NOT an end-to-end provider extraction or
multilingual accuracy benchmark. Do not compare them directly with the old
CPU-only canary or claim universal startup acceleration.

## Deployment/rollback

Use an isolated candidate. Verify current runtime source hashes match its base.
The scoped Gateway overlay reuses the exact deployed image and changes only
index.js, strict-lid-batch.js and strict-lid-inference.js. Preserve all image
binaries/models, environment, ports, mounts, resource bounds and proxy secrets.
Replace only when no real playback, extraction or inference is active.
Preserve original image as rollback. Edge mounts copy the actual deployed
functions; replace only norva-admin and add strict-lid-health.mjs, retaining the
six Telegram routes and all unrelated changes.

A Gateway rollback may leave supervision degraded until its protocol is
restored; NEVER revive retired flags or bypass strict certification to make an
alert green. Close the material batch with the existing observation CAS,
keeping rev16/20% and a full fresh window. The paused Codex automation must not
be silently reenabled.
