/**
 * Series Page Controller
 * Handles TV series browsing and playback with rich filtering,
 * duplicate grouping (one card per title) and version selection.
 */

class SeriesPage {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('series-grid');
        this.sourceSelect = document.getElementById('series-source-select');
        this.searchInput = document.getElementById('series-search');
        this.detailsPanel = document.getElementById('series-details');
        this.seasonsContainer = document.getElementById('series-seasons');

        // Filter bar elements
        this.sortSelect = document.getElementById('series-sort');
        this.genreSelect = document.getElementById('series-genre');
        this.yearSelect = document.getElementById('series-year');
        this.ratingSelect = document.getElementById('series-rating');
        this.watchedSelect = document.getElementById('series-watched');
        this.addedSelect = document.getElementById('series-added');
        this.statusSelect = document.getElementById('series-status');
        this.groupToggleBtn = document.getElementById('series-group-toggle');
        this.hideBrokenBtn = document.getElementById('series-hide-broken-btn');
        this.randomBtn = document.getElementById('series-random');
        this.countEl = document.getElementById('series-count');
        this.resetBtn = document.getElementById('series-reset');
        this.continueRow = document.getElementById('series-continue');
        this.continueList = document.getElementById('series-continue-list');

        this.seriesList = [];
        this.categories = [];
        this.sources = [];
        this.currentBatch = 0;
        this.batchSize = 24;
        this.filteredCards = [];
        this.isLoading = false;
        this.cloudLoadingMore = false;
        this.cloudHasMore = false;
        this.cloudOffset = 0;
        this.cloudTotal = null;
        this.cloudPageSize = 120;
        this.cloudRequestId = 0;
        this.observer = null;
        this.hiddenCategoryIds = new Set();
        this.currentSeries = null;
        this.favoriteIds = new Set();
        this.showFavoritesOnly = false;
        this.groupDuplicates = true;
        this.hideBroken = true;
        this.startedSeriesIds = new Set(); // series with at least one episode in history
        this.historyItems = [];
        this.serverSettings = {};

        this.restoreFilters();
        this.init();
    }

    init() {
        this.categoryMulti = new MultiSelect({
            btnId: 'series-category-btn',
            panelId: 'series-category-panel',
            searchId: 'series-category-search',
            listId: 'series-category-list',
            allLabel: 'All Categories',
            onChange: () => this.onFiltersChanged()
        });

        this.sourceSelect?.addEventListener('change', async () => {
            await this.loadCategories();
            await this.loadPlaybackStatuses();
            await this.loadSeries();
        });

        let searchTimeout;
        this.searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.onFiltersChanged(), 300);
        });

        [this.sortSelect, this.genreSelect, this.yearSelect, this.ratingSelect,
         this.watchedSelect, this.addedSelect, this.statusSelect].forEach(sel => {
            sel?.addEventListener('change', () => this.onFiltersChanged());
        });

        this.groupToggleBtn?.addEventListener('click', () => {
            this.groupDuplicates = !this.groupDuplicates;
            this.groupToggleBtn.classList.toggle('active', this.groupDuplicates);
            this.onFiltersChanged();
        });

        this.hideBrokenBtn?.addEventListener('click', () => {
            this.hideBroken = !this.hideBroken;
            this.hideBrokenBtn.classList.toggle('active', this.hideBroken);
            this.onFiltersChanged();
        });

        this.randomBtn?.addEventListener('click', () => this.openRandom());
        this.resetBtn?.addEventListener('click', () => this.resetFilters());

        document.querySelector('.series-back-btn')?.addEventListener('click', () => {
            this.hideDetails();
        });

        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this.isLoading) {
                this.renderNextBatch();
            }
        }, { rootMargin: '200px' });

        const favBtn = document.getElementById('series-favorites-btn');
        favBtn?.addEventListener('click', () => {
            this.showFavoritesOnly = !this.showFavoritesOnly;
            favBtn.classList.toggle('active', this.showFavoritesOnly);
            this.onFiltersChanged();
        });

        // When a previously-broken series plays successfully, remove the HS mark
        // immediately so it reappears if "hide broken" is active — no page reload needed.
        window.addEventListener('playbackStatusChanged', (e) => {
            const d = e.detail;
            if (d && d.status === 'ok' && (d.item_type === 'series' || d.itemType === 'series')) {
                if (this.hideBroken) this.filterAndRender();
            }
        });

        this.applyFiltersToUI();
    }

    // === Filter persistence ===

    restoreFilters() {
        const saved = MediaUtils.loadFilters('series') || {};
        this.savedFilters = saved;
        this.groupDuplicates = saved.group !== undefined ? saved.group : true;
        this.showFavoritesOnly = !!saved.favoritesOnly;
        this.hideBroken = saved.hideBroken !== undefined ? saved.hideBroken : true;
    }

    applyFiltersToUI() {
        const s = this.savedFilters || {};
        if (this.sortSelect && s.sort) this.sortSelect.value = s.sort;
        if (this.yearSelect && s.year) this.yearSelect.value = s.year;
        if (this.ratingSelect && s.rating) this.ratingSelect.value = s.rating;
        if (this.watchedSelect && s.watched) this.watchedSelect.value = s.watched;
        if (this.addedSelect && s.added) this.addedSelect.value = s.added;
        if (this.searchInput && s.search) this.searchInput.value = s.search;
        this.groupToggleBtn?.classList.toggle('active', this.groupDuplicates);
        this.hideBrokenBtn?.classList.toggle('active', this.hideBroken);
        document.getElementById('series-favorites-btn')?.classList.toggle('active', this.showFavoritesOnly);
    }

    persistFilters() {
        MediaUtils.saveFilters('series', {
            sort: this.sortSelect?.value || 'default',
            genre: this.genreSelect?.value || '',
            year: this.yearSelect?.value || '',
            rating: this.ratingSelect?.value || '',
            watched: this.watchedSelect?.value || '',
            added: this.addedSelect?.value || '',
            status: this.statusSelect?.value || '',
            search: this.searchInput?.value || '',
            group: this.groupDuplicates,
            hideBroken: this.hideBroken,
            favoritesOnly: this.showFavoritesOnly,
            categories: [...(this.categoryMulti?.getSelected() || [])]
        });
    }

    onFiltersChanged() {
        this.persistFilters();
        if (this.isCloudPagedMode()) {
            this.loadSeries();
            return;
        }
        this.filterAndRender();
    }

    resetFilters() {
        [this.sortSelect, this.genreSelect, this.yearSelect, this.ratingSelect,
         this.watchedSelect, this.addedSelect, this.statusSelect].forEach(sel => {
            if (sel) sel.value = sel.querySelector('option')?.value ?? '';
        });
        if (this.sortSelect) this.sortSelect.value = 'default';
        if (this.searchInput) this.searchInput.value = '';
        this.showFavoritesOnly = false;
        this.hideBroken = true;
        this.hideBrokenBtn?.classList.toggle('active', this.hideBroken);
        document.getElementById('series-favorites-btn')?.classList.remove('active');
        this.categoryMulti?.setSelected([]);
        this.onFiltersChanged();
    }

    hasActiveFilters() {
        return Boolean(
            (this.sortSelect?.value && this.sortSelect.value !== 'default') ||
            this.genreSelect?.value || this.yearSelect?.value || this.ratingSelect?.value ||
            this.watchedSelect?.value || this.addedSelect?.value || this.statusSelect?.value ||
            this.searchInput?.value || this.showFavoritesOnly || this.hideBroken === false ||
            (this.categoryMulti?.getSelected().size > 0)
        );
    }

    // === Page lifecycle ===

    async show() {
        this.hideDetails();

        if (this.sources.length === 0) {
            await this.loadSources();
        }

        await Promise.all([this.loadFavorites(), this.loadWatchState(), this.loadServerSettings(), this.loadPlaybackStatuses()]);
        this.renderContinueWatching();

        if (this.seriesList.length === 0) {
            await this.loadCategories();
            await this.loadSeries();
        } else {
            this.filterAndRender();
        }
    }

    hide() {
        // Page is hidden
    }

    async loadServerSettings() {
        try {
            this.serverSettings = await API.settings.get();
        } catch (err) {
            this.serverSettings = {};
        }
    }

    async loadFavorites() {
        try {
            const favs = await API.favorites.getAll(null, 'series');
            this.favoriteIds = new Set(favs.map(f => `${f.source_id}:${f.item_id}`));
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }

    async loadWatchState() {
        try {
            const history = await API.history.getAll(500);
            this.historyItems = history || [];
            this.startedSeriesIds = new Set();
            for (const h of this.historyItems) {
                if (h.item_type === 'episode' && h.data?.seriesId) {
                    this.startedSeriesIds.add(String(h.data.seriesId));
                }
            }
        } catch (err) {
            console.warn('Error loading watch history:', err);
            this.historyItems = [];
            this.startedSeriesIds = new Set();
        }
    }

    async loadPlaybackStatuses() {
        if (!window.PlaybackHealth) return;
        const sourceId = this.sourceSelect?.value || null;
        await PlaybackHealth.load({ sourceId, itemType: 'series' });
    }

    isGroupStarted(items) {
        return items.some(i => this.startedSeriesIds.has(String(i.series_id)));
    }

    async loadSources() {
        try {
            const allSources = await API.sources.getAll();
            this.sources = allSources.filter(s => s.type === 'xtream' && s.enabled);

            this.sourceSelect.innerHTML = '<option value="">All Sources</option>';
            this.sources.forEach(s => {
                const option = document.createElement('option');
                option.value = s.id;
                option.textContent = s.name;
                this.sourceSelect.appendChild(option);
            });
        } catch (err) {
            console.error('Error loading sources:', err);
        }
    }

    getSourceName(sourceId) {
        return this.sources.find(s => s.id === parseInt(sourceId))?.name || `Source ${sourceId}`;
    }

    async loadCategories() {
        if (this.isCloudPagedMode()) {
            return this.loadCloudCategories();
        }

        try {
            this.categories = [];
            this.hiddenCategoryIds = new Set();

            const sourceId = this.sourceSelect.value;
            const sourcesToLoad = sourceId
                ? this.sources.filter(s => s.id === parseInt(sourceId))
                : this.sources;

            for (const source of sourcesToLoad) {
                try {
                    const hiddenItems = await API.channels.getHidden(source.id);
                    hiddenItems.forEach(h => {
                        if (h.item_type === 'series_category') {
                            this.hiddenCategoryIds.add(`${source.id}:${h.item_id}`);
                        }
                    });
                } catch (err) {
                    console.warn(`Failed to load hidden items from source ${source.id}`);
                }
            }

            for (const source of sourcesToLoad) {
                try {
                    const cats = await API.proxy.xtream.seriesCategories(source.id);
                    if (cats && Array.isArray(cats)) {
                        cats.forEach(c => {
                            if (!this.hiddenCategoryIds.has(`${source.id}:${c.category_id}`)) {
                                this.categories.push({ ...c, sourceId: source.id });
                            }
                        });
                    }
                } catch (err) {
                    console.warn(`Failed to load series categories from source ${source.id}:`, err.message);
                }
            }

            const options = this.categories.map(c => ({
                value: `${c.sourceId}:${c.category_id}`,
                label: sourcesToLoad.length > 1
                    ? `${c.category_name} (${this.getSourceName(c.sourceId)})`
                    : c.category_name
            }));
            this.categoryMulti.setOptions(options);

            if (this.savedFilters?.categories?.length && !this._categoriesRestored) {
                this.categoryMulti.setSelected(this.savedFilters.categories);
                this._categoriesRestored = true;
            }
        } catch (err) {
            console.error('Error loading categories:', err);
        }
    }

    async loadCloudCategories() {
        try {
            this.categories = [];
            this.hiddenCategoryIds = new Set();

            const sourceId = this.sourceSelect.value;
            const sourcesToLoad = sourceId
                ? this.sources.filter(s => s.id === parseInt(sourceId))
                : this.sources;

            const loaded = [];
            for (const source of sourcesToLoad) {
                try {
                    const cats = await API.media.categories({ sourceId: source.id, type: 'series' });
                    if (Array.isArray(cats)) {
                        cats.forEach(c => loaded.push({ ...c, sourceId: c.sourceId || source.id }));
                    }
                } catch (err) {
                    console.warn(`Failed to load cloud series categories from source ${source.id}:`, err.message);
                }
            }

            this.categories = loaded;
            const options = this.categories.map(c => ({
                value: `${c.sourceId}:${c.category_id}`,
                label: sourcesToLoad.length > 1
                    ? `${c.category_name} (${this.getSourceName(c.sourceId)})`
                    : c.category_name
            }));
            this.categoryMulti.setOptions(options);

            if (this.savedFilters?.categories?.length && !this._categoriesRestored) {
                this.categoryMulti.setSelected(this.savedFilters.categories);
                this._categoriesRestored = true;
            }
        } catch (err) {
            console.error('Error loading cloud series categories:', err);
        }
    }

    async loadSeries() {
        if (this.isCloudPagedMode()) {
            return this.loadCloudSeries({ reset: true });
        }

        this.isLoading = true;
        this.container.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

        try {
            this.seriesList = [];

            const sourceId = this.sourceSelect.value;
            const sourcesToLoad = sourceId
                ? this.sources.filter(s => s.id === parseInt(sourceId))
                : this.sources;

            // Load everything once; category filtering happens client-side
            for (const source of sourcesToLoad) {
                try {
                    const series = await API.proxy.xtream.series(source.id, null);
                    console.log(`[Series] Source ${source.id}: Got ${series?.length || 0} series`);
                    if (series && Array.isArray(series)) {
                        series.forEach(s => {
                            if (this.hiddenCategoryIds.has(`${source.id}:${s.category_id}`)) return;
                            this.seriesList.push({
                                ...s,
                                sourceId: source.id,
                                id: `${source.id}:${s.series_id}`
                            });
                        });
                    }
                } catch (err) {
                    console.warn(`Failed to load series from source ${source.id}:`, err.message);
                }
            }

            console.log(`[Series] Total loaded: ${this.seriesList.length} series`);
            this.populateGenres();
            this.filterAndRender();
        } catch (err) {
            console.error('Error loading series:', err);
            this.container.innerHTML = '<div class="empty-state"><p>Error loading series</p></div>';
        } finally {
            this.isLoading = false;
        }
    }

    isCloudPagedMode() {
        try {
            return Boolean(window.API?.isCloudMode?.());
        } catch (_) {
            return false;
        }
    }

    cloudPageParams(offset = 0) {
        const selectedCats = [...(this.categoryMulti?.getSelected() || [])];
        let sourceId = this.sourceSelect?.value || '';
        let categoryId = '';

        if (selectedCats.length === 1) {
            const [selectedSourceId, selectedCategoryId] = selectedCats[0].split(':');
            categoryId = selectedCategoryId || '';
            if (!sourceId) sourceId = selectedSourceId || '';
        }

        return {
            type: 'series',
            sourceId,
            categoryId,
            q: (this.searchInput?.value || '').trim(),
            limit: this.cloudPageSize,
            offset
        };
    }

    async loadCloudSeries({ reset = false } = {}) {
        if (this.cloudLoadingMore || (this.isLoading && !reset)) return;

        if (reset) {
            this.isLoading = true;
            this.cloudRequestId += 1;
            this.cloudOffset = 0;
            this.cloudHasMore = false;
            this.cloudTotal = null;
            this.seriesList = [];
            this.filteredCards = [];
            this.currentBatch = 0;
            this.container.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
        } else {
            this.cloudLoadingMore = true;
        }

        try {
            const requestId = this.cloudRequestId;
            const renderedBefore = reset ? 0 : this.container.querySelectorAll('.series-card').length;
            const page = await API.media.page(this.cloudPageParams(this.cloudOffset));
            if (reset && requestId !== this.cloudRequestId) return;
            const incoming = (page.items || [])
                .filter(s => !this.hiddenCategoryIds.has(`${s.sourceId}:${s.category_id}`))
                .map(s => ({
                    ...s,
                    sourceId: s.sourceId,
                    id: `${s.sourceId}:${s.series_id}`
                }));

            const seen = new Set(this.seriesList.map(s => `${s.sourceId}:${s.series_id}`));
            incoming.forEach(series => {
                const key = `${series.sourceId}:${series.series_id}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    this.seriesList.push(series);
                }
            });

            this.cloudOffset = (page.offset || this.cloudOffset) + (page.items?.length || 0);
            this.cloudHasMore = Boolean(page.hasMore);
            this.cloudTotal = page.count ?? this.cloudTotal;
            this.populateGenres();

            if (reset) {
                this.filterAndRender();
            } else {
                this.filteredCards = this.buildFilteredCards();
                this.updateResultChrome(this.filteredCards);
                this.currentBatch = Math.ceil(renderedBefore / this.batchSize);
                this.renderNextBatch();
            }
        } catch (err) {
            console.error('Error loading cloud series:', err);
            if (reset) {
                this.container.innerHTML = '<div class="empty-state"><p>Error loading series</p></div>';
            }
        } finally {
            if (reset) this.isLoading = false;
            this.cloudLoadingMore = false;
        }
    }

    populateGenres() {
        if (!this.genreSelect) return;
        const genres = new Set();
        let hasStatus = false;
        for (const s of this.seriesList) {
            if (s.tmdb?.genres) s.tmdb.genres.forEach(g => genres.add(g));
            if (s.tmdb?.status) hasStatus = true;
        }

        if (genres.size === 0) {
            this.genreSelect.classList.add('hidden');
        } else {
            const current = this.savedFilters?.genre || this.genreSelect.value;
            this.genreSelect.innerHTML = '<option value="">All Genres</option>' +
                [...genres].sort().map(g =>
                    `<option value="${MediaUtils.escapeHtml(g)}">${MediaUtils.escapeHtml(g)}</option>`).join('');
            if (current && genres.has(current)) this.genreSelect.value = current;
            this.genreSelect.classList.remove('hidden');
        }

        this.statusSelect?.classList.toggle('hidden', !hasStatus);
        if (hasStatus && this.savedFilters?.status) {
            this.statusSelect.value = this.savedFilters.status;
        }
    }

    // === Filtering, grouping, sorting ===

    parseAddedMs(item) {
        const raw = item.added || item.last_modified || item.added_at;
        if (!raw) return 0;
        const num = parseInt(raw);
        if (!isNaN(num) && num > 0) {
            return num < 10000000000 ? num * 1000 : num;
        }
        const date = Date.parse(raw);
        return isNaN(date) ? 0 : date;
    }

    getItemYear(item) {
        const y = MediaUtils.extractYear(item.name, item.year || item.releaseDate);
        return y ? parseInt(y) : null;
    }

    matchesFilters(item) {
        if (this.hideBroken && this.isBrokenItem(item)) return false;

        const selectedCats = this.categoryMulti?.getSelected();
        if (selectedCats && selectedCats.size > 0 &&
            !selectedCats.has(`${item.sourceId}:${item.category_id}`)) {
            return false;
        }

        const yearFilter = this.yearSelect?.value;
        if (yearFilter) {
            const y = this.getItemYear(item);
            if (yearFilter === 'old') {
                if (!y || y >= 1990) return false;
            } else {
                const decade = parseInt(yearFilter);
                if (!y || y < decade || y >= decade + 10) return false;
            }
        }

        const minRating = parseFloat(this.ratingSelect?.value);
        if (minRating) {
            const r = parseFloat(item.rating) || (item.tmdb?.vote_average ?? 0);
            if (!r || r < minRating) return false;
        }

        const genre = this.genreSelect?.value;
        if (genre && !(item.tmdb?.genres || []).includes(genre)) return false;

        // Series status (TMDB): ended vs ongoing
        const statusFilter = this.statusSelect?.value;
        if (statusFilter) {
            const tmdbStatus = item.tmdb?.status;
            if (!tmdbStatus) return false;
            const isEnded = ['Ended', 'Canceled'].includes(tmdbStatus);
            if (statusFilter === 'ended' && !isEnded) return false;
            if (statusFilter === 'ongoing' && isEnded) return false;
        }

        const addedDays = parseInt(this.addedSelect?.value);
        if (addedDays) {
            const addedMs = this.parseAddedMs(item);
            if (!addedMs || (Date.now() - addedMs) > addedDays * 86400000) return false;
        }

        return true;
    }

    isBrokenItem(item) {
        return item?.playback_status === 'broken' ||
            window.PlaybackHealth?.isBroken(item.sourceId, 'series', item.series_id);
    }

    buildFilteredCards() {
        const searchTerm = MediaUtils.searchableText(this.searchInput?.value || '').trim();

        let items = this.seriesList.filter(s => this.matchesFilters(s));

        if (searchTerm && !this.isCloudPagedMode()) {
            items = items.filter(s =>
                MediaUtils.searchableText(s.name).includes(searchTerm) ||
                (s.tmdb?.title && MediaUtils.searchableText(s.tmdb.title).includes(searchTerm)));
        }

        let cards;
        if (this.groupDuplicates) {
            cards = MediaUtils.groupItems(items, { idField: 'series_id' });
        } else {
            cards = items.map(item => ({ key: item.id, items: [item], representative: item }));
        }

        if (this.showFavoritesOnly) {
            cards = cards.filter(c => c.items.some(i => this.favoriteIds.has(`${i.sourceId}:${i.series_id}`)));
        }

        const watchedFilter = this.watchedSelect?.value;
        if (watchedFilter === 'inprogress') {
            cards = cards.filter(c => this.isGroupStarted(c.items));
        } else if (watchedFilter === 'unwatched') {
            cards = cards.filter(c => !this.isGroupStarted(c.items));
        }

        this.sortCards(cards);
        return cards;
    }

    updateResultChrome(cards) {
        if (this.countEl) {
            let total = this.groupDuplicates ? `${cards.length} titles` : `${cards.length} series`;
            if (this.isCloudPagedMode() && this.cloudTotal !== null && !this.hasActiveFilters()) {
                total = `${this.cloudTotal} titles`;
            } else if (this.isCloudPagedMode() && this.cloudHasMore) {
                total = `${cards.length}+ titles`;
            }
            this.countEl.textContent = total;
        }
        this.resetBtn?.classList.toggle('hidden', !this.hasActiveFilters());
    }

    filterAndRender() {
        const cards = this.buildFilteredCards();
        this.filteredCards = cards;

        this.updateResultChrome(cards);

        console.log(`[Series] Displaying ${cards.length} cards from ${this.seriesList.length} series`);

        this.currentBatch = 0;
        this.container.innerHTML = '';

        if (cards.length === 0) {
            this.container.innerHTML = '<div class="empty-state"><p>No series found</p></div>';
            return;
        }

        const loader = document.createElement('div');
        loader.className = 'series-loader';
        loader.innerHTML = '<div class="loading-spinner"></div>';
        this.container.appendChild(loader);

        for (let i = 0; i < 5; i++) {
            this.renderNextBatch();
        }

        this.observer.observe(loader);
    }

    sortCards(cards) {
        const sort = this.sortSelect?.value || 'default';
        const rep = c => c.representative;
        switch (sort) {
            case 'added':
                cards.sort((a, b) => this.parseAddedMs(rep(b)) - this.parseAddedMs(rep(a)));
                break;
            case 'rating':
                cards.sort((a, b) => (parseFloat(rep(b).rating) || 0) - (parseFloat(rep(a).rating) || 0));
                break;
            case 'year':
                cards.sort((a, b) => (this.getItemYear(rep(b)) || 0) - (this.getItemYear(rep(a)) || 0));
                break;
            case 'year-asc':
                cards.sort((a, b) => (this.getItemYear(rep(a)) || 9999) - (this.getItemYear(rep(b)) || 9999));
                break;
            case 'name':
                cards.sort((a, b) => (rep(a).name || '').localeCompare(rep(b).name || ''));
                break;
            default:
                break;
        }
    }

    // === Rendering ===

    renderNextBatch() {
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        const batch = this.filteredCards.slice(start, end);

        if (batch.length === 0) {
            const loader = this.container.querySelector('.series-loader');
            if (this.isCloudPagedMode() && this.cloudHasMore && !this.cloudLoadingMore) {
                if (loader) loader.style.display = '';
                this.loadCloudSeries({ reset: false });
            } else if (loader) {
                loader.style.display = 'none';
            }
            return;
        }

        const fragment = document.createDocumentFragment();
        batch.forEach(card => fragment.appendChild(this.buildCard(card)));

        const loader = this.container.querySelector('.series-loader');
        if (loader) {
            this.container.insertBefore(fragment, loader);
        } else {
            this.container.appendChild(fragment);
        }

        this.currentBatch++;

        if (end >= this.filteredCards.length && loader && !(this.isCloudPagedMode() && this.cloudHasMore)) {
            loader.style.display = 'none';
        }
    }

    buildCard(group) {
        const series = group.representative;
        const card = document.createElement('div');
        card.className = 'series-card';
        card.dataset.seriesId = series.series_id;
        card.dataset.sourceId = series.sourceId;

        const poster = MediaUtils.safeImageUrl(
            series.cover || series.stream_icon || MediaUtils.tmdbPosterUrl(series.tmdb),
            '/img/norva-media-placeholder.png'
        );
        const year = this.getItemYear(series) || '';
        const rating = series.rating ? `${Icons.star} ${series.rating}` : '';
        const isFav = group.items.some(i => this.favoriteIds.has(`${i.sourceId}:${i.series_id}`));
        const started = this.isGroupStarted(group.items);
        const versionCount = group.items.length;
        const displayName = (this.groupDuplicates && series.tmdb?.title) ? series.tmdb.title : series.name;
        const groupBroken = group.items.every(item => this.isBrokenItem(item));

        card.innerHTML = `
            <div class="series-poster">
                <img src="${MediaUtils.escapeHtml(poster)}" alt="${MediaUtils.escapeHtml(displayName)}"
                     onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'" loading="lazy">
                <div class="series-play-overlay">
                    <span class="play-icon">${Icons.play}</span>
                </div>
                ${groupBroken ? '<span class="playback-badge" title="Playback failed">HS</span>' : ''}
                ${versionCount > 1 ? `<button class="version-badge" title="Choose version">${versionCount} versions</button>` : ''}
                ${started ? '<span class="watched-badge inprogress-badge" title="Watching">▶</span>' : ''}
                <button class="favorite-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
                    <span class="fav-icon">${isFav ? Icons.favorite : Icons.favoriteOutline}</span>
                </button>
            </div>
            <div class="series-card-info">
                <div class="series-title">${MediaUtils.escapeHtml(displayName)}</div>
                <div class="series-meta">
                    ${year ? `<span>${year}</span>` : ''}
                    ${rating ? `<span>${rating}</span>` : ''}
                    ${series.tmdb?.number_of_seasons ? `<span>${series.tmdb.number_of_seasons} seasons</span>` : ''}
                </div>
            </div>
        `;

        card.addEventListener('click', (e) => {
            if (e.target.closest('.favorite-btn')) {
                e.stopPropagation();
                this.toggleFavorite(group, e.target.closest('.favorite-btn'));
            } else if (e.target.closest('.version-badge')) {
                e.stopPropagation();
                this.showVersionPicker(group);
            } else {
                this.openGroup(group);
            }
        });

        return card;
    }

    // === Continue Watching row ===

    getResumeOffset(progress, duration = 0) {
        const position = Math.max(0, Math.floor(Number(progress) || 0));
        const total = Math.max(0, Math.floor(Number(duration) || 0));
        if (position < 12) return 0;
        if (total > 0 && position >= total * 0.95) return 0;
        return Math.max(0, position - 3);
    }

    renderContinueWatching() {
        if (!this.continueRow || !this.continueList) return;
        // Keep only the most recent episode per series
        const seen = new Set();
        const inProgress = [];
        for (const h of (this.historyItems || [])) {
            if (h.item_type !== 'episode' || !h.data?.seriesId) continue;
            if (this.getResumeOffset(h.progress, h.duration) <= 0) continue;
            const key = `${h.data.sourceId}:${h.data.seriesId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            inProgress.push(h);
            if (inProgress.length >= 12) break;
        }

        if (inProgress.length === 0) {
            this.continueRow.classList.add('hidden');
            return;
        }

        this.continueList.innerHTML = inProgress.map(h => {
            const ratio = h.duration > 0 ? Math.round((h.progress / h.duration) * 100) : 0;
            return `
            <div class="continue-card" data-item-id="${MediaUtils.escapeHtml(h.item_id)}">
                <img src="${MediaUtils.escapeHtml(MediaUtils.safeImageUrl(h.data?.poster, '/img/norva-media-placeholder.png'))}"
                     onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'" loading="lazy" alt="">
                <div class="continue-card-info">
                    <p class="continue-card-title">${MediaUtils.escapeHtml(h.data?.title || 'Unknown')}</p>
                    <p class="continue-card-subtitle">${MediaUtils.escapeHtml(h.data?.subtitle || '')}</p>
                    <div class="card-progress"><div class="card-progress-fill" style="width:${ratio}%"></div></div>
                </div>
            </div>`;
        }).join('');

        this.continueList.querySelectorAll('.continue-card').forEach(card => {
            card.addEventListener('click', () => {
                const h = inProgress.find(x => String(x.item_id) === card.dataset.itemId);
                if (h) this.resumeEpisodeFromHistory(h);
            });
        });

        this.continueRow.classList.remove('hidden');
    }

    async resumeEpisodeFromHistory(h) {
        const sourceId = parseInt(h.source_id || h.data?.sourceId);
        const seriesId = h.data?.seriesId;
        if (!sourceId || !seriesId) return;

        try {
            await this.prepareForPlaybackSession();
            const info = await API.proxy.xtream.seriesInfo(sourceId, seriesId);
            if (!info?.episodes) return;

            // Find the episode in seriesInfo
            let episode = null, seasonNum = h.data?.currentSeason, episodeNum = h.data?.currentEpisode;
            for (const [sn, eps] of Object.entries(info.episodes)) {
                const found = eps.find(ep => String(ep.id) === String(h.item_id));
                if (found) { episode = found; seasonNum = sn; episodeNum = found.episode_num; break; }
            }
            if (!episode) return;

            const container = episode.container_extension || h.data?.containerExtension || 'mp4';
            const resumeOffset = this.getResumeOffset(h.progress, h.duration);
            const resumePlan = this.getGatewayResumePlan(resumeOffset);
            const playbackHint = MediaUtils.playbackHintFromItem
                ? MediaUtils.playbackHintFromItem(episode, { container, streamType: 'series' })
                : { container, streamType: 'series' };
            if (resumePlan.sessionStart > 0) {
                playbackHint.seekOffset = resumePlan.sessionStart;
                playbackHint.startOffset = resumePlan.sessionStart;
                playbackHint.resumeTime = resumePlan.sessionStart;
            }
            const playbackPreferences = h.data?.playbackPreferences || h.data?.playback_preferences || null;
            const audioStreamIndex = Number(playbackPreferences?.audio?.streamIndex ?? playbackPreferences?.audio?.stream_index);
            if (Number.isInteger(audioStreamIndex)) {
                playbackHint.audioStreamIndex = audioStreamIndex;
            }
            const result = await API.proxy.xtream.getStreamUrl(
                sourceId,
                episode.id,
                'series',
                container,
                playbackHint
            );
            if (!result?.url) return;

            this.app.pages.watch?.play({
                type: 'series',
                id: episode.id,
                title: h.data?.title || 'Series',
                subtitle: `S${seasonNum} E${episodeNum} - ${episode.title || `Episode ${episodeNum}`}`,
                poster: MediaUtils.safeImageUrl(h.data?.poster),
                sourceId: sourceId,
                seriesId: seriesId,
                seriesInfo: info,
                currentSeason: seasonNum,
                currentEpisode: episodeNum,
                containerExtension: container,
                resumeTime: resumePlan.target,
                playbackPreferences,
                durationHint: h.duration || MediaUtils.parseDurationToSeconds(episode.duration),
                cloudPlaybackSessionId: result.sessionId
            }, result.url, {
                ...result,
                seekOffset: resumePlan.sessionStart,
                startOffset: resumePlan.sessionStart,
                resumeTarget: resumePlan.target
            });
        } catch (err) {
            console.error('Error resuming episode:', err);
        }
    }

    // === Group interaction ===

    getPreferences() {
        return {
            preferredLanguage: this.serverSettings.preferredLanguage || '',
            preferredQuality: this.serverSettings.preferredQuality || 'highest'
        };
    }

    openGroup(group) {
        const ordered = MediaUtils.orderVersionsByPreference(group.items, this.getPreferences());
        this.showSeriesDetails(ordered[0]);
    }

    openRandom() {
        if (this.filteredCards.length === 0) return;
        const group = this.filteredCards[Math.floor(Math.random() * this.filteredCards.length)];
        this.openGroup(group);
    }

    showVersionPicker(group) {
        const modal = document.getElementById('modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        const footer = document.getElementById('modal-footer');
        if (!modal || !body) return;

        const ordered = MediaUtils.orderVersionsByPreference(group.items, this.getPreferences());
        title.textContent = group.representative.tmdb?.title || group.representative.name;

        body.innerHTML = `
            <p class="hint" style="margin-bottom: 8px;">Choose a version to open:</p>
            <div class="version-list">
                ${ordered.map((item, i) => `
                    <button class="version-item" data-index="${i}">
                        <span class="version-item-label">${MediaUtils.escapeHtml(MediaUtils.versionLabel(item, this.getSourceName(item.sourceId)))}</span>
                        <span class="version-item-name">${MediaUtils.escapeHtml(item.name)}</span>
                    </button>
                `).join('')}
            </div>
        `;
        footer.innerHTML = '';

        const close = () => modal.classList.remove('active');
        modal.querySelector('.modal-close').onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };

        body.querySelectorAll('.version-item').forEach(btn => {
            btn.addEventListener('click', () => {
                close();
                this.showSeriesDetails(ordered[parseInt(btn.dataset.index)]);
            });
        });

        modal.classList.add('active');
    }

    async showSeriesDetails(series) {
        this.currentSeries = series;

        this.container.classList.add('hidden');
        this.detailsPanel.classList.remove('hidden');

        document.getElementById('series-poster').src = MediaUtils.safeImageUrl(
            series.cover || series.stream_icon || MediaUtils.tmdbPosterUrl(series.tmdb),
            '/img/norva-media-placeholder.png'
        );
        document.getElementById('series-title').textContent = series.tmdb?.title || series.name;
        document.getElementById('series-plot').textContent = series.plot || series.tmdb?.overview || '';

        this.seasonsContainer.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

        try {
            const info = await API.proxy.xtream.seriesInfo(series.sourceId, series.series_id);

            if (!info || !info.episodes) {
                this.seasonsContainer.innerHTML = '<p class="hint">No episodes found</p>';
                return;
            }

            this.currentSeriesInfo = info;

            // Episodes already watched (for ✓ markers)
            const watchedEpisodes = new Map();
            for (const h of (this.historyItems || [])) {
                if (h.item_type === 'episode' && String(h.data?.seriesId) === String(series.series_id)) {
                    const ratio = h.duration > 0 ? h.progress / h.duration : 0;
                    watchedEpisodes.set(String(h.item_id), ratio);
                }
            }

            let html = '';
            const seasons = Object.keys(info.episodes).sort((a, b) => parseInt(a) - parseInt(b));

            seasons.forEach(seasonNum => {
                const episodes = info.episodes[seasonNum];
                html += `
                <div class="season-group">
                    <div class="season-header">
                        <span class="season-expander">${Icons.chevronDown}</span>
                        <span class="season-name">Season ${seasonNum} (${episodes.length} episodes)</span>
                    </div>
                    <div class="episode-list">
                        ${episodes.map(ep => {
                            const ratio = watchedEpisodes.get(String(ep.id)) || 0;
                            const marker = ratio >= 0.9 ? '<span class="episode-watched" title="Watched">✓</span>'
                                : (ratio > 0.02 ? '<span class="episode-watched inprogress" title="In progress">◐</span>' : '');
                            return `
                            <div class="episode-item" data-episode-id="${ep.id}" data-source-id="${series.sourceId}" data-container="${ep.container_extension || 'mp4'}">
                                <span class="episode-number">E${ep.episode_num}</span>
                                <span class="episode-title">${MediaUtils.escapeHtml(ep.title || `Episode ${ep.episode_num}`)}</span>
                                ${marker}
                                <span class="episode-duration">${ep.duration || ''}</span>
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
            });

            this.seasonsContainer.innerHTML = html;

            this.seasonsContainer.querySelectorAll('.season-header').forEach(header => {
                header.addEventListener('click', () => {
                    header.closest('.season-group').classList.toggle('collapsed');
                });
            });

            this.seasonsContainer.querySelectorAll('.episode-item').forEach(ep => {
                ep.addEventListener('click', () => this.playEpisode(ep));
            });

        } catch (err) {
            const { friendly, detail } = this.getSeriesInfoError(err);
            console.error('Error loading series info:', err);
            this.seasonsContainer.innerHTML = `
                <div class="series-error" style="color: var(--color-error);">
                    <p class="hint">${MediaUtils.escapeHtml(friendly)}</p>
                    ${detail ? `<p class="hint" style="opacity: .75;">${MediaUtils.escapeHtml(detail.slice(0, 240))}</p>` : ''}
                </div>`;
        }
    }

    sanitizeErrorMessage(message) {
        return String(message || '')
            .replace(/https?:\/\/[^\s'"<>]+/gi, '[stream URL]')
            .replace(/([?&](?:username|password|pass)=)[^&\s]+/gi, '$1[redacted]')
            .replace(/\/(live|movie|series)\/[^/\s]+\/[^/\s]+\//gi, '/$1/[user]/[password]/')
            .trim();
    }

    getSeriesInfoError(err) {
        const payload = err?.payload || {};
        const raw = [
            payload.error,
            payload.details,
            err?.code,
            err?.upstreamStatus,
            err?.message
        ].filter(Boolean).join(' ');
        const detail = this.sanitizeErrorMessage(raw);

        let friendly = payload.error && !/^Upstream error$/i.test(payload.error)
            ? payload.error
            : 'Unable to load episodes from the provider.';

        if (/429|Too Many Requests|Many Requests|rate limit/i.test(detail)) {
            friendly = 'The provider is rate limiting episode data right now. Close other players, wait a bit, then try again.';
        } else if (/401|Unauthorized/i.test(detail)) {
            friendly = 'The provider refused episode data (401 Unauthorized). Your IPTV account may be blocked, expired, or limited to one connection.';
        } else if (/403|Forbidden/i.test(detail)) {
            friendly = 'Access denied by the provider while loading episodes (403).';
        } else if (/404|not found/i.test(detail)) {
            friendly = 'Episodes were not found on the provider (404).';
        }

        return { friendly, detail };
    }

    hideDetails() {
        this.detailsPanel.classList.add('hidden');
        this.container.classList.remove('hidden');
        this.currentSeries = null;
    }

    findEpisodeById(episodeId) {
        if (!this.currentSeriesInfo?.episodes) return null;
        for (const episodes of Object.values(this.currentSeriesInfo.episodes)) {
            const found = Array.isArray(episodes)
                ? episodes.find(ep => String(ep.id) === String(episodeId))
                : null;
            if (found) return found;
        }
        return null;
    }

    async playEpisode(episodeEl) {
        const episodeId = episodeEl.dataset.episodeId;
        const sourceId = parseInt(episodeEl.dataset.sourceId);
        const container = episodeEl.dataset.container || 'mp4';
        const episode = this.findEpisodeById(episodeId) || {
            id: episodeId,
            container_extension: container,
            type: 'episode',
            streamType: 'series'
        };

        const seasonGroup = episodeEl.closest('.season-group');
        const seasonHeader = seasonGroup?.querySelector('.season-name')?.textContent || '';
        const seasonMatch = seasonHeader.match(/Season (\d+)/);
        const seasonNum = seasonMatch ? seasonMatch[1] : '1';
        const episodeNum = episodeEl.querySelector('.episode-number')?.textContent?.replace('E', '') || '1';

        try {
            const h = (this.historyItems || []).find(x =>
                x.item_type === 'episode' && String(x.item_id) === String(episodeId));
            const resumeOffset = h ? this.getResumeOffset(h.progress, h.duration) : 0;
            const resumePlan = this.getGatewayResumePlan(resumeOffset);
            const playbackPreferences = h?.data?.playbackPreferences || h?.data?.playback_preferences || null;
            const playbackHint = MediaUtils.playbackHintFromItem
                ? MediaUtils.playbackHintFromItem(episode, { container, streamType: 'series' })
                : { container, streamType: 'series' };
            if (resumePlan.sessionStart > 0) {
                playbackHint.seekOffset = resumePlan.sessionStart;
                playbackHint.startOffset = resumePlan.sessionStart;
                playbackHint.resumeTime = resumePlan.sessionStart;
            }
            const audioStreamIndex = Number(playbackPreferences?.audio?.streamIndex ?? playbackPreferences?.audio?.stream_index);
            if (Number.isInteger(audioStreamIndex)) {
                playbackHint.audioStreamIndex = audioStreamIndex;
            }
            await this.prepareForPlaybackSession();
            const result = await API.proxy.xtream.getStreamUrl(
                sourceId,
                episodeId,
                'series',
                container,
                playbackHint
            );

            if (result && result.url) {
                if (this.app.pages.watch) {
                    const episodeTitle = episodeEl.querySelector('.episode-title')?.textContent || `Episode ${episodeNum}`;

                    // Episode duration ("00:42:10") as timeline fallback
                    const durationText = episodeEl.querySelector('.episode-duration')?.textContent;
                    const durationHint = (h?.duration) || MediaUtils.parseDurationToSeconds(durationText);

                    this.app.pages.watch.play({
                        type: 'series',
                        id: episodeId,
                        title: this.currentSeries?.tmdb?.title || this.currentSeries?.name || 'Series',
                        subtitle: `S${seasonNum} E${episodeNum} - ${episodeTitle}`,
                        poster: MediaUtils.safeImageUrl(this.currentSeries?.cover || this.currentSeries?.stream_icon || MediaUtils.tmdbPosterUrl(this.currentSeries?.tmdb)),
                        description: this.currentSeries?.plot || this.currentSeries?.tmdb?.overview || '',
                        year: this.currentSeries?.year,
                        rating: this.currentSeries?.rating,
                        sourceId: sourceId,
                        seriesId: this.currentSeries?.series_id,
                        seriesInfo: this.currentSeriesInfo,
                        currentSeason: seasonNum,
                        currentEpisode: episodeNum,
                        containerExtension: container,
                        resumeTime: resumePlan.target,
                        playbackPreferences,
                        durationHint,
                        cloudPlaybackSessionId: result.sessionId
                    }, result.url, {
                        ...result,
                        seekOffset: resumePlan.sessionStart,
                        startOffset: resumePlan.sessionStart,
                        resumeTarget: resumePlan.target
                    });
                }
            }
        } catch (err) {
            console.error('Error playing episode:', err);
        }
    }

    async prepareForPlaybackSession() {
        await Promise.allSettled([
            this.app?.player?.stop?.(),
            this.app?.pages?.watch?.releasePlaybackPipelineForRetry?.()
        ]);
    }

    getGatewayResumePlan(resumeOffset, requestedPreRoll = 20) {
        const target = Math.max(0, Math.floor(Number(resumeOffset) || 0));
        const requested = Math.max(0, Math.floor(Number(requestedPreRoll) || 0));
        const preRoll = target > 5 ? Math.min(target, requested || 20) : 0;
        const sessionStart = Math.max(0, target - preRoll);
        return {
            target,
            sessionStart,
            localSeekTarget: Math.max(0, target - sessionStart)
        };
    }

    async toggleFavorite(group, btn) {
        const series = group.representative;
        const favKey = `${series.sourceId}:${series.series_id}`;
        const isFav = group.items.some(i => this.favoriteIds.has(`${i.sourceId}:${i.series_id}`));
        const iconSpan = btn.querySelector('.fav-icon');

        try {
            if (isFav) {
                for (const item of group.items) {
                    const key = `${item.sourceId}:${item.series_id}`;
                    if (this.favoriteIds.has(key)) {
                        this.favoriteIds.delete(key);
                        await API.favorites.remove(item.sourceId, item.series_id, 'series');
                    }
                }
                btn.classList.remove('active');
                btn.title = 'Add to Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favoriteOutline;
            } else {
                this.favoriteIds.add(favKey);
                btn.classList.add('active');
                btn.title = 'Remove from Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favorite;
                await API.favorites.add(series.sourceId, series.series_id, 'series');
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            await this.loadFavorites();
            this.filterAndRender();
        }
    }
}

window.SeriesPage = SeriesPage;
