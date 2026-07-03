-- Cancel-flow save offer + cancellation reasons + funnel analytics (audit V4 lot).
--
-- 1) Save offer: a one-shot "stay for 50% off your next payment" counter-offer shown in the
--    cancel flow (B2C cancel flows save 20-22% of cancellations — Churnkey; discount offers
--    are accepted at ~54%). The discount is applied ONCE by the billing cron on the next
--    charge, then cleared. `save_offer_used_at` makes the offer once-per-customer.
-- 2) Cancellation feedback: reasons collected in the cancel flow, kept as history (the funnel
--    view + future product decisions read from here).
-- 3) Funnel view: every funnel stage ALREADY exists as timestamped rows in live tables — the
--    view derives daily per-stage unique-user counts retroactively, with no client tracking:
--      signup         → cloud_entitlement_projection.created_at
--      source_added   → first cloud_sources row per user
--      first_play     → first cloud_watch_history row per user
--      checkout_open  → cloud_stancer_payments (trial_setup / resubscribe intents)
--      trial_start    → cloud_entitlement_projection.trial_consumed_at
--      trial_convert  → cloud_stancer_payments kind='first_charge' captured
--      renewal        → cloud_stancer_payments kind='renewal' captured
--      cancel / save  → cloud_cancel_feedback
--      winback_return → cloud_stancer_payments kind='resubscribe' completed

alter table public.cloud_stancer_customers
  add column if not exists save_offer_used_at timestamptz,
  add column if not exists discount_next_pct integer
    check (discount_next_pct is null or (discount_next_pct between 1 and 99));

create table if not exists public.cloud_cancel_feedback (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  -- whitelisted in the edge function: too_expensive | not_using | technical | other | skipped
  reason text not null,
  -- 'cancelled' = went through with the cancellation; 'saved' = accepted the counter-offer
  action text not null check (action in ('cancelled', 'saved')),
  offer text,                -- e.g. 'discount50' when action='saved'
  status_at text,            -- projection status at the time (trialing/active/past_due/…)
  created_at timestamptz not null default now()
);

-- Service-role only: RLS on with no policies (edge functions write, dashboards read).
alter table public.cloud_cancel_feedback enable row level security;
create index if not exists cloud_cancel_feedback_created_idx
  on public.cloud_cancel_feedback (created_at desc);

-- Daily funnel: one row per (day, stage) with unique users. Service-role only.
create or replace view public.norva_funnel_daily as
select day, stage, count(distinct user_id)::int as users
from (
  select created_at::date as day, 'signup' as stage, user_id
    from public.cloud_entitlement_projection
  union all
  select first_at::date, 'source_added', user_id
    from (select user_id, min(created_at) as first_at from public.cloud_sources group by user_id) s
  union all
  select first_at::date, 'first_play', user_id
    from (select user_id, min(created_at) as first_at from public.cloud_watch_history group by user_id) w
  union all
  select created_at::date, 'checkout_open', user_id
    from public.cloud_stancer_payments where kind in ('trial_setup', 'resubscribe')
  union all
  select trial_consumed_at::date, 'trial_start', user_id
    from public.cloud_entitlement_projection where trial_consumed_at is not null
  union all
  select updated_at::date, 'trial_convert', user_id
    from public.cloud_stancer_payments where kind = 'first_charge' and status = 'captured'
  union all
  select updated_at::date, 'renewal', user_id
    from public.cloud_stancer_payments where kind = 'renewal' and status = 'captured'
  union all
  select created_at::date, 'cancel', user_id
    from public.cloud_cancel_feedback where action = 'cancelled'
  union all
  select created_at::date, 'save', user_id
    from public.cloud_cancel_feedback where action = 'saved'
  union all
  select updated_at::date, 'winback_return', user_id
    from public.cloud_stancer_payments
    where kind = 'resubscribe' and status in ('captured', 'authorized', 'to_capture')
) stages
group by day, stage;

revoke all on public.norva_funnel_daily from anon, authenticated;
