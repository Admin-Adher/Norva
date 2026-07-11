-- =============================================================================
-- Revolut web-rail mapping + order journal (checkout side of the Stancer → Revolut
-- migration). Mirrors cloud_stancer_customers / cloud_stancer_payments.
-- =============================================================================
-- Revolut Merchant DOES have saved payment methods (tokenised card attached to a
-- Revolut customer, reusable for merchant-initiated renewals), so Norva stores the
-- customer id + saved payment-method id here and the plan/period/amount for the
-- renewal engine (a "plus_monthly" plan_code would violate the projection CHECK, so
-- period + amount live here, plan_code stays 'plus'/'family' on the projection).
-- Service-role only (payment mapping) — RLS on, no public policies.

CREATE TABLE IF NOT EXISTS public.cloud_revolut_customers (
  user_id             uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  revolut_customer_id text,          -- Revolut customer the saved card attaches to
  payment_method_id   text,          -- saved card token, reusable for MIT renewals
  card_last4          text,
  card_brand          text,          -- 'VISA' | 'MASTERCARD' | …
  card_exp            text,          -- "MM/YY"
  plan                text,          -- 'plus' | 'family'   (recurring plan)
  period              text,          -- 'monthly' | 'annual'
  amount_cents        integer,       -- recurring charge amount in cents (USD)
  save_offer_used_at  timestamptz,   -- one-shot cancel-flow counter-offer consumed
  discount_next_pct   integer,       -- % off the NEXT charge (applied once, then cleared)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Order journal: one row per checkout order we open with Revolut. Lets /confirm find
-- the caller's most recent order without a webhook, and feeds refunds later.
CREATE TABLE IF NOT EXISTS public.cloud_revolut_orders (
  order_id    text PRIMARY KEY,      -- Revolut order id
  public_id   text,                  -- order token handed to the RevolutCheckout widget
  user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'renewal',   -- trial_setup | first_charge | plan_change | resubscribe | card_update | renewal
  amount      integer,               -- cents
  currency    text DEFAULT 'usd',
  state       text,                  -- Revolut order state (pending/authorised/completed/…)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_revolut_orders_user ON public.cloud_revolut_orders (user_id);

ALTER TABLE public.cloud_revolut_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_revolut_orders    ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (which bypasses RLS) touches these.

-- 'revolut' is already whitelisted on cloud_entitlement_projection.provider
-- (20260711160000) and cloud_entitlement_events.provider (20260711170000).
