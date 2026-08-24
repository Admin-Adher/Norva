# Catalog cache epoch v2 — proof report

Date: 2026-08-24

Status: `CATALOG_CACHE_EPOCH_V2_CORE_PROVED`

Production status: `NO_GO` — this report proves the additive contract in an
isolated environment. It does not complete the rollout, enable a Provider
Access flag, publish Edge code, or mutate production data.

## Contract proved

- PostgreSQL owns a singleton global policy epoch and the existing account
  visibility epoch remains the physical catalogue write fence.
- Account mutations advance only their account epoch. They do not serialize or
  invalidate unrelated accounts.
- Completing the v2 rollout, enabling visibility, disabling visibility, or
  changing the effective Provider Access policy advances the global epoch in
  the same transaction.
- Edge binds and rechecks `v2.<global>.<account>` immediately before returning
  an authenticated response.
- Catalogue selector/write RPCs continue to receive the numeric account epoch.
- `0`/missing/malformed epochs fail closed.
- A v1 numeric response cannot downgrade a browser process that has observed a
  v2 token.
- In-memory, HTTP URL, seven-day catalogue and Live IndexedDB caches are scoped
  to the composite token. Cloud cold paint without a known token is rejected.
- The historical Provider Access flag trigger remains the single atomic guard;
  the migration does not create a competing trigger topology.

## Immutable inputs

```text
manifest
23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3

migration
c3116c5df957e779979a558af0890128f83df8d9096b277edd83daa156bbedc1

SQL acceptance harness
1b634d04f240990d5c245d1dbd9a1c109dacbdcf4719dd545a22ae8b82388d1d

shared Edge response helper
d3e876af8f46eb86c867e71b6b3b0035eb530540d5ba30eb8a847bd12f9a6f86
```

The migration stores and checks the exact canonical-LF manifest hash. An exact
completion replay is idempotent; a different hash is rejected with SQLSTATE
`22023`.

## PostgreSQL proof

Environment:

```text
host: 157.180.96.159
container: norva-phase3-proof-a-db
database: norva_cache_epoch_v2_proof
source dump: transaction-crash-clean-final4-a.dump
PostgreSQL: 17.6
```

The database was recreated from the clean Phase 3 dump, the current migration
was applied once, and `supabase/tests/catalog_cache_epoch_v2.sql` passed:

```text
1..29
ok 1  ... ok 29
finish: 0 rows
ROLLBACK
```

The 29 assertions include:

- singleton authority and flags OFF;
- table ACLs and authenticated owner isolation;
- rollback of an account bump;
- account/global independence;
- two real `dblink` PostgreSQL sessions publishing distinct consecutive global
  generations;
- visibility activation rejected before v2 completion;
- manifest mismatch rejected;
- exact completion and idempotent replay;
- visibility ON and OFF each advancing the global epoch;
- final flags OFF and exact composite RPC output.

The source dump contains `pg_cron`, which this Supabase image permits only in
database `postgres`. Restoring the disposable secondary database therefore
reported six expected `pg_cron`-only warnings; all schemas, functions and data
used by this proof restored successfully. pgTAP was then bootstrapped in the
isolated database before the acceptance harness.

## Edge and client proof

```text
visibility and surface suite: 109/109 PASS
targeted Live/cold-cache suite: 21/21 PASS
epoch-v2 static/runtime contracts: 7/7 PASS
combined final regression run: 128/128 PASS
Edge bundles parsed: 3/3
browser scripts parsed: PASS
```

The three Edge bundles checked were `norva-catalog`, `norva-cloud` and
`norva-playback`. The surface suite covers centralized visibility reads,
playback, Home, Movies, Series, Live, search/title hydration, favorites,
history, Continue Watching, EPG, background jobs, source management, paired
devices, provider workers and response finalization.

## Defects found and closed during proof

1. The initial draft advanced the global singleton for every account mutation,
   which would have serialized unrelated users and caused global cache churn.
   Global and account authorities are now independent.
2. A first operator exception allowed `session_user=supabase_admin` to bypass
   owner isolation after `SET ROLE authenticated`. The fresh restore caught it;
   the exception now also requires the current SQL role to be an operator role.
3. Live IndexedDB entries were time-scoped only. They now carry and verify one
   exact v2 token across categories, all pages and the final write.
4. Movies and Series could cold-paint a seven-day cache before learning the
   server epoch. Cloud persistent caches now reject reads and writes without an
   exact current signature.

## Remaining rollout gate

Core proof is not production rollout. The required order remains:

1. freeze and publish the exact reviewed Phase 1–3 tree;
2. install the additive migration in production with all flags OFF;
3. deploy the compatible Edge readers;
4. deploy the SPA/WebView cache handling;
5. run authenticated warm-cache cutover smokes on real production topology;
6. wait beyond the longest old in-memory/browser cache TTL;
7. complete the v2 rollout with the exact manifest hash;
8. only then consider a separately reversible Provider Access visibility
   activation and its production canary.

Until those steps are evidenced, `provider_access_visibility_v1_enabled` and
all other Provider Access flags remain OFF.

The additive proof in `23-cache-epoch-v2-observation-gate-proof.md` strengthens
step 6: PostgreSQL now rejects the exact service-role completion RPC until
`installed_at + 7 days`. The documented window is therefore a database
invariant, not only an operator runbook condition.
