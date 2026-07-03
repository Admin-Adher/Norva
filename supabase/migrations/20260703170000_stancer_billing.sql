-- Stancer web-rail mapping + payment journal (see docs/STANCER-BILLING.md).
-- Stancer has no native subscription object, so Norva stores the card-on-file token and orchestrates
-- the trial/recurring itself. Service-role only (holds payment mapping) — RLS on, no public policies.

CREATE TABLE IF NOT EXISTS public.cloud_stancer_customers (
  user_id             uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stancer_customer_id text,
  card_token          text,          -- card_xxx, reusable for recurring charges
  card_last4          text,
  card_exp            text,          -- "MM/YY"
  plan                text,          -- 'plus' | 'family'   (recurring plan)
  period              text,          -- 'monthly' | 'annual'
  amount_cents        integer,       -- recurring charge amount in cents
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Note: cloud_entitlement_projection.plan_code is constrained to
-- (trial|plus|family|premium|manual|none) — so the plan lives there as 'plus'/'family',
-- and the period + amount live here (a "plus_monthly" plan_code would violate the check).

CREATE TABLE IF NOT EXISTS public.cloud_stancer_payments (
  pi_id       text PRIMARY KEY,      -- Stancer payment / payment_intent id
  user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'renewal',   -- trial_setup | first_charge | renewal
  amount      integer,               -- cents
  currency    text DEFAULT 'eur',
  status      text,                  -- Stancer status (authorized/captured/failed/…)
  order_id    text,                  -- our reference sent to Stancer
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stancer_payments_user ON public.cloud_stancer_payments (user_id);

ALTER TABLE public.cloud_stancer_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_stancer_payments  ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (which bypasses RLS) touches these.

-- Allow 'stancer' as an entitlement provider (the projection's provider column is white-listed).
ALTER TABLE public.cloud_entitlement_projection DROP CONSTRAINT IF EXISTS cloud_entitlement_provider_check;
ALTER TABLE public.cloud_entitlement_projection ADD CONSTRAINT cloud_entitlement_provider_check
  CHECK (provider = ANY (ARRAY['system','manual','revenuecat','google_play','apple_app_store','web','stripe','stancer']));
