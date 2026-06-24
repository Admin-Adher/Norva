-- Ordered per-track audio map for MULTI files: [{"index": <absolute ffmpeg stream index>, "lang": "fr"}, ...].
-- The deduped set lives in audio_languages; this preserves ORDER so the in-browser
-- engine (libav, which cannot read per-stream language tags) can label each audio
-- stream it demuxes by mapping its absolute index -> language WITHOUT a playback-time
-- probe. Populated by the audio crawl; served read-only to the player.
alter table public.cloud_titles
  add column if not exists audio_tracks jsonb;

-- Work queue for the crawl's ordered-track capture pass: titles known to carry
-- multiple audio languages (so the per-track order is worth storing) that don't yet
-- have the ordered map. Service-role only.
create or replace function public.cloud_titles_missing_ordered_audio(
  p_user_id uuid,
  p_item_type text,
  p_limit int
) returns table(id uuid, default_variant_id uuid)
language sql
security definer
set search_path = public
as $$
  select id, default_variant_id
  from public.cloud_titles
  where user_id = p_user_id
    and item_type = p_item_type
    and variant_count > 0
    and default_variant_id is not null
    and audio_tracks is null
    and (
      coalesce(cardinality(audio_languages), 0) >= 2
      or version_languages && array['multi']::text[]
    )
  order by id
  limit greatest(1, least(coalesce(p_limit, 40), 200));
$$;

revoke all on function public.cloud_titles_missing_ordered_audio(uuid, text, int) from public, anon, authenticated;
