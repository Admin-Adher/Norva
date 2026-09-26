# VOD responsive grids and scroll latency

## Scope

This release covers the ordinary Web catalogue grids and the paged `See all`
genre buckets for movies and series. Android TV selectors remain separately
scoped under `html.tv-mode`.

## Code and checks

- Flat movie and series grids use fluid CSS Grid tracks with a `2:3` poster
  ratio and cards that fill their available track.
- Paged genre buckets use the same responsive tracks instead of the previous
  fixed-width flex cards. Rails keep their own horizontal scrolling behavior.
- VOD prefetch remains rooted in the catalogue scroll owner and starts 700 px
  before the end. Recycled-card restoration is coalesced with
  `requestAnimationFrame` while scrolling.
- Focused catalogue, source/filter, read-performance, grid-race, and locale
  tests passed: **77 passed, 0 failed**.
- JavaScript syntax checks and `git diff --check` passed.

## Production proof

- `main` commit: `8f9491fe`.
- Cloudflare Pages deployment: run `36242953697`, conclusion `success`.
- Production serves the cache-busted VOD assets from `app.html`; the served
  CSS contains the responsive bucket rule and both page scripts contain the
  frame-coalesced restore path.
- Mobile runtime sample at 488 x 1055 CSS px: grid width 488 px, two 224 px
  columns, first card left edge 10 px, document horizontal overflow 0 px,
  120 cards, scrollHeight 24192 px and clientHeight 634 px. After a rapid
  two-page scroll, scrollTop was 2638 px with six cards visible and no blank
  sentinel gap.
- A desktop runtime sample at 1357 px before final promotion measured seven
  fluid columns, first card left edge 24 px and document horizontal overflow
  0 px. The production stylesheet serves the same rule after promotion.

## Limits

The paged `See all` view is covered by source and contract checks, but was not
opened against a fresh ordinary QA account during this turn. The 100-reader
campaign remains deferred. The broader commercial-readiness objective remains
open for the previously documented provider, Android, enrichment, and
production-playback evidence gaps.
