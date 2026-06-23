-- Cursor state for the multi-language re-validation backfill
-- (norva-source-sync /cron/revalidate). Single-row, service-role only — drives a
-- resumable pass over provider_unverified / weak titles, re-scoring them against
-- TMDB alternative_titles + translations and promoting the matches.
create table if not exists public.norva_revalidate_state (
  id smallint primary key default 1 check (id = 1),
  last_id uuid,
  done boolean not null default false,
  last_run jsonb,
  updated_at timestamptz not null default now()
);

alter table public.norva_revalidate_state enable row level security;

insert into public.norva_revalidate_state (id) values (1) on conflict (id) do nothing;
