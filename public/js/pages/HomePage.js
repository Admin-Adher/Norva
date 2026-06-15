/**
 * Home Dashboard Page
 * Features "Continue Watching" and "Recently Added" content
 */
class HomePage {
    constructor(app) {
        this.app = app;
        this.container = null; // Will be set in renderLayout
        this.isLoading = false;
        this.loadPromise = null;
        this.lastLoadedAt = 0;
        this.dashboardTtlMs = 60000;
    }

    async init() {
        // Initialization if needed
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
                <section class="dashboard-section" id="favorite-channels-section">
                    <div class="section-header">
                        <h2>Favorite Channels</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll channel-tiles" id="favorite-channels-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Loading favorites...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <section class="dashboard-section" id="continue-watching-section">
                    <div class="section-header">
                        <h2>Continue Watching</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="continue-watching-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Loading history...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <section class="dashboard-section">
                    <div class="section-header">
                        <h2>Recently Added Movies</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="recent-movies-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Loading recently added...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <section class="dashboard-section">
                    <div class="section-header">
                        <h2>Recently Added Series</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="recent-series-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Loading recently added...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>
            </div>
        `;
        this.container = document.getElementById('home-content');

        // Attach scroll arrow handlers
        this.initScrollArrows();
    }

    initScrollArrows() {
        this.container.querySelectorAll('.scroll-wrapper').forEach(wrapper => {
            const scrollContainer = wrapper.querySelector('.horizontal-scroll');
            const leftBtn = wrapper.querySelector('.scroll-left');
            const rightBtn = wrapper.querySelector('.scroll-right');

            if (!scrollContainer || !leftBtn || !rightBtn) return;

            const scrollAmount = 300; // pixels to scroll per click

            leftBtn.addEventListener('click', () => {
                scrollContainer.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
            });

            rightBtn.addEventListener('click', () => {
                scrollContainer.scrollBy({ left: scrollAmount, behavior: 'smooth' });
            });

            // Update arrow visibility based on scroll position
            const updateArrows = () => {
                const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
                leftBtn.classList.toggle('hidden', scrollLeft <= 0);
                rightBtn.classList.toggle('hidden', scrollLeft + clientWidth >= scrollWidth - 5);
            };

            // Store reference for later updates
            wrapper._updateArrows = updateArrows;

            scrollContainer.addEventListener('scroll', updateArrows);
            // Initial check after content loads
            setTimeout(updateArrows, 100);
        });
    }

    /**
     * Re-check scroll arrow visibility for all sections
     * Call this after dynamically loading content
     */
    updateScrollArrows() {
        this.container?.querySelectorAll('.scroll-wrapper').forEach(wrapper => {
            if (wrapper._updateArrows) {
                wrapper._updateArrows();
            }
        });
    }


    async loadDashboardData() {
        if (this.isLoading) return this.loadPromise;
        this.isLoading = true;

        this.loadPromise = (async () => {
            try {
                const historyPromise = window.API.request('GET', '/history?limit=12');
                const recentMoviesPromise = this.renderRecentMovies();
                const recentSeriesPromise = this.renderRecentSeries();
                const favoriteChannelsPromise = this.renderFavoriteChannels();

                try {
                    const history = await historyPromise;
                    if (history && Array.isArray(history)) {
                        this.renderHistory(history);
                    }
                } catch (err) {
                    console.error('[Dashboard] Error loading history:', err);
                }

                await Promise.allSettled([
                    recentMoviesPromise,
                    recentSeriesPromise,
                    favoriteChannelsPromise
                ]);

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

    async renderFavoriteChannels() {
        const list = document.getElementById('favorite-channels-list');
        const section = document.getElementById('favorite-channels-section');
        if (!list || !section) return;

        try {
            // Fetch favorite channels for current user
            const favorites = await window.API.request('GET', '/favorites?itemType=channel');

            if (!favorites || favorites.length === 0) {
                list.innerHTML = '<div class="empty-state hint">Add channels to favorites from Live TV</div>';
                return;
            }

            // Ensure channel list is loaded to resolve channel details
            const channelList = this.app.channelList;
            if (!channelList.channels || channelList.channels.length === 0) {
                await channelList.loadSources();
                await channelList.loadChannels();
            }

            // Match favorites to channel data
            const channels = [];
            for (const fav of favorites) {
                // Find channel in loaded channel list
                const channel = channelList.channels.find(ch =>
                    String(ch.sourceId) === String(fav.source_id) &&
                    (String(ch.id) === String(fav.item_id) || String(ch.streamId) === String(fav.item_id))
                );
                if (channel) {
                    channels.push({ ...channel, favoriteId: fav.id });
                }
            }

            if (channels.length === 0) {
                list.innerHTML = '<div class="empty-state hint">Add channels to favorites from Live TV</div>';
                return;
            }

            // Render channel tiles
            list.innerHTML = channels.map(ch => this.createChannelTile(ch)).join('');

            // Attach click handlers
            list.querySelectorAll('.channel-tile').forEach(tile => {
                tile.addEventListener('click', () => {
                    const channelId = tile.dataset.channelId;
                    const sourceId = tile.dataset.sourceId;
                    this.playChannel(channelId, sourceId);
                });
            });

            // Update scroll arrows after content renders
            this.updateScrollArrows();

        } catch (err) {
            console.error('[Dashboard] Error loading favorite channels:', err);
            list.innerHTML = '<div class="empty-state hint">Error loading favorites</div>';
        }
    }

    createChannelTile(channel) {
        const logoUrl = this.getChannelLogoSrc(channel);
        const fallbackLogo = this.getChannelLogoFallback(channel);
        const name = channel.name || 'Unknown';

        return `
            <div class="channel-tile" data-channel-id="${channel.id}" data-source-id="${channel.sourceId}">
                <div class="tile-logo">
                    <img src="${this.escapeHtml(logoUrl)}" alt="${this.escapeHtml(name)}" loading="lazy" onerror="this.onerror=null;this.src='${this.escapeHtml(fallbackLogo)}'">
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
        // Navigate to Live TV and select the channel
        this.app.navigateTo('live');

        // Small delay to ensure page is ready
        setTimeout(() => {
            const channelList = this.app.channelList;
            if (channelList) {
                // Find and select the channel
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
            }
        }, 100);
    }

    renderHistory(items) {
        const list = document.getElementById('continue-watching-list');
        const section = document.getElementById('continue-watching-section');

        if (!list || !section) return;

        if (items.length === 0) {
            section.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');
        list.innerHTML = items.map(item => this.createCard(item)).join('');

        // Attach click listeners
        list.querySelectorAll('.dashboard-card').forEach(card => {
            card.addEventListener('click', () => {
                const id = card.dataset.id;
                const item = items.find(i => i.item_id === id);
                if (item) {
                    const type = item.item_type || item.type;

                    // IF it's a series, checking details is better than blind resume
                    // BUT for "Continue Watching", we ideally want to resume

                    // Prioritize playing directly for resume tiles
                    this.playItem(item, true); // true for resume
                }
            });
        });

        // Update scroll arrows after content renders
        this.updateScrollArrows();
    }

    navigateToSeries(item) {
        if (!this.app.pages.series) return;

        // Prepare the series object as expected by SeriesPage.showSeriesDetails
        const series = {
            series_id: item.item_id,
            sourceId: item.source_id,
            name: item.name || (item.data ? item.data.title : 'Series'),
            cover: item.stream_icon || (item.data ? item.data.poster : null),
            plot: item.data ? item.data.description : '',
            year: item.data ? item.data.year : ''
        };

        // Switch page
        this.app.navigateTo('series');

        // Show details (delay slightly to ensure page is visible)
        setTimeout(() => {
            this.app.pages.series.showSeriesDetails(series);
        }, 100);
    }

    async renderRecentMovies() {
        const list = document.getElementById('recent-movies-list');
        if (!list) return;

        try {
            const movies = await window.API.request('GET', '/channels/recent?type=movie&limit=12');
            if (!movies || movies.length === 0) {
                list.innerHTML = '<div class="empty-state hint">No recently added movies found</div>';
                return;
            }

            list.innerHTML = movies.map(item => this.createRecentCard(item)).join('');

            // Attach listeners
            list.querySelectorAll('.dashboard-card').forEach(card => {
                card.addEventListener('click', () => {
                    const id = card.dataset.id;
                    const item = movies.find(m => m.item_id === id);
                    if (item) this.playItem(item);
                });
            });

            // Update scroll arrows after content renders
            this.updateScrollArrows();
        } catch (err) {
            console.error('[Dashboard] Error loading recent movies:', err);
        }
    }

    async renderRecentSeries() {
        const list = document.getElementById('recent-series-list');
        if (!list) return;

        try {
            const series = await window.API.request('GET', '/channels/recent?type=series&limit=12');
            if (!series || series.length === 0) {
                list.innerHTML = '<div class="empty-state hint">No recently added series found</div>';
                return;
            }

            list.innerHTML = series.map(item => this.createRecentCard(item)).join('');

            // Attach listeners
            list.querySelectorAll('.dashboard-card').forEach(card => {
                card.addEventListener('click', () => {
                    const id = card.dataset.id;
                    const item = series.find(s => s.item_id === id);
                    if (item) this.navigateToSeries(item);
                });
            });

            // Update scroll arrows after content renders
            this.updateScrollArrows();
        } catch (err) {
            console.error('[Dashboard] Error loading recent series:', err);
        }
    }

    createCard(item) {
        const data = item.data || {};
        const { progress, duration, item_id } = item;
        const type = item.item_type || item.type;
        const percent = duration > 0 ? Math.min(100, Math.round((progress / duration) * 100)) : 0;
        const title = item.name || item.title || data.title || 'Unknown Title';
        const subtitle = data.subtitle || (type === 'movie' ? 'Movie' : 'Series');
        const posterUrl = this.resolveImageUrl(this.posterFromItem(item), '/img/norva-media-placeholder.png');


        return `
            <div class="dashboard-card" data-id="${item_id}" data-type="${type}">
                <div class="card-image">
                    <img src="${this.escapeHtml(posterUrl)}" alt="${this.escapeHtml(title)}" loading="lazy" onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'">
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

    createRecentCard(item) {
        const data = item.data || {};
        const { item_id } = item;
        const type = item.type || item.item_type;
        const title = item.name || item.title || data.title || 'Unknown Title';
        const subtitle = data.subtitle || (type === 'movie' ? 'Movie' : 'Series');
        const posterUrl = this.resolveImageUrl(this.posterFromItem(item), '/img/norva-media-placeholder.png');

        return `
            <div class="dashboard-card" data-id="${item_id}" data-type="${type}">
                <div class="card-image">
                    <img src="${this.escapeHtml(posterUrl)}" alt="${this.escapeHtml(title)}" loading="lazy" onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'">
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

    posterFromItem(item = {}) {
        const data = item.data || {};
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
            || (typeof MediaUtils !== 'undefined' ? MediaUtils.tmdbPosterUrl(item.tmdb || data.tmdb) : null);
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

    escapeSvgText(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
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
            const type = item.item_type || item.type;
            const streamType = type === 'movie' ? 'movie' : 'series';
            const sourceId = item.source_id || (item.data && item.data.sourceId);
            const streamId = item.item_id;
            const container = item.container_extension || (item.data && item.data.containerExtension) || 'mp4';

            const result = await window.API.request('GET', `/proxy/xtream/${sourceId}/stream/${streamId}/${streamType}?container=${container}`);

            if (result && result.url) {
                const content = {
                    id: item.item_id,
                    type: type,
                    title: item.name || item.data.title,
                    subtitle: item.data.subtitle || (type === 'movie' ? 'Movie' : 'Series'),
                    poster: item.stream_icon || item.data.poster,
                    sourceId: sourceId,
                    resumeTime: isResume ? item.progress : 0,
                    containerExtension: container,
                    cloudPlaybackSessionId: result.sessionId
                };

                // For episodes, try to restore series data for next episode functionality
                if (type === 'episode' && item.data) {
                    content.seriesId = item.data.seriesId || null;
                    content.currentSeason = item.data.currentSeason || null;
                    content.currentEpisode = item.data.currentEpisode || null;

                    // Fetch seriesInfo if we have a seriesId
                    if (content.seriesId && sourceId) {
                        try {
                            const seriesInfo = await window.API.request('GET', `/proxy/xtream/${sourceId}/series_info?series_id=${content.seriesId}`);
                            if (seriesInfo) {
                                content.seriesInfo = seriesInfo;
                            }
                        } catch (e) {
                            console.warn('[Dashboard] Could not fetch seriesInfo for next episode:', e);
                        }
                    }
                }

                // Switch to watch page
                this.app.navigateTo('watch');

                this.app.pages.watch.play(content, result.url, { sessionId: result.sessionId });
            }
        } catch (err) {
            console.error('[Dashboard] Playback failed:', err);
        }
    }
}

window.HomePage = HomePage;
