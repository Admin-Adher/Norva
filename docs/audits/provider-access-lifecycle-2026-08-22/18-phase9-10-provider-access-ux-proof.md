# Phase 9–10 Provider Access UX proof

Date: 2026-08-24  
Scope: optional onboarding capture, Settings lifecycle/restoration UI, dedicated Provider Access Edge client, phone/WebView and Android TV presentation.  
Rollout state: all Provider Access flags remain OFF.

## Result

```text
PHASE_9_ONBOARDING_IMPLEMENTED_AND_LOCALLY_PROVED
PHASE_10_SETTINGS_IMPLEMENTED_AND_LOCALLY_PROVED
PRODUCTION_VISIBILITY_NOT_ENABLED
```

The UX is wired only to the dedicated durable Provider Access contract. Xtream
credentials are never returned to the legacy source PATCH. If the independent UI
gate is off, a credential edit is refused without mutating the saved login.

The interactive calendar explored during review remains an ignored local visual
prototype. It is not part of this product change and has not been deployed.

## Product contract implemented

- Onboarding accepts an optional provider-access period after a valid Xtream login.
- A user may provide semantic duration (`day`, `week`, `month`, `year`) or explicit
  dates, never both.
- Calendar arithmetic is performed by PostgreSQL and the semantic term is retained.
- Provider-access validation errors are independent from login validation errors.
- Settings separates technical source health from provider-access state.
- Restoration exposes three explicit paths: current access extended, new login
  details, or a different provider/catalog.
- Candidate login submission uses an immutable candidate transition with revision,
  idempotency and polling preconditions.
- Ambiguous, stale, retryable, terminal, rollback and post-swap verification states
  have explicit user-facing representations.
- Provider Access is independently default-off.
- Android TV never collects provider credentials and presents the existing
  `Continue on phone or web` handoff.

## Mechanical evidence

### Browser and static contracts

```text
node --test tests/provider-access-ux-contract.test.js \
  tests/android-tv-navigation-contract.test.js \
  tests/onboarding-ui-contract.test.js

48 tests
48 passed
0 failed
```

The mono-account mutation ordering contract was updated to reflect the durable
candidate path and proves that every accepted source mutation releases playback
before the legacy display-name mutation. It also proves that Xtream username and
password never re-enter the legacy source PATCH.

```text
node --test tests/mkv-sequential-handoff.test.js \
  tests/provider-access-ux-contract.test.js

16 tests
16 passed
0 failed
```

### Full repository suite

The first full run exposed one genuine stale test expectation and one transient
Gateway fixture failure. The source mutation ordering was corrected and the
obsolete credential-PATCH assertion was replaced by the new fail-closed contract.
The Gateway scenario passed in isolation and in the complete rerun.

```text
npm test

2605 tests
2603 passed
0 failed
2 expected runtime skips
```

### Android JVM suites

```text
clients/android-phone :app:testDebugUnitTest -> BUILD SUCCESSFUL
clients/android-tv    :app:testDebugUnitTest -> BUILD SUCCESSFUL
```

### Android phone runtime

The debug APK was built and installed on `Norva_API35`. The Provider Access
Settings surface rendered in the native WebView. A cold native Back replay closed
the active modal through the production `window.__norvaHandleBack` bridge and kept
the application foregrounded.

Evidence:

- `output/playwright/android-phone-provider-access-harness.png`
- `output/playwright/android-phone-provider-access-bridge-before-back.png`
- `output/playwright/android-phone-provider-access-bridge-after-back.png`

### Android TV runtime

The debug APK was built and installed on `Norva_TV_API34`. Through the native
advanced local connector, a TV-mode harness using the production Settings classes,
copy and stylesheet rendered the handoff card. The accessibility tree contained:

```text
Continue on phone or web
norva.tv/account
This TV never asks for provider credentials.
```

The deliberately present source-management credential controls were hidden by the
production TV rule and absent from the runtime accessibility tree.

Evidence:

- `output/playwright/android-tv-provider-handoff.png`
- `output/playwright/android-tv-provider-handoff.xml`

## Database evidence used by the UX

The Provider Access cycle proof now contains 39 assertions. It proves PostgreSQL
calendar resolution (including calendar months rather than client-side fixed-day
approximations), semantic term retention, revision CAS, lifecycle state and the
visibility gate. This evidence was run on the disposable proof database before
this report.

## Remaining boundary

Phases 9–10 are locally implemented and proven, but this is not production
activation evidence. Public visibility remains governed by the independent flags
and the Phase 16 rollout gates. The calendar prototype requires an explicit product
approval before it can become a tracked implementation.
