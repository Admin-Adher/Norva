# Phases 1–3 — Edge runtime integration proof

Date: 2026-08-24

Status:

```text
PHASE_1_VISIBILITY_RUNTIME_CORE_PROVED
PHASE_2_DURABLE_TRANSITION_CORE_PROVED
PHASE_3_EDGE_INTEGRATION_RUNTIME_PROVED
PRODUCTION_ROLLOUT_NO_GO
```

This proof closes the isolated Edge/PostgREST runtime gate for the Phase 1–3
tree. It does not claim that the migration, Edge functions, SPA/WebView, or any
Provider Access flag have been deployed to production.

## Immutable application input

```text
Edge/client source commit
fbb6e95c58c5019e2d4fd0b0233c1e1d34ca3477

Git bundle SHA-256 (local and Hetzner copies identical)
656940e8486b433fb0db127b8d799ad5fccef474f84d161574319fb2b64b3fd3

catalog-cache epoch v2 manifest SHA-256
23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3

catalog-cache epoch v2 migration SHA-256
c3116c5df957e779979a558af0890128f83df8d9096b277edd83daa156bbedc1
```

The Hetzner checkout at
`/home/adrien/norva-phase3-proof/source-fbb6e95c` was checked before the run:

```text
HEAD = fbb6e95c58c5019e2d4fd0b0233c1e1d34ca3477
tracked changes = 0
untracked files = 0
commit recoverable with git cat-file = yes
```

## Reproducible harness

```text
ops/hetzner/scripts/run_phase123_edge_runtime_proof.sh
SHA-256 0ef50aa03745cb13055ce88d0c209eb2753f0904ff6d462e61dcd628f2aa57e5

ops/hetzner/phase3-proof/postgrest.passwd
SHA-256 bf72f86891eff321a7808529f5b1957f76eaa04e2d4b2edd019bbeb84b4d4ea8

ops/hetzner/phase3-proof/nginx-rest-prefix.conf
SHA-256 b214392f0f73db4cb79cb49603d6fedd90ec2e8b88758413926c413934152645
```

Pinned runtime images:

```text
supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00
supabase/edge-runtime@sha256:2781daf92394db91f7e94129cc3d04ec474ad16a8fe64b3fbeef6e7d557ab120
postgrest/postgrest@sha256:54000f24847d01a2c2302e0041cf0618b875c57fb48507d743cfa9aaa50bf43c
nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
curlimages/curl@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b
```

The REST-prefix proxy has no authentication authority. It only maps
`/rest/v1/*` to the isolated PostgREST root; PostgREST verifies the signed JWT
and PostgreSQL remains the authorization and epoch authority.

## Database acceptance

The additive migration was applied to `norva-phase3-proof-db`, never to the
production `norva-db` container. The pgTAP acceptance suite passed:

```text
1..29
ok 1 ... ok 29
finish: 0 rows
```

The suite finished inside its transaction with all Provider Access flags OFF.
The durable runtime proof also checked those same six flags after both global
epoch bumps.

## Authenticated runtime surfaces

A fixed synthetic Auth user was created only in the isolated proof database.
The harness minted a one-hour HS256 test JWT with the proof-only JWT secret and
called the exact Edge tree through a fresh Edge Runtime.

The following authenticated routes returned HTTP 200 with one exact composite
epoch and all four required response headers:

```text
norva-cloud/sources
norva-catalog/media-items?itemType=movie&limit=1
norva-playback/generated-subtitle-langs
```

Required headers:

```text
X-Norva-Visibility-Epoch: v2.<global>.<account>
X-Norva-User-Visibility-Epoch: <account>
X-Norva-Global-Visibility-Epoch: <global>
X-Norva-Catalog-Cache-Contract: v2
```

Two consecutive warm `norva-cloud/sources` reads returned the same epoch. A
server-side global bump then changed the next response token without changing
the account epoch.

## Real mid-flight cutover proof

The harness used two real PostgreSQL sessions and a real Edge request:

```text
session A: ACCESS EXCLUSIVE lock on cloud_sources
Edge: bind v2 global/account epoch
Edge/PostgREST: block on the source read as authenticator
session B: bump global catalog visibility epoch
session A: release the source table
Edge: finish the source read and recheck the epoch
```

The mixed response was refused exactly as required:

```text
HTTP 409
details.code = CATALOG_VISIBILITY_EPOCH_CHANGED
Cache-Control = no-store
Retry-After = 0
response epoch = the new current v2 token
```

The immediate retry converged to HTTP 200 under the new token.

## Deterministic rebuilds

The complete runtime stack was removed/recreated between successful runs.

Run A:

```text
PHASE123_EDGE_RUNTIME_PROOF_PASS
baseline=v2.6.1
after_warm_bump=v2.7.1
after_midflight_cutover=v2.8.1
authenticated_surfaces=3
midflight_cutover_status=409
provider_access_flags_enabled=0
rollout_phase=installed
```

Run B:

```text
PHASE123_EDGE_RUNTIME_PROOF_PASS
baseline=v2.8.1
after_warm_bump=v2.9.1
after_midflight_cutover=v2.10.1
authenticated_surfaces=3
midflight_cutover_status=409
provider_access_flags_enabled=0
rollout_phase=installed
```

The global sequence is strictly monotone across rebuilds. The account epoch
remained `1`, proving again that global policy invalidation does not mutate an
unrelated account write fence.

## Harness defects found and closed

1. The historical proof compose interpolated a base64 password containing `/`
   and `+` directly into a PostgreSQL URI. A fresh parse was invalid. The
   harness now uses a quoted libpq key/value conninfo.
2. The distroless PostgREST image has no passwd entry for UID 1000. The proof
   supplies a minimal read-only passwd file.
3. The old proof Kong key-auth declaration had drifted from its environment.
   The runtime proof uses a minimal prefix-only proxy and leaves JWT validation
   in PostgREST.
4. Kong/proxy startup was initially treated as synchronous. Every network
   boundary now has an explicit bounded readiness check and curl timeout.
5. The first concurrency observer searched for a physical table name inside a
   prepared PostgREST query. It now observes the `authenticator` backend waiting
   on a PostgreSQL lock.

These were proof-topology defects. None required weakening a visibility, RLS,
generation, transition, or fail-closed product invariant.

## Production topology read-only check

A separate disposable PostgREST v14.12 process was freshly booted on the live
Docker network with the current production PostgREST configuration. It only
loaded the schema cache; it made no data mutation and exposed no host port.

```text
PROD_REST_FRESH_BOOT_READ_ONLY_SMOKE_PASS
PostgreSQL 17.6 connected
schema cache: 146 relations / 506 RPCs
temporary container removed
```

Therefore the raw-password URI defect is confined to the historical proof
compose; the current production PostgREST configuration is fresh-bootable.

## Remaining production gate

Phases 1–3 are not production-closed yet. The required order remains:

1. freeze and publish the exact reviewed tree;
2. install the additive migration in production with all six flags OFF;
3. deploy compatible Edge readers;
4. deploy the SPA/WebView v2 cache handling;
5. execute authenticated warm-cache and mid-cutover smokes on production;
6. wait beyond the longest incompatible old cache lifetime;
7. complete the v2 rollout with the exact manifest hash;
8. activate each Provider Access capability only through its independent,
   reversible canary gate;
9. capture production rollback and invariant evidence.

Until those steps are evidenced, `PRODUCTION_ROLLOUT_NO_GO` remains correct.
