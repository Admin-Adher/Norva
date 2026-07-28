# Norva Product Design System

## Purpose and fidelity contract

Norva is a dark, cross-device cloud media player for a user-owned compatible source. Its product promise is a single personal media universe—movies, series, and live TV—with profiles and playback progress synchronized across web, mobile, tablet, and TV.

This document describes the design language already implemented in the repository. It is the source of truth for Superdesign drafts:

- Preserve the current Norva identity.
- Use the canonical values in `.superdesign/init/theme.md`.
- Do not introduce a competitor palette, a new accent family, or a light theme.
- Treat the existing phone (`#6366f1`) and TV (`#6C63FF`) accents as native-shell drift to be reconciled deliberately, not as extra colors to scatter through web designs.
- Editorial art and user content should provide visual variety; product chrome stays restrained, dark, and blue-led.

## Product and platform context

### Surfaces

- Web and PWA: vanilla HTML/CSS/JavaScript app under `public/`.
- Desktop: Electron shell around the same web app.
- Android phone/tablet: WebView browsing shell plus native fullscreen playback, native downloads, Cast, PiP, and platform system bars.
- Android TV: WebView catalogue plus native D-pad-first fullscreen player.

### Core pages and states

1. Account entry, sign-in, recovery, and profile selection.
2. Home: editorial billboard, continue watching, personalized rails, ecosystem discovery.
3. Live TV: source/group selection, searchable guide, channel preview, native fullscreen launch on phone.
4. Movies: source/category/filter controls, rails/grid, detail hero, versions, favorite, download, play.
5. Series: source/category/filter controls, detail hero, seasons, episodes, resume, download, play.
6. Global catalogue search: movies and series, grouped results, empty and loading states.
7. Fullscreen player: launch, loading, resume, playback, seeking, tracks, versions, resize, Cast/PiP, lock, recovery, terminal error.
8. Downloads: active, queued, complete, paused, failed, storage and network policy states.
9. Settings: account/access, devices and screens, source management, catalogue refresh, playback preferences, content controls, troubleshooting.
10. Account sheet and profile switching.

### Jobs to be done

- “Let me connect a compatible source I control and understand when its catalogue is ready.”
- “Let me find something worth watching quickly across all of my sources.”
- “Let me filter large movie and series libraries without losing context or getting trapped.”
- “Let me start, resume, and finish playback on any screen with my position preserved.”
- “Let me recover from an unavailable stream or unsupported version without understanding provider internals.”
- “Let me choose audio, subtitles, quality/version, and picture fit with confidence.”
- “Let me download safely for offline viewing and understand progress, storage, and network constraints.”
- “Show me that Norva is one ecosystem across web, phone, tablet, and TV.”

The intended emotional outcome is quiet confidence: cinematic content leads; controls feel immediate; system state is always legible; recovery is calm and actionable.

## Brand character

- Cinematic, composed, contemporary.
- Dense enough for a large personal catalogue, never administrative in primary browsing.
- Premium means state clarity, polish, continuity, and restraint—not excessive gradients or decoration.
- Norva is a player, not a content service. Copy must not imply that Norva supplies media.
- Use plain, user-facing language. Provider/source mechanics belong in secondary detail, not primary error headlines.

## Foundations

### Color

Use the exact canonical web palette:

- Canvas `#080B12`.
- Raised surface `#12121a`.
- Card/input surface `#1a1a25`.
- Hover `#22222f`; active `#2a2a3a`.
- Primary accent `#3B82F6`; hover `#60A5FA`; tint `rgba(59, 130, 246, 0.2)`.
- Secondary accent `#8B5CF6`, reserved for existing secondary/accented states.
- Text `#F8FAFC`, `#94A3B8`, `#71717a`.
- Borders `#27272a`, `#3f3f46`.
- Semantic success `#10b981`, warning `#f59e0b`, error `#ef4444`.
- Glass `rgba(18, 18, 26, 0.8)` with edge `rgba(255, 255, 255, 0.1)`.

Use blue for a primary action, selected navigation, progress, or focus—not all four at full intensity in the same region. Semantic colors communicate state only. Do not recolor posters or backdrops to manufacture brand consistency.

### Typography

- Inter is the default UI face. Use loaded weights only: 400, 500, 600, 700.
- Outfit 800 is editorial display type for hero titles, rail headings, and ecosystem statements.
- The current wordmark uses Century Gothic 500 when available.
- Base UI is 14px with 1.5 line-height.
- Shared h2/h3/h4 remain 1.5rem/1.25rem/1rem at weight 600 and 1.3 line-height.
- Large artwork-backed titles use tight line-height around 0.95–0.96 and must retain enough width for localized copy.
- Metadata and support copy use Inter; avoid display typography for operational messages.
- Do not assume `--font-display` or `--color-text-bright` has a value: they are currently undefined in source. A faithful draft should use the explicit Inter/Outfit and canonical text values above rather than inventing a hidden token value.

### Spacing and density

The base rhythm is 4, 8, 16, 24, 32, 48px. Mobile compresses medium/large/extra-large spacing to 12/16/20px. Favor:

- 4–8px inside compact metadata relationships.
- 8–12px between controls in a row.
- 16px within cards and functional panels.
- 20–24px between related sections.
- 32–48px between major editorial sections on larger screens.

Touch targets are at least 44×44px where current CSS already establishes coarse-pointer rules. Primary player and irreversible controls should use the existing 48px class of affordance. Visual glyphs can remain 18–24px inside those targets.

### Shape and elevation

- 6px: compact control corners.
- 10px: default button, input, and catalogue card.
- 16px: modal and large panel.
- 9999px: chips, statuses, and circular controls.
- Detail posters use the implemented 8px radius.
- Account sheets use 18px top corners in current CSS.
- Elevation is dark and soft; reserve the blue glow for primary hover/focus emphasis.
- Blur belongs to navigation, overlay controls, and artwork-backed glass—not every card.

## Composition

### App shell

- Desktop/tablet: top glass navigation, content below.
- Phone at ≤640px: fixed bottom navigation plus compact top bar.
- Main content must always subtract `--topbar-h` and, on phone, `--bottom-nav-h`.
- Navigation chrome stays visually quieter than artwork and current title.
- Profile, search, downloads, and settings must not crowd primary Home/Live/Movies/Series wayfinding.

### Home

- One decisive artwork-backed hero with a dark directional gradient for readable copy.
- Editorial reason/kicker is secondary to title and resume/play action.
- Rails are horizontally scannable; cards use stable 2:3 poster geometry.
- Continue-watching progress remains visible without opening a card.
- Ecosystem messaging is a first-class product-value module, not a blocking modal. It must be fully scrollable and clear of fixed navigation/system bars.

### Catalogue

- Movies and Series share one filter grammar and one source/category order.
- The chosen source, categories, and secondary filters remain visible as removable chips.
- Changing “All sources” to “All categories” and the reverse must never strand focus, reset an unrelated selection, or create nested-scroll traps.
- Mobile filters are a bottom sheet or full-height panel with one scroll owner, sticky context, and actions above both gesture and three-button system navigation.
- Grid/rail cards keep a 2:3 poster ratio, stable loading dimensions, title, concise metadata, favorite/progress where relevant.
- Placeholder artwork must still preserve geometry and hierarchy.

### Detail pages

- Artwork and title establish identity; metadata, synopsis, and versions follow.
- Primary Play/Resume is the strongest action. Favorite and Download are secondary.
- Keep active filters out of the detail hero unless they are explicitly part of a back-to-results context.
- Version rows explain only user-relevant distinctions: language, quality, provider/source label, availability. Selection state is unambiguous.
- Series detail prioritizes resume/next episode, then seasons and episodes.

### Search

- Search opens as a focused, single-purpose surface.
- Results preserve poster geometry and distinguish Movies from Series without duplicating visual systems.
- Keyboard/IME never obscures the query, first results, or dismiss action.
- Accent/diacritic-insensitive matching should not visually penalize an exact-title query.
- Empty, offline, and still-loading states are explicit and calm.

### Settings and operational surfaces

- Group settings by user goal, not implementation subsystem.
- Progressive disclosure keeps advanced provider/transcode controls out of the default reading path.
- Pairing, source sync, catalogue enrichment, and downloads expose stage, progress, next step, and recovery.
- Destructive account/source actions use semantic error color and explicit confirmation.
- Dense telemetry/admin styling must not leak into consumer browsing surfaces.

## Components and states

### Buttons

- Primary: accent background, white label, medium radius; accent-hover plus existing glow on hover.
- Secondary: tertiary background, border, primary text.
- Ghost: transparent, secondary text; hover surface plus primary text.
- Danger: semantic error fill; use only for destructive actions.
- Back: existing 44px glass pill with chevron and label in catalogue details; round icon-only treatment is acceptable only in fullscreen playback.
- Every button needs default, hover (where available), pressed, focus-visible, disabled, and busy states without changing geometry.

### Navigation

- Selected state uses canonical blue and full opacity.
- Unselected state uses secondary text and lower emphasis.
- Mobile bottom tabs use a 24px icon frame and 10px label in the existing implementation; designs must test localization, text scaling, 320dp width, and seven visible destinations before accepting this density.
- TV uses a persistent, high-contrast focus treatment and spatially predictable D-pad movement. Focus, selection, and playback state are different concepts and must not collapse into one style.

### Cards and rails

- Poster cards are 2:3 and retain stable dimensions while loading.
- Touch surfaces do not depend on hover-only overlays.
- Progress, “new”, downloaded, unavailable, and favorite states are legible without obscuring key artwork.
- One rail has one axis and one scroll owner. Avoid a second horizontal scroller inside a vertically scrolling filter/modal region.

### Chips and filters

- Pills use the full-radius token.
- Active filter: accent tint/border and accent-hover text.
- Playback-status active: success treatment already present.
- Reset uses warning semantics without becoming the primary action.
- Removable chips retain a 44px interaction target even when their visual pill is smaller.

### Modals, sheets, menus

- Desktop modal: centered, max 500px, large radius, bounded by `min(90dvh, 760px)`.
- Mobile account/filter surface: bottom-docked, one internal scroll area, safe-bottom padding, sticky header/action region when content exceeds viewport.
- Backdrop click, close button, Android Back, keyboard Escape, and focus return behave consistently.
- Focus is trapped inside the active modal/sheet; background content is inert.

### Loading, empty, recovery, error

- Preserve final geometry with skeletons.
- Loading copy identifies the action (“Preparing playback”, “Updating catalogue”), not an indeterminate technical process.
- Do not show an unexplained black screen while a title loads. Retain poster/backdrop, title, compact progress, and a graceful “taking longer” state.
- Recovery replaces stale error actions; do not display a terminal headline while simultaneously saying “Reconnecting”.
- Terminal errors have one recommended action and one exit. Player controls behind an error pane are hidden and non-interactive.
- Auth, rate-limit, account-busy, circuit-open, provider-unavailable, unsupported-format, and offline are distinct states with distinct recovery.

## Motion

- Use existing 150/250/350ms tokens.
- Movement communicates relationship: sheet rises from bottom; modal fades/scales; card focus/hover lifts slightly; progress changes continuously.
- Avoid animating layout dimensions during critical playback controls.
- Press feedback is immediate and returns cleanly.
- Auto-hiding player chrome must never remove the only feedback for loading/recovery.
- Honor `prefers-reduced-motion`; no essential state may be encoded only in motion.

## Mobile system bars, viewport, and IME

- `viewport-fit=cover` and all four safe-area insets are mandatory.
- Browsing keeps Android status and navigation bars visible with the dark native shell.
- Fullscreen playback alone enters immersive mode.
- Test both Android gesture navigation and three-button navigation. A layout that clears only the gesture inset is not accepted.
- Fixed bottom navigation height is `57px + safe-bottom` at ≤640px; content, filter actions, toasts, menus, and keyboard-aware sheets must clear it.
- System navigation mode changes and rotation must restore the current route, profile, query/filter state, and scroll position where practical.
- When the IME is visible, the focused control, first relevant result, close action, and primary filter action remain visible.
- Do not stack document scroll, sheet scroll, and an inner multi-select scroll. Select one primary vertical scroll owner.
- Landscape phone remains a phone layout even when the WebView reports a tablet-like width.

## Premium streaming interaction constraints

### Launch and resume

- Player launch immediately shows artwork/title and a meaningful loading state.
- Resume choice is made before controls become ambiguous; chosen position is reflected in timeline and copy.
- A long startup escalates from normal preparation to “taking longer” without flashing terminal errors.

### Controls

- Central play/pause, ±10 seconds, timeline, time, back, audio/subtitles, version/quality, resize, lock, Cast/PiP are grouped by frequency.
- Previous/next controls appear only when the content model supports them.
- Compact layouts may move secondary controls into “More”, but every gesture-only function also has a discoverable control.
- Locked mode blocks accidental seeks/taps yet makes unlock obvious; Android Back must not silently exit when the user reasonably expects unlock.
- Seek feedback is immediate, and the final frame/state confirms completion.

### Tracks, versions, and episodes

- Audio and subtitles share a coherent selection surface, with selected/unavailable states and neutral labels where language evidence is absent.
- Version changes preserve position and expose recovery progress.
- Episode progression surfaces “Up next” without hijacking the current title; cancel/continue is always possible.
- Burned-in subtitles are explicitly described as always visible.

### Recovery and continuity

- Direct stream, gateway/recovery, refreshed URL, and alternate version are stages behind one user-facing recovery narrative.
- Only the latest recovery attempt may update UI.
- Retry is idempotent and cannot leave stale buttons or overlapping controls.
- Offline download playback must not route through a network-only recovery path.
- Cast/PiP handoff confirms success before abandoning a working local session.
- Returning from PiP, rotation, app background, or system navigation restores control-lock, position, selected tracks, and active title coherently.

### Accessibility and remote/touch parity

- Interactive targets are ≥44×44px on touch; principal playback actions use the existing 48px class.
- Focus-visible has a high-contrast canonical-blue/white treatment and does not rely on color alone.
- Screen readers receive actionable labels, selected/unavailable state, time progress, loading, reconnecting, and errors.
- Every TV flow is operable with D-pad directions, OK, and Back; every mobile flow is operable without hover or hidden gestures.
- Dynamic updates use appropriate status/live-region semantics without repeatedly interrupting playback.

## Fidelity risks already present in source

These are constraints for design review, not permission to invent replacements:

1. `--font-display` is used but not defined.
2. `--color-text-bright` is used but not defined.
3. Web `#3B82F6`, phone `#6366f1`, and TV `#6C63FF` currently diverge.
4. App/PWA native shell background is `#0A0A0F` while the canonical web canvas is `#080B12`.
5. Several older/local component blocks use hardcoded blue-violet and neutral values; do not promote those into new global tokens.
6. Century Gothic is requested for the wordmark but is not web-loaded.
7. Mobile bottom navigation can contain seven destinations, which is fragile at small width and increased font scale.

## Draft acceptance checklist

A Norva draft is ready for review only when:

- It uses the exact current palette and type families.
- Content artwork leads and chrome remains restrained.
- Loading, empty, busy, offline, recovery, and terminal-error states are designed.
- Touch, keyboard, screen-reader, and TV D-pad states are represented where relevant.
- Phone layouts clear status bar, fixed bottom nav, gesture inset, three-button bar, and IME.
- Filters have one scroll owner and reversible source/category movement.
- Player launch never collapses to unexplained black.
- Selection, focus, progress, disabled, unavailable, and error are visually distinct.
- Long/localized labels and 320dp width do not clip primary actions.
- The design does not imply Norva includes or sells media content.
