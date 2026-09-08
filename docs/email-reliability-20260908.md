# Norva email reliability and presentation — 8 September 2026

## Latest production state — 19:09 UTC / 21:09 Paris

The operator subsequently requested all applicable email circuits active, and provided Gmail in the Codex browser for direct verification. This authorization supersedes the earlier scoped 10% email pilot described below.

Migration `20260908183015_complete_email_coverage.sql` and the two Edge modules are deployed. Four behavioral journeys are active in the explicit `production` email audience, 100% rollout, all countries, zero experimental holdout, with five enabled email steps. Only new qualifying events after activation enter these cohorts. Internal accounts are excluded. Readiness must be fresh and passing to enter production; a later recorded failure suppresses delivery. Production email is a lasting product setting, separate from the expiring pilot and its experiment measurements; no uplift is claimed.

| Circuit | Current behavior |
| --- | --- |
| No source | Email after the existing configured delay; adding a source attempt suppresses it. The private cadence guard still extends to 72 hours when a granted, recent push registration exists. |
| Import unresolved | Email after 24 hours; a ready or progressively usable catalogue suppresses it. |
| Catalogue ready, no first play | New email after 24 hours; a first play suppresses it. |
| Continue watching | New consent-gated email after 72 hours, only while resumable progress remains relevant. |
| Catalogue updates | New consent-gated email after seven days in the continuation journey, only when the server records newer catalogue content since the last watch. This is not a general newsletter to all accounts. |
| Winback and abandoned checkout | Both Edge flags enabled. Existing current-event eligibility, consent, signed unsubscribe and final SMTP suppression preserved. Zero eligible historical candidates at activation. |
| MFA added/removed, identity linked/unlinked, verified phone changed | Three new Auth database triggers enqueue five kinds of durable notices. Initial signup and cascading account deletion do not generate misleading notices. No real credential or MFA configuration was changed for QA. GoTrue's equivalent toggles remain off to avoid duplicate senders. |
| Upcoming renewal | Existing monthly/annual reminder now includes the authoritative current USD amount with the same one-time discount calculation and 50-cent floor as billing. A pending plan transition with an unconfirmed final amount omits the quote. No payment behavior changed. |
| Provider expiry J−7, J−1, day-of, hidden access and restored access | Email channel enabled through its audited revision-CAS control, revision 17. The underlying Provider Access product cohort remains at 20%; auto-detection, push and unrelated rollout settings are unchanged. These emails are not represented as available outside that cohort. |
| Operations incidents and recovery | Both Edge replicas and private transport recipient policy explicitly target the operator's verified Gmail. Independent Telegram monitoring remains active. |

Behavioral email retains a maximum two messages per week, journey cooldowns and quiet hours 21:00–09:00 in a verified user timezone. Marketing additionally shares a reservation guard across winback, checkout and behavioral marketing: no pending/processing commercial message, at least 24 hours since the previous accepted commercial message, and fewer than two accepted commercial messages in seven days. The enqueue lock serializes concurrent commercial reservations. Transactional security, receipts and service alerts retain their own delivery rules.

The new migration compiled and passed security-event, deletion suppression, deduplication, renewal arithmetic, global audience, subsequent readiness failure and commercial-pressure checks in networkless disposable PostgreSQL. An exact-anchor preview against the live definitions was rolled back before the real application. Existing function owners, ACLs, security mode and search paths were preserved. 86 focused Node checks pass. Both Edge replicas passed health and deployed-file hash verification. The normal lifecycle cron subsequently returned `ok`, all intended email flags true, financial expiry false, zero newly queued customer messages and zero new dead letters. All eleven new test payloads have matching `sent` outbox and private SMTP receipts.

Direct Gmail verification covered all eleven `[TEST Norva - complet]` variants: winback, checkout, renewal amount, first-watch help, continuation, catalogue updates and all five provider messages. All illustrations loaded, text was readable, and CTA destinations matched the intended Norva pages. Visible commercial unsubscribe links and the postal address were checked. The renewal test displayed `$7.99 USD`. These are synthetic transport previews, not real subscription/provider events or proof that a 24-hour/seven-day customer schedule has elapsed. Gmail grouped the renewal test into its earlier renewal conversation.

The active release and rollback material live under `/home/adrien/.norva/email-coverage-20260908`. Migration SHA-256: `b20b3f91abcb7869dda6df1d2a4b19a573914c82e13a359e13ceaaee5b2a142d`; lifecycle worker SHA-256: `9a5abf766b6de452e9ab2c5640928bc0615ed3f575508da213bbd2ca08a3e92c`; lifecycle renderer SHA-256: `a2f1934bd33258be7e5226a063f72eea7139f394963525174179c60968f237f2`. The illustrated frame itself is unchanged.

Potential future features are not mislabeled as activated switches: suspicious-login risk beyond the existing new-device alert needs an authoritative risk signal; targeted service-incident/recovery campaigns need an actual affected-user incident producer; a separate price-policy change notice needs a scheduled price-change event; export-ready email applies only if a deferred export feature exists. No such events were fabricated and no user was opted into marketing. The existing payment, Auth, support, import, trial, subtitle and Partners circuits remain active as previously documented.

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

## Behavioral email pilot

At `2026-09-08T18:09:53.886676Z` (20:09 Paris), `no_source` and `import_unresolved` entered customer pilot mode at 10%, version 5, through the audited admin configuration functions. The country allowlist remains Bangladesh and India, with the permanent 10% holdout. Only their email steps are enabled. The configured 24-hour delays, final transport cadence checks, maximum two lifecycle emails per week, quiet hours 21:00–09:00 in the user's verified timezone and cooldowns (14 days for no-source, seven days for unresolved import) are unchanged. Their push caps remain zero. The other two journeys remain draft at 0%.

The operator explicitly confirmed that both immediate Gmail messages are readable and both source/help paths work: “Oui, les deux parcours fonctionnent”. Physical-device import and help observations are linked to source commit `9542b8eb63af9c3d933c6b512883ef195fa2ae48`, Android `1.3.19+32`, and immutable evidence SHA-256 `a8df9e37f04140d5892114c471ef6c118b5e08ad60d3d01ffb4e824263ba2dbc`. The append-only readiness record passes the five scoped checks and expires at `2026-09-22T18:09:53.879228Z`; the existing expiry gate then suppresses new pilot deliveries unless readiness is refreshed.

The activation first passed a transaction preview that was rolled back and verified to leave live state unchanged. The committed transition preserved every step and every unrelated journey, established fresh cohort boundaries, and canceled the two pending internal tests without submitting them to SMTP. The normal service-role lifecycle tick at `2026-09-08T18:11:39.993584Z` inserted zero deliveries and materialized zero in-app messages. There were zero historical customer jobs, zero active internal jobs and zero customer transport starts. This is activation and fresh-cohort proof, not an observed customer delivery or a commercial uplift result.

Before this transition, both journeys had entered version 3 in `internal_test` mode at `2026-09-08T16:29:16.808914Z`. That internal acceptance did not enable customer delivery.

On the physical Android phone (Norva 1.3.19 / build 32), a real M3U import completed with eight channels, and required-field guidance was observed. The temporary QA source was disabled after validation. The existing Xtream source was resynchronized; its initial inventory was 276,965 items and the catalogue was usable during the remaining background work. At `2026-09-08T18:00:05.564774Z`, the source was still `syncing`, at 96%, with both `usable` and `browseReady` true, 282,652 visible items and no sync error. A physical-phone capture shows the rendered catalogue with its ongoing-background-import banner. The Xtream and large-catalogue readiness checks cover this actual progressive usability; they do not establish terminal background completion. The installed APK's binary digest was not captured.

The physical phone also exercised a genuine nonexistent public M3U endpoint, the recoverable error form, Android Back hiding the keyboard, the app-only provider help panel, return to the retained M3U form and the Xtream format selector. No failed-source row was created and no existing provider credentials were changed.

### Progressive catalogue and import-help corrections

The first failed M3U test at `2026-09-08T16:09:16.519428Z` exposed two live defects: the unresolved-import predicate considered the already usable progressive Xtream catalogue unavailable, and subsequent Xtream heartbeats overwrote the failed attempt's M3U help context.

Migration `20260908160531_suppress_import_reminder_for_usable_catalog.sql` corrects both functions. A source suppresses an import reminder when it is ready, or when it is syncing without an error and its server projection contains both `usable: true` and `browseReady: true`. The source must still belong to the same owner, be enabled and not be deleted. This grants no catalogue access. An unrelated heartbeat preserves the existing failure's source format; genuine new failure and completion transitions can still update it.

Both defects first failed their new integration fixtures in a networkless disposable PostgreSQL database. After the patch, both fixtures, the existing behavioral integration fixture and its concurrent-worker fixture passed (`BEHAVIORAL_READINESS_PATCH_PROOF_OK`). The 29 focused Node tests also passed. The production replacement was applied atomically at `2026-09-08T16:20:51.496358Z`, preserved both functions' owner, ACL, security mode and search path, and did not change delivery configuration. Anonymous and authenticated client roles still cannot execute either internal function.

The physical-phone retry at `2026-09-08T16:22:37.500702Z` then recorded a real M3U `endpoint_not_found` failure. A later real Xtream heartbeat at `16:23:34.511248Z` preserved the M3U context. At `16:23:35.477308Z`, unresolved-import relevance was false because the catalogue was usable. There were still only the original two nondeleted sources. This is live device/API/database evidence, separate from the synthetic fixture proof.

### Scheduled internal checks and accelerated inbox acceptance

Two fresh QA identities were created through the Auth admin API at `2026-09-08T17:36:05.717137Z` and `17:36:06.059194Z`, using plus aliases of the operator's already-confirmed Gmail test mailbox. Both are tagged internal with a nonbillable `system` entitlement; neither has an admin role. Their passwords are retained only in the private host release directory. Existing accounts and their sessions are unchanged.

One identity has no source attempt. The second made a real authenticated POST to the source-import API; the public test endpoint returned HTTP 404, recording an M3U `endpoint_not_found` at `2026-09-08T17:36:06.689683Z`. This backend acceptance is not described as a second physical-device login.

The timezone gate initially prevented scheduling. `Europe/Paris` was then observed from the operator's Windows JavaScript runtime and reported through each QA identity's normal authenticated `/lifecycle-context` endpoint. No SQL timezone override or fabricated clock was used. The lifecycle tick inserted exactly two email deliveries, both naturally assigned to treatment, with no in-app materialization, no other internal recipient and no customer delivery.

| Journey | Earliest scheduled time (UTC) | Paris time | Current state |
| --- | --- | --- | --- |
| `no_source` | 2026-09-09 17:36:05.717137 | 9 September, 19:36 | canceled when the audience changed to pilot |
| `import_unresolved` | 2026-09-09 17:36:06.689683 | 9 September, 19:36 | canceled when the audience changed to pilot |

The private transport's earliest-send checks matched these times. Neither delivery entered the email transport outbox before the pilot transition canceled it. Original trigger times, schedules and experiment arms were not rewritten. The real 24-hour automatic-send delay was not awaited; these scheduled rows must not be reported as delivered or opened. Adding a source or resolving an import still cancels the corresponding reminder.

The operator subsequently requested faster acceptance instead of waiting 24 hours. Two immediate manual transport previews use the pending journeys' actual copy and contextual destinations, through the existing `postal_transport_test` circuit. Their subjects start with `[TEST Norva - immediat]`. The previews remove the lifecycle tracking parameter so opening one cannot fabricate an early opening event for its scheduled delivery; the source/help destination itself is unchanged. The automatic schedule and transport cadence guards are unchanged.

Both immediate previews reached `sent` in the private SMTP receipts and the public outbox. SMTP acceptance was recorded at `2026-09-08T17:52:16.958916Z` for import help and `17:52:54.409121Z` for no-source help; both outbox acknowledgements completed at `17:53:01Z`. The operator subsequently confirmed actual inbox readability and both source/help links. These prove immediate transport and the accepted action paths, not the future scheduled-send timing. No next-day Codex automation was created.

The accepted immediate emails and supported import-readiness evidence enabled the scoped pilot described above. Terminal Xtream background completion and real customer automatic delivery remain separate, unobserved outcomes. Winback, other behavioral journeys and unrequested push channels remain closed.

### Source validation follow-up

The previous draft PR's cloud-contract job exposed four obsolete assertions after linking the artwork: three chose the first link as the authentication CTA, and one depended on a removed source comment. The updated checks locate the rendered authentication actions, require matching CTA/fallback URLs and ensure artwork clicks cannot invoke authentication; marketing checks exercise the actual rendered unsubscribe controls. All 32 focused auth, marketing-consent and email-quality tests pass.

A broader Windows run reported 3,793 passing tests, three skipped and three failures outside the email changes: a CI-evidence test parses LF-only workflow text from a CRLF checkout, and two subprocess fixtures lack local module resolution in this worktree. This local run is not reported as entirely green. All PR checks passed for source commit `9542b8eb63af9c3d933c6b512883ef195fa2ae48`, including cloud contracts, disposable database integration, Edge type checks, Android phone/TV compile and tests, mocked journeys, and Android/Windows builds ([build run 34260052373](https://github.com/Admin-Adher/Norva/actions/runs/34260052373), [integration run 34260052396](https://github.com/Admin-Adher/Norva/actions/runs/34260052396)). The broader reliability source changes remain published in draft PR 331, separate from the live deployment evidence.

## Operations evidence

Production release directories:

- `/home/adrien/.norva/email-reliability-20260908`: worker rollback, independent monitor and reliability proof material.
- `/home/adrien/.norva/email-reliability-edge-20260908`: dunning/renewal release and live email-cron proof.
- `/home/adrien/.norva/email-ui-edge-20260908`: initial glass envelope and database backup.
- `/home/adrien/.norva/email-ui-images-edge-20260908`: final illustrated templates, image-selection migration, baseline manifest, rollback and database proof.
- `/home/adrien/.norva/email-ui-linked-artwork-20260908`: current linked illustrations, forward database migration, rollback and presentation proof.
- `/home/adrien/.norva/behavioral-readiness-20260908`: defect reproduction, migration, original function definitions, security/configuration checks and application proof.
- `/home/adrien/.norva/behavioral-internal-canary-20260908`: configuration baseline, audited internal activation, private QA identities, observed client timezone and real-delay canary proof.
- `/home/adrien/.norva/behavioral-email-pilot-20260908`: immutable device/operator evidence manifest, rolled-back activation preview, baseline, audited 10% email pilot transition and normal service-RPC verification.

The active illustrated frame SHA-256 is `a93f0c17270b211275140dae2d6978a12d8b0afecb6caa2394c220af55b3aa56`. The final database function definition SHA-256 is `b9cd11ac8f0094b2be6877a254bc84f1b8ac59efcf41929240c6a09fa5fef1c7`.

The reminder/context migration SHA-256 (LF-normalized) is `23f2373ac04fd6481c909258f063c5ad73231ccee40383b3f96e79a964b556e6`. The resulting function-body MD5 markers are `b63e2cae486acabd949ba425ecc5b1a3` for relevance and `446e633984acc835673c77990c54174a` for source-context projection. These are deployment identity markers, not security assurances.

At `2026-09-08T18:11:39.993584Z`, live aggregate delivery health showed zero overdue import, branded, support or billing-receipt emails; zero expired auth messages in the last 24 hours; two known auth failures; and zero import or branded dead letters remaining within the rolling 72-hour window.

Operational directories contain private configuration and must not be copied into Git. Frozen outbox payloads must not be rewritten to apply a newer design; the new presentation applies at initial rendering for subsequent messages.
