# Norva Theme Context

Source snapshot: `public/css/main.css`, `public/app.html`, and the Android phone/TV `res/values` files on 2026-07-27.

Norva uses a custom, dark-only vanilla CSS system. There is no Tailwind configuration and no JavaScript theme provider in the product shell. The canonical web tokens live in the opening `:root` block of `public/css/main.css`.

## Part 1 — Compact token summary

### Canonical web colors

| Role | Token | Exact value |
| --- | --- | --- |
| App canvas | `--color-bg-primary` | `#080B12` |
| Raised surface | `--color-bg-secondary` | `#12121a` |
| Card / input surface | `--color-bg-tertiary` | `#1a1a25` |
| Hover surface | `--color-bg-hover` | `#22222f` |
| Active surface | `--color-bg-active` | `#2a2a3a` |
| Primary action / focus | `--color-accent` | `#3B82F6` |
| Primary hover / highlighted copy | `--color-accent-hover` | `#60A5FA` |
| Primary tint | `--color-accent-dim` | `rgba(59, 130, 246, 0.2)` |
| Secondary accent | `--color-accent-secondary` | `#8B5CF6` |
| Success | `--color-success` | `#10b981` |
| Warning | `--color-warning` | `#f59e0b` |
| Error | `--color-error` | `#ef4444` |
| Primary text | `--color-text-primary` | `#F8FAFC` |
| Secondary text | `--color-text-secondary` | `#94A3B8` |
| Muted text | `--color-text-muted` | `#71717a` |
| Border | `--color-border` | `#27272a` |
| Strong border | `--color-border-light` | `#3f3f46` |
| Glass surface | `--glass-bg` | `rgba(18, 18, 26, 0.8)` |
| Glass edge | `--glass-border` | `rgba(255, 255, 255, 0.1)` |

Compatibility aliases:

- `--primary-blue: var(--color-accent)`
- `--text-secondary: var(--color-text-secondary)`

### Native shell colors

These values are already present in the native clients. They document current platform divergence; they are not additional web palette recommendations.

| Surface | Exact value |
| --- | --- |
| Phone theme, status bar, navigation bar, splash | `#0A0A0F` |
| Phone `colorPrimary` | `#6366f1` |
| Phone player window | Android black |
| TV launcher background | `#05050A` |
| TV `colorAccent` | `#6C63FF` |

### Typography

- Body: `Inter`, then `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `Roboto`, `sans-serif`.
- Loaded Inter weights: `400`, `500`, `600`, `700`.
- Editorial display: `Outfit`, loaded only at weight `800`.
- Wordmark: `Century Gothic`, `sans-serif`; no Century Gothic webfont is loaded, so availability is platform-dependent.
- Body baseline: `14px / 1.5`.
- Shared headings: weight `600`, line-height `1.3`; `h2 1.5rem`, `h3 1.25rem`, `h4 1rem`.
- Home billboard title: Outfit `clamp(2rem, 4.8vw, 4.6rem)`, line-height `0.96`.
- Home rail heading: Outfit `1.5rem`.
- Movie/series detail title: `clamp(2.2rem, 6vw, 5rem)`, line-height `0.95`.

Observed fidelity gap: `--font-display` and `--color-text-bright` are consumed in `main.css` but are not defined anywhere in the checked product sources. Designs must not invent values for them. Until the product defines them, affected font declarations inherit/fall back and affected color declarations fall back according to CSS computed-value behavior.

### Spacing

| Token | Base | ≤768px | ≤640px |
| --- | ---: | ---: | ---: |
| `--space-xs` | `4px` | `4px` | `4px` |
| `--space-sm` | `8px` | `8px` | `8px` |
| `--space-md` | `16px` | `16px` | `12px` |
| `--space-lg` | `24px` | `16px` | `16px` |
| `--space-xl` | `32px` | `24px` | `20px` |
| `--space-2xl` | `48px` | `48px` | `48px` |

### Radius and elevation

| Role | Token | Exact value |
| --- | --- | --- |
| Small | `--radius-sm` | `6px` |
| Medium | `--radius-md` | `10px` |
| Large | `--radius-lg` | `16px` |
| Pill / circle | `--radius-full` | `9999px` |
| Small shadow | `--shadow-sm` | `0 2px 4px rgba(0, 0, 0, 0.3)` |
| Medium shadow | `--shadow-md` | `0 4px 12px rgba(0, 0, 0, 0.4)` |
| Large shadow | `--shadow-lg` | `0 8px 24px rgba(0, 0, 0, 0.5)` |
| Accent glow | `--shadow-glow` | `0 0 20px rgba(59, 130, 246, 0.3)` |

### Motion

- Fast: `150ms ease`
- Normal: `250ms ease`
- Slow: `350ms ease`
- Page entry in current CSS: `160ms ease`
- Card hover lift in current CSS: `translateY(-4px)` over `200ms ease`
- Mobile sheet entry in current CSS: `220ms ease`
- Touch pressed state in current CSS: `scale(0.97)` and `opacity: 0.85`
- Reduced-motion rules exist for page entry, skeletons, live indicators, sync progress, and TV route/card transitions.

### Layout, breakpoints, and safe areas

- Base navbar height: `60px`; `56px` at `≤768px`; `52px` at `≤640px`; `48px` at `≤480px`.
- Base sidebar: `320px`; `280px` at `≤1024px`; back to `320px` at `≤768px`.
- EPG sidebar: `250px`; `200px` at `≤1024px`; `180px` at `≤768px`.
- Canonical layout breakpoints with token changes: `1024px`, `768px`, `640px`, `480px`.
- Component-local media queries also exist at `1100`, `900`, `896`, `720`, `560`, `380` and corresponding minimum-width/orientation/height conditions.
- Safe-area tokens directly wrap `env(safe-area-inset-top/right/bottom/left, 0px)`.
- `--topbar-h` is the navbar plus safe top inset.
- At `≤640px`, `--bottom-nav-h` is `calc(57px + env(safe-area-inset-bottom, 0px))`.
- The app shell uses `100vh`, `-webkit-fill-available`, then `100dvh` in that order so `100dvh` wins in modern WebViews.

## Part 2 — Raw source dumps

### `public/css/main.css` canonical token block

The file is 433,867 bytes and 17,328 lines in this snapshot. The complete canonical token block is lines 1–92 below. Lines 93–17,328 contain reset/base styles and page/component implementations, so they are intentionally not duplicated in this init file.

```css
/* =====================================================
  * Norva - Dark Theme Design System
   ===================================================== */

/* CSS Variables */
:root {
  /* iOS Safari toolbar compensation (set dynamically by JS) */
  --ios-ui-bottom: 0px;

  /* Height of the fixed mobile bottom nav (0 outside the ≤640px breakpoint).
     Every viewport-sized container (calc(100vh/100dvh - …)) must subtract it,
     otherwise its last rows hide behind the bar. */
  --bottom-nav-h: 0px;


  /* Colors */
  --color-bg-primary: #080B12;
  --color-bg-secondary: #12121a;
  --color-bg-tertiary: #1a1a25;
  --color-bg-hover: #22222f;
  --color-bg-active: #2a2a3a;

  --color-accent: #3B82F6;
  --color-accent-hover: #60A5FA;
  --color-accent-dim: rgba(59, 130, 246, 0.2);
  --color-accent-secondary: #8B5CF6;

  --color-success: #10b981;
  --color-warning: #f59e0b;
  --color-error: #ef4444;

  --color-text-primary: #F8FAFC;
  --color-text-secondary: #94A3B8;
  --color-text-muted: #71717a;

  /* Compatibility aliases — some mobile-nav and focus rules reference these
     legacy names. Point them at the canonical tokens so the active bottom tab
     and focus rings render in the brand colour instead of falling back to grey
     (the active tab was inheriting the inactive grey) or a non-brand violet. */
  --primary-blue: var(--color-accent);
  --text-secondary: var(--color-text-secondary);

  --color-border: #27272a;
  --color-border-light: #3f3f46;

  /* Glass effect */
  --glass-bg: rgba(18, 18, 26, 0.8);
  --glass-border: rgba(255, 255, 255, 0.1);

  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;
  --space-2xl: 48px;

  /* Border Radius */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: 0 2px 4px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
  --shadow-glow: 0 0 20px rgba(59, 130, 246, 0.3);

  /* Transitions */
  --transition-fast: 150ms ease;
  --transition-normal: 250ms ease;
  --transition-slow: 350ms ease;

  /* Layout */
  --navbar-height: 60px;
  --sidebar-width: 320px;
  --epg-sidebar-width: 250px;

  /* Safe area insets for notched devices */
  --safe-area-inset-top: env(safe-area-inset-top, 0px);
  --safe-area-inset-right: env(safe-area-inset-right, 0px);
  --safe-area-inset-bottom: env(safe-area-inset-bottom, 0px);
  --safe-area-inset-left: env(safe-area-inset-left, 0px);

  /* REAL height of the top bar box. In the edge-to-edge webviews (Android 15 /
     targetSdk 35 forces it; iOS standalone) the navbar pads itself down by the
     status-bar inset, so its box is navbar-height + safe-top. Every container
     sized against the viewport must subtract THIS, not --navbar-height alone —
     that miss left exactly ~safe-top of content hidden behind the bottom nav. */
  --topbar-h: calc(var(--navbar-height) + var(--safe-area-inset-top));
}
```

### `public/css/main.css` responsive token overrides

These are the complete token-setting fragments at their current source ranges. Each enclosing media query continues into component rules that are deliberately omitted.

```css
/* public/css/main.css lines 5133–5140 */
/* Mobile-first responsive breakpoints */
@media (max-width: 1024px) {

  /* Tablet adjustments */
  :root {
    --sidebar-width: 280px;
    --epg-sidebar-width: 200px;
  }

/* public/css/main.css lines 5149–5158 */
@media (max-width: 768px) {

  /* Tablet/Mobile landscape */
  :root {
    --navbar-height: 56px;
    --sidebar-width: 320px;
    --space-lg: 16px;
    --space-xl: 24px;
    --epg-sidebar-width: 180px;
  }

/* public/css/main.css lines 5499–5507 */
@media (max-width: 640px) {

  /* Mobile portrait - phones */
  :root {
    --navbar-height: 52px;
    --space-md: 12px;
    --space-lg: 16px;
    --space-xl: 20px;
  }

/* public/css/main.css lines 5935–5940 */
@media (max-width: 480px) {

  /* Extra small phones */
  :root {
    --navbar-height: 48px;
  }

/* public/css/main.css lines 13416–13421 */
@media (max-width: 640px) {
  /* The fixed bottom bar exists at this breakpoint — publish its height so every
     viewport-sized container (grids, settings, EPG) subtracts it.
     57px = 56px nav-link + 1px border-top; plus the gesture-bar inset the bar
     pads itself with in edge-to-edge webviews. */
  :root { --bottom-nav-h: calc(57px + env(safe-area-inset-bottom, 0px)); }
```

### `public/app.html` font loading

Relevant source range: lines 21–25. The rest of the 2,047-line document is product markup and script loading, not theme definition.

```html
  <link rel="stylesheet" href="/css/main.css?v=89">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@800&display=swap"
    rel="stylesheet">
```

The same document sets `viewport-fit=cover` and `<meta name="theme-color" content="#0a0a0f">`.

### `clients/android-phone/app/src/main/res/values/colors.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#6366f1</color>
    <color name="colorBackground">#0a0a0f</color>
</resources>
```

### `clients/android-phone/app/src/main/res/values/styles.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Browsing keeps the status bar (clock/battery/notifications stay visible,
         like Netflix); only the player goes immersive via its own theme below. -->
    <style name="AppTheme" parent="android:style/Theme.Material.NoActionBar">
        <item name="android:statusBarColor">#0A0A0F</item>
        <item name="android:navigationBarColor">#0A0A0F</item>
        <item name="android:windowBackground">#0A0A0F</item>
    </style>

    <!-- Fullscreen playback: PlayerActivity layers immersive-sticky on top. -->
    <style name="PlayerTheme" parent="android:style/Theme.Material.NoActionBar.Fullscreen">
        <item name="android:windowBackground">@android:color/black</item>
    </style>
    <!-- Branded cold-start splash: dark brand background + app icon, then the
         normal theme takes over (core-splashscreen backports pre-12). -->
    <style name="Theme.NorvaSplash" parent="Theme.SplashScreen">
        <item name="windowSplashScreenBackground">#0A0A0F</item>
        <item name="windowSplashScreenAnimatedIcon">@drawable/ic_launcher</item>
        <item name="postSplashScreenTheme">@style/AppTheme</item>
    </style>
</resources>
```

### `clients/android-tv/app/src/main/res/values/colors.xml`

```xml
<resources>
    <color name="ic_launcher_background">#05050A</color>
</resources>
```

### `clients/android-tv/app/src/main/res/values/styles.xml`

```xml
<resources>
    <style name="AppTheme" parent="android:style/Theme.Material.NoActionBar">
        <item name="android:windowNoTitle">true</item>
        <item name="android:windowActionBar">false</item>
        <item name="android:windowFullscreen">true</item>
        <item name="android:fontFamily">sans</item>
        <item name="android:colorAccent">#6C63FF</item>
    </style>
</resources>
```
