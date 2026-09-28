# Exact movie metadata projection

The first normal Xtream metadata intake in the 20% owned-language cohort returned
HTTP 500 / PostgreSQL 57014. No new durable intake claim was observed.

A read-only reproduction of `catalog_movie_audio_identified` across 16 movies
timed out at 12 seconds inside `cloud_catalog_owned_audio_declarations_scoped`.
One movie took 0.854 seconds including the SQL subprocess. Its SQL function
boundary prevented the outer variant filter from limiting the source-wide work.

Migration 20260928233000 adds an exact-movie projection with the variant predicate
inside the existing scoped query. Ownership, generation, lifecycle, identity,
rollout, precedence and visibility predicates are preserved. Only the movie
intake consumer changes; no provider lease, retry policy or activation changes.

## Evidence

- Networkless schema-only PostgreSQL clone: 80 assertions passed. At each fixture
  checkpoint the exact projection is compared in both directions with the
  reference view for every synthetic owner/source/variant combination, including
  series variants, stale metadata, observations, disabled sources and rollout
  transitions. Null arguments and authenticated access are checked.
- Production-data benchmark using a temporary function in a rolled-back
  transaction: exact declarations for 16 movies execute in 54.804 ms. No public
  definition or catalogue row changed. This measures the declaration subquery,
  not the complete intake endpoint or user-visible playback startup.
- Separate strict job 1f66d446-e694-433e-bec6-e32e7ea56d4a finished at
  23:05:21.939699 UTC with LANGUAGE_VALIDATION_STRICT_CONSENSUS_INCONCLUSIVE after
  six windows. No language certificate is claimed, and no retry was forced.

Integration, production deployment and full intake replay remain pending.
The separate series inventory query timeout is not resolved by this movie fix.
