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

## Automatic hold release follow-up

The customer's cancellation of the original order was manual, not an observed automatic void. In addition to the nested amount defect above, the production billing cron skipped expired `AUTHORISED` card-check orders. It also omitted finalized checkouts whose first cancellation attempt failed (`hold_released=false`). An integrity rejection could return before attempting to release an authorized hold.

PR #384 merged as `82b47554f8b7352d929cc8d7572f0cd3c7063a37` and closes those recovery gaps. An integrity-rejected card check now requests cancellation before returning an error. The hourly cron claims expired authorized validation-only orders, re-reads and retries cancellation after an ambiguous or failed attempt, and revisits finalized validation orders with an unreleased hold. Captured resubscriptions remain on the separate money-reconciliation path. Revolut's [manual-capture guide](https://developer.revolut.com/docs/guides/merchant/operations/capture-and-settlement/capture-later) confirms that an authorized order holds funds without capture and that cancelling it releases the hold.

Thirty-three focused local payment tests passed, including a mocked cron exercise for an expired authorized order, a later retry, a finalized unreleased hold, and an authorized resubscription. The PR's Build Norva and Partners integration workflows completed successfully. Read-only production SQL found zero finalized validation orders with `hold_released=false` before deployment. The billing cron was active and its last predeployment run at 03:23 UTC succeeded.

The three revised modules were deployed to both production Edge replicas at 04:09:41 UTC from that merged commit. Postdeployment SHA-256 values were `c0c133539d1d920d7b7b48769a02234b850c99a76bba1a4ab0c5fa6a63bb37fd` (checkout), `5676f3439c7df698230598c6f111a60ac6404d835a63abf3b8328b26053e68ab` (webhook), and `1f7a06a99ad71ff50f4516351a3b46348af378299953811656e3f67039e95d6f` (billing cron). Both replicas restarted healthy; each returned 200/configured for checkout health and 405 for unauthenticated GET probes to webhook and billing. Rollback backup: `/home/adrien/.norva/revolut-hold-release-20260924/backup-20260924T040941Z`.

No new live QA card authorization has been initiated after this deployment. Therefore the exact automatic void and the issuing bank's removal of a pending hold remain unverified; the original manually canceled order cannot supply that proof. The scheduled billing cron should be checked after its next normal run rather than invoked manually, because it also handles real customer charges.
