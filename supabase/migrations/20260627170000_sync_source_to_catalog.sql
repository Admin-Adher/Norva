-- Phase 2 (dedup-plan.md) — sync-time dual-write (bulk, per source).
--
-- Called best-effort at the end of finalize (the "complete" phase, once per sync
-- completion) so the provider-global catalog_* tables stay auto-coherent with the
-- per-user catalogue WITHOUT a per-row trigger on the hot import path. One bulk
-- upsert per table, scoped to the just-synced source and keyed by its provider
-- host. Idempotent (keep-best merge on media_items, first-write-wins on the
-- provider-stable raw tables) — re-running a sync just refreshes.
--
-- statement_timeout is raised on the function so a big catalogue's mirror isn't
-- killed by the authenticator role's 8s cap; it runs in its own finalize isolate,
-- so the wall-clock is fine. Service-role only. Nothing reads these tables yet
-- (flag OFF), and the call is wrapped in try/catch on the caller — so a mirror
-- failure can never break a sync.

create or replace function public.sync_source_to_catalog(p_source_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout to '300s'
as $$
declare v_host text; n_media int; n_tv int; n_llc int; n_lv int;
begin
  select s.config_hint->>'serverHost' into v_host from cloud_sources s where s.id = p_source_id;
  if coalesce(v_host,'') = '' then
    return jsonb_build_object('skipped', 'no serverHost', 'source', p_source_id);
  end if;

  insert into catalog_media_items
    (server_host, item_type, external_id, parent_external_id, title, subtitle,
     poster_url, backdrop_url, metadata, playback_hint, added_at, rating_num, release_year)
  select v_host, m.item_type, m.external_id, m.parent_external_id, m.title, m.subtitle,
         m.poster_url, m.backdrop_url, m.metadata, m.playback_hint, m.added_at, m.rating_num, m.release_year
  from cloud_media_items m
  where m.source_id = p_source_id
  on conflict (server_host, item_type, external_id) do update set
     parent_external_id = excluded.parent_external_id, title = excluded.title, subtitle = excluded.subtitle,
     poster_url = excluded.poster_url, backdrop_url = excluded.backdrop_url, metadata = excluded.metadata,
     playback_hint = excluded.playback_hint, added_at = excluded.added_at,
     rating_num = excluded.rating_num, release_year = excluded.release_year;
  get diagnostics n_media = row_count;

  insert into catalog_title_variants
    (server_host, item_type, external_id, raw_title, label, language, quality, resolution,
     container_extension, poster_url, playback_hint, codec_profile, compatibility_tier, metadata)
  select v_host, v.item_type, v.external_id, v.raw_title, v.label, v.language, v.quality, v.resolution,
         v.container_extension, v.poster_url, v.playback_hint, v.codec_profile, v.compatibility_tier, v.metadata
  from cloud_title_variants v
  where v.source_id = p_source_id
  on conflict (server_host, item_type, external_id) do update set
     raw_title = excluded.raw_title, label = excluded.label, language = excluded.language,
     quality = excluded.quality, resolution = excluded.resolution, container_extension = excluded.container_extension,
     poster_url = excluded.poster_url, playback_hint = excluded.playback_hint, codec_profile = excluded.codec_profile,
     compatibility_tier = excluded.compatibility_tier, metadata = excluded.metadata, updated_at = now();
  get diagnostics n_tv = row_count;

  insert into catalog_live_logical_channels
    (server_host, logical_id, logical_key, title, lcn, section, category_id, category_name,
     poster_url, stream_icon, default_stream_id, variant_count, default_variant, variant_preview, playback_hint, metadata)
  select v_host, c.logical_id, c.logical_key, c.title, c.lcn, c.section, c.category_id, c.category_name,
         c.poster_url, c.stream_icon, c.default_stream_id, c.variant_count, c.default_variant, c.variant_preview, c.playback_hint, c.metadata
  from cloud_live_logical_channels c
  where c.source_id = p_source_id
  on conflict (server_host, logical_id) do update set
     logical_key = excluded.logical_key, title = excluded.title, lcn = excluded.lcn, section = excluded.section,
     category_id = excluded.category_id, category_name = excluded.category_name, poster_url = excluded.poster_url,
     stream_icon = excluded.stream_icon, default_stream_id = excluded.default_stream_id, variant_count = excluded.variant_count,
     default_variant = excluded.default_variant, variant_preview = excluded.variant_preview,
     playback_hint = excluded.playback_hint, metadata = excluded.metadata, updated_at = now();
  get diagnostics n_llc = row_count;

  insert into catalog_live_variants
    (server_host, logical_id, stream_id, label, external_id, rank, health_rank, title, raw_title,
     category_id, category_name, poster_url, stream_icon, playback_hint, metadata, container_extension)
  select v_host, lv.logical_id, lv.stream_id, lv.label, lv.external_id, lv.rank, lv.health_rank, lv.title, lv.raw_title,
         lv.category_id, lv.category_name, lv.poster_url, lv.stream_icon, lv.playback_hint, lv.metadata, lv.container_extension
  from cloud_live_variants lv
  where lv.source_id = p_source_id
  on conflict (server_host, logical_id, stream_id, label) do update set
     external_id = excluded.external_id, rank = excluded.rank, health_rank = excluded.health_rank, title = excluded.title,
     raw_title = excluded.raw_title, category_id = excluded.category_id, category_name = excluded.category_name,
     poster_url = excluded.poster_url, stream_icon = excluded.stream_icon, playback_hint = excluded.playback_hint,
     metadata = excluded.metadata, container_extension = excluded.container_extension, updated_at = now();
  get diagnostics n_lv = row_count;

  return jsonb_build_object('host', v_host, 'media', n_media, 'title_variants', n_tv,
                            'live_channels', n_llc, 'live_variants', n_lv);
end; $$;
revoke all on function public.sync_source_to_catalog(uuid) from anon, authenticated;
