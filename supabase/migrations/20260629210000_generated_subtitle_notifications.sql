-- Phase 3a — per-requester email notifications for AI (whisper) subtitles.
--
-- catalog_generated_subtitles is a CROSS-USER cache (keyed on provider_key + file),
-- so it cannot say WHO asked for a given transcript. This table records each viewer
-- who opted into an email when the transcription lands. When the gateway calls
-- /transcribe-callback and the cache row flips to 'ready', the edge matches the
-- pending rows here on the same cache key and sends one email per subscriber via
-- Resend, then marks them sent. A "no speech" result closes the row as 'skipped'
-- (nothing to show, so no email); a transcription failure closes it as 'failed'.
--
-- Service-role only (the edge function writes/reads it): RLS on, no policies, so
-- the service role bypasses RLS and anon/auth clients can't touch it directly.

create table if not exists public.catalog_generated_subtitle_notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  email        text not null,
  provider_key text not null,
  item_type    text not null,
  external_id  text not null,
  kind         text not null default 'transcript',
  lang         text not null default 'src',
  title_label  text,
  status       text not null default 'pending',  -- pending | sent | skipped | failed
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  -- One live subscription per viewer per transcript: re-opting-in upserts in place.
  unique (user_id, provider_key, item_type, external_id, kind, lang)
);

-- Callback fan-out: find pending subscribers for a finished transcript by its exact cache key.
create index if not exists catalog_gen_sub_notif_pending_idx
  on public.catalog_generated_subtitle_notifications (provider_key, item_type, external_id, kind, lang)
  where status = 'pending';

alter table public.catalog_generated_subtitle_notifications enable row level security;
