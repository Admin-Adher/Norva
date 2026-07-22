# Resend Contacts data operations

Norva is the source of truth. Resend receives a deliberately small projection
for Broadcast eligibility and personalization; it never receives provider
credentials, catalog titles, payment identifiers, raw Norva user UUIDs or exact
signup/activity timestamps.

## Trust boundary

- Public Edge runtimes receive only the domain-scoped `RESEND_API_KEY` used to
  send email.
- The always-on `resend-contact-worker` is private: no listener, no published
  port, read-only filesystem, dropped capabilities and Docker-internal
  PostgREST access.
- It is the only application runtime that receives
  `RESEND_MANAGEMENT_API_KEY`. The taxonomy provisioning and key-rotation
  scripts use the same host-only credential.
- Contacts are team-wide in Resend. Provisioning and projection remain disabled
  until `RESEND_DEDICATED_TEAM_CONFIRMED=true` confirms that BuildTrack is on a
  different team.

## Processing contract

Every cycle runs in this order:

1. Refresh at most 25 stale local projections with
   `norva_reconcile_resend_contacts`.
2. Load and validate all managed taxonomy IDs before leasing work.
3. Lease at most 12 desired-state rows with `SKIP LOCKED` for 180 seconds.
4. Sequentially patch/create the contact, reconcile every managed segment and
   set the consent Topic, with at least 300 ms between Resend calls and 300 ms
   between contacts.
5. Acknowledge only through the revision + lease-token CAS. An ambiguous ack is
   never followed by an immediate duplicate remote write; lease expiry recovers
   it.
6. Record counts-only health in the database and an atomic `/tmp` heartbeat used
   by Docker healthcheck.

Opt-outs, stale addresses and suppressions are ordered first by the claim RPC.
Failures back off from about 30 seconds to six hours and are retried indefinitely
because a delayed revocation must not be dropped. A permanent bounce or provider
suppression re-enqueues the contact immediately without rewriting consent;
resolution re-enqueues it again. Complaints also revoke consent.

## Canonical segments

| Segment | Exact meaning |
|---|---|
| `internal-pilots` | explicit system/pilot account; never marketing-eligible |
| `onboarding` | customer, usable identity, entitlement none/trial/active, before first ready catalog |
| `trialing` | entitlement is trialing |
| `active-subscribers` | entitlement is active |
| `cancel-scheduled` | cancellation scheduled; intentionally separate from active subscribers |
| `payment-recovery` | grace or past due |
| `churned` | expired |
| `blocked-suppressed` | revoked, refunded or fraud |
| `catalog-ready` | at least one ready source and identity not blocked |

The lifecycle-state segments (`trialing`, `active-subscribers`,
`cancel-scheduled`, `payment-recovery`, `churned`, `blocked-suppressed`) are
mutually exclusive. `catalog-ready` is an orthogonal product-readiness cohort.

The only Topic is `product-news-offers`, default `opt_out`. Effective opt-in
requires explicit consent evidence, a confirmed and non-banned email identity,
no internal-account marker, no active local suppression and no terminal
revoked/refunded/fraud entitlement. The consent ledger is not erased when
effective eligibility becomes false.

## Remote data dictionary (v3)

| Property | Shape | Purpose |
|---|---|---|
| `norva_contact_key` | SHA-256 pseudonym | stable correlation without exposing Auth UUID |
| `account_class` | `internal` / `customer` | system-account exclusion |
| `identity_state` | `created` / `email_verified` / `disabled` | identity quality |
| `entitlement_state` | bounded lifecycle enum | subscription journey |
| `plan`, `billing_provider` | bounded identifiers | plan/rail analysis |
| `onboarding_stage`, `catalog_health` | bounded product cohorts | activation journey |
| `source_count`, `ready_source_count` | integer counts | catalog readiness |
| `engagement_stage` | `never_played`, 7/30/90-day buckets | recency without a timestamp |
| `signup_cohort` | `YYYY-MM` | acquisition cohort without exact signup time |
| `locale`, `country_code` | normalized locale / ISO-like country | localized communication |

The provisioning script deletes the deprecated v2 property definitions
`norva_user_id`, `signup_at` and `last_active_at`, which removes those stored
values team-wide. It cursor-paginates every Resend list. GETs may retry; a
non-idempotent POST is attempted once and then reconciled by re-listing before a
safe failure.

## Activation and operations

From `ops/hetzner`, after applying migrations:

```bash
# Keep worker disabled while provisioning the dedicated team.
sed -i 's/^RESEND_DEDICATED_TEAM_CONFIRMED=.*/RESEND_DEDICATED_TEAM_CONFIRMED=true/' .env
ENV_FILE=.env ./scripts/provision-resend-contact-data.sh

# Only after the script reports active_taxonomy_ids=10:
sed -i 's/^RESEND_CONTACT_PROJECTION_ENABLED=.*/RESEND_CONTACT_PROJECTION_ENABLED=true/' .env
docker compose --env-file .env -f docker-compose.supabase.yml up -d resend-contact-worker
```

Operational checks:

```bash
docker compose --env-file .env -f docker-compose.supabase.yml ps resend-contact-worker
docker compose --env-file .env -f docker-compose.supabase.yml logs --tail=50 resend-contact-worker
docker exec norva-db psql -U supabase_admin -d postgres -x \
  -c 'select public.resend_contact_projection_health();'
```

Healthy means a fresh worker heartbeat, no growing opt-out backlog and bounded
`oldest_due_at`/p95 lag. `degraded` reports individual retries or an ambiguous
CAS; `error` means the cycle could not reconcile/claim safely. The old public
`/norva-lifecycle/cron/resend-contacts` path intentionally returns 404 and its
pg_cron job is unscheduled by migration `20260722004000`.

Resend uses cursor pagination with `has_more`/`after`, and contact updates only
accept pre-declared custom properties. See the official [pagination
reference](https://resend.com/docs/api-reference/pagination), [Contacts update
API](https://resend.com/docs/api-reference/contacts/update-contact), and
[Contact Properties documentation](https://resend.com/docs/dashboard/audiences/properties).

## False permanent-bounce recovery

There is intentionally no generic **Unsuppress** button. A complaint is an
explicit recipient rejection and remains blocked. A Resend/provider
`email.suppressed` event also remains blocked until the provider-side cause is
remediated. Neither can be cleared through the recovery RPC.

The only operator-recoverable case is a demonstrably false-positive
`email.bounced` event whose sanitized diagnostic type is exactly `Permanent`.
The RPC additionally requires all of the following in one transaction:

- the expected address is still the user's current Auth address;
- the Auth address is confirmed, the account exists, is not deleted and is not
  currently banned;
- mailbox ownership was re-verified after the last suppression and no more
  than seven days ago;
- the verification is either a fresh confirmation link or a verified mailbox
  reply;
- the operator supplies an opaque challenge/ticket UUID, a 20+ character
  decision reason and an attributable operator identifier.

Use only a trusted server-side operator client carrying the service-role token;
never call this RPC from the browser or expose the token in Admin UI. Example
payload for `POST /rest/v1/rpc/norva_resolve_false_permanent_email_suppression`:

```json
{
  "p_user_id": "00000000-0000-4000-8000-000000000000",
  "p_expected_email": "current-address@example.com",
  "p_verification_method": "verified_mailbox_reply",
  "p_verification_reference": "support_ticket:00000000-0000-4000-8000-000000000000",
  "p_verified_at": "2026-07-22T10:00:00Z",
  "p_resolution_reason": "Customer replied from the current mailbox after the false bounce was investigated.",
  "p_operator_actor": "ops:operator-name"
}
```

For `fresh_confirmation_link`, the reference prefix must be
`email_challenge:`. References are deliberately opaque: do not put customer
names, email addresses, message text or other support notes in them or in the
operator identifier. Keep the fuller evidence in the restricted support case.

The resolution writes an append-only
`cloud_email_suppression_resolution_audit` row before clearing the active local
suppression. The audit stores a SHA-256 pseudonym derived from the high-entropy
user UUID (never the UUID or address itself), source event/message IDs, source
timestamps, verification method/reference, reason, operator and decision time.
Its pseudonymous records expire after 400 days. Service-role access to
`cloud_email_suppressions` is read-only, so application code cannot bypass this
audit with a direct update. A later permanent bounce, complaint or provider
suppression reactivates the safety block automatically and re-enqueues the
contact projection.

Post-resolution checks:

```sql
select active, resolved_at, complaint_seen_at, provider_suppression_seen_at
from public.cloud_email_suppressions
where email = lower(btrim('<current-address>'));

select id, user_fingerprint, source_event_id, verification_method,
       verification_reference, operator_actor, resolved_at
from public.cloud_email_suppression_resolution_audit
where source_event_id = '<suppression-source-event-id>'
order by resolved_at desc;

select public.resend_contact_projection_health();
```

Expected state: `active=false`, exactly one audit record for the source event,
and a newly due contact-projection revision. Do not retry an ambiguous operator
call: first query the audit by `source_event_id`. If a fresh delivery event
arrives after resolution, investigate that new event instead of resolving it
automatically.
