# Norva interface localization — work in progress

This is the initial implementation, **not a completed 100% translation rollout**.
The agreed list contains ten distinct languages: English, French, Brazilian
Portuguese, Spanish, Hindi, Turkish, Bengali, Arabic, Indonesian and Filipino.
English/French cover several of the nine target countries; countries are never
used to force an interface language.

## Implemented

- Device-local `auto` / explicit preference. Browser uses `navigator.languages`;
  APKs expose Android's system languages and per-app preference. Unsupported
  languages fall back to English. `pt-*` maps to Brazilian Portuguese, `tl` to
  Filipino and the legacy Android `in` code to Indonesian.
- Forty-one shared messages translated into all ten languages in
  `messages.json`, ordered by `locales.json`. These are actual translations,
  not English placeholder copies counted as coverage.
- Deterministic web i18next bundle, shared Android XML resources, explicit
  language configuration and asset hashes. No runtime translation requests.
- Settings selector with native language names, associated label/hint, live
  status, 48px minimum height, failed-save handling and preserved web focus.
- Selected static web navigation labels and native setup/error labels migrated.
- Android context wrapping for activities/application/download service and a
  locale-only bridge for cloud, standalone and local connector WebViews.
- RTL document direction and the selector's layout; logical horizontal Settings
  tab navigation. Full application/TV spatial navigation RTL is still pending.

## Development

Run `npm run i18n:build` after editing messages or language resources. It validates
that each message has a nonempty translation for every language and that named
placeholders match, generates both APK resource sets and the web bundle, and
updates only i18n asset hashes. Run it before building APKs or publishing web changes.

Web text uses explicit `data-i18n="ui_key"` markers on leaf elements. Attributes
use `data-i18n-aria-label`, `data-i18n-title`, `data-i18n-placeholder` or
`data-i18n-alt`. Dynamic labels must use `NorvaI18n.t()` at their state transition;
do not attach a static key to a button whose wording changes during a request.
Translations are written with `textContent`/`setAttribute`, not `innerHTML`.
Provider titles, URLs, account information and user text are never translated by
DOM scanning. An observer processes only explicitly marked UI.

`npm run i18n:audit` writes `output/i18n/inventory.json` with source locations,
candidate copy and per-platform native resource coverage. Its current inventory
has 5,834 candidate occurrences, including duplicates/false positives that require
review. This excludes editorial blog content, backend copy, vendor UI and some
nonliteral runtime messages, so it is not a complete string count.
`npm run i18n:audit -- --check-coverage` intentionally fails while migration remains.
No coverage percentage or release readiness should be inferred from the selector.

`node scripts/i18n/preview.cjs` serves a local-only preview of the actual language
section at `http://127.0.0.1:4179`. This is component validation, not a substitute
for authenticated application or native playback validation.

## Remaining before the agreed release

1. Review the inventory, centralize all owned UI copy, translate it into all ten
   languages, including native player/download resources, accessibility strings,
   notifications, dialogs, recovery, account, authentication and subscription.
2. Extend to the independent web entry points; they currently do not load this
   runtime. Integrate initial-language boot into every owned interface.
3. Introduce plural resources and Android formatting conversion for parameterized
   messages as they are migrated. Never concatenate translated sentence fragments.
4. Convert physical layout constraints to logical ones and validate TV D-pad
   navigation throughout the RTL catalogue, guide, modals and native player.
5. Verify context recreation/route/focus continuity, Android 6–12 behavior,
   Android 12→13 preference migration, active service notifications and offline
   starts. Current tests do not certify these transitions.
6. Validate all routes/states at desktop/mobile/TV viewports, Android font scale
   1.3, both navigation modes, keyboard visible, TalkBack and offline/retry states.
7. Complete translation review/glossary checks and wire a reviewed coverage gate
   into release workflows. Publication is separate from this local implementation.

UI language is independent of audio, subtitles, content region, title metadata,
household membership and billing. Their persistence is not changed.

## Validation recorded on 2026-09-05

- 82 distinct focused Node tests passed (language policy/runtime/cache, Settings,
  navigation, native continuity, accessibility and consent contracts).
- Android phone: compilation and 25 JVM tests passed. Android TV: compilation and
  20 JVM tests passed. Debug APKs and instrumentation APKs assembled successfully.
- `UiLanguageDeviceTest` passed once for each APK on an isolated, read-only Android
  TV API 34 emulator: all ten language resources, RTL configuration and automatic
  fallback. This is resource integration evidence, not phone-layout evidence.
- Browser component preview: ten languages at 390px and 1280px; twenty combinations
  checked for overflow, control size, unchanged provider text and focus retention.
  Preference survived reload and language switching worked offline. Arabic,
  Bengali and Hindi screenshots are under `output/i18n/`.
- The first phone API 35 emulator did not finish cold boot and was stopped. No
  claim is made about phone emulator replay, TalkBack, RTL TV navigation or full
  application coverage. Both isolated emulator processes were stopped after use.
- Git diff whitespace check passed for the touched web files. Existing unrelated
  worktree changes were preserved. Nothing was committed or deployed.

## Publication validation on current main (2026-09-05)

The foundation was replayed in an isolated worktree based on `df4220e9`, preserving
current catalogue access gates and all unrelated changes in the original checkout.
Phone compilation and 29 JVM tests passed; TV compilation and 24 JVM tests passed.
Cloudflare Functions compiled and the region model check passed. The previous
validation above refers to the initial implementation, before this main integration.
This foundation still does not provide complete interface translation.

Full Node regression: 3,544 passed, 8 skipped, zero failures (3,552 tests).
