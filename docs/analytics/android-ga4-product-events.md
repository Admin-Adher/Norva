# Android GA4 product events

## Routing contract

Norva's Android phone shell owns the Firebase and Clarity SDKs. The WebView
keeps the shared product-event vocabulary, but sends each allowed event through
the origin-scoped `NorvaAnalyticsNative` channel. Browser Google/Ads and Meta
tags must never load in a Norva Android WebView, including after a page reload
with saved consent.

The consent order for a first run is:

1. persist and apply native analytics consent;
2. update `NorvaProductAnalytics` in the current page;
3. publish same-page lifecycle and business events through the native bridge.

Only event names in `NativeClarity.EVENTS` can reach the phone callback. No
email, user id, provider credential, URL, title, or arbitrary event property is
forwarded to Firebase by this bridge.

`signup_completed` is renamed to GA4's recommended `sign_up` event at the
Firebase boundary. Other allowlisted product-event names are preserved.
`begin_checkout` remains owned by the native Play Billing flow so this bridge
does not create a second canonical checkout event. Purchase collection also
remains on the existing Firebase/RevenueCat path.

## Historical truth

Hetzner PostgreSQL remains the authoritative historical record for signups,
trials, subscriptions, payments, and provider onboarding. Events that were
dropped before this Android routing fix cannot be reconstructed or backfilled
into GA4 as if they had been observed by the SDK. Reports spanning the cutover
must label pre-fix GA4 funnel counts as incomplete and reconcile them against
aggregated Hetzner cohorts.

## Verification gate

Before release, the automated contract must pass for both paths:

- first run: `Accept -> signup_completed` without a page reload;
- returning run: saved granted consent after a WebView reload.

After installing the build on a test phone, enable Firebase Analytics debug
mode for `tv.norva.phone`, manually accept consent, complete a test signup, and
confirm in Firebase DebugView that `sign_up` appears under the Android stream.
Also confirm that no `googletagmanager.com`, Google Ads, Meta Pixel, or web GA4
request is emitted by the WebView. This live DebugView check is release
evidence; passing source and contract tests alone is not production proof.
