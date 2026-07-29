# Telegram signup notifications

Every new row in `auth.users` creates one durable notification in
`cloud_signup_telegram_outbox`. The Auth trigger only writes PostgreSQL state:
Telegram is called by `norva-signup-notify`, first through an asynchronous
`pg_net` wake and then through the minutely retry cron if needed. Telegram
availability can therefore never block account creation.

## Enrichment window

Sign-up attribution can arrive after the Auth row, especially after an OAuth
return. Delivery therefore allows an enrichment window of at most 120 seconds.
When attribution becomes complete, it wakes the worker immediately instead of
waiting for the full window. At send time the worker reads the current Auth
confirmation state and joins the current `cloud_signup_attribution` row; it
does not copy location data into the outbox.

One logical notification is produced for an outbox row. If the 120-second
window expires before every attribution field is available, the notification
is sent with an explicit `Attribution partielle` fallback rather than being
held indefinitely. The transport caveat about a rare duplicate after an
ambiguous Telegram acknowledgement still applies below.

## Notification contents

The message uses this minimized allow-list:

- display name, when supplied at sign-up;
- masked email address, when present;
- server-controlled Auth provider and current email-confirmation state;
- sign-up application (`Navigateur Web` or `Application Android`) when known;
- Norva journey (`Compte`, `Abonnement` or `Pairing TV`) when known;
- approximate region and country, when available;
- sign-up timestamp.

The Auth user UUID is not rendered in the message body. An inline
`Ouvrir la fiche client` button provides the operational route to the
authenticated Admin interface. Its destination can contain the internal
account identifier, so that identifier can transit to Telegram as part of the
button URL even though it is not displayed as message text.

City is intentionally never sent to Telegram, even when it is available in the
Admin dashboard. Passwords, password hashes, access/refresh tokens, phone numbers
and raw IP addresses are never stored in the outbox or sent to Telegram. The
same exclusion applies to raw `user_metadata`, raw `app_metadata`, provider
credentials and arbitrary profile fields. User-provided email/name fields are
length-bounded and HTML-escaped before rendering. Successful delivery
immediately scrubs email and display name from the outbox; terminal history is
retained for 30 days.

An enriched notification is rendered along these lines:

```text
✨ Nouvelle inscription Norva

Jérémy Hernandez
jé••••@example.com

📱 Application Android
🧭 Pairing TV
🔐 Google · Compte vérifié
🌍 Île-de-France · France
   Localisation réseau approximative
🕒 29 juil. 2026 · 14:32

[ Ouvrir la fiche client ]
```

The location label must remain approximate: it is a network-edge signal, not
proof of residence. The message is sent with Telegram `protect_content`
enabled to discourage forwarding and saving. This is a Telegram client
protection, not a guarantee against screenshots or manual copying.

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

### Production rollout gate

Before enabling region/country in Telegram after any suspected bot-token
exposure, revoke and regenerate the token with `@BotFather`. Update both
`ops/hetzner/.env` and `/etc/norva-netdata/health_alarm_notify.conf`, recreate
the Edge Functions containers, reload the Netdata notifier, and verify both
delivery paths without printing the token. Updating only one consumer is not a
complete rotation. Never paste the replacement token into Git, logs, tickets or
chat history.

## Telegram-side retention

Deleting a Norva account removes or anonymizes data held by Norva according to
the account-deletion flow, but it does not retroactively delete a notification
already delivered into Telegram. Keep the destination chat restricted to the
operators who need these alerts, configure Telegram's shortest suitable
auto-delete period where available, and periodically review chat membership and
history. `protect_content` reduces casual redistribution but does not replace
those controls.

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
