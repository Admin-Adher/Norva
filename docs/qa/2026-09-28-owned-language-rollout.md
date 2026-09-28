# Provider language metadata rollout

Installation starts at 0%. The legacy global flag remains unchanged. A stable
owner bucket controls declarations in filters/cards, movie metadata acquisition
and the one-time series inventory refresh. Internal owners get no exception.
Every admission also requires the source to be visible to its owner.

Stages: 0, 1, 5, 20, 50 and 100 percent. Service-only revision CAS rejects stale
updates and skipped forward stages; rollback may move to any lower stage.
This rollout is independent of metadata batching/exact-file admission: granting
it never grants a provider connection or changes the existing playback guards.

The catalogue attachment helper now groups requests by owner/source/media type
and uses the optimized scoped projection instead of the correlated reference
view. Returned variant/source/type membership is still checked before display.
Provider declarations remain separate from observed and certified audio.

## Verification

- 16 focused JavaScript tests passed, including network refusal, lease handling,
  ownership fencing, source/type grouping and declaration presentation.
- 80 SQL assertions passed in a networkless schema-only clone. Repeated
  bidirectional comparisons retain projection equivalence; new checks cover
  stage order, stable buckets, stale revisions, wrong/null owners, permissions,
  activation of declarations and emergency rollback.
- Live-schema compatibility transaction rolled back. No production activation.

## Deployment order and remaining proof

Apply the SQL migration at 0%, deploy the two modified Edge files on both
replicas, check runtime parity, then advance the rollout with fresh revision
checks. Collect actual provider metadata and rendered catalogue evidence before
further expansion. Existing SQL query timings are not UI latency certification.
The old reference view remains for compatibility and bounded movie inspection;
catalogue cards and filter aggregation use the optimized scoped reader.
