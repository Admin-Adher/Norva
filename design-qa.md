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
---

# Subscription selector — Plan-first

Date: 2026-08-14

## Approved source and implementation

- Approved desktop source: `https://p.superdesign.dev/draft/78d213d8-b42e-4d1f-a4f5-ef61d9b11267`
- Approved mobile source: `https://p.superdesign.dev/draft/c04b1183-a727-4fe7-b83b-a7223cf29ea1`
- Desktop reference, 1440 × 900: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-plans-plan-first-desktop-1440x900.png`
- Mobile reference, 390 × 844: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-plans-plan-first-mobile-390x844.png`
- Compact mobile reference, 375 × 667: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-plans-plan-first-mobile-375x667.png`
- Landscape reference, 844 × 390: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-plans-plan-first-mobile-landscape-844x390.png`
- Desktop implementation: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-plan-first-implementation-desktop-1440x900.png`
- Mobile implementation: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-plan-first-implementation-mobile-390x844.png`
- Compact mobile implementation: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-plan-first-implementation-mobile-375x667.png`
- Landscape implementation: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-plan-first-implementation-mobile-landscape-844x390.png`
- 130% mobile text-scale equivalent: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-plan-first-implementation-mobile-font-scale-1.3.png`
- Combined desktop comparison: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-plan-first-qa-comparison-desktop.png`
- Combined mobile comparison: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-plan-first-qa-comparison-mobile.png`
- Combined landscape comparison: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-plan-first-qa-comparison-landscape.png`
- Comparison document: `C:\Users\AdrienHernandez\AppData\Local\Temp\norva-plan-first-qa-comparison.html`
- Final multi-screen asset: `public/assets/landing/norva-every-screen-premium.webp` (`1586 × 992`, 36,680 bytes).

## Fidelity and responsive checks

- Desktop reproduces the centered plan-first hierarchy, annual/monthly selector, two equal plan choices, one shared-benefit band and one explicit continuation action.
- Portrait phone keeps the short title, equal billing options, full-card radio choices and a safe-area-aware fixed action rail.
- Compact phone reduces non-decision copy while preserving both plan choices, their prices and a 50 px continuation target.
- Landscape uses the approved split composition, wraps `Choose your plan.` on two lines, keeps both plans visible together and fixes the action inside the lower safe zone.
- No horizontal overflow was measured at 1440 × 900, 390 × 844, 375 × 667, 844 × 390 or the 130% text-scale equivalent.
- Existing Norva assets, Outfit/Inter typography, spacing rhythm, radii and semantic commerce tokens are reused; no placeholder icon set was introduced.

## Interaction, accessibility and payment invariants

- The whole card is a native radio label inside an explicit radiogroup; pointer selection and Left/Right arrow selection were exercised.
- Selecting Family updates the summary and shared CTA to `Continue with Norva Family`; ArrowLeft returns selection and focus to Norva.
- Monthly and Annual controls update the displayed period and keep accurate `aria-pressed` state.
- The visible continuation control delegates to the existing authenticated plan button. The new presentation adapter contains no price constants and does not become payment authority.
- Loading, disabled, active and current-plan button states continue to come from the existing commerce flow; provider messages remain sanitized.
- Touch targets are at least 44 CSS px, focus remains visible, reduced motion and forced-colors adaptations are present, and the fixed mobile rail includes the bottom safe-area inset.

## Architecture and verification

- `public/js/plan-selection-ui.js` is a presentation adapter; entitlement, authenticated catalogue pricing, promotions, analytics and checkout routing remain owned by the existing subscription orchestrator.
- Targeted subscription/commerce/mobile/accessibility/sanitization suite: 29 passed, 0 failed.
- Final visual/commerce/ecosystem regression subset: 16 passed, 0 failed.
- Full repository suite: 1653 tests, 1652 passed, 0 failed, 1 skipped.
- `node --check public/js/plan-selection-ui.js`: passed.
- Android WebView routing contract for canonical `/subscribe`: passed.
- The existing Android emulator could not be opened on the local preview because policy blocked the external `adb am start` URL command. No APK was installed, rebuilt or modified; browser QA at the exact phone viewports and 130% equivalent is complete, while installed-APK runtime replay remains a separate gate.

## Correction history

- Moved product proof below the plan decision so the plans and continuation action appear first.
- Preserved the real pricing and checkout rails behind a single shared CTA instead of duplicating purchase logic.
- Matched the approved compact and landscape compositions, including the two-line landscape title and fixed safe action rail.
- Replaced the rejected nested device illustration with a premium full-frame TV, phone and tablet render, optimized from 1,358,471-byte PNG to a 36,680-byte WebP.
- Removed the inherited 190 px height cap. The image and slot now share the intended 8:5 ratio: 417 × 260.625 desktop, 358 × 223.75 at 390 px, 342 × 213.75 compact, and 360 × 225 landscape; no device crop remains.
- Re-ran same-viewport reference/implementation comparisons after the responsive corrections.

final result: passed

---

# Centre de notifications Admin

Date: 2026-08-29

## Source et implémentation

- Source visuelle : `C:\Users\AdrienHernandez\.codex\generated_images\01a04ac7-516d-7a60-9bba-ebd1fbc27e9f\exec-93f7d78c-649e-40cc-82d2-ee145892ab8a.png`
- Implémentation : `C:\Users\AdrienHernandez\Documents\Norva-notifications-center-20260829\.codex-artifacts\notification-center-automations-reference-viewport-corrected.png`
- Comparaison commune : `C:\Users\AdrienHernandez\Documents\Norva-notifications-center-20260829\.codex-artifacts\notification-center-comparison-same-viewport-corrected.png`
- Viewport de comparaison : référence 1513 × 1038 px ; implémentation 1512 × 1037 CSS px, densité navigateur 0,8. Le raster du navigateur a été recadré puis remis à l’échelle sur le viewport CSS pour neutraliser le facteur de capture Windows.
- Contrôle responsive : 487 × 1055 CSS px (cible mobile demandée 390 × 844), sans débordement horizontal du document ; contrôles interactifs d’au moins 44 CSS px.

## États et interactions contrôlés

- Onglets Composer, Programmées, Automatiques et Historique ; navigation clavier par flèches.
- Composition immédiate et programmée, date future, audience et revue explicite avant envoi.
- Édition et duplication d’une programmation ; confirmation d’annulation intégrée et focus placé sur la revue.
- Lecture des règles système protégées, extension des événements sûrs, création et édition des automations personnalisées.
- Activation, duplication et archivage d’une automation personnalisée.
- Repli responsive en une colonne, onglets défilables et formulaire Composer mobile.
- Aucun message d’erreur de console sur l’URL locale finale.

## Comparaison et décisions

- La hiérarchie de la référence est conservée : navigation Marketing, sections opérationnelles, inventaire des règles à gauche et détail/action à droite.
- L’implémentation sépare volontairement les règles transactionnelles protégées des automations marketing modifiables. Cette différence évite de présenter comme éditables des tunnels système dont le moteur n’expose pas de contrat d’écriture.
- Les KPI remplacent le bandeau de prochaine programmation et gardent l’échéance visible dans le même écran. La modification reste disponible dans Programmées.
- Le détail en lecture puis le bouton Modifier réduisent les changements accidentels ; le formulaire complet reste disponible en une action.

## Historique des corrections

- P2 corrigé : champs de programmation étendus sur les deux colonnes et `fieldset` natif neutralisé.
- P2 corrigé : états pressés des filtres, focus visible et cibles tactiles normalisés.
- P2 corrigé : aperçu de date invalide protégé et boutons asynchrones stabilisés avant `await`.
- P1/P0 : aucun défaut restant dans le parcours principal contrôlé.

final result: passed
