-- Refund readiness: persist the AUTHORITATIVE Stancer payment id on each charge.
--
-- Recurring charges (norva-stancer-billing → POST /v1/checkout/) journal a SYNTHETIC
-- pi_id (`charge_<uniqueId>`) and, until now, discarded the real Stancer payment id
-- from the response. Stancer's refund API refunds a *payment* by its id, so without it
-- a past charge cannot be refunded. This column captures that id so that, the day the
-- live key lands, wiring the refund route is turnkey and every historical charge is
-- already refundable. Nullable + additive: existing rows and the trial-setup path
-- (whose pi_id is already the refundable payment_intent id) are unaffected.
alter table public.cloud_stancer_payments
  add column if not exists provider_payment_id text;

comment on column public.cloud_stancer_payments.provider_payment_id is
  'Authoritative PSP payment id used for refunds (Stancer paym_… / RC transaction id). '
  'For trial-setup rows the refundable id is pi_id itself.';
