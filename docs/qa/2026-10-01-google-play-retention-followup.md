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

## Production rollout and transport audit

- Backend deployed globally at 2026-10-01 14:30:23 UTC, sequentially restarting the two Edge replicas after guarded file-hash checks. Both health endpoints passed. Backup: `/home/adrien/.norva/play-retention-backup-20261001T143023Z`.
- The dedicated ten-minute scheduler is installed. Authenticated direct checks on both replicas return `playRetention: 0`, with both mobile campaign flags still false. No promotional deliveries were released.
- RevenueCat login is now available. Phone app `app145ab4c2f7` has valid Google credentials and is connected to the existing `norva-rtdn` topic. Its matching RevenueCat subscriber exists in Google Cloud.
- Real-time notifications were enabled and saved in Play Console for subscriptions/voided purchases on that exact topic. The test failed: Google Play's official notification service lacks topic Publisher permission. The topic-scoped grant is prepared, awaiting user confirmation; no broader IAM change was made.
- The existing RevenueCat webhook points to `/functions/v1/norva-billing-webhook`, both environments, all events. The official dashboard TEST reached Norva and passed authentication/signature validation, but returned `403 revenuecat_app_not_allowed`: its synthetic application id is not the production phone id. TEST now returns an acknowledgement after both authentication guards and before business-event allowlisting, with no business processing. Real purchases and transfers retain their application restriction. Three executable preflight cases and the existing 23 billing/transfer checks passed.
- Full Android regression run 36876153585 initially passed five configurations. Gesture/font 1.0 stopped in `CatalogVersionTagsWebViewTest` after WebView renderer crashes (code -1); no promotion assertion failed. Only the failed job was replayed. Final result is recorded below when available.

### RevenueCat transport verified

At 2026-10-01 14:45 UTC, the diagnostic-only webhook acknowledgement was deployed on both current Edge replicas. A concurrent VOD deployment had moved their functions mount; the guarded rollout stopped before mutation, then verified that all five retention files were preserved on the new active mount before patching the single webhook file. Both replicas passed health checks. Backup: `/home/adrien/.norva/play-retention-release-20261001/webhook-active-backup-20261001T144512Z.ts`.

The official RevenueCat "Resend Test Event" then returned HTTP 200 and exactly `{"ok":true,"test":true}`. This verifies RevenueCat-to-Norva connectivity, authorization and signature validation. It does not prove a store purchase or Google-to-RevenueCat RTDN delivery.

PR [548](https://github.com/Admin-Adher/Norva/pull/548) is merged as `44698d17100bccc6ec59c18171a9b8f1ce04ed1e`. The final code change after the successful focused emulator suite affects only the server diagnostic event path and its tests; the mobile UI is unchanged. Full Android regression remains in progress. Cloudflare publication run [36879181135](https://github.com/Admin-Adher/Norva/actions/runs/36879181135) is in progress at this entry.

### Client publication and final gate

Cloudflare production publication 36879181135 passed. Production `PlayRetentionCard.js`, `billing.js` and `Settings.js` hashes match the release. The current application's versioned translation script `/js/i18n.js?v=8514b85c61` matches merged commit `44698d17` and contains the retention translations; the unversioned CDN URL still exposes an older cached asset and was not used as release evidence.

Full emulator run 36876153585 passed all six configurations after the one failed-job replay. A separate automatic run at the diagnostic-only server commit (36878575297) again lost a WebView renderer, this time during `ContextualLanguageInstrumentedTest.attachedFiltersKeepScopeWithKeyboard` (code -1, empty failure, suite interrupted at 11/65). This is recorded as an unresolved general-suite instability, not a passed full run at that commit. The dedicated four-configuration retention replay remains passed; no production Android/retention UI source changed between these commits.

Remaining actions: approve the prepared topic-scoped Google publisher permission, resend the Play RTDN test and verify RevenueCat's received timestamp, then validate one real eligible promotional purchase and preserved billing date. Production currently has no Google Play entitlement suitable for that purchase. Campaign flags remain off; no user purchase, trial date, consent or entitlement has been fabricated.

## Approved Google notification permission — 1 October, 14:57 UTC

The user explicitly approved the prepared permission. The official principal `google-play-developer-notifications@system.gserviceaccount.com` was granted Pub/Sub Publisher on the single topic `norva-rtdn`. Google Cloud confirmed the policy update; no project-wide role was granted.

The Play Console test was resent. RevenueCat Phone now shows `Last received 2026-10-01, 2:57 p.m. UTC` on the exact topic `projects/norva-ecosystem/topics/norva-rtdn`. This completes the Google Play-to-RevenueCat transport check; the separate RevenueCat-to-Norva diagnostic already returned HTTP 200. The optional "Track new purchases from server-to-server notifications" remains unchanged.

Production still has zero Google Play entitlement projections and zero eligible subscriptions. A real offer test needs an ordinary Play customer with cancelled access ending within three days. A new seven-day trial begun today cannot truthfully be treated as J-3 today. The user was asked to reconnect the phone and open a test account without an active Revolut subscription. No device is detected by ADB at this check. Financial confirmation remains a user action, and campaigns remain disabled.

### Additional general Android-suite diagnosis

Run 36878575297 finished with three phone jobs failing and three configurations succeeding. The three-button/font 1.0 artifact has an empty test failure and an instrumentation interruption (11/65), rather than a recorded promotion assertion. Continuous logcat exited 255 at 14:47:54 without the harness stopping it; the app PID remained visible through 14:48:05, and ADB stayed available after a transport change. Renderer `code -1` messages also occur at normal fixture teardown and are not sufficient to establish the root cause. The earlier wording identifying renderer crashes as the cause is therefore superseded: the general-suite interruption remains unexplained. The dedicated retention matrix and the six-configuration replay at the unchanged UI commit are passed evidence; this later general run is not counted as passed.

## Ordinary phone customer sign-in and missing purchase entry

The user reconnected the phone and explicitly asked the agent to sign it into the QA account. Production 1.3.28 (42) is installed. The existing September 24 ordinary QA account was signed in through its genuine email OTP delivered to the user's personal Gmail. No unrelated organization mailbox was used. The Settings screen confirms this account; its Revolut projection is expired as of 2026-10-01 06:23:01.964 UTC, with the consumed-trial history intact.

Runtime inspection found only Contact support beneath Plan expired. The cause was an obsolete Settings allowlist for a single customer-success email. The release APK now exposes the account-bound WebMessage billing channel, but Settings still required that old address to recognize it.

PR [549](https://github.com/Admin-Adher/Norva/pull/549), merged as `8c38067a89f7e3fbce3398ddb880ce3394a3f5ff`, removes this email restriction and recognizes the actual supported channel. The purchase entry waits for the authoritative membership response. It stays hidden for a live web subscription, included access, hard blocks, TV, missing bridge, or a failed membership lookup. Existing Play membership keeps Play management. No native APK or store offer was changed.

Verification: 30 focused Node checks passed. Focused Android run [36882726929](https://github.com/Admin-Adher/Norva/actions/runs/36882726929) passed all four phone configurations (gesture/three-button, font 1.0/1.3), including Settings entry, retention and subscription layout, plus both TV configurations. Generated asset metadata was refreshed separately and the latest cloud-contract suite passed. The general automatic suite is separate from this successful focused replay. Production client publication and the genuine Google Play sheet remain to be recorded below. Mobile campaign flags remain disabled.

### Entry correction published; phone handed back

Cloudflare production run [36883440504](https://github.com/Admin-Adher/Norva/actions/runs/36883440504) succeeded, including its regression gate. The public application references `/js/pages/Settings.js?v=995a273060`; the served script matches the local corrected file (normalized SHA-256 `995a273060df567c6d4cb71e932b7e7570c356c226ab449aebcc2999c798defc`) and no longer contains the email allowlist.

Before the final production replay the phone moved to another application. The user said they would notify us when it becomes available. No further phone input was sent. The QA account is signed in, but the newly published purchase entry and actual Google Play checkout have not yet been replayed on that phone. No purchase was initiated or confirmed. The existing QA account's web trial is already consumed; do not promise a new free trial or reset that history. The store's exact offer and financial terms must be inspected before the user confirms anything. Real promotional purchase, preserved billing date and campaign activation remain outstanding.
