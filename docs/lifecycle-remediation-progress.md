# Lifecycle remediation — active, not complete

Working branch: `codex/lifecycle-remediation-20260905`, isolated worktree based on fetched `origin/main` at `a3eed288`. The original dirty checkout is untouched. No production deployment, send, or audience activation is authorized by this progress record.

## Full scope and acceptance gates

- [ ] Confirmed-signup welcome independent of entitlements, durable idempotence, no automatic historical blast.
- [ ] Import failure email distinguishes permanent action-required failures from genuinely scheduled retries.
- [ ] Shared browser/server input classification, including emails, names, malformed domains, valid DNS/IP and complete Xtream access; app-only guidance in the settings modal.
- [ ] Verified device timezone/provenance and safe scheduling for unknown timezones.
- [ ] Conditional no-source email at +24 h when push unavailable, preserving caps, quiet hours, conversion cancellation and no duplicates.
- [ ] Real controlled import/first-play attestation.
- [ ] Authorized internal email/push, real-device deep link, receipt, foreground/background, post-conversion and offline-delay checks.
- [ ] Separately authorized 10% pilot, then mature J+7/J+14 evidence; no completion claim from local tests alone.

## First implementation increment

The server telemetry parser now discards email-like schemeless inputs, single-label names, malformed DNS, noncanonical numeric IPv4 aliases and invalid IPv6. Discarded hosts carry neither normalized domain nor host hash and cannot be relabeled with a client path hint. Explicit HTTP userinfo URLs remain classifiable without returning credentials. The client-diagnostic intake also discards hashes and path classifications when its domain is invalid, preserving reserved anonymous network labels.

Focused verification: `node --test tests/source-attempt-host-validation.test.js tests/source-connection-attempt-telemetry.test.js tests/m3u-large-playlist.test.js` passes 16 tests, including the 25,001-entry playlist.

This is NOT an end-to-end fix yet: browser normalization can turn an email into an explicit HTTP URL before it reaches the server. The next input step must share the classification logic and test the original input in `SourceManager`/onboarding, not only the server summary.

## Welcome integration constraint discovered

Changing `runWelcome()` alone is insufficient. The final email authorization in `20260722003000_lifecycle_email_delivery_outbox.sql` also requires an entitlement row for the `welcome` marker, and provider acknowledgement marks `welcome_email_at` on that same table. The correction must change cohort selection, final authorization and durable completion together. Keep a no-backlog activation cutoff and do not fabricate entitlement rows for free accounts.

## Remaining external gates

Production currently remains dormant by design. Internal test sends and pilot activation require their dedicated authority. The previous audit detected Android 1.3.17 with notification permission, but automatic device navigation was blocked; do not treat that as a receipt/deep-link proof or bypass the tool restriction.

## Incremental production rollout — 2026-09-05

The user explicitly authorized incremental production deployments and tests on their USB-connected phone. This authorizes controlled internal notification tests, not general customer communications or the 10% pilot. Earlier no-deploy/no-send statements above describe the previous stage.

The first server-only telemetry increment is deployed on both `norva-edge-functions` replicas. The deployment cloned the actual running function tree and overlaid exactly two reviewed files, preserving every unrelated file and Compose setting. No SQL migration, gateway change, web publication, client send, or audience activation occurred.

- Release directory: `/home/adrien/.norva/source-attempt-20260905-r1`.
- `_shared/source-connection-attempt.mjs` SHA256: `e039599b918892a838ccf4bc8e5388ea8897400795e39b885cc91ce2e512ac1d`.
- `norva-cloud/index.ts` SHA256: `da316500964bed870da52de2f10197e6814a715685ff6395e9e9eb83eadda48d`.
- Baseline hashes matched the isolated worktree base before staging. Both runtime file hashes were verified after sequential recreation.
- Both playback readiness checks and direct `/norva-cloud/health` checks returned healthy on both replicas.
- Local checks: 16 focused tests passed; Node TypeScript syntax check and git diff whitespace check passed.
- Operator script: `ops/hetzner/scripts/deploy-source-attempt-20260905.py`. The server plan preserves original Compose arguments for per-replica rollback. Automatic readiness failure restores the prior Compose definition; rollback readiness must then be checked.
- USB phone: Android app `1.3.17`, versionCode `30`, notification permission granted. This is not a delivery or deep-link test.

Still required: identify the controlled account currently signed into that phone before sending; the browser currently has Play Console, Google Ads and Clarity only. No customer identity is inferred from the device model or FCM counts. Shared browser validation and all other acceptance gates above remain open.
