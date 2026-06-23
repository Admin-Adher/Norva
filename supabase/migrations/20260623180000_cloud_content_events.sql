-- "What's new" feed. When a provider sync detects the catalogue changed
-- (content_signature moved), it records at most one summary event per source
-- per day here ("12 new movies · 3 new shows"). The client surfaces unseen
-- events as an in-app notification on open — the free tier's taste of the
-- auto-refresh value. Premium (later) adds push + a higher cadence.
-- Written by the edge functions (service role); read per-user via norva-cloud.
create table if not exists public.cloud_content_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source_id uuid,
  kind text not null default 'new_content',
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  seen_at timestamptz
);

create index if not exists idx_cloud_content_events_user_unseen
  on public.cloud_content_events (user_id, created_at desc) where seen_at is null;
create index if not exists idx_cloud_content_events_user_source
  on public.cloud_content_events (user_id, source_id, created_at desc);

alter table public.cloud_content_events enable row level security;
revoke all on public.cloud_content_events from anon, authenticated;
