# DB branded-email delivery

Security notices and provider-correct trial reminders use one durable pipeline:

1. the originating database transaction calls `norva_enqueue_branded_email`;
2. PostgreSQL freezes recipient, sender, reply-to, subject, HTML, text and tags in
   `cloud_branded_email_outbox`;
3. the minutely `norva-branded-email-delivery` cron wakes
   `norva-branded-email-worker` only when a row is due;
4. the worker leases at most four rows and sends their exact payload to Resend;
5. Resend's response is acknowledged with a lease CAS. Transient failures back
   off exponentially; permanent/exhausted failures become dead letters.

No database transaction calls Resend. `pg_net` only wakes the Edge worker.

## Guarantees

- The existing seven-argument `norva_send_branded_email(...)` signature remains
  available, but now performs only a transactional outbox insert.
- Password, email-address and new-device triggers use explicit non-PII flows and
  stable dedup keys. An enqueue failure is a PostgreSQL warning and never blocks
  the underlying security operation.
- A future trial reminder's dedup row and email outbox row commit atomically. A
  queue failure aborts the trial job transaction, so a reminder key cannot be
  consumed without a durable delivery.
- Each immutable `delivery_key` is the Resend `Idempotency-Key`. If Resend accepts
  an email but the SQL acknowledgement is ambiguous, the processing lease is left
  intact and replay resolves to the original provider email.
- Every email contains HTML and plain text, `Reply-To: support@norva.tv`, and only
  `category=transactional` plus one stable `flow` tag. Email, user id, ticket or
  free-form content never appear in tags.
- Recipient and message bodies are erased immediately after Resend acceptance.
  Dead letters retain their frozen payload so operators can safely requeue them;
  all sent/dead-letter rows are pruned after 90 days.

Pre-migration rows in `cloud_trial_reminder_deliveries` deliberately remain with
`email_delivery_id IS NULL`: their old fire-and-forget outcome is unknowable and
automatically replaying them could duplicate a delivered reminder.

## Runtime configuration

The worker requires the same Edge secrets already used by other transactional
senders:

- `RESEND_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NORVA_CRON_SHARED_SECRET` (also stored in DB Vault for the cron request)

The retired DB-side `resend_api_key` Vault copy is no longer read by
`norva_send_branded_email`. A missing Edge Resend key leaves rows pending and does
not consume delivery attempts.

## Operations

Health summary (service role only):

```sql
select public.branded_email_delivery_health();
```

Inspect actionable rows without exposing bodies in routine output:

```sql
select id, flow, state, attempt_count, next_attempt_at,
       last_http_status, last_error, dead_lettered_at
from public.cloud_branded_email_outbox
where state <> 'sent'
order by created_at;
```

After correcting a permanent cause, requeue one dead letter:

```sql
select public.requeue_branded_email_delivery('<outbox-uuid>'::uuid);
```

This RPC deliberately returns `false` for
`ambiguous_delivery_after_idempotency_window`. Resend only retains an
idempotency key for 24 hours, so that row must first be reconciled in the Resend
delivery log. Only after an operator proves it was not delivered may they change
the diagnostic to `operator_confirmed_not_delivered` and use the normal requeue.
Never blindly replay an expired ambiguous row.

Run the worker manually:

```bash
curl -fsS -X POST \
  https://api.norva.tv/functions/v1/norva-branded-email-worker/cron/drain \
  -H "Authorization: Bearer $NORVA_CRON_SHARED_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

An accepted email is only provider acceptance. Final delivery/bounce/complaint
continues to come from the signed Resend webhook ledger.
