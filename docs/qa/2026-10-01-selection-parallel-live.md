# Selection parallel admission: real-file trial

## Scope and starting state

At 2026-09-30 22:55 UTC the production Selection worker was healthy, capture
enabled, concurrency one and parallel admission disabled. The durable queue had
193 completed and 522 exhausted historical failures, with no active work.
The previous status-only turn did not advance the goal; this trial does.

Two distinct audited feeds were selected from eligible historical failures:
Herbert (`De Ladrón A Policía (1999)`) and Klysmgt (`TNTS1`). Fresh Gateway probes
succeeded in 8,303 ms and 8,179 ms. Each returned one AAC stereo track with no
declared language. The current-file owner RPC found 37 owners for each file,
including the ordinary commercial QA account. No provider URL or credentials
are included in this report.

## Controlled activation

The reviewed worker code was not changed. Its exact Docker configuration was
cloned, changing only `SELECTION_AUDIO_CONCURRENCY=1` to `2`. Image remained
`sha256:f8b2141c332d051333d0d7332227d0d6af1971b5e286a94252e0c6287d95eeb6`.
The old container is retained for rollback. The replacement is
`38851563aba8ba439b414550c064df07af8dece59437021ada8a5ca4197687b8`.
The flag stayed off during this idle-only configuration change.

At 22:55:42 UTC, parallel admission and exactly two audited recoveries committed
in one transaction using the existing global claim advisory lock. Repair
revision: `16029b54007b870729b297a08959caf60b8de160`. The recovery RPC archived
the old eight-attempt histories; it did not reset or bulk-requeue other files.
The two new jobs retain the normal bounded retry budget and once-only recovery
rule. Network admission, drain requirements and viewer priority were unchanged.

Private operational evidence is retained under
`/home/adrien/.norva/selection-parallel-20261001/`: `preflight.private.json`,
`started.private.json`, `worker-config/` and `observations.safe.jsonl`.

## Observed result so far

The Herbert file completed six capture windows and verified Spanish on its first
counted attempt. Publication to 37 owners completed; hydration was acknowledged
by 22:58:13 UTC.

The Klysmgt job initially received four safe capacity refusals at the **probe**
stage. Its attempt debit was refunded each time, leaving attempt count zero.
It began processing when the first analysis finished and had one durable window
by 22:58:33 UTC. This does **not** prove parallel analysis throughput.

The actual code reserves generic FFprobe acquisition as opaque network work:
it cannot overlap existing provider I/O because its redirect targets are not yet
reserved. Capture separately drains before local inference. The observation
therefore identifies initial profile acquisition/admission as the next scheduling
investigation; removing network fences or resetting jobs would not solve it safely.

The gateway reported no active viewing sessions during these samples. Real
viewer preemption under this two-file workload has **not** been demonstrated.

## Regression evidence

27 tests passed for task pooling, actual SQL admission, owner/generation/URL
fences and audited recovery (40 SQL assertions; no skipped tests).
42 additional handler tests passed for capture handoff, confirmed network drain,
deferred background work and foreground priority. These are controlled handler
tests, not a real viewer replay.

## Bounded trial closed; existing recovery still pending

The Klysmgt job subsequently retained **three** durable windows, then entered
`retry_wait` on attempt one. The Gateway log identifies `stage=store`,
`providerDrained=true`, no upstream HTTP error, and an unparseable extracted WAV
(`audioMilliseconds=[null]`). The public worker diagnostic reports capture/502;
this is not evidence of a provider HTTP 502. The lower-level WAV parser code is
currently absent from the safe diagnostic allowlist and appears as UNCLASSIFIED.
Do not infer an expired provider account or label its audio language from these
incomplete results.

Parallel admission was restored to **false** after this bounded trial. Capture
remains enabled; the worker has a maximum configuration of two but its effective
DB admission is back to **one**. No jobs, attempts, profile evidence or captures
were reset. The existing Klysmgt job is
`d7da9e0d-c694-46a5-b01c-768e1c274e2c`, with its next normal attempt due at
**2026-09-30 23:04:20.586863 UTC**. A fresh database read at 23:00:48 UTC confirms
that state. Its worker daemon is running, not an abandoned shell process.

The 120-second observation process completed normally; it is not the analysis
job. Reinspect the same durable job after its scheduled attempt. Do not infer
terminal failure from an observation timeout or start a replacement analysis.

Next diagnostic: recover the exact safe WAV-validation failure from a normal
retry (or add narrowly allowlisted diagnostics), then assess actual file duration
and extraction boundaries. Initial opaque probe admission remains a separate
parallel-throughput constraint. Neither is resolved by this trial. Real viewer
preemption and successful overlapping capture/inference remain unproven.

## Diagnostic repair deployed

The second normal attempt failed at the same fourth window, retaining all three
receipts. Its next retry is 23:14:28.737266 UTC; no attempt was brought forward.

PR #521: `0bea90d37c770059f623e2b2e18905a947bca0ae`, merged as
`91b6d01b8c14fd95bc6b52a6acbc312cd1b80f10`. Build 36788999343 succeeded.
The change adds only literal WAV-parser failures to the internal diagnostic
allowlist. Four malformed WAV fixtures exercise the actual parser/storage path
and confirm provider drain, no retained invalid audio, no inference and no
private diagnostic text. Windows: 28 pass, one Linux-only skip. The isolated
Linux candidate image passes **29/29**, including the real ownership lock.

The complete image is
`sha256:74c0c8fd18b53ef1b1ceeb411251a0e424be3a3da49f31caca72678b7c83e87e`.
It was built and checked without network access or production configuration.
Both production Gateways now use that image, after idle guards, at 23:08:42
(pilot) and 23:09:11 (main) UTC. An initial main invocation erroneously included
the pilot-only mount flag; the operator rejected it before mutation. The corrected
main invocation succeeded. Environment, mounts and protocol version 171 remain
unchanged. This diagnostic-only change does not weaken WAV validation.

The persisted Compose image pin was updated at 23:09:22 UTC, verified as the
only rendered configuration difference. Override SHA256:
`388aef80d5a4178fa3cf40edc9cc64a3c4c867508e90a1034cf1888610cd7bc2`.
At 23:09:44 both nodes were healthy and idle; all 76 source files and two
dependency manifests match the candidate archive (dependency line endings
normalized). This is archive provenance, not a claim about raw Git line endings.

Image, isolated checks and postdeployment receipt:
`/home/adrien/.norva/selection-wav-diagnostics-20261001/0bea90d37c77/`.
Runtime rollout receipts:
`/home/adrien/.norva/gateway-reference-rollout/20260930T230842681972Z/` and
`/home/adrien/.norva/gateway-reference-rollout/20260930T230911745411Z/`.
The automatic job retry is still needed to identify the real malformed output;
these tests do not establish its root cause or fix the media acquisition.

## Third normal attempt and follow-up

The same job resumed at 23:14:30 UTC, again retained its three prior windows,
and returned to retry_wait on attempt three. The new diagnostic proves
`STRICT_LID_AUDIO_INVALID_DATA`: a WAV with no valid data samples, not an HTTP
502 from the supplier. Next scheduled attempt: 23:34:40.670938 UTC.
The observation process (exec 50803) is now terminal; the durable job is not.

A separate normal, admitted `/probe-audio` request returned 200 with confirmed
provider drain: MOV/MP4 container, duration 7,120.15 seconds, size 702,299,602
bytes, one stereo AAC track at 44,100 Hz. The exact per-track duration and the
reason for the empty fourth window are not yet known.

Code inspection found an independent error-propagation defect: the capture
adapter checked `broker.terminalError` only when FFmpeg reported failure.
A zero exit with empty or partial output could therefore hide an authoritative
provider/range failure behind WAV validation. The pending correction checks
viewer preemption first, then the broker's terminal error, before accepting an
FFmpeg success. A test executes the actual adapter for zero/nonzero process exit,
conflicting preemption and a valid success; an errored input never reaches the
audio read/storage stage. This is not yet proof that the live file's broker had
a terminal error. Its next normal retry must resolve that question.
