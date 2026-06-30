-- Phase 1 import-lifecycle notifications: an event QUEUE the sync engine writes to (never sends
-- inline), swept by a digest cron that groups by (user_id, kind) within a window and sends ONE
-- Resend email per group. The unique(source_id, kind) is the idempotency guard — the engine runs
-- across dozens of self-invoked isolates, so it inserts ON CONFLICT DO NOTHING and an event fires
-- exactly once per source per kind. English-only copy (Norva is English-only). Applied live; here for
-- version control.
create table if not exists public.cloud_import_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source_id uuid not null,
  kind text not null check (kind in ('import_started','import_completed','import_failed')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','sent','skipped')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (source_id, kind)
);

create index if not exists cloud_import_notifications_pending_idx
  on public.cloud_import_notifications (created_at)
  where status = 'pending';

alter table public.cloud_import_notifications enable row level security;
revoke all on table public.cloud_import_notifications from anon, authenticated;
grant all on table public.cloud_import_notifications to service_role;
