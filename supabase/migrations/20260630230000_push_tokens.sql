-- Phase 2 native push: device FCM tokens, keyed by token (one per device+app install). Re-registering
-- the same device after an account switch updates user_id. The digest sender (norva-import-notify) reads
-- these by user_id to send an FCM push alongside the import-completed email. Service-only: the web POSTs
-- its token to an edge route that validates the user's JWT and upserts here with service role.
create table if not exists public.cloud_push_tokens (
  token text primary key,
  user_id uuid not null,
  platform text not null default 'android' check (platform in ('android','ios','web')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists cloud_push_tokens_user_idx on public.cloud_push_tokens (user_id);

alter table public.cloud_push_tokens enable row level security;
revoke all on table public.cloud_push_tokens from anon, authenticated;
grant all on table public.cloud_push_tokens to service_role;
