# Customer security and service notices

These transactional notices use the existing illustrated Norva email renderer and durable Postal outbox. They do not modify marketing consent, prices, payments, entitlements, or the provider-access rollout.

## Confirmed unusual sign-in

GoTrue v2.189.0 calls the private PostgreSQL password-verification hook. Five failed password checks within a 15-minute window establish a candidate only when a correct password is subsequently supplied. An actual `login` audit event must then be committed within 60 seconds. The outbox insertion belongs to that login transaction.

Failed checks alone, ordinary refresh-token revocations and repeated logins during the 24-hour cooldown produce no message. The hook never rejects a login. It stores only a per-account counter and timestamps; notification failures are logged without credentials. This is a specific risk signal, not a claim that every compromised account can be detected.

## Playback incident and recovery

The existing 15-minute operations sweep probes the documented gateway and relay health endpoints. Two matching observations separated by at least ten minutes and no more than 25 minutes are required. Unknown or malformed responses cannot confirm recovery. Internal Telegram alerts retain their independent delivery path.

The audience consists only of accounts with gateway sessions or relay playback sessions during the affected interval, including a ten-minute lookback. Each incident sends at most one initial notice and one recovery notice per account. Batches contain at most 100 new recipients. A recovery follows a successfully sent initial notice; an initial notice never attempted before recovery is canceled and scrubbed. Delivery attempts already handed to Postal retain their existing idempotency and acknowledgement semantics.

## Subscription price notice

The customer mapping emits a notice when the recurring price changes while the plan and period stay the same, including exhaustion of promotional periods. A future price-only change can also be announced when recorded without a user checkout. Existing checkout/plan-change confirmations remain authoritative for user-requested plan changes.

The notice includes the previous and new recurring USD amounts, billing period, future renewal date in UTC, and account-management link. One-time discounts remain separate. Editing the catalogue's `billing_prices` table does not notify grandfathered subscribers. This implementation never edits a price or executes a payment.

## Deployment and verification

1. Run `proof-customer-notices-20260909.py` with the migration, bootstrap, integration assertions and renderer sources in `notice-proof/`. It creates an internal Docker network with disposable PostgreSQL and the same GoTrue image as production, without published ports or email transport.
2. Run `apply-customer-notices-20260909.py preview`, then `apply`. The migration leaves all three new circuits disabled and checks ACL/RLS and unrelated runtime state.
3. Stage and deploy `functions`, `functions2`, then `auth` with `deploy-customer-notices-20260909.py`. Live unrelated files, environment variables, signing secrets and images are preserved. Each service has a rollback to its prior compose configuration if readiness fails.
4. Inspect the four clearly labeled internal email previews. Activate with `apply-customer-notices-20260909.py activate`, then `verify` and inspect the next operations sweep. Admin Marketing → Notifications → Automatiques lists the three circuits and their database enablement state.

To stop these new notices, set their booleans in `norva_notices.runtime` to false. Disabling the password hook environment is optional when that database gate is off. Keep the private schema and delivery history when rolling back an already active release.

Deferred account export is not offered in the current product; there is no asynchronous export-ready event to wire. Existing immediate administrative CSV exports remain unchanged.
