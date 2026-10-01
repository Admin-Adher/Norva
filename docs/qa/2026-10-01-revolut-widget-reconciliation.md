# Revolut widget reconciliation — 1 October 2026

Production incident: the new ordinary QA account's only trial_setup order was
finalized by webhook at 06:36:06 UTC, with trial_started and hold_released=true.
The provider journal is CANCELLED for the released USD0.50 verification hold;
the entitlement is trialing. The screenshot instead shows the widget error copy.

The widget onError handler previously unconditionally reported payment_declined
and re-enabled submission. It never consulted the owned-order confirmation API.
This is distinct from the September missing event-index repair.

Fix: ambiguous widget error and submitted cancel run existing owned-order
confirmation. One in-flight confirmation, a terminal UI success guard, and ignored
late validation events prevent contradictory states and duplicate submission.
Unconfirmed outcomes retain the existing retry-confirmation action; no success
is inferred from a widget callback. No payment details are persisted by this fix.

Verification: 18 focused tests pass, including five runtime callback tests for
webhook-success/widget-error, callback races, pending confirmation, submitted
cancel, and late validation. Generated locale assets check passes.
Production deployment and a fresh user-operated card check remain to be recorded.
