# Automatic TMDB enrichment

Films and series in every visible M3U/Xtream catalogue, including Norva Selection,
use the shared TMDB search/validation workflow. Imports do not require an operator
to prepare their account or a visit to a film detail page.

## Scheduling and recovery

- `norva-catalog-owner-maintenance`: every minute, calls the service-authenticated
  `norva-source-sync/cron/catalog-owner-maintenance` endpoint. It discovers new
  catalogue owners and advances existing baseline/candidate/GC jobs using the
  claim, generation, visibility, lease and checkpoint contracts already in SQL.
  Each call stops after 16 slices or 20 seconds, with 2,000 titles per slice.
- `norva-enrich-search-match`: every two minutes, up to 120 titles, concurrency 4.
- `norva-enrich-revalidate`: every five minutes, up to 120 titles, concurrency 4.
- Existing language translation, genre materialization and global TMDB reuse
  jobs remain responsible for their respective derived data.

The scheduler migration reuses the installed endpoint and secret lookup. It does
not reset a global cursor or discard inflight outcomes. Interrupted owner jobs
release their exact checkpoint; uncertain commits recover through lease expiry
and CAS. Failed TMDB requests remain retryable. A genuine unmatched result is
attempt-stamped by the existing worker (90-day retry interval).

Background owner maintenance had previously been available only as an operator
script. A September 6 audit found 84 catalogue owners but only 5 owner pointers;
the search cron was restricted to overnight hours. Selection itself passes the
internal source visibility predicate; its missing owner baseline prevented it
from entering the durable matcher. Visibility/RLS rules were not relaxed.

## Editorial metadata

Search candidates require a confidence of at least 0.90 and a year within one year
when both years are present; an explicitly confirmed TMDB poster can prove the
identity. Movie rows labelled Season/Episode are not matched to a movie by search.
Provider-supplied IDs continue through the existing multilingual validator.

Validated TMDB synopsis priority is: requested-language translation, TMDB fallback,
then provider synopsis if TMDB has none. The fallback is not automatically
translated. TMDB genres feed the existing genre taxonomy and category filters.

The preservation trigger retains only validated TMDB editorial fields when a raw
refresh for the same owner/type/identity lacks a new validation. Explicit
invalidation or a different provider TMDB ID wins. Replacement generations can
reuse that owner's active editorial metadata without updating the active payload.
Title IDs, identity keys, versions, favourites and provider routing stay stable.
Audio/subtitle evidence and declared audio tags are not derived from TMDB.

Category pages use the existing bounded language-page SQL selector with an empty
language predicate, avoiding a full runtime-title-view hydration before pagination.
The source, hidden-genre, year, rating and visibility predicates still apply.
