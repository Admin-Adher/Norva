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

---

# Android TV pairing — Panorama scindé A

Date: 2026-08-14

## Source and implementation

- Approved source: `C:\Users\AdrienHernandez\Documents\Norva repo\.superdesign\tmp\superdesign-tv-pairing-a.png`
- Production implementation capture: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-tv-pairing-a-implementation-1280x720-crop.png`
- Side-by-side comparison, approved source left and implementation right: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-tv-pairing-a-comparison-1280x720.png`
- Compact Android TV WebView capture: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-tv-pairing-a-implementation-960x540.png`
- Compact D-pad focus capture: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-tv-pairing-a-focus-960x540.png`
- Reference and primary comparison viewport: 1280 × 720 CSS px.
- Compact APK WebView viewport: 960 × 540 CSS px.
- State: pending approval with a real scannable QR, a short-lived pairing code and the APK's initial `New code` D-pad focus; no authenticated account data is displayed.
- Comparison scope: full visible pairing document including header status, split content, QR, steps and fixed action rail.

## Findings and correction history

- Replaced the centered 1160 px card-like composition with the approved full-bleed split panorama and a 5% TV safe zone.
- Matched the approved header, two-line title, grouped six-character code, three steps, 288 px QR at 720p and fixed bottom rail.
- Replaced the prototype's illustrative QR drawing with the actual vendored QR encoder output. The denser pattern is an intentional functional difference.
- The implementation comparison includes the required initial D-pad focus ring; the static approved source did not depict a focused action.
- Kept the approved hierarchy while raising both TV actions from 44 px to a minimum 48 px target.
- Reused the official Norva app mark, account/check assets, local Inter variable font and canonical Norva color tokens. The refresh glyph is the library-backed Heroicons arrow-path asset.
- Removed the one-second timer from the live region; only the bounded status pill announces asynchronous changes.
- Added explicit loading, pending, success and sanitized error presentations, a QR-unavailable fallback, reduced-motion handling and visible D-pad focus.
- Made pairing creation single-flight and restored the initial `New code` focus after its temporary disabled state.
- Preserved the existing pairing payload, TTL, secret handling, polling cadence, device-token storage, safe return path and command loop.
- Kept the same-origin manual fallback but renamed it to the honest `Pair on this TV`: it opens `/cloud.html?pair=<code>` inside the TV WebView; the QR remains the preferred phone-first route.
- Added `no-store` for `cloud-pair.html`; the APK also retains its per-launch shell cache bust.

## Runtime measurements

- 960 × 540: document and body exactly 960 × 540; QR 216 px; actions end at y=515.5.
- 1280 × 720: document and body exactly 1280 × 720; QR 288 px; actions end at y=691.
- 1920 × 1080: document and body exactly 1920 × 1080; QR 432 px; actions end at y=1030.
- No horizontal or vertical scroll was produced at any tested TV viewport.
- D-pad order passed at all sizes: `New code → Pair on this TV → New code`, including Up/Down looping.
- Loading, pending, creation failure, four-poll failure, recovery, expiry pause, QR fallback and success states remained inside the viewport with sanitized copy.

## Verification

- Focused TV pairing/navigation/player/sanitization/billing suite: 81 passed, 0 failed.
- Full repository suite: 1648 tests, 1647 passed, 0 failed, 1 skipped.
- `git diff --check`: passed.
- Existing Android TV emulator verified the native shell as full-screen at 1920 × 1080. The installed APK was not rebuilt or modified during this QA.
- Post-deployment gate remains distinct: scan and approve the production QR from a phone, then confirm the automatic APK redirect.

final result: passed
