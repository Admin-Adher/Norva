# Phase 5 Provider A → B cross-surface proof — 2026-08-24

## Scope and safety

Branch: `codex/phase123-production-integration`

All database executions used synthetic accounts and catalogues in the
disposable Hetzner proof B PostgreSQL container. No production credential,
customer source or public feature flag was used. Every Provider Access flag was
restored to `false` after the proof.

## Synthetic catalogues

`provider_replacement_candidate_builder.sql` now builds different fenced
catalogues for A and B:

```text
A: movie=a-history, series=a-series, live=a-live
B: movie=b-fenced, series=b-series, live=b-live
```

A rows belong to A's active generation. B rows belong to the candidate
generation and carry the durable ingest job, lease sequence and lease owner.
The enriched builder retained its complete result:

```text
PROVIDER_REPLACEMENT_CANDIDATE_BUILDER 30/30 PASS
```

## One transition observed by all central projections

`provider_replacement_cross_surface_e2e.sql` consumes one committed
`READY_TO_SWITCH` fixture and captures three authenticated snapshots:

1. A active, B staging;
2. B active after atomic promotion;
3. A active after durable rollback.

The harness was executed twice on new fixtures `982...` and `983...`.
Both executions returned:

```text
1..38
38 PASS
0 FAIL
```

The assertions prove:

- exactly one visible source in every snapshot;
- B absent from every catalogue projection while staging;
- Movies, Series and Live switch together from A to B;
- A absent immediately after promotion;
- player admission rejects the hidden endpoint and admits only the visible one;
- the v2 composite cache token changes at promotion and again at rollback;
- Settings retains hidden A during the rollback window, while source pickers
  have exactly one `catalog_visible` source, B;
- provider-scoped A favorites and history are not rebound to unrelated B ids;
- those A rows remain durable but hidden during the rollback window;
- rollback restores A, its three catalogue markers, favorite and history;
- rollback creates exactly one compensating transition and never exposes A+B.

The temporary test adapters are owner-scoped `SECURITY DEFINER` functions over
the real security-invoker views. They exist only inside the rolled-back test
transaction and do not widen production table/view ACLs.

## Global cache epoch v2 runtime proof

The previously missing `20260824100000_catalog_cache_epoch_v2.sql` migration
was installed on proof B, flags OFF. The acceptance test then passed with a
collision-free synthetic UUID prefix:

```text
CATALOG_CACHE_EPOCH_V2 29/29 PASS
```

It proves global/account monotonicity, two-session concurrent bumps, immutable
manifest binding, fail-closed activation, exact token composition, idempotent
completion and invalidation on both visibility ON and OFF.

## Product-surface contracts

A focused Node runtime suite passed:

```text
98 tests
98 pass
0 fail
```

Coverage includes:

- Home rails and profile-isolated recommendations;
- Movies and Series watch state;
- Live TV and IndexedDB catalogue caches;
- Search and flat/title catalogue projections;
- Favorites, History and Continue Watching visibility;
- EPG and series metadata provider/cache admission;
- source management versus paired-device/source-picker projections;
- playback pre-decryption and pre-session visibility checks;
- background enrichment and delayed-provider TOCTOU checks;
- browser HTTP no-store, exact epoch retry and stale-response rejection;
- local source alias preservation and fail-safe removal of provider-scoped
  recents/resume/version choices.

## Closure status

```text
PHASE_5_PROVIDER_A_TO_B_CROSS_SURFACE_PROVED
PHASE_6_PROVIDER_ACCESS_MODEL_NEXT
PRODUCTION_ROLLOUT_NO_GO
```

This closes the pre-production cross-layer A→B gate. It does not authorize a
public rollout. A real production canary, monitoring and rollback rehearsal
remain Phase 16 gates after Provider Access, UX, notifications, legal policy
and operational readiness are complete.
