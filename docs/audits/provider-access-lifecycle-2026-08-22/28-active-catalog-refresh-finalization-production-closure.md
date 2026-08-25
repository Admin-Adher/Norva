# Phase 3.2 — active catalog refresh finalization production closure

Date: 2026-08-25

Status:

```text
ACTIVE_CATALOG_REFRESH_FINALIZATION_PRODUCTION_PROVED
ACTIVE_CATALOG_REFRESH_CRASH_RESUME_PROVED
ACTIVE_CATALOG_REFRESH_STALE_PRUNE_COMPLETED
ACTIVE_CATALOG_REFRESH_OPERATOR_STATE_CLEAN
PROVIDER_ACCESS_ROLLOUT_STILL_OFF
```

## Scope

This report closes the production execution gap left after the v3 active
catalog worker deployment. It records a real active-source refresh through
durable title projection, bounded stale pruning, reconciliation and terminal
`READY`, plus the finalizer fixes required by that execution.

The run did not activate Provider Access. The rollout stage and capability
flags remained OFF throughout.

## Defects found by the real run

The refresh initially reached all 197,626 logical titles, but both finalizer
layers retained a response snapshot captured before their own successful
visibility-epoch bump:

1. the `/cron/finalize-step` route reasserted its pre-operation snapshot after
   `finalizeCloudSource()` had already pruned a committed batch;
2. the internal `driveFinalizeToReady()` loop repeated the same stale
   postcondition after a self-induced epoch bump.

The database mutations were correct and durable, but the callers returned a
false `SOURCE_CATALOG_CHANGED` after each committed batch. The fixes adopt only
the active catalog's monotone user-visibility epoch, then reassert the complete
snapshot before continuing:

```text
eccbf5a7 fix(sync): carry finalize response epoch
0be61891 fix(sync): carry durable finalize epoch
```

The durable operator path was then hardened so structured upstream timeouts are
classified as transient and terminal `READY` removes only the exact owned
cursor and lease through compare-and-set:

```text
7da9a8d6c49e4470bee757384b5cedbcdca72ac1
fix(sync): harden durable finalize recovery
```

`0 rows affected` remains a stale/no-op result. No operator cleanup may remove
state owned by another worker or generation.

## Crash and reclaim evidence

The external operator connection was interrupted multiple times while bounded
prune pages were running. After each interruption:

- PostgreSQL retained the exact newer durable cursor;
- no source-sync backend remained active;
- the old lease was released only through exact CAS;
- the continuation resumed from PostgreSQL rather than process memory;
- no page was double-committed and no generation authority changed.

The stale population converged from 26,344 rows to zero through bounded pages.
The active catalog count remained 254,372 throughout.

## Authoritative production snapshot

The final read-only PostgreSQL capture reported:

```text
source sync_status       ready
source sync_error        NULL
sync progress            100%
progress stage           ready
finalize status          done
active generation        f8fef67f-3f6e-4cc3-99d2-a48a51a817aa
generation state         active
generation config rev    0
catalog head revision    0
active media rows        254372
non-active media rows    0
live                     56746
movies                   150150
series                   47476
finalize cursor present  false
finalize lease present   false
active source sessions   0
```

The terminal sync-progress document also records 1,725 categories and an
`updatedAt` of `2026-08-25T12:55:08.060Z`.

## Runtime delivery proof

Both production Edge replicas mount the immutable worktree:

```text
/home/adrien/norva-deployments/phase123-7da9a8d6/supabase/functions
```

Their `norva-source-sync/index.ts` SHA-256 values are identical:

```text
0894d837ef675b4fa41b9192ddefc45c5135778aee07235f2f94cc3c1a562d71
```

The public source-sync health probe remained green after the rolling restart.

## Verification

- response-epoch regression suite: 44/44;
- durable-driver regression suite: 33/33;
- transient-finalizer and cleanup suite on final `main`: 47/47;
- Edge bundle build: PASS;
- GitHub Build run `32850737977`: PASS for cloud contracts, Android Phone,
  Android TV and Windows portable;
- Cloudflare and relay workflows for the same source head: PASS.

The unrelated strict-LID CI case failed once on an earlier attempt and passed
on its isolated rerun. It did not exercise the finalizer path.

## Remaining independent gate

The production activation preflight on 2026-08-25 remains intentionally:

```text
cache phase       installed
cache completed   NULL
not before        2026-08-31 10:12:57.166559 UTC
rollout stage     off
rollout revision  2
enabled flags     0
P0 safe           true
status            WAIT_OBSERVATION_WINDOW
```

This time-bound cache gate is independent of the now-complete Phase 3.2 active
refresh proof. It must not be bypassed.
