-- Conversion-signal log for the entitlement scaffold (observe mode). Records,
-- best-effort, when a user reaches for a premium-gated feature (e.g. the
-- background auto-refresh upsell) along with the plan they were really on. This
-- is pure observability — nothing is enforced — so we can size demand before
-- committing to a paywall. Writes go through the edge functions (service role);
-- clients never touch it directly.
create table if not exists public.cloud_entitlement_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  feature text not null,
  plan_code text,
  mode text,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_cloud_entitlement_signals_feature
  on public.cloud_entitlement_signals (feature, created_at desc);
create index if not exists idx_cloud_entitlement_signals_user
  on public.cloud_entitlement_signals (user_id, created_at desc);

alter table public.cloud_entitlement_signals enable row level security;
-- No policies → only the service role (which bypasses RLS) can read/write.
revoke all on public.cloud_entitlement_signals from anon, authenticated;
