-- Real audio-track languages (ISO codes: fr, en, ar ...) observed at playback,
-- to de-opaque the "Multi" tag (multiple audio tracks without saying which).
-- Distinct from version_languages (the title-string tags): this is filled
-- progressively by the client capture path (default track from get_vod_info +
-- the demuxed track list) and AUGMENTS the tag facets in the catalog filter.
-- Additive + reversible; starts empty.
alter table public.cloud_titles
  add column if not exists audio_languages text[] not null default '{}'::text[];

create index if not exists cloud_titles_audio_languages_gin
  on public.cloud_titles using gin (audio_languages);
