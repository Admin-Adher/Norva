/**
 * Hover preview — Netflix-style expanded card on pointer dwell.
 *
 * Rails and grids clip their children (overflow scrollers), so the preview is a
 * single fixed-position PORTAL element floating above the hovered card: bigger
 * art, title/meta and instant Play / Details actions.
 *
 * Data comes from either:
 *   - `card.__norvaHover` (a plain object or a function returning one), attached
 *     by pages that build card elements in JS (Movies/Series grids), or
 *   - a registered resolver for delegated/innerHTML cards (Home rails):
 *     NorvaHoverPreview.register(selector, (card) => data | null)
 *
 * Data shape: { title, meta, poster, backdrop, onPlay(), onDetails() }.
 * Desktop-only by design: requires a fine pointer with real hover, and stays
 * off in TV mode (D-pad focus is the TV interaction, not mouse hover).
 */

window.NorvaHoverPreview = (() => {
    const fine = window.matchMedia?.('(hover: hover) and (pointer: fine)');
    const tv = document.documentElement.classList.contains('tv-mode');
    if (!fine?.matches || tv) {
        return { register() { } };
    }

    const CARD_SELECTOR = '.dashboard-card, .movie-card, .series-card, .continue-card';
    const SHOW_DELAY_MS = 550;
    const HIDE_DELAY_MS = 180;

    const resolvers = [];
    let box = null;
    let showTimer = null;
    let hideTimer = null;
    let currentCard = null;

    function register(selector, resolve) {
        resolvers.push({ selector, resolve });
    }

    function dataFor(card) {
        try {
            if (typeof card.__norvaHover === 'function') return card.__norvaHover();
            if (card.__norvaHover) return card.__norvaHover;
            for (const r of resolvers) {
                if (card.matches(r.selector)) {
                    const d = r.resolve(card);
                    if (d) return d;
                }
            }
        } catch (_) { /* preview is progressive enhancement */ }
        return null;
    }

    function ensureBox() {
        if (box) return box;
        box = document.createElement('div');
        box.id = 'norva-hover-preview';
        box.className = 'hover-preview hidden';
        box.addEventListener('mouseenter', () => clearTimeout(hideTimer));
        box.addEventListener('mouseleave', scheduleHide);
        document.body.appendChild(box);
        return box;
    }

    function hideNow() {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        currentCard = null;
        if (box) {
            box.classList.remove('visible');
            box.classList.add('hidden');
        }
    }

    function scheduleHide() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideNow, HIDE_DELAY_MS);
    }

    function show(card) {
        if (!document.contains(card)) return;
        const data = dataFor(card);
        if (!data || (!data.poster && !data.backdrop)) return;

        const el = ensureBox();
        const rect = card.getBoundingClientRect();
        if (rect.width < 60) return;
        const width = Math.min(Math.max(rect.width * 1.55, 300), 430);
        let left = rect.left + rect.width / 2 - width / 2;
        left = Math.max(12, Math.min(left, window.innerWidth - width - 12));

        const art = data.backdrop || data.poster;
        const esc = window.MediaUtils?.escapeHtml || ((s) => String(s));
        el.innerHTML = `
            <div class="hover-preview-art">
                <img src="${esc(art)}" alt="" onerror="this.style.display='none'">
            </div>
            <div class="hover-preview-body">
                <div class="hover-preview-title">${esc(data.title || '')}</div>
                ${data.meta ? `<div class="hover-preview-meta">${esc(data.meta)}</div>` : ''}
                <div class="hover-preview-actions">
                    <button type="button" class="hover-preview-play">▶ Play</button>
                    <button type="button" class="hover-preview-info">More info</button>
                </div>
            </div>`;
        el.style.width = `${width}px`;
        el.style.left = `${left}px`;
        el.classList.remove('hidden');

        const height = el.offsetHeight || 320;
        let top = rect.top + rect.height / 2 - height / 2;
        top = Math.max(12, Math.min(top, window.innerHeight - height - 12));
        el.style.top = `${top}px`;

        el.querySelector('.hover-preview-play')?.addEventListener('click', (e) => {
            e.stopPropagation();
            hideNow();
            data.onPlay?.();
        });
        el.querySelector('.hover-preview-info')?.addEventListener('click', (e) => {
            e.stopPropagation();
            hideNow();
            (data.onDetails || data.onPlay)?.();
        });

        currentCard = card;
        requestAnimationFrame(() => el.classList.add('visible'));
    }

    document.addEventListener('mouseover', (e) => {
        const card = e.target.closest?.(CARD_SELECTOR);
        if (!card) return;
        clearTimeout(hideTimer);
        if (card === currentCard) return;
        clearTimeout(showTimer);
        showTimer = setTimeout(() => show(card), SHOW_DELAY_MS);
    });

    document.addEventListener('mouseout', (e) => {
        const card = e.target.closest?.(CARD_SELECTOR);
        if (!card) return;
        clearTimeout(showTimer);
        scheduleHide();
    });

    // Anything that moves content under the preview invalidates its anchor.
    document.addEventListener('scroll', hideNow, true);
    window.addEventListener('resize', hideNow);
    document.addEventListener('click', (e) => {
        if (box && !box.contains(e.target)) hideNow();
    }, true);

    return { register };
})();
