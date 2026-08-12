# Settings redesign visual QA

Date: 2026-08-12

## Scope

- Web Account screen, Direction B, with the account/service health summary first.
- Android TV Account screen, TV-first navigation, including the `TV service needs attention` state.
- Standard cloud-user presentation was verified separately from the authenticated internal/admin account.

## Web Account — ready state

- Source: `C:\Users\AdrienHernandez\.codex\visualizations\2026\08\12\019ff56e-e45c-7393-ba9b-1d94a2ce2d70\norva-settings-account-health.png`
- Implementation: `C:\Users\AdrienHernandez\.codex\visualizations\2026\08\12\019ff56e-e45c-7393-ba9b-1d94a2ce2d70\norva-settings-account-health-implementation.png`
- Side-by-side comparison, reference left and implementation right: `C:\Users\AdrienHernandez\.codex\visualizations\2026\08\12\019ff56e-e45c-7393-ba9b-1d94a2ce2d70\comparison-settings-account-web.png`
- Viewport: 1280 × 720 CSS px, DPR 1 for both source and implementation.
- State: standard Norva Cloud user, active access, TV service ready, Account selected.
- Comparison scope: full visible Settings surface.

Findings and correction history:

- Matched the left rail, content column, status-first hierarchy, flat account/access/legal rows, typography, spacing and controls.
- Kept the requested Advanced destination visible even though the initial mock stopped at Library Management.
- Replaced generic status art with the real Norva live-TV asset and canonical tokens.
- Corrected the Advanced-row surface and the contrast of small Settings eyebrow text.
- Result: passed.

## Android TV Account — service needs attention

- Source: `C:\Users\AdrienHernandez\.codex\visualizations\2026\08\12\019ff56e-e45c-7393-ba9b-1d94a2ce2d70\norva-settings-tv-service-needs-attention.png`
- Implementation from the final debug APK on the TV emulator: `C:\Users\AdrienHernandez\.codex\visualizations\2026\08\12\019ff56e-e45c-7393-ba9b-1d94a2ce2d70\norva-tv-emulator-final-warning-standard-user.png`
- Side-by-side comparison, reference left and implementation right: `C:\Users\AdrienHernandez\.codex\visualizations\2026\08\12\019ff56e-e45c-7393-ba9b-1d94a2ce2d70\comparison-settings-tv-warning-standard-user.png`
- Instruction modal: `C:\Users\AdrienHernandez\.codex\visualizations\2026\08\12\019ff56e-e45c-7393-ba9b-1d94a2ce2d70\norva-tv-emulator-warning-modal.png`
- Physical viewport: 1920 × 1080 on `Norva_TV_API34`.
- WebView viewport: 960 × 540 CSS px, DPR 2.
- State: standard paired cloud screen, active access, service needs attention, `Show instructions` focused.
- Comparison scope: full visible Account surface.

Findings and correction history:

- Matched the warning banner, rail/content alignment, paired-screen identity, profile, access, handoff and legal rows.
- Matched the public copy from the selected mock, including `Valid via cloud synchronization`.
- Used the real Norva live-TV icon in amber instead of the mock's generic warning triangle.
- Added the 960 × 540 TV-density contract after the physical emulator exposed the WebView's DPR-2 CSS viewport.
- Kept TV capabilities read-only: only Account, Playback and TV Service are exposed.
- Result: passed.

## TV interaction and privacy checks

- Account → Right focused `Show instructions` without scrolling the panel.
- Center opened an `aria-modal="true"` dialog, focused `Done`, and made the app background inert and `aria-hidden`.
- Android Back closed the dialog and restored focus to `Show instructions`.
- Left returned focus to the Settings rail; Down selected Playback and activated its panel.
- The tablist reports vertical orientation and selected/focused states remain distinct.
- A warning fixture deliberately included a private source ID, provider type, username, password and raw provider message. None appeared in the TV DOM, attributes or visible copy; `auth_failed` was normalized to the public `degraded` presentation.
- The only warning action exposed on TV is `show-instructions`; it never opens provider credential or repair controls.

## Runtime verification

- `node --check` passed for the changed Settings/source-health/TV-navigation JavaScript.
- Focused Settings/TV contract suite: 87 passed, 0 failed.
- Final Android TV/cache regression subset: 90 passed, 0 failed.
- Full repository suite on the current `main` baseline: 1589 passed, 0 failed, 1 skipped.
- Android TV debug build: `BUILD SUCCESSFUL`; 33 tasks, final web assets synchronized.
- Final APK output: `clients/android-tv/app/build/outputs/apk/debug/app-debug.apk`
- Final APK confirmed `Settings.js?v=52`, `main.css?v=106`, 960 × 540 CSS viewport at DPR 2, and the bundled debug-audit assets.

## Result

Passed. The implementation and visual comparisons were completed locally; production deployment is not claimed by this report.
