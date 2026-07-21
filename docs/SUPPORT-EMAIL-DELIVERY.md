# Support email delivery

Support email is delivered through `cloud_support_email_outbox`. The support
thread and its exact Resend request are committed in the same database
transaction, so a Resend outage cannot lose a customer message.

## Write path and idempotency

- `POST /create`, `POST /reply` and `POST /admin/reply` accept a UUID in either
  `request_id` or `X-Request-Id`. Older clients receive a generated UUID and are
  additionally protected by a short content-fingerprint lock.
- `norva_create_support_message_with_email` and
  `norva_append_support_message_with_email` take transaction-scoped advisory
  locks. A request id can identify exactly one message; conflicting reuse is an
  HTTP 409.
- The message, ticket transition and immutable multipart Resend payload commit
  together. The mutation response includes `email_delivery.state` and
  `email_delivery.request_id`; `ready` means durably queued, not delivered.
- User messages route only to `NORVA_SUPPORT_EMAIL`; agent replies resolve the
  ticket owner's current Auth email inside the transaction. Every payload has
  `Reply-To` and non-PII tags: `app=norva`, `category=transactional` and its
  direction-specific `flow`.

## Worker contract

`POST /norva-support/cron/run` requires `NORVA_CRON_SECRET` and claims at most
four rows. Claims use `FOR UPDATE SKIP LOCKED`, a lease token and compare-and-set
completion. Requests are sent sequentially with at least 300 ms between starts.
The immutable `delivery_key` is also the Resend `Idempotency-Key`.

Only a Resend 2xx response containing an email id is accepted. HTTP 408, 425,
429, 5xx, authentication failures and network ambiguity retry with bounded
exponential backoff. A 409 retries only when the provider explicitly reports an
in-flight/concurrent request; invalid idempotency-key reuse is terminal. A team
429 defers the unsent remainder of the claimed batch without consuming an
attempt.

If Resend may have accepted a request but the SQL acknowledgement is ambiguous,
the lease is deliberately left intact. Retrying with the same key is safe only
inside Resend's 24-hour idempotency window. Norva stops automatic replay at 23
hours and moves the row to `dead_letter` with
`idempotency_window_expired_manual_review`; an operator must reconcile it in
Resend before any manual action.

## Privacy and retention

- Successful acknowledgement immediately removes recipient, Reply-To, subject,
  HTML and text from the outbox.
- Provider diagnostics are allowlisted/redacted before persistence and never
  returned raw to clients.
- A dead-letter payload remains available for 14 days for remediation, then its
  addresses and free-form content are scrubbed.
- Sent and dead-letter audit rows are deleted after 90 days by
  `prune_support_email_outbox()`.
- The table is RLS-enabled and accessible only to `service_role`; user-facing
  support APIs expose no outbox payload.

## Operations

Apply `20260722002000_support_email_delivery_outbox.sql`, deploy
`norva-support`, and configure `RESEND_API_KEY`, `NORVA_CRON_SECRET`,
`NORVA_SUPPORT_EMAIL` and `SUPPORT_EMAIL_FROM`. The migration schedules the
minute worker and daily prune when `pg_cron`, `pg_net` and the Vault secret
`norva_cron_shared_secret` are available. Otherwise register the same cron route
on the host scheduler.

Useful health query:

```sql
select state, direction, count(*) as messages,
       max(attempt_count) as max_attempts,
       min(created_at) filter (where state in ('ready', 'processing')) as oldest_pending
from public.cloud_support_email_outbox
group by state, direction
order by state, direction;
```

Investigate every `dead_letter` row before its 14-day payload scrub. Never copy
the free-form body or email address into logs, tickets or analytics.
