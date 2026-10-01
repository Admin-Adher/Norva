# Google Play retention follow-up — 1 October 2026

## Scope and activation gate

Mobile billing remains separate from Revolut. The approved offer is 20% off three monthly cycles or 10% off one annual cycle, available from three days before access ends. An explicit Google Play purchase must preserve remaining access. The server checks owner, subscription state, previous benefits in both rails over twelve months, and concurrent claims. Promotional email requires email consent; push requires its own preference and a granted Android permission. One channel per stage, at most one post-expiry reminder.

At the production audit, both `cloud_play_retention_policy` flags are false; there are zero Google Play entitlement projections, zero mobile offers and zero deliveries. No receipt, subscription date, consent or billing entitlement was fabricated for validation. Campaign activation is still gated on a real promotional Google Play purchase and its authoritative receipt.

## Store configuration

The four existing draft offers were checked and activated in the authenticated Play Console for `tv.norva.phone`:

| Product | Offer | Duration | France reduced / regular |
| --- | --- | --- | --- |
| Plus | retention-monthly-20 | three monthly cycles | EUR 3.99 / 4.99 |
| Plus | retention-annual-10 | one year | EUR 39.59 / 43.99 |
| Family | retention-monthly-20 | three monthly cycles | EUR 7.59 / 9.49 |
| Family | retention-annual-10 | one year | EUR 71.99 / 79.99 |

Each retains developer-determined eligibility and `rc-ignore-offer`, preventing automatic selection by RevenueCat's ordinary purchase flow. The observed regional discount rows match the intended percentage. Plus base plans show "Charge at next billing date". Native retention additionally requests `WITHOUT_PRORATION`, the supported same-product replacement mode; its actual effect still requires purchase verification.

The connected phone has production 1.3.28 (42), which already contains the native retention bridge. This change does not modify native purchase code or require a new APK.

## Corrections

- Authenticated, owner-filtered confirmation reads the verified purchase ledger. Client callbacks cannot grant access or declare success.
- Bounded confirmation polling and a manual confirmation retry avoid repeating payment after an ambiguous result. Recent pending claims survive re-entering settings; navigation/account changes invalidate old callbacks. Confirmed purchases refresh the authoritative access card.
- Google Play campaigns have a dedicated authenticated scheduler and SQL activation gate, independent of the disabled generic Revolut winback switches.
- Mobile UI, email and push are localized in all ten product languages. Push uses the account profile locale before legacy authentication metadata.
- The cancellation receipt preserves the verified store and sends Play subscribers to Google Play; unknown store receipts use neutral account settings. Revolut receipts retain the web subscription destination. Receipts are transactional and contain no promotion.

## Verification

- 32 focused billing, delivery, retention, consent and cancellation Node tests passed; nine additional localization context tests passed after aligning the retry label with Norva's reviewed glossary.
- Android emulator run [36875246102](https://github.com/Admin-Adher/Norva/actions/runs/36875246102): all four phone configurations passed (gesture and three-button, fonts 1.0 and 1.3), plus two TV configurations. The phone fixture checks visible terms, 44px targets, error/retry, pending status, server-confirmed completion, no second purchase, decline/focus and Revolut exclusion. These are simulated UI responses, not real store transactions.
- SQL ran against the empty schema clone `play_retention_20261001` in a Docker container with networking disabled. The migration applied successfully. Owner isolation, consent withdrawal, Postal final guard, stage deduplication, push claim, concurrent claim, verified receipt consumption and renewal cooldown passed. Store-specific cancellation receipt capture and disabled/private campaign dispatcher passed. All synthetic records rolled back.
- Production deployment and final CI results are recorded below when completed.

## Integration finding and remaining evidence

The Play Console monetization page currently shows real-time developer notifications disabled. The existing Google Cloud topic `projects/norva-ecosystem/topics/norva-rtdn` has a RevenueCat subscription. A RevenueCat login was requested to verify the receiving app before wiring and testing notifications.

Developer-determined eligibility is enforced by the official Norva flow, not independently by Google Play. It must not be described as absolute protection against modified apps or multiple identities. A real purchase must establish `offer_code`, account ownership, preserved expiry, no early billing, and webhook timing before campaigns open.

Sources: [Google subscription replacement modes](https://developer.android.com/google/play/billing/subscriptions), [RevenueCat Google Play offers](https://www.revenuecat.com/docs/subscription-guidance/subscription-offers/google-play-offers), [RevenueCat real-time notifications](https://www.revenuecat.com/docs/platform-resources/server-notifications/google-server-notifications).
