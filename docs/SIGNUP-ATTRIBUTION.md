# Signup attribution

## Why the Admin dashboard previously showed no location

The existing `Pays` field in **Admin → Clients** comes from billing only:

- RevenueCat storefront country (`store`);
- Revolut card issuing country (`card`).

A free account with no payment rail therefore correctly had no value. Google
Analytics could still report an approximate audience location because it
processes network traffic separately, but Norva did not ingest that data and did
not record the screen that created the Auth user.

The catalogue preference `preferred_content_region` and `cloud_profiles.locale`
must never be used as substitutes. They represent a content choice and a UI
locale, not a physical location.

## Data model

`public.cloud_signup_attribution` stores:

- the screen that created the account: `web` or `mobile_android`;
- the Norva journey: account, subscription, or TV pairing;
- the method: email/password, email magic link, or Google;
- an approximate Cloudflare edge country/region/city;
- capture stage and timestamp.

Android TV never appears as the creating screen. When a person scans a TV
pairing QR code, the creating screen is the companion browser or Android phone
app and the journey is `tv_pairing`.

The official Norva client hands the edge estimate to Auth. The record therefore
has `client_handoff` integrity: it is useful as an indicative aggregate product
signal, but it is not cryptographically server-attested and is never presented
as proof. It is never used for authorization, entitlement, billing, tax
residence or fraud decisions.

## Privacy boundaries

- No raw IP address.
- No full User-Agent.
- No referrer.
- No pairing code.
- No access/refresh token.
- Fine location is never copied into Supabase Auth user metadata; only the
  bounded app/journey/method labels are attached to account creation.
- Location is labelled **approximate network location**.
- City and region are masked from Admin reads exactly at 90 days, then physically
  erased by a 15-minute retention job; country remains for longer-term trends.
- The row is deleted automatically with `auth.users`.
- Billing country remains a separate field and label.

The public endpoint `/api/signup-context` runs as a Cloudflare Pages Function.
It returns only country code, region code/name and city from `request.cf`;
timezone, coordinates and postal code are intentionally discarded.

## Capture paths

| Account creation path | Initial capture |
|---|---|
| Email + password | App/journey/method are snapshotted by the DB trigger; coarse location is completed only after an authenticated immediate session or confirmation |
| Passwordless email signup | App/journey/method are snapshotted by the DB trigger; coarse location is completed after the authenticated magic-link return |
| Google web OAuth | Auth creates a pending row; the authenticated return fills it |
| Google Android ID token | Auth creates a pending row; the native authenticated return fills it |
| Android TV | No signup; pairing only |

The authenticated completion RPC can update only `auth.uid()`, only while its
row is still `pending`, and only during the first 24 hours after account
creation.

If the first-party edge-context request is temporarily unavailable, OAuth/native
capture remains pending instead of becoming terminal. The callback refreshes
the context twice and preserves a same-tab retry for a later account visit.

The filtered CSV asks for attribution using the exact exported user IDs. It
does not independently select the globally newest attribution rows, and it
omits city from the standard export.

## Historical accounts

Existing users are backfilled as `historical_backfill`. Norva deliberately does
not relabel a historical account from a later login device or infer a country
from language. Consequently, the exact signup app/location of accounts created
before this migration cannot be guaranteed retroactively. Their Google
Analytics aggregates may still be useful, but they are not joined to Auth users
unless a separate, consent-aware User-ID analytics design is introduced.

## Verification

```powershell
node --test tests/signup-attribution-dashboard.test.js
npx wrangler pages functions build functions --outfile .tmp-signup-worker.js
```

After applying the migration and deploying `main`:

1. `GET https://norva.tv/api/signup-context` returns `Cache-Control: no-store`
   and never returns an IP, coordinates or postal code.
2. Create one web email account and one Android phone test account.
3. Confirm **Admin → Clients** shows `Pays paiement` separately from
   `Inscription`.
4. Open each client record and verify the **Inscription & localisation** panel.
5. Start TV pairing, create the companion account if needed, and verify the
   creating screen is web/mobile while the journey is `Pairing TV`.
