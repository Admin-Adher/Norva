# Google Play retention — distributed 1.3.29 replay

## Scope

Physical POCO, authorized USB, Google Play installation 1.3.29 (43).
Ordinary September 24 QA account signed in through its genuine Gmail OTP.
No real payment authorized or performed. Every purchase sheet must display
the Google Play test notice and the always-approved test card.

Production retains `NORVA_RC_ACCEPT_SANDBOX=false` on both Edge replicas.
The isolated database has no communication worker. October 1 annual and monthly
purchase evidence is retained in separate databases, without changing a real
customer's eligibility or twelve-month offer history.

## Completed: reactivation after expiry

- Baseline monthly receipt `EF724667-1DAE-4627-94CA-75F3CA322480`, SANDBOX,
  access through 2026-10-02 06:18:27.997 UTC.
- Official Google Play cancellation receipt
  `AED292C2-F6A1-4D15-A85A-4A57ACB3D2F4`.
- The user opened the isolated QA page manually, because the earlier automatic
  approval refusal of the USB deep link was respected.
- Native offer showed EUR 3.99/month for three months, then EUR 4.99/month.
  Google Play confirmed the same simulated price and no-charge test instrument.
- Claim 06:18:52.531469 UTC occurred **after** accelerated baseline expiry.
  This pass must not be described as a before-expiry replacement.
- Verified purchase `31A56449-09C1-4499-B4CF-3DEE9FBDA2D0`, SANDBOX,
  `retention-monthly-20`, accepted at 06:19:53.524 UTC.
- Phone rendered “Votre achat promotionnel Google Play est confirmé.”
- A subsequent offer lookup returned null: accepted-offer reuse was denied.
- Fictitious subscription cancelled in Google Play, access through 08:24 Paris.

## Supporting checks

25 focused Node tests passed: authenticated-owner binding, exact store price,
verified confirmation, separate email/push flow, revoked consent, duplicate
delivery prevention, isolated QA configuration and the minimum 1.3.29 guard.
The first local test attempt lacked esbuild; rerun used the existing root
node_modules via NODE_PATH and passed, without a code change.

Fresh production check: zero sandbox entitlement events, no Google Play
entitlement projections, campaign switches still false at this stage. Dedicated
cron is scheduled every ten minutes. FCM configuration exists on both replicas.

## Completed: before-expiry replacement

- New annual baseline `E6E14AE6-9EDE-43A0-A8C1-73577C17517F`; real store
  sandbox expiry 06:57:26.263 UTC. Cancellation
  `E8EED87F-EAD9-4099-9EB3-04206B05EB71` arrived through the webhook.
- Offer `19c4d853-cc6e-46a9-8987-b461986c6415` displayed EUR 39.59 for the
  next year, then EUR 43.99/year. Google Play explicitly displayed first billing
  at **08:57:26 Paris**, the unchanged baseline boundary.
- First native promotional attempt opened Google Play successfully, without
  relaunching Norva or retrying a stale-state error after cancellation.
- Claim at 06:32:02.448655 UTC; receipt
  `191F3F18-AF80-4BE0-B4E0-ED522AFECFC9` accepted at 06:32:34.334 UTC,
  about 24 minutes 52 seconds before previous expiry.
- Verified Google API authority identifies `retention-annual-10`, the correct
  claim, SANDBOX and boundary 06:57:56.851 UTC: **30.588 seconds later**, never
  earlier, within accelerated sandbox timing.
- The physical phone displayed “Votre achat promotionnel Google Play est
  confirmé.” A further offer lookup returned null. No real payment occurred.
- The final fictitious subscription was cancelled in official Google Play;
  its screen confirms remaining access through 08:57 Paris.

## Production activation

Activated at **2026-10-02 06:33:21.846163 UTC / 08:33 Paris**:
`cloud_play_retention_policy.enabled=true`, `communications_enabled=true`.
The operator script checks the accepted sandbox evidence, confirmation before
expiry, Google authority and access preservation; it does not copy a receipt
or entitlement into production. Previous policy and activation receipts are
preserved privately on the operator host.

Production dispatch **192451** returned HTTP 200, no timeout, and
`{"ok":true,"playRetention":0}`. Zero is expected: there are currently no
Google Play production entitlement projections. No customer promotion was sent
by this verification. Cron remains enabled every ten minutes. This is execution
proof of the production selector, not a claim that a real customer received
an offer today.

Production sandbox acceptance remains false; sandbox entitlement event count
remains zero. Personal eligibility, twelve-month reuse protection, consent,
web/mobile separation and email/push stage deduplication remain enforced.
Clients below 1.3.29 retain the published update invitation.

## Scope and diagnostic note

The October 1 three-discounted-monthly-renewal proof and ordinary fourth price
remain the full-cycle evidence. Today's purchase proves the distributed 1.3.29
native fresh-state fix and confirmation; sandbox timings are not a measurement
of a real calendar-year renewal.

While setting up the second baseline, standard annual checkout initially showed
a generic start error immediately after accelerated monthly expiry. A normal
Restore Purchases action followed by checkout succeeded. The standard checkout
still uses the SDK's default customer-info fetch policy, unlike the corrected
retention path. This observation is retained as a separate diagnostic, not
misreported as a failed promotional attempt or a proven root cause.

This closes the mobile campaign gate, not the entire commercial-readiness goal.

## Cleanup

Final sandbox cancellation receipt `F7F1F7BA-D771-46A0-A7A7-ACA93592A104`
was received before cleanup. The optional QA configuration was moved out of
the served function tree into the private evidence folder. Both Edge replicas
were reloaded sequentially and returned healthy version 84. The isolated REST
container was stopped; evidence databases were retained. No purchase remains
set to renew in the test workflow.
