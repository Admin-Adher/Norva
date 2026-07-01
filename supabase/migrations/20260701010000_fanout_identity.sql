-- Phase B: make cross-user file-track fan-out resolve on the canonical provider IDENTITY, so a probe
-- done by one reseller of a panel reaches EVERY user of that panel (mirrors + drifted keys), not just
-- users sharing the exact providerKey. Backward-compatible: p_server_host may be an identity id (new
-- code) OR a raw providerKey/host (old code / unresolved source) — both match, so this is safe to apply
-- before the norva-playback deploy. UPDATE body identical to the prior version.
CREATE OR REPLACE FUNCTION public.fanout_file_tracks_to_users(
  p_server_host text, p_item_type text, p_external_id text,
  p_audio_tracks jsonb, p_subtitle_tracks jsonb, p_has_audio boolean, p_has_subtitle boolean
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_count integer;
begin
  if coalesce(p_server_host,'') = '' or coalesce(p_external_id,'') = '' then return 0; end if;
  with owners as (
    select distinct v.user_id, v.title_id
    from cloud_title_variants v
    join cloud_sources s on s.id = v.source_id and s.user_id = v.user_id
    left join catalog_provider_identities cpi
      on cpi.provider_key = coalesce(s.config_hint->>'providerKey', s.config_hint->>'serverHost')
    where v.item_type = p_item_type
      and v.external_id = p_external_id
      and v.title_id is not null
      and (
        coalesce(s.config_hint->>'providerKey', s.config_hint->>'serverHost') = p_server_host
        or cpi.identity_id::text = p_server_host
      )
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
end; $function$;
