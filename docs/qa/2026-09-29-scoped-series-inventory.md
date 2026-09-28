# Series inventory source scope

## Failure and change

On the eligible internal Xtream source used for the movie-intake replay, the
unidentified series set returned 2,076 rows in 3.63 seconds, but the complete
inventory candidate query exceeded 12 seconds inside source visibility checks.
Moving only the rollout predicate into an initplan did not resolve the timeout.

The migration materializes the visible source set for the requested owner/source
once. It derives its variants from the complete existing visible-variant view
definition, preserving its generation rules, then scopes that relation to series.
Inventory joins, refresh eligibility, provider cooldown, ordering and limits are
unchanged. No flags or retry state are modified.

## Verification

- Initial networkless fixture: 80 assertions passed with ordered candidate arrays
  compared to the pre-migration function at each checkpoint for every synthetic
  owner/source combination and limits NULL, -1, 0, 1, 4, 100 and 101.
- Expanded fixture: 84 assertions passed, including multiple fresh series to
  exercise ordering and limits, stale generations and a disabled source. The
  initial null-generation fixture was rejected by the actual NOT NULL schema;
  the final test verifies that constraint instead of weakening it. Migration
  setup was tested from a clean schema before the corrected fixture replay.
- Final migration-generated function executed against the real source in a
  rolled-back transaction: 4,800.152 ms. Earlier prototype: 4,301.508 ms. These
  measure database candidate selection, not provider fetching or playback.
- On the separate source named in the actual fleet timeout log, the final
  candidate executed in 3,145.592 ms, also in a rolled-back transaction.

Production deployment and normal-worker replay remain pending. Mobile playback,
commercial flow and rollout evidence are tracked separately in the main ledger.
