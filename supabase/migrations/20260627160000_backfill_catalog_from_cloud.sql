-- Phase 2 (dedup-plan.md) — reconciliation primitive: dedup the existing per-user
-- cloud_* catalogue rows into the provider-global catalog_* tables, keyed by the
-- provider host (cloud_sources.config_hint->>'serverHost'). This is the bulk
-- cousin of the sync-time dual-write (added later); it runs decoupled from the
-- import hot path, so it can populate/validate the global cache without touching
-- the tuned import. Idempotent: re-running merges rather than duplicates.
--
-- media_items uses ON CONFLICT DO UPDATE so the keep-best guard merges TMDB
-- enrichment that can differ between users; the raw provider tables (variants,
-- live) are provider-stable, so first-write-wins (DO NOTHING) is correct + cheap.
-- DISTINCT ON collapses each provider key to one row inside a single pass.
-- Service-role only.

create or replace function public.backfill_catalog_from_cloud()
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_media int; n_tv int; n_llc int; n_lv int;
begin
  insert into catalog_media_items
    (server_host, item_type, external_id, parent_external_id, title, subtitle,
     poster_url, backdrop_url, metadata, playback_hint, added_at, rating_num, release_year)
  select distinct on (s.config_hint->>'serverHost', m.item_type, m.external_id)
     s.config_hint->>'serverHost', m.item_type, m.external_id, m.parent_external_id, m.title, m.subtitle,
     m.poster_url, m.backdrop_url, m.metadata, m.playback_hint, m.added_at, m.rating_num, m.release_year
  from cloud_media_items m
  join cloud_sources s on s.id = m.source_id
  where coalesce(s.config_hint->>'serverHost','') <> ''
  order by s.config_hint->>'serverHost', m.item_type, m.external_id, m.updated_at desc
  on conflict (server_host, item_type, external_id) do update set
     parent_external_id = excluded.parent_external_id, title = excluded.title, subtitle = excluded.subtitle,
     poster_url = excluded.poster_url, backdrop_url = excluded.backdrop_url, metadata = excluded.metadata,
     playback_hint = excluded.playback_hint, added_at = excluded.added_at,
     rating_num = excluded.rating_num, release_year = excluded.release_year;
  get diagnostics n_media = row_count;

  insert into catalog_title_variants
    (server_host, item_type, external_id, raw_title, label, language, quality, resolution,
     container_extension, poster_url, playback_hint, codec_profile, compatibility_tier, metadata)
  select distinct on (s.config_hint->>'serverHost', v.item_type, v.external_id)
     s.config_hint->>'serverHost', v.item_type, v.external_id, v.raw_title, v.label, v.language, v.quality, v.resolution,
     v.container_extension, v.poster_url, v.playback_hint, v.codec_profile, v.compatibility_tier, v.metadata
  from cloud_title_variants v
  join cloud_sources s on s.id = v.source_id
  where coalesce(s.config_hint->>'serverHost','') <> ''
  order by s.config_hint->>'serverHost', v.item_type, v.external_id, v.updated_at desc
  on conflict (server_host, item_type, external_id) do nothing;
  get diagnostics n_tv = row_count;

  insert into catalog_live_logical_channels
    (server_host, logical_id, logical_key, title, lcn, section, category_id, category_name,
     poster_url, stream_icon, default_stream_id, variant_count, default_variant, variant_preview, playback_hint, metadata)
  select distinct on (s.config_hint->>'serverHost', c.logical_id)
     s.config_hint->>'serverHost', c.logical_id, c.logical_key, c.title, c.lcn, c.section, c.category_id, c.category_name,
     c.poster_url, c.stream_icon, c.default_stream_id, c.variant_count, c.default_variant, c.variant_preview, c.playback_hint, c.metadata
  from cloud_live_logical_channels c
  join cloud_sources s on s.id = c.source_id
  where coalesce(s.config_hint->>'serverHost','') <> ''
  order by s.config_hint->>'serverHost', c.logical_id, c.updated_at desc
  on conflict (server_host, logical_id) do nothing;
  get diagnostics n_llc = row_count;

  insert into catalog_live_variants
    (server_host, logical_id, stream_id, label, external_id, rank, health_rank, title, raw_title,
     category_id, category_name, poster_url, stream_icon, playback_hint, metadata, container_extension)
  select distinct on (s.config_hint->>'serverHost', lv.logical_id, lv.stream_id, lv.label)
     s.config_hint->>'serverHost', lv.logical_id, lv.stream_id, lv.label, lv.external_id, lv.rank, lv.health_rank, lv.title, lv.raw_title,
     lv.category_id, lv.category_name, lv.poster_url, lv.stream_icon, lv.playback_hint, lv.metadata, lv.container_extension
  from cloud_live_variants lv
  join cloud_sources s on s.id = lv.source_id
  where coalesce(s.config_hint->>'serverHost','') <> ''
  order by s.config_hint->>'serverHost', lv.logical_id, lv.stream_id, lv.label, lv.updated_at desc
  on conflict (server_host, logical_id, stream_id, label) do nothing;
  get diagnostics n_lv = row_count;

  return jsonb_build_object('media', n_media, 'title_variants', n_tv,
                            'live_channels', n_llc, 'live_variants', n_lv);
end; $$;
revoke all on function public.backfill_catalog_from_cloud() from anon, authenticated;

-- Dedup measurement: per-table, how many per-user rows collapse to how many
-- provider-distinct rows (= storage multiplier removed at scale). dup_factor is
-- ~1 with one user/provider today, and rises to ~N as N users share a host.
create or replace function public.catalog_dedup_report()
returns table(scope text, per_user_rows bigint, provider_distinct bigint, dup_factor numeric)
language sql security definer set search_path = public as $$
  select 'media_items',
         (select count(*) from cloud_media_items m join cloud_sources s on s.id=m.source_id where coalesce(s.config_hint->>'serverHost','')<>''),
         (select count(distinct (s.config_hint->>'serverHost', m.item_type, m.external_id)) from cloud_media_items m join cloud_sources s on s.id=m.source_id where coalesce(s.config_hint->>'serverHost','')<>''),
         round((select count(*) from cloud_media_items m join cloud_sources s on s.id=m.source_id where coalesce(s.config_hint->>'serverHost','')<>'')::numeric
               / nullif((select count(distinct (s.config_hint->>'serverHost', m.item_type, m.external_id)) from cloud_media_items m join cloud_sources s on s.id=m.source_id where coalesce(s.config_hint->>'serverHost','')<>''),0), 2)
  union all
  select 'live_channels',
         (select count(*) from cloud_live_logical_channels c join cloud_sources s on s.id=c.source_id where coalesce(s.config_hint->>'serverHost','')<>''),
         (select count(distinct (s.config_hint->>'serverHost', c.logical_id)) from cloud_live_logical_channels c join cloud_sources s on s.id=c.source_id where coalesce(s.config_hint->>'serverHost','')<>''),
         round((select count(*) from cloud_live_logical_channels c join cloud_sources s on s.id=c.source_id where coalesce(s.config_hint->>'serverHost','')<>'')::numeric
               / nullif((select count(distinct (s.config_hint->>'serverHost', c.logical_id)) from cloud_live_logical_channels c join cloud_sources s on s.id=c.source_id where coalesce(s.config_hint->>'serverHost','')<>''),0), 2);
$$;
revoke all on function public.catalog_dedup_report() from anon, authenticated;