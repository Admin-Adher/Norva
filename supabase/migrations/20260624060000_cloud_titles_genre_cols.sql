-- Denormalised genre keys for the genre-summary aggregation.
--
-- cloud_genre_summary GROUPed over `metadata->>'categoryName'` and
-- `metadata->'tmdb'->'genres'`, which forced PostgreSQL to DETOAST the large
-- `metadata` JSONB of every one of a user's ~14k titles just to read those two
-- fields. Measured cost: ~5.7s (detoast-bound, even fully cached), which breaches
-- the authenticated/authenticator role's 8s statement_timeout whenever the crawl
-- adds load — the recurring `media-genre-summary` 500 (statement timeout).
--
-- A covering index does NOT help: PostgreSQL won't index-only-scan a jsonb
-- expression here (it re-detoasts from the heap), and a function-local
-- `SET statement_timeout` can't extend a timer already armed at the outer
-- statement. The robust fix is to hold those two values in narrow columns so the
-- aggregation never touches the TOAST blob (next migration switches the RPC to
-- them; the query then runs in ~150ms with no detoast).
--
-- Columns are added NULLABLE (a catalog-only change in PG11+, instant — no table
-- rewrite). A BEFORE INSERT OR UPDATE OF metadata trigger keeps them in sync. The
-- trigger is scoped to `OF metadata`, so the every-5-min audio crawl (which writes
-- audio_languages / audio_tracks, never metadata) does NOT re-fire it — zero cost
-- on the hot write path; only the slower projection upserts (which set metadata)
-- recompute the keys.
--
-- PROD NOTE: existing rows are backfilled once by a standalone data UPDATE run
-- OUTSIDE this DDL transaction (so the ALTER's brief ACCESS EXCLUSIVE lock is not
-- held for the duration of the ~14k-row detoast). Fresh databases need no backfill
-- — the trigger populates the columns as rows are inserted.

alter table public.cloud_titles
  add column if not exists genre_category text,
  add column if not exists genre_payload  jsonb;

create or replace function public.cloud_titles_sync_genre_cols()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.genre_category := new.metadata->>'categoryName';
  new.genre_payload  := new.metadata->'tmdb'->'genres';
  return new;
end;
$$;

drop trigger if exists trg_cloud_titles_genre_cols on public.cloud_titles;
create trigger trg_cloud_titles_genre_cols
  before insert or update of metadata on public.cloud_titles
  for each row execute function public.cloud_titles_sync_genre_cols();
