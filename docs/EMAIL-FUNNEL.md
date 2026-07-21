# Norva account-email funnel

Inventory of every account/security/lifecycle email, when it fires, and the
credentials it needs. Produced from the 2026-07-07 signup-email audit.

## What fires, and when

| Email | Mechanism | Fires on | Credential |
|---|---|---|---|
| Confirm your email / recovery / magic link / invite / email-change | edge `norva-auth-email` (Supabase **Send Email Hook**) | GoTrue auth action | env `RESEND_API_KEY` + `SEND_EMAIL_HOOK_SECRET` |
| Account deleted (transactional) | edge `norva-account-delete`; exact payload prepared before deletion, activated by `auth.users AFTER DELETE`, delivered by a leased retry cron | successful permanent self-deletion only | env `RESEND_API_KEY` + DB `norva_cron_shared_secret` |
| **Welcome / onboarding** | edge `norva-lifecycle` cron `runWelcome()` | `cloud_entitlement_projection` row with `welcome_email_at IS NULL` created < 72 h ago (the row is created when the user first reaches the app) | env `RESEND_API_KEY` |
| Trial-ending / dunning | edge `norva-lifecycle` cron (master + per-flow flags) | projection status/markers | env `RESEND_API_KEY` |
| Win-back / abandoned-checkout (marketing) | edge `norva-lifecycle`, explicit user opt-in checked again immediately before send | projection/order claim + `cloud_marketing_email_preferences` | `RESEND_API_KEY` + `NORVA_POSTAL_ADDRESS` + `NORVA_LIFECYCLE_UNSUBSCRIBE_SECRET` |
| **Password changed** (security) | DB trigger → transactional `cloud_branded_email_outbox` → edge `norva-branded-email-worker` | `AFTER UPDATE OF encrypted_password` — **guarded** (see below) | edge `RESEND_API_KEY` |
| Email changed (security) | DB trigger → same durable branded-email outbox/worker | `AFTER UPDATE OF email`; sent to the old address | edge `RESEND_API_KEY` |
| New device connected (security) | DB trigger on `cloud_devices` → same durable branded-email outbox/worker | `AFTER INSERT` | edge `RESEND_API_KEY` |
| Contact projection (not an email) | DB triggers enqueue the minimized desired state; an isolated ops worker reconciles global Contacts, operational Segments and the consent Topic through a durable outbox | signup, consent/internal-account/entitlement/catalog update, email update or account deletion | host-only `RESEND_MANAGEMENT_API_KEY` + provisioned IDs in `cloud_resend_taxonomy` |
| Delivery telemetry (not an email) | signed Resend webhook → append-only idempotent event ledger + monotonic message status + suppression safety | sent/delivered/delayed/bounced/complained/failed/suppressed/opened/clicked | edge `RESEND_WEBHOOK_SECRET`; service-only tables |

All user-facing templates are branded multipart messages (dark-theme HTML plus a
plain-text alternative).

Marketing consent is **off by default**. Authenticated users can change it on
`subscription.html`; the page calls `norva-lifecycle/preferences`. Win-back and
abandoned checkout remain disabled unless both the master flag and their own flag
are true. Every marketing message carries a signed HTTPS RFC8058 one-click link;
transactional account/security/billing messages are unaffected by an opt-out.

Contact synchronization never performs network I/O inside a database transaction.
Triggers write the latest desired state into `cloud_resend_audience_outbox`; the
private host worker refreshes a small stale cohort, leases rows with `SKIP LOCKED`,
retries transient failures with backoff, and acknowledges a revision only after a
Resend 2xx response. The former public lifecycle route returns 404. See
[`RESEND-CONTACT-OPS.md`](RESEND-CONTACT-OPS.md) for the minimized v3 dictionary,
segment definitions, health checks and activation runbook.

### Resend team isolation gate

Resend Contacts, contact properties and the global `unsubscribed` field are
team-wide. Norva currently shares its Resend team with BuildTrack, so contact
projection is intentionally fail-closed (`RESEND_CONTACT_PROJECTION_ENABLED=false`)
and the provisioning script refuses to mutate Contacts until a dedicated Norva
team is confirmed. Email delivery remains active. The full-access management key
is host-only and is never forwarded to the shared public Edge runtime. Once the
team and worker are isolated, set `RESEND_DEDICATED_TEAM_CONFIRMED=true`, provision
the taxonomy, then enable the worker. The minutely worker prioritizes opt-outs and
exposes backlog/lag metrics.

## Least-privilege Resend credentials

All email network I/O uses an Edge `RESEND_API_KEY` restricted to
`sending_access` for `norva.tv`. Database security/trial
functions only enqueue immutable rows; they no longer read the legacy Vault
`resend_api_key` or call Resend through `pg_net`. `pg_net` only wakes the worker
with the independent `NORVA_CRON_SHARED_SECRET`.

The full-access `RESEND_MANAGEMENT_API_KEY` is confined to host-side ops scripts
for key rotation/webhook setup and the isolated no-port contact worker. It must
never be injected into the shared Edge runtime or GoTrue.

Go-live requires edge `RESEND_API_KEY` plus each sender's authentication secret
(`SEND_EMAIL_HOOK_SECRET` for auth, `NORVA_CRON_SHARED_SECRET` for workers, and
`RESEND_WEBHOOK_SECRET` for delivery events). A missing email transport key leaves
branded-email rows pending without consuming attempts.

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
