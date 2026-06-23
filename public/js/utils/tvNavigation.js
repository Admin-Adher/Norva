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

    function isVisible(el) {
        if (!el.offsetParent && el.offsetWidth === 0 && el.offsetHeight === 0) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        // Keep candidates near the viewport so huge lists stay fast
        return rect.bottom > -400 && rect.top < window.innerHeight + 400 &&
            rect.right > -200 && rect.left < window.innerWidth + 200;
    }

    // The currently open modal, if any. While one is open, navigation is
    // confined to it so the D-pad can't escape to the dimmed page behind.
    function openModal() {
        return document.querySelector('#modal.active, .modal-overlay.active, .np-overlay');
    }

    function getCandidates() {
        const scope = openModal() || document;
        const all = scope.querySelectorAll(INTERACTIVE_SELECTOR);
        const result = [];
        for (const el of all) {
            if (el.disabled) continue;
            if (el.closest('.hidden, [hidden]')) continue;
            if (!isVisible(el)) continue;
            result.push(el);
            if (result.length >= 400) break;
        }
        return result;
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

        for (const el of getCandidates()) {
            if (el === current) continue;
            const to = centerOf(el);
            const dx = to.x - from.x;
            const dy = to.y - from.y;

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
        // <select>: arrows navigate away (never trapped); Enter opens the
        // native picker through the default behavior
        if (focused?.tagName === 'SELECT' && isEnter) return;

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
            // Nothing focused yet: enter the active page before falling back
            // to global navigation links.
            const pageCandidates = getPageCandidates();
            const first = e.key === 'ArrowUp'
                ? pageCandidates[pageCandidates.length - 1]
                : pageCandidates[0];
            focusElement(first || getCandidates()[0] || null);
            return;
        }

        if (e.key === 'ArrowDown' && focused.closest('.navbar')) {
            const firstPageCandidate = getPageCandidates()[0];
            if (firstPageCandidate) {
                focusElement(firstPageCandidate);
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
