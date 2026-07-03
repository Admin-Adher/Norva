-- Checkout-abandonment relance (audit V3, P1-7): mark journal rows once the
-- one-shot "finish setting up your trial" reminder has been sent, so the
-- norva-lifecycle scan never re-emails the same abandoned checkout.
alter table if exists public.cloud_stancer_payments
  add column if not exists reminder_sent_at timestamptz;

-- Partial index for the pending-relance scan (recent, unpaid, not yet reminded).
create index if not exists cloud_stancer_payments_abandoned_idx
  on public.cloud_stancer_payments (created_at)
  where status = 'require_payment_method' and reminder_sent_at is null;
