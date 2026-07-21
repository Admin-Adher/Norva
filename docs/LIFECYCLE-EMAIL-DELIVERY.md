# Lifecycle email delivery

Norva lifecycle emails no longer call Resend from the cohort scanner. Welcome,
payment-failure, win-back and abandoned-checkout messages are rendered once and
inserted into `cloud_branded_email_outbox`; the existing dedicated worker drains
that outbox every minute.

## Delivery contract

- `norva_enqueue_lifecycle_email` resolves the current Auth recipient, rejects
  pilot/system accounts and inserts a complete multipart Resend request under a
  unique semantic key (`flow + user/order + stage`). Concurrent cron runs can
  therefore only create one row.
- Marketing payloads require explicit effective consent, an HTTPS signed
  unsubscribe URL, the postal footer and RFC 8058 headers at enqueue time.
  `authorize_branded_email_delivery` checks consent again immediately before
  network I/O. Revoked or stale work is canceled and scrubbed.
- Only a Resend 2xx response carrying an email id may acknowledge delivery. The
  same transaction then advances `welcome_email_at`, `dunning_stage` /
  `dunning_last_at`, `winback_email_at`, or the abandoned-order
  `reminder_sent_at`. Enqueue never advances these business markers.
- Trial J-3/J-1 jobs remain provider-correct DB producers. Their dedup rows and
  outbox rows commit together, while `delivered_at` and
  `trial_reminder_email_at` are written only by the worker acknowledgement.

The worker leases at most four rows, authorizes each row, and sends sequentially
with 300 ms spacing. A team-wide 429 defers all still-unsent claims without
consuming attempts. Concurrent/in-progress Resend 409s retry; invalid or
mismatched idempotency-key 409s are terminal.

The provider window starts in the final authorization CAS immediately before
network I/O, not when a row is merely claimed. The immutable delivery key is
retained across ambiguous retries. A proven non-accepted 401/403 resets the
window so repaired credentials get a fresh attempt. Ambiguous work is never
replayed after 23 hours because Resend's key expires after 24 hours; it moves to
dead letter for manual reconciliation. Accepted and canceled payloads are
scrubbed immediately. Dead-letter content is scrubbed at 14 days and audit rows
are deleted at 90 days.

## Billing event bridge

The outbox supports `marker_kind=billing_event` for transactionally enqueued,
deduplicated events. The intended premium flows are:

- cancellation confirmed, including effective date and reactivation link;
- cancellation revoked / subscription resumed;
- plan change scheduled and plan change applied;
- payment recovered after `past_due`;
- access expired;
- refund confirmed.

`20260722003500_lifecycle_billing_event_intents.sql` attaches these flows without
a generic projection trigger. Authoritative actions first journal one immutable
`cloud_entitlement_events` row. A database trigger atomically captures a minimal,
non-PII intent; `norva-lifecycle` leases that intent, renders it and freezes it in
the branded outbox. Outbox acknowledgement remains the only delivery truth.

Connected producers:

- Revolut account cancel/resume: projection mutation and source event are one SQL
  transaction (`norva_apply_revolut_account_action`);
- Revolut plan change scheduled: checkout order id is the stable event identity;
- Revolut payment recovery and applied plan change: immutable billing cycle key;
- Revolut expiration: period boundary, with a seven-day crash-recovery sweep;
- Revolut admin refund: immutable refund ledger/order reference;
- RevenueCat Web/store cancellation, uncancellation, product-change scheduling,
  expiration, recovered renewal and effective plan change: provider event id.

RevenueCat refunds are not advertised as covered: Norva currently receives no
explicit authoritative refund event or refund ledger entry for that rail.
Likewise, `status=revoked` is a guarded model state but has no application
producer today, so no revocation email is inferred from the mutable projection.

## Operations

Apply `20260722003000_lifecycle_email_delivery_outbox.sql` and
`20260722003500_lifecycle_billing_event_intents.sql`, deploy
`norva-lifecycle` and `norva-branded-email-worker`, then keep the existing
`norva-branded-email-delivery` minute cron enabled. Monitor:

```sql
select flow, state, count(*) as emails,
       min(created_at) filter (where state in ('pending','processing')) as oldest_pending,
       max(attempt_count) as max_attempts
from public.cloud_branded_email_outbox
group by flow, state
order by flow, state;
```

Every `dead_letter` row requires reconciliation before the 14-day payload scrub.
Never replay `ambiguous_delivery_after_idempotency_window` without checking the
delivery key in Resend first.

Also monitor source intents:

```sql
select event_type, state, count(*) as intents,
       min(created_at) filter (where state in ('pending','processing')) as oldest_pending
from public.cloud_lifecycle_billing_intents
group by event_type, state
order by event_type, state;
```
