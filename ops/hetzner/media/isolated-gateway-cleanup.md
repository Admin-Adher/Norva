# Closing an isolated Gateway that shares the encoder pool

An isolated process can still own production-wide capacity through
`VIDEO_ENCODER_SHARED_ROOT`. Stopping its container closes transport, but does
**not** run `stopSession()` or release `sharedEncoderLease`. The allocator
deliberately retains uncertain reservations after process death.

## Normal experiment completion

1. Keep the ordinary provider claim heartbeat alive throughout media cleanup.
2. Read the candidate's authenticated `/debug/sessions`. Refuse any session whose
   `playbackSessionId` differs from the experiment's claim.
3. Close each exact candidate session with authenticated `DELETE /sessions/:id`,
   without `resumePosition` or `completeCache=continue`. These omissions prevent
   an intentional retained decoder or a background cache continuation.
4. Require candidate `/health` to report `videoEncoderCapacity.active == 0`.
5. Stop the candidate container and verify the stop succeeded before expiring the
   ordinary claim. Record cleanup failure explicitly if any preceding step failed.
6. Check the shared reservation inventory after closing. A stopped container and
   zero media files alone do not prove capacity has been returned.

A failed heartbeat or emergency watchdog must still stop the candidate
immediately. Do not delay fail-closed transport termination while attempting
graceful cleanup. Record that reservation recovery needs an independent audit.

## Recovery after an abrupt stop

Do not raise the pool limit or delete all `slot-*` directories. Establish the
exact shared mount and enumerate every running consumer. Check current encoder
admissions, retained/live sessions and host encoder children; prove that the old
candidate and its children have stopped. A PCM-to-WAV language extraction is a
different activity and cannot establish ownership of a video reservation.

Capture the exact slot directory and nonce before recovery. Revalidate the
unchanged directory, nonce, mount and running consumers immediately before a
scoped removal. Refuse unknown owners, active encoders, changed nonces, symlinks
or unexpected directory contents. Use non-recursive removals only. Preserve a
receipt, then verify pool occupancy and ordinary service admissions.

The bounded `provider-quiesce` lease may defer new background work while waiting
for a natural drain. It is not evidence that existing work has drained, does not
authorize interrupting viewers, and must be released or allowed to expire on all
exit paths. Never alter provider leases or replay consumed test admissions.

Incident and recovery evidence:
[`2026-10-09-zero-start-recovery.md`](../../../docs/qa/2026-10-09-zero-start-recovery.md).
