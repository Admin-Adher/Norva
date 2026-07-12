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
        '.channel-tile', '.dashboard-card'
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
        const modals = document.querySelectorAll('#modal.active, .modal-overlay.active, .np-overlay, #norva-region-prompt');
        return modals[modals.length - 1] || null;
    }

    // Single layout pass: measure each candidate's rect ONCE and keep it alongside
    // the element, so findNext can score without a second getBoundingClientRect().
    // rects[i] corresponds to els[i]. Filtering/order/400-cap are identical to the
    // old getCandidates (the inlined offset + rect checks equal isVisible(el)).
    function getCandidatesWithRects() {
        const scope = openModal() || document;
        const all = scope.querySelectorAll(INTERACTIVE_SELECTOR);
        const els = [];
        const rects = [];
        for (const el of all) {
            if (el.disabled) continue;
            if (el.closest('.hidden, [hidden]')) continue;
            if (!el.offsetParent && el.offsetWidth === 0 && el.offsetHeight === 0) continue;
            const rect = el.getBoundingClientRect();
            if (!isVisibleRect(rect)) continue;
            els.push(el);
            rects.push(rect);
            if (els.length >= 400) break;
        }
        return { els, rects };
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

    function scrollActivePage(direction, focused = null) {
        const target = findVerticalScroller(focused, direction);
        if (!target) return false;

        const amount = Math.max(220, Math.round(target.clientHeight * 0.65));
        const top = direction === 'ArrowDown' ? amount : -amount;
        const before = target.scrollTop;
        target.scrollBy({ top, behavior: 'smooth' });

        return target.scrollHeight > target.clientHeight && (
            direction === 'ArrowDown'
                ? before < target.scrollHeight - target.clientHeight
                : before > 0
        );
    }

    /** Close the topmost open modal, running the app's own close handler. */
    function closeTopModal() {
        const modal = openModal();
        if (!modal) return false;
        const closeBtn = modal.querySelector('.modal-close, #modal-cancel');
        if (closeBtn && typeof closeBtn.onclick === 'function') {
            try { closeBtn.onclick(); } catch (e) { /* fall through to class removal */ }
        }
        modal.classList.remove('active');
        return true;
    }

    function centerOf(el) {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
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

    function focusElement(el) {
        if (!el) return;
        if (!el.hasAttribute('tabindex') &&
            !['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
            el.setAttribute('tabindex', '-1');
        }
        el.focus({ preventScroll: true });
        // inline:'center' keeps the focused card centered as the D-pad walks a
        // horizontal rail (instead of leaving it stuck against an edge).
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
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
        const rows = [...select.options].map((opt, i) =>
            `<button type="button" class="tv-select-option${opt.selected ? ' selected' : ''}" data-index="${i}">
                ${opt.selected ? '✓ ' : ''}${opt.textContent}
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
                if (select.selectedIndex !== idx) {
                    select.selectedIndex = idx;
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
            if (closeTopModal()) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        }

        const arrows = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
        const isArrow = arrows.includes(e.key);
        const isEnter = e.key === 'Enter';
        if (!isArrow && !isEnter) return;

        const focused = currentFocus();

        // Text fields: ←/→ move the caret and Enter submits natively, but
        // ↑/↓ leave the field via spatial navigation — except in the channel
        // search, whose own ↑/↓ result navigation must keep working.
        if (isTextField(focused)) {
            if (focused.id === 'channel-search' &&
                e.key === 'ArrowDown' &&
                !focused.value.trim() &&
                !window.app?.channelList?.searchMode &&
                !window.app?.channelList?.zeroState) {
                e.preventDefault();
                e.stopPropagation();
                if (window.app?.channelList?.focusFirstVisibleChannel?.()) return;
            }
            const ownsVerticalKeys = focused.id === 'channel-search' &&
                (window.app?.channelList?.searchMode || window.app?.channelList?.zeroState);
            if (isEnter || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || ownsVerticalKeys) return;
        }
        // <select>: arrows navigate away (never trapped); Enter opens a custom
        // full-screen option list instead of the WebView's tiny native spinner.
        if (focused?.tagName === 'SELECT' && isEnter) {
            e.preventDefault();
            e.stopPropagation();
            openTvSelect(focused);
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
                : pageCandidates[0]);
            focusElement(first || getCandidates()[0] || null);
            return;
        }

        if (e.key === 'ArrowDown' && focused.closest('.navbar')) {
            // Left rail (TV): a nav item directly BELOW the focused one should win,
            // so Down walks the rail top-to-bottom. Only dive into the content grid
            // when there's nothing below in the rail (last item / a horizontal top
            // bar, where findNext finds no lower nav sibling — backward-compatible).
            const belowInNav = findNext(focused, 'ArrowDown');
            if (belowInNav && belowInNav.closest('.navbar')) {
                focusElement(belowInNav);
                return;
            }
            const firstPageCandidate = getPageCandidates()[0];
            if (firstPageCandidate) {
                focusElement(firstPageCandidate);
                return;
            }
        }

        // Left rail (TV): opening the menu must always be ONE press away. From
        // content, ArrowLeft walks left within the row; at the left edge (nothing
        // more to the left, or the only thing left is the rail itself) it lands on
        // the rail's CURRENT section. Pure spatial findNext could miss the rail
        // when a partially-scrolled card still sits to the left — this guarantees it.
        if (e.key === 'ArrowLeft' && !focused.closest('.navbar')) {
            const leftNext = findNext(focused, 'ArrowLeft');
            if (!leftNext || leftNext.closest('.navbar')) {
                const railTarget = document.querySelector('.navbar .nav-link.active')
                    || [...document.querySelectorAll('.navbar .nav-link')].find(isVisible);
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

        const next = findNext(focused, e.key);
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

    // Auto-focus the first field/button when a modal opens, so the remote
    // lands inside it immediately instead of on the dimmed page behind.
    let lastModal = null;
    const modalObserver = new MutationObserver(() => {
        const modal = openModal();
        if (modal && modal !== lastModal) {
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

    // ---- Initial focus & focus restoration -------------------------------
    // Netflix always lands focus somewhere visible. Two mechanisms:
    //  1. When the active page changes (or first paints its cards), focus its
    //     first candidate so a ring is visible before any arrow press.
    //  2. When focus dies (native player return, list re-render removing the
    //     focused card), re-anchor to the remembered card or its neighbor.

    let lastFocusedCard = null;          // last card-like element we focused
    let lastFocusedPageId = null;
    let lastFocusRect = null;            // where it was — re-anchor point after re-renders

    document.addEventListener('focusin', () => {
        const el = document.activeElement;
        if (el && el !== document.body && el.matches?.(INTERACTIVE_SELECTOR)) {
            lastFocusedCard = el;
            lastFocusedPageId = activePage()?.id || null;
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
        const candidates = getPageCandidates();
        const target = lastFocusedPageId === page.id ? nearestToLastRect(candidates) : candidates[0];
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

        // Series details panel (seasons/episodes) open → go back to the grid
        const details = document.getElementById('series-details');
        if (details && !details.classList.contains('hidden')) {
            document.querySelector('.series-back-btn')?.click();
            return 'nav';
        }

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
