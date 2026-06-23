-- Cursor state for the TMDB release-year backfill (norva-source-sync /cron/backfill-years).
-- Single-row table: the backfill walks cloud_titles by id and records how far it got
-- so the job is resumable across edge invocations without re-scanning from the top.
-- Service-role only (RLS on, no policies) — it's driven by the cron endpoint, never a client.
create table if not exists public.norva_year_backfill_state (
  id smallint primary key default 1 check (id = 1),
  last_id uuid,
  done boolean not null default false,
  last_run jsonb,
  updated_at timestamptz not null default now()
);

alter table public.norva_year_backfill_state enable row level security;

insert into public.norva_year_backfill_state (id) values (1) on conflict (id) do nothing;
