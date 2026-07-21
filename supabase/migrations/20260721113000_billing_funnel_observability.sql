-- Authoritative billing funnel observability.
--
-- One-time conversion stages use their first immutable event per user. Recurring
-- stages retain one user/day so the 30-day admin rollup measures actual activity.
-- Anonymous landing views remain in the consent-gated marketing stack.

create or replace view public.norva_funnel_daily as
with
checkout_events as (
  select user_id, created_at as at
  from public.cloud_revolut_orders
  where kind in ('trial_setup', 'resubscribe')
  union all
  select user_id, created_at
  from public.cloud_billing_ledger
  where provider = 'stancer' and kind in ('trial_setup', 'resubscribe')
),
authorization_events as (
  select user_id, coalesce(finalized_at, last_reconciled_at, updated_at, created_at) as at
  from public.cloud_revolut_orders
  where kind in ('trial_setup', 'resubscribe')
    and upper(coalesce(state, '')) in ('AUTHORISED', 'AUTHORIZED', 'COMPLETED')
  union all
  select user_id, coalesce(updated_at, created_at)
  from public.cloud_billing_ledger
  where provider = 'stancer'
    and kind in ('trial_setup', 'resubscribe')
    and lower(coalesce(status, '')) in ('authorized', 'to_capture', 'captured')
),
activation_events as (
  -- Card-backed trial activation is retained in this historical field even
  -- after the projection later becomes active/expired.
  select user_id, trial_consumed_at as at
  from public.cloud_entitlement_projection
  where trial_consumed_at is not null
  union all
  -- Checkout finalization is the proof that the temporary authorization was
  -- accepted and the local projection transition committed.
  select user_id, finalized_at
  from public.cloud_revolut_orders
  where kind in ('trial_setup', 'resubscribe')
    and finalized_at is not null
    and upper(coalesce(state, '')) in ('AUTHORISED', 'AUTHORIZED', 'COMPLETED')
  union all
  select user_id, coalesce(updated_at, created_at)
  from public.cloud_billing_ledger
  where provider = 'stancer'
    and kind in ('trial_setup', 'resubscribe')
    and lower(coalesce(status, '')) in ('authorized', 'to_capture', 'captured')
  union all
  -- New RevenueCat events carry the result of the monotonic projection CAS in
  -- _norva. Historical events predate that marker and were applied directly.
  select user_id, coalesce(processed_at, created_at)
  from public.cloud_entitlement_events
  where provider = 'revenuecat'
    and event_type in (
      'INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION',
      'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_EXTENDED', 'REFUND_REVERSED'
    )
    and coalesce(payload #>> '{_norva,projection_applied}', 'true') = 'true'
  union all
  -- Manual/system grants have no PSP event. Their immutable projection creation
  -- is the best available activation record (internal accounts are removed below).
  select user_id, created_at
  from public.cloud_entitlement_projection
  where provider in ('system', 'manual') and status = 'active'
),
post_trial_captured_payments as (
  -- RevenueCat labels the first paid transaction after a free store trial as
  -- RENEWAL. Rank captured payments across every rail so that switching from a
  -- previously-paid web rail to a store is not mistaken for a trial conversion.
  select
    l.pi_id,
    l.user_id,
    l.provider,
    l.kind,
    coalesce(l.updated_at, l.created_at) as at,
    row_number() over (
      partition by l.user_id
      order by coalesce(l.updated_at, l.created_at), l.pi_id
    ) as capture_rank
  from public.cloud_billing_ledger l
  join public.cloud_entitlement_projection p on p.user_id = l.user_id
  where l.status = 'captured'
    and l.kind in ('first_charge', 'renewal')
    and p.trial_consumed_at is not null
    and coalesce(l.updated_at, l.created_at) >= p.trial_consumed_at
),
first_post_trial_capture as (
  select pi_id, user_id, provider, kind, at
  from post_trial_captured_payments
  where capture_rank = 1
),
trial_conversion_events as (
  select user_id, applied_at as at
  from public.cloud_revolut_billing_attempts
  where kind = 'first_charge' and status = 'completed' and applied_at is not null
  union all
  select l.user_id, coalesce(l.updated_at, l.created_at)
  from public.cloud_billing_ledger l
  join public.cloud_entitlement_projection p on p.user_id = l.user_id
  where l.status = 'captured'
    and p.trial_consumed_at is not null
    and coalesce(l.updated_at, l.created_at) >= p.trial_consumed_at
    and (
      l.kind = 'first_charge'
      or exists (
        select 1
        from first_post_trial_capture first_capture
        where first_capture.pi_id = l.pi_id
          and first_capture.kind = 'renewal'
          and first_capture.provider in (
            'revenuecat', 'google_play', 'apple_app_store', 'stripe', 'web'
          )
      )
    )
),
one_time_stages as (
  select id as user_id, 'account_created'::text as stage, created_at as at
  from auth.users
  union all
  select user_id, 'source_added', min(created_at)
  from public.cloud_sources group by user_id
  union all
  select user_id, 'checkout_open', min(at)
  from checkout_events group by user_id
  union all
  select user_id, 'order_authorized', min(at)
  from authorization_events group by user_id
  union all
  select user_id, 'entitlement_active', min(at)
  from activation_events group by user_id
  union all
  select user_id, 'first_play', min(created_at)
  from public.cloud_watch_history group by user_id
  union all
  select user_id, 'trial_start', trial_consumed_at
  from public.cloud_entitlement_projection
  where trial_consumed_at is not null
  union all
  select user_id, 'trial_convert', min(at)
  from trial_conversion_events group by user_id
),
recurring_stages as (
  select user_id, 'renewal'::text as stage, applied_at as at
  from public.cloud_revolut_billing_attempts
  where kind = 'renewal' and status = 'completed' and applied_at is not null
  union all
  select user_id, 'renewal', coalesce(updated_at, created_at)
  from public.cloud_billing_ledger ledger
  where kind = 'renewal' and status = 'captured'
    and not exists (
      select 1
      from first_post_trial_capture first_capture
      where first_capture.pi_id = ledger.pi_id
        and first_capture.kind = 'renewal'
        and first_capture.provider in (
          'revenuecat', 'google_play', 'apple_app_store', 'stripe', 'web'
        )
    )
  union all
  select user_id, 'cancel', created_at
  from public.cloud_cancel_feedback
  where action = 'cancelled'
  union all
  select user_id, 'cancel', coalesce(processed_at, created_at)
  from public.cloud_entitlement_events
  where provider = 'revenuecat'
    and event_type = 'CANCELLATION'
    and coalesce(payload #>> '{_norva,projection_applied}', 'true') = 'true'
  union all
  select user_id, 'winback_return', finalized_at
  from public.cloud_revolut_orders
  where kind = 'resubscribe'
    and finalized_at is not null
    and upper(coalesce(state, '')) in ('AUTHORISED', 'AUTHORIZED', 'COMPLETED')
  union all
  select user_id, 'winback_return', coalesce(updated_at, created_at)
  from public.cloud_billing_ledger
  where provider = 'stancer' and kind = 'resubscribe' and status = 'captured'
),
stages as (
  select * from one_time_stages
  union all
  select * from recurring_stages
)
select s.at::date as day, s.stage, count(distinct s.user_id)::int as users
from stages s
where s.user_id is not null
  and s.at is not null
  and not exists (
    select 1 from public.admin_internal_accounts a where a.user_id = s.user_id
  )
group by s.at::date, s.stage;

revoke all on public.norva_funnel_daily from public, anon, authenticated;
grant select on public.norva_funnel_daily to service_role;
