-- Phase-1 dedup (Gate 2B + Gate 3): make the cloud_titles -> catalog_titles mirror
-- trigger SELF-THINNING, so heavy title metadata is stored ONCE (global, per tmdb id)
-- instead of once per user.
--
-- After copying a row's metadata into the global catalog_titles cache, the trigger
-- replaces the per-user cloud_titles.metadata with an empty '{}' object. The multi-KB
-- i18n/tmdb blob is served back on every rail/grid by applyCatalogOverlay when
-- NORVA_CATALOG_READ_SOURCE=catalog_titles; the denormalised genre_category/genre_payload
-- columns survive via the preserve-unless-present genre trigger (migration
-- 20260626083903_cloud_titles_genre_cols_preserve). No edge-function rewrite needed —
-- the write path thins itself in pure SQL.
--
-- Design notes (lessons from building this):
--   * Thin to '{}' NOT null — cloud_titles.metadata is NOT NULL (default '{}'); '{}' is
--     a few inline bytes (no TOAST) so the space win is identical.
--   * pg_trigger_depth() = 1 guards the self-thin UPDATE. A statement-level AFTER trigger
--     fires ONCE PER STATEMENT even for 0 rows, so a row-level WHERE cannot terminate the
--     recursion the self-thin UPDATE creates; the depth guard runs the thin only at the
--     top-level write and the re-fire (depth 2) skips it. Terminates at depth 2.
--   * Step 1's `metadata <> '{}'` heavy-content guard means the re-fired statement (whose
--     transition table is all-'{}') cannot overwrite the cache with empty objects.
--   * EXISTS-on-catalog guard never strips a row the cache can't serve back (gap-safe).
--   * audio_languages is never touched here (owned by merge_catalog_title_audio).
--
-- Reversibility (Gate 3 is reversible, not a one-way door): the full metadata lives in
-- catalog_titles. To roll back, revert this function to mirror-only (delete step 2) then
--   update public.cloud_titles ct set metadata = c.metadata
--     from public.catalog_titles c
--    where c.item_type = ct.item_type and c.provider_tmdb_id = ct.provider_tmdb_id
--      and ct.metadata = '{}'::jsonb and c.metadata <> '{}'::jsonb;
-- (and optionally unset NORVA_CATALOG_READ_SOURCE). See docs/roadmap/dedup-plan.md.
--
-- The one-time backfill of existing rows + VACUUM FULL is a data/maintenance step (run
-- once via the runbook in dedup-plan.md), not part of this schema migration — a fresh
-- database has no rows to thin and the trigger handles new rows automatically.

create or replace function public.cloud_titles_mirror_to_catalog()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 1) Mirror heavy metadata into the global cache (rows that actually carry it).
  insert into public.catalog_titles
    (item_type, provider_tmdb_id, title, original_title, release_year,
     poster_url, backdrop_url, metadata, enriched_at, updated_at)
  select distinct on (item_type, provider_tmdb_id)
    item_type, provider_tmdb_id, title, original_title, release_year,
    poster_url, backdrop_url, metadata, now(), now()
  from changed
  where provider_tmdb_id is not null
    and provider_tmdb_id <> ''
    and provider_tmdb_id !~ '^(tt)?0+$'
    and metadata is not null
    and metadata <> '{}'::jsonb
  order by item_type, provider_tmdb_id, updated_at desc nulls last
  on conflict (item_type, provider_tmdb_id) do update set
    title          = excluded.title,
    original_title = excluded.original_title,
    release_year   = excluded.release_year,
    poster_url     = excluded.poster_url,
    backdrop_url   = excluded.backdrop_url,
    metadata       = excluded.metadata,
    updated_at     = now();

  -- 2) Thin (top-level only): replace mirrored per-user metadata with '{}'.
  if pg_trigger_depth() = 1 then
    update public.cloud_titles ct
       set metadata = '{}'::jsonb
      from changed ch
     where ct.id = ch.id
       and ct.metadata <> '{}'::jsonb
       and ch.provider_tmdb_id is not null
       and ch.provider_tmdb_id <> ''
       and ch.provider_tmdb_id !~ '^(tt)?0+$'
       and exists (
         select 1 from public.catalog_titles c
         where c.item_type = ch.item_type
           and c.provider_tmdb_id = ch.provider_tmdb_id
           and c.metadata is not null
           and c.metadata <> '{}'::jsonb
       );
  end if;
  return null;
end;
$$;
