# Web cancellation follow-up — 1 October 2026

## Scope

Web subscriptions billed by Revolut. No Play pricing, promotion rollout, native purchase or push campaign is changed.

## Diagnosis

The ordinary QA account's cancellation intents at 13:03:37 and 13:11:18 UTC stayed pending until the 13:15 lifecycle sweep. Their outbox rows became `sent` at 13:17:00 and 13:19:00. This is transport acknowledgement, not proof of inbox placement. Cancellation and the 8 October access boundary were already correct.

## Changes

- Cancellation wakes a dedicated authenticated billing-email producer. A minutely retry also runs independently of behavioral/marketing sweeps. Existing durable intents, leases and transport deduplication remain authoritative; mail errors cannot undo cancellation.
- Confirmation is transactional and localized in all ten product languages, using the account locale before Auth metadata. It contains access dates and a neutral subscription-management link.
- Eligible web users see a personal offer immediately after successful cancellation. Cancellation is confirmed first. Prices, duration, next price, first-charge date and an explicit keep-cancellation option are displayed. No automatic resumption.
- The existing server-owned offer is available immediately instead of starting at J−3. Existing annual/monthly terms, ownership, noncumulative pricing, twelve-month consumption limit, billing locks and cross-channel exclusions remain active.
- A separate consent-gated offer email uses the existing pre-expiry delivery key, preventing a second J−3 offer. Its final delivery gate rejects withdrawn consent, declined/accepted offers and subscriptions moved to Google Play. Closing the dialog is not acceptance; declining stops reminders for that offer.
- Signup offers a separate unchecked opt-in. Only a recent positive choice matching the authenticated, verified email can be saved; authentication does not depend on marketing. Existing unsubscribes are not backfilled or reset.

## Consent rationale

CNIL guidance says account creation alone does not establish the existing-customer exception, and promotional material in a service message can qualify as direct marketing. Therefore cancellation confirmation remains independent of promotional consent. No batch subscription of existing users or campaign blast was performed.

- https://www.cnil.fr/fr/la-prospection-commerciale-par-courrier-electronique-sms-mms-et-automate-dappel
- https://www.cnil.fr/fr/communication-electronique-quelles-regles

## Verification

- 40 focused Node tests: receipt languages, verified-email opt-in binding, one-use intent consumption, consent/rail separation, failed promotion delivery preserving confirmation, authenticated fast lane, existing offer endpoints and cancellation rendering.
- Offline PostgreSQL schema clone with networking disabled: immediate offer before J−3, monthly/annual prices, retained access boundary, acceptance idempotence, foreign-owner rejection, consumed offer rejection, no consent required for on-site offers, consent required for mail, decline suppression, twelve-month exclusion and service-only dispatch permissions. Transaction rolled back.
- Separate SQL channel test confirms pending web marketing cannot be delivered after a switch to Google Play.
- Existing full financial-cycle fixture reaches its unrelated price-change notification and is blocked by an older Postal procedure in the disposable schema snapshot. It is not counted as a passing billing-cycle replay. This change does not modify billing-cycle consumption logic.
- Browser fixture: confirmed cancellation → quote → explicit decline; renewal remains cancelled. At measured 1280×720 CSS viewport the primary and decline buttons are fully visible. At measured 480×844 CSS viewport there is no horizontal overflow and both actions remain visible. Native Android is outside this web-only change.
- Locale build/check and Edge bundle compilation pass.

## Deployment

Pending publication and production checks.
