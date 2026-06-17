/**
 * Home dashboard.
 * The page is intentionally powered by the same cloud catalog contract used by
 * the other clients: history + /home/rails + playback/session.
 */
class HomePage {
    constructor(app) {
        this.app = app;
        this.container = null;
        this.isLoading = false;
        this.loadPromise = null;
        this.lastLoadedAt = 0;
        this.dashboardTtlMs = 60000;
        this.railItems = [];
        this.historyItems = [];
        this.heroItem = null;
    }

    async init() {
        // Initialization if needed.
    }

    async show() {
        if (!document.getElementById('home-content')) {
            this.renderLayout();
        } else {
            this.container = document.getElementById('home-content');
        }

        if (this.lastLoadedAt && Date.now() - this.lastLoadedAt < this.dashboardTtlMs) {
            this.updateScrollArrows();
            return;
        }

        await this.loadDashboardData();
    }

    hide() {
        // Keep the dashboard DOM warm so returning to Home feels instant.
    }

    renderLayout() {
        const pageHome = document.getElementById('page-home');
        if (!pageHome) return;

        pageHome.innerHTML = `
            <div class="dashboard-content" id="home-content">
                <section id="home-service-health" class="dashboard-section hidden"></section>

                <section class="home-hero-section hidden" id="home-hero"></section>

                <section class="dashboard-section hidden" id="continue-watching-section">
                    <div class="section-header">
                        <h2>Reprendre</h2>
                    </div>
                    ${this.scrollSection('continue-watching-list', 'Loading history...')}
                </section>

                <div id="home-rails">
                    <section class="dashboard-section">
                        <div class="section-header">
                            <h2>Selection Norva</h2>
                        </div>
                        <div class="loading-state">
                            <div class="loading"></div>
                            <span>Loading recommendations...</span>
                        </div>
                    </section>
                </div>

                <section class="dashboard-section" id="favorite-channels-section">
                    <div class="section-header">
                        <h2>Chaines favorites</h2>
                    </div>
                    ${this.scrollSection('favorite-channels-list', 'Loading favorites...', 'channel-tiles')}
                </section>
            </div>
        `;

        this.container = document.getElementById('home-content');
        this.initScrollArrows();
    }

    scrollSection(id, loadingText, extraClass = '', content = '') {
        const body = content || `
                    <div class="loading-state">
                        <div class="loading"></div>
                        <span>${this.escapeHtml(loadingText)}</span>
                    </div>
        `;
        return `
            <div class="scroll-wrapper">
                <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                </button>
                <div class="horizontal-scroll ${extraClass}" id="${id}">
                    ${body}
                </div>
                <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                </button>
            </div>
        `;
    }

    initScrollArrows() {
        this.container?.querySelectorAll('.scroll-wrapper').forEach(wrapper => {
            if (wrapper.dataset.scrollReady === '1') return;
            const scrollContainer = wrapper.querySelector('.horizontal-scroll');
            const leftBtn = wrapper.querySelector('.scroll-left');
            const rightBtn = wrapper.querySelector('.scroll-right');

            if (!scrollContainer || !leftBtn || !rightBtn) return;

            const scrollAmount = 420;

            leftBtn.addEventListener('click', () => {
                scrollContainer.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
            });

            rightBtn.addEventListener('click', () => {
                scrollContainer.scrollBy({ left: scrollAmount, behavior: 'smooth' });
            });

            const updateArrows = () => {
                const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
                leftBtn.classList.toggle('hidden', scrollLeft <= 0);
                rightBtn.classList.toggle('hidden', scrollLeft + clientWidth >= scrollWidth - 5);
            };

            wrapper._updateArrows = updateArrows;
            wrapper.dataset.scrollReady = '1';
            scrollContainer.addEventListener('scroll', updateArrows);
            setTimeout(updateArrows, 100);
        });
    }

    updateScrollArrows() {
        this.container?.querySelectorAll('.scroll-wrapper').forEach(wrapper => {
            if (wrapper._updateArrows) wrapper._updateArrows();
        });
    }

    async loadDashboardData() {
        if (this.isLoading) return this.loadPromise;
        this.isLoading = true;

        this.loadPromise = (async () => {
            try {
                const [historyResult, railsResult, healthResult, favoritesResult] = await Promise.allSettled([
                    window.API.request('GET', '/history?limit=18'),
                    window.API.request('GET', '/home/rails?limit=18'),
                    window.NorvaSourceHealth?.loadSummary?.(),
                    this.renderFavoriteChannels()
                ]);

                const history = historyResult.status === 'fulfilled' && Array.isArray(historyResult.value)
                    ? historyResult.value
                    : [];
                this.renderHistory(history);

                if (healthResult.status === 'fulfilled' && healthResult.value) {
                    this.renderServiceHealth(healthResult.value);
                }

                if (railsResult.status === 'fulfilled') {
                    this.renderHero(history, railsResult.value?.rails || []);
                    this.renderCloudRails(railsResult.value);
                } else {
                    console.warn('[Dashboard] Home rails unavailable, using recent content fallback:', railsResult.reason);
                    await this.renderFallbackRails();
                    this.renderHero(history, this.railItems);
                }

                if (favoritesResult.status === 'rejected') {
                    console.warn('[Dashboard] Favorites unavailable:', favoritesResult.reason);
                }

                this.lastLoadedAt = Date.now();
            } catch (err) {
                console.error('[Dashboard] Error loading data:', err);
            } finally {
                this.isLoading = false;
                this.loadPromise = null;
            }
        })();

        return this.loadPromise;
    }

    renderServiceHealth(summary) {
        const container = document.getElementById('home-service-health');
        if (!container || !window.NorvaSourceHealth) return;

        container.innerHTML = window.NorvaSourceHealth.cardHtml(summary, { hideWhenReady: true });
        container.classList.toggle('hidden', summary?.state === 'ready');
        container.querySelector('[data-source-health-action="open-sources"]')?.addEventListener('click', () => {
            this.app.navigateTo('settings');
            setTimeout(() => this.app.pages.settings?.switchTab?.('sources'), 0);
        });
    }

    async renderFallbackRails() {
        const container = document.getElementById('home-rails');
        if (!container) return;

        const [moviesResult, seriesResult] = await Promise.allSettled([
            window.API.request('GET', '/channels/recent?type=movie&limit=18'),
            window.API.request('GET', '/channels/recent?type=series&limit=18')
        ]);

        const rails = [];
        if (moviesResult.status === 'fulfilled' && moviesResult.value?.length) {
            rails.push({ id: 'recently-added-movies', title: 'Films recemment ajoutes', items: moviesResult.value });
        }
        if (seriesResult.status === 'fulfilled' && seriesResult.value?.length) {
            rails.push({ id: 'recently-added-series', title: 'Series recemment ajoutees', items: seriesResult.value });
        }

        this.renderCloudRails({ rails });
    }

    renderHero(history = [], rails = []) {
        const hero = document.getElementById('home-hero');
        if (!hero) return;

        const firstHistory = history.find(item => this.posterFromItem(item) && this.hasUsefulDisplayTitle(item));
        const firstRailItem = rails
            .flatMap(rail => rail.items || [])
            .find(item => this.posterFromItem(item) && this.hasUsefulDisplayTitle(item));
        const item = firstHistory || firstRailItem;

        if (!item) {
            this.heroItem = null;
            hero.classList.add('hidden');
            hero.innerHTML = '';
            return;
        }

        this.heroItem = item;
        const data = item.data || {};
        const title = this.displayTitle(item);
        const type = item.item_type || item.itemType || item.type || 'movie';
        const subtitle = this.heroSubtitle(item);
        const description = this.descriptionFromItem(item);
        const poster = this.resolveImageUrl(this.backdropFromItem(item) || this.posterFromItem(item), '/img/norva-media-placeholder.png');
        const action = firstHistory ? 'Resume' : (type === 'series' ? 'Open' : 'Play');

        hero.classList.remove('hidden');
        hero.innerHTML = `
            <div class="home-hero-bg" style="background-image:url('${this.escapeAttr(poster)}')"></div>
            <div class="home-hero-content">
                <div class="home-hero-kicker">${this.escapeHtml(subtitle)}</div>
                <h1>${this.escapeHtml(title)}</h1>
                ${description ? `<p>${this.escapeHtml(description)}</p>` : ''}
                <div class="home-hero-actions">
                    <button class="btn btn-primary home-hero-play" id="home-hero-play">${this.escapeHtml(action)}</button>
                    <button class="btn btn-ghost home-hero-more" id="home-hero-more">Details</button>
                </div>
            </div>
        `;

        hero.querySelector('#home-hero-play')?.addEventListener('click', () => {
            this.openRailItem(item, firstHistory);
        });
        hero.querySelector('#home-hero-more')?.addEventListener('click', () => {
            if (type === 'series') this.navigateToSeries(item);
            else this.openRailItem(item, firstHistory);
        });
    }

    heroSubtitle(item) {
        const type = item.item_type || item.itemType || item.type;
        const data = item.data || {};
        const bits = [];
        if (item.progress || data.progress) bits.push('A reprendre');
        bits.push(type === 'series' ? 'Series' : type === 'channel' ? 'Live TV' : 'Movie');
        const year = item.year || data.year || data.releaseYear;
        if (year) bits.push(year);
        const rating = item.rating || data.rating || data.voteAverage;
        if (rating) bits.push(`Note ${String(rating).slice(0, 3)}`);
        return bits.join(' - ');
    }

    descriptionFromItem(item) {
        const data = item.data || {};
        return data.description || data.plot || item.plot || item.description || '';
    }

    backdropFromItem(item = {}) {
        const data = item.data || {};
        const metadata = item.metadata || {};
        return item.backdrop
            || item.backdrop_url
            || item.backdropUrl
            || data.backdrop
            || data.backdrop_url
            || data.backdropUrl
            || metadata.backdrop
            || metadata.backdropUrl
            || this.tmdbImagePath(data.backdrop_path || metadata.backdrop_path || item.backdrop_path, 'w780');
    }

    tmdbImagePath(path, size = 'w342') {
        if (!path) return null;
        const value = String(path);
        if (/^https?:\/\//i.test(value)) return value;
        return value.startsWith('/') ? `https://image.tmdb.org/t/p/${size}${value}` : value;
    }

    renderCloudRails(payload = {}) {
        const container = document.getElementById('home-rails');
        if (!container) return;

        const rails = (payload.rails || [])
            .map(rail => ({
                ...rail,
                items: (rail.items || []).filter(item => this.hasUsefulDisplayTitle(item) && (this.posterFromItem(item) || item.stream_icon || item.poster_url))
            }))
            .filter(rail => rail.items.length);

        this.railItems = rails;

        if (!rails.length) {
            container.innerHTML = `
                <section class="dashboard-section">
                    <div class="empty-state hint">Add a TV service from Settings to build your Home.</div>
                </section>
            `;
            return;
        }

        container.innerHTML = rails.map((rail, railIndex) => this.createRailSection(rail, railIndex)).join('');

        container.querySelectorAll('.dashboard-card').forEach(card => {
            card.addEventListener('click', () => {
                const rail = this.railItems[Number(card.dataset.railIndex)];
                const item = rail?.items?.[Number(card.dataset.itemIndex)];
                if (item) this.openRailItem(item, false);
            });
        });

        this.initScrollArrows();
        this.updateScrollArrows();
    }

    createRailSection(rail, railIndex) {
        const title = this.railTitle(rail);
        const subtitle = this.railSubtitle(rail);
        const id = `home-rail-${this.slug(String(rail.id || railIndex))}`;

        return `
            <section class="dashboard-section home-rail-section" data-rail-id="${this.escapeAttr(rail.id || id)}">
                <div class="section-header home-rail-header">
                    <div>
                        <h2>${this.escapeHtml(title)}</h2>
                        ${subtitle ? `<p class="home-rail-subtitle">${this.escapeHtml(subtitle)}</p>` : ''}
                    </div>
                </div>
                ${this.scrollSection(id, 'Loading...', '', rail.items.map((item, itemIndex) => this.createRailCard(item, railIndex, itemIndex)).join(''))}
            </section>
        `;
    }

    railTitle(rail = {}) {
        const id = String(rail.id || '').toLowerCase();
        if (id === 'recently-added-movies') return 'Films recemment ajoutes';
        if (id === 'recently-added-series') return 'Series recemment ajoutees';
        if (id === 'action-movies') return "Films d'action";
        if (id === 'popular-movies') return 'Films populaires';
        if (id === 'popular-series') return 'Series populaires';
        if (id.startsWith('because-you-watched')) return 'Parce que vous avez regarde';
        return rail.title || rail.name || 'Selection Norva';
    }

    railSubtitle(rail = {}) {
        const id = String(rail.id || '').toLowerCase();
        if (id.startsWith('because-you-watched')) return 'Suggestions basees sur votre historique';
        if (id === 'action-movies') return 'Titres verifies avec genres enrichis';
        if (id === 'popular-movies') return 'Titres verifies avec les meilleures notes';
        return '';
    }

    createRailCard(item, railIndex, itemIndex) {
        const data = item.data || {};
        const itemId = item.item_id || item.itemId || item.id || '';
        const type = item.item_type || item.itemType || item.type || 'movie';
        const title = this.displayTitle(item);
        const posterUrl = this.resolveImageUrl(this.posterFromItem(item), '/img/norva-media-placeholder.png');
        const meta = this.cardMeta(item);
        const variantCount = Number(item.variantCount || item.variant_count || data.variantCount || 0);

        return `
            <div class="dashboard-card" data-id="${this.escapeAttr(itemId)}" data-type="${this.escapeAttr(type)}" data-rail-index="${railIndex}" data-item-index="${itemIndex}">
                <div class="card-image">
                    <img src="${this.escapeAttr(posterUrl)}" alt="${this.escapeAttr(title)}" loading="lazy" onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'">
                    ${variantCount > 1 ? `<div class="home-card-badge">${variantCount} versions</div>` : ''}
                    <div class="play-icon-overlay">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                </div>
                <div class="card-info">
                    <div class="card-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
                    <div class="card-subtitle">${this.escapeHtml(meta || this.typeLabel(type))}</div>
                </div>
            </div>
        `;
    }

    cardMeta(item = {}) {
        const data = item.data || {};
        const metadata = item.metadata || {};
        const year = item.year || data.year || data.releaseYear || metadata.year;
        const rating = item.rating || data.rating || data.voteAverage || metadata.rating;
        const genres = this.genreList(item).slice(0, 2);
        return [year, ...genres, rating ? `Note ${String(rating).slice(0, 3)}` : ''].filter(Boolean).join(' - ');
    }

    genreList(item = {}) {
        const data = item.data || {};
        const metadata = item.metadata || {};
        const raw = item.genres || data.genres || metadata.genres || [];
        if (Array.isArray(raw)) {
            return raw.map(genre => typeof genre === 'string' ? genre : (genre.name || genre.label || '')).filter(Boolean);
        }
        return String(raw || '').split(',').map(value => value.trim()).filter(Boolean);
    }

    typeLabel(type) {
        return type === 'series' ? 'Series' : type === 'channel' ? 'Live TV' : 'Movie';
    }

    getResumeOffset(progress, duration = 0) {
        const position = Math.max(0, Math.floor(Number(progress) || 0));
        const total = Math.max(0, Math.floor(Number(duration) || 0));
        if (position < 12) return 0;
        if (total > 0 && position >= total * 0.95) return 0;
        return Math.max(0, position - 3);
    }

    renderHistory(items) {
        const list = document.getElementById('continue-watching-list');
        const section = document.getElementById('continue-watching-section');
        if (!list || !section) return;

        this.historyItems = (items || []).filter(item => {
            const data = item.data || {};
            const progress = item.progress || item.progress_seconds || data.progress || 0;
            const duration = item.duration || item.duration_seconds || data.duration || 0;
            return this.getResumeOffset(progress, duration) > 0;
        });

        if (!this.historyItems.length) {
            section.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');
        list.innerHTML = this.historyItems.map((item, index) => this.createHistoryCard(item, index)).join('');

        list.querySelectorAll('.dashboard-card').forEach(card => {
            card.addEventListener('click', () => {
                const item = this.historyItems[Number(card.dataset.historyIndex)];
                if (item) this.openRailItem(item, true);
            });
        });

        this.updateScrollArrows();
    }

    createHistoryCard(item, index) {
        const data = item.data || {};
        const progress = Number(item.progress || item.progress_seconds || data.progress || 0);
        const duration = Number(item.duration || item.duration_seconds || data.duration || 0);
        const percent = duration > 0 ? Math.min(100, Math.round((progress / duration) * 100)) : 0;
        const itemId = item.item_id || item.itemId || item.id || '';
        const type = item.item_type || item.itemType || item.type || 'movie';
        const title = this.displayTitle(item);
        const subtitle = data.subtitle || this.typeLabel(type);
        const posterUrl = this.resolveImageUrl(this.posterFromItem(item), '/img/norva-media-placeholder.png');

        return `
            <div class="dashboard-card" data-id="${this.escapeAttr(itemId)}" data-type="${this.escapeAttr(type)}" data-history-index="${index}">
                <div class="card-image">
                    <img src="${this.escapeAttr(posterUrl)}" alt="${this.escapeAttr(title)}" loading="lazy" onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'">
                    <div class="progress-bar-container">
                        <div class="progress-bar" style="width: ${percent}%"></div>
                    </div>
                    <div class="play-icon-overlay">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                </div>
                <div class="card-info">
                    <div class="card-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
                    <div class="card-subtitle">${this.escapeHtml(subtitle)}</div>
                </div>
            </div>
        `;
    }

    openRailItem(item, isResume = false) {
        const type = item.item_type || item.itemType || item.type;
        if (type === 'series' && !isResume) {
            this.navigateToSeries(item);
            return;
        }
        if (type === 'channel') {
            this.playChannel(item.item_id || item.streamId || item.stream_id, item.source_id || item.sourceId);
            return;
        }
        this.playItem(item, isResume);
    }

    async renderFavoriteChannels() {
        const list = document.getElementById('favorite-channels-list');
        const section = document.getElementById('favorite-channels-section');
        if (!list || !section) return;

        try {
            const favorites = await window.API.request('GET', '/favorites?itemType=channel');

            if (!favorites || favorites.length === 0) {
                section.classList.add('hidden');
                return;
            }

            const channelList = this.app.channelList;
            if (!channelList.channels || channelList.channels.length === 0) {
                await channelList.loadSources();
                await channelList.loadChannels();
            }

            const channels = [];
            for (const fav of favorites) {
                const channel = channelList.channels.find(ch =>
                    String(ch.sourceId) === String(fav.source_id) &&
                    (String(ch.id) === String(fav.item_id) || String(ch.streamId) === String(fav.item_id))
                );
                if (channel) channels.push({ ...channel, favoriteId: fav.id });
            }

            if (!channels.length) {
                section.classList.add('hidden');
                return;
            }

            section.classList.remove('hidden');
            list.innerHTML = channels.map(ch => this.createChannelTile(ch)).join('');

            list.querySelectorAll('.channel-tile').forEach(tile => {
                tile.addEventListener('click', () => {
                    this.playChannel(tile.dataset.channelId, tile.dataset.sourceId);
                });
            });

            this.updateScrollArrows();
        } catch (err) {
            console.error('[Dashboard] Error loading favorite channels:', err);
            section.classList.add('hidden');
        }
    }

    createChannelTile(channel) {
        const logoUrl = this.getChannelLogoSrc(channel);
        const fallbackLogo = this.getChannelLogoFallback(channel);
        const name = channel.name || 'Unknown';

        return `
            <div class="channel-tile" data-channel-id="${this.escapeAttr(channel.id)}" data-source-id="${this.escapeAttr(channel.sourceId)}">
                <div class="tile-logo">
                    <img src="${this.escapeAttr(logoUrl)}" alt="${this.escapeAttr(name)}" loading="lazy" onerror="this.onerror=null;this.src='${this.escapeAttr(fallbackLogo)}'">
                </div>
                <div class="tile-name" title="${this.escapeHtml(name)}">${this.escapeHtml(name)}</div>
            </div>
        `;
    }

    getChannelLogoSrc(channel) {
        if (this.app?.channelList?.getChannelLogoSrc) {
            return this.app.channelList.getChannelLogoSrc(channel);
        }
        const raw = channel?.tvgLogo || channel?.stream_icon || channel?.poster_url || channel?.logo;
        if (this.isKnownBrokenLogoUrl(raw)) return this.getChannelLogoFallback(channel);
        return raw ? this.resolveImageUrl(raw, '/img/placeholder.png') : this.getChannelLogoFallback(channel);
    }

    isKnownBrokenLogoUrl(url) {
        try {
            const host = new URL(String(url || '')).hostname.toLowerCase();
            return host === 'aptvpix.net' || host.endsWith('.aptvpix.net');
        } catch (_) {
            return false;
        }
    }

    getChannelLogoFallback(channel) {
        if (this.app?.channelList?.getChannelLogoFallback) {
            return this.app.channelList.getChannelLogoFallback(channel);
        }
        const label = channel?.name || channel?.title || 'TV';
        const clean = String(label || 'TV').replace(/\s+/g, ' ').trim();
        const initials = clean
            .split(/[^A-Za-z0-9]+/)
            .filter(Boolean)
            .slice(0, 2)
            .map(part => part.slice(0, 2).toUpperCase())
            .join('') || 'TV';
        const hue = Array.from(clean).reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
        const title = clean.length > 18 ? `${clean.slice(0, 17)}...` : clean;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <defs>
    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue}, 82%, 58%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 70) % 360}, 78%, 46%)"/>
    </linearGradient>
  </defs>
  <rect width="96" height="96" rx="20" fill="#101522"/>
  <rect x="4" y="4" width="88" height="88" rx="18" fill="url(#g)" opacity=".22"/>
  <text x="48" y="46" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#f8fbff">${this.escapeSvgText(initials)}</text>
  <text x="48" y="67" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="10" font-weight="700" fill="#cfd8ff">${this.escapeSvgText(title)}</text>
</svg>`;
        return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
    }

    playChannel(channelId, sourceId) {
        this.app.navigateTo('live');
        setTimeout(() => {
            const channelList = this.app.channelList;
            if (!channelList) return;
            const channel = channelList.channels.find(ch =>
                String(ch.id) === String(channelId) && String(ch.sourceId) === String(sourceId)
            );
            if (channel) {
                channelList.selectChannel({
                    channelId: channel.id,
                    sourceId: channel.sourceId,
                    sourceType: channel.sourceType,
                    streamId: channel.streamId || '',
                    url: channel.url || ''
                });
            }
        }, 100);
    }

    navigateToSeries(item) {
        if (!this.app.pages.series) return;
        const data = item.data || {};
        const sourceId = item.source_id || item.sourceId || data.sourceId;
        const series = {
            series_id: item.item_id || item.itemId || item.series_id,
            sourceId,
            name: this.displayTitle(item),
            cover: item.stream_icon || item.cover || data.poster || data.posterUrl || null,
            plot: data.description || data.plot || item.plot || '',
            year: data.year || item.year || ''
        };

        this.app.navigateTo('series');
        setTimeout(() => {
            this.app.pages.series.showSeriesDetails(series);
        }, 100);
    }

    posterFromItem(item = {}) {
        const data = item.data || {};
        const metadata = item.metadata || {};
        return item.stream_icon
            || item.cover
            || item.poster
            || item.poster_url
            || item.posterUrl
            || data.poster
            || data.posterUrl
            || data.poster_url
            || data.cover
            || data.stream_icon
            || metadata.poster
            || metadata.posterUrl
            || this.tmdbImagePath(data.poster_path || metadata.poster_path || item.poster_path, 'w342')
            || (typeof MediaUtils !== 'undefined' ? MediaUtils.tmdbPosterUrl(item.tmdb || data.tmdb) : null);
    }

    displayTitle(item = {}) {
        const data = item.data || {};
        const metadata = item.metadata || {};
        const tmdb = data.tmdb || metadata.tmdb || item.tmdb || {};
        return this.rawDisplayTitle(item) || 'Norva';
    }

    hasUsefulDisplayTitle(item = {}) {
        return Boolean(this.rawDisplayTitle(item));
    }

    rawDisplayTitle(item = {}) {
        const data = item.data || {};
        const metadata = item.metadata || {};
        const tmdb = data.tmdb || metadata.tmdb || item.tmdb || {};
        return this.firstUsefulTitle(
            data.title,
            metadata.title,
            tmdb.title,
            tmdb.name,
            tmdb.original_title,
            tmdb.original_name,
            item.title,
            item.name,
            item.item_name,
            item.original_title,
            item.defaultVariant?.title,
            item.defaultVariant?.name,
            item.defaultVariant?.raw_title,
            item.defaultVariant?.rawTitle
        );
    }

    firstUsefulTitle(...values) {
        for (const value of values) {
            const title = String(value ?? '').replace(/\s+/g, ' ').trim();
            if (!title) continue;
            if (['0', 'null', 'undefined', 'unknown', 'unknown title', 'norva'].includes(title.toLowerCase())) continue;
            return title;
        }
        return '';
    }

    resolveImageUrl(value, fallback) {
        const raw = String(value || '').trim();
        if (!raw) return fallback;
        if (raw.startsWith('/')) return raw;
        if (/^https?:\/\//i.test(raw)) {
            if (window.API?.isCloudMode?.() && window.NorvaCloud?.imageUrl) {
                return window.NorvaCloud.imageUrl(raw);
            }
            return this.shouldProxyImages(raw) ? `/api/proxy/image?url=${encodeURIComponent(raw)}` : raw;
        }
        return raw;
    }

    shouldProxyImages(url = '') {
        try {
            return window.location.protocol === 'https:' && String(url).startsWith('http://');
        } catch (_) {
            return false;
        }
    }

    slug(value) {
        return String(value || 'rail').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rail';
    }

    escapeSvgText(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    escapeAttr(value) {
        return this.escapeHtml(value).replace(/`/g, '&#096;');
    }

    escapeHtml(value) {
        if (typeof MediaUtils !== 'undefined' && MediaUtils.escapeHtml) {
            return MediaUtils.escapeHtml(value || '');
        }
        return String(value || '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    async playItem(item, isResume = false) {
        if (!this.app.pages.watch) return;

        try {
            const data = item.data || {};
            const type = item.item_type || item.itemType || item.type;
            const streamType = type === 'movie' ? 'movie' : 'series';
            const sourceId = item.source_id || item.sourceId || data.sourceId;
            const streamId = item.item_id || item.itemId || item.stream_id || item.streamId || item.series_id;
            const container = item.container_extension || item.containerExtension || data.containerExtension || 'mp4';
            const resumeOffset = isResume
                ? this.getResumeOffset(
                    item.progress || item.progress_seconds || data.progress || 0,
                    item.duration || item.duration_seconds || data.duration || 0
                )
                : 0;
            const playbackPreferences = isResume
                ? (data.playbackPreferences || data.playback_preferences || null)
                : null;

            if (!sourceId || !streamId) {
                throw new Error('Missing source or stream identifier');
            }

            const playbackHint = MediaUtils.playbackHintFromItem
                ? MediaUtils.playbackHintFromItem(item, { container })
                : { container };
            if (resumeOffset > 0) {
                playbackHint.seekOffset = resumeOffset;
                playbackHint.startOffset = resumeOffset;
                playbackHint.resumeTime = resumeOffset;
            }
            const audioStreamIndex = Number(playbackPreferences?.audio?.streamIndex ?? playbackPreferences?.audio?.stream_index);
            if (Number.isInteger(audioStreamIndex)) {
                playbackHint.audioStreamIndex = audioStreamIndex;
            }

            const result = await window.API.proxy.xtream.getStreamUrl(
                sourceId,
                streamId,
                streamType,
                container,
                playbackHint
            );

            if (result && result.url) {
                const content = {
                    id: streamId,
                    type,
                    title: this.displayTitle(item),
                    subtitle: data.subtitle || this.typeLabel(type),
                    poster: item.stream_icon || item.poster_url || item.posterUrl || data.poster || data.posterUrl,
                    sourceId,
                    cloudSourceId: item.cloudSourceId || data.cloudSourceId || null,
                    resumeTime: resumeOffset,
                    playbackPreferences,
                    containerExtension: container,
                    cloudPlaybackSessionId: result.sessionId,
                    titleId: data.titleId || item.titleId || item.title_id || null,
                    variantCount: item.variantCount || item.variant_count || data.variantCount || 1,
                    defaultVariant: item.defaultVariant || item.default_variant || null
                };

                if (type === 'episode' && item.data) {
                    content.seriesId = item.data.seriesId || null;
                    content.currentSeason = item.data.currentSeason || null;
                    content.currentEpisode = item.data.currentEpisode || null;

                    if (content.seriesId && sourceId) {
                        try {
                            const seriesInfo = await window.API.request('GET', `/proxy/xtream/${sourceId}/series_info?series_id=${content.seriesId}`);
                            if (seriesInfo) content.seriesInfo = seriesInfo;
                        } catch (e) {
                            console.warn('[Dashboard] Could not fetch seriesInfo for next episode:', e);
                        }
                    }
                }

                this.app.navigateTo('watch');
                this.app.pages.watch.play(content, result.url, { ...result, seekOffset: resumeOffset, startOffset: resumeOffset });
            }
        } catch (err) {
            console.error('[Dashboard] Playback failed:', err);
        }
    }
}

window.HomePage = HomePage;
