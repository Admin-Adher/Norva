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
