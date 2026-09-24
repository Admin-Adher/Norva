# QA trial card check: entitlement active, checkout journal incomplete

Date: 2026-09-24 (UTC). Scope: one ordinary QA account, Norva Plus monthly.

## Observed incident

- The 06:23 UTC trial setup order reached `AUTHORISED`; the validation hold was then cancelled. The order ended `CANCELLED`, and the user observed the hold being released.
- The projection reached `trialing` at 06:24:56 UTC, with the first scheduled charge on 2026-10-01. The recurring customer mapping and saved payment method were present. This explains the founder's new-trial Telegram notification.
- The order remained `CANCELLED` but unfinalized. The browser's `/confirm` route therefore reported that confirmation had not succeeded.
- The webhook logged `trial lifecycle write failed: there is no unique or exclusion constraint matching the ON CONFLICT specification`. The missing `TRIAL_STARTED` event was confirmed in the production database.

## Cause and repair

`cloud_entitlement_events` had a **partial** unique index on `(provider, provider_event_id)` with `WHERE provider_event_id IS NOT NULL`. Four Edge functions issue PostgREST upserts with the unqualified conflict target `(provider, provider_event_id)`. PostgreSQL cannot infer that partial index from the target. A regular unique index on the same columns preserves uniqueness for non-null IDs and permits multiple null IDs.

Migration `20260924090000_entitlement_event_conflict_target.sql` adds the regular index. It was applied to the production database at about 06:33 UTC. A transactional probe confirmed duplicate keyed events are ignored and multiple null IDs remain allowed; an existing-row conflict probe on the production table passed without inserting data.

The one-time script `ops/hetzner/scripts/repair_qa_trial_20260924.sql` reconciled the exact QA order after checking the released hold, current unfinalized journal, matching trial projection and matching saved-card billing mapping. It inserted the missing event once and finalized the order as `trial_started` in one transaction. A subsequent read confirmed `CANCELLED` with `hold_released=true`, finalized journal, one `TRIAL_STARTED` event, finalized checkout intent, and a still-active `trialing` projection.

The already open checkout tab used **Retry finalization** once after repair. It displayed **Your free trial has started** and the first payment date of 2026-10-01. The finalized-order branch returns this result without creating a new payment order or contacting Revolut. No additional card check was initiated.

Focused checkout contract suite: **13/13 passed**. A separate real card transaction was not repeated; the browser and database verification used the original order.
