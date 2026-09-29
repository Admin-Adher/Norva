# Scoped validation dispatch — 29 September 2026

The deployed exact-file admission uses `catalog_language_exact_file_enabled_for_source`, but its due-job selector still consults only the legacy global flag. Thus the20% rollout does not yet expose independent source candidates through normal dispatch. This is separate from job2455621d's local inference failure: that job was present in the due list and then deferred by foreground capacity.

The migration updates only the due-list partition and active-source guard. Existing global activation is preserved. Two scoped sources can be scheduled independently; if either active/candidate source still uses legacy admission, identity-wide serialization is retained. Actual provider account/file leases and viewer priority remain the admission authority. No rollout, retry, quarantine, job or credential values change.

Verification:10 PostgreSQL assertions passed in new synthetic database `scoped_dispatch_20260929` in the existing networkless proof container. The fixture derives the production function from its committed migration lineage and executes the new migration. It tests legacy/scoped/mixed modes, manual priority, quarantine, future retries, limits and rollback. Source ownership/visibility gate behavior remains covered separately by `exact-file-scoped.sql`.

Production deployment and runtime dispatch observation remain pending.
