# M3U production runtime reference — 24 September 2026

## Scope and evidence

The two production Edge replicas mount the same source directory,
`/home/adrien/.norva/resume-cache-edge-pilot-20260918/functions`, and use the
same Edge image. A read-only SHA-256 inventory of that mount was compared with
the committed blobs in this change:

| File under `supabase/functions/` | Production and committed SHA-256 |
| --- | --- |
| `norva-cloud/index.ts` | `5d70a7d1814e8fe6f3bf762f4c1e38f78166a47fe508f5829c1bd383665434a4` |
| `norva-source-sync/index.ts` | `f1a458cea42c96d396c16c66ef00ebe34b40a63106d65292a5d921b374aa4799` |
| `_shared/selection-initial-import.mjs` | `6a593eed7d2d6c5e8c1eb56bf5f628a91634159294d0e86f07f00f84424bd1fe` |
| `_shared/m3u-media-classification.mjs` | `5a80a2907761ce1f1b77e4ef4c61641b5dc881bb5b5dba3c469b522c31fee8b1` |

The reference now includes the production M3U movie/episode classification,
durable finalizer proof, source projection lease, account epoch joining and
bounded concurrent import behavior. The deployment health gate checks protocol
2 for finalizer resume and bounded finalization, plus the projection, epoch
and concurrent import markers on both Cloud and source-sync functions.

## Verification and limits

- 82 relevant M3U/catalog/visibility tests passed locally, including owner-scoped rows,
  contradictory episode metadata, semantic signature stability, stale cursor
  rejection and competing import leases.
- The installed production files were not modified by this reconciliation.
  A code match proves these four source files can be rebuilt from Git; it is
  not a new end-to-end import on an ordinary paid account.
- Other Edge files still differ from the repository. The full Edge runtime is
  **not yet** reproducible from this PR alone; each remaining difference needs
  a versioned reconciliation and a complete deploy audit.
- CI Edge type-check and integration results must be recorded before merge.
