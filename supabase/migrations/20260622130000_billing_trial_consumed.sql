-- Cross-rail free-trial anti-abuse.
--
-- Trial ACCESS is unified automatically by RevenueCat (one entitlement per
-- account across Play / web / TV). Trial ELIGIBILITY is not: Google Play only
-- knows about Play trials and web/Stripe only about web trials, so without an
-- account-level marker a user could stack a Play trial and a web trial.
--
-- trial_consumed_at records the first time an account ever started a trial on
-- ANY billing rail. It is keyed to the Supabase user (which equals the
-- RevenueCat App User ID), so the gate follows the account, not the device or
-- the store.

alter table public.cloud_entitlement_projection
  add column if not exists trial_consumed_at timestamptz;

comment on column public.cloud_entitlement_projection.trial_consumed_at is
  'First time this account consumed a free trial on any billing rail (Play, web/Stripe, system). Used to prevent stacking trials across stores. Keyed to the account, not the device.';

-- Backfill: any account that already has a trial window recorded has, by
-- definition, already consumed its trial.
update public.cloud_entitlement_projection
  set trial_consumed_at = coalesce(trial_ends_at, current_period_end, created_at)
  where trial_consumed_at is null
    and (trial_ends_at is not null or plan_code = 'trial' or status = 'trialing');
