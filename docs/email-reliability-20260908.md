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

The focused follow-up passed 42 existing tests, the networkless PostgreSQL shell proof, and 21 rendered viewport checks with zero overflow or broken images. Both production Edge replicas passed health and hash checks with unchanged configuration; the database owner and ACL were preserved. A single new internal Gmail hover-check sample was queued under the immutable key `email-linked-artwork-20260908:verification`; real hover acceptance remains separate from the earlier successful image-display confirmation.

## Activation still gated

The `no_source` and `import_unresolved` journeys remain `draft`, rollout 0%, with the behavioral emergency stop enabled. No import-readiness attestation was fabricated.

On the physical Android phone (Norva 1.3.19 / build 32), a real M3U import completed with eight channels, and required-field guidance was observed. The temporary QA source was disabled after validation. The existing Xtream source was resynchronized; its latest observed inventory was 276,965 items and the catalogue was usable while the remaining background title work continued at 90%. This does not establish a completed terminal import or full acceptance of both behavioral email paths.

The next gate is to complete the actual import/error/help-path acceptance, record the supported readiness evidence, validate the two internal email paths, then enable only the requested email journeys with a fresh eligibility boundary. Winback, other behavioral journeys and unrequested push channels should stay closed.

## Operations evidence

Production release directories:

- `/home/adrien/.norva/email-reliability-20260908`: worker rollback, independent monitor and reliability proof material.
- `/home/adrien/.norva/email-reliability-edge-20260908`: dunning/renewal release and live email-cron proof.
- `/home/adrien/.norva/email-ui-edge-20260908`: initial glass envelope and database backup.
- `/home/adrien/.norva/email-ui-images-edge-20260908`: final illustrated templates, image-selection migration, baseline manifest, rollback and database proof.
- `/home/adrien/.norva/email-ui-linked-artwork-20260908`: current linked illustrations, forward database migration, rollback and presentation proof.

The active illustrated frame SHA-256 is `a93f0c17270b211275140dae2d6978a12d8b0afecb6caa2394c220af55b3aa56`. The final database function definition SHA-256 is `b9cd11ac8f0094b2be6877a254bc84f1b8ac59efcf41929240c6a09fa5fef1c7`.

Operational directories contain private configuration and must not be copied into Git. Frozen outbox payloads must not be rewritten to apply a newer design; the new presentation applies at initial rendering for subsequent messages.
