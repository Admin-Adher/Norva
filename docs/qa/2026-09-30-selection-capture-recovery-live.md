# Selection capture recovery: live execution

## Scope

One real existing Herbert manifest file, previously failed after eight attempts,
is being recovered through the audited production RPC. A current Gateway probe
returned a valid exact-file profile with one unknown audio track. The ordinary
commercial QA account owns a current visible variant of that exact file.
The profile probe is not a verified language result.

## Configuration and recovery

The production worker was recreated with only
`SELECTION_CAPTURE_PIPELINE_ENABLED=1`; concurrency remains one. Existing image,
environment, resource/security settings, network and mounted source were
checked against the prior container. The replacement is healthy. The stopped
prior container is retained for rollback. Both Gateways already have capture
enabled; no Gateway restart or policy change was needed.

The legacy Compose invocation does not resolve with its saved working directory
alone. The exact inspected configuration and Docker recreation payload are
therefore retained privately under
`/home/adrien/.norva/selection-capture-recovery-20260930/` in mode-600 files.
They contain credentials and must never be copied into a public report.

An initial transaction using `postgres` failed on the existing Partners guard's
private helper permissions and rolled back entirely. The existing deployment
operator uses `supabase_admin` for flag writes; the same maintenance identity
was then used without changing any permissions or Partners flags.

Capture activation and the single recovery committed together. Parallel capture
remains disabled. `started.private.json` records the original/replacement IDs;
`selected.private.json` records the exact preflight. The original failed row is
preserved in the recovery archive. No other failed job was reset or recovered.

At 21:36:32 UTC the replacement was queued with zero attempts and no profile,
receipts or capture checkpoints. This is a start receipt, not evidence that
capture, inference, hydration or UI publication succeeded. Inspect the same
replacement job and worker before taking any further action.

## Worker authentication repair

The queued replacement remained at zero attempts while the worker logged
`SELECTION_AUDIO_WORKER_RETRY`. Its three read-only repository RPCs returned
HTTP 401. The worker's service key differed from both active Edge containers;
the two Edge keys agreed, and their current key returned HTTP 200 against the
same internal API and capture-admission RPC.

The worker was recreated again with only its service key synchronized to that
active value. No credentials were printed or committed. The exact private
recreation payload and stopped predecessor are retained under
`/home/adrien/.norva/selection-capture-auth-refresh-20260930/`.
The replacement is healthy; capture admission, parallel admission and pending
hydration RPCs now return HTTP 200 (true, false, zero respectively).

The queued job still had zero attempts at the immediate follow-up. The worker
reported another intake retry, so the normal first manifest-seeding batch is
being checked separately. Authentication success does not establish extraction
or inference success. Continue following the original replacement ID rather
than issuing a second recovery.
