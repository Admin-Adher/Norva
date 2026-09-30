# Avoid rechecking unchanged Selection jobs

After restoring the Selection worker's current service credential, its first
normal seed batch still failed with HTTP 500 / SQLSTATE 57014 after 8,060 ms.
That prevented it reaching an already queued recovered job. The original
seeder joined catalogue visibility and ownership for all manifest entries,
even when terminal/unchanged existing jobs could never be updated.

The migration materializes only manifest entries that can change a job before
the catalogue joins: new exact files, higher-priority queued/retry jobs and
`NO_ACTIVE_OWNER` candidates. Every retained entry still passes the canonical
owner, active generation, URL, availability and incomplete-audio checks.
The final conflict predicate remains unchanged for concurrent updates.

Tests cover terminal jobs, unchanged queued jobs, priority increase with/without
a visible owner, orphan revival, and all existing recovery/visibility/rollback
cases. The mandatory SQL test file passed 24 tests with zero skips.

## Production-sized measurement without publication

The exact first 250-entry manifest batch was executed against production data
with the candidate function installed only inside a transaction that rolled
back. It changed zero jobs and completed in **20.505 ms**. Before/after function
body hashes match, confirming the live definition was preserved. This measures
an existing-job batch, not a new 250-file import. Receipt:
`/home/adrien/.norva/selection-seed-candidate-timing.safe.json`.

An initial attempt to replace the function under the `postgres` identity was
rejected because the installed function belongs to `supabase_admin`; the actual
transactional measurement used that existing maintenance identity. No grants
or owners were changed.

Publication and the queued capture job's end-to-end result are still pending.
