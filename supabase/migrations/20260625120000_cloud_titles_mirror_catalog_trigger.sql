-- Keep the global `catalog_titles` cache in lock-step with per-user
-- `cloud_titles` title metadata, regardless of which path writes it (sync
-- dual-write, the enrichment crons /cron/search-match | /cron/revalidate |
-- /cron/backfill-years, etc.). Before this, those crons UPDATE `cloud_titles`
-- only, so `catalog_titles` drifted (catalog_mirror_diff showed ~200 per-field
-- mismatches) and the NORVA_CATALOG_READ_SOURCE read-flip was unsafe.
--
-- Implemented as a STATEMENT-level AFTER trigger with a NEW transition table, so
-- it does ONE bulk upsert per write statement — efficient even for the ~40k-row
-- full sync (no per-row overhead). Does NOT touch `catalog_titles.audio_languages`
-- (owned by merge_catalog_title_audio). Interim mechanism: once `cloud_titles` is
-- thinned (Phase 1 step 1.6) enrichment writes `catalog_titles` directly and this
-- trigger is dropped.

create or replace function public.cloud_titles_mirror_to_catalog()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.catalog_titles
    (item_type, provider_tmdb_id, title, original_title, release_year,
     poster_url, backdrop_url, metadata, enriched_at, updated_at)
  select distinct on (item_type, provider_tmdb_id)
    item_type, provider_tmdb_id, title, original_title, release_year,
    poster_url, backdrop_url, metadata, now(), now()
  from changed
  where provider_tmdb_id is not null
    and provider_tmdb_id <> ''
    and provider_tmdb_id !~ '^(tt)?0+$'   -- exclude the no-match sentinel
  order by item_type, provider_tmdb_id, updated_at desc nulls last
  on conflict (item_type, provider_tmdb_id) do update set
    title          = excluded.title,
    original_title = excluded.original_title,
    release_year   = excluded.release_year,
    poster_url     = excluded.poster_url,
    backdrop_url   = excluded.backdrop_url,
    metadata       = excluded.metadata,
    updated_at     = now();
  return null;
end;
$$;

revoke all on function public.cloud_titles_mirror_to_catalog() from public, anon, authenticated;

drop trigger if exists cloud_titles_mirror_catalog_ins on public.cloud_titles;
create trigger cloud_titles_mirror_catalog_ins
  after insert on public.cloud_titles
  referencing new table as changed
  for each statement execute function public.cloud_titles_mirror_to_catalog();

drop trigger if exists cloud_titles_mirror_catalog_upd on public.cloud_titles;
create trigger cloud_titles_mirror_catalog_upd
  after update on public.cloud_titles
  referencing new table as changed
  for each statement execute function public.cloud_titles_mirror_to_catalog();
