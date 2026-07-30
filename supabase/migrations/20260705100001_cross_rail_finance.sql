-- Cross-rail finance: make admin_finance able to SEE and DIFFERENTIATE mobile
-- (Play Store / Apple via RevenueCat) revenue, not only Stancer-web.
--
-- Today every money aggregate reads Stancer-only tables (cloud_stancer_customers,
-- cloud_stancer_payments), so a `google_play` subscriber shows $0. The rail
-- dimension already exists on cloud_entitlement_projection.provider; this migration
-- adds the two things that are missing off the Stancer rail: a per-rail payments
-- journal and a recurring price/cadence on the projection.
--
-- Additive + safe: existing payment rows default to provider='stancer' (correct —
-- they ARE Stancer), existing projection rows get NULL mrr_cents/bill_period.

-- (1) cloud_stancer_payments becomes the generic cross-rail payments ledger.
alter table public.cloud_stancer_payments
  add column if not exists provider text not null default 'stancer';

alter table public.cloud_stancer_payments
  drop constraint if exists cloud_stancer_payments_provider_check;
alter table public.cloud_stancer_payments
  add constraint cloud_stancer_payments_provider_check
  check (provider in ('stancer','google_play','apple_app_store','web','stripe','revenuecat','system','manual'));

create index if not exists idx_stancer_payments_provider
  on public.cloud_stancer_payments(provider);

-- (2) Projection carries a recurring price + cadence for the non-Stancer rails
--     (Stancer keeps its own mapping in cloud_stancer_customers.amount_cents/period).
--     mrr_cents = full-period base price in cents (assume the store product's base
--     price is USD, like the Stancer plan charges); the RevenueCat webhook stamps
--     these on Play/Apple purchases. admin_finance then reads
--     coalesce(cloud_stancer_customers.amount_cents, projection.mrr_cents).
alter table public.cloud_entitlement_projection
  add column if not exists mrr_cents integer,
  add column if not exists bill_period text;

alter table public.cloud_entitlement_projection
  drop constraint if exists cloud_entitlement_projection_bill_period_check;
alter table public.cloud_entitlement_projection
  add constraint cloud_entitlement_projection_bill_period_check
  check (bill_period is null or bill_period in ('monthly','annual'));
