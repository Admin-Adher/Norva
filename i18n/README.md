# Norva interface localization

Validated and published to the web on 2026-09-05. Android production releases 31 submitted to Google Play; Google review remains external. Work isolated in Norva-i18n-publish-20260905.

## Languages and preference

English, French, Brazilian Portuguese, Spanish, Hindi, Turkish, Bengali, Arabic,
Indonesian and Filipino. The device language is the default. Settings can force a
language per device; switching rebuilds cached web views and restores focus.
Android LocaleManager and the native preference bridge use the same policy.
Audio, subtitles and content-region preferences remain independent.

## Coverage

- 7,104 web messages and 73 shared messages: all ten locale values present,
  with no missing or duplicated interpolation parameters.
- 320 native source messages, generating 3,240 translated Android resource entries,
  including locale-specific plural categories. No MissingTranslation baseline.
- Audited account, billing, settings, profiles, provider onboarding, media catalogue,
  player errors, subtitle status, Partners and administration UI. Context-reviewed
  residual extractions are recorded in reviewed-ui-literals.json.
- Published blog navigation is localized; authored article prose keeps its original
  language. User/provider content, brand names, technical identifiers, logs, typed
  confirmations and outgoing message templates retain their source values.
- Named DOM slots preserve links/actions and escaped parameters. Initial labels
  release ownership after an imperative state change. RTL uses logical spacing;
  region display names use Intl without changing stored country/content codes.
- Full sentences replace hardcoded trial-day fragments; relative times use Intl.
- The consent banner updates in place when the UI language changes, preserving focus, button identity and the unmodified consent decision.

Coverage counts describe registered UI messages. Machine translation and structural
checks are not a professional linguistic certification of every sentence, nor proof
of every possible authenticated playback/provider/account combination.

## Validation

Local evidence is under output/i18n/ (ignored, no credentials):

| Check | Result | Evidence |
| --- | --- | --- |
| Complete regression suite | 3,549 passed, 0 failed, 8 skipped | release-tests-final.log |
| Strict catalog/build reproducibility | 7,147 messages, ten languages | release-check.log |
| Public routes | 56 checks: 14 routes, French/Arabic, 390/1280 px; no overflow | release-journeys.json |
| Actual browser bundle | Ten languages, RTL, escaping, state transitions, retained DOM actions | release-browser-runtime.log |
| Playback/source/financial labels | Actual page methods, ten languages, local fixtures | release-journeys.json |
| Android phone | JVM, lint, two device/WebView tests passed | release-phone-validation-final.log |
| Android TV | JVM, lint, two device/WebView tests passed | release-tv-validation.log |
| Region model and Pages Functions | Passed | release-region-contract.log / release-functions.log |

Device/WebView tests are offline and do not perform purchases, identity verification,
or provider playback. Earlier emulator evidence covers native Arabic Downloads and
TV settings/error/Back at font scale 1.3. A Play review or installed-device rollout is
separate from local build validation.

The mobile pairing error and privacy table were adjusted after the rendered checks
found small-screen overflow. Region localization now preserves canonical data;
empty-synopsis replacement compares the localized fallback. Business assertions were
updated only where localization metadata/calls changed their source representation.

## Translation generation and secrets

Cloud Translation generated the catalogue in bounded batches, with saved responses,
no automatic network retry, and rejection of damaged parameters. The user-authorized
Translation-only API key was held in a local process, never embedded in shipped
assets or command arguments. No runtime Google Translation request is needed.

Local request ledger: **801,762 characters / 397 requests**.
The cumulative script ceiling is 1,000,000 characters. This ledger is not an account-
wide quota or an invoice; the full-account upgrade was not activated by the agent.
The earlier evaluated local model was rejected and its outputs are not in the release.

## Publication

- Web deployment verified: Git main 4e919257, Cloudflare run 33954860592, 3,553 tests passed / 0 failed / 7 skipped. Six served assets matched local SHA-256 values.
- Live browser: all ten languages switched, Filipino preference persisted after reload; 280 route/language/viewport checks had no locale, direction or horizontal overflow failures (14 routes x 10 languages x 390/1280 px).
- Phone 1.3.18 (31) and TV 3.8.18-hybrid (31): signed bundles from run 33954616434 accepted by Play and submitted for full production rollout. No supported devices lost. Managed publishing is disabled, so approved releases publish automatically.
- Play review and quick automated checks are still in progress; submission is not yet public availability. Phone listing translations already under review were preserved in the restarted review.
- Android bundles were built from 38840bab. Later Git changes concern validation scripts/tests, integrity metadata and web account copy; no native implementation changes.

Target versions: phone 1.3.18 (31), TV 3.8.18-hybrid (31).
Main triggers the Cloudflare deployment and Android build workflows. The Android
Release workflow produces signed AABs for Google Play. Git, CI, domain deployment,
Play submission, Google review and user-installed updates are distinct milestones.
The final task report records their verified state; progress.json is the pre-push
validation checkpoint and does not assert production availability.

## Maintenance

### Subscription page follow-up (2026-09-05)

The `/subscribe` audit identified gaps beyond catalogue completeness. Thirty
context-reviewed messages now cover complete pricing, savings, promotion and
account-state sentences. Dynamic labels keep their state through initial
translation and language changes; web accounts no longer inherit Google Play's
loading message. Arabic money tokens are isolated from their billing periods.

The benefits heading has its own row, long labels can wrap, and the fixed decision
bar reserves its measured height so enlarged text cannot cover the footer links.
The existing plan-first flow and verified billing values remain the source of truth.

Evidence is kept under `output/playwright/subscribe-fix-20260905/`: browser viewport
and enlarged-text matrices, offline account/promotion fixtures, and the actual
Android System WebView at 100% and 130% text zoom. Fixtures cannot purchase.
The final report records the deployed commit, CI and live-page verification
separately; Android instrumentation is not a new Google Play publication.

### Catalogue workflow

- npm run i18n:build generates strict web/native assets.
- npm run i18n:check rejects stale or incomplete generated assets.
- npm run i18n:audit and scripts/i18n/audit-residuals.cjs report candidates for review.
- scripts/i18n/migrate-web.cjs requires contextual review before applying extraction.
- scripts/i18n/translate-cloud.cjs is a development-only draft generator.
- Preserve protocol values and provider content; add complete messages rather than
  joining translated suffixes. Run the affected behavioral and device checks.
