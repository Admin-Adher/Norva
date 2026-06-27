-- Phase 2 (dedup-plan.md) — keystone: the PROVIDER-GLOBAL raw catalogue.
--
-- cloud_media_items is keyed (user_id, source_id, item_type, external_id), so the
-- same provider's catalogue is stored once PER USER — O(users × catalogue). Two
-- users on super8k.top = two full copies (~357 MB each). This table holds the
-- provider-derived half ONCE per file, keyed by the provider identity
-- (server_host, item_type, external_id) — the same shape as catalog_file_tracks
-- and catalog_titles. Per-user cloud_media_items will then thin to a membership
-- link (user_id, source_id, external_id, available) once reads cut over.
--
-- What lives here is provider-derived and identical for every user of that host:
-- the display fields, the metadata blob, the playback_hint (confirmed provider-
-- derived — resolvePlaybackTarget needs only this + the user's encrypted creds),
-- and the sort keys. Availability + favorites/history stay per-user.
--
-- Additive + reversible: nothing reads this yet (the read cutover is a later,
-- flag-gated step). `drop table public.catalog_media_items;` rolls it back.
-- Service-role only, like every catalog_* cache.

create table if not exists public.catalog_media_items (
  server_host        text not null,
  item_type          text not null,
  external_id        text not null,
  parent_external_id text,
  title              text,
  subtitle           text,
  poster_url         text,
  backdrop_url       text,
  metadata           jsonb not null default '{}'::jsonb,
  playback_hint      jsonb not null default '{}'::jsonb,
  added_at           bigint,
  rating_num         numeric,
  release_year       integer,
  updated_at         timestamptz not null default now(),
  primary key (server_host, item_type, external_id)
);

alter table public.catalog_media_items enable row level security;
revoke all on public.catalog_media_items from anon, authenticated;

-- Browse-grid sort support, mirroring the per-user idx_cmi_sort_* indexes but
-- keyed by provider host instead of user_id. The decisive win: at scale these
-- live ONCE per provider here, not once per user on cloud_media_items (where the
-- four sort indexes were 124 MB for a single big catalogue and would be
-- duplicated for every user). external_id is the stable pagination tiebreaker.
create index if not exists idx_catmi_sort_added  on public.catalog_media_items (server_host, item_type, added_at     desc nulls last, external_id);
create index if not exists idx_catmi_sort_rating on public.catalog_media_items (server_host, item_type, rating_num   desc nulls last, external_id);
create index if not exists idx_catmi_sort_year   on public.catalog_media_items (server_host, item_type, release_year desc nulls last, external_id);
create index if not exists idx_catmi_sort_title  on public.catalog_media_items (server_host, item_type, title, external_id);

-- Keep-best guard, mirroring catalog_titles_keep_best: the dual-write upsert (run
-- in bulk from the sync path) must never let provider-raw / null overwrite a
-- richer existing row (e.g. a TMDB-enriched title/poster). Monotone, exception-
-- guarded so a guard bug can never break a sync write. release_year is clamped to
-- a sane window. Display/text fields fill-but-don't-blank; metadata/playback_hint
-- only grow (a non-empty value never replaced by an empty one).
create or replace function public.catalog_media_items_keep_best() returns trigger
language plpgsql as $$
begin
  begin
    -- text fields: prefer incoming when it carries content, else keep existing
    new.title        := coalesce(nullif(new.title, ''),        old.title);
    new.subtitle     := coalesce(nullif(new.subtitle, ''),     old.subtitle);
    new.poster_url   := coalesce(nullif(new.poster_url, ''),   old.poster_url);
    new.backdrop_url := coalesce(nullif(new.backdrop_url, ''), old.backdrop_url);
    new.parent_external_id := coalesce(nullif(new.parent_external_id, ''), old.parent_external_id);

    -- sort keys: keep a known value rather than regress to null; clamp year
    new.added_at     := coalesce(new.added_at, old.added_at);
    new.rating_num   := coalesce(new.rating_num, old.rating_num);
    new.release_year := coalesce(new.release_year, old.release_year);
    if new.release_year is not null and (new.release_year < 1900 or new.release_year > extract(year from now())::int + 1) then
      new.release_year := old.release_year;
    end if;

    -- jsonb blobs only grow: a non-empty existing value is never replaced by empty
    if new.metadata is null or new.metadata = '{}'::jsonb then
      new.metadata := coalesce(nullif(old.metadata, '{}'::jsonb), new.metadata, '{}'::jsonb);
    end if;
    if new.playback_hint is null or new.playback_hint = '{}'::jsonb then
      new.playback_hint := coalesce(nullif(old.playback_hint, '{}'::jsonb), new.playback_hint, '{}'::jsonb);
    end if;

    new.updated_at := now();
  exception when others then
    -- never let the guard break a sync write; fall back to the incoming row
    return new;
  end;
  return new;
end; $$;

drop trigger if exists trg_catalog_media_items_keep_best on public.catalog_media_items;
create trigger trg_catalog_media_items_keep_best
  before update on public.catalog_media_items
  for each row execute function public.catalog_media_items_keep_best();
