# Norva design-system rules

These instructions apply to the whole repository. They define how Figma-driven UI work must be translated into Norva without replacing the product's existing architecture or visual language.

## Product architecture

- The primary application UI is a vanilla JavaScript SPA in `public/app.html`, `public/js/`, and `public/css/main.css`.
- Mobile and TV shells are native Android clients under `clients/android-phone/` and `clients/android-tv/`. The phone catalogue is rendered in a WebView; VOD playback and downloads use native Java views.
- Reuse existing page modules and shared components before adding a new abstraction. Shared WebView components live in `public/js/components/`; page modules live in `public/js/pages/`.
- Keep platform-specific interaction models distinct: touch and TalkBack on phone/tablet, D-pad focus on TV, and keyboard/pointer on web.

## Visual tokens and assets

- IMPORTANT: Treat the `:root` variables near the start of `public/css/main.css` as the canonical WebView tokens. Extend that token set when a missing semantic value is genuinely required; do not introduce isolated hex values in page code.
- Canonical dark surfaces are `--color-bg-primary`, `--color-bg-secondary`, and `--color-bg-tertiary`; canonical actions and text use the existing `--color-accent` and `--color-text-*` variables.
- Native Android colors must map to the same semantic product tokens. Avoid introducing a second indigo/blue palette in Java or resources.
- Use Inter for application UI and Outfit only where the existing product intentionally uses a display face.
- Use the existing 4/8/16/24/32/48 spacing rhythm and 6/10/16 radius scale.
- Reuse real Norva assets from `public/img/`, `public/img/icons/`, and the Android resource folders. Do not replace the Norva mark or navigation icons with placeholders, emoji, or a new icon library.

## Interaction and accessibility

- Every mobile layout must work with gesture navigation and the Android three-button navigation bar, including visible IME states and safe-area insets.
- Validate at default font size and at least Android font scale 1.3. Bottom navigation labels must not collide, truncate ambiguously, or reduce tap targets.
- Interactive touch targets must be at least 48 dp where Android-native, and at least 44 CSS px in the WebView unless a larger existing Norva pattern applies.
- Provide visible pressed, selected, loading, disabled, retry, offline, and terminal-error states. Never expose raw provider responses, object dumps, credentials, account identifiers, or internal error JSON in user-facing UI.
- Dialogs and bottom sheets must move focus on open, contain focus/TalkBack traversal, mark the background inert, close with Android Back before navigating, and restore focus to their trigger.
- Async status changes must use appropriate live-region or native accessibility announcements.
- Do not claim WCAG conformance without a dedicated conformance review; still meet WCAG 2.2 AA contrast and interaction expectations for changed UI.

## Figma MCP integration

For every Figma-driven implementation:

1. Fetch `get_design_context` for the exact target node.
2. If the response is too large, use `get_metadata` to locate smaller target nodes, then fetch those nodes.
3. Fetch a `get_screenshot` reference for each implemented state.
4. Download and reuse supplied assets before changing code.
5. Translate generated representation into this repository's vanilla JavaScript, CSS-token, and native Java conventions.
6. Reuse existing components and assets rather than duplicating them.
7. Compare the same viewport and state against Figma after implementation, then test behavior on the relevant emulator.

Figma or Superdesign drafts are design specifications, not authorization to modify production behavior. During an audit-only task, keep production code unchanged.

## Verification

- WebView UI changes require the relevant contract/unit tests plus runtime inspection in the Android phone or TV emulator.
- Native player/download changes require focused JVM tests and emulator replay of loading, success, retry, terminal error, Back, background/return, and accessibility states.
- For mobile filters, explicitly test `All Sources -> All Categories` and the inverse with both Android navigation modes and the keyboard visible.
- Record performance evidence separately for the native process and the WebView renderer; `gfxinfo` for the Activity alone is not sufficient to certify catalogue or video rendering performance.
