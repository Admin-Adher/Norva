-- Phase 3 cross-user cache + async job state for AI subtitles. Keyed by providerKey + file (like
-- catalog_file_tracks), so one transcription/translation serves every user of that panel.
--   kind 'transcript'  = whisper VTT in the spoken language (lang = 'src'; real code in source_lang).
--   kind 'translation' = Argos VTT in a target language (lang = target ISO code). [Phase 3b]
-- status drives the async job: processing -> ready | failed. Service-role only.
create table if not exists public.catalog_generated_subtitles (
  provider_key text not null,
  item_type text not null,
  external_id text not null,
  kind text not null,
  lang text not null,
  status text not null default 'processing',
  vtt text,
  source_lang text,
  audio_sec int,
  segments int,
  error text,
  job_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider_key, item_type, external_id, kind, lang)
);
alter table public.catalog_generated_subtitles enable row level security;
revoke all on public.catalog_generated_subtitles from anon, authenticated;
create index if not exists idx_gensubs_job on public.catalog_generated_subtitles (job_id);
create index if not exists idx_gensubs_status on public.catalog_generated_subtitles (status) where status = 'processing';
