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
        '.captions-option', '.audio-option', '.version-item', '.multi-select-item',
        '.search-group-chip', '.watch-episode-item', '.watch-season-header',
        '.season-header', '.tab', '.watch-recommended-card', '.context-item',
        '.live-guide-group', '.live-guide-row',
        // Home page cards (dashboard)
        '.channel-tile', '.dashboard-card', '.tv-more-like-card'
    ].join(',');

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
        const modals = document.querySelectorAll('#modal.active, #edit-user-modal.active, .modal-overlay.active, .np-overlay, #norva-region-prompt, .norva-modal-overlay, .trailer-lightbox');
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
            return [...page.querySelectorAll('.movies-grid .movie-card, .series-grid .series-card')]
                .find(isVisible) || null;
        }
        return null;
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
            previewCard = page.querySelector('#movies-grid .movie-card.tv-preview-active');
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
    const NAV_BURST_MS = 250;
    // Held-key rate cap: while a direction is held the OS repeats keydown ~25-40x/s, and
    // the full pipeline (candidate scan + geometry reads + scroll) ran on every repeat,
    // pegging a weak TV CPU and letting focus lag behind the keys. Drop burst repeats that
    // arrive < this interval after the last processed move (~12 moves/s max) — smoother to
    // track by eye AND far cheaper. Isolated presses are never throttled.
    const NAV_THROTTLE_MS = 80;
    function navScrollBehavior() { return navBurst ? 'auto' : 'smooth'; }

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

    // Movies/Series TV grid UP nav state. Discriminating a HELD Up (fast-scroll) from a DOUBLE-tap
    // Up (escape to filters) via KeyboardEvent.repeat is UNRELIABLE on Android TV WebView (held keys
    // often arrive as discrete keydowns with repeat=false). Instead we mirror the DOWN path — every
    // Up keydown walks/scrolls the grid — and detect a genuine second press via a KEYUP between
    // presses (a continuous hold emits no interleaved keyup). A long gap (>600ms) also counts as a
    // fresh press, so it degrades gracefully even if keyup isn't delivered on the device.
    let upReleased = true;      // an ArrowUp keyup was seen since the last ArrowUp keydown
    let prevUpDownAt = 0;       // timestamp of the previous ArrowUp keydown
    let upFreshCount = 0;       // consecutive FRESH (released-between) Up presses within the window
    let lastUpFreshAt = 0;
    const UP_DOUBLE_TAP_MS = 400;
    const UP_FRESH_GAP_MS = 600;

    // The Movies filter row nearest the card's column (bottom row = closest to the grid) — the
    // EXPLICIT escape target so a mid-list double-tap Up lands on the filters, not another grid card.
    function catalogFilterTarget(fromEl) {
        const page = activePage();
        const rows = [...(page?.querySelectorAll('.tv-movies-filter-row, .tv-series-filter-row') || [])]
            .filter(isVisible);
        const regionName = page?.id === 'page-series' ? 'series-filters' : 'movies-filters';
        const region = rows[rows.length - 1] ||
            page?.querySelector(`[data-tv-nav-region="${regionName}"]`);
        if (!region) return null;
        const fromX = centerOf(fromEl).x;
        const cands = getCandidates().filter((el) => region.contains(el) && isVisible(el));
        if (!cands.length) return null;
        return cands.reduce((b, el) => {
            const d = Math.abs(centerOf(el).x - fromX);
            return d < b.d ? { el, d } : b;
        }, { el: cands[0], d: Infinity }).el;
    }

    // Nearest VISIBLE card above `card` within its grid — lets UP walk up the visible rows before
    // the scroll step. Prefers the same column, then the nearest row.
    function gridCardAbove(card) {
        const grid = card?.closest?.('.movies-grid, .series-grid');
        if (!grid) return null;
        const from = centerOf(card);
        let best = null, bestScore = Infinity;
        for (const c of grid.querySelectorAll('.movie-card, .series-card')) {
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

    /** Close the topmost open modal, running the app's own close handler. */
    function closeTopModal() {
        const modal = openModal();
        if (!modal) return false;
        // The trailer lightbox dismisses via its own ✕ (removes the node + its key listener).
        if (modal.classList.contains('trailer-lightbox')) {
            const x = modal.querySelector('.trailer-lightbox-close');
            if (x) { x.click(); } else { modal.remove(); }
            return true;
        }
        // NorvaModal dialogs (.norva-modal-overlay) are promise-based: their buttons are
        // wired with addEventListener and the dialog dismisses by REMOVING its node (there
        // is no `active` class to strip, and no `.onclick`). Click Cancel — else Confirm/OK
        // for a single-button alert — so the pending Promise resolves (false / true) and the
        // overlay tears itself down. Stripping a class here would orphan a full-screen veil.
        if (modal.classList.contains('norva-modal-overlay')) {
            const btn = modal.querySelector('.norva-modal-cancel') || modal.querySelector('.norva-modal-confirm');
            if (btn) { btn.click(); return true; }
        }
        const closeBtn = modal.querySelector('.modal-close, #modal-cancel');
        if (closeBtn && typeof closeBtn.onclick === 'function') {
            try { closeBtn.onclick(); } catch (e) { /* fall through to class removal */ }
        }
        modal.classList.remove('active');
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
            panel.classList.add('hidden');
            const btn = panel.closest('.multi-select')?.querySelector('.multi-select-btn');
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
            const cards = [...(grid?.querySelectorAll('.movie-card, .series-card') || [])];
            const usable = card => Boolean(
                card?.isConnected &&
                !card.closest('.hidden, [hidden]') &&
                (card.offsetWidth > 0 || card.offsetHeight > 0)
            );
            const preview = grid?.querySelector('.movie-card.tv-preview-active, .series-card.tv-preview-active');
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

    function focusElement(el) {
        if (!el) return;
        if (!el.hasAttribute('tabindex') &&
            !['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
            el.setAttribute('tabindex', '-1');
        }
        el.focus({ preventScroll: true });
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
        if (!isArrow && !isEnter) return;

        // Refresh the held-key burst flag so this move's scroll (focusElement /
        // scrollActivePage) is instant when presses are coming fast, smooth when
        // isolated. Only arrows drive scrolling, so only they update the cadence.
        if (isArrow) {
            const now = e.timeStamp || (typeof performance !== 'undefined' ? performance.now() : 0);
            navBurst = (now - lastNavKeyAt) < NAV_BURST_MS;
            lastNavKeyAt = now;
        }

        // Start this keydown with a fresh candidate scan, and guarantee the memo is
        // dropped once the (synchronous) handler unwinds — a microtask fires before
        // any later task, so nothing outside this keypress can read stale rects.
        candCache = null;
        if (typeof queueMicrotask === 'function') queueMicrotask(() => { candCache = null; });
        else Promise.resolve().then(() => { candCache = null; });

        const focused = currentFocus();

        // Held-key throttle (spatial nav only — text-field caret stays fully responsive).
        // A burst repeat that lands too soon after the last processed move is dropped; the
        // NEXT repeat still moves, so held-scroll keeps flowing without running the whole
        // navigation pipeline 30-40x/s on a weak TV.
        if (isArrow && navBurst && !isTextField(focused)) {
            const nowMs = (typeof performance !== 'undefined' ? performance.now() : (e.timeStamp || 0));
            if (nowMs - lastNavMoveAt < NAV_THROTTLE_MS) { e.preventDefault(); return; }
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
                let target = null;
                if (e.key === 'ArrowDown') {
                    const series = focused.id === 'series-search';
                    const row = document.getElementById(series
                        ? 'series-tv-primary-filters'
                        : 'movies-tv-primary-filters');
                    target = [...(row?.querySelectorAll(INTERACTIVE_SELECTOR) || [])]
                        .find(el => !el.disabled && isVisible(el));
                    if (!target) {
                        target = [...document.querySelectorAll(series
                            ? '#series-grid .series-card'
                            : '#movies-grid .movie-card')]
                            .find(isVisible);
                    }
                } else {
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
                : (pageDefaultTarget(page) || firstNonTextCandidate(pageCandidates)));
            focusElement(first || firstNonTextCandidate(getCandidates()) || null);
            return;
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
            const firstPageCandidate = pageDefaultTarget(activePage()) || firstNonTextCandidate(getPageCandidates());
            if (firstPageCandidate) {
                focusElement(firstPageCandidate);
                return;
            }
        }

        // Right from the rail crosses into the page content. findNext normally finds a
        // card to the right; when the page is still empty/loading it returns null and
        // Right would be a silent no-op (the scroll fallback at the end only handles
        // Up/Down). Fall back to the page's default target so Right is never dead —
        // mirroring the ArrowDown dive above.
        if (e.key === 'ArrowRight' && focused.closest('.navbar')) {
            const rightNext = findNext(focused, 'ArrowRight');
            if (rightNext) {
                focusElement(rightNext);
                return;
            }
            const target = pageDefaultTarget(activePage()) || firstNonTextCandidate(getPageCandidates());
            if (target) {
                focusElement(target);
                return;
            }
        }

        // Movies/Series TV: walk each filter band internally, then bridge its right
        // edge straight to the docked preview CTA. Pure geometry cannot make this hop
        // reliably because the large poster pushes the first panel button far below
        // the filters, so cards underneath otherwise out-score it.
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
                    let target = grid.querySelector('.movie-card.tv-preview-active, .series-card.tv-preview-active');
                    if (!target || !isVisible(target)) {
                        const origin = centerOf(focused);
                        const y = origin.y;
                        const cards = [...grid.querySelectorAll('.movie-card, .series-card')].filter(isVisible);
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
        const TILE = '.movie-card, .series-card, .continue-card';
        if (e.key === 'ArrowLeft' && focused.matches?.(TILE)) {
            const leftCard = findNext(focused, 'ArrowLeft');
            const sameRow = leftCard && leftCard.matches?.(TILE) &&
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

        // Movies/Series grid (TV): UP walks up WITHIN the grid (nearest card above), and once the top
        // visible row is reached it scrolls the grid up (scrollActivePage, focus stays) — exactly
        // mirroring how DOWN scrolls the list down, so a HELD Up fast-scrolls up and NEVER escapes.
        // Reaching the filters: a FRESH Up press at the very top, OR a deliberate DOUBLE-tap Up from
        // anywhere (two presses with a key RELEASE between them, within 400ms). A continuous hold has
        // no interleaved keyup (see the keyup listener), so it can never trip the escape — robust to
        // the Android TV WebView key model where e.repeat is unreliable.
        if (e.key === 'ArrowUp' &&
            focused.matches?.('.movies-grid .movie-card, .series-grid .series-card')) {
            const now = Date.now();
            const fresh = upReleased || (now - prevUpDownAt > UP_FRESH_GAP_MS);   // a distinct new press
            prevUpDownAt = now;
            upReleased = false;
            if (fresh) {
                upFreshCount = (now - lastUpFreshAt < UP_DOUBLE_TAP_MS) ? upFreshCount + 1 : 1;
                lastUpFreshAt = now;
            }
            // Deliberate double-tap (two fresh presses) from ANYWHERE in the list → the filters.
            if (fresh && upFreshCount >= 2) {
                upFreshCount = 0;
                const f = catalogFilterTarget(focused) || findNext(focused, 'ArrowUp');
                if (f) { focusElement(f); return; }
            }
            // Otherwise walk/scroll up within the grid.
            const above = gridCardAbove(focused);
            if (above) { focusElement(above); return; }
            if (scrollActivePage('ArrowUp', focused)) return;         // reveal cards above; focus stays
            // At the very top (can't scroll up): a FRESH single Up escapes to the filters (natural);
            // a held repeat swallows so a fast-scroll to the top never overshoots into the filters.
            if (fresh) {
                const f = catalogFilterTarget(focused) || findNext(focused, 'ArrowUp');
                if (f) { focusElement(f); return; }
            }
            return;
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

    // Powers the Movies/Series grid double-tap-Up detector: a key RELEASE between two Up keydowns
    // marks a genuine second press (a continuous hold emits keydowns with no interleaved keyup).
    document.addEventListener('keyup', (e) => {
        if (e.key === 'ArrowUp') upReleased = true;
    }, true);

    // Auto-focus the first field/button when a modal opens, so the remote
    // lands inside it immediately instead of on the dimmed page behind.
    let lastModal = null;
    const modalObserver = new MutationObserver(() => {
        const modal = openModal();
        // NorvaModal dialogs (.norva-modal-overlay) manage their own initial focus
        // (Cancel-first for destructive confirms) and are never revealed via a class
        // mutation this observer watches — don't second-guess or steal their focus.
        if (modal && modal !== lastModal && !modal.classList.contains('norva-modal-overlay')) {
            lastModal = modal;
            setTimeout(() => {
                // Prefer the first form field (full-width, so vertical nav flows
                // cleanly through the fields then down to the footer buttons);
                // fall back to any focusable for button-only modals.
                const first = modal.querySelector(
                        '#modal-body input:not([type="hidden"]), #modal-body textarea, #modal-body select')
                    || modal.querySelector(
                        'input:not([type="hidden"]), textarea, select, button, a[href], [tabindex]');
                if (first) focusElement(first);
            }, 60);
        } else if (!modal) {
            lastModal = null;
        }
    });
    modalObserver.observe(document.body, {
        attributes: true, subtree: true, attributeFilter: ['class']
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
        if (el && el !== document.body && el.matches?.(INTERACTIVE_SELECTOR)) {
            lastFocusedCard = el;
            lastFocusedPageId = activePage()?.id || null;
            lastFocusedKey = cardKey(el);
            try { lastFocusRect = el.getBoundingClientRect(); } catch (_) { lastFocusRect = null; }
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
            : (pageDefaultTarget(page) || firstNonTextCandidate(candidates));
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

        // Not on the home page → navigate home instead of exiting
        const activePage = document.querySelector('.page.active')?.id;
        if (activePage && activePage !== 'page-home') {
            document.querySelector('.nav-link[data-page="home"]')?.click();
            return 'nav';
        }
        return 'exit';
    };

    console.log('[TV] D-pad spatial navigation enabled');
})();
