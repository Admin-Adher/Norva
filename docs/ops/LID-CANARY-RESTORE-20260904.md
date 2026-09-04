# LID canary: expiry incident and bounded restoration

Verified 2026-09-04, 20:42 UTC. Operator request: investigate deeply and correct the
expired LID fast path while preserving smooth playback. This was a configuration
repair using existing RPCs, not an application/worker redeployment.

## Cause

The explicit seven-day lease expired on 2026-08-28 06:59:05.123686 UTC. Last
renewal was August 21. There is deliberately no unconditional renewal cron.
Both deployed Edge replicas reported `lidCascadeHealth=expired` and
`lidCascadeMode=conflict`; this was not a stale Telegram incident or failed worker.
The alert must not be suppressed to hide that state.

## Evidence before correction

- LID worker image `norva-lid-worker:2`, healthy, restarts 0, protocol 2,
  calibrated policy `lid-cascade-v1`; all four engines ready; queue idle.
- Calibration unchanged: revision `norva-shadow20-canary-20260720-r1`, ECAPA
  probability >=0.98, margin >=1, entropy <=0.5.
- Since August 21: 25 recorded attempts, no errors; 9 fast-consensus writes,
  5 Whisper-tiebreak writes, 7 no-speech pending and 4 disagreement pending.
  Fast-consensus inference mean 957 ms; this excludes provider extraction and
  is NOT an end-to-end playback or accuracy measurement.
- Gateway v165, image `norva-media-gateway:vaapi-fac9d36b`, healthy, restarts 0,
  activeSessions 0, activeStrictLidBrokers 0.
- Both Edge replicas retain provider-attempt/viewer-preemption protocol 1,
  four consecutive no-progress attempts and 300-second failure backoff.
- Incident job `5df2bccb-cae4-47fb-97f1-95c1efdc95b3` remains failed/quarantined,
  attempt_count 135, lease_owner null. No job was resurrected or deleted.
- Validation leases 0; one live file-probe lease existed independently. It was
  left untouched. Tests opened NO provider connection.

## Internal inference tests

`ops/hetzner/scripts/lid-canary-smoke.py` sends bounded WAV bodies directly to the
authenticated internal worker. It does not call Edge enqueue or persist RPCs.
The official Whisper JFK fixture is pinned to commit
`080bbbe85230f624f0b52127f1ae1218247989f9` and SHA-256
`59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`.

| Test | Result | Wall time |
| --- | --- | --- |
| English speech, canary | en, whisper-tiebreak, no full transcription | 5757 ms |
| Ten-second silence | pending-no-speech, language null | 36 ms |
| Same speech, shadow including full baseline | en, full baseline ran | 15542 ms |

Whisper full baseline alone took 10130 ms within the shadow run. Worker queue
ended idle, completed 209, failed 0. All results had verified=false and
persisted=false. These are internal functional checks, not proof of universal
multilingual accuracy or sub-second provider extraction.

Focused local suite: 20 passed, 0 failed (production worker, lease reliability,
gateway WAV extraction). Includes calibration, confidence, lexical safeguards,
bounded queues, signed sample scope, idle/account guards and buffer destruction.

## Production transaction

One-shot SQL: `ops/hetzner/scripts/lid-canary-restore-20260904.sql`.
Expected old expiry/cohort/cap and quarantined job are checked before mutation.
Existing renewal RPC validates all rollout flags and safe bounds. The existing
Provider Access CAS RPC atomically invalidates the predecessor and starts one
full observation; the rollout stage/revision are not promoted.

The first transaction aborted on the observation RPC's service-role guard;
rollback was verified (lease still expired, audit row 4 absent). The corrected
transaction explicitly assumes service_role for that RPC and committed:

- Renewal audit ID 5; cohort still 1000 bp (10%), cap still 60/day.
- Expires: **2026-09-11 20:41:20.508532 UTC**, 22:41:20 Paris.
- Predecessor `783ef466-1485-4274-bd20-dfd6c89f0559` stale MATERIAL_CHANGE_RESTART.
- New observation `db577813-ee6e-4986-a7a2-4cc8731ba27d`, rev16, 20_percent,
  collecting, minimum 86400 seconds, baseline qualifyingActivity=0, P0=false.
- not_before **2026-09-05 20:41:20.510786 UTC**. No early acceptance/promotion.

## After correction

Both actual Edge replicas report active/canary, protocol2, configured worker,
the new expiry and unchanged cap/cohort. Ops sweep reports problems=[],
recovery_pending=false. Telegram accepted Catalogue recovery for the
lid_cascade_expiring and lid_cascade_expired incident keys. Old chat messages are
historical; none were deleted.

## Remaining operational boundary

This is a bounded reactivation, NOT permanent primary rollout or automatic
unlimited renewal. Existing Ops warning starts 24 hours before expiry, so the
next review is required by September 10 at 22:41 Paris. Review fresh worker
readiness, inference, recent errors, exact-track persistence and viewer
priority before the next explicit renewal; keep fallback and uncertainty.
Never run the one-shot repair again to slide the deadline: expected-expiry CAS
rejects it. Use a newly reviewed operation for the next renewal.

The Codex Provider Access automation was already PAUSED with stale historical
instructions; it was not reactivated. Its prompt must be refreshed from live
state before any future resume. No claim of continuous autonomous monitoring
is made. No code, provider credentials, tagged-language writes, primary flag,
payments, campaigns or Telegram routing configuration changed.
