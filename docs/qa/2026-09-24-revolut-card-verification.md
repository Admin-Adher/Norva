# Production Revolut card-check failure, 24 September 2026

## Observed failure

A newly registered, non-internal QA account completed the card widget's first 3-D Secure check for a Norva Plus monthly trial. The issuer displayed a temporary USD 0.50 authorization. Norva did not activate the trial. The customer manually canceled the authorization after the app showed that finalization had failed. A later card attempt was declined by the issuer (3-D Secure failure). No subscription charge was captured, no entitlement was granted, and the Revolut Merchant order shows USD 0 net.

The production order was created at 02:18 UTC. Both `/confirm` and the `ORDER_AUTHORISED` webhook logged an immutable-journal mismatch. A read-only comparison of the exact Revolut order and local journal found that the owner, kind, plan, period, metadata price, currency, intent, reference, and attribution matched. The only mismatch was the provider order amount: the legacy GET response supplied `order_amount: { value: 50, currency: "USD" }`, while both handlers read the absent top-level `amount` field. This made a valid authorization fail closed. The old checkout error text also falsely said that no amount could appear on the card.

## Correction

Both checkout and webhook now read provider money from the nested response or the older flat shape. If both shapes are present and disagree, the order is rejected. Missing provider money cannot be replaced by untrusted order metadata. This check covers trial confirmation, webhook finalization, recovery lookup, refund integrity, and captured resubscription reconciliation. The checkout's pending message now distinguishes a temporary authorization hold from a captured subscription payment and tells the user not to submit another payment while retrying verification.

## Evidence and remaining validation

- Revolut Merchant UI: original order `CANCELLED`, one successful card verification later canceled by the customer, one declined attempt, USD 0 net.
- Norva production journal: trial order `CANCELLED`, `finalized_at` empty, entitlement absent.
- Local test suite: 71 Revolut-focused tests passed, including nested/flat response compatibility, contradictory amounts, and exact owner/reference/amount recovery.
- The original canceled order cannot start a trial. A new customer-initiated checkout is required after deploying the fix. Do not infer that an issuer has removed the pending hold from Revolut's USD 0 merchant balance; verify the card statement separately.

## Deployment and customer copy

PR #381 merged to main as `321cb2f870f2d9e2479e0ceac6e866f290a5f850`. Cloudflare Pages workflow `35949281178` succeeded. The live checkout page serves the new pending-hold message and `i18n.js?v=498cb9b828`; the old false error message is absent. Both Edge replicas passed guarded preflight and were restarted successfully at 02:55:33 UTC with checkout and webhook modules healthy. The protected backup is under `/home/adrien/.norva/revolut-order-fix-20260924/backup-20260924T025533Z`.

A subsequent read-only comparison of the canceled provider order with its local journal, using the nested provider amount and currency, found zero immutable-field mismatches. It cannot establish that a fresh authorization will finalize because this order is already canceled. A new real checkout remains the required end-to-end proof.

The subscription-choice page still overstated the speed at which a pending bank hold disappears. A follow-up copy change now says that Norva cancels the authorization after successful verification and that the bank can display it for longer. It also corrects the saved-card and payment-calendar text in all ten supported UI languages. The copy change does not alter payment behavior.
