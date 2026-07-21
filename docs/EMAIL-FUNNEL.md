# Norva account-email funnel

Inventory of every account/security/lifecycle email, when it fires, and the
credentials it needs. Produced from the 2026-07-07 signup-email audit.

## What fires, and when

| Email | Mechanism | Fires on | Credential |
|---|---|---|---|
| Confirm your email / recovery / magic link / invite / email-change | edge `norva-auth-email` (Supabase **Send Email Hook**) | GoTrue auth action | env `RESEND_API_KEY` + `SEND_EMAIL_HOOK_SECRET` |
| **Welcome / onboarding** | edge `norva-lifecycle` cron `runWelcome()` | `cloud_entitlement_projection` row with `welcome_email_at IS NULL` created < 72 h ago (the row is created when the user first reaches the app) | env `RESEND_API_KEY` |
| Trial-ending / dunning | edge `norva-lifecycle` cron (master + per-flow flags) | projection status/markers | env `RESEND_API_KEY` |
| Win-back / abandoned-checkout (marketing) | edge `norva-lifecycle`, explicit user opt-in checked again immediately before send | projection/order claim + `cloud_marketing_email_preferences` | `RESEND_API_KEY` + `NORVA_POSTAL_ADDRESS` + `NORVA_LIFECYCLE_UNSUBSCRIBE_SECRET` |
| **Password changed** (security) | DB trigger `norva_password_changed_trg` → `norva_notify_password_changed()` → `norva_send_branded_email()` | `AFTER UPDATE OF encrypted_password` — **guarded** (see below) | Vault secret `resend_api_key` |
| Email changed (security) | DB trigger `norva_email_changed_trg` | `AFTER UPDATE OF email` | Vault secret `resend_api_key` |
| New device connected (security) | DB trigger `norva_new_device_trg` on `cloud_devices` | `AFTER INSERT` | Vault secret `resend_api_key` |
| Marketing audience sync (not an email) | DB triggers enqueue desired state; edge `norva-lifecycle` drains a durable outbox | signup, consent update, email update or account deletion | edge `RESEND_API_KEY` + `RESEND_AUDIENCE_ID` |

All user-facing templates are branded dark-theme HTML.

Marketing consent is **off by default**. Authenticated users can change it on
`subscription.html`; the page calls `norva-lifecycle/preferences`. Win-back and
abandoned checkout remain disabled unless both the master flag and their own flag
are true. Every marketing message carries a signed HTTPS RFC8058 one-click link;
transactional account/security/billing messages are unaffected by an opt-out.

Audience synchronization never performs network I/O inside a database transaction.
Triggers write the latest desired state into `cloud_resend_audience_outbox`; the
lifecycle cron leases rows with `SKIP LOCKED`, retries transient failures with
backoff, and acknowledges a revision only after a Resend 2xx response.

## ⚠️ Two Resend credentials must be provisioned together
The **DB security triggers** read the **Vault** secret `resend_api_key`, while the
**edge** emails (welcome, confirm, lifecycle) read the **env var** `RESEND_API_KEY`.
They are independent switches. If only the Vault secret is set, security emails
send while the welcome/confirmation stay silent — i.e. a user can get a security
notice with no welcome. **Go-live checklist:** set BOTH
- Vault `resend_api_key` (Supabase → Project Settings → Vault), and
- edge env `RESEND_API_KEY` (+ `SEND_EMAIL_HOOK_SECRET` for the auth hook and
  `RESEND_AUDIENCE_ID` for marketing-audience synchronization),

or leave both unset. Never one without the other.

## Guards / fixes applied (2026-07-07)

- **`norva_password_changed_trg`** (migration `20260707190000`): the original guard
  was only `old.encrypted_password IS DISTINCT FROM new.encrypted_password`, so the
  first-ever password write (`NULL/'' → hash`) on provisioning / OAuth / invite, and
  re-submitting `/signup` for an unconfirmed email (GoTrue re-hashes), both tripped it
  — users got "password changed" at sign-up. It now also requires
  `old.encrypted_password IS NOT NULL AND <> ''`, a non-empty new hash, and
  `old.email_confirmed_at IS NOT NULL` (account already active). Still fires on a real
  recovery/settings password change. **The 2026-06-26 "hardened" migration only
  replaced the function body, not the trigger — always fix the TRIGGER's WHEN clause.**
- **`runWelcome()` internal-account exclusion**: welcome is no longer sent to accounts
  in `admin_internal_accounts` (owner / family / test), mirroring the finance/funnel
  exclusions.

## Trial-start / welcome timing (deliberate)
Welcome is keyed on the `cloud_entitlement_projection` row, which
`startTrialProjection()` creates when the user first reaches the app. The sign-up
flow redirects straight to `/app`, so the row (and thus the welcome, on the next
≤15 min cron tick) lands for every completed sign-up. Trial length lives in the edge
env `NORVA_TRIAL_DAYS` (default 7). We intentionally do **not** create the projection
from a DB trigger at confirmation: that would duplicate the trial-length config
(drift risk) and shift the projection's meaning as an "activated / reached-app"
funnel signal. Trial-clock start stays at first app reach.
