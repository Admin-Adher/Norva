-- Thumbs up/down title ratings (audit UX vs Netflix 2026-07-03, benchmark gap).
-- Per-profile like/dislike; one row per (profile, title), flipped or cleared by
-- the fiche buttons. Feeds future recommendation signal; keyed like cloud_favorites.
-- (Applied live via MCP; committed for record.)
create table if not exists public.cloud_title_ratings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  profile_id uuid,
  source_id text not null,
  item_type text not null,       -- 'movie' | 'series'
  item_id text not null,
  rating smallint not null,      -- 1 = thumbs up, -1 = thumbs down
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, profile_id, source_id, item_type, item_id)
);

create index if not exists cloud_title_ratings_lookup
  on public.cloud_title_ratings (user_id, profile_id, item_type);

alter table public.cloud_title_ratings enable row level security;
-- Edge functions (service role) mediate all access — no anon/authenticated policy.
