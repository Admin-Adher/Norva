-- Phase-1 dedup (Gate 2A): make the denormalised genre trigger PRESERVE-UNLESS-PRESENT.
--
-- Previously cloud_titles_sync_genre_cols() unconditionally derived genre_category
-- and genre_payload from `metadata`, so any write that thinned metadata (Phase-1
-- dedup, Gate 2B/3) or rewrote it without the provider `categoryName` (the revalidate
-- / search-match enrichment crons, which spread `...metadata` and overwrite tmdb/i18n)
-- would WIPE the genre columns. Those two columns are the sole grouping keys of
-- cloud_genre_summary (read per-user, NOT overlaid by catalog_titles), so they MUST
-- survive on cloud_titles. genre_category in particular is the dominant signal today:
-- present on 100% of rows vs genre_payload on only the tmdb-verified ~8%.
--
-- New behaviour: derive each genre column ONLY when its source key is actually present
-- in the incoming metadata; otherwise keep the existing value.
--   * metadata thinned to '{}'                 -> both preserved
--   * metadata = {tmdb,...} without categoryName -> genre_category preserved, genre_payload refreshed
--   * full sync metadata (has both)            -> both updated
--   * explicit {categoryName:null}             -> still updates (key present)
-- Same trigger wiring (BEFORE INSERT OR UPDATE OF metadata) — no behavioural change for
-- the audio crawl (never writes metadata).

create or replace function public.cloud_titles_sync_genre_cols()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.metadata is not null then
    if new.metadata ? 'categoryName' then
      new.genre_category := new.metadata->>'categoryName';
    end if;
    if (new.metadata #> '{tmdb,genres}') is not null then
      new.genre_payload := new.metadata->'tmdb'->'genres';
    end if;
  end if;
  return new;
end;
$$;
