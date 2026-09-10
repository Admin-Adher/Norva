# Validated TMDB catalogue regrouping

The catalogue can contain separate translated-title rows for the same validated
TMDB work. The old canonicalizer updated every generation without current write
proof, silently caught the resulting error, and attempted to delete sibling
parents. The replacement consolidates current visible membership and retains
all historical title parents and variants.

## Eligibility and preservation

- Match within one account, one item type, one nonzero TMDB ID.
- Every visible title must have `provider_verified` and its own
  `tmdbValidation.valid=true`; contradictory release years require review.
- Acquire source/head/lifecycle/epoch locks before the title locks. Recheck
  eligibility after locking and supply the current four-part write proof.
- Preserve variant IDs, source/generation, media coordinates, playback hints,
  metadata and file-language evidence. Observations follow their exact variant
  through the existing composite `ON UPDATE CASCADE` FK.
- Repoint active series episode and inventory parent pointers, without changing
  episode identities or inventory state. Retain retired/candidate generations.
- Keep every rating/operation row using the existing causal merge rules.
- Retain all title parents; re-key the visible canonical title only if its TMDB
  identity key is available. Existing watched-file fallback still resolves by
  provider/source identity.
- Compare before/after SHA-256 proofs of every file, observation, episode and
  inventory payload. A mismatch rolls back the entire group. Successful proofs
  are recorded in the private audit table.

`norva_merge_validated_tmdb_group(uuid,text,text)` and
`norva_canonicalize_titles_for_user(uuid,integer)` are maintenance functions,
available only to the database operators, not client or service-role RPCs. Both
remain `SECURITY INVOKER`. The audit table has RLS enabled and no client access.

## Release and verification

1. Save the existing function definitions and a private per-variant title mapping
   before applying `20260910064150_catalog_validated_tmdb_merge.sql`.
2. Rehearse the migration plus `tests/sql/catalog-tmdb-merge.integration.sql` in
   one transaction ending in `ROLLBACK`. Set `norva.test_catalog_user_id` to a
   fixture account containing separate validated Raya cards. The suite also
   requires the validated Paradise series and the contradictory-year fixture.
3. Apply the migration and the first guarded canary in the same transaction;
   commit only when it reports `merged` and the preservation proof passes.
4. Validate the live genre card and its version picker. Drain bounded batches
   with `select public.norva_canonicalize_titles_for_user(null,25);` under a
   statement timeout. Inspect retries before continuing a failing batch.
5. Repeat the visible-title duplicate audit, check private preservation records,
   and verify the original variant IDs still exist with unchanged source,
   generation and media coordinates.

The original overnight reconciliation remains in place. The dedicated
`norva-catalog-tmdb-merge` cron processes at most 50 eligible groups every ten
minutes after daytime enrichment, without running the heavy poster/media pass.
The batch uses an advisory lock and retries failed groups after a five-minute
backoff. Warnings and `norva_catalog_tmdb_merge_audit` replace silent failures.

```sql
select state, reason, sqlstate, count(*)
from public.norva_catalog_tmdb_merge_audit
group by state, reason, sqlstate;

select count(*) filter(where preservation_proof is not null) as proven_groups,
       sum(variants_moved) as moved_variants,
       sum(titles_consolidated) as consolidated_cards
from public.norva_catalog_tmdb_merge_audit
where state='merged';
```

## Recovery

Pause the dedicated cron before investigating unexpected retries. Do not disable
generation guards or run the former delete-based canonicalizer. Each failed
group is already rolled back. For a previously committed group, use its private
pre-release variant/title mapping with fresh generation proofs; do not overwrite
subsequent playback observations or rating revisions from a stale snapshot.

The contradictory `School Life (2019)` / `L'École buissonnière (2017)` group is
deliberately excluded. TMDB describes distinct works (`587301` and `451499`);
the provider's conflicting assignment must not be repaired by forcing all files
under a common year or language.
