# Telegram operations audit — 2 October 2026

## Scope and observed messages

Read the owner's six Norva bots in the authenticated Codex Telegram browser.
Initial unread badges: Infrastructure 382, Catalogue & Lecture 378, Croissance
47. These are accumulated unread messages, not 807 simultaneous incidents.
No history was deleted, no bot was muted and no customer campaign was sent.
Reading conversations naturally changes their unread badges.

- Infrastructure: repeated six-hour capacity checks, historical mail delivery
  warnings and cron failure/recovery pairs.
- Catalogue: historical incomplete-source warnings, followed by frequent LID
  fallback/recovery pairs. A few actual Whisper failures also exist historically.
- Growth: wrongly routed infrastructure/catalogue warnings as well as genuine
  signup events. Support, Partners and Finance show only September 4 routing
  tests in their visible histories; this alone cannot certify their delivery.

## Causes and corrections

1. Both active Edge containers had only the legacy Telegram credentials, pointing
   to Growth. The six dedicated routes and strict mode existed in the protected
   stack environment but were missing from its older Compose definition.
   Verified all six bot identities through read-only Telegram getMe. Restored
   the dedicated variables on both replicas, retaining the existing recipients.
   Also reconciled the persisted functions mount with the actually running
   October 1 directory so recreation does not restore an older release.
2. LID fallback generated alert/recovery loops. Its first warning remains; its
   reminder is now daily and recovery requires 30 continuous healthy minutes.
   A real engine/baseline failure has a separate key, bypassing fallback cooldown.
   Cron recoveries also require 30 stable minutes; immediate outage alerts and
   existing six-hour critical reminders remain. Existing source warnings now
   remind daily. Delivery acknowledgement remains separate for each channel.
3. Capacity message identity included fluctuating numbers and the footer. For
   WAL/growth/cost warnings, daily deduplication now uses condition and severity
   bands. A new condition or a doubling band alerts immediately. Backup failure,
   low disk and other critical warnings retain their conservative transport.
4. Mail-monitor signatures included every counter value; a draining dead-letter
   queue could notify for each decrease. Signatures now use affected counter
   names. Dependencies and new affected queues remain visible.
5. The facet/genre refresh batch rolled back all owners when one owner's catalogue
   epoch changed. Each owner is now isolated; only the exact expected visibility
   serialization failure is deferred. Other errors still propagate.
6. Source cleanup recovery stopped the whole reaper when one provider account
   had an active transition. That precise lock condition is deferred per source;
   ownership/transition fences remain enforced. Other failures propagate.
7. Branded mail pruning wrote a Resend response on Postal rows, violating the
   provider receipt constraint. Scrubbing now keeps the unused provider response
   null and clears the correct provider's payload.

## Validation and deployment

- 18 focused Node tests passed, including flapping, real-failure escalation,
  channel acknowledgement, routing and preservation of LID quality safeguards.
- 2 Python capacity-policy tests passed.
- Disposable PostgreSQL `norva_ops_alert_qa_20261002`: executed actual production
  batch definitions with deterministic conflicting-owner fixtures. Verified
  other-owner progress, both provider scrub paths, and propagation of unexpected
  SQL errors. No production fixture data or credentials were copied.
- Both migrations deployed. Both Edge replicas recreated sequentially, each
  checked at playback health version 84, with unchanged image and unrelated env.
  Active files matched the Git base before replacement.
- Host capacity sender updated in the directory used by its real systemd unit.
- Mail monitor rebuilt as `norva-mail-monitor:ops-20261002`, preserving user,
  network, private mounts, read-only root, dropped capabilities and resource
  limits. Previous container is stopped and retained for rollback.
- Natural facet, genre and reaper cron executions reported `succeeded` after
  deployment. Production prune replay succeeded, deleted zero records and
  scrubbed the eligible old payload. Its historical failed cron receipt remains
  until the next scheduled execution; no run history was falsified.
- Live ops sweep at approximately 07:20 UTC: six routes configured; the LID
  fallback notification was accepted by Catalogue & Lecture and visible there
  in Telegram. A second sweep sent **zero notifications**. No fabricated test
  incident was injected.
- Mail health: all eight backlog/failure counters zero; monitor running.

Protected deployment backups and safe receipts are under
`/home/adrien/.norva/telegram-audit-20261002/`. Private environment and Docker
specification backups must not be committed. The rollout helper defaults to a
plan and refuses source/config drift; its first guarded attempt stopped before
container recreation because the mount was environment-driven, then this was
correctly reconciled through `NORVA_EDGE_FUNCTIONS_ROOT`.

## Capacity and LID limits

At inspection, the running Gateway reported 94 VAD failures out of 928 attempts,
but **zero baseline Whisper failures** and zero quality-fallback failures.
The fallback is operational; this change does not claim to repair every VAD
failure or eliminate provider latency.

The morning capacity alert reported 218.49 GiB/day over its prior sampling
window. A fresh 446-second sample produced 41.91 MiB of WAL, equivalent to
7.93 GiB/day if sustained. Disk was 63% used, about 157 GiB available. Historical
pg_stat_statements shows catalogue background builds/imports among the largest
WAL producers. These are different time windows: the fresh sample does not
invalidate the earlier spike, establish a daily budget or prove bloat absent.
Checkpoint timeout is already 30 minutes and WAL compression zstd; neither was
weakened and backup retention was not shortened to hide volume.

The deployed policy bounds repeated warnings. A full-day reduction in delivered
message volume has not yet been measured. All genuinely new/severe conditions
remain eligible to alert; old messages remain available as evidence.
