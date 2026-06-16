-- Norva access / entitlement projection.
--
-- RevenueCat or store receipts will be the long-term source of truth. These
-- tables are a Supabase projection/cache used by Norva Cloud to make fast
-- product decisions and to fail open when billing state is temporarily
-- unverifiable.

create table if not exists public.cloud_entitlement_projection (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'system',
  provider_customer_id text,
  plan_code text not null default 'trial',
  status text not null default 'trialing',
  limits jsonb not null default '{
    "trusted_devices": 5,
    "concurrent_streams": 2,
    "sources": 2,
    "profiles": 1,
    "gateway": true,
    "cloud_sync": true,
    "metadata": true
  }'::jsonb,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  last_verified_at timestamptz,
  last_event_at timestamptz,
  fail_open_until timestamptz,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_entitlement_provider_check check (
    provider in ('system', 'manual', 'revenuecat', 'google_play', 'apple_app_store', 'web', 'stripe')
  ),
  constraint cloud_entitlement_plan_check check (
    plan_code in ('trial', 'plus', 'family', 'premium', 'manual', 'none')
  ),
  constraint cloud_entitlement_status_check check (
    status in (
      'trialing',
      'active',
      'grace',
      'past_due',
      'cancelled_at_period_end',
      'expired',
      'revoked',
      'refunded',
      'fraud',
      'unknown'
    )
  )
);

create table if not exists public.cloud_entitlement_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'system',
  provider_event_id text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint cloud_entitlement_events_provider_check check (
    provider in ('system', 'manual', 'revenuecat', 'google_play', 'apple_app_store', 'web', 'stripe')
  )
);

create unique index if not exists cloud_entitlement_events_provider_event_uidx
  on public.cloud_entitlement_events (provider, provider_event_id)
  where provider_event_id is not null;

create index if not exists cloud_entitlement_projection_status_idx
  on public.cloud_entitlement_projection (status, current_period_end, fail_open_until);

create index if not exists cloud_entitlement_projection_verified_idx
  on public.cloud_entitlement_projection (last_verified_at desc nulls last);

create index if not exists cloud_entitlement_events_user_created_idx
  on public.cloud_entitlement_events (user_id, created_at desc);

alter table public.cloud_entitlement_projection enable row level security;
alter table public.cloud_entitlement_events enable row level security;

drop policy if exists "Users can read own entitlement projection" on public.cloud_entitlement_projection;
create policy "Users can read own entitlement projection"
  on public.cloud_entitlement_projection
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can read own entitlement events" on public.cloud_entitlement_events;
create policy "Users can read own entitlement events"
  on public.cloud_entitlement_events
  for select
  to authenticated
  using (auth.uid() = user_id);

grant select on public.cloud_entitlement_projection to authenticated;
grant select on public.cloud_entitlement_events to authenticated;
grant all on public.cloud_entitlement_projection to service_role;
grant all on public.cloud_entitlement_events to service_role;

drop trigger if exists cloud_entitlement_projection_updated_at on public.cloud_entitlement_projection;
create trigger cloud_entitlement_projection_updated_at
  before update on public.cloud_entitlement_projection
  for each row execute function public.norva_set_updated_at();
