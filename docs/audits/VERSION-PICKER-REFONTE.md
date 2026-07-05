# Version picker refonte — fiche Film & Série

_Last updated: 2026-07-05 — PRs #162 → #163 → #164 (merged to `main`)._

The **Versions** block on the Movie and Series fiches lets the user pick which copy of a
title to play. This doc records why the labels were wrong, the three passes it took to fix
them, and the design that shipped.

## The problem

On real catalogues a title's "versions" are almost never different cuts of one file — they
are the **same film re-imported many times**:

- across a provider's **regional catalogue sections** (`EN -`, `AR ▎`, `FR -`, `SCAN ▎`,
  `NF -`, `TR ▎NETFLIX`, `|IN| HINDI SUBS` …), and
- across **several providers** the user subscribes to.

The audio is usually the original; the prefixes are **subtitle / market labels**, not dubs.
Critically, the provider almost never populates the structured `quality` / language columns
(they are `null`), so any label built by trusting those columns is empty or wrong.

Concrete failure observed on _"One Last Adventure: The Making of Stranger Things 5"_ (a
Netflix English documentary imported ~11× on one account): the old picker showed either
`PREFIX - mkv - Strng IPTV 8K` (garbage) or **"French ✓" on all 8 buttons** — a title-level
language stamped uniformly, carrying zero information — with the one thing that actually
differed (the market) truncated off-screen.

## Three passes

| PR | Approach | Why it was superseded |
|----|----------|-----------------------|
| **#162** | Language-first label, garbage-filtered (`parseLeadingRegionTag` rejects `PREFIX`), fluidity pill, differentiator chips | The "language" came from a **title-level** aggregate applied to every version → identical & misleading on regional re-imports. |
| **#163** | Compact one-line `Provider · Quality · Container · Market`, everything visible | `Provider · Container` were **identical on every button** and ate the width; the differentiator (market) was truncated. Overflowed. |
| **#164** | **Two-tier**: bold headline = what *differs*, muted meta = the constants | Shipped. |

## The shipped design (#164)

`MediaUtils.versionDescriptor(item, { siblings, index, resolveSourceName })` →
`{ headline, meta, badge, tier }`.

- **headline** — leads with the axis that actually **differs** across the title's versions:
  - the **market** (language/edition), humanised, by **default**;
  - the **provider** when the market is constant across versions but the provider isn't
    (same film across several subscriptions). This is the *adaptive lead*.
- **meta** — the quiet constants, demoted: `Provider · Container` (or `Market · Container`
  when the provider leads). A field equal to the headline is never repeated.
- **badge** — `quality` when present (`4K` highlighted via `.hi`); omitted when it would
  duplicate the headline.
- **tier** — playback **fluidity** (`compatibility_tier`) as a coloured dot
  (green = `direct`, blue = `remux`, amber = `video_transcode`); absent/`unknown` → no dot.
- **true duplicates** — when `market + provider + container + quality` all match a sibling,
  the raw provider **category** (`|EN| DOCUMENTARY`, `AR ▎NETFLIX`) is appended to keep the
  two buttons distinguishable.

### Market humanisation

Reuses the app's existing language layer and only adds what it must:

1. `MARKET_LABELS` — a small map for the **non-ISO IPTV tokens** the live catalogue uses
   (`SC/SCAN/SCAND → Nordic`, `NF → Netflix`, `AMZ → Prime Video`, `LAT/LA → Latino`,
   `EXYU → Ex-YU`, `QFR/FRQ/QC → French (QC)`, the Indian regionals `TA/TL/ML/KN/…`, the
   Nordic singletons `SE/DK/NO/FI/IS`, …). Labels are **English**, to match the rest of the
   UI (`languageDisplayFull` already renders "French"/"Arabic" elsewhere).
2. `parseLeadingRegionTag` + `languageDisplayFull` for the ~20 **ISO** tokens
   (`EN → English`, `AR ▎ → Arabic`, `AR-SUBS → "Arabic · ST"`, …).
3. `versionCategoryMarket` — platform keywords in the category (`NETFLIX`, `MULTI-SUB`, …).
4. Honest fallback: an **ambiguous** token degrades to the raw token or to the provider
   lead, **never a wrong guess** (`TG/TM/STH/AS/KA` are deliberately in `MARKET_REJECT`
   rather than mapped — mislabelling ~3k titles is worse than a neutral fallback).

### Rendering

One shared markup in both `renderMovieVersions` (MoviesPage) and `renderSeriesVersions`
(SeriesPage): `.version-head` (dot + `.version-headline` + `.version-quality-badge`) over a
`.version-meta` line. All descriptor fields are `escapeHtml`-wrapped (provider / raw title /
category are attacker-controllable). CSS truncates with `min-width:0` + ellipsis so the
headline never pushes the badge off-card and the button never overflows the grid.

## Adversarial review (#164)

A 5-lens workflow (IPTV-map correctness, JS logic, XSS, CSS, movie/series parity) with each
finding independently verified. Confirmed fixes applied:

- **CSS class collision** — the inline quality badge was named `.version-badge`, which
  already existed as the `position:absolute` poster-card "N versions" pill declared later in
  the file; it clobbered the inline badge. Renamed to `.version-quality-badge`.
- **headline == provider duplication** — guard `metaParts.filter(p => p !== headline)`.
- **`SCANDI`/`NORDIC` unreachable** — the leading-token parser caps at 5 chars; dropped the
  dead 6-char keys, added reachable `SCAND`.
- Polish: HBO category match tightened off bare `MAX`; `versionMarket` memoised
  (`WeakMap`, O(n²)→O(n)); null-sibling guard; `tier.cls` escaped.

Rejected findings (verified `isReal:false`): the `TG/TM/STH/AS/AF` map guesses — the
conservative fallback is correct.

## Files

- `public/js/utils/mediaUtils.js` — `versionDescriptor` + `versionMarket` + `MARKET_LABELS`.
- `public/js/pages/MoviesPage.js` / `SeriesPage.js` — the two renderers.
- `public/css/main.css` — `.version-head` / `.version-headline` / `.version-quality-badge` /
  `.version-meta` / `.version-tier-dot`.
- `tests/versionDescriptor.test.js` — 13 unit tests (51/51 suite green).

## Known limitations / future

- **Labels are English.** Switching markets to French (`Nordique`, `Espagnol`) is an
  app-wide i18n decision, not local to this component — deliberately deferred.
- **No probed-audio integration.** When `cloud_titles.audio_languages` is populated for a
  specific variant (e.g. `["en","hi"]`), the headline could show the real dub rather than
  the market prefix. Not wired (the grid item doesn't carry per-variant probed audio today).
- **Duplicate re-imports are still shown, not merged.** A follow-up could hide/fuse
  near-identical regional copies and keep only meaningful differences (4K, distinct
  provider). Tracked separately.
