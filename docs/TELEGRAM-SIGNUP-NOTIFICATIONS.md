# Telegram signup notifications

Every new row in `auth.users` creates one durable notification in
`cloud_signup_telegram_outbox`. The Auth trigger only writes PostgreSQL state:
Telegram is called by `norva-signup-notify`, first through an asynchronous
`pg_net` wake and then through the minutely retry cron if needed. Telegram
availability can therefore never block account creation.

## Notification contents

The message contains only this allow-list:

- Auth user UUID
- email address, when present
- display name, when supplied at signup
- server-controlled Auth provider
- email-confirmation state
- signup timestamp

Passwords, password hashes, access/refresh tokens, phone numbers, IP addresses,
raw `user_metadata`, raw `app_metadata`, provider credentials and arbitrary
profile fields are never stored in the outbox or sent to Telegram. User-provided
email/name fields are length-bounded and HTML-escaped before rendering.
Successful delivery immediately scrubs email and display name from the outbox;
terminal history is retained for 30 days.

## Delivery and security

- One outbox row per `user_id` prevents duplicate enqueueing.
- Claims use `FOR UPDATE SKIP LOCKED`, a 90-second lease and exact lease-token
  compare-and-set acknowledgements.
- Transient transport, HTTP 408/425/429 and 5xx failures retry with exponential
  backoff; permanent responses enter a dead letter.
- Telegram `retry_after` is honored and remaining claimed rows are deferred.
- The Edge route accepts only `NORVA_CRON_SHARED_SECRET`, verified through
  `norva_verify_cron_secret`.
- The worker needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; when either is
  absent it does not claim rows.
- Telegram has no idempotency-key feature. A rare provider acceptance followed
  by a database acknowledgement failure can result in a duplicate retry, which
  is preferred to silently losing a signup notification.

## Operations

Health:

```sql
select public.signup_telegram_delivery_health();
```

Inspect dead letters without exposing their payload:

```sql
select id, user_id, attempt_count, last_http_status, last_error, dead_lettered_at
from public.cloud_signup_telegram_outbox
where state = 'dead_letter'
order by dead_lettered_at desc;
```

After correcting configuration, requeue a specific row:

```sql
select public.requeue_signup_telegram_delivery(<outbox_id>);
```

Manual authenticated drain:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $NORVA_CRON_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  https://api.norva.tv/functions/v1/norva-signup-notify/cron/drain \
  -d '{}'
```
