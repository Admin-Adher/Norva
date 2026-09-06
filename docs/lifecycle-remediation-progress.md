# Lifecycle remediation — active, not complete

## Latest verified state — 2026-09-06

Work resumed in isolated branch `codex/lifecycle-resume-20260906` from `origin/main` `4ed43231`. Previously deployed telemetry, failure-copy and dormant welcome increments were reconciled into this branch. The original dirty checkout and the earlier remediation worktree remain preserved.

- Postal is the live Norva email transport; this does not activate any behavioral audience. The four journeys are still draft/0%, emergency stop is on, the independent signup welcome gate is disabled, and behavioral outbox/receipt counts remain zero.
- Timezone provenance and its FCM-independent authenticated context RPC are installed on Hetzner. Web commit `2df5768e974d5a25a0aa005f81e7d3209de4e1a1` is on `main`; Cloudflare CI `34031952452` succeeded and both live JavaScript hashes match the release.
- Local full Node suite: **3,701 passed, 0 failed, 8 skipped** (3,709 total). The skips remain unproven runtime scenarios, not successes. Generated locale validation, region model and JS/TS syntax checks pass. A localization-sensitive test now scopes assertions to the real connection section rather than a brittle character-count limit; no provider UI behavior was changed for that test.
- Real PostgreSQL 17 synthetic integration proof passed. The live controlled-account RPC smoke also passed in a transaction that was explicitly rolled back, without changing the account timezone, creating a token, claiming a job or sending an email.
- The reconnected USB phone runs Android Norva 1.3.17 (code 30), with notification permission granted. After reopening the deployed web shell, production recorded Europe/Paris with `device` provenance. One authorized generic push was accepted by FCM and actually observed in the phone's notification shade while Norva was backgrounded. The user must perform the tap; lifecycle-specific deep links, foreground behavior, deduplication and conversion cancellation remain unproven.
- Still outstanding: shared input validation/settings guidance completion, conditional +24h no-push email and its final Postal authorization, controlled import/first-play attestation, real internal sends, then separately authorized pilot and mature J+7/J+14 results. Do not activate the pilot or revive paused Codex monitoring.

Evidence outputs are under `outputs/01a05135-6828-78c2-aeae-17738180c47a/lifecycle-followup-20260906/` in the original workspace (not committed customer data).

Working branch: `codex/lifecycle-remediation-20260905`, isolated worktree based on fetched `origin/main` at `a3eed288`. The original dirty checkout is untouched. No production deployment, send, or audience activation is authorized by this progress record.

## Full scope and acceptance gates

- [ ] Confirmed-signup welcome independent of entitlements, durable idempotence, no automatic historical blast.
- [ ] Import failure email distinguishes permanent action-required failures from genuinely scheduled retries.
- [ ] Shared browser/server input classification, including emails, names, malformed domains, valid DNS/IP and complete Xtream access; app-only guidance in the settings modal.
- [x] Verified device timezone/provenance and safe scheduling for unknown timezones (SQL and real phone context evidence below; no outbound journey enabled).
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

## Second increment — import failure guidance (local, not deployed)

The Xtream failure producer records a bounded `failureDisposition` on its event: terminal failures require action; nonterminal failures remain unknown because nonterminal alone does not prove a durable retry. The digest reads only that disposition from its already-claimed event IDs, scoped to the user and failure kind. Legacy events are unknown. Raw provider errors/credentials are not selected for copy generation.

Email HTML/plain text now distinguish action-required from unknown, remove unconditional retry promises, explain M3U versus Xtream, and warn against emailing private URLs/passwords. Push no longer says "We're on it". Exact email payload freezing and idempotency remain unchanged, so already-frozen messages are deliberately not rewritten.

Verification: 26 tests passed across template, locale, outbox contract and visibility suites; a subsequent added status test also passed (3/3 guidance suite), covering 401/403/404 versus 408/429/503. Most outbox tests are structural, not real provider delivery proof. Node syntax checks pass for the two Edge entry modules changed. Initial test execution lacked esbuild in the isolated checkout; tests then used the existing original checkout dependency via process-local NODE_PATH without changing that checkout.

Before incremental deployment: verify the bounded JSON projection against the actual PostgREST API without claiming jobs/sending, review exact production baselines for all three files, stage the scoped overlay and validate worker startup. This increment still uses the generic Open Norva action; targeted import deep-link and device behavior remain a separate open requirement. Welcome eligibility, timezone safety and +24h email fallback remain unimplemented.

### Second increment production verification — 2026-09-05

The above predeployment checks are now completed. The PostgREST projection returned HTTP 200 with `limit=0` (no event values fetched). The reviewed three-file overlay was deployed sequentially on both Edge replicas from `/home/adrien/.norva/import-guidance-20260905-r1`, preserving the previous telemetry correction and all unrelated running files. Both readiness checks passed. Direct GET probes to `norva-import-notify` returned its expected HTTP 405 JSON on both replicas, proving entry-module loading without invoking the digest or claiming messages.

Verified SHA256:
- `_shared/import-email.ts`: `63d0832c73292cdd4bb1a5427e77e35bd634fbe237edde1c92f7b2672e0e10b6`
- `_shared/xtream-sync.ts`: `d61ee2ea4872d16a0c06951cf6f5b19bed2ab4d9ca4803d63b20ff381b370545`
- `norva-import-notify/index.ts`: `e206d7cc9571c773210730ba630b019ec5a2eb0b64222a0724725aed92c27467`

No operator-triggered email/push was sent. Existing transactional cron behavior is unchanged and future import failures can use the new copy. Behavioral runtime remains stopped in internal-test mode. Provider delivery, real receipt and deep-link tests remain unproven.

The user identified their connected admin account for the internal test. Read-only verification found exactly one confirmed account and five Android tokens, of which only one has granted permission, version 1.3.17 and Europe/Paris timezone (last seen 2026-09-05 07:26 UTC). The other four have unknown permission/version and must not be targeted. Account identifiers and tokens are intentionally omitted from this evidence document. The production lifecycle engine requires fresh post-activation cohorts; do not fabricate events or bypass its gate to treat this existing admin as a full journey test.

## Third increment — confirmed-signup welcome, deployed dormant

Migration `20260905143000_confirmed_signup_welcome.sql` creates a service-only candidate RPC, a separate durable signup welcome marker and a disabled activation gate with a cutoff. Cohort selection requires both signup creation and email confirmation after the cutoff, a confirmation within 72 hours, no internal-account marker, no prior welcomed entitlement and no existing welcome outbox delivery. The worker no longer selects subscription rows. Final authorization changes only the welcome branch of the mature pre-behavioral function; its body baseline is checked before replacement and the outer behavioral wrapper remains untouched. A transactionally coupled outbox state trigger records the independent marker after successful provider acknowledgement. No entitlement is fabricated.

Real PostgreSQL 17 proof ran in disposable container `norva-welcome-proof-20260905` (network disabled, 512 MiB memory cap, 1 CPU, tmpfs data), not in the production database. The checked-in bootstrap and integration fixture use the actual existing completion function. `SIGNUP_WELCOME_RUNTIME_PROOF_OK` proves disabled selection, confirmed/free-account eligibility, old/internal/unconfirmed exclusion, repeated candidate idempotence, existing-queue exclusion, wrong-key rejection, successful acknowledgement, durable independent marker, duplicate acknowledgement refusal, role boundaries, revoked-confirmation cancellation/payload scrubbing and runtime-stop cancellation. It does not prove external delivery or device behavior.

Production installation first failed on function ownership and its entire transaction rolled back (table absence verified). It then committed under the existing owner `supabase_admin`. The baseline body hash differed only in CRLF line endings; normalized MD5 matched `cf3b362e4a2de85cf2eea25c52a4735d` before replacement. No in-flight welcome was present at preflight.

The one-file worker overlay was deployed to both replicas at `/home/adrien/.norva/signup-welcome-20260905-r1`, preserving all unrelated functions and the two preceding increments. `norva-lifecycle/index.ts` SHA256 is `94f837d69b98367a8ba8a42f8ae18c51bb23844442fe8fd208fd200e8968ba86`. Both runtime hashes/readiness checks and direct lifecycle health probes passed. A rolled-back production smoke returned zero candidates and zero markers, welcome enabled=false, behavioral emergency_stop=true/internal_test.

Remaining gates: the signup welcome gate must be activated with a fresh cutoff only after review of copy/deep-link and authorized send validation. The current welcome still uses the generic app link. Actual email receipt, targeted push, timezone provenance, +24h fallback and full shared UI validation remain outstanding; do not describe this dormant deployment as an active welcome service or completed objective.

## Fourth increment — timezone provenance (local, not deployed)

`20260905160000_lifecycle_timezone_provenance.sql` separates explicit device timezone reports from default/unknown UTC, records provenance and observation time, preserves the last good timezone against invalid metadata, and treats reports older than 45 days as unverified. Legacy provenance is established only from matching valid non-default timezone reports on versioned push tokens, never country/IP inference. Outbound scheduling and final delivery eligibility require verified timezone; in-app help remains available. Cloud token intake no longer substitutes UTC for missing metadata.

Real PostgreSQL test `tests/sql/lifecycle-timezone.integration.sql` passed against the complete behavioral engine in a network-disabled, 512 MiB disposable database (`norva-timezone-proof-20260905`): `LIFECYCLE_TIMEZONE_RUNTIME_PROOF_OK`. It covers default/missing timezone rejection, explicit India/UTC acceptance, invalid update preservation, India and Bangladesh quiet hours, withheld external scheduling versus available in-app help, scheduling after verification, and final refusal after timezone evidence expires. No provider requests or production changes occurred for this increment.

Before deployment: add authenticated context reporting independently of FCM so users without push can become email-eligible; verify production function baselines before replacing them; deploy Cloud's empty fallback to both replicas BEFORE the SQL provenance migration (otherwise the old Cloud UTC fallback could falsely establish provenance). Review fresh SQL tests and metadata collection. The conditional +24h no-push email remains to implement; existing J+3 configuration is unchanged.

### Fourth increment installed on Hetzner — 2026-09-06

Those backend prerequisites are now satisfied. Context reporting derives the account exclusively from authenticated identity and accepts only a timezone payload. It does not require an FCM token or analytics consent, never invents UTC, and retries after a failed report. Client reports are coalesced and throttled for one hour per account/timezone; returning to a visible page refreshes stale observations. Explicit, observed UTC remains valid. An explicit `timezoneObserved` protocol flag prevents older clients' default UTC from minting fresh provenance.

Both Edge replicas were updated sequentially using the exact prior runtime as the baseline. All unrelated function files, environment values, container images and Compose settings were preserved. The new `norva-cloud/index.ts` normalized SHA256 is `f524d4687f40e8f1ff1815a9e38e89606ab5959e82e55acc0fec185d0b2de36f`. Both readiness checks passed.

Migration normalized SHA256: `8695b3f72227334b295fc4cd7327910be44a1aab69698cacee4585c45a8eecde`. The migration requires stopped/draft audiences, checks the three production function baselines and uses 5-second lock/30-second statement timeouts. It committed after both new Cloud replicas. The prior function definitions are preserved at `/home/adrien/.norva/lifecycle-context-20260906-r1/timezone-functions.before.sql`; no broad rollback or destructive schema reset is needed.

At 11:59 UTC, 439 user states had matching legacy device evidence and 238 remained unknown. Unknown does not mean the timezone value is wrong: it means no sufficiently trustworthy observation exists, so outbound behavioral messages remain ineligible. No country-derived timezone correction was fabricated.

`PRODUCTION_TIMEZONE_RPC_SMOKE_ROLLED_BACK_OK` verifies a real controlled account can record Asia/Dhaka without push, rejects an invalid timezone without overwriting the good observation, preserves token counts, restricts execution to service role and leaves every journey stopped. The transaction was rolled back. This is not proof of browser/Android transport or receipt.

Deployment helpers: `ops/hetzner/scripts/deploy-lifecycle-context-20260906.py` and `ops/hetzner/scripts/deploy-lifecycle-timezone-20260906.py`. Web publication and live asset verification remain separate gates; the conditional +24h email is not deployed by this increment.

### Web release and real phone context — 2026-09-06

Commit `2df5768e974d5a25a0aa005f81e7d3209de4e1a1` was pushed to `main`. GitHub/Cloudflare workflow `34031952452` completed successfully at 12:03:58 UTC, including the full Node suite and Pages deployment. Direct HTTP checks verified the HTML references and the actual served bytes, not only the CI result:

- `app.js`: `0e2ba9778e9424f2e9921f71b328ec4d909ae47434e3e3b28a9bfb152e3cc40c`.
- `cloudApi.js`: `2263d2b70e4d49f4fb2cfbc05cdfe6fd9e5559b054cede3560939cca18336b0b`.

The controlled admin identity was verified in the device UI. Only Norva was stopped and reopened to load the release; app data, account, consent and notification permissions were not reset. Production then recorded `Europe/Paris`, provenance `device`, observed at `2026-09-06T12:06:13.915787Z`, with verified timezone=true and one recent granted Android token on 1.3.17. This proves real device reporting. FCM-independent operation is covered separately by code/unit tests and the rolled-back SQL smoke, not inferred from this phone which also has push.

The tool refused automatic VIEW/deep-link navigation. That action was not retried or circumvented. The user must tap the link/notification for the real opening proof.

### Postal verification preserved across the Cloud overlay

The old read-only diagnostic required the former runtime folder literally and would misclassify the legitimate lifecycle release. Its replacement allowlists the two reviewed roots and compares all 139 files: only the exact reviewed Cloud before/after hashes may differ, and every other byte (including all email senders/shared transports) must match. Missing, added, symlinked or unexpectedly modified files fail closed. Both replicas must use the same root and be running. Seven Python fixtures passed on Linux; on Windows six passed and the symlink case was skipped because creating symlinks is unavailable. The 13 Postal transport tests and the FCM boundary test also passed.

The live verifier passed at 12:20 UTC on both replicas: eight sending boundaries on Postal, no Resend key in either Edge environment, private gateway healthy/enabled, old Resend contact worker stopped with no automatic restart, and zero pending Resend outbox items. Eight messages were recorded as sent by the Postal transport and three auth messages as canceled. Those aggregate states are not an inbox-placement or customer-read guarantee. The diagnostic replacement restarted no service and sent no email. Its exact predecessor is preserved on the server.

### One controlled background push — 2026-09-06

The user authorized internal tests on their connected admin phone. A bounded operator test checked exactly one confirmed controlled account and one fresh, granted Android 1.3.17 token. It verified both running FCM source hashes and used a bundle of that exact production sender. Credentials and the token remained in memory over private stdin and were not printed or persisted. The journal stores only a token hash and a provider-receipt hash. It was created exclusively before the external request; any ambiguous result permanently prevents automatic retry for this test.

One generic notification, **Norva internal notification test**, was accepted by FCM HTTP 200 at `2026-09-06T12:24:14.502722Z`. With Norva in the background, Android's rendered notification shade then exposed the exact title and benign internal-test text. This is actual phone receipt, beyond FCM acceptance. It contains no lifecycle delivery ID, source URL, credentials or invented conversion; it does not manufacture lifecycle receipts or bypass journey eligibility. TTL is 300 seconds, with a test-specific collapse key.

No email was initiated by this test and no customer journey or pilot was enabled. The four journeys remain draft/0% with emergency stop on. Actual user tap and opening, lifecycle deep-link routing, foreground/offline replay, duplicate suppression and conversion cancellation are separate pending checks. A single observed notification is not sufficient to certify all of them.

### User-reported blank push logo — correction prepared, not installed

The actual notification shade showed a solid rounded tile rather than the Norva N. This was not a test-mode effect: no FCM default notification icon was configured, and the native service also used the opaque launcher artwork as its small icon. Android uses a monochrome/alpha representation for that slot ([Firebase behavior](https://firebase.google.com/docs/cloud-messaging/android/receive-messages)).

Commit `974a33ff4d79729245861a62158703cd9424fbd7` adds a dedicated transparent vector adaptation of the rounded Norva N, shared by the FCM manifest fallback and the native notification builder. The native builder retains the existing, unchanged full-colour PNG as its large icon and uses the existing `norva_accent` resource. No sending payload, targeting, consent, deduplication or tap behavior was changed. The focus was preserving the established Norva branding, not redesigning the mark or the notification layout.

The two new Node branding contracts and the FCM boundary contract pass. GitHub run `34033658895` completed its cloud-regression and Android Phone jobs successfully, including native unit tests, lint, debug APK and instrumentation APK compilation/upload. The three new resource-level instrumentation tests are compiled but **not yet executed**. Local Gradle failed before compilation with `Unable to establish loopback connection`. The read-only emulator failed to start because C: had only 1.82 GiB free; no disk cleanup, permission change or data reset was performed.

The physical phone still has the Play-installed 1.3.17/code 30. It was not overwritten with a debug build or uninstalled. A signed Play-distributed update and a renewed real-device foreground/background visual check remain necessary before claiming the logo correction is effective for this user. CI success or a vector resource contract alone is not visual/device acceptance. No additional test push was sent after the original one-shot journal closed.
