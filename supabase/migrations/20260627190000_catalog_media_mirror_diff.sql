-- Phase 2 (dedup-plan.md) — mirror-verify gate for the raw catalogue.
--
-- Proves the provider-global catalog_media_items is a faithful mirror of a
-- source's per-user cloud_media_items BEFORE any read/playback cutover, the same
-- role catalog_mirror_diff plays for catalog_titles. The gate that must hold to
-- flip the playback read onto the global store:
--   cloud_only = 0              (every per-user item is mirrored)
--   mismatch_playback_hint = 0  (playback resolves identically from global)
--   global_weaker_* = 0         (global never blanker than per-user)
-- A non-zero mismatch_metadata at multi-user scale is acceptable (keep-best can
-- hold the richer of two users' rows); at single-user it should also be 0.
-- Read-only, service-role only.

create or replace function public.catalog_media_mirror_diff(p_source_id uuid)
returns table(
  server_host text,
  compared bigint,
  cloud_only bigint,
  mismatch_playback_hint bigint,
  mismatch_metadata bigint,
  global_weaker_title bigint,
  global_weaker_poster bigint
)
language sql
security definer
set search_path = public
set statement_timeout to '120s'
as $$
  with src as (
    select s.config_hint->>'serverHost' as host, m.item_type, m.external_id,
           m.playback_hint, m.metadata, m.title, m.poster_url
    from cloud_media_items m
    join cloud_sources s on s.id = m.source_id
    where m.source_id = p_source_id and coalesce(s.config_hint->>'serverHost','') <> ''
  )
  select
    max(src.host),
    count(*) filter (where g.external_id is not null),
    count(*) filter (where g.external_id is null),
    count(*) filter (where g.external_id is not null and g.playback_hint is distinct from src.playback_hint),
    count(*) filter (where g.external_id is not null and g.metadata is distinct from src.metadata),
    count(*) filter (where g.external_id is not null
                       and coalesce(nullif(g.title, ''), '') = ''
                       and coalesce(nullif(src.title, ''), '') <> ''),
    count(*) filter (where g.external_id is not null
                       and coalesce(nullif(g.poster_url, ''), '') = ''
                       and coalesce(nullif(src.poster_url, ''), '') <> '')
  from src
  left join catalog_media_items g
    on g.server_host = src.host and g.item_type = src.item_type and g.external_id = src.external_id;
$$;
revoke all on function public.catalog_media_mirror_diff(uuid) from anon, authenticated;
