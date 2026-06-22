// Netflix-style horizontal genre rails.
//
// Renders a list of rails (sections of horizontally-scrolling poster cards),
// reusing the Home page's rail CSS classes (.home-rail-section, .dashboard-card,
// .horizontal-scroll, .scroll-wrapper, .scroll-arrow, .card-image, .card-info)
// so the look is identical with zero new CSS.
//
// Self-contained on purpose: the caller passes the rails payload (same item
// shape as Home rails) and an onItemClick(item, rail) callback, so it has no
// coupling to any page. Used by the Movies and Series browse pages.
(function () {
    'use strict';

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function posterOf(item) {
        const data = item.data || {};
        const url = item.poster_url || item.posterUrl || item.stream_icon || item.cover
            || data.poster || data.posterUrl || data.poster_url || data.cover || '';
        if (!url) return '/img/norva-media-placeholder.png';
        if (/^https?:\/\//i.test(url)) return url;
        // A TMDB path (e.g. "/abc.jpg") needs the image host; our own assets keep their path.
        return (url.charAt(0) === '/' && url.indexOf('/img') !== 0)
            ? `https://image.tmdb.org/t/p/w342${url}`
            : url;
    }

    function titleOf(item) {
        return item.title || item.name || (item.data && (item.data.title || item.data.name)) || 'Sans titre';
    }

    function metaOf(item) {
        const data = item.data || {};
        const year = item.year || data.year || data.releaseYear || '';
        const rating = item.rating || item.vote_average || data.voteAverage || '';
        const genres = Array.isArray(item.genres) ? item.genres : (Array.isArray(data.genres) ? data.genres : []);
        const parts = [year].concat(genres.slice(0, 2));
        if (rating) parts.push('★ ' + String(rating).slice(0, 3));
        return parts.filter(Boolean).join(' · ');
    }

    function cardHtml(item, railIndex, itemIndex) {
        const variantCount = Number(item.variantCount || item.variant_count || (item.data && item.data.variantCount) || 0);
        const t = titleOf(item);
        return `
            <div class="dashboard-card" data-rail-index="${railIndex}" data-item-index="${itemIndex}">
                <div class="card-image">
                    <img src="${esc(posterOf(item))}" alt="${esc(t)}" loading="lazy" onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'">
                    ${variantCount > 1 ? `<div class="home-card-badge">${variantCount} versions</div>` : ''}
                    <div class="play-icon-overlay"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
                </div>
                <div class="card-info">
                    <div class="card-title" title="${esc(t)}">${esc(t)}</div>
                    <div class="card-subtitle">${esc(metaOf(item))}</div>
                </div>
            </div>`;
    }

    function railHtml(rail, railIndex) {
        const cards = (rail.items || []).map((item, i) => cardHtml(item, railIndex, i)).join('');
        return `
            <section class="dashboard-section home-rail-section" data-rail-id="${esc(rail.id || railIndex)}">
                <div class="section-header home-rail-header">
                    <div><h2>${esc(rail.title || rail.name || '')}</h2></div>
                </div>
                <div class="scroll-wrapper">
                    <button class="scroll-arrow scroll-left" aria-label="Défiler à gauche" type="button"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg></button>
                    <div class="horizontal-scroll">${cards}</div>
                    <button class="scroll-arrow scroll-right" aria-label="Défiler à droite" type="button"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></button>
                </div>
            </section>`;
    }

    function wireArrows(container) {
        container.querySelectorAll('.scroll-wrapper').forEach((wrapper) => {
            if (wrapper.dataset.scrollReady === '1') return;
            const scroller = wrapper.querySelector('.horizontal-scroll');
            const left = wrapper.querySelector('.scroll-left');
            const right = wrapper.querySelector('.scroll-right');
            if (!scroller || !left || !right) return;
            const amount = 420;
            left.addEventListener('click', () => scroller.scrollBy({ left: -amount, behavior: 'smooth' }));
            right.addEventListener('click', () => scroller.scrollBy({ left: amount, behavior: 'smooth' }));
            const update = () => {
                const { scrollLeft, scrollWidth, clientWidth } = scroller;
                left.classList.toggle('hidden', scrollLeft <= 0);
                right.classList.toggle('hidden', scrollLeft + clientWidth >= scrollWidth - 5);
            };
            wrapper.dataset.scrollReady = '1';
            scroller.addEventListener('scroll', update);
            setTimeout(update, 100);
        });
    }

    function render(container, rails, options) {
        if (!container) return;
        options = options || {};
        const onItemClick = options.onItemClick || function () {};
        const usable = (rails || []).filter((r) => Array.isArray(r.items) && r.items.length);
        if (!usable.length) {
            container.innerHTML = `<div class="empty-state"><p>${esc(options.emptyText || 'Aucun contenu à afficher pour le moment.')}</p></div>`;
            return;
        }
        container.innerHTML = usable.map((rail, i) => railHtml(rail, i)).join('');
        container.querySelectorAll('.dashboard-card').forEach((card) => {
            card.addEventListener('click', () => {
                const rail = usable[Number(card.dataset.railIndex)];
                const item = rail && rail.items[Number(card.dataset.itemIndex)];
                if (item) onItemClick(item, rail);
            });
        });
        wireArrows(container);
    }

    window.GenreRails = { render };
})();
