# Subtitle-ready email delivery

The “email me when AI subtitles are ready” message is an explicitly requested transactional email. It must not depend on the transcription callback staying alive, and it must not be added to marketing audiences.

## Delivery contract

1. A viewer opts in through `generated-subtitle-notify`.
2. The per-viewer subscription is stored in `catalog_generated_subtitle_notifications`.
3. When the exact cross-user subtitle cache becomes ready with speech, a database trigger creates one `catalog_subtitle_email_deliveries` row and one in-app bell event in the same transaction.
4. A two-minute cron calls `norva-playback/subtitle-email-delivery` with `norva_cron_shared_secret`.
5. The worker leases at most four rows, resolves the current Supabase Auth email, renders the message, and freezes the exact recipient, sender, reply-to, subject, HTML, plain text, and Resend tags before network I/O.
6. Resend receives the stable outbox `delivery_key` as `Idempotency-Key`. Success requires both a 2xx response and a non-empty Resend email ID.
7. Retryable failures use exponential backoff with jitter and `Retry-After`. Permanent failures, or twelve exhausted non-ambiguous attempts, move to `dead_letter`.

Ready callbacks never send Resend inline. Immediately before transport, SQL records
`idempotency_started_at`. An accepted or otherwise ambiguous Resend request whose
database acknowledgement fails stays leased; after expiry, the same frozen request
and key may replay only inside a 23-hour safety window. It is then quarantined and
can never replay automatically after Resend's 24-hour idempotency guarantee.

## Concurrency and opt-out invariants

- `notification_id` and `delivery_key` are unique duplicate barriers.
- Claims use `FOR UPDATE SKIP LOCKED` and an expiring lease.
- Cache-ready and late-opt-in triggers queue the normal ordering immediately. The worker also performs a bounded join of pending opt-ins against ready cache rows before every claim, closing the exact MVCC crossover on the next two-minute tick without risky cross-table lock ordering.
- Deleting the opt-in cancels any pending or processing delivery and invalidates its lease.
- Both the opt-in and delivery tables have validated `auth.users ... ON DELETE CASCADE`
  foreign keys. The migration deletes pre-existing, provable Auth orphans before
  validation. A deleted Auth user therefore cannot leave a deliverable email behind;
  an account without a current email is skipped without contacting Resend.
- The legacy email field on the original opt-in is deliberately blank and existing snapshots are erased by the migration. The current Auth email is resolved on the first attempt; the resulting complete request is then frozen so retries remain idempotent.

## Message and data rules

- Default sender: `Norva Updates <updates@norva.tv>` via `NORVA_SUBTITLE_EMAIL_FROM`.
- Reply-to: `support@norva.tv` via `NORVA_EMAIL_REPLY_TO`.
- Multipart HTML and plain text are mandatory.
- Resend tags are stable and contain no user, title, provider, or email data:
  - `category=transactional`
  - `flow=subtitle_ready`
- The CTA accepts HTTPS only and otherwise falls back to `https://norva.tv`.
- The template uses generic “title” wording so it works for movies and series.
- A successful, skipped, or cancelled delivery immediately erases its frozen recipient and message bodies. Terminal outbox records are deleted after 30 days. RLS is enabled and only `service_role` has table or function access.
- Terminal delivery also erases optional title/source/series context. Provider
  responses are allowlisted and email/credential-redacted again inside SQL, not
  trusted merely because the current worker already sanitizes them.
- This explicit service email has no marketing unsubscribe. It does not bypass, alter, or enroll the user in product-and-offer consent.

## Safe rollout order

Do not deploy the migration first while the old callback sender is live: the trigger could queue an email while the old code also sends it inline.

1. Deploy the updated `norva-playback` function first. During this short window, ready notifications remain pending because the queue RPC does not exist yet; no email is lost.
2. Apply `20260722001000_subtitle_email_delivery_outbox.sql`. Its backfill queues pending opt-ins whose subtitle cache is already ready, and it registers the worker cron.
3. Confirm the cron endpoint returns counts and that pending rows progress to `sent`, `skipped`, retry, or `dead_letter`.

No deployment is performed by the code change itself.

## Operations

Health snapshot:

```sql
select status, delivery_uncertain, count(*) as deliveries,
       min(created_at) as oldest_created,
       min(next_attempt_at) filter (where status = 'pending') as next_due
from public.catalog_subtitle_email_deliveries
group by status, delivery_uncertain
order by status, delivery_uncertain;
```

Dead-letter inspection (do not export recipient or frozen body fields):

```sql
select id, delivery_key, attempt_count, last_http_status,
       left(last_error, 300) as last_error, dead_lettered_at,
       delivery_uncertain, idempotency_started_at, quarantined_at
from public.catalog_subtitle_email_deliveries
where status = 'dead_letter'
order by dead_lettered_at desc
limit 100;
```

To retry a corrected operational failure, reset only selected rows after the root cause is fixed. Keep the frozen request and stable key:

```sql
update public.catalog_subtitle_email_deliveries
set status = 'pending', next_attempt_at = now(), dead_lettered_at = null,
    lease_token = null, lease_expires_at = null, updated_at = now()
where id = '<reviewed-delivery-id>' and status = 'dead_letter'
  and quarantined_at is null and not delivery_uncertain;
```

Never reopen a quarantined or uncertain row with this query. First reconcile it
manually against Resend. Once 24 hours elapsed, the historical key no longer
protects a replay from producing a duplicate; any proven necessary resend is an
explicit operator action with a new documented key.

Monitor `dead_letter`, oldest pending age, retry rate, missing Resend IDs, and acknowledgement failures. Alerts and dashboards must use delivery IDs/keys, never recipient addresses or title labels.
