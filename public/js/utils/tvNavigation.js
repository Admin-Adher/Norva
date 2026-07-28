/**
 * TV Navigation — D-pad spatial navigation for the Android TV WebView client.
 *
 * The Android client appends "NorvaTV-AndroidTV" to the user agent; when
 * detected (or with ?tv=1 for desktop testing) this module:
 *  - moves a visible focus ring between interactive elements with the arrow
 *    keys (closest element in the pressed direction),
 *  - maps Enter (D-pad center) to click,
 *  - stays out of the way inside text inputs and on the video player when
 *    its controls overlay is hidden (so player shortcuts keep working).
 */

(() => {
    const isTv = navigator.userAgent.includes('NorvaTV-AndroidTV') ||
        new URLSearchParams(location.search).has('tv');
    if (!isTv) return;

    document.documentElement.classList.add('tv-mode');

    const INTERACTIVE_SELECTOR = [
        'a[href]', 'button', 'input', 'select', 'textarea',
        '.movie-card', '.series-card', '.channel-item', '.episode-item',
        '.continue-card', '.search-result', '.group-header', '.nav-link',
        '.gsearch-result', '.gsearch-seeall', '.gsearch-cancel', // global (menu) search overlay
        '.captions-option', '.audio-option', '.version-item', '.multi-select-item',
        '.search-group-chip', '.watch-episode-item', '.watch-season-header',
        '.season-header', '.tab', '.watch-recommended-card', '.context-item',
        '.live-guide-group', '.live-guide-row',
        // Native <summary> is actionable but absent from the generic button/link
        // selectors. Keep Settings' Advanced sections reachable with D-pad Center.
        '.settings-advanced-summary',
        // Home page cards (dashboard)
        '.channel-tile', '.dashboard-card', '.tv-more-like-card'
    ].join(',');
    // MoviesPage's cloud genre/category bucket deliberately reuses
    // GenreRails.appendCards(), whose cards are `.dashboard-card` rather than the
    // flat catalogue's `.movie-card`. Treat both renderers as the same semantic
    // grid so changing a filter cannot sever the D-pad graph at the toolbar.
    const MOVIE_CATALOG_CARD_SELECTOR =
        '.movie-card, .genre-bucket-grid .dashboard-card';
    const CATALOG_CARD_SELECTOR =
        `${MOVIE_CATALOG_CARD_SELECTOR}, .series-card`;
    const CATALOG_TILE_SELECTOR =
        `${CATALOG_CARD_SELECTOR}, .continue-card`;

    const MODAL_SELECTOR = [
        '#modal.active',
        '#edit-user-modal.active',
        '.modal-overlay.active',
        '.np-overlay',
        '#norva-region-prompt',
        '.norva-modal-overlay',
        '.trailer-lightbox'
    ].join(',');

    // One remembered content stop per page. A premium 10-foot interface returns
    // viewers to the exact row/control they left when they briefly open the rail;
    // relying on geometry here caused Settings -> Transcoding and Series -> Movies
    // jumps whenever two controls happened to share a screen y-coordinate.
    const pageFocusMemory = new Map();
    // Returning from the single catalogue search field should land on the exact
    // primary filter that opened it, not whichever control happens to be closest
    // to the search box's wide visual centre.
    const catalogHeaderOrigins = new WeakMap();

    // Optional native audit bridge, present only in the opt-in debug APK used by
    // the emulator matrix. It has zero effect in release/cloud browsers.
    function auditDpad(action, el) {
        const bridge = window.__norvaDpadAudit;
        if (!bridge || typeof bridge.log !== 'function') return;
        const page = el?.closest?.('.page');
        const id = el?.id || '-';
        const classes = String(el?.className || '-').trim().replace(/\s+/g, '.');
        const text = String(el?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        bridge.log(`${action} id=${id} class=${classes} text=${text} page=${page?.id || '-'}`);
    }

    // Visibility test on an already-measured rect — same truthiness as isVisible's
    // rect checks, split out so getCandidatesWithRects can reuse the one rect it
    // already read instead of forcing a second getBoundingClientRect() per element.
    function isVisibleRect(rect) {
        if (rect.width === 0 || rect.height === 0) return false;
        // Keep candidates near the viewport so huge lists stay fast
        return rect.bottom > -400 && rect.top < window.innerHeight + 400 &&
            rect.right > -200 && rect.left < window.innerWidth + 200;
    }

    function isVisible(el) {
        if (!el.offsetParent && el.offsetWidth === 0 && el.offsetHeight === 0) return false;
        return isVisibleRect(el.getBoundingClientRect());
    }

    // Rendering test without a viewport constraint. Explicit focus graphs may
    // target the row just outside the viewport; focusElement() then scrolls it in.
    // This is intentionally different from isVisible(), which keeps spatial scans
    // bounded for performance.
    function isRendered(el) {
        if (!el || el.disabled || !el.isConnected) return false;
        if (el.closest('.hidden, [hidden]')) return false;
        return Boolean(el.offsetParent || el.offsetWidth || el.offsetHeight);
    }

    // The currently open modal, if any. While one is open, navigation is
    // confined to it so the D-pad can't escape to the dimmed page behind.
    function openModal() {
        // Return the TOPMOST open modal (last in DOM), so a modal opened on top of
        // another — e.g. the TV <select> list (openTvSelect) raised from inside the
        // region prompt — correctly captures navigation instead of the one beneath.
        // #norva-region-prompt is the first-run region dialog (cloudApi.js): listing
        // it here traps the D-pad inside it and lets Back/Escape dismiss it.
        // .norva-modal-overlay is the promise-based NorvaModal (confirm/alert): it is
        // shown by being in the DOM (no `.active` class) and removed on close, so its
        // mere presence means it is open — listing it confines the arrows to the dialog
        // AND lets closeTopModal()/hardware-Back dismiss it (see closeTopModal below).
        // .trailer-lightbox is the fullscreen YouTube trailer overlay (mediaUtils): it is
        // shown by presence (no .active) and sits OVER an open fiche, so listing it here
        // traps the D-pad inside it and lets closeTopModal()/Back dismiss the trailer
        // instead of the fiche behind it.
        const modals = document.querySelectorAll(MODAL_SELECTOR);
        return modals[modals.length - 1] || null;
    }

    // Docked catalogue previews are navigation regions, never modal scopes.
    function isTvSplitPanel(panel) {
        if (!panel || panel.dataset.tvSplitPreview !== 'true') return false;
        if (panel.id === 'movie-details') {
            return Boolean(panel.closest('#page-movies')?.classList.contains('tv-movies-layout-ready'));
        }
        if (panel.id === 'series-tv-preview') {
            const page = panel.closest('#page-series');
            return Boolean(page?.classList.contains('tv-series-layout-ready') &&
                !page.classList.contains('series-detail-open'));
        }
        return false;
    }

    function lastVisible(selector) {
        return [...document.querySelectorAll(selector)].reverse().find(isVisible) || null;
    }

    // A transient popover or detail view confines D-pad navigation to itself, the
    // same way an open modal does — so arrows can't leak to the page behind it.
    // Priority: a real modal, then an open category multi-select panel, then an
    // open Movies/Series detail panel (its actions/seasons/episodes live inside it).
    // These panels aren't modals (they toggle .hidden, not .active), so openModal()
    // alone wouldn't trap them — hence a dedicated scope resolver.
    function navScope() {
        const modal = openModal();
        if (modal) return modal;

        const multiSelect = lastVisible('.multi-select-panel:not(.hidden)');
        if (multiSelect) return multiSelect;

        const details = lastVisible('#movie-details:not(.hidden), #series-details:not(.hidden)');
        return details && !isTvSplitPanel(details) ? details : document;
    }

    // Per-keydown memo of the candidate scan. A single arrow press can call findNext
    // 2-3 times (e.g. Left runs the TILE check then the rail guard), each re-scanning
    // up to 400 nodes with getBoundingClientRect + getComputedStyle. Caching the scan
    // for the duration of ONE synchronous keydown collapses those to a single pass.
    // The cache is reset at keydown start and dropped on a microtask right after the
    // handler unwinds, so no later (page-entry / observer / focus-restore) caller can
    // ever read stale rects. null = nothing cached.
    let candCache = null;

    // Single layout pass: measure each candidate's rect ONCE and keep it alongside
    // the element, so findNext can score without a second getBoundingClientRect().
    // rects[i] corresponds to els[i]. Filtering/order/400-cap are identical to the
    // old getCandidates (the inlined offset + rect checks equal isVisible(el)).
    function getCandidatesWithRects() {
        if (candCache) return candCache;
        const scope = navScope();
        const all = scope.querySelectorAll(INTERACTIVE_SELECTOR);
        const els = [];
        const rects = [];
        for (const el of all) {
            if (el.disabled) continue;
            if (el.closest('.hidden, [hidden]')) continue;
            // The channel row's ▶ play button is redundant on TV (OK on the row body
            // already plays) and, being a right-edge child, it out-scores the next
            // column on a Right press — drop it so the row is the sole per-channel stop.
            if (el.classList.contains('live-guide-play')) continue;
            // Movies/Series cards pin an always-visible ♥ favourite button and a
            // "N versions" badge inside the poster (opacity:1, so not caught by the
            // invisibility test below). On TV both hijack the D-pad — Up/Down/Right
            // off a card lands on the card's own corner instead of the neighbouring
            // card. Favourite + version selection live in the detail panel, so these
            // are never D-pad stops. (The detail-panel favourite is .movie-secondary-
            // action / .series-secondary-action — a different class — and stays.)
            if (el.classList.contains('favorite-btn') || el.classList.contains('version-badge')) continue;
            // A category row and its nested checkbox represent the same action.
            // Keep the full row as the sole TV stop so one category never requires
            // two arrow presses or leaves the focus ring on the tiny checkbox.
            if (el.matches('.multi-select-item input[type="checkbox"]')) continue;
            if (!el.offsetParent && el.offsetWidth === 0 && el.offsetHeight === 0) continue;
            const rect = el.getBoundingClientRect();
            if (!isVisibleRect(rect)) continue;
            // Skip elements painted invisible (opacity:0 / visibility:hidden) — e.g. the
            // per-row favourite heart and the search clear-×. isVisibleRect only tests
            // size/viewport, so without this the D-pad ring can land on nothing.
            // getComputedStyle forces a style resolution, so it runs ONLY after the
            // rect test — i.e. for the handful of on-screen candidates, not every one
            // of the up-to-400 off-screen grid cards (the dominant per-press cost).
            const cs = getComputedStyle(el);
            if (cs.opacity === '0' || cs.visibility === 'hidden') continue;
            els.push(el);
            rects.push(rect);
            if (els.length >= 400) break;
        }
        candCache = { els, rects };
        return candCache;
    }

    function getCandidates() {
        return getCandidatesWithRects().els;
    }

    function activePage() {
        return document.querySelector('.page.active');
    }

    function getPageCandidates() {
        const page = activePage();
        if (!page) return [];
        return getCandidates().filter(el => page.contains(el));
    }

    // First candidate that is NOT a text input. Used wherever we fall back to "the
    // page's first candidate" on page-entry / focus restoration, so a still-loading
    // page never traps the D-pad in a search box (focusing one raises the IME and
    // makes Left a caret move). Degrades to the raw first candidate if all are text.
    function firstNonTextCandidate(list) {
        if (!list || !list.length) return null;
        return list.find((el) => !isTextField(el)) || list[0];
    }

    // Live TV's first candidate in DOM order is the #channel-search text input, a poor
    // D-pad landing (raises the IME, and Left becomes a caret move so the menu is no
    // longer one press away). Prefer an actionable, directional target on that page.
    function pageDefaultTarget(page) {
        if (page && page.id === 'page-live') {
            return page.querySelector('#channel-list .group-header, #channel-list .channel-item')
                || page.querySelector('.player-section .live-guide-preview [data-action="watch"]')
                || page.querySelector('.player-section .live-guide-row')
                // Still loading (no channel rows yet): fall back to an actionable, NON-TEXT
                // sidebar control so the dive/initial-focus never lands on #channel-search —
                // focusing that text field raises the on-screen IME and turns Left into a
                // caret move, breaking the "menu is one Left press away" guarantee.
                || [...page.querySelectorAll('#source-select, #toggle-groups, #live-hide-broken-btn')]
                    .find((el) => isVisible(el) && !el.disabled)
                || null;
        }
        // Movies/Series: land on the first content card (Netflix-style), not the source
        // <select> that happens to be first in DOM — the controls sit one ArrowUp away.
        // Guarded to a VISIBLE card so an open detail panel (grid hidden) or empty grid
        // falls back to the caller's default.
        if (page && (page.id === 'page-movies' || page.id === 'page-series')) {
            return [...page.querySelectorAll(CATALOG_CARD_SELECTOR)]
                .find(isVisible) || null;
        }
        // Settings always enters through its first logical tab. Spatial scoring
        // previously selected the far-right Transcoding tab because it happened
        // to align with the rail item, then scrolled the page header off-screen.
        if (page && page.id === 'page-settings') {
            return [...page.querySelectorAll('.settings-container .tabs .tab')]
                .find((el) => el.dataset.tab === 'account' && isRendered(el))
                || [...page.querySelectorAll('.settings-container .tabs .tab')]
                    .find(isRendered)
                || null;
        }
        return null;
    }

    function rememberedPageTarget(page) {
        if (!page) return null;
        const remembered = pageFocusMemory.get(page.id);
        if (!remembered) return null;
        if (remembered.element && page.contains(remembered.element) &&
            isRendered(remembered.element)) {
            return remembered.element;
        }
        if (!remembered.key) return null;
        for (const candidate of page.querySelectorAll(INTERACTIVE_SELECTOR)) {
            if (isRendered(candidate) && cardKey(candidate) === remembered.key) {
                remembered.element = candidate;
                return candidate;
            }
        }
        return null;
    }

    // Deterministic rail -> page transition. Settings deliberately ignores
    // memory so every fresh entry starts at Account; catalogue/live pages resume
    // the viewer's last content stop and otherwise use their semantic default.
    function pageEntryTarget(page) {
        if (!page) return null;
        if (page.id === 'page-settings') {
            // Rail -> Settings may happen without a page class mutation. Activate
            // Account first, then resolve/focus its tab so focus and visible panel
            // can never describe two different destinations.
            preparePageEntry(page);
            return pageDefaultTarget(page);
        }
        const semanticDefault = pageDefaultTarget(page);
        return rememberedPageTarget(page)
            || semanticDefault
            || firstNonTextCandidate(getPageCandidates());
    }

    function preparePageEntry(page) {
        if (!page || page.id !== 'page-settings') return null;
        const account = page.querySelector('.settings-container .tabs .tab[data-tab="account"]');
        const accountPanel = page.querySelector('#tab-account.tab-content');
        if (!account || !accountPanel || !isRendered(account)) return null;

        const isCoherent = () =>
            account.classList.contains('active') &&
            accountPanel.classList.contains('active');
        if (!isCoherent()) {
            const settingsController = window.app?.pages?.settings;
            if (typeof settingsController?.switchTab === 'function') {
                settingsController.switchTab('account');
            } else {
                account.click();
            }
        }

        // Defensive pre-controller fallback for very early key input. Normal app
        // flow uses SettingsPage.switchTab above; this mirrors its accessible state
        // only when no handler made Account coherent synchronously.
        if (!isCoherent()) {
            page.querySelectorAll('.settings-container .tabs .tab').forEach((tab) => {
                const selected = tab === account;
                tab.classList.toggle('active', selected);
                tab.setAttribute('aria-selected', selected ? 'true' : 'false');
            });
            page.querySelectorAll('.settings-container .tab-content').forEach((panel) => {
                const selected = panel === accountPanel;
                panel.classList.toggle('active', selected);
                panel.setAttribute('aria-hidden', selected ? 'false' : 'true');
            });
        }

        page.scrollTop = 0;
        const container = page.querySelector('.settings-container');
        if (container) container.scrollTop = 0;
        accountPanel.scrollTop = 0;
        return isCoherent() ? account : null;
    }

    // Stable entry point for the docked Movies/Series preview. Generic geometry
    // cannot reliably bridge from compact filters to a CTA below a large artwork.
    function tvSplitPanelEntryTarget() {
        const page = activePage();
        let panel = null;
        let previewCard = null;
        let selectors = [];
        if (page?.id === 'page-movies' &&
            document.documentElement.classList.contains('tv-movies-active')) {
            panel = page.querySelector('#movie-details');
            previewCard = page.querySelector(
                '#movies-grid .movie-card.tv-preview-active, ' +
                '#movies-grid .dashboard-card.tv-preview-active'
            );
            selectors = [
                '#movie-primary-action', '#movie-detail-favorite',
                '.movie-version-item.active', '.movie-version-item',
                '.movie-detail-actions button:not(.movie-back-btn):not([disabled])'
            ];
        } else if (page?.id === 'page-series' &&
            document.documentElement.classList.contains('tv-series-active')) {
            panel = page.querySelector('#series-tv-preview');
            previewCard = page.querySelector('#series-grid .series-card.tv-preview-active');
            selectors = ['#series-tv-preview-open', '#series-tv-preview-favorite'];
        } else {
            return null;
        }
        if (!panel || panel.classList.contains('hidden') ||
            !isTvSplitPanel(panel) || !previewCard?.isConnected) return null;

        panel.scrollTop = 0;
        for (const selector of selectors) {
            const target = [...panel.querySelectorAll(selector)]
                .find((el) => !el.disabled && isVisible(el));
            if (target) return target;
        }
        return null;
    }

    function findVerticalScroller(start, direction) {
        const page = activePage();
        if (!page) return null;

        let el = start && page.contains(start) ? start : page;
        while (el && el !== document.body && el !== document.documentElement) {
            const style = getComputedStyle(el);
            const canScrollY = /(auto|scroll)/.test(style.overflowY);
            const hasRoom = el.scrollHeight > el.clientHeight + 2;
            const canMove = direction === 'ArrowDown'
                ? el.scrollTop < el.scrollHeight - el.clientHeight - 2
                : el.scrollTop > 2;

            if (canScrollY && hasRoom && canMove) return el;
            el = el.parentElement;
        }

        const canMovePage = direction === 'ArrowDown'
            ? page.scrollTop < page.scrollHeight - page.clientHeight - 2
            : page.scrollTop > 2;
        return canMovePage ? page : null;
    }

    // D-pad "burst" detection. A held key on Android TV WebView emits discrete
    // keydowns (KeyboardEvent.repeat is unreliable), and every move calls
    // scrollIntoView/scrollBy. With behavior:'smooth' each press restarts an
    // animation before the previous settles, so the weak GPU animates continuously
    // and focus feels laggy. While presses arrive rapidly we scroll INSTANTLY
    // ('auto') so there is no animation to stack; an isolated, deliberate press
    // still gets the polished 'smooth'. navBurst is refreshed on each arrow keydown.
    let lastNavKeyAt = 0;
    let lastNavMoveAt = 0;
    let navBurst = false;
    let lastNavDirection = null;
    let lastNavDirectionReleased = true;
    const NAV_BURST_MS = 250;
    // Held-key rate cap: while a direction is held the OS repeats keydown ~25-40x/s.
    // The full pipeline is bounded to ~12 moves/s; over-fast repeats are replayed
    // once at the trailing edge instead of being silently lost.
    const NAV_THROTTLE_MS = 80;
    let queuedNavRepeat = null;
    let queuedNavRepeatTimer = null;
    function navScrollBehavior() { return navBurst ? 'auto' : 'smooth'; }

    // A fast change of direction is a distinct command, not a held-key repeat.
    // Android TV WebView does not reliably set KeyboardEvent.repeat, so use the
    // absence of an intervening keyup plus the same direction as the repeat signal.
    function isHeldNavRepeat(direction, previousDirection, previousReleased, burst) {
        return burst && direction === previousDirection && !previousReleased;
    }

    // Coalesce an over-fast held-key burst into one trailing command rather than
    // dropping it. Weak TV hardware keeps a bounded layout rate while the final
    // viewer intent is still applied after the current frame budget clears.
    function queueHeldNavRepeat(direction, delayMs) {
        if (queuedNavRepeat === direction && queuedNavRepeatTimer) return;
        if (queuedNavRepeatTimer) clearTimeout(queuedNavRepeatTimer);
        queuedNavRepeat = direction;
        queuedNavRepeatTimer = setTimeout(() => {
            const key = queuedNavRepeat;
            queuedNavRepeat = null;
            queuedNavRepeatTimer = null;
            if (!key) return;
            const replay = new KeyboardEvent('keydown', {
                key,
                bubbles: true,
                cancelable: true
            });
            Object.defineProperty(replay, '__norvaQueuedNav', { value: true });
            document.dispatchEvent(replay);
        }, Math.max(0, delayMs));
    }

    function cancelQueuedNavRepeat(exceptDirection = null) {
        if (!queuedNavRepeatTimer || queuedNavRepeat === exceptDirection) return;
        clearTimeout(queuedNavRepeatTimer);
        queuedNavRepeatTimer = null;
        queuedNavRepeat = null;
    }

    function scrollActivePage(direction, focused = null) {
        const target = findVerticalScroller(focused, direction);
        if (!target) return false;

        const amount = Math.max(220, Math.round(target.clientHeight * 0.65));
        const top = direction === 'ArrowDown' ? amount : -amount;
        const before = target.scrollTop;
        target.scrollBy({ top, behavior: navScrollBehavior() });

        return target.scrollHeight > target.clientHeight && (
            direction === 'ArrowDown'
                ? before < target.scrollHeight - target.clientHeight
                : before > 0
        );
    }

    // Catalogue Up is conventional and deterministic: it walks the grid, then
    // enters the immediately preceding semantic band in one command.

    // The Movies/Series filter row nearest the card's column, used as a safe
    // fallback when optional toolbar/Continue bands are absent.
    function catalogFilterTarget(fromEl) {
        const rows = catalogFilterRows();
        return nearestCatalogFilterItem(rows[rows.length - 1]?.items || [], fromEl);
    }

    // Nearest VISIBLE card above `card` within its grid — lets UP walk up the visible rows before
    // the scroll step. Prefers the same column, then the nearest row.
    // Movies/Series filter controls form two explicit D-pad rows. Generic spatial
    // scoring is deliberately NOT used inside or between those rows: controls with
    // different widths (notably Any Time -> Favorites) can otherwise become a dead
    // end in older Android WebViews. DOM order is the visual left-to-right order.
    function catalogFilterRows() {
        const page = activePage();
        if (!page || (page.id !== 'page-movies' && page.id !== 'page-series')) return [];
        const selector = page.id === 'page-series'
            ? '.tv-series-filter-row'
            : '.tv-movies-filter-row';
        return [...page.querySelectorAll(selector)]
            .filter(isRendered)
            .map((row) => ({
                row,
                items: [...row.querySelectorAll(INTERACTIVE_SELECTOR)].filter((el) =>
                    isRendered(el))
            }))
            .filter(({ items }) => items.length);
    }

    function nearestCatalogFilterItem(items, fromEl) {
        if (!items?.length || !fromEl) return null;
        const fromX = centerOf(fromEl).x;
        return items.reduce((best, item) => {
            const distance = Math.abs(centerOf(item).x - fromX);
            return distance < best.distance ? { item, distance } : best;
        }, { item: items[0], distance: Infinity }).item;
    }

    function catalogFilterStep(focused, direction) {
        if (!focused) return null;
        const rows = catalogFilterRows();
        const rowIndex = rows.findIndex(({ row }) => row.contains(focused));
        if (rowIndex < 0) return null;
        const itemIndex = rows[rowIndex].items.indexOf(focused);
        if (itemIndex < 0) return null;

        if (direction === 'ArrowRight') {
            return rows[rowIndex].items[itemIndex + 1] || null;
        }
        if (direction === 'ArrowLeft') {
            return rows[rowIndex].items[itemIndex - 1] || null;
        }
        if (direction === 'ArrowDown' && rowIndex < rows.length - 1) {
            return nearestCatalogFilterItem(rows[rowIndex + 1].items, focused);
        }
        if (direction === 'ArrowUp' && rowIndex > 0) {
            return nearestCatalogFilterItem(rows[rowIndex - 1].items, focused);
        }
        return null;
    }

    function catalogRegionItems(container, selector = INTERACTIVE_SELECTOR) {
        if (!container || !isRendered(container)) return [];
        return [...container.querySelectorAll(selector)].filter(isRendered);
    }

    // Semantic Movies/Series bands in their visual order. Controls are moved
    // into these hosts by the catalogue pages, so the graph remains stable when
    // chips appear/disappear or Continue Watching is temporarily empty.
    function catalogGraphRegions() {
        const page = activePage();
        if (!page || (page.id !== 'page-movies' && page.id !== 'page-series')) return [];
        const kind = page.id === 'page-series' ? 'series' : 'movies';
        const filterRows = catalogFilterRows();
        const search = page.querySelector(`#${kind}-search`);
        const toolbar = page.querySelector(`#${kind}-tv-catalog-head`);
        const continueRow = page.querySelector(`#${kind}-continue`);
        const grid = page.querySelector(`#${kind}-grid`);
        const cardSelector = kind === 'series'
            ? '.series-card'
            : MOVIE_CATALOG_CARD_SELECTOR;
        const stateSelector = kind === 'series'
            ? '[data-series-retry], #series-empty-reset'
            : '[data-movies-retry], #movies-empty-reset';
        const gridItems = catalogRegionItems(grid, cardSelector);
        // Error/empty CTAs replace the grid as a real semantic band. Never add
        // this stop while cards are available, even if a stale state node is
        // still mounted during a catalogue refresh.
        const stateItems = gridItems.length ? [] : catalogRegionItems(grid, stateSelector);

        return [
            { name: 'header', items: search && isRendered(search) ? [search] : [] },
            { name: 'primary', items: filterRows[0]?.items || [] },
            { name: 'secondary', items: filterRows[1]?.items || [] },
            { name: 'continue', items: catalogRegionItems(continueRow, '.continue-card') },
            // Continue Watching is visually above the catalogue heading. Keeping
            // this same order in the semantic graph prevents Down from jumping
            // past the rail to a chip below it, then back upward on the next press.
            { name: 'toolbar', items: catalogRegionItems(toolbar) },
            { name: 'state', items: stateItems },
            { name: 'grid', items: gridItems }
        ].filter(({ items }) => items.length);
    }

    // Pure ordered-band step used by the DOM adapter below and by behavioural
    // contract tests. Vertical moves preserve the nearest x-coordinate; horizontal
    // moves follow the visual DOM order inside one semantic band.
    function catalogRegionStep(regions, focused, direction) {
        if (!focused || !Array.isArray(regions)) return null;
        const regionIndex = regions.findIndex(({ items }) => items.includes(focused));
        if (regionIndex < 0) return null;
        const region = regions[regionIndex];
        const itemIndex = region.items.indexOf(focused);

        if (direction === 'ArrowLeft') {
            return region.items[itemIndex - 1] || null;
        }
        if (direction === 'ArrowRight') {
            return region.items[itemIndex + 1] || null;
        }
        const step = direction === 'ArrowUp' ? -1 : direction === 'ArrowDown' ? 1 : 0;
        if (!step) return null;
        const destination = regions[regionIndex + step];
        return destination
            ? nearestCatalogFilterItem(destination.items, focused)
            : null;
    }

    function catalogGraphMove(focused, direction) {
        const regions = catalogGraphRegions();
        const region = regions.find(({ items }) => items.includes(focused));
        if (!region) return { handled: false, target: null };

        // Filter-row Left/Right and their direct inter-row moves are owned by
        // catalogFilterStep so Sources <-> Categories remains an explicit pair.
        if ((region.name === 'primary' || region.name === 'secondary') &&
            (direction === 'ArrowLeft' || direction === 'ArrowRight')) {
            return { handled: false, target: null };
        }

        if (region.name === 'grid') {
            if (direction === 'ArrowUp') {
                return {
                    handled: true,
                    target: gridCardAbove(focused)
                        || catalogRegionStep(regions, focused, direction)
                        || catalogFilterTarget(focused)
                };
            }
            if (direction === 'ArrowDown') {
                return { handled: true, target: gridCardBelow(focused) };
            }
            return { handled: false, target: null };
        }

        if (region.name === 'primary' && direction === 'ArrowUp') {
            const target = catalogRegionStep(regions, focused, direction);
            if (target) catalogHeaderOrigins.set(target, focused);
            return { handled: true, target };
        }

        if (region.name === 'header' && direction === 'ArrowDown') {
            const primary = regions.find(({ name }) => name === 'primary');
            const origin = catalogHeaderOrigins.get(focused);
            return {
                handled: true,
                target: origin && primary?.items.includes(origin)
                    ? origin
                    : primary?.items[0] || catalogRegionStep(regions, focused, direction)
            };
        }

        if (direction === 'ArrowUp' || direction === 'ArrowDown') {
            // A missing destination is an intentional boundary no-op. Do not let
            // generic geometry leak Up from the primary filters into the menu.
            return { handled: true, target: catalogRegionStep(regions, focused, direction) };
        }

        // A degraded catalogue has one deliberate action. Keep horizontal
        // presses stable instead of allowing geometry to escape to the rail or
        // another unrelated control.
        if (region.name === 'header' || region.name === 'state') {
            return { handled: true, target: null };
        }

        if (region.name === 'toolbar' || region.name === 'continue') {
            const target = catalogRegionStep(regions, focused, direction);
            if (target) return { handled: true, target };
            // End of a horizontal Continue Watching rail is a stable no-op.
            if (region.name === 'continue' && direction === 'ArrowRight') {
                return { handled: true, target: null };
            }
            return { handled: false, target: null };
        }
        return { handled: false, target: null };
    }

    function catalogSearchVerticalTarget(focused, direction) {
        const page = activePage();
        const isSearch = (page?.id === 'page-movies' && focused?.id === 'movies-search') ||
            (page?.id === 'page-series' && focused?.id === 'series-search');
        if (!isSearch) return null;
        if (direction === 'ArrowUp') return activeNavbarTarget();
        if (direction === 'ArrowDown') return catalogGraphMove(focused, direction).target;
        return null;
    }

    function gridCardAbove(card) {
        const grid = card?.closest?.('.movies-grid, .series-grid');
        if (!grid) return null;
        const from = centerOf(card);
        let best = null, bestScore = Infinity;
        for (const c of grid.querySelectorAll(CATALOG_CARD_SELECTOR)) {
            if (c === card) continue;
            // One rect per card: derive BOTH the visibility test and the center from a
            // single getBoundingClientRect, instead of isVisible()+centerOf() each
            // reading their own rect (halves the layout reads across the whole grid).
            if (!c.offsetParent && c.offsetWidth === 0 && c.offsetHeight === 0) continue;
            const r = c.getBoundingClientRect();
            if (!isVisibleRect(r)) continue;
            const px = r.left + r.width / 2;
            const py = r.top + r.height / 2;
            const dy = from.y - py;                             // > 0 when c is above
            if (dy <= 4) continue;
            const score = dy + Math.abs(px - from.x) * 3;       // same column first, nearest row
            if (score < bestScore) { bestScore = score; best = c; }
        }
        return best;
    }

    function gridCardBelow(card) {
        const grid = card?.closest?.('.movies-grid, .series-grid');
        if (!grid) return null;
        const from = centerOf(card);
        let best = null, bestScore = Infinity;
        for (const candidate of grid.querySelectorAll(CATALOG_CARD_SELECTOR)) {
            if (candidate === card) continue;
            if (!candidate.offsetParent && candidate.offsetWidth === 0 && candidate.offsetHeight === 0) continue;
            const rect = candidate.getBoundingClientRect();
            if (!isVisibleRect(rect)) continue;
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const dy = y - from.y;
            if (dy <= 4) continue;
            const score = dy + Math.abs(x - from.x) * 3;
            if (score < bestScore) { bestScore = score; best = candidate; }
        }
        return best;
    }

    const modalFocusOrigins = new WeakMap();

    function scopeEntryTarget(scope) {
        if (!scope) return null;
        const safeCancel = scope.querySelector('.norva-modal-cancel:not([disabled])');
        return (safeCancel && isRendered(safeCancel) ? safeCancel : null)
            || [...scope.querySelectorAll(
                '#movie-primary-action:not([disabled]), #series-primary-action:not([disabled]), ' +
                '.tv-select-option.selected, .multi-select-actions [data-action="all"]'
            )].find(isRendered)
            || [...scope.querySelectorAll(
                'input:not([type="hidden"]), textarea, select, button:not([disabled]), a[href], [tabindex]'
            )].find(isRendered)
            || null;
    }

    function rememberModalOrigin(modal, origin = document.activeElement) {
        if (!modal || modalFocusOrigins.has(modal)) return;
        if (!origin || origin === document.body || modal.contains(origin)) {
            origin = pageFocusMemory.get(activePage()?.id)?.element || null;
        }
        if (origin && origin !== document.body && !modal.contains(origin)) {
            modalFocusOrigins.set(modal, origin);
        }
    }

    function scheduleModalFocusRestore(modal) {
        if (!modal) return;
        const restoreId = modal.dataset?.restoreFocus;
        const declared = restoreId ? document.getElementById(restoreId) : null;
        const origin = declared || modalFocusOrigins.get(modal) || null;
        setTimeout(() => {
            const top = openModal();
            const active = currentFocus();
            // Respect focus explicitly restored by the modal's own close handler.
            if (active && (!top || top.contains(active)) && !modal.contains(active)) return;
            const target = origin && isRendered(origin) && (!top || top.contains(origin))
                ? origin
                : null;
            if (target) {
                focusElement(target);
            } else if (!top) {
                ensurePageFocus();
            }
        }, 0);
    }

    /** Close the topmost open modal, running the app's own close handler. */
    function closeTopModal() {
        const modal = openModal();
        if (!modal) return false;
        // The trailer lightbox dismisses via its own ✕ (removes the node + its key listener).
        if (modal.classList.contains('trailer-lightbox')) {
            const x = modal.querySelector('.trailer-lightbox-close');
            if (x) { x.click(); } else { modal.remove(); }
            scheduleModalFocusRestore(modal);
            return true;
        }
        // NorvaModal dialogs (.norva-modal-overlay) are promise-based: their buttons are
        // wired with addEventListener and the dialog dismisses by REMOVING its node (there
        // is no `active` class to strip, and no `.onclick`). Click Cancel — else Confirm/OK
        // for a single-button alert — so the pending Promise resolves (false / true) and the
        // overlay tears itself down. Stripping a class here would orphan a full-screen veil.
        if (modal.classList.contains('norva-modal-overlay')) {
            const btn = modal.querySelector('.norva-modal-cancel') || modal.querySelector('.norva-modal-confirm');
            if (btn) {
                btn.click();
                scheduleModalFocusRestore(modal);
                return true;
            }
        }
        const closeBtn = modal.querySelector('.modal-close, #modal-cancel');
        if (closeBtn) {
            try { closeBtn.click(); } catch (e) { /* fall through only if it stayed open */ }
            // addEventListener-based close handlers commonly remove the overlay or
            // deactivate it synchronously. Never mutate that already-closed node:
            // doing so bypassed cleanup bookkeeping and could leave display:grid
            // notification overlays visible but outside navScope.
            if (!modal.isConnected || !modal.matches(MODAL_SELECTOR)) {
                scheduleModalFocusRestore(modal);
                return true;
            }
        }
        // Legacy overlays without a close handler still use the active-class
        // fallback. It is safe only while the same node remains an open scope.
        if (modal.isConnected && modal.matches(MODAL_SELECTOR)) {
            modal.classList.remove('active');
        }
        // Prefer an explicit data-restore-focus target, then the captured opener.
        scheduleModalFocusRestore(modal);
        return true;
    }

    /**
     * Close the topmost open transient that isn't a modal: a category multi-select
     * panel, else a Movies/Series detail view (returns to its grid via the back
     * button). Lets BACK/Escape unwind these the way it already unwinds modals.
     */
    function closeTransient() {
        const panel = lastVisible('.multi-select-panel:not(.hidden)');
        if (panel) {
            const btn = panel.closest('.multi-select')?.querySelector('.multi-select-btn');
            if (typeof panel.__norvaMultiSelectClose === 'function') {
                panel.__norvaMultiSelectClose({ restoreFocus: false });
            } else {
                // Legacy/fallback panels still need the complete disclosure state,
                // not just the visual class.
                panel.classList.add('hidden');
                panel.setAttribute('aria-hidden', 'true');
                panel.inert = true;
                btn?.setAttribute('aria-expanded', 'false');
            }
            if (btn) focusElement(btn);
            return true;
        }
        // A TV catalogue preview is persistent. Back from its controls returns to
        // the selected poster instead of hiding the panel or navigating Home.
        const tvMoviePanel = document.querySelector('#page-movies.active #movie-details');
        const tvSeriesPanel = document.querySelector('#page-series.active #series-tv-preview');
        const tvPanel = [tvMoviePanel, tvSeriesPanel].find(isTvSplitPanel) || null;
        const active = document.activeElement;
        if (tvPanel && active && tvPanel.contains(active)) {
            const page = tvPanel.closest('.page');
            const grid = page?.querySelector('.movies-grid, .series-grid');
            const cards = [...(grid?.querySelectorAll(CATALOG_CARD_SELECTOR) || [])];
            const usable = card => Boolean(
                card?.isConnected &&
                !card.closest('.hidden, [hidden]') &&
                (card.offsetWidth > 0 || card.offsetHeight > 0)
            );
            const preview = grid?.querySelector(
                '.movie-card.tv-preview-active, .dashboard-card.tv-preview-active, ' +
                '.series-card.tv-preview-active'
            );
            const target = usable(preview)
                ? preview
                : (cards.find(isVisible) || cards.find(usable));
            if (target) focusElement(target);
            return true;
        }
        const details = lastVisible('#movie-details:not(.hidden), #series-details:not(.hidden)');
        if (details && !isTvSplitPanel(details)) {
            const back = details.querySelector('.movie-back-btn, .series-back-btn');
            if (back) { back.click(); return true; }
        }
        return false;
    }

    function centerOf(el) {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    function hasMeaningfulVerticalOverlap(a, b, ratio = 0.25) {
        if (!a || !b) return false;
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const overlap = Math.max(0, Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top));
        return overlap >= Math.min(ar.height, br.height) * ratio;
    }

    /**
     * Closest candidate in the pressed direction, with a strong penalty on
     * perpendicular drift so rows/columns feel natural.
     */
    function findNext(current, direction) {
        const from = centerOf(current);
        let best = null;
        let bestScore = Infinity;

        // Reuse the rect measured in getCandidatesWithRects (one read per element)
        // and inline centerOf here so we don't force a second layout read. Same
        // candidate set, same arithmetic, same iteration order → same result.
        const { els, rects } = getCandidatesWithRects();
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            if (el === current) continue;
            const r = rects[i];
            const dx = (r.left + r.width / 2) - from.x;
            const dy = (r.top + r.height / 2) - from.y;

            let forward, lateral;
            if (direction === 'ArrowRight') { forward = dx; lateral = Math.abs(dy); }
            else if (direction === 'ArrowLeft') { forward = -dx; lateral = Math.abs(dy); }
            else if (direction === 'ArrowDown') { forward = dy; lateral = Math.abs(dx); }
            else { forward = -dy; lateral = Math.abs(dx); }

            if (forward <= 4) continue; // not in that direction
            const score = forward + lateral * 2.5;
            if (score < bestScore) {
                bestScore = score;
                best = el;
            }
        }
        return best;
    }

    // Nearest candidate strictly BELOW `from` that lives in the rail (.navbar), chosen
    // by vertical position only (ignoring findNext's lateral penalty). In tv-mode the
    // rail packs nav-links at the top and the utility cluster (search / bell / profile)
    // at the very bottom with a large flex gap between; findNext's forward+lateral*2.5
    // score lets a nearby content card out-rank the distant utility button, so a plain
    // Down would skip the cluster and dive into content. This walks the rail by geometry.
    function navbarCandidateBelow(from) {
        const fromBottom = from.getBoundingClientRect().bottom;
        const { els, rects } = getCandidatesWithRects();
        let best = null;
        let bestTop = Infinity;
        for (let i = 0; i < els.length; i++) {
            if (els[i] === from || !els[i].closest('.navbar')) continue;
            const top = rects[i].top;
            if (top > fromBottom - 4 && top < bestTop) { bestTop = top; best = els[i]; }
        }
        return best;
    }

    function activeNavbarTarget() {
        const active = document.querySelector('.navbar .nav-link.active');
        if (active && isRendered(active)) return active;
        return [...document.querySelectorAll('.navbar .nav-link')].find(isRendered) || null;
    }

    // Settings is a fixed tab strip above a separately scrolling panel. Treating
    // those controls as one all-page geometry cloud lets a Down press at the end
    // of Account jump to the bell/profile in the rail, and can skip horizontally
    // adjacent actions. Keep a small semantic graph scoped to the active panel:
    // vertical presses change visual rows, horizontal presses stay in their row,
    // and only Left at a row boundary intentionally opens the rail.
    function settingsPanelCandidates(panel, anchor = null) {
        if (!panel) return [];
        const all = [...panel.querySelectorAll(INTERACTIVE_SELECTOR)];
        const anchorIndex = anchor ? all.indexOf(anchor) : -1;
        // Manage Content can render a large tree. A bounded DOM window around
        // the current stop keeps each keypress cheap while still covering many
        // rows above/below; panel entry scans the first 400 candidates.
        const start = anchorIndex >= 0 ? Math.max(0, anchorIndex - 240) : 0;
        const end = anchorIndex >= 0
            ? Math.min(all.length, anchorIndex + 241)
            : Math.min(all.length, 400);
        return all.slice(start, end).filter((el) => {
            if (!isRendered(el)) return false;
            const style = getComputedStyle(el);
            return style.opacity !== '0' && style.visibility !== 'hidden';
        });
    }

    function settingsHorizontalTarget(current, candidates, direction) {
        if (!current || (direction !== 'ArrowLeft' && direction !== 'ArrowRight')) return null;
        const from = centerOf(current);
        let best = null;
        let bestScore = Infinity;
        for (const candidate of candidates) {
            if (candidate === current || !hasMeaningfulVerticalOverlap(current, candidate, 0.2)) continue;
            const point = centerOf(candidate);
            const forward = direction === 'ArrowRight'
                ? point.x - from.x
                : from.x - point.x;
            if (forward <= 4) continue;
            const score = forward + Math.abs(point.y - from.y) * 2.5;
            if (score < bestScore) {
                bestScore = score;
                best = candidate;
            }
        }
        return best;
    }

    function settingsVerticalTarget(current, candidates, direction) {
        if (!current || (direction !== 'ArrowUp' && direction !== 'ArrowDown')) return null;
        const down = direction === 'ArrowDown';
        const fromRect = current.getBoundingClientRect();
        const fromX = fromRect.left + fromRect.width / 2;
        const eligible = [];

        for (let index = 0; index < candidates.length; index++) {
            const candidate = candidates[index];
            if (candidate === current) continue;
            const rect = candidate.getBoundingClientRect();
            // A vertical command changes ROWS. Controls whose rectangles overlap
            // belong to the same action row and are reached with Left/Right.
            const inDirection = down
                ? rect.top >= fromRect.bottom - 2
                : rect.bottom <= fromRect.top + 2;
            if (!inDirection) continue;
            eligible.push({ candidate, rect, index });
        }
        if (!eligible.length) return null;

        let nearestEdge = down ? Infinity : -Infinity;
        for (const { rect } of eligible) {
            nearestEdge = down
                ? Math.min(nearestEdge, rect.top)
                : Math.max(nearestEdge, rect.bottom);
        }
        // Real Settings rows can be a few pixels misaligned because buttons,
        // inline links and form controls have different heights. Keep those small
        // offsets in one row, then preserve the viewer's horizontal column.
        const row = eligible.filter(({ rect }) =>
            Math.abs((down ? rect.top : rect.bottom) - nearestEdge) <= 28);
        row.sort((a, b) => {
            const ax = a.rect.left + a.rect.width / 2;
            const bx = b.rect.left + b.rect.width / 2;
            return Math.abs(ax - fromX) - Math.abs(bx - fromX) || a.index - b.index;
        });
        return row[0]?.candidate || null;
    }

    function settingsGraphMove(focused, direction) {
        const page = activePage();
        if (!focused || page?.id !== 'page-settings' || !page.contains(focused)) {
            return { handled: false, target: null, selectTab: false, scroll: false };
        }

        const tabsHost = page.querySelector('.settings-container > .tabs');
        const tabs = tabsHost
            ? [...tabsHost.querySelectorAll('.tab')].filter(isRendered)
            : [];
        const focusedTab = focused.closest?.('.settings-container > .tabs .tab');
        if (focusedTab && tabsHost?.contains(focusedTab)) {
            const index = tabs.indexOf(focusedTab);
            if (direction === 'ArrowLeft') {
                if (index > 0) {
                    return { handled: true, target: tabs[index - 1], selectTab: true, scroll: false };
                }
                return {
                    handled: true,
                    target: activeNavbarTarget(),
                    selectTab: false,
                    scroll: false
                };
            }
            if (direction === 'ArrowRight') {
                return {
                    handled: true,
                    target: index >= 0 && index < tabs.length - 1 ? tabs[index + 1] : null,
                    selectTab: index >= 0 && index < tabs.length - 1,
                    scroll: false
                };
            }
            if (direction === 'ArrowUp') {
                return { handled: true, target: null, selectTab: false, scroll: false };
            }
            if (direction === 'ArrowDown') {
                // A focused-but-not-selected tab can only occur after external DOM
                // focus. Select it first so the tab label and panel never disagree.
                if (!focusedTab.classList.contains('active')) {
                    return { handled: true, target: focusedTab, selectTab: true, scroll: false };
                }
                const panel = page.querySelector('.tab-content.active');
                return {
                    handled: true,
                    target: settingsPanelCandidates(panel)[0] || null,
                    selectTab: false,
                    scroll: true
                };
            }
        }

        const panel = page.querySelector('.tab-content.active');
        if (!panel?.contains(focused)) {
            return { handled: false, target: null, selectTab: false, scroll: false };
        }
        const candidates = settingsPanelCandidates(panel, focused);

        if (direction === 'ArrowLeft' || direction === 'ArrowRight') {
            const target = settingsHorizontalTarget(focused, candidates, direction);
            if (target) {
                return { handled: true, target, selectTab: false, scroll: false };
            }
            if (direction === 'ArrowLeft') {
                return {
                    handled: true,
                    target: activeNavbarTarget(),
                    selectTab: false,
                    scroll: false
                };
            }
            // Right at the end of an action row is a stable no-op, never a
            // diagonal jump into another Settings row.
            return { handled: true, target: null, selectTab: false, scroll: false };
        }

        if (direction === 'ArrowUp' || direction === 'ArrowDown') {
            const target = settingsVerticalTarget(focused, candidates, direction);
            if (target) {
                return { handled: true, target, selectTab: false, scroll: false };
            }
            if (direction === 'ArrowUp') {
                const activeTab = tabs.find((tab) => tab.classList.contains('active')) || tabs[0] || null;
                return { handled: true, target: activeTab, selectTab: false, scroll: false };
            }
            // At the last visible row, remain inside Settings. scrollActivePage()
            // will advance the panel when more content exists; at the true end it
            // becomes a deliberate no-op instead of escaping to rail utilities.
            return { handled: true, target: null, selectTab: false, scroll: true };
        }

        return { handled: false, target: null, selectTab: false, scroll: false };
    }

    function focusActiveNavbar() {
        const target = activeNavbarTarget();
        if (!target) return false;
        focusElement(target);
        return true;
    }

    function focusElement(el) {
        if (!el) return;
        if (!el.hasAttribute('tabindex') &&
            !['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
            el.setAttribute('tabindex', '-1');
        }
        el.focus({ preventScroll: true });
        auditDpad('focus', el);
        // inline:'center' keeps the focused card centered as the D-pad walks a
        // horizontal rail (instead of leaving it stuck against an edge). Instant
        // during a held-key burst so overlapping smooth scrolls don't jank the TV.
        // Vertical list rows (episode lists) only need to scroll when the row is actually
        // off-screen; block:'center' re-scrolled AND repainted the whole details panel on
        // EVERY Up/Down. block:'nearest' keeps focus visible with far fewer repaints. Cards
        // and horizontal rails keep 'center' so the focused item stays framed.
        const vBlock = el.closest('.episode-item') ? 'nearest' : 'center';
        el.scrollIntoView({ block: vBlock, inline: 'center', behavior: navScrollBehavior() });
    }

    function currentFocus() {
        const el = document.activeElement;
        if (el && el !== document.body && isVisible(el)) return el;
        return null;
    }

    function isTextField(el) {
        return el && (
            (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range'].includes(el.type)) ||
            el.tagName === 'TEXTAREA'
        );
    }

    /**
     * TV replacement for the native <select> spinner: a focus-trapped overlay
     * listing the options as big remote-friendly rows. Reuses the modal plumbing
     * (`.modal-overlay.active` confines navigation; BACK/Escape closes it).
     */
    function openTvSelect(select) {
        if (!select || !select.options?.length) return;
        document.getElementById('tv-select-overlay')?.remove();
        const ov = document.createElement('div');
        ov.id = 'tv-select-overlay';
        ov.className = 'modal-overlay active tv-select-overlay';
        const label = select.getAttribute('aria-label')
            || select.closest('label')?.textContent?.trim()
            || document.querySelector(`label[for="${select.id}"]`)?.textContent?.trim()
            || 'Choose an option';
        // Keep the value shown in each row stable even if language facets refresh
        // while the overlay is open. Resolve that value against the live select on OK.
        const optionSnapshot = [...select.options];
        const rows = optionSnapshot.map((opt, i) =>
            `<button type="button" class="tv-select-option${opt.selected ? ' selected' : ''}" data-index="${i}">
                <span class="tv-select-option-label">${opt.textContent}</span>
                ${opt.selected ? '<span class="tv-select-check" aria-hidden="true">✓</span>' : ''}
            </button>`).join('');
        ov.innerHTML = `
            <div class="tv-select-panel" role="listbox" aria-label="${label.replace(/"/g, '&quot;')}">
                <div class="tv-select-title">${label}</div>
                <div class="tv-select-list">${rows}</div>
                <button type="button" class="modal-close tv-select-cancel">Cancel</button>
            </div>`;
        const close = () => { ov.remove(); focusElement(select); };
        ov.querySelector('.tv-select-cancel').onclick = close;
        ov.addEventListener('click', (ev) => { if (ev.target === ov) close(); });
        ov.querySelectorAll('.tv-select-option').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.dataset.index);
                const intendedValue = optionSnapshot[idx]?.value;
                const liveIndex = [...select.options].findIndex(option =>
                    option.value === intendedValue);
                if (intendedValue !== undefined && liveIndex >= 0) {
                    // Dispatch even when the selected index already matches: some
                    // Android WebViews expose the new index with the previous value,
                    // and a repeated choice also repairs a stale filtered catalogue.
                    select.value = intendedValue;
                    if (select.selectedIndex !== liveIndex) select.selectedIndex = liveIndex;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
                close();
            });
        });
        document.body.appendChild(ov);
        focusElement(ov.querySelector('.tv-select-option.selected') || ov.querySelector('.tv-select-option'));
    }

    function onWatchPageWithHiddenControls() {
        const watchActive = document.getElementById('page-watch')?.classList.contains('active');
        if (!watchActive) return false;
        const overlay = document.getElementById('watch-overlay');
        return !overlay || overlay.classList.contains('hidden');
    }

    document.addEventListener('keydown', (e) => {
        // Escape (some remotes / keyboards): close an open modal first
        if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
            if (closeTopModal() || closeTransient()) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        }

        const arrows = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
        const isArrow = arrows.includes(e.key);
        const isEnter = e.key === 'Enter';
        const queuedReplay = e.__norvaQueuedNav === true;
        if (!isArrow && !isEnter) return;

        let heldNavRepeat = false;

        // Refresh the held-key burst flag so this move's scroll (focusElement /
        // scrollActivePage) is instant when presses are coming fast, smooth when
        // isolated. Only arrows drive scrolling, so only they update the cadence.
        if (isArrow) {
            if (!queuedReplay) {
                cancelQueuedNavRepeat(lastNavDirectionReleased ? null : e.key);
            }
            const now = e.timeStamp || (typeof performance !== 'undefined' ? performance.now() : 0);
            navBurst = (now - lastNavKeyAt) < NAV_BURST_MS;
            heldNavRepeat = !queuedReplay && isHeldNavRepeat(
                e.key, lastNavDirection, lastNavDirectionReleased, navBurst
            );
            lastNavKeyAt = now;
            lastNavDirection = e.key;
            // A queued trailing replay has no physical keyup of its own. Keep the
            // direction released so the viewer's next real press is always distinct.
            lastNavDirectionReleased = queuedReplay;
        }

        // Start this keydown with a fresh candidate scan, and guarantee the memo is
        // dropped once the (synchronous) handler unwinds — a microtask fires before
        // any later task, so nothing outside this keypress can read stale rects.
        candCache = null;
        if (typeof queueMicrotask === 'function') queueMicrotask(() => { candCache = null; });
        else Promise.resolve().then(() => { candCache = null; });

        const focused = currentFocus();
        auditDpad(`key ${e.key}`, focused);

        // A newly opened web modal can exist for one frame before its component
        // assigns focus. Never let that timing window activate or navigate the
        // dimmed page: the first D-pad command anchors inside the topmost scope.
        const scope = navScope();
        if (scope !== document && (!focused || !scope.contains(focused))) {
            e.preventDefault();
            e.stopPropagation();
            const target = scopeEntryTarget(scope);
            if (target) focusElement(target);
            return;
        }

        // Held-key throttle (spatial nav only — text-field caret stays fully responsive).
        // A burst repeat that lands too soon after the last processed move is dropped; the
        // NEXT repeat still moves, so held-scroll keeps flowing without running the whole
        // navigation pipeline 30-40x/s on a weak TV.
        if (isArrow && heldNavRepeat && !isTextField(focused)) {
            const nowMs = (typeof performance !== 'undefined' ? performance.now() : (e.timeStamp || 0));
            if (nowMs - lastNavMoveAt < NAV_THROTTLE_MS) {
                queueHeldNavRepeat(e.key, NAV_THROTTLE_MS - (nowMs - lastNavMoveAt));
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            lastNavMoveAt = nowMs;
        } else if (isArrow) {
            lastNavMoveAt = (typeof performance !== 'undefined' ? performance.now() : (e.timeStamp || 0));
        }

        // Text fields: ←/→ move the caret and Enter submits natively, but
        // ↑/↓ leave the field via spatial navigation — except in the channel
        // search, whose own ↑/↓ result navigation must keep working.
        if (isTextField(focused)) {
            // IME composition uses synthetic arrow events (keyCode 229). Those
            // belong to the keyboard and must never trigger spatial navigation.
            if (e.isComposing || e.keyCode === 229) return;

            // Live search has an explicit rail boundary: Left at the beginning
            // always opens the menu, including while the guide is still loading.
            if (focused.id === 'channel-search' && e.key === 'ArrowLeft' &&
                (focused.selectionStart ?? 0) === 0 &&
                (focused.selectionEnd ?? 0) === 0) {
                e.preventDefault();
                e.stopPropagation();
                focusActiveNavbar();
                return;
            }

            // This module is TV-only. Down from the channel search box always steps to
            // the controls row (All Sources first, else Hide unavailable, else the
            // list / results) — so search bar → controls → results is one top-to-bottom
            // path with real focus, and the controls stay reachable whether or not a
            // query is typed. (Do NOT call focusFirstVisibleChannel — on TV its
            // fallback force-expands & persists group #1, a stored change from a pure
            // nav keypress.) The search box no longer traps ↓/↑ for a result highlight.
            if (focused.id === 'channel-search' && e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                const t = [
                    document.getElementById('source-select'),
                    document.getElementById('live-hide-broken-btn'),
                    document.querySelector('#channel-list .group-header, #channel-list .channel-item, .search-result')
                ].find(el => el && isVisible(el));
                if (t) { focusElement(t); return; }
            }
            // Global (menu) search overlay: the input has no rail behind it, so give it
            // explicit exits — Down → first result (else See-all / Cancel), Right at caret
            // end → Cancel. Mirrors the #channel-search boundary so results + Cancel become
            // D-pad-reachable instead of the input being a caret-only dead field.
            if (focused.id === 'gsearch-input') {
                const ov = document.getElementById('gsearch-overlay');
                if (e.key === 'ArrowDown') {
                    // Prefer a result, then See-all, then Cancel — by ROLE, not DOM order
                    // (.gsearch-cancel sits in the bar ABOVE the results, so a combined
                    // querySelector would wrongly pick it first).
                    const t = ov?.querySelector('.gsearch-result')
                        || ov?.querySelector('.gsearch-seeall')
                        || ov?.querySelector('.gsearch-cancel');
                    if (t && isVisible(t)) { e.preventDefault(); e.stopPropagation(); focusElement(t); return; }
                }
                const atEnd = (focused.selectionStart ?? 0) === focused.value.length
                    && (focused.selectionEnd ?? 0) === focused.value.length;
                if (e.key === 'ArrowRight' && atEnd) {
                    const cancel = ov?.querySelector('.gsearch-cancel');
                    if (cancel && isVisible(cancel)) { e.preventDefault(); e.stopPropagation(); focusElement(cancel); return; }
                }
            }
            // An OPEN searchable combobox (RegionPicker) drives its own listbox with
            // Up/Down/Enter/Home/End while the search input keeps focus (via
            // aria-activedescendant). Spatial nav must not touch those keys —
            // preventDefault/stopPropagation would kill the combobox's own keydown AND
            // move focus out of the container, tripping its focusout-to-close. Hand the
            // whole key back to the input's handler.
            const rpPop = focused.closest?.('[data-region-picker]')?.querySelector('[data-region-pop]');
            if (rpPop && !rpPop.hidden) return;

            const isCatalogSearch = (focused.id === 'movies-search' && activePage()?.id === 'page-movies') ||
                (focused.id === 'series-search' && activePage()?.id === 'page-series');

            // At the beginning of a catalogue search field, Left leaves the page
            // for the rail instead of becoming an empty caret move.
            if (!e.repeat && isCatalogSearch && e.key === 'ArrowLeft' &&
                (focused.selectionStart ?? 0) === 0 && (focused.selectionEnd ?? 0) === 0) {
                const active = document.querySelector('.navbar .nav-link.active');
                const railTarget = (active && isVisible(active))
                    ? active
                    : [...document.querySelectorAll('.navbar .nav-link')].find(isVisible);
                if (railTarget) {
                    e.preventDefault();
                    e.stopPropagation();
                    focusElement(railTarget);
                    return;
                }
            }

            // Symmetric boundary: Right at the end of search enters the
            // docked fiche instead of remaining an inert caret press.
            if (!e.repeat && isCatalogSearch && e.key === 'ArrowRight' &&
                (focused.selectionStart ?? 0) === focused.value.length &&
                (focused.selectionEnd ?? 0) === focused.value.length) {
                const panelTarget = tvSplitPanelEntryTarget();
                if (panelTarget) {
                    e.preventDefault();
                    e.stopPropagation();
                    focusElement(panelTarget);
                    return;
                }
            }

            // Avoid the generic all-page geometry scan from catalogue Search. A
            // direct target stays instant even with a very large catalogue.
            if (isCatalogSearch &&
                (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                e.preventDefault();
                e.stopPropagation();
                let target = catalogSearchVerticalTarget(focused, e.key);
                if (e.key === 'ArrowDown') {
                    // Before the TV page finishes arranging its semantic bands,
                    // retain a safe first-filter/card fallback. Once ready, the
                    // graph restores the exact primary filter that opened Search.
                    if (!target) {
                        const series = focused.id === 'series-search';
                        const row = document.getElementById(series
                            ? 'series-tv-primary-filters'
                            : 'movies-tv-primary-filters');
                        target = [...(row?.querySelectorAll(INTERACTIVE_SELECTOR) || [])]
                            .find(el => !el.disabled && isVisible(el));
                    }
                    if (!target) {
                        const series = focused.id === 'series-search';
                        target = [...document.querySelectorAll(series
                            ? '#series-grid .series-card'
                            : '#movies-grid .movie-card')]
                            .find(isVisible);
                    }
                } else if (!target) {
                    const activeNav = document.querySelector('.navbar .nav-link.active');
                    target = (activeNav && isVisible(activeNav))
                        ? activeNav
                        : [...document.querySelectorAll('.navbar .nav-link')].find(isVisible);
                }
                if (target) focusElement(target);
                return;
            }

            // Only ←/→ (caret) and Enter stay with the input; ↑ leaves via spatial nav.
            // (On phone the input keeps ↑/↓ for its own highlight nav — but this module
            // never runs there.)
            if (isEnter || e.key === 'ArrowLeft' || e.key === 'ArrowRight') return;
        }
        // <select>: arrows navigate away (never trapped); Enter opens a custom
        // full-screen option list instead of the WebView's tiny native spinner.
        if (focused?.tagName === 'SELECT' && isEnter) {
            e.preventDefault();
            e.stopPropagation();
            openTvSelect(focused);
            return;
        }

        // SeriesPage owns Left/Right on season tabs because moving focus must also
        // activate the season and repaint the episode list. Let that target handler
        // receive the event instead of swallowing it in capture-phase spatial nav.
        if (focused?.matches?.('.season-tab') &&
            (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            return;
        }

        // Fullscreen playback with hidden controls: arrows belong to the
        // player (skip/volume); Enter just brings the controls back
        if (onWatchPageWithHiddenControls()) {
            if (isEnter) {
                document.querySelector('.watch-video-section')
                    ?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
                e.preventDefault();
                e.stopPropagation();
            }
            return;
        }

        if (isEnter) {
            if (focused) {
                e.preventDefault();
                e.stopPropagation();
                focused.click();
            }
            return;
        }

        // Spatial move
        e.preventDefault();
        e.stopPropagation(); // keep LivePage zapping & co. out of TV navigation

        if (!focused) {
            // Nothing focused: prefer restoring the remembered card (focus lost
            // to a re-render or a native-player round-trip keeps its position),
            // else its nearest surviving neighbor, else enter the active page.
            const page = activePage();
            if (lastFocusedCard && lastFocusedPageId === page?.id &&
                page.contains(lastFocusedCard) && isVisible(lastFocusedCard)) {
                focusElement(lastFocusedCard);
                return;
            }
            const pageCandidates = getPageCandidates();
            const anchored = lastFocusedPageId === page?.id ? nearestToLastRect(pageCandidates) : null;
            const first = anchored || (e.key === 'ArrowUp'
                ? pageCandidates[pageCandidates.length - 1]
                : pageEntryTarget(page));
            focusElement(first || firstNonTextCandidate(getCandidates()) || null);
            return;
        }

        // Settings owns a fixed tab strip + one scrolling panel. Keep all four
        // directions inside that semantic graph once focus has entered the page;
        // rail traversal remains unchanged while focus is still in .navbar.
        const settingsMove = settingsGraphMove(focused, e.key);
        if (settingsMove.handled) {
            if (settingsMove.selectTab && settingsMove.target) {
                settingsMove.target.click();
            }
            if (settingsMove.target) {
                focusElement(settingsMove.target);
            } else if (settingsMove.scroll) {
                scrollActivePage(e.key, focused);
            }
            return;
        }

        // The two catalogue filter bands are a deterministic control graph, not a
        // loose cloud of rectangles. This handles all four arrows inside/between the
        // rows; boundary presses intentionally fall through to the rail, content, or
        // split-panel rules below.
        if (navScope() === document &&
            (activePage()?.id === 'page-movies' || activePage()?.id === 'page-series')) {
            const filterStep = catalogFilterStep(focused, e.key);
            if (filterStep) {
                focusElement(filterStep);
                return;
            }
            const graphMove = catalogGraphMove(focused, e.key);
            if (graphMove.handled) {
                if (graphMove.target) {
                    focusElement(graphMove.target);
                } else if (focused.matches?.(CATALOG_CARD_SELECTOR) &&
                    (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                    scrollActivePage(e.key, focused);
                }
                return;
            }
        }

        if (e.key === 'ArrowDown' && focused.closest('.navbar')) {
            // Left rail (TV): walk the vertical rail top-to-bottom by GEOMETRY, so the
            // bottom utility cluster (Search / bell / profile) stays reachable across the
            // flex gap that findNext's lateral-weighted score would otherwise skip (a
            // nearby content card could out-rank the distant Search button). Only dive
            // into the content grid when there is genuinely no rail item below (last item,
            // or a horizontal top bar where nothing shares the column).
            const belowInNav = navbarCandidateBelow(focused);
            if (belowInNav) {
                focusElement(belowInNav);
                return;
            }
            const firstPageCandidate = pageEntryTarget(activePage());
            if (firstPageCandidate) {
                focusElement(firstPageCandidate);
                return;
            }
        }

        // The navbar is the physical left edge of the TV interface. A Settings
        // tab strip can be horizontally scrolled after visiting an advanced tab,
        // leaving an off-screen tab geometrically "left" of the rail. Without an
        // explicit boundary, another Left press re-entered that hidden strip.
        // Keep Left on the rail as a stable no-op; Right is the sole page entry.
        if (e.key === 'ArrowLeft' && focused.closest('.navbar')) {
            return;
        }

        // Right from the rail crosses into the page content. findNext normally finds a
        // card to the right; when the page is still empty/loading it returns null and
        // Right would be a silent no-op (the scroll fallback at the end only handles
        // Up/Down). Fall back to the page's default target so Right is never dead —
        // mirroring the ArrowDown dive above.
        if (e.key === 'ArrowRight' && focused.closest('.navbar')) {
            // Returning from the active section's rail restores its exact content
            // stop. This precedes geometry so an aligned far-right control cannot
            // steal entry (the Settings -> Transcoding regression).
            if (focused.matches?.('.nav-link.active')) {
                const entry = pageEntryTarget(activePage());
                if (entry) {
                    focusElement(entry);
                    return;
                }
            }
            const rightNext = findNext(focused, 'ArrowRight');
            if (rightNext) {
                focusElement(rightNext);
                return;
            }
            const target = pageEntryTarget(activePage());
            if (target) {
                focusElement(target);
                return;
            }
        }

        // Movies/Series TV: catalogFilterStep above owns the two filter rows. This
        // fallback keeps toolbar chips/sort walking horizontally and bridges the
        // right edge of any catalogue control band to the docked preview CTA.
        if (e.key === 'ArrowRight' &&
            (activePage()?.id === 'page-movies' || activePage()?.id === 'page-series') &&
            navScope() === document) {
            const regionName = activePage()?.id === 'page-series' ? 'series-filters' : 'movies-filters';
            const filterRegion = focused.closest?.(
                `[data-tv-nav-region="${regionName}"], .tv-movies-filter-row, .tv-series-filter-row`
            );
            if (filterRegion) {
                const from = centerOf(focused);
                let nextInRegion = null;
                let bestScore = Infinity;
                for (const candidate of getCandidates()) {
                    if (candidate === focused || !filterRegion.contains(candidate) ||
                        !hasMeaningfulVerticalOverlap(focused, candidate, 0.5)) continue;
                    const point = centerOf(candidate);
                    const forward = point.x - from.x;
                    if (forward <= 4) continue;
                    const score = forward + Math.abs(point.y - from.y) * 2.5;
                    if (score < bestScore) {
                        bestScore = score;
                        nextInRegion = candidate;
                    }
                }

                if (nextInRegion) {
                    focusElement(nextInRegion);
                    return;
                }

                const panelTarget = tvSplitPanelEntryTarget();
                if (panelTarget) {
                    focusElement(panelTarget);
                    return;
                }
            }
        }

        // Live TV (TV) is 3 columns: rail | .channel-sidebar | .player-section.
        // ArrowLeft from the player column (a channel row or a preview action button)
        // should return to a MEANINGFUL sidebar target — the active channel, else the
        // category header nearest the focused row's screen-y, else the search box — not
        // the arbitrary same-screen-y node (often an invisible heart) that pure findNext
        // would pick. Runs BEFORE the rail guard so the sidebar wins; the rail stays one
        // further Left press away (column-hop).
        if (e.key === 'ArrowLeft' && focused.closest('.player-section')) {
            const sb = document.querySelector('.channel-sidebar');
            if (sb) {
                let target = sb.querySelector('.channel-item.active, .channel-item.nav-active, .channel-item.playing');
                if (!target) {
                    const y = centerOf(focused).y;
                    const heads = [...sb.querySelectorAll('.group-header')].filter(isVisible);
                    if (heads.length) {
                        target = heads.reduce((b, h) => {
                            const d = Math.abs(centerOf(h).y - y);
                            return d < b.d ? { el: h, d } : b;
                        }, { el: heads[0], d: Infinity }).el;
                    }
                }
                if (!target) target = sb.querySelector('#channel-search');
                if (target) { focusElement(target); return; }
            }
        }

        // Live TV loading/empty states still expose a guaranteed path to the rail.
        // From a full-width list row, or from the first available header control,
        // Left is semantic "open menu" rather than a diagonal geometry move.
        if (e.key === 'ArrowLeft' && focused.closest('#page-live .channel-sidebar')) {
            const controls = [
                document.getElementById('source-select'),
                document.getElementById('toggle-groups'),
                document.getElementById('live-hide-broken-btn')
            ].filter(isRendered);
            const listRow = focused.matches?.('.group-header, .channel-item, .search-result');
            if (listRow || focused === controls[0]) {
                if (focusActiveNavbar()) return;
            }
        }

        // Catalogue split-view is 3 columns: rail | grid | preview panel. ArrowLeft
        // from INSIDE the panel returns to the grid — the card that
        // opened the preview (marked .tv-preview-active) if it's still on screen, else
        // the grid card nearest the focused control's screen-y — instead of letting
        // findNext strand focus in the tall scrolling panel or jump to the rail. A
        // control that HAS a panel neighbour to its left (e.g. Favorite ← Play) falls
        // through to the generic handler, which steps to that neighbour.
        const splitPanel = focused.closest?.('#movie-details, #series-tv-preview');
        if (e.key === 'ArrowLeft' && isTvSplitPanel(splitPanel)) {
            const panel = splitPanel;
            const leftInPanel = findNext(focused, 'ArrowLeft');
            const realPanelNeighbour = leftInPanel && panel.contains(leftInPanel) &&
                hasMeaningfulVerticalOverlap(focused, leftInPanel);
            if (!realPanelNeighbour) {
                const grid = panel.closest('.page')?.querySelector('.movies-grid, .series-grid');
                if (grid) {
                    let target = grid.querySelector(
                        '.movie-card.tv-preview-active, .dashboard-card.tv-preview-active, ' +
                        '.series-card.tv-preview-active'
                    );
                    if (!target || !isVisible(target)) {
                        const origin = centerOf(focused);
                        const y = origin.y;
                        const cards = [...grid.querySelectorAll(CATALOG_CARD_SELECTOR)].filter(isVisible);
                        target = cards.length
                            ? cards.reduce((b, c) => {
                                const cc = centerOf(c);
                                const d = Math.abs(cc.y - y) * 3 + Math.abs(cc.x - origin.x);
                                return d < b.d ? { el: c, d } : b;
                            }, { el: cards[0], d: Infinity }).el
                            : null;
                    }
                    if (target) { focusElement(target); return; }
                }
            }
        }

        // Movies/Series grid + Continue rail (TV): ArrowLeft from a LEFT-EDGE tile (no
        // tile to its left on the same row) opens the rail — otherwise findNext drifts
        // diagonally up to a filter control (the first filter <select> sits above-and-
        // left of the first card). A tile that DOES have a left neighbour on its row
        // falls through to the generic handler below, which steps to that neighbour.
        if (e.key === 'ArrowLeft' && focused.matches?.(CATALOG_TILE_SELECTOR)) {
            const leftCard = findNext(focused, 'ArrowLeft');
            const sameRow = leftCard && leftCard.matches?.(CATALOG_TILE_SELECTOR) &&
                hasMeaningfulVerticalOverlap(focused, leftCard, 0.5);
            if (!sameRow) {
                const active = document.querySelector('.navbar .nav-link.active');
                const rail = (active && isVisible(active))
                    ? active
                    : [...document.querySelectorAll('.navbar .nav-link')].find(isVisible);
                if (rail) { focusElement(rail); return; }
            }
        }

        // Left rail (TV): opening the menu must always be ONE press away. From
        // content, ArrowLeft walks left within the row; at the left edge (nothing
        // more to the left, or the only thing left is the rail itself) it lands on
        // the rail's CURRENT section. Pure spatial findNext could miss the rail
        // when a partially-scrolled card still sits to the left — this guarantees it.
        if (e.key === 'ArrowLeft' && !focused.closest('.navbar')) {
            const leftNext = findNext(focused, 'ArrowLeft');
            // Full-width sidebar list rows (a category header or a channel) have no
            // in-row neighbour to their left — only the header controls sit up-and-left.
            // For them, Left must open the menu, not jump diagonally to Hide-unavailable.
            // The header controls themselves keep walking left within their own row.
            const isSidebarListRow = focused.matches?.('.channel-sidebar .group-header, .channel-sidebar .channel-item');
            // NEVER escape to the rail while navigation is confined to an overlay (a modal,
            // a multi-select panel, or an open Movies/Series detail panel — navScope()): a
            // full-width trapped element has no left neighbour (leftNext null), which would
            // otherwise fall through here and land the ring on the active nav-link BEHIND the
            // overlay, breaking the focus trap. Inside a scope, keep focus put (findNext is
            // scope-bound). navScope() === document means nothing is trapping.
            if (navScope() === document && (!leftNext || leftNext.closest('.navbar') || isSidebarListRow)) {
                // Only trust the active nav-link if it is actually VISIBLE. applyCatalogAvailability
                // (app.js) can hide the current section's tab (display:none) while it stays .active,
                // and a truthy-but-hidden active link would shadow the visible fallback via `||`,
                // making the menu unreachable. Gate on visibility so the fallback still runs.
                const active = document.querySelector('.navbar .nav-link.active');
                const railTarget = (active && isVisible(active))
                    ? active
                    : [...document.querySelectorAll('.navbar .nav-link')].find(isVisible);
                if (railTarget && isVisible(railTarget)) {
                    focusElement(railTarget);
                    return;
                }
            }
            if (leftNext) {
                focusElement(leftNext);
                return;
            }
        }

        // Live TV (TV): ArrowRight from anywhere in .channel-sidebar must cross into the
        // player column in ONE press. The sidebar's own right-edge buttons (collapse ‹,
        // sort ⇅, Hide unavailable) sit closer than the far channel rows and would
        // otherwise win findNext's forward+lateral score. Prefer the playing/selected
        // row, else the channel row nearest the focused row's screen-y, else Watch.
        // (Inside #channel-search the text-field branch above already returned, so Right
        // stays a caret move there.)
        // Only a full-width sidebar LIST ROW (category / channel / search result)
        // force-crosses to the player on Right — those rows have nothing to their
        // right in the sidebar, and the sidebar's edge buttons would otherwise win
        // findNext's score. The header controls row (source · sort · Hide unavailable)
        // is NOT force-crossed: normal findNext walks it rightward and only reaches
        // the player at the row's right edge — otherwise those controls are stranded.
        if (e.key === 'ArrowRight' && focused.closest('.channel-sidebar') &&
            focused.matches?.('.group-header, .channel-item, .search-result')) {
            const player = document.querySelector('.player-section');
            if (player) {
                let target = player.querySelector('.live-guide-row.playing, .live-guide-row.selected, .live-guide-row.active');
                if (!target) {
                    const rows = [...player.querySelectorAll('.live-guide-row')].filter(isVisible);
                    if (rows.length) {
                        const y = centerOf(focused).y;
                        target = rows.reduce((b, r) => {
                            const d = Math.abs(centerOf(r).y - y);
                            return d < b.d ? { el: r, d } : b;
                        }, { el: rows[0], d: Infinity }).el;
                    }
                }
                if (!target) target = player.querySelector('.live-guide-preview [data-action="watch"]');
                if (target) { focusElement(target); return; }
            }
        }

        // Live TV (TV): from the TOP channel row, ArrowUp should land on the primary
        // preview action (Watch), not the Favorite button that sits lower and would win
        // on pure distance. Only fires at the top of the list (no row above).
        if (e.key === 'ArrowUp' && focused.matches?.('.live-guide-row')) {
            const firstRow = focused.closest('.live-guide-rows')?.querySelector('.live-guide-row');
            if (focused === firstRow) {
                const watch = document.querySelector('.player-section .live-guide-preview [data-action="watch"]');
                if (watch && isVisible(watch)) { focusElement(watch); return; }
            }
        }

        let next = findNext(focused, e.key);
        // Confine a horizontal press to its own rail row: inside a .horizontal-scroll rail,
        // a Left/Right target MUST live in the same rail. Otherwise Right at the true end of
        // a rail (no card to its right) leaps diagonally into a different rail and recenters
        // the page — on a 10-foot UI the expected behaviour is a no-op. Vertical presses, the
        // hero action row, and vertical grids (not a .horizontal-scroll) are unaffected.
        if (next && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            const row = focused.closest?.('.horizontal-scroll');
            if (row && !row.contains(next)) next = null;
        }
        if (next) {
            focusElement(next);
            return;
        }

        // If a page section only contains loading/empty states, or if focus is
        // at the end of a row, keep the D-pad useful by scrolling the page.
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            scrollActivePage(e.key, focused);
        }
    }, true); // capture: runs before the app's own arrow-key handlers

    // A physical key release guarantees the next command is never mistaken for
    // a held repeat, even when Android WebView does not populate event.repeat.
    // It also cancels the trailing coalesced move: once the viewer releases the
    // remote, focus must stop immediately instead of advancing one extra item.
    document.addEventListener('keyup', (e) => {
        if (e.key !== lastNavDirection) return;
        lastNavDirectionReleased = true;
        cancelQueuedNavRepeat();
    }, true);

    // Capture the opener before a modal component moves focus into its panel.
    document.addEventListener('focusin', (event) => {
        const modal = event.target?.closest?.(MODAL_SELECTOR);
        if (modal) rememberModalOrigin(modal, event.relatedTarget);
    }, true);

    let lastModal = null;
    const modalObserver = new MutationObserver(() => {
        const modal = openModal();
        const closed = lastModal && lastModal !== modal &&
            (!lastModal.isConnected || !lastModal.matches(MODAL_SELECTOR));
        if (closed) scheduleModalFocusRestore(lastModal);
        // Respect a component's own initial focus; only anchor when it left the
        // active element outside the topmost scope.
        if (modal && modal !== lastModal) {
            rememberModalOrigin(modal);
            lastModal = modal;
            setTimeout(() => {
                if (openModal() !== modal) return;
                const focused = currentFocus();
                if (focused && modal.contains(focused)) return;
                const first = scopeEntryTarget(modal);
                if (first) focusElement(first);
            }, 60);
        } else if (!modal) {
            lastModal = null;
        }
    });
    modalObserver.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['class']
    });

    // Land the ring on a just-opened fiche's primary action (Play/Resume). On the
    // Series fiche, Play is rendered disabled ('Loading…') while seriesInfo fetches, so
    // it's not focusable at open time — focus the first available control now, then hand
    // the ring to Play the instant it enables (unless the user already moved it).
    function anchorDetailFocus(panel) {
        const primary = panel.querySelector('#movie-primary-action, #series-primary-action');
        if (primary && !primary.disabled && isVisible(primary)) {
            focusElement(primary);
            return;
        }
        const fallback = [...panel.querySelectorAll('button:not([disabled]), a[href], [tabindex]')]
            .find(isVisible) || null;
        if (fallback) focusElement(fallback);
        if (primary && primary.disabled) {
            const enableObs = new MutationObserver(() => {
                if (primary.disabled) return;
                enableObs.disconnect();
                if (panel.classList.contains('hidden') || !isVisible(primary)) return;
                // Only claim focus if the user hasn't already navigated away from the
                // stop-gap target — never yank the ring out from under them.
                if (document.activeElement === fallback || document.activeElement === document.body) {
                    focusElement(primary);
                }
            });
            enableObs.observe(primary, { attributes: true, attributeFilter: ['disabled'] });
            setTimeout(() => enableObs.disconnect(), 6000);
        }
    }

    // Movies/Series detail panels are shown by the page toggling .hidden — not a modal,
    // so modalObserver above won't fire. When one opens, anchor the ring on its primary
    // action so the remote is immediately actionable instead of stranded on <body> (the
    // launching card is now inside the hidden grid, so focus would otherwise be lost).
    let lastOpenDetail = null;
    let detailOriginCard = null;   // the grid card that opened the current fiche
    const detailPanels = [
        document.getElementById('movie-details'),
        document.getElementById('series-details'),
    ].filter(Boolean);
    if (detailPanels.length) {
        const detailObserver = new MutationObserver(() => {
            // The docked Movies TV preview is permanently visible and must never
            // trigger fullscreen-fiche focus anchoring on each preview render.
            const open = detailPanels.find((p) =>
                !p.classList.contains('hidden') && isVisible(p) &&
                !isTvSplitPanel(p)) || null;
            if (open && open !== lastOpenDetail) {
                lastOpenDetail = open;
                // Capture the launching card NOW — before the 60ms anchor moves focus
                // into the panel and focusin overwrites lastFocusedCard with a fiche
                // button — so closing can return the ring to the user's exact place.
                // Don't require isVisible here: the grid was hidden just before the panel
                // opened, so the card is momentarily invisible. Visibility is re-checked
                // at restore time (below), once the grid is shown again.
                // Fiches open from grid cards (.movie-card/.series-card) AND rails / search /
                // "More like this" / continue cards (.dashboard-card/.continue-card/
                // .watch-recommended-card). Capture all of them, else closing a fiche opened
                // from a rail can't return the ring to its origin card.
                detailOriginCard = (lastFocusedCard &&
                    lastFocusedCard.matches?.('.movie-card, .series-card, .dashboard-card, .continue-card, .watch-recommended-card') &&
                    document.contains(lastFocusedCard)) ? lastFocusedCard : null;
                setTimeout(() => {
                    if (!open.classList.contains('hidden') && isVisible(open) &&
                        !isTvSplitPanel(open)) {
                        anchorDetailFocus(open);
                    }
                }, 60);
            } else if (!open && lastOpenDetail) {
                lastOpenDetail = null;
                // Fiche closed → return the ring to the card that opened it (Back
                // leaves focus on the now-hidden back button, so no ring otherwise).
                const origin = detailOriginCard;
                detailOriginCard = null;
                if (origin) {
                    setTimeout(() => {
                        if (!currentFocus() && document.contains(origin) && isVisible(origin)) {
                            focusElement(origin);
                        }
                    }, 60);
                }
            }
        });
        detailPanels.forEach((p) =>
            detailObserver.observe(p, { attributes: true, attributeFilter: ['class'] }));
    }

    // ---- Initial focus & focus restoration -------------------------------
    // Netflix always lands focus somewhere visible. Two mechanisms:
    //  1. When the active page changes (or first paints its cards), focus its
    //     first candidate so a ring is visible before any arrow press.
    //  2. When focus dies (native player return, list re-render removing the
    //     focused card), re-anchor to the remembered card or its neighbor.

    let lastFocusedCard = null;          // last card-like element we focused
    let lastFocusedPageId = null;
    let lastFocusRect = null;            // where it was — re-anchor point after re-renders
    let lastFocusedKey = null;           // data-identity, to re-find the SAME card after a rebuild

    // Stable identity for a card-like element that survives an innerHTML rebuild: the new
    // node is a different object but carries the same identifying data-* attributes (same
    // underlying item — e.g. data-rail-index/data-item-index, data-history-index, an id).
    // Lets us re-focus the SAME card after a rail is rebuilt in the background instead of
    // snapping to a stale screen position (a rebuilt rail resets scrollLeft to 0).
    function cardKey(el) {
        if (!el || el.nodeType !== 1) return null;
        if (el.id) return '#' + el.id;
        const ds = el.dataset ? Object.keys(el.dataset).filter((k) => k !== 'heroHoverBound') : [];
        if (!ds.length) return null;
        ds.sort();
        return (el.className || '').split(' ')[0] + '|' + ds.map((k) => k + '=' + el.dataset[k]).join('&');
    }
    function relocateLastCard() {
        if (!lastFocusedKey) return null;
        const page = activePage();
        if (!page) return null;
        // Scan the raw page DOM (NOT the viewport-filtered candidate set) so we can re-find a
        // card that the rebuild's scrollLeft:0 reset pushed off-screen; focusElement then
        // scrollIntoView-centres it, restoring the user's exact horizontal place in the rail.
        for (const el of page.querySelectorAll(INTERACTIVE_SELECTOR)) {
            if (el.disabled || el.closest('.hidden, [hidden]')) continue;
            if (cardKey(el) === lastFocusedKey) return el;
        }
        return null;
    }

    document.addEventListener('focusin', () => {
        const el = document.activeElement;
        const page = activePage();
        if (el && el !== document.body && page?.contains(el) &&
            el.matches?.(INTERACTIVE_SELECTOR)) {
            lastFocusedCard = el;
            lastFocusedPageId = page.id;
            lastFocusedKey = cardKey(el);
            try { lastFocusRect = el.getBoundingClientRect(); } catch (_) { lastFocusRect = null; }
            pageFocusMemory.set(page.id, {
                element: el,
                key: lastFocusedKey,
                rect: lastFocusRect
            });
        }
    });

    // When a re-render removed the focused card, land on its nearest surviving
    // neighbor (by screen distance) instead of snapping back to the page's first
    // candidate — the user keeps their place in the list.
    function nearestToLastRect(candidates) {
        if (!lastFocusRect || !candidates.length) return candidates[0] || null;
        const cx = lastFocusRect.left + lastFocusRect.width / 2;
        const cy = lastFocusRect.top + lastFocusRect.height / 2;
        let best = null;
        let bestDist = Infinity;
        for (const el of candidates) {
            const c = centerOf(el);
            const d = (c.x - cx) * (c.x - cx) + (c.y - cy) * (c.y - cy);
            if (d < bestDist) { bestDist = d; best = el; }
        }
        return best;
    }

    function ensurePageFocus() {
        // Never steal focus from an open modal or a text field being edited.
        if (openModal() || isTextField(document.activeElement)) return;
        if (currentFocus()) return;
        const page = activePage();
        if (!page) return;
        // Prefer restoring the exact card (still attached + same page), else its
        // nearest surviving neighbor via the remembered element's position.
        if (lastFocusedCard && lastFocusedPageId === page.id &&
            page.contains(lastFocusedCard) && isVisible(lastFocusedCard)) {
            focusElement(lastFocusedCard);
            return;
        }
        // The card node was replaced by a same-page re-render: re-focus the SAME card by its
        // data-identity so the user keeps their place (a rebuilt rail resets scrollLeft to 0,
        // so a screen-position match via nearestToLastRect would snap to a low-index card).
        if (lastFocusedPageId === page.id) {
            const relocated = relocateLastCard();
            if (relocated) { focusElement(relocated); return; }
        }
        const candidates = getPageCandidates();
        const target = lastFocusedPageId === page.id
            ? nearestToLastRect(candidates)
            : pageEntryTarget(page);
        if (target) focusElement(target);
    }

    // Page switches: the router toggles .page.active — watch for it, then let
    // the page paint (rails/grids render async) before landing focus.
    let pendingFocusTimer = null;
    function scheduleEnsureFocus(delay) {
        clearTimeout(pendingFocusTimer);
        pendingFocusTimer = setTimeout(ensurePageFocus, delay);
    }

    const pageObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.target.classList?.contains('page') && m.target.classList.contains('active')) {
                preparePageEntry(m.target);
                scheduleEnsureFocus(350);
                return;
            }
        }
    });
    document.querySelectorAll('.page').forEach((p) =>
        pageObserver.observe(p, { attributes: true, attributeFilter: ['class'] }));

    // A same-page re-render (e.g. HomePage swaps a rail/hero innerHTML on a background
    // refetch while the page stays .active) detaches the focused card; document.activeElement
    // falls to <body> and the ring vanishes. pageObserver above only watches the .page CLASS,
    // and window 'focus' never fires (the window never blurred), so nothing re-anchors until
    // the next keypress (which is then eaten by the restore branch). Watch the content subtree
    // for childList changes and, when our focused node was torn out (focus fell to <body>) on
    // the page that owned it, re-anchor at once — ensurePageFocus → relocateLastCard keeps the
    // user's exact card. Cheap: it only acts when a card was focused AND focus is now lost.
    let contentReanchorTimer = null;
    function scheduleContentReanchor() {
        clearTimeout(contentReanchorTimer);
        contentReanchorTimer = setTimeout(() => {
            if (openModal() || isTextField(document.activeElement) || currentFocus()) return;
            const page = activePage();
            if (page && lastFocusedPageId === page.id) ensurePageFocus();
        }, 50);
    }
    const contentObserver = new MutationObserver((mutations) => {
        if (!lastFocusedCard || isTextField(lastFocusedCard) || currentFocus()) return;
        for (const m of mutations) {
            if (m.addedNodes.length || m.removedNodes.length) { scheduleContentReanchor(); return; }
        }
    });
    contentObserver.observe(document.querySelector('.main-content') || document.body,
        { childList: true, subtree: true });

    // Boot: the first page renders its content async — a couple of passes catch
    // both the fast (cached rails) and slow (network) paint.
    scheduleEnsureFocus(800);
    setTimeout(() => { if (!currentFocus()) ensurePageFocus(); }, 2500);

    // Returning from the native player (the WebView regains window focus with
    // document.activeElement reset to <body>): restore the launch card's ring.
    window.addEventListener('focus', () => scheduleEnsureFocus(250));

    // Bridge for the Android client's hardware Back button.
    // Returns 'modal' / 'nav' when it handled Back internally, else 'exit'.
    window.__norvaTV = window.__norvaTV || {};
    window.__norvaTV.handleBack = function () {
        if (closeTopModal()) return 'modal';

        // An open RegionPicker combobox is a popover, not a modal — close it on Back
        // before falling through to page/exit handling.
        const openPicker = document.querySelector('[data-region-picker] [data-region-pop]:not([hidden])');
        if (openPicker) {
            const container = openPicker.closest('[data-region-picker]');
            if (container && typeof container.__regionClose === 'function' && container.__regionClose()) return 'nav';
        }

        // A category panel or a Movies/Series detail view (seasons/episodes/actions)
        // open → close it / go back to the grid instead of leaving the page.
        if (closeTransient()) return 'nav';

        // An open captions/audio/overflow menu in the web watch page
        const openMenu = document.querySelector(
            '.watch-captions-menu:not(.hidden), .watch-audio-menu:not(.hidden), .player-overflow-menu:not(.hidden)');
        if (openMenu) {
            openMenu.classList.add('hidden');
            return 'nav';
        }

        // On Live TV, the first hardware Back is always a safe escape to the
        // active rail item, even when the guide is still loading or empty.
        const page = activePage();
        if (page?.id === 'page-live' && !document.activeElement?.closest?.('.navbar')) {
            if (focusActiveNavbar()) return 'nav';
        }

        // Not on the home page → navigate home instead of exiting
        const activePageId = document.querySelector('.page.active')?.id;
        if (activePageId && activePageId !== 'page-home') {
            document.querySelector('.nav-link[data-page="home"]')?.click();
            return 'nav';
        }
        return 'exit';
    };

    console.log('[TV] D-pad spatial navigation enabled');
})();
