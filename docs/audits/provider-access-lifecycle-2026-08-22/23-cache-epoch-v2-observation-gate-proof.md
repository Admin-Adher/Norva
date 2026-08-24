# Catalog cache epoch v2 — minimum observation gate

Date: 2026-08-25

Status:

```text
CACHE_EPOCH_V2_SEVEN_DAY_DB_GATE_PROVED
PRODUCTION_INSTALLATION_PENDING
```

## Defect closed

The seven-day incompatible-cache observation window was documented and enforced
by the operator sequence, but the service-role completion RPC itself did not
reject an early call. Migration
`20260824171000_catalog_cache_epoch_v2_minimum_observation_gate.sql` moves that
authority into PostgreSQL.

For an `installed` rollout, the immutable completion RPC now locks the singleton
and derives:

```text
not_before = installed_at + interval '7 days'
```

If database time is earlier, it rejects with SQLSTATE `55000` and
`reason=observation_window`. Manifest validation, immutable replay and the
single global epoch bump remain unchanged.

## PostgreSQL proof

Disposable database: `norva-phase3-proof-a-db`.

The cache rollout was still `installed` and had no `940...` synthetic fixture.
The additive migration was applied, then the acceptance transaction proved:

```text
catalog_cache_epoch_v2.sql
1..30
30 PASS
0 FAIL
ROLLBACK
```

Assertion 18 calls the exact production completion RPC as `service_role` with
the exact manifest before seven days and receives the required refusal. Only
the rolled-back proof fixture is then backdated eight days; exact completion,
replay, ON/OFF invalidation and final flag shutdown remain green.

## Operator boundary

`run_provider_access_production_activation_gate.sh` is read-only by default. It
accepts only the exact `norva-db` container, derives the same deadline from
PostgreSQL, refuses an unsafe rollout/P0 state and requires the literal
`COMPLETE_CACHE_EPOCH_V2_AFTER_7D` before invoking completion.

The script is convenience and evidence capture. PostgreSQL remains the ultimate
authority if another caller tries to bypass it.

## Immutable proof inputs

```text
migration SHA-256
80f23995387905468ee61fe303b4ff0eadb69255f2fd04bae7e092214a48f743

SQL acceptance SHA-256
fb875ebba4cbdafbabc36aecc9f71a190ca3e320e69f0270911ab0553d949160
```

## Repository regression

```text
2630 tests
2628 passed
0 failed
2 expected skips
```

This proof does not complete epoch v2, activate a cohort or change any Provider
Access flag.
