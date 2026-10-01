# Selection shared activation

## Change

Store the qualified public catalogue once, then enroll an authorized source by
one fenced reference. Media, logical title, variant and Live read models bind
that public snapshot to the requesting owner. Activation no longer creates
8,611 media rows, 8,000 variants and their observations for each account.

Playback and reactions create only the selected physical FK targets (one film,
or an episode and its parent). Stable owner-specific IDs preserve isolation.
Other providers retain their existing read paths; mixed accounts use bounded
physical/shared page merging and indexed title runtime lookups.

This does not change entitlement, payment, provider credentials or client UI.
The cloud adapters and scheduled sync adapter all recognize shared enrollment.

## Predeployment evidence

62 focused JavaScript tests passed. All three affected Edge entrypoints bundle.
Real PostgreSQL schema-clone testing used `norva_selection_shared_qa_20261001`,
public catalogue data only and synthetic users inside a rollback transaction.
Tests execute as the actual service role after fixture setup.

- Common release prepared once in 11.9 s, outside enrollment.
- Enrollment: 18.4 ms SQL time, zero owner media/title/variant inventory copies.
- 8,611 visible rows: 7,724 films, 276 series, 590 episodes, 21 Live entries.
- 6,432 logical titles, 12 known audio languages; unknown languages remain honest.
- Home selection, hydration and second cursor page: 429 ms combined.
- Grid, search, genre counts: 469 ms combined; language counts: 220 ms.
- Genre rails, language filtering and Live visibility: 532 ms combined.
- Selected film binding and idempotent repeat: 109 ms combined.
- Two owners get different title/variant IDs; playing on one creates no data on
  the other. Disabling one source hides its catalog without hiding the other.
- Mixed ordinary/shared provider title has one card and both variants.
- Foreign owners and stale epochs cannot write bindings; episode creates only
  its exact row and parent. Full catalogue counts survive lazy binding.

SQL times are not browser first-paint or end-to-end activation measurements.

## Release and rollback

`ops/hetzner/scripts/deploy-selection-shared-20261001.py` checks installed hashes,
applies the five migrations with enrollment disabled, installs four Edge files,
publishes a freshly fetched public manifest with exact recipe/file evidence and
complete Live variants, then enables new enrollment globally.

Roll back admission with `disable`. Keep shared read/bind schema and code for
already enrolled accounts; do not delete those references or restore old reads.
Existing physically imported accounts retain their usual import semantics.

Shared memberships pin a qualified release. Publishing another snapshot does
not silently retarget already-bound physical files. Upgrading those memberships
requires a separately qualified bound-file migration. This initial release is
not an automatic rolling metadata-refresh implementation.

## Production evidence

Pending production rollout and fresh enrollment replay. No end-to-end latency
claim follows from the isolated database measurements above.
