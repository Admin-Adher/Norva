# Telegram notification routing

Approved rollout: 4 September 2026. No payment, KYC, advertising, provider-slot or entitlement policy is changed by this notification release.

## Six destinations

| Category | Bot | Notifications |
| --- | --- | --- |
| infrastructure | @norva_infrastructure_bot | Netdata operator alarms, Hetzner/DB/backups/storage/capacity, stale admin snapshot, unclassified cron failures |
| catalogue | @norva_catalogue_bot | Sources incomplete/error, playback gateway/relay, LID canary, catalogue/TMDb/language/provider crons |
| finance | @norva_finance_bot | First paid conversion, failed charge, recovered payment, billing/past-due, Revolut availability, VAT/OSS |
| partners | @norva_partners_bot | Every `partners_*` monitoring code: commissions, reversals, transfers, KYC/quota, reconciliation and manual payment actions |
| support | @norva_support_alerts_bot | New ticket, customer reply, stale support ticket, support cron |
| growth | @norva_alerts_bot (display name Norva Croissance) | Signup, **confirmed trial started**, scheduled/manual marketing results, weekly business summary, lifecycle/signup crons |

BotFather created five new bots then returned a 24-hour creation delay. Reuse of the existing Norva bot supplies the sixth independent destination; no existing token is revoked. This is not six new bots.

## Configuration

For each uppercase category set both `TELEGRAM_<CATEGORY>_BOT_TOKEN` and `TELEGRAM_<CATEGORY>_CHAT_ID` on **both** Edge replicas. `TELEGRAM_CATEGORY_ROUTING_STRICT=1` disables the legacy fallback after all routes are tested. A partially configured category never falls back. During staging, absence of both dedicated values preserves `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`.

Netdata's `TELEGRAM_BOT_TOKEN` and default recipient must point to Infrastructure. Preserve its roles and silent alarms; do not enable every alarm. Host watchdogs read the dedicated Infrastructure pair with the same strict fallback rules. Deploy `telegram-send.py` beside the **installed** capacity script, not only into the Git checkout. Storage-watch remains uninstalled unless separately requested.

Never commit credentials or print Compose's rendered environment. Preserve mode-0600 backups. Validate each token using `getMe`, require an explicit `/start` in the founder's private chat, then test receipt before switching production senders.

## Trial-start contract

`cloud_entitlement_projection` remains authoritative. An AFTER trigger records one pending outbox row per user only when status is `trialing`, `trial_consumed_at` exists and the trial end is in the future. Manual grants and internal accounts are excluded. An existing consumed trial, webhook replay, cross-device refresh and subsequent conversion do not create another notification. No historical backfill is performed.

The event includes the frozen provider, plan, start and end. The renderer labels Revolut as Web, Google Play as Google Play, and system trials as automatic Norva trials; it does not infer a platform from the user's current browser. Identity is fetched at delivery and the email is masked. No payment is described as collected for a trial.

The existing minute signup worker also drains this outbox, with a best-effort immediate transactional wake. Claims use SKIP LOCKED, a 90-second lease and exact lease-token acknowledgements. Retry-After is honored, exponential backoff is bounded, and 12 unsuccessful claims terminate in dead letter. Read `trial_telegram_delivery_health()` for counts; no personal information is returned. An ops alert reports dead letters or >15-minute pending work. Product grants must not fail when the notification enqueue fails; failures emit a safe SQLSTATE warning.

Telegram has no sendMessage idempotency key: a rare accepted-but-unacknowledged transport failure can still duplicate a delivery. The database prevents ordinary webhook replay duplicates; do not advertise exactly-once delivery. Signup and trial starts are durable; existing individual support/payment pings remain best-effort. Their routing is corrected here without changing financial state machines.

## Operational incident acknowledgements

`admin_alert_delivery_state` stores `(category, channel, key)` independently. A successful email cannot acknowledge failed Telegram delivery. Successful categories do not repeat while another fails. Recoveries use the stored category and clear only an acknowledged channel. Source flap cooldown remains six hours; overlapping LID states do not falsely heal each other. Cron failures use per-job keys instead of duplicate generic + billing summaries. Legacy state is preserved for audit and copied into Telegram-category cooldowns at migration.

Long Telegram messages are split rather than silently truncated; long formatted messages use safe plain-text chunks. Host watchdog receipts retain accepted chunk counts and deduplicate identical messages for six hours. A network-ambiguous send can still duplicate a chunk.

## Deployment / rollback / rotation

1. Apply the two additive migrations transactionally after the SQL smoke test has passed in a ROLLBACK-only transaction. No trial/test user should remain afterwards.
2. Use a clean candidate and prove all non-notification Edge files match the running release before a scoped rolling deployment. This patch does not introduce a provider-I/O protocol migration. Do not run an unrelated quiesced protocol migration or change lifecycle emergency-stop settings to deploy notifications.
3. Recreate functions2, verify health/hash/routes, then functions. Keep the previous code path and secret backup intact.
4. Verify a labelled test message in each destination, both replica environments, signup/trial health, ops category receipts, and Netdata recipient parity. Never trigger a real payment or user trial merely to test Telegram.
5. Roll back to the preceding code/config if needed; keep additive tables and pending trial rows so notifications can resume later. Old worker ignores trial rows, so monitor/redeploy before their delay becomes excessive.

The legacy `rotate-telegram-bot-token.sh` refuses strict category mode. Rotate **one category**: obtain its replacement token in BotFather, validate getMe, update only that category in the server secret store and both replicas, and verify delivery. For Infrastructure update Netdata plus host-watchdog configuration too. Keep Growth's legacy alias consistent while any legacy consumer exists. Never apply one shared token to all six routes.

Tests: `tests/telegram-category-routing.test.js`, signup transport/contracts, ops email safety, LID recovery, Partners alerting; `supabase/tests/trial_telegram_outbox_smoke.sql` verifies confirmation, replay, internal exclusions, lease CAS, Retry-After and ACLs inside rollback. The SQL fixture includes a normal paywall exposure because the existing purchase-funnel trigger requires that context; this release does not change that pre-existing trigger.

Reference: [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage).
