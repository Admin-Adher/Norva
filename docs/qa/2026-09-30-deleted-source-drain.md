# Deleted-source cleanup: disabled imports

## Observed problem

Read-only production checks at 14:49–14:51 UTC on 30 September found the old,
deleted MAX OTT source still `purge_pending`. Its purge was due immediately on
23 September; no rollback retention remained. Its source-delete cleanup job
had 265 attempts, no recorded error and `provider_deletion_pending=false`.
The hidden payload still contained 250,158 raw items and 107,160 variants.

The scheduled reaper was active every ten minutes and reported successful
calls, but its global import guard returned before processing any source.
Twenty non-deleted M3U sources were still `syncing`, all disabled and unchanged
since 6 September. `norva-source-sync` deliberately pauses disabled sources.
At the second snapshot, 24 cleanup jobs in total were due. No provider request,
production deletion, status reset or manual reaper invocation was performed.

## Change

Migration `20260930151000_source_reaper_enabled_import_guard.sql` adds only
`and enabled` to the existing global syncing-import guard. Enabled imports
continue to defer cleanup. The migration requires exactly one known old guard
or exactly one already-updated guard and refuses missing, duplicate or mixed
definitions. The procedure's remaining body, permissions, cleanup deadlines,
owner/generation checks, activity fences and 5,000-row budget are unchanged.

Deployment is owned by the parent task. This report does not claim the cleanup
backlog has drained; the existing cron must provide that evidence after rollout.

## Verification

- Seven focused Node tests passed (`source-reaper-enabled-import.test.js` and
  `provider-source-delete-cleanup.test.js`).
- `tests/run-source-reaper-enabled-proof.py` ran the actual production procedure
  in a new networkless PostgreSQL 17 container, using column definitions only
  and synthetic rows. The old disabled-import blockage was reproduced first.
- Ten runtime cases passed: disabled syncing source, enabled syncing source,
  enabled ready source, deleted syncing source, active provider permit, active
  fallback lease, active playback, active Gateway session, due-generation
  cleanup authority, and the 5,000-row budget with another source preserved.
- The migration was applied twice with identical results. The entire procedure
  definition equals the original with just the intended guard replacement.
  Missing, duplicate and mixed old/new guards all refused migration without
  changing the definition.
- Procedure SHA-256 (normalized text): before
  `8df5dd9414d8e60ed6f123c9d8ef7a7d5f5aec42e9237824561bfcd9795091d3`;
  after `385677116b20b217fed9ebd4381b04796c8e16173e503b6a331dce6b944193f0`.
- Production procedure was read again and was unchanged. Disposable container
  was removed. No production rows were copied or modified.

The isolated schema copies column types, not production triggers or foreign
keys. Queue scheduling and terminal cleanup are no-op stubs in this narrow
proof. It verifies actual reaper branch behavior and preservation of its body;
it is not a full production cleanup replay or a throughput benchmark.
