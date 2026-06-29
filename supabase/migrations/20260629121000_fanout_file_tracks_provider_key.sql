-- Cross-mirror dedup: fan out a file's track map to every user owning that file by
-- PROVIDER IDENTITY, not by hostname.
--
-- A reseller hands out many URLs (DNS aliases / reverse-proxies) for ONE Xtream panel
-- (same catalogue, same content IDs). The cross-user cache keys on the cache key passed
-- by the edge (`p_server_host`), which is now the source's providerKey when known
-- (norva-source-sync writes config_hint.providerKey = hash of the panel's category
-- taxonomy), else the hostname. So the join must match a source by the SAME coalesced key.
--
-- BACKWARD-COMPATIBLE / no-op until keys populate: a source with no providerKey matches on
-- serverHost exactly as before. Once a panel's sources carry providerKey, all its mirror
-- URLs collapse to one identity and the fan-out reaches every owner of the file regardless
-- of which mirror URL they configured. Only the `owners` join condition changed vs.
-- 20260625010000_catalog_file_tracks_global_cache.sql; the UPDATE body is identical.
create or replace function public.fanout_file_tracks_to_users(
  p_server_host text, p_item_type text, p_external_id text,
  p_audio_tracks jsonb, p_subtitle_tracks jsonb,
  p_has_audio boolean, p_has_subtitle boolean
) returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if coalesce(p_server_host,'') = '' or coalesce(p_external_id,'') = '' then return 0; end if;
  with owners as (
    select distinct v.user_id, v.title_id
    from cloud_title_variants v
    join cloud_sources s on s.id = v.source_id and s.user_id = v.user_id
    where v.item_type = p_item_type
      and v.external_id = p_external_id
      and coalesce(s.config_hint->>'providerKey', s.config_hint->>'serverHost') = p_server_host
      and v.title_id is not null
  )
  update cloud_titles t set
    audio_tracks = case when p_has_audio and t.audio_probed_at is null then coalesce(p_audio_tracks,'[]'::jsonb) else t.audio_tracks end,
    audio_languages = case when p_has_audio and t.audio_probed_at is null then
      coalesce((select array_agg(distinct lang order by lang)
                from (select e->>'lang' as lang from jsonb_array_elements(coalesce(p_audio_tracks,'[]'::jsonb)) e) s
                where lang ~ '^[a-z]{2}$'), '{}'::text[])
      else t.audio_languages end,
    audio_probed_at = case when p_has_audio and t.audio_probed_at is null then now() else t.audio_probed_at end,
    subtitle_tracks = case when p_has_subtitle and t.subtitle_probed_at is null then coalesce(p_subtitle_tracks,'[]'::jsonb) else t.subtitle_tracks end,
    subtitle_probed_at = case when p_has_subtitle and t.subtitle_probed_at is null then now() else t.subtitle_probed_at end
  from owners o
  where t.user_id = o.user_id and t.id = o.title_id
    and ((p_has_audio and t.audio_probed_at is null) or (p_has_subtitle and t.subtitle_probed_at is null));
  get diagnostics v_count = row_count;
  return v_count;
end; $$;
revoke all on function public.fanout_file_tracks_to_users(text,text,text,jsonb,jsonb,boolean,boolean) from anon, authenticated;
