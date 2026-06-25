-- Subtitle track enumeration, mirroring the audio columns. Probed once (relay
-- header-parse, the SAME call as audio), persisted here, and served in the engine
-- playback payload so the client knows the tracks at load time (enables the
-- subtitle-preference restore and lists them in the CC menu) without re-probing
-- the provider per user. Best-effort; nullable/defaulted.
alter table public.cloud_titles
  add column if not exists subtitle_tracks jsonb not null default '[]'::jsonb,
  add column if not exists subtitle_probed_at timestamptz;

comment on column public.cloud_titles.subtitle_tracks is
  'Ordered subtitle tracks [{index, lang, codec, subtitleType, extractable, forced}], absolute ffmpeg stream index. Probed via the relay header-parse, served in the engine playback payload.';
