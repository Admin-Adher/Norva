-- Global shared title cache — FOUNDATION ONLY (steps 1 & 3 of the staged migration
-- in docs/global-title-cache-design.md). This creates the table and backfills it,
-- and the projection starts dual-writing it. The read path is NOT cut over here:
-- nothing reads catalog_titles yet, so this is additive and reversible with zero
-- impact on rails/grid/playback. The read cutover (the high-risk, high-reward step)
-- waits until there is real cross-user catalogue overlap to justify and validate it.
--
-- Keyed by the TITLE (item_type, provider_tmdb_id), not the user: the enriched
-- metadata (TMDB details, release_year, posters, i18n) is identical for every user,
-- so at scale this is stored/enriched once instead of once per user.

create table if not exists public.catalog_titles (
  item_type        text not null,
  provider_tmdb_id text not null,
  title            text,
  original_title   text,
  release_year     integer,
  poster_url       text,
  backdrop_url     text,
  metadata         jsonb not null default '{}'::jsonb,
  enriched_at      timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (item_type, provider_tmdb_id),
  -- '0' / '' / 'tt0000000' is the no-match sentinel — never a real identity.
  constraint catalog_titles_tmdb_not_sentinel
    check (provider_tmdb_id <> '' and provider_tmdb_id !~ '^(tt)?0+$')
);

-- Read/written only by edge functions via the service role (which bypasses RLS).
-- No policies => the browser (anon/authenticated) cannot touch it directly.
alter table public.catalog_titles enable row level security;

-- Backfill from the distinct matched titles already in cloud_titles. distinct on
-- keeps the most-recently-updated row per (item_type, tmdb_id) — today there is one
-- per id (single catalogue); with multiple users it dedupes to the freshest.
insert into public.catalog_titles
  (item_type, provider_tmdb_id, title, original_title, release_year,
   poster_url, backdrop_url, metadata, enriched_at, updated_at)
select distinct on (ct.item_type, ct.provider_tmdb_id)
  ct.item_type, ct.provider_tmdb_id, ct.title, ct.original_title, ct.release_year,
  ct.poster_url, ct.backdrop_url, ct.metadata, now(), now()
from public.cloud_titles ct
where ct.provider_tmdb_id is not null
  and ct.provider_tmdb_id <> ''
  and ct.provider_tmdb_id !~ '^(tt)?0+$'
order by ct.item_type, ct.provider_tmdb_id, ct.updated_at desc nulls last
on conflict (item_type, provider_tmdb_id) do nothing;
