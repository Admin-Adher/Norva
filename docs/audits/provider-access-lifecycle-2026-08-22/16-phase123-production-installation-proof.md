# Phases 1–3 — Production installation and authenticated smoke

Date: 2026-08-24

Status:

```text
PHASE_1_PRODUCTION_CORE_INSTALLED
PHASE_2_PRODUCTION_CORE_INSTALLED
PHASE_3_PRODUCTION_CORE_INSTALLED
PHASE_3_2_FORMALLY_CLOSED
PHASE_1_2_3_AUTHENTICATED_PRODUCTION_SMOKE_PROVED
PROVIDER_ACCESS_FLAGS_OFF
CATALOG_CACHE_EPOCH_V2_WAITING_FOR_OLD_CACHE_EXPIRY
PRODUCTION_CAPABILITY_ACTIVATION_PENDING
```

The additive database and compatible Edge/client readers are installed in
production. This is not an authorization to enable Provider Access for all
users: the six independent capability flags remain OFF until the incompatible
v1 cache lifetime has elapsed and the reversible canary gates are executed.

## Published and deployed source

- Phase 1–3 reviewed source and production database/Edge deployment:
  `cc6a78fa9437b7d3112ed732e6d636e3b67285e7`;
- CI isolation correction published on `main`:
  `bd8a0b4b568215390b526f171cd785ffbf417eb0`;
- authenticated production smoke harness:
  `bcbab1e9971e56622b35477d7b41fda6725f7298` on
  `codex/phase123-production-integration`.

The production database container is `norva-db`, running
`supabase/postgres:17.6.1.136`. The production Edge containers were rebuilt
from the reviewed Phase 1–3 source. Catalog v6, Cloud v25 and Playback v61
health probes were green after deployment.

## Database installation proof

The pre-deployment logical dump is retained at:

```text
/var/lib/norva-phase3-proof/production-deploy-59750614/predeploy.dump
size: 911646653 bytes
mode: 0600
```

The production online backfill completed for all ten sources, with 2,702,020
cumulative bounded batch writes and all 28 rollout constraints validated. The
contraction completed and an immediate replay proved idempotence. The catalog
summary refresh cron was disabled only while its pre-existing run drained and
was re-enabled after contraction.

Final invariant artifact:

```text
/var/lib/norva-phase3-proof/production-deploy-cc6a78fa/final-invariants.tsv
SHA-256 931622f448ad7b840bf1fb8fd9166bf72e1f0ae3a9aaccc8ca7cc0d895e86d71
```

It records:

- rollout `contracted`, discovery complete, `10/10` sources and 28 validated
  constraints;
- six Provider Access flags present and zero enabled;
- exactly one global epoch singleton;
- cache epoch v2 installed but deliberately not completed;
- no raw provider account activity;
- no missing generation on any contracted catalog relation;
- no non-terminal transition, credential job or open generation.

Completion marker:

```text
/var/lib/norva-phase3-proof/production-deploy-cc6a78fa/PHASE123_DATABASE_INSTALL_COMPLETE
SHA-256 8cde49b3d9236b28e1a4bc511e0a52cf2276b43bcf0e4aef2501ae46081e604e
```

## Authenticated production runtime proof

The smoke used a synthetic `invalid.test` Auth account and a short-lived JWT
minted only on the production host. Neither JWT secret nor token was logged.
It called the public production endpoints through their real TLS boundary:

```text
norva-cloud/sources
norva-catalog/media-items?itemType=movie&limit=1
norva-playback/generated-subtitle-langs
```

All returned HTTP 200 with the exact v2 cache contract. Warm reads kept the
same token. A server-authorized global epoch bump changed `v2.1.1` to
`v2.2.1` without changing the account epoch.

Thirty-two real concurrent public requests then raced another global cutover.
One in-flight request was refused fail-closed:

```text
HTTP 409
X-Norva-Visibility-Epoch: v2.3.1
X-Norva-Catalog-Cache-Contract: v2
Cache-Control: no-store
details.code: CATALOG_VISIBILITY_EPOCH_CHANGED
```

The immediate post-cutover request converged to HTTP 200 under `v2.3.1`.
There is no explicit table lock in the runtime or production smoke path.

The synthetic account was then removed through the durable provider/account
deletion state machines, not by bypassing their fences. Independent
postconditions found zero Auth user, workflow, provider-deletion preparation,
transition and credential-job rows. All six capability flags remained OFF.

Artifacts:

```text
/var/lib/norva-phase3-proof/production-auth-smoke-bcbab1e9/RESULT.txt
SHA-256 ef98bf02edf1cec4a3effb7d6b86e1be94f2d7635d5935a00c1d20f6a3fcba1c

/var/lib/norva-phase3-proof/production-auth-smoke-bcbab1e9/cleanup.log
SHA-256 a0e604572a59a0988d264a499605cbde75652fb11ce56eae772492539d150428
```

Harness bytes:

```text
run_phase123_production_authenticated_smoke.sh
SHA-256 0ab6b49011713698fd43e9222c3f4e57361afc5b0779a4632cd914ec080d9f3b

phase123-production-smoke-cleanup.sql
SHA-256 fa3b21424b03ec2663963939775281c3ee8a0e8e94ce53bbc61972751cb98749
```

## CI and delivery verification

The post-publication GitHub runs are green:

- Partners integration `32716134499`: disposable Supabase database, pgTAP,
  browser journey, Edge contracts, Android Phone and Android TV;
- Build `32716134522`: web contracts, Android Phone APK, Android TV APK and
  Windows portable build;
- Web `32716134477` and Relay `32716134536`: successful production delivery.

The complete merged local suite before production operations reported 2,558
tests: 2,556 passed, zero failed and two expected skips.

## Remaining activation gate

The longest incompatible cache lifetime is seven days. Because compatible v2
readers were deployed on 2026-08-24, the rollout cannot be completed before
the evidence window ending around 2026-08-31. Until then:

1. `cloud_catalog_cache_epoch_v2_rollout.phase` remains `installed`;
2. its manifest and completion timestamp remain NULL;
3. all six Provider Access capability flags remain OFF;
4. no public capability canary is activated.

After the window, the exact reviewed manifest must complete the v2 rollout.
Each capability is then activated through its own bounded, reversible canary,
with rollback and invariant captures. Only that final sequence can change the
status to `PRODUCTION_CAPABILITY_ACTIVATED`.
