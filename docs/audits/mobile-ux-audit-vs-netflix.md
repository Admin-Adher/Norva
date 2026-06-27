# Norva Android Phone — UX Audit (vs Netflix Mobile)

*14 UX dimensions, each audited and adversarially verified against the live source. Scope: Android phone only — Android TV is a separate later pass.*

## Executive summary

The Norva phone app is a genuinely capable streaming client with strong bones — a native ExoPlayer with smart gateway/codec recovery, an encrypted offline library, a self-healing HLS live pipeline, and a responsive web shell that already ships several Netflix-grade patterns (stale-while-revalidate catalog cache on Movies/Series, a 60s warm-DOM home, language-aware rail ranking). But against the Netflix mobile benchmark it reads as *almost-finished* rather than *polished*, and the felt gap clusters into four themes: **(1) perceived speed** — no skeletons anywhere, a spinner-on-empty home with no persistent cache, render-blocking scripts plus an unused render-blocking CDN tag, and hard-cut page transitions; **(2) language inconsistency** — an English shell with stray French strings on Home, fiches, the live guide, and an *entirely French* native player error overlay, which is the single most trust-eroding defect; **(3) mobile player & live ergonomics** — no double-tap-seek, forced landscape, no next-episode autoplay, no one-hand channel zap, and a dead-end native error screen; **(4) discovery depth** — a flat, poster-only, single-static-hero home with no Top 10, no "More like this" on the fiche, and a non-landscape Continue Watching you can't edit. There is also a real CSS bug: two undefined variables (`--primary-blue`, `--text-secondary`) leave the **active bottom tab rendered grey instead of brand blue** and break several focus rings. The single highest-leverage fix is **language normalization + the CSS-variable alias** — a few hours of string and token work that immediately lifts perceived quality across every screen and the most visible failure surface (the player). The closely-following structural bet is a **perceived-speed pass** (persistent home cache + skeletons + deferred scripts), which is high-impact and reuses code the app already ships. Two bright spots temper the picture: **profiles are already Netflix-grade and Play billing is compliant and fully wired**, so the account foundation is genuinely strong. The clearest *additive* opportunities beyond the four themes are **making search a real front door** — today it is a hard-to-reach top-bar icon that cannot even find live channels and opens to a dead empty state — and **giving Settings a phone-shaped IA with parental controls**, since it is currently the desktop 6-tab IPTV surface with no maturity rating, Kids profile, or PIN.

## Scorecard

| Dimension | Rating (vs Netflix) | Verdict |
|---|---|---|
| Onboarding & first-run | 2 / 5 | BYO-IPTV credentials wall is inherent, but a black-flash cold start, no load watchdog, and mixed-language copy make it feel unfinished. |
| Navigation & information architecture | 3 / 5 | Solid bottom-nav model, but Search isn't a tab, the bar reflows on state change, page switches are hard cuts, and re-tap/back don't follow phone conventions. |
| Search | 3 / 5 | A genuinely good engine (debounce, request-race guard, poster thumbnails, direct-to-fiche), undermined by being a top-bar icon not a tab, omitting Live TV, and opening to a dead empty state. |
| Home & content discovery | 2 / 5 | Functional rails, but flat poster-only grid, one static cropped hero, no Top 10, no editable landscape Continue Watching, no "See all." |
| Browse catalog (Movies & Series) | 3 / 5 | Good cache + infinite scroll, undermined by a 2-up low-density grid, no skeletons, full-wipe on every refine, and dead-end empty states. |
| Title detail / fiche | 2 / 5 | Cramped desktop two-column layout, clamped synopsis, no "More like this," no series version switch, mixed FR/EN metadata. |
| Player UX (native ExoPlayer) | 2 / 5 | Reliable core, but missing every expected mobile gesture (double-tap, brightness/volume), forced landscape, no PiP/MediaSession/autoplay, French errors. |
| Live TV UX | 2 / 5 | Smart self-healing stream, but no one-hand zap, black-gap switches, two-tap-to-watch, empty now/next, hidden live badge, French leaks. |
| Downloads / offline | 3 / 5 | Strong encrypted library with offline auto-routing, but downloads never resume, no size estimate, no storage guard, no smart downloads. |
| Settings, profiles & account/billing | 3 / 5 | Profiles are Netflix-grade and Play billing is compliant & well-wired, but Settings is the desktop 6-tab IPTV surface, with no parental controls/PIN, no Restore on the manage-plan screen, and a thin 3-row account sheet. |
| Visual design, motion & consistency | 2 / 5 | No motion, no skeletons, a broken active-tab color, mixed icon styles, 57 ad-hoc font sizes, default tap-flash. |
| Performance & perceived speed | 2 / 5 | No home cache, serialized cold fetch, render-blocking JS + unused CDN, oversized hero art, no SW/precache. |
| Accessibility & internationalization | 2 / 5 | No focus indicators, no caption styling, no i18n, no RTL, low-contrast hint text, unannounced loading/errors. |
| Reliability & error/empty states | 2 / 5 | Good native gateway fallback, but dead-end player error, no offline awareness, retry-without-connectivity-check, bare retry-less empty states. |

## Prioritized roadmap

### P0 — Launch blockers
*None.* No finding is a hard functional trap; the app always reaches an actionable screen. The items below are the difference between "works" and "feels like Netflix."

### P1 — High impact, do first (ordered by impact-per-effort)

| Title | Dimension(s) | Effort | The fix in one line |
|---|---|---|---|
| EN/FR language inconsistency across shell, fiche, live guide & native player | Visual consistency + Onboarding + Player + Live + i18n *(merged: 5 findings — Home/fiche/live/player French leaks + "no i18n layer")* | S→M | Normalize all visible strings to English (incl. native player error overlay → strings.xml) so no screen mixes two languages. |
| Undefined CSS vars break active-tab color & focus rings | Visual consistency | S | Alias `--primary-blue`→`--color-accent` and `--text-secondary`→`--color-text-secondary` in `:root`. |
| No visible focus indicator on phone controls | Accessibility | S | Add one global `:focus-visible{outline:2px solid var(--color-accent)}` and remove the bare `outline:none` on inputs. |
| Double-tap-to-seek (±10s) missing | Player | S | Overlay a `GestureDetector` on the PlayerView root, split at 50% width, `seekTo(±10_000)` + bubble. |
| Native VOD player error is a dead-end (French, no buttons) | Player + Reliability *(merged)* | S | Replace the bare TextView with an English headline + **Retry** (re-`setMediaItem`+`prepare`) and **Back** buttons. |
| Loading spinner has no watchdog — hung load strands the user | Onboarding + Reliability | S | Arm a 12–15s `postDelayed` in `connect()`, cancel in `onPageFinished`; on fire show the existing error panel. |
| Search isn't a bottom-tab destination | Navigation + Search | S | Mirror the top-right search icon as a bottom-nav entry calling the existing `openSearch()`. |
| Home has no persistent cache (spinner wall on every cold start) | Performance + Home | M | Reuse the existing `NorvaCatalogCache` to paint last-seen rails/history synchronously, then revalidate. |
| No skeletons anywhere | Performance + Browse + Visual motion + Reliability *(merged: 4 findings)* | M | One `.skeleton` shimmer class; render N placeholder cards in rails/grids instead of the spinner. |
| Page navigation has zero motion (hard `display:block` cut) | Visual motion + Navigation *(merged)* | M | ~140–180ms opacity/translateY enter on `.page.active` via an inner wrapper, gated by reduced-motion. |
| Render-blocking scripts + unused render-blocking hls.js CDN | Performance | M | Add `defer` to the 29 app scripts; self-host + lazy-load hls.js (never on APK). |
| Home cold fetch serialized into two network phases | Performance | S | Fire history + rails in parallel with health/settings; route rails through the memoized `getHomeRails`. |
| No "More like this" rail — fiche is a discovery dead-end | Title detail | M | Add a genre-matched related rail at the bottom of both fiches via existing `GenreRails.appendCards`. |
| Mobile fiche keeps a desktop 2-column layout | Title detail | S | In the ≤720px query set `grid-template-columns:1fr` so poster stacks above a full-width Play + synopsis. |
| Series fiche has no version selector | Title detail | M | When `currentSeriesGroup.items.length>1`, render a switcher mirroring `renderMovieVersions`. |
| No next-episode autoplay on native path | Player | M | Thread the next episode as Intent extras; show a native "Up Next" overlay on `STATE_ENDED`. |
| Offline downloads always restart from 0 | Downloads | M | Add `positionSeconds` to `DownloadStore.Item`; pass it as `EXTRA_RESUME_SECONDS` (cloud seek path already works). |
| No one-hand channel zap | Live | M | Add persistent on-player up/next + down/prev buttons wired to existing `selectNextChannel/selectPrevChannel`. |
| Black screen during channel switch | Live | S | Paint the target channel's logo+name splash over the black video until `markPlaybackUsable()` fires. |
| EPG now/next frequently empty | Live | M | Prioritize short-EPG for on-screen rows first; show a "loading guide…" shimmer instead of hard "No info." |
| Hero is one static, often-cropped portrait poster | Home | M | Only promote items with a real landscape backdrop; rotate 3–5 candidates with crossfade. |
| No Top 10 / numbered ranked rail | Home | M | Special-case a `top-10` rail id and render large rank numerals over the poster using the existing `itemIndex`. |
| Continue Watching is portrait, unlabelled-time, non-removable | Home | M | Landscape 16:9 card variant + long-press "Remove" (wire existing `history.remove`) + "X min left." |
| First-run lands on credentials form, not content | Onboarding | M | Set the BYO expectation up front + a warmer, guided, thumb-reachable setup gate. |
| Native player error/diagnostic overlays in French | Player | S | *(Covered by the language-normalization merge above.)* |
| Global search can't find Live TV channels (movies + series only) | Search | M | Add a 3rd parallel query via `API.proxy.xtream.liveStreams(sourceId,null,{q})` + a "Live TV" results section opening into the native player. |
| Search opens to a dead empty state (no recent / Top searches) | Search | M | Persist the last ~8 queries in localStorage as tappable chips + a "Top searches" poster grid reusing a home rail. |
| No in-app "Restore purchases" on the subscription *management* screen | Settings/billing | S | Add a Restore button to `subscription.html` calling the existing `NorvaBilling.restore` bridge (today it lives only on `subscribe.html`). |
| Phone Settings is the desktop 6-tab IPTV surface, not a mobile IA | Settings | L | Phone-only layout: lead with Account / Playback / Downloads; collapse TV-service, transcoding & sources behind one "Advanced" entry. |
| No parental controls / maturity rating / profile PIN | Settings/profiles | L | Add a "Kids profile" flag + optional 4-digit PIN gating profile switch, surfaced as a Parental-controls row reusing the `hiddenGenres` store. |

### P2 — Strong polish (grouped)

| Title | Dimension(s) | Effort | The fix in one line |
|---|---|---|---|
| Player hard-locked to landscape | Player | S | Change `screenOrientation` to `sensorFullUser`; portrait shows letterboxed video + media3 controls. |
| Phone grid is low-density 2-up | Browse | S | CSS grid `repeat(3,1fr)` at ≤640px, drop the 160px cap and space-around. |
| Search/sort do a full grid wipe | Browse | S | Keep the existing grid visible/dimmed on reset-path refetch; clear only when new page-1 arrives. |
| Empty/error grid states have no recovery | Browse + Reliability *(merged)* | S→M | Shared `renderErrorState(onRetry)` + inline "Clear filters" when `hasActiveFilters()`. |
| On-poster heart/version badge invite mis-taps | Browse | S | Drop or 44px-hit-slop the heart on phone; route poster-body tap to open the title. |
| Bottom bar reflows / can reach 6 tabs | Navigation | M | Reserve fixed slots so positions never re-divide on catalog-unlock or first/last download. |
| Re-tap active tab is a no-op | Navigation | S | Detect `dataset.page === currentPage` and scroll the page container to top + close any fiche. |
| Back replays whole tab history | Navigation | M | Tab backstack that collapses repeats and treats Home as the floor (~2 presses max). |
| Synopsis clamps to 4 lines, no "more" | Title detail | S | Tap-to-toggle an `.expanded` class that removes the line-clamp. |
| All episodes rendered into DOM at once | Title detail | M | Render only the selected season; rebuild on `<select>` change. |
| Episode description hidden on phone; bare `<select>` season picker | Title detail | S | Re-enable a 2-line clamped `.episode-description` in the ≤720px query. |
| Two-tap "preview then Watch" on live rows | Live | S | On touch, single tap on a guide row plays directly; keep preview-on-focus for D-pad only. |
| Live badge / channel name hide with the auto-hiding overlay | Live | S | Keep the LIVE / "Behind by X" badge persistently visible, 44px hit target on the actionable state. |
| Mixed-language first-run UI | Onboarding | S | *(Covered by language-normalization merge.)* |
| Bottom-nav tabs reflow on first run | Onboarding | M | Render disabled/greyed Live/Movies/Series tabs pre-catalog instead of removing them. |
| Brightness/volume vertical swipe gestures missing | Player | M | In the same gesture layer: left half → `screenBrightness`, right half → `AudioManager`, with a HUD. |
| No Picture-in-Picture | Player | M | `supportsPictureInPicture=true`, enter on `onUserLeaveHint`, skip pause while in PiP. |
| No download size estimate / low-storage guard | Downloads *(merged: estimate + storage guard)* | S→M | Estimate movie size from runtime × bitrate; check `getUsableSpace()` once Content-Length is known. |
| No Smart Downloads (auto-next / auto-delete) | Downloads | L | On episode finish, auto-queue the next episode (you already store season/episodeNum). |
| Static rail ordering, no personalization priority | Home | S | Client-side row sort: because-you-watched > top-10 > genre > recently-added. |
| Artwork is poster-only across the whole home | Home | M | One landscape "spotlight"/Continue-Watching variant fed by `backdropFromItem` w/ poster fallback. |
| Rail headers non-interactive (no "See all") | Home | S | Reuse the `GenreRails` "See all ›" button + `onSeeAll` to jump into the pre-filtered grid. |
| Mixed icon styles in tab bar | Visual consistency | M | One currentColor icon family so the active tab can fill to brand blue. |
| No tap-highlight / pressed state | Visual consistency | S | Global `-webkit-tap-highlight-color:transparent` + a `.btn:active` scale/opacity dip. |
| No systematic type scale (57 sizes) | Visual consistency | L | Collapse onto ~7 `--fs-*` tokens. |
| Favorite/icon targets ~28px | Visual consistency / a11y | S | 44×44 hit area on icon buttons under `(pointer:coarse)`. |
| Retry reloads without connectivity check | Reliability | S | Call `hasNetwork()` first; register a `NetworkCallback` to auto-retry when the network returns. |
| Live playback failure has no retry/next | Reliability | S | Add Retry + "Next channel" to live `showError`; reuse `getFriendlyPlaybackError`. |
| Catalog grid uses brittle 100vh math | Browse | S | Set scroller to `height:100%`/`flex:1;min-height:0` or `100dvh`; drop the 140px magic number. |
| No grid EPG reachable on phone | Live | M | Wire the orphaned `EpgGuide`/`GuidePage` to a "Guide" affordance, or a per-channel "tonight" list. |
| No second cold-launch caching / service worker | Performance | M | Immutable caching on versioned assets + a minimal SW app-shell precache. |
| Oversized hero art (w780/w1280) on phone | Performance | S | Branch TMDB backdrop size by viewport (w500 phone). |
| No RTL readiness despite Arabic support | i18n | M | `dir="auto"` on provider strings now; logical properties + `documentElement.dir` later. |
| Fixed 14px root, narrow reduced-motion query | i18n / a11y | S | Relative root base + blanket reduced-motion rule. |
| Muted hint text fails AA contrast | a11y | S | Lighten `--color-text-muted` to ~`#949ba8`; raise phone `.setting-hint` to ~12px. |
| Search results capped at 24/type, no "see all" | Search | S | A "see all" that routes the query into the Movies/Series grid, or paginate the overlay. |
| Search input lacks mobile keyboard ergonomics | Search | S | Add `inputmode="search" enterkeyhint="search"`; make Enter jump to the first result. |
| Download settings (Wi-Fi-only / quality) buried in native Downloads, not in Settings | Settings/Downloads | M | Surface a "Downloads" group in phone Settings (mirror the Wi-Fi-only toggle via the bridge) + a download-quality picker. |
| No app version / "About" / Help & support entry anywhere | Settings | S | Add an About row (app version via the bridge) + a Help/Support link to the Account tab. |
| Audio/subtitle defaults framed as "recommendations"; subtitle copy misleading | Settings | S | Move "Preferred audio" into a Playback group as "Default audio language"; relabel the subtitle control given burned-in subs. |
| Phone account sheet is a thin 3-row menu, not a "My Norva" hub | Settings/account | M | Enrich `buildAccountSheet` with plan status + Manage-subscription + Downloads rows. |

### P3 — Backlog / opportunistic

| Title | Dimension(s) | Effort | The fix in one line |
|---|---|---|---|
| Unbranded black cold-start flash | Onboarding | S | AndroidX SplashScreen / `windowBackground` layer-list; tint the in-app spinner brand blue. |
| Offline first-run dead-ends with generic error | Onboarding | S | Check `hasNetwork()` before first load; show first-run-tailored offline copy. |
| Email-confirmation sign-up strands the user | Onboarding | M | Pending state + "Resend" + pre-filled email + poll-to-auto-advance. |
| Only `norva://pair` is deep-linkable | Navigation | M | Add an https App Link parsing page + title id into `openByItem`. |
| "Live TV" label too long for 10px tab | Navigation | S | Shorten bottom label to "Live" (keep "Live TV" on desktop). |
| No cast / director / maturity rating on fiche | Title detail | M | Add a maturity badge (prioritized) + cast line when TMDB credits exist. |
| Asymmetric 5/15s seek defaults | Player | S | `.setSeekBackIncrementMs(10_000).setSeekForwardIncrementMs(10_000)`. |
| No scrub-preview thumbnails | Player | L | Aspirational for IPTV — document as a known limitation. |
| No MediaSession (no lock-screen controls) | Player | M | Add media3-session bound to the player; pairs with PiP. |
| In-fiche download has no % ring | Downloads | S | Read the per-id `progress` already in `getDownloads()`; render a conic-gradient ring. |
| Offline entry wording is connectivity-agnostic | Downloads | S | Reword error title to "You're offline" and promote Downloads above Retry. |
| No expiry/license model | Downloads | S | Deliberate non-gap — keep permanent downloads; soften dead-file copy only. |
| 60s TTL reflow on warm revisit | Home | S | Per-rail skeleton + detached-fragment swap to smooth the post-TTL reflow. |
| Reduced-motion honors only one animation | Visual motion / a11y | S | Broaden the reduced-motion block to neutralize non-essential motion. |
| Loading/error states not announced to SR | a11y | S | `role="status" aria-live="polite"` on loaders; `role="alert"` on player error. |
| Icon-only player controls lack accessible names | a11y | S | `aria-label` on each control; `aria-hidden` on decorative SVGs. |
| No voice search on phone | Search | M | Mic button using the WebView `webkitSpeechRecognition` to dictate into the search input. |
| Native sign-out bounces to the web account page (two `signOut()` impls) | Settings | S | Consolidate to one in-WebView sign-out that resets to the native login without a full web nav. |

## Deep dives (top 10)

### 1. Language normalization (the highest-leverage fix)
**Netflix:** rigorously single-locale per session — every label, metadata chip, and error message is in one language; a mixed-language screen instantly reads as broken.
**Norva today:** the shell is English but French is sprinkled throughout. Home renders `<h2>Chaînes favorites</h2>` next to "Loading favorites..." (`HomePage.js:92,94`); the series fiche builds `${n} saison(s)` / `${n} épisodes` and a `Note 8.4` chip (`SeriesPage.js:1682-1683`, `MoviesPage.js:1659`); the live guide leaks `variante(s) fonctionnelle(s)` / `HS` tooltips (`LiveGuideFusion.js:476-484`) and the live player markup carries `En direct` / `Qualité` (`app.html:289,295,316,322`). Worst of all, the **native player error overlay is entirely French** — the 35s watchdog `Aucune donnée reçue (timeout 35s)…Hôte :` (`PlayerActivity.java:84-86`) and `diagnose()` `Lecture impossible / Code : / Hôte :` (`PlayerActivity.java:362-378`) — shown on a red overlay at the most trust-sensitive moment.
**Sketch:** (a) string pass over the web strays → English; (b) move all `PlayerActivity` user-facing strings into `res/values/strings.xml` (+ `values-fr` default) so the native player matches the shell. This is a few hours and lifts perceived quality on *every* surface plus the player failure path. Pairs with the "native error is a dead-end" fix below.

### 2. CSS-variable bug: active tab is grey, not brand blue
**Netflix:** one brand accent drives every active/selected state; the active tab is unmistakable.
**Norva today:** `:root` defines `--color-accent:#3B82F6` (`main.css:18`) and `--color-text-secondary` (`main.css:28`) but **never** `--primary-blue` or `--text-secondary`. The phone active-tab rule is `color: var(--primary-blue)` with no fallback (`main.css:9956`) — an invalid value, so the property inherits the grey label color (~`#9aa6bd`, `main.css:9936`). The active tab is therefore barely distinguishable from inactive. Focus rings at `main.css:231,296` are equally invalid; the search/input rings fall back to a non-matching violet `#5b7cfa` (`main.css:10030,10271`).
**Sketch:** add two `:root` aliases — `--primary-blue: var(--color-accent); --text-secondary: var(--color-text-secondary);` — and the active tab + focus rings snap to the correct brand blue everywhere. One-line-ish, high visibility.

### 3. Perceived speed: persistent home cache + skeletons + deferred scripts
**Netflix:** the phone home paints a laid-out skeleton in <1s, relaunch shows yesterday's rows instantly (stale) while refreshing, and JS is deferred/code-split.
**Norva today:** Home — the default landing — is the *one* catalog surface with no persistent cache: Movies/Series read `NorvaCatalogCache` (`MoviesPage.js:818`, `SeriesPage.js:797`) but Home has only a 60s in-memory TTL reset every process (`HomePage.js:13`), so every cold launch shows the "Loading recommendations..." spinner wall (`HomePage.js:83-86`). There are **zero** skeleton rules in `public/` (the only loader is a 20px spin ring, `main.css:4070-4078`). And `app.html` ships 29 parse-blocking scripts with no `defer` plus a render-blocking jsdelivr hls.js tag (`app.html:75`) that the **phone APK never uses** (inline player is `display:none` on APK, `main.css:10039`; VOD goes native).
**Sketch:** (a) on `HomePage.show()`, synchronously paint cached history+rails from `NorvaCatalogCache` then revalidate — same SWR pattern `loadCloudMovies` already runs; (b) add a `.skeleton` shimmer class and render placeholder cards in `scrollSection`/grids instead of the spinner; (c) add `defer` to the 29 scripts (they already boot on `DOMContentLoaded`) and self-host/lazy-load hls.js. Three independent wins that compound; the cache + skeletons alone change the felt speed of the most-visited screen.

### 4. Native player error is a French dead-end
**Netflix:** a playback failure shows a centered card with a short message, an error code, and an explicit "Try Again" plus a clear way back.
**Norva today:** the error overlay is a single red `TextView` (`PlayerActivity.java:119-127`); `showStreamError` only sets text/visibility (`335-340`) — no Retry, no Back, no tap handler. The gateway fallback is automatic and one-shot (`fallbackTried`), so after it fails the user is stranded on a wall of French diagnostic text and must use the system Back gesture and re-tap Play in the WebView.
**Sketch:** replace the bare TextView with a small vertical layout — English headline ("Couldn't play this title"), the diagnostic as a collapsible secondary detail, and two large buttons: **Retry** (reset `fallbackTried`, re-`setMediaItem(originalUrl)` + `prepare()`) and **Back** (`finish()`). S effort, and it converts the worst dead-end in the app into a recoverable moment.

### 5. Double-tap-to-seek (the table-stakes mobile gesture)
**Netflix (and YouTube/Disney+/Prime):** double-tap right = +10s, left = −10s, with a ripple and a "+10s" bubble; rapid taps accumulate.
**Norva today:** `PlayerActivity` builds a stock `PlayerView` (`PlayerActivity.java:106`) with only `setShowSubtitleButton(true)` (`:183`). A grep of the entire native package finds **no** `GestureDetector`/`onTouchEvent`/`setOnTouchListener` — there is no touch layer at all. Skipping requires summoning the controller and hitting small FF/rewind icons on a landscape-only screen.
**Sketch:** overlay a `GestureDetector` on the PlayerView root `FrameLayout`, split at 50% width, `player.seekTo(currentPosition ± 10_000)`, fade a `±10s` `TextView` bubble, accumulate rapid taps. Half a day, no new dependencies — and it's the same gesture layer you'll reuse for brightness/volume (P2).

### 6. "More like this" — close the fiche discovery loop
**Netflix:** the lower half of every title page is a "More Like This" grid; after deciding not to play, the user keeps browsing without backing out.
**Norva today:** neither fiche renders related content — `showMovieDetails` ends at `renderMovieVersions` (`MoviesPage.js:1615-1698`) and `showSeriesDetailsV2` ends at the episode list (`SeriesPage.js:1626-1796`). The only exit is Back. (WatchPage's "recommended" grid is a separate VOD-watch surface, not the browse fiche.)
**Sketch:** add one genre-matched rail at the bottom of both fiches — query the existing `genreItems`/page endpoints by the title's primary genre (`getMovieGenres`/`getSeriesGenres`), exclude the current title, and reuse `GenreRails.appendCards` (already imported in both pages, `MoviesPage.js:384`/`SeriesPage.js:378`) with `onItemClick` → `openByItem`. No new asset cost; closes the core engagement loop.

### 7. Offline downloads never resume
**Netflix:** resuming a downloaded title offline picks up exactly where you left off, fully offline — table-stakes for commuters.
**Norva today:** `playLocal()` never passes `EXTRA_RESUME_SECONDS` (`DownloadsActivity.java:632-651`), so `PlayerActivity` starts at 0 (`:76,100,200-207`). On exit, position is returned only as an Activity result for *cloud* history (`PlayerActivity.java:412-428` → `MainActivity.java:688-703`), a no-op offline, and `DownloadStore.Item` has no `positionSeconds` field — so every offline replay restarts. **The cloud resume seek already works**, so this is wiring, not new player code.
**Sketch:** add `positionSeconds` to `DownloadStore.Item` (persist in `toJson/fromJson`); pass it as `EXTRA_RESUME_SECONDS` in `playLocal()`; in `PlayerActivity.finish()`, when `EXTRA_LOCAL` is true, write the final position back to `DownloadStore` keyed by download id. Optionally render a thin progress bar in the Downloads list. Single highest-impact offline win.

### 8. One-hand channel zap + masked switch
**Netflix / best-in-class live (TiviMate, YouTube TV):** change channel without leaving the video — vertical swipe, persistent up/down chevrons, or a last-channel toggle — and keep the previous frame or a channel splash visible during the switch.
**Norva today:** channel switching is **keyboard-only** (`LivePage.js:82-98`); the live controls overlay (`app.html:273-373`) has no prev/next button (the styled `.channel-nav` at `main.css:4256-4265` is never rendered). To zap you must scroll the guide list. And during a switch `prepareLiveSwitch` tears down the stream (`video.src` cleared) *before* the new session, leaving a black box with only a spinner (`VideoPlayer.js:2847-2873`) — the team measures `zapMs` but nothing masks the gap.
**Sketch:** (a) add two persistent thumb-zone up/next + down/prev buttons wired to the existing `selectNextChannel()`/`selectPrevChannel()` (already debounced by the 300ms anti-hammer, so a fast sweep opens one session); (b) immediately paint the target channel's logo+name (known synchronously from the row dataset) over the black video until `markPlaybackUsable()` fires. Costs nothing in latency, makes zapping feel instant.

### 9. Make search a true front door (bottom tab + live channels + useful empty state)
**Netflix:** Search is a permanent bottom tab; opening it before typing shows "Recently searched" + a "Top searches" poster grid, and it spans the *entire* watchable catalogue.
**Norva today:** Search is a 40×40 top-bar icon (`app.html:124-126`; `.nav-search-btn`, `main.css:10015-10021`) — the hardest place to reach one-handed — wired to `openSearch` (`app.js:174`); the phone `#bottom-nav` (`app.html:138-163`) has no Search slot. `runSearch` fires only movie + series queries (`app.js:1131-1134`) and renders only "Movies"/"Series" (`app.js:1160-1161`), so "CNN"/"Sky Sports" returns "No results" even though a live logical-channel search already exists (`API.proxy.xtream.liveStreams(sourceId,null,{q})`, `api.js:2165-2174` — the same call the Live page uses). And the empty state is one dead hint, "Type at least 2 characters…" (`app.js:1106`), with no recent-search persistence anywhere in `public/`.
**Sketch:** (a) add a `data-action="search"` slot to `#bottom-nav` calling `openSearch()` through the existing delegated handler (`app.js:151-171`); (b) add a 3rd parallel live query to `runSearch` + a "Live TV" section that opens a channel into the native player; (c) persist the last ~8 successful queries in localStorage (write in `openSearchResult`, `app.js:1176`) and render them as chips above a "Top searches" poster grid reusing a home rail (`api.js:2085`). The engine itself — debounce, request-race guarding, poster thumbnails, direct-to-fiche — is already well built, so this is all additive, and it turns a hidden magnifier into the single front door it implies.

### 10. Parental controls + a phone-shaped Settings
**Netflix:** per-profile maturity rating, a Kids profile, and an optional profile-switch PIN are prominent, first-class settings; the mobile Settings screen is a short, phone-shaped list (Account, Playback, Downloads, Notifications), never engineering plumbing.
**Norva today:** Norva already nails the hard part — profiles are Netflix-grade ("Who's watching?" gate `profiles.js:480-514`, persistent bottom-nav Profile tab with live avatar `app.html:159-162`) and Play billing is compliant and fully wired. But there is **no** maturity rating, Kids profile, or PIN anywhere (a repo-wide search returns zero matches); the only per-profile control is a genre-hide (`hiddenGenres`, `SourceManager.js:1422-1433`) buried in "Manage Content". And the Settings page is the **desktop 6-tab IPTV surface** (`app.html:699-706`) shown verbatim on phone — it merely becomes horizontally scrollable (`main.css:4335-4338`) — so a phone user faces TV-service / transcoding / user-agent / TMDB-key tabs instead of phone preferences. Two concrete extras: the subscription *management* screen (`subscription.html`, reached via Settings → Manage plan) has **no Restore-purchases** button (it exists only on `subscribe.html:150`), and there is no app-version/About/Help entry at all (`versionName "1.0.0"`, `build.gradle:20`, never surfaced).
**Sketch:** (a) add a per-profile "Kids" flag + optional 4-digit PIN gating the profile switch in `profiles.js`, surfaced as a "Parental controls" row that reuses the `hiddenGenres` store with a maturity preset; (b) add a phone-only Settings layout (reorder under `@media` + native-shell detection) leading with Account / Playback / Downloads and collapsing the IPTV plumbing behind one "Advanced / Sources" entry; (c) drop a "Restore purchases" button onto `subscription.html` and an "About + Help" row into the Account tab. (a) and (b) are larger bets; the Restore button and About row are quick wins.

## Quick wins (ship this week)
*S-effort, P0/P1 items — order roughly by visibility-per-hour.*

1. **Alias the two undefined CSS variables** (`main.css:9956,231,10030`) — active tab + focus rings become brand blue. *(P1, S)*
2. **Normalize the language strays** on Home, the fiches, the live guide, and **translate the native player overlay to English** (`HomePage.js:92,94`; `SeriesPage.js:1682-1683`; `LiveGuideFusion.js:476-484`; `app.html:289,295,316,322`; `PlayerActivity.java:84-86,362-378`). *(P1, S→M)*
3. **Add the global `:focus-visible` rule** and drop `outline:none` on inputs (`main.css:579,3552,10271`). *(P1, S)*
4. **Replace the native player error TextView** with English message + Retry + Back buttons (`PlayerActivity.java:119-127,335-340`). *(P1, S)*
5. **Add the cold-start load watchdog** — 12–15s `postDelayed` in `connect()`, show the existing error panel on fire (`MainActivity.java:217-228,767-833`). *(P1, S)*
6. **Add Search to the bottom nav**, calling the existing `openSearch()` (`app.js:174,1083`). *(P1, S)*
7. **Add `defer` to the 29 app scripts** (no behavior change — they boot on `DOMContentLoaded`, `app.js:1510-1512`). *(P1, M but the defer half is S and risk-free.)*
8. **Stack the mobile fiche to one column** — `grid-template-columns:1fr` in the ≤720px query (`main.css:5800,6632`). *(P1, S)*
9. **Parallelize the home cold fetch** — fire history+rails alongside health/settings; route rails through `getHomeRails` (`HomePage.js:204-234`, `api.js:500`). *(P1, S)*
10. **Mask the channel-switch black gap** with a logo+name splash (`ChannelList.js:2836-2918`, `VideoPlayer.js:2847-2873`). *(P1, S)*
11. **Add "Restore purchases" to the subscription management screen** — wire the existing `NorvaBilling.restore` bridge into `subscription.html` (today it's only on `subscribe.html:150`). *(P1, S)*

## Coverage & caveats

**Audited (code-verified, Android phone only):** the full web shell and router (`app.html`, `app.js`); all phone-facing pages (Home, Live + Guide/EpgGuide/LiveGuideFusion/ChannelList, Movies, Series, Watch, Settings, account/billing); the complete native layer (`MainActivity`, `PlayerActivity`, `DownloadsActivity`/`DownloadService`/`DownloadStore`, `NorvaBilling`, `AndroidManifest`, `styles.xml`, `build.gradle`); the ~9,200-line `main.css` (theme tokens, 44 media queries, all phone overrides); the JS bridges, caching utilities, and i18n/locale handling. All 14 dimensions were audited and adversarially verified against the actual source (the Search and Settings/profiles/billing dimensions were completed in a dedicated second pass); each of the ~100 findings was checked against the code with line refs preserved, and adjusted findings note where the original line ref or mechanism was corrected. Android TV is explicitly **out of scope** (separate later pass), and TV-only rules (e.g. `.tv-mode *:focus`) were excluded from phone verdicts.

**What a code-only audit cannot fully assess — these need a real-device pass:**
- **Felt latency & jank:** actual cold-start time, `zapMs` on real providers, scroll smoothness of the all-episodes-in-DOM series fiche on a low-end phone, and whether the 100vh→100dvh grid math actually janks on URL-bar collapse — all need a physical device on real cellular.
- **Provider-data reality:** how often TMDB backdrops/credits/maturity ratings are actually present (gates the hero, landscape art, "More like this," and cast/maturity findings), and how often the short-EPG drain leaves visible "No info" rows in practice.
- **Player edge behavior:** real DRM/codec failure surfaces, the gateway-fallback success rate, PiP/MediaSession lifecycle correctness, and subtitle rendering against actual OS caption settings.
- **Billing & auth flows:** whether Supabase email confirmation is actually enabled (determines if the sign-up-stranding finding bites), and the RevenueCat/Play billing happy path — neither is inspectable from this code slice.
- **Accessibility in practice:** TalkBack/switch-access traversal order, focus trapping in overlays, and whether the WebView passes through Android font-scale — all require assistive-tech testing on hardware.
- **Subjective polish calls:** exact transition timings, skeleton shapes, and hero rotation cadence should be tuned by eye on-device, not specified from CSS alone.