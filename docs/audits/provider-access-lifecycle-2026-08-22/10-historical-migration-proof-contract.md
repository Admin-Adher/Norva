# Phase 3.2 — Historical migration proof contract

## Purpose

This is an acceptance proof for data accepted by the historical provider
access schema.  It is not a synthetic seed for the current schema and it does
not authorize a production rollout.

The raw fixture is immutable:
`supabase/tests/fixtures/provider_catalog_generation_online_legacy_seed.sql`.
It is loaded before the generation-fence migrations, without adding modern
generation values, leases, snapshots, or staging rows to it.

## Fixed migration boundaries

| Boundary | Migration |
| --- | --- |
| Fixture schema head | `20260823110700_cloud_titles_candidate_shell_guard.sql` |
| Last pre-contraction migration | `20260823179920_catalog_generation_flag_gate.sql` |
| Contraction definition | `20260823180000_provider_catalog_generation_online_rollout.sql` |
| Online prerequisite head | `20260823182700_series_inventory_generation_parent_natural_fk.sql` |
| Current Phase 3 head | `20260823194000_replacement_promotion_proof_account_delete.sql` |

## Split acceptance harness

The old lifecycle test is deliberately split, with different valid schemas:

- `provider_access_lifecycle_pre_contraction.sql` runs at the last
  pre-contraction head. It proves that the historical fixture is intact and
  that neither the contraction RPC nor generation rows/heads exist yet.
- `provider_access_lifecycle_post_contraction.sql` runs after the durable
  discovery, backfill, validation, contract, idempotent contract replay, and
  the current Phase 3 head. It proves terminal contract metadata, historical
  row preservation, generation/head ownership, generation fences, and flags
  OFF.

No harness is permitted to bypass a generation guard or issue a raw modern
catalogue write.  A failure is evidence of a migration or contract defect.

## Reproducible execution

Run `ops/hetzner/scripts/run_provider_access_historical_migration_proof.sh`
on the isolated proof host:

```text
run A: fresh run-a volume and container
run B: fresh run-b volume and container
compare: normalized final semantic snapshots only
```

Each run writes a manifest containing the frozen Git commit, the migration tree
hash, the unchanged raw-fixture hash, separate pre/post harness hashes, and the
three fixed migration markers.  The comparison intentionally excludes random
UUIDs and timestamps.

## Closure boundary

Two green fresh runs with identical normalized semantic snapshots prove
`PHASE_3_2_HISTORICAL_MIGRATION_PROVED`.  They do not prove the remaining
adversarial concurrency races or the complete crash matrix, and do not change
the production status from **NO-GO**.
