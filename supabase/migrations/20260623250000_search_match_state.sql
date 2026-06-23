-- Cursor state for the search-based matching backfill
-- (norva-source-sync /cron/search-match). Single-row, service-role only — walks
-- the unmatched cloud_titles (no provider TMDB id), finds each on TMDB by
-- name+year, and on a strong, validated match promotes + localizes it.
create table if not exists public.norva_search_match_state (
  id smallint primary key default 1 check (id = 1),
  last_id uuid,
  done boolean not null default false,
  last_run jsonb,
  updated_at timestamptz not null default now()
);

alter table public.norva_search_match_state enable row level security;

insert into public.norva_search_match_state (id) values (1) on conflict (id) do nothing;
