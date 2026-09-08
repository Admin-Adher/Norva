# Norva email reliability and presentation — 8 September 2026

## Production changes

- The private Postal sender accepts the existing `Norva Updates` display name on approved Norva domains. The final normalized sender and recipient checks remain enforced.
- Eight recent import dead letters were reviewed and replayed with their original delivery keys: seven sent, one skipped because its source was no longer visible. Nineteen older quota-related failures were left untouched.
- The two address-verification SMTP failures were confirmed as unavailable mailboxes with RCPT-only checks. No message DATA was submitted during those checks and no expired authentication token was replayed. Diagnostics now retain bounded SMTP stage/status information without raw recipient/provider responses.
- Confirmed-account password and email changes enqueue security notices. Initial confirmation, unchanged passwords and case-only email changes do not enqueue notices. The email-change notice goes to the previous address.
- A separate Telegram delivery monitor runs independently of Postal and reports aggregate incidents and recoveries.
- Dunning uses an acknowledged stage and stable billing-cycle key. Eligibility is checked again immediately before SMTP; stale-cycle acknowledgements cannot advance another cycle. Pre-renewal notices cover eligible Revolut subscriptions three days before monthly renewal and seven days before annual renewal. These workers do not initiate payments.
- Welcome has been enabled for confirmed signups from `2026-09-08T13:23:58.123066Z`, with no historical signup backfill. Dunning and renewal email flags are enabled on both Edge replicas. Expiration enforcement, winback and abandoned-checkout flags remain disabled.

## Shared email design

`supabase/functions/_shared/email-frame.ts` provides the inline/table-based dark glass envelope for authentication, lifecycle/billing, imports, subtitles, account deletion, support and provider-access messages. The generated database function uses the same presentation for security, trial and partner messages.

Six original illustrations in `public/img/email/` cover welcome, security, catalogue, billing, action required and support. JPEG encoding retains full image dimensions; files range from 82,459 to 103,836 bytes. Illustrations carry no essential message content. Codes, content, links and actions remain HTML text, with solid-color fallbacks when a client removes gradients or blur. No tracking identifiers are added to image URLs.

Artwork was published in commit `7bb0b363` through [Cloudflare run 34237110329](https://github.com/Admin-Adher/Norva/actions/runs/34237110329) and merged in [PR 330](https://github.com/Admin-Adher/Norva/pull/330), merge commit `3338c75f957c10a9f2b92d9c0dd942a01e4befc7`. All six public JPEGs returned HTTP 200 and matched their source SHA-256. A request using the GoogleImageProxy user-agent also returned HTTP 200; this alone is not an actual Gmail rendering proof.

## Validation

- 140 email-related Node tests passed after the final artwork integration.
- The previous reliability validation included 17 private-transport tests, 10 SMTP tests, networkless security-trigger proof, and lifecycle/billing/behavioral SQL integration and concurrency proofs.
- Seven representative rendered emails were checked at 320, 390 and 1440 CSS pixels: no horizontal overflow, no broken illustrations, one main heading per message. Desktop and mobile screenshots were inspected. The code email remained usable with images, CSS enhancements and gradients removed.
- Networkless PostgreSQL proof: `PREMIUM_EMAIL_UI_PROOF_OK`. The production replacement preserved the function owner, ACL and security-definer setting. Security, trial and partner messages resolve respectively to security, billing and support artwork.
- Both production Edge replicas passed health and deployed-file hash checks. The overlay preserves other live modules and all runtime configuration. It intentionally retains the existing production authentication-handler differences instead of replacing unrelated delivery behavior from the source checkout.
- Five initial internal test emails were received and reported readable by the operator. The first glass-style test set was also reviewed; the operator requested custom imagery while retaining the style. Three final illustrated internal tests have Postal receipts and a `sent` outbox state. The operator subsequently confirmed that the illustrations are visible in all three Gmail test messages; this completes the actual inbox artwork-display acceptance.

## Gmail image interaction

The shared frame and a forward database migration, `20260908144324_linked_email_artwork.sql`, now wrap each hero illustration in a normal `https://norva.tv/` link with a localized accessible image label. This addresses Gmail's download overlay on large unlinked images while retaining the same artwork and layout. The artwork never links to an authentication or confirmation action. This is a presentation change, not download prevention: the asset can still be saved or captured, and already-sent messages retain their original HTML.

The focused follow-up passed 42 existing tests, the networkless PostgreSQL shell proof, and 21 rendered viewport checks with zero overflow or broken images. Both production Edge replicas passed health and hash checks with unchanged configuration; the database owner and ACL were preserved. A single new internal Gmail hover-check sample under the immutable key `email-linked-artwork-20260908:verification` reached `sent` at `2026-09-08T14:50:00.455296Z`. The operator has not yet confirmed its hover controls; this acceptance remains separate from the earlier successful image-display confirmation.

## Activation still gated

Customer delivery remains closed. At `2026-09-08T16:29:16.808914Z`, `no_source` and `import_unresolved` entered version 3 in `internal_test` mode through the audited admin configuration functions. The global emergency stop is now off for this internal acceptance only. Both journeys have only their email step enabled, a 24-hour configured delay, zero push caps, the existing 10% holdout and unchanged country settings. The other two journeys remain draft at 0%. No import-readiness attestation has been recorded.

On the physical Android phone (Norva 1.3.19 / build 32), a real M3U import completed with eight channels, and required-field guidance was observed. The temporary QA source was disabled after validation. The existing Xtream source was resynchronized; its inventory was 276,965 items and the catalogue was usable during the remaining background work. At `2026-09-08T17:40:04Z`, the source was still `syncing`, at 95%, with both `usable` and `browseReady` true and no sync error. This does not establish a completed terminal import.

The physical phone also exercised a genuine nonexistent public M3U endpoint, the recoverable error form, Android Back hiding the keyboard, the app-only provider help panel, return to the retained M3U form and the Xtream format selector. No failed-source row was created and no existing provider credentials were changed.

### Progressive catalogue and import-help corrections

The first failed M3U test at `2026-09-08T16:09:16.519428Z` exposed two live defects: the unresolved-import predicate considered the already usable progressive Xtream catalogue unavailable, and subsequent Xtream heartbeats overwrote the failed attempt's M3U help context.

Migration `20260908160531_suppress_import_reminder_for_usable_catalog.sql` corrects both functions. A source suppresses an import reminder when it is ready, or when it is syncing without an error and its server projection contains both `usable: true` and `browseReady: true`. The source must still belong to the same owner, be enabled and not be deleted. This grants no catalogue access. An unrelated heartbeat preserves the existing failure's source format; genuine new failure and completion transitions can still update it.

Both defects first failed their new integration fixtures in a networkless disposable PostgreSQL database. After the patch, both fixtures, the existing behavioral integration fixture and its concurrent-worker fixture passed (`BEHAVIORAL_READINESS_PATCH_PROOF_OK`). The 29 focused Node tests also passed. The production replacement was applied atomically at `2026-09-08T16:20:51.496358Z`, preserved both functions' owner, ACL, security mode and search path, and did not change delivery configuration. Anonymous and authenticated client roles still cannot execute either internal function.

The physical-phone retry at `2026-09-08T16:22:37.500702Z` then recorded a real M3U `endpoint_not_found` failure. A later real Xtream heartbeat at `16:23:34.511248Z` preserved the M3U context. At `16:23:35.477308Z`, unresolved-import relevance was false because the catalogue was usable. There were still only the original two nondeleted sources. This is live device/API/database evidence, separate from the synthetic fixture proof.

### Real-delay internal acceptance

Two fresh QA identities were created through the Auth admin API at `2026-09-08T17:36:05.717137Z` and `17:36:06.059194Z`, using plus aliases of the operator's already-confirmed Gmail test mailbox. Both are tagged internal with a nonbillable `system` entitlement; neither has an admin role. Their passwords are retained only in the private host release directory. Existing accounts and their sessions are unchanged.

One identity has no source attempt. The second made a real authenticated POST to the source-import API; the public test endpoint returned HTTP 404, recording an M3U `endpoint_not_found` at `2026-09-08T17:36:06.689683Z`. This backend acceptance is not described as a second physical-device login.

The timezone gate initially prevented scheduling. `Europe/Paris` was then observed from the operator's Windows JavaScript runtime and reported through each QA identity's normal authenticated `/lifecycle-context` endpoint. No SQL timezone override or fabricated clock was used. The lifecycle tick inserted exactly two email deliveries, both naturally assigned to treatment, with no in-app materialization, no other internal recipient and no customer delivery.

| Journey | Earliest scheduled time (UTC) | Paris time | Current state |
| --- | --- | --- | --- |
| `no_source` | 2026-09-09 17:36:05.717137 | 9 September, 19:36 | pending |
| `import_unresolved` | 2026-09-09 17:36:06.689683 | 9 September, 19:36 | pending |

The private transport's earliest-send checks match these times. The normal 15-minute lifecycle cron should first evaluate them around 19:45 Paris time. Neither delivery has entered the email transport outbox yet; receipt and link-opening acceptance remain pending. Configuration, timestamps and experiment arms must remain unchanged during this wait. Adding a source or resolving an import must still cancel the corresponding reminder.

The operator subsequently requested faster acceptance instead of waiting 24 hours. Two immediate manual transport previews use the pending journeys' actual copy and contextual destinations, through the existing `postal_transport_test` circuit. Their subjects start with `[TEST Norva - immediat]`. The previews remove the lifecycle tracking parameter so opening one cannot fabricate an early opening event for its scheduled delivery; the source/help destination itself is unchanged. The automatic schedule and transport cadence guards are unchanged.

Both immediate previews reached `sent` in the private SMTP receipts and the public outbox. SMTP acceptance was recorded at `2026-09-08T17:52:16.958916Z` for import help and `17:52:54.409121Z` for no-source help; both outbox acknowledgements completed at `17:53:01Z`. These prove the immediate mail transport, not the future scheduled-send timing. The operator's inbox and source/help-link checks are pending. No next-day Codex automation was created.

The remaining gate is inbox/link acceptance and supported import-readiness evidence before starting the customer pilot. The terminal Xtream background job and the real automatic cadence remain distinct pending observations. Winback, other behavioral journeys and unrequested push channels remain closed.

### Source validation follow-up

The previous draft PR's cloud-contract job exposed four obsolete assertions after linking the artwork: three chose the first link as the authentication CTA, and one depended on a removed source comment. The updated checks locate the rendered authentication actions, require matching CTA/fallback URLs and ensure artwork clicks cannot invoke authentication; marketing checks exercise the actual rendered unsubscribe controls. All 32 focused auth, marketing-consent and email-quality tests pass.

A broader Windows run reported 3,793 passing tests, three skipped and three failures outside the email changes: a CI-evidence test parses LF-only workflow text from a CRLF checkout, and two subprocess fixtures lack local module resolution in this worktree. The remote CI result remains a separate publication check; this local run is not reported as entirely green.

## Operations evidence

Production release directories:

- `/home/adrien/.norva/email-reliability-20260908`: worker rollback, independent monitor and reliability proof material.
- `/home/adrien/.norva/email-reliability-edge-20260908`: dunning/renewal release and live email-cron proof.
- `/home/adrien/.norva/email-ui-edge-20260908`: initial glass envelope and database backup.
- `/home/adrien/.norva/email-ui-images-edge-20260908`: final illustrated templates, image-selection migration, baseline manifest, rollback and database proof.
- `/home/adrien/.norva/email-ui-linked-artwork-20260908`: current linked illustrations, forward database migration, rollback and presentation proof.
- `/home/adrien/.norva/behavioral-readiness-20260908`: defect reproduction, migration, original function definitions, security/configuration checks and application proof.
- `/home/adrien/.norva/behavioral-internal-canary-20260908`: configuration baseline, audited internal activation, private QA identities, observed client timezone and real-delay canary proof.

The active illustrated frame SHA-256 is `a93f0c17270b211275140dae2d6978a12d8b0afecb6caa2394c220af55b3aa56`. The final database function definition SHA-256 is `b9cd11ac8f0094b2be6877a254bc84f1b8ac59efcf41929240c6a09fa5fef1c7`.

The reminder/context migration SHA-256 (LF-normalized) is `23f2373ac04fd6481c909258f063c5ad73231ccee40383b3f96e79a964b556e6`. The resulting function-body MD5 markers are `b63e2cae486acabd949ba425ecc5b1a3` for relevance and `446e633984acc835673c77990c54174a` for source-context projection. These are deployment identity markers, not security assurances.

At `2026-09-08T17:40:04Z`, live aggregate delivery health showed zero overdue import, branded, support or billing-receipt emails; zero expired auth messages in the last 24 hours; two known auth failures; and one historical import dead letter remaining within the rolling 72-hour window.

Operational directories contain private configuration and must not be copied into Git. Frozen outbox payloads must not be rewritten to apply a newer design; the new presentation applies at initial rendering for subsequent messages.
