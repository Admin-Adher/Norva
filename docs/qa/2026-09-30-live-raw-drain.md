# Prepared Live raw cleanup — 2026-09-30

## Scope and state

Gateway candidate version **171**, implementation commit
`0cf51271284d18a640d8d70f8268bdc3831d6395` (based on PR513's `18fc35ac`).
This document records local and isolated runtime verification. At this checkpoint,
the patch is **not yet deployed** and the two production stale entries have not
been reset or hidden. A guarded rollout and physical-phone replay remain separate.

## Defect reproduced

After two actual TF1 native raw playbacks, the source connection and raw pump closed,
but `playbackPreparationPendingCount` accumulated one entry per playback. Relevant
cloud sessions were `96911bf4-388f-4e89-b883-0f3102123936` and
`aadcfc75-1dc6-4296-a682-4824f6881426`; their preparations were respectively
`515d1716-4479-482e-b6fd-d49a99206274` and
`6644e006-ff7b-44ff-b3e9-be33375941f5`. SQL recorded the sessions expired and
preparations finished, with no FFmpeg, raw pump or active playback remaining.

The previous raw handler propagated AbortSignal to Undici before cancelling its
reader, then cancelled the same unlocked body again in `finally`. A real loopback
fetch reproduced `reader.cancel() -> false` and a second `body.cancel() -> AbortError`
although the HTTP source had already observed disconnect. The registry correctly
retained a negative attestation; its input was the defective double disposal.

The full previous Gateway **170** reproduces the same result with the committed
runtime fixture: exactly one source request, source active **0**, raw pump **0**,
startup admissions/reservations/waiters **0**, but pending preparation **1**, still
present when the bounded four-second verification fails.

## Correction and preserved boundaries

- Maintain one disposal obligation per exact response body; register its reader
  before the first awaited prefix read.
- Start that reader's cancellation before propagating parent or attempt abort.
- Reuse its original result rather than calling `body.cancel()` after reader disposal.
- A rejected, throwing or pending cancellation remains unconfirmed. A later EOF
  callback cannot replace an earlier negative result. Each retry body has its own
  obligation.
- Preserve the unprepared/legacy path, exact owner/session fence, process generation,
  stale capability rejection and existing admission limits.

No exception is accepted merely because its name is `AbortError`.

## Verification

### Node tests

31 passed, zero skips:

```powershell
node --test tests/live-preparation-raw-disposal.test.js tests/live-preparation-gateway-routes.test.js tests/live-preparation-gateway.test.js tests/media-gateway-raw-guard.test.js
```

The new nine tests use actual Node fetch/Undici and local HTTP sockets. They exercise
client-close, parent abort, independent attempt abort, EOF, both abort paths during
prefix sniffing, HEAD with no body, negative/throwing/pending disposal and distinct
retry obligations. Adjacent tests retain the non-final 202 cancellation behavior.

### Full Gateway handler, isolated

Fixture: `tests/fixtures/live-preparation-client-close-runtime.py`.
It runs the real Gateway and synthetic HTTP source in one `--network none` container,
with no production environment, external network, mounted credentials or public port.
Resources: two CPUs, 1 GiB memory, 128 PIDs, read-only root filesystem, bounded tmpfs.

The client closes **before** calling the cancellation endpoint. All six cases pass:

| Case | Observed drain check |
| --- | ---: |
| Close after streamed bytes | 23 ms |
| Close while prefix sniff waits for first byte | 23 ms |
| Close while waiting for response headers | 23 ms |
| Close terminal 403 response with no body bytes | 23 ms |
| Natural EOF | 3 ms |
| HEAD | 2 ms |

For every case, before cancellation API use: one source request total, source active
0, raw pumps 0, preparations pending 0, admissions/reservations/waiters 0 and no
FFmpeg/ffprobe processes. Subsequent exact cancellation returns 200 and `drained:true`;
late raw replay returns 409 without another source request.

These are local cleanup measurements, **not** provider startup or phone latency.

Private receipts:

- `/home/adrien/.norva/raw-drain-20260930/qa/baseline.safe.json`
- `/home/adrien/.norva/raw-drain-20260930/qa/runtime.safe.json`

Fixture SHA256:
`98b9b4ed755d54694890afb9a68d8a3cbc99f6185671d6854a80c9a4ae316096`.
Candidate mounted index byte SHA256 (working-tree newline representation):
`b9848e65cb1c4b85703f165fc4922ae16d51a1fd313eb75ef1fa3725e8d5327c`.
Base runtime image:
`733ed751c108c194bb8ecb3cf4334005181699ba07f884820d1d509ae59a7f63`.
The release builder separately verifies the complete image against exact Git bytes.

Independent review of the code, 31 tests, runtime fixture and receipt was favorable.
No provider playback was initiated by this investigation.
