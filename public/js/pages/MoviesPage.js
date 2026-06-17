/**
 * Movies Page Controller
 * Handles VOD movie browsing and playback with rich filtering,
 * duplicate grouping (one card per title) and version selection.
 */

class MoviesPage {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('movies-grid');
        this.sourceSelect = document.getElementById('movies-source-select');
        this.searchInput = document.getElementById('movies-search');

        // Filter bar elements
        this.sortSelect = document.getElementById('movies-sort');
        this.genreSelect = document.getElementById('movies-genre');
        this.yearSelect = document.getElementById('movies-year');
        this.ratingSelect = document.getElementById('movies-rating');
        this.watchedSelect = document.getElementById('movies-watched');
        this.addedSelect = document.getElementById('movies-added');
        this.durationSelect = document.getElementById('movies-duration');
        this.groupToggleBtn = document.getElementById('movies-group-toggle');
        this.hideBrokenBtn = document.getElementById('movies-hide-broken-btn');
        this.randomBtn = document.getElementById('movies-random');
        this.countEl = document.getElementById('movies-count');
        this.resetBtn = document.getElementById('movies-reset');
        this.continueRow = document.getElementById('movies-continue');
        this.continueList = document.getElementById('movies-continue-list');

        this.movies = [];
        this.categories = [];
        this.sources = [];
        this.currentBatch = 0;
        this.batchSize = 24;
        this.filteredCards = []; // [{ items, representative }] — grouped or singletons
        this.isLoading = false;
        this.cloudLoadingMore = false;
        this.cloudHasMore = false;
        this.cloudOffset = 0;
        this.cloudTotal = null;
        this.cloudPageSize = 120;
        this.cloudRequestId = 0;
        this.observer = null;
        this.favoriteIds = new Set();
        this.showFavoritesOnly = false;
        this.groupDuplicates = true;
        this.hideBroken = true;
        this.watchState = new Map(); // item_id -> { progress, duration, ratio }
        this.serverSettings = {};
        this.hiddenCategoryIds = new Set();

        this.restoreFilters();
        this.init();
    }

    init() {
        // Category multi-select
        this.categoryMulti = new MultiSelect({
            btnId: 'movies-category-btn',
            panelId: 'movies-category-panel',
            searchId: 'movies-category-search',
            listId: 'movies-category-list',
            allLabel: 'All Categories',
            onChange: () => this.onFiltersChanged()
        });

        // Source change reloads everything
        this.sourceSelect?.addEventListener('change', async () => {
            await this.loadCategories();
            await this.loadPlaybackStatuses();
            await this.loadMovies();
        });

        // Search with debounce
        let searchTimeout;
        this.searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.onFiltersChanged(), 300);
        });

        // Filter selects
        [this.sortSelect, this.genreSelect, this.yearSelect, this.ratingSelect,
         this.watchedSelect, this.addedSelect, this.durationSelect].forEach(sel => {
            sel?.addEventListener('change', () => this.onFiltersChanged());
        });

        // Group duplicates toggle
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

        // Random movie
        this.randomBtn?.addEventListener('click', () => this.playRandom());

        // Reset filters
        this.resetBtn?.addEventListener('click', () => this.resetFilters());

        // Lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this.isLoading) {
                this.renderNextBatch();
            }
        }, { rootMargin: '200px' });

        // Favorites filter toggle
        const favBtn = document.getElementById('movies-favorites-btn');
        favBtn?.addEventListener('click', () => {
            this.showFavoritesOnly = !this.showFavoritesOnly;
            favBtn.classList.toggle('active', this.showFavoritesOnly);
            this.onFiltersChanged();
        });

        // When a previously-broken movie plays successfully, remove the HS mark
        // immediately so it reappears if "hide broken" is active — no page reload needed.
        window.addEventListener('playbackStatusChanged', (e) => {
            const d = e.detail;
            if (d && d.status === 'ok' && (d.item_type === 'movie' || d.itemType === 'movie')) {
                if (this.hideBroken) this.filterAndRender();
            }
        });

        this.applyFiltersToUI();
    }

    // === Filter persistence ===

    restoreFilters() {
        const saved = MediaUtils.loadFilters('movies') || {};
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
        document.getElementById('movies-favorites-btn')?.classList.toggle('active', this.showFavoritesOnly);
    }

    persistFilters() {
        MediaUtils.saveFilters('movies', {
            sort: this.sortSelect?.value || 'default',
            genre: this.genreSelect?.value || '',
            year: this.yearSelect?.value || '',
            rating: this.ratingSelect?.value || '',
            watched: this.watchedSelect?.value || '',
            added: this.addedSelect?.value || '',
            duration: this.durationSelect?.value || '',
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
            this.loadMovies();
            return;
        }
        this.filterAndRender();
    }

    resetFilters() {
        [this.sortSelect, this.genreSelect, this.yearSelect, this.ratingSelect,
         this.watchedSelect, this.addedSelect, this.durationSelect].forEach(sel => {
            if (sel) sel.value = sel.querySelector('option')?.value ?? '';
        });
        if (this.sortSelect) this.sortSelect.value = 'default';
        if (this.searchInput) this.searchInput.value = '';
        this.showFavoritesOnly = false;
        this.hideBroken = true;
        this.hideBrokenBtn?.classList.toggle('active', this.hideBroken);
        document.getElementById('movies-favorites-btn')?.classList.remove('active');
        this.categoryMulti?.setSelected([]);
        this.onFiltersChanged();
    }

    hasActiveFilters() {
        return Boolean(
            (this.sortSelect?.value && this.sortSelect.value !== 'default') ||
            this.genreSelect?.value || this.yearSelect?.value || this.ratingSelect?.value ||
            this.watchedSelect?.value || this.addedSelect?.value || this.durationSelect?.value ||
            this.searchInput?.value || this.showFavoritesOnly || this.hideBroken === false ||
            (this.categoryMulti?.getSelected().size > 0)
        );
    }

    // === Page lifecycle ===

    async show() {
        if (this.sources.length === 0) {
            await this.loadSources();
        }

        await Promise.all([this.loadFavorites(), this.loadWatchState(), this.loadServerSettings(), this.loadPlaybackStatuses()]);
        this.renderContinueWatching();

        if (this.movies.length === 0) {
            await this.loadCategories();
            await this.loadMovies();
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
            const favs = await API.favorites.getAll(null, 'movie');
            this.favoriteIds = new Set(favs.map(f => `${f.source_id}:${f.item_id}`));
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }

    async loadWatchState() {
        try {
            const history = await API.history.getAll(500);
            this.watchState = new Map();
            this.historyItems = history || [];
            for (const h of this.historyItems) {
                if (h.item_type !== 'movie') continue;
                const ratio = h.duration > 0 ? h.progress / h.duration : 0;
                this.watchState.set(String(h.item_id), {
                    progress: h.progress,
                    duration: h.duration,
                    ratio,
                    updatedAt: h.updated_at,
                    data: h.data
                });
            }
        } catch (err) {
            console.warn('Error loading watch history:', err);
            this.watchState = new Map();
            this.historyItems = [];
        }
    }

    async loadPlaybackStatuses() {
        if (!window.PlaybackHealth) return;
        const sourceId = this.sourceSelect?.value || null;
        await PlaybackHealth.load({ sourceId, itemType: 'movie' });
    }

    getWatchStatus(items) {
        // A group is "watched"/"in progress" if any version is
        let best = null;
        for (const item of items) {
            const state = this.watchState.get(String(item.stream_id));
            if (state && (!best || state.ratio > best.ratio)) best = state;
        }
        if (!best || best.ratio <= 0.01) return { status: 'unwatched', ratio: 0 };
        if (best.ratio >= 0.9) return { status: 'watched', ratio: 1 };
        return { status: 'inprogress', ratio: best.ratio };
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
                        if (h.item_type === 'vod_category') {
                            this.hiddenCategoryIds.add(`${source.id}:${h.item_id}`);
                        }
                    });
                } catch (err) {
                    console.warn(`Failed to load hidden items from source ${source.id}`);
                }
            }

            for (const source of sourcesToLoad) {
                try {
                    const cats = await API.proxy.xtream.vodCategories(source.id);
                    if (cats && Array.isArray(cats)) {
                        cats.forEach(c => {
                            if (!this.hiddenCategoryIds.has(`${source.id}:${c.category_id}`)) {
                                this.categories.push({ ...c, sourceId: source.id });
                            }
                        });
                    }
                } catch (err) {
                    console.warn(`Failed to load categories from source ${source.id}:`, err.message);
                }
            }

            const options = this.categories.map(c => ({
                value: `${c.sourceId}:${c.category_id}`,
                label: sourcesToLoad.length > 1
                    ? `${c.category_name} (${this.getSourceName(c.sourceId)})`
                    : c.category_name
            }));
            this.categoryMulti.setOptions(options);

            // Restore saved category selection once
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
                    const cats = await API.media.categories({ sourceId: source.id, type: 'movie' });
                    if (Array.isArray(cats)) {
                        cats.forEach(c => loaded.push({ ...c, sourceId: c.sourceId || source.id }));
                    }
                } catch (err) {
                    console.warn(`Failed to load cloud movie categories from source ${source.id}:`, err.message);
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
            console.error('Error loading cloud movie categories:', err);
        }
    }

    async loadMovies() {
        if (this.isCloudPagedMode()) {
            return this.loadCloudMovies({ reset: true });
        }

        this.isLoading = true;
        this.container.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

        try {
            this.movies = [];

            const sourceId = this.sourceSelect.value;
            const sourcesToLoad = sourceId
                ? this.sources.filter(s => s.id === parseInt(sourceId))
                : this.sources;

            // Load everything once; category filtering happens client-side
            for (const source of sourcesToLoad) {
                try {
                    const movies = await API.proxy.xtream.vodStreams(source.id, null);
                    console.log(`[Movies] Source ${source.id}: Got ${movies?.length || 0} movies`);
                    if (movies && Array.isArray(movies)) {
                        movies.forEach(m => {
                            if (this.hiddenCategoryIds.has(`${source.id}:${m.category_id}`)) return;
                            this.movies.push({
                                ...m,
                                sourceId: source.id,
                                id: `${source.id}:${m.stream_id}`
                            });
                        });
                    }
                } catch (err) {
                    console.warn(`Failed to load movies from source ${source.id}:`, err.message);
                }
            }

            console.log(`[Movies] Total loaded: ${this.movies.length} movies`);
            this.populateGenres();
            this.filterAndRender();
        } catch (err) {
            console.error('Error loading movies:', err);
            this.container.innerHTML = '<div class="empty-state"><p>Error loading movies</p></div>';
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
            type: 'movie',
            sourceId,
            categoryId,
            q: (this.searchInput?.value || '').trim(),
            limit: this.cloudPageSize,
            offset
        };
    }

    async loadCloudMovies({ reset = false } = {}) {
        if (this.cloudLoadingMore || (this.isLoading && !reset)) return;

        if (reset) {
            this.isLoading = true;
            this.cloudRequestId += 1;
            this.cloudOffset = 0;
            this.cloudHasMore = false;
            this.cloudTotal = null;
            this.movies = [];
            this.filteredCards = [];
            this.currentBatch = 0;
            this.container.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
        } else {
            this.cloudLoadingMore = true;
        }

        try {
            const requestId = this.cloudRequestId;
            const renderedBefore = reset ? 0 : this.container.querySelectorAll('.movie-card').length;
            const page = await API.media.page(this.cloudPageParams(this.cloudOffset));
            if (reset && requestId !== this.cloudRequestId) return;
            const incoming = (page.items || [])
                .filter(m => !this.hiddenCategoryIds.has(`${m.sourceId}:${m.category_id}`))
                .map(m => ({
                    ...m,
                    sourceId: m.sourceId,
                    id: `${m.sourceId}:${m.stream_id}`
                }));

            const seen = new Set(this.movies.map(m => `${m.sourceId}:${m.stream_id}`));
            incoming.forEach(movie => {
                const key = `${movie.sourceId}:${movie.stream_id}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    this.movies.push(movie);
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
            console.error('Error loading cloud movies:', err);
            if (reset) {
                this.container.innerHTML = '<div class="empty-state"><p>Error loading movies</p></div>';
            }
        } finally {
            if (reset) this.isLoading = false;
            this.cloudLoadingMore = false;
        }
    }

    populateGenres() {
        if (!this.genreSelect) return;
        const genres = new Set();
        let hasRuntime = false;
        for (const m of this.movies) {
            if (m.tmdb?.genres) m.tmdb.genres.forEach(g => genres.add(g));
            if (m.tmdb?.runtime) hasRuntime = true;
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

        this.durationSelect?.classList.toggle('hidden', !hasRuntime);
        if (hasRuntime && this.savedFilters?.duration) {
            this.durationSelect.value = this.savedFilters.duration;
        }
    }

    // === Filtering, grouping, sorting ===

    parseAddedMs(item) {
        const raw = item.added || item.added_at;
        if (!raw) return 0;
        const num = parseInt(raw);
        if (!isNaN(num) && num > 0) {
            // Xtream uses unix seconds
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

        // Category multi-select
        const selectedCats = this.categoryMulti?.getSelected();
        if (selectedCats && selectedCats.size > 0 &&
            !selectedCats.has(`${item.sourceId}:${item.category_id}`)) {
            return false;
        }

        // Year / decade
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

        // Minimum rating
        const minRating = parseFloat(this.ratingSelect?.value);
        if (minRating) {
            const r = parseFloat(item.rating) || (item.tmdb?.vote_average ?? 0);
            if (!r || r < minRating) return false;
        }

        // Genre (TMDB)
        const genre = this.genreSelect?.value;
        if (genre && !(item.tmdb?.genres || []).includes(genre)) return false;

        // Duration (TMDB runtime)
        const durationFilter = this.durationSelect?.value;
        if (durationFilter) {
            const runtime = item.tmdb?.runtime;
            if (!runtime) return false;
            if (durationFilter === '90' && runtime >= 90) return false;
            if (durationFilter === '120' && runtime >= 120) return false;
            if (durationFilter === '121' && runtime < 120) return false;
        }

        // Recently added
        const addedDays = parseInt(this.addedSelect?.value);
        if (addedDays) {
            const addedMs = this.parseAddedMs(item);
            if (!addedMs || (Date.now() - addedMs) > addedDays * 86400000) return false;
        }

        return true;
    }

    isBrokenItem(item) {
        return item?.playback_status === 'broken' ||
            window.PlaybackHealth?.isBroken(item.sourceId, 'movie', item.stream_id);
    }

    buildFilteredCards() {
        const searchTerm = MediaUtils.searchableText(this.searchInput?.value || '').trim();

        let items = this.movies.filter(m => this.matchesFilters(m));

        if (searchTerm && !this.isCloudPagedMode()) {
            items = items.filter(m =>
                MediaUtils.searchableText(m.name).includes(searchTerm) ||
                (m.tmdb?.title && MediaUtils.searchableText(m.tmdb.title).includes(searchTerm)));
        }

        // Group duplicates (or wrap as singleton groups for a uniform render path)
        let cards;
        if (this.groupDuplicates) {
            cards = MediaUtils.groupItems(items, { idField: 'stream_id' });
        } else {
            cards = items.map(item => ({ key: item.id, items: [item], representative: item }));
        }

        // Favorites: group qualifies if any version is favorite
        if (this.showFavoritesOnly) {
            cards = cards.filter(c => c.items.some(i => this.favoriteIds.has(`${i.sourceId}:${i.stream_id}`)));
        }

        // Watch status
        const watchedFilter = this.watchedSelect?.value;
        if (watchedFilter) {
            cards = cards.filter(c => this.getWatchStatus(c.items).status === watchedFilter);
        }

        // Sort
        this.sortCards(cards);
        return cards;
    }

    updateResultChrome(cards) {
        if (this.countEl) {
            let total = this.groupDuplicates ? `${cards.length} titles` : `${cards.length} movies`;
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

        // Counter + reset visibility
        this.updateResultChrome(cards);

        console.log(`[Movies] Displaying ${cards.length} cards from ${this.movies.length} movies`);

        this.currentBatch = 0;
        this.container.innerHTML = '';

        if (cards.length === 0) {
            this.container.innerHTML = '<div class="empty-state"><p>No movies found</p></div>';
            return;
        }

        const loader = document.createElement('div');
        loader.className = 'movies-loader';
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
                break; // provider order
        }
    }

    // === Rendering ===

    renderNextBatch() {
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        const batch = this.filteredCards.slice(start, end);

        if (batch.length === 0) {
            const loader = this.container.querySelector('.movies-loader');
            if (this.isCloudPagedMode() && this.cloudHasMore && !this.cloudLoadingMore) {
                if (loader) loader.style.display = '';
                this.loadCloudMovies({ reset: false });
            } else if (loader) {
                loader.style.display = 'none';
            }
            return;
        }

        const fragment = document.createDocumentFragment();

        batch.forEach(card => fragment.appendChild(this.buildCard(card)));

        const loader = this.container.querySelector('.movies-loader');
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
        const movie = group.representative;
        const card = document.createElement('div');
        card.className = 'movie-card';
        card.dataset.movieId = movie.stream_id;
        card.dataset.sourceId = movie.sourceId;

        const poster = MediaUtils.safeImageUrl(
            movie.stream_icon || movie.cover || MediaUtils.tmdbPosterUrl(movie.tmdb),
            '/img/norva-media-placeholder.png'
        );
        const year = this.getItemYear(movie) || '';
        const rating = movie.rating ? `${Icons.star} ${movie.rating}` : '';
        const isFav = group.items.some(i => this.favoriteIds.has(`${i.sourceId}:${i.stream_id}`));
        const watch = this.getWatchStatus(group.items);
        const versionCount = group.items.length;
        const displayName = (this.groupDuplicates && movie.tmdb?.title) ? movie.tmdb.title : movie.name;
        const groupBroken = group.items.every(item => this.isBrokenItem(item));

        card.innerHTML = `
            <div class="movie-poster">
                <img src="${MediaUtils.escapeHtml(poster)}" alt="${MediaUtils.escapeHtml(displayName)}"
                     onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'" loading="lazy">
                <div class="movie-play-overlay">
                    <span class="play-icon">${Icons.play}</span>
                </div>
                ${groupBroken ? '<span class="playback-badge" title="Playback failed">HS</span>' : ''}
                ${versionCount > 1 ? `<button class="version-badge" title="Choose version">${versionCount} versions</button>` : ''}
                ${watch.status === 'watched' ? '<span class="watched-badge" title="Watched">✓</span>' : ''}
                ${watch.status === 'inprogress' ? `<div class="card-progress"><div class="card-progress-fill" style="width:${Math.round(watch.ratio * 100)}%"></div></div>` : ''}
                <button class="favorite-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
                    <span class="fav-icon">${isFav ? Icons.favorite : Icons.favoriteOutline}</span>
                </button>
            </div>
            <div class="movie-info">
                <div class="movie-title">${MediaUtils.escapeHtml(displayName)}</div>
                <div class="movie-meta">
                    ${year ? `<span>${year}</span>` : ''}
                    ${rating ? `<span>${rating}</span>` : ''}
                    ${movie.tmdb?.runtime ? `<span>${movie.tmdb.runtime} min</span>` : ''}
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
                this.playGroup(group);
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
        const inProgress = (this.historyItems || [])
            .filter(h => h.item_type === 'movie' && h.duration > 0 &&
                this.getResumeOffset(h.progress, h.duration) > 0)
            .slice(0, 12);

        if (inProgress.length === 0) {
            this.continueRow.classList.add('hidden');
            return;
        }

        this.continueList.innerHTML = inProgress.map(h => {
            const ratio = Math.round((h.progress / h.duration) * 100);
            return `
            <div class="continue-card" data-item-id="${MediaUtils.escapeHtml(h.item_id)}"
                 data-source-id="${h.source_id || h.data?.sourceId || ''}">
                <img src="${MediaUtils.escapeHtml(MediaUtils.safeImageUrl(h.data?.poster, '/img/norva-media-placeholder.png'))}"
                     onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'" loading="lazy" alt="">
                <div class="continue-card-info">
                    <p class="continue-card-title">${MediaUtils.escapeHtml(h.data?.title || 'Unknown')}</p>
                    <div class="card-progress"><div class="card-progress-fill" style="width:${ratio}%"></div></div>
                </div>
            </div>`;
        }).join('');

        this.continueList.querySelectorAll('.continue-card').forEach(card => {
            card.addEventListener('click', () => {
                const h = inProgress.find(x => String(x.item_id) === card.dataset.itemId);
                if (h) this.resumeFromHistory(h);
            });
        });

        this.continueRow.classList.remove('hidden');
    }

    async resumeFromHistory(h) {
        const sourceId = h.source_id || h.data?.sourceId;
        if (!sourceId) return;
        const movie = this.movies.find(m =>
            String(m.stream_id) === String(h.item_id) && m.sourceId === parseInt(sourceId))
            || {
                stream_id: h.item_id,
                sourceId: parseInt(sourceId),
                name: h.data?.title,
                stream_icon: h.data?.poster,
                container_extension: h.data?.containerExtension || 'mp4'
            };
        await this.playMovie(movie, {
            resumeTime: this.getResumeOffset(h.progress, h.duration),
            versions: [movie],
            playbackPreferences: h.data?.playbackPreferences || h.data?.playback_preferences || null
        });
    }

    // === Playback ===

    getPreferences() {
        return {
            preferredLanguage: this.serverSettings.preferredLanguage || '',
            preferredQuality: this.serverSettings.preferredQuality || 'highest'
        };
    }

    async playGroup(group) {
        const ordered = MediaUtils.orderVersionsByPreference(group.items, this.getPreferences());
        const best = ordered[0];
        const watch = this.watchState.get(String(best.stream_id));
        const resumeTime = watch ? this.getResumeOffset(watch.progress, watch.duration) : 0;
        await this.playMovie(best, {
            versions: ordered,
            resumeTime,
            playbackPreferences: watch?.data?.playbackPreferences || watch?.data?.playback_preferences || null
        });
    }

    async playRandom() {
        if (this.filteredCards.length === 0) return;
        const group = this.filteredCards[Math.floor(Math.random() * this.filteredCards.length)];
        await this.playGroup(group);
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
            <p class="hint" style="margin-bottom: 8px;">Choose a version to play:</p>
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
            btn.addEventListener('click', async () => {
                close();
                const index = parseInt(btn.dataset.index);
                // Selected version first, others kept as failover
                const versions = [ordered[index], ...ordered.filter((_, i) => i !== index)];
                await this.playMovie(versions[0], { versions });
            });
        });

        modal.classList.add('active');
    }

    async prepareForPlaybackSession() {
        await Promise.allSettled([
            this.app?.player?.stop?.(),
            this.app?.pages?.watch?.releasePlaybackPipelineForRetry?.()
        ]);
    }

    async playMovie(movie, { versions = null, resumeTime = 0, playbackPreferences = null } = {}) {
        try {
            const container = movie.container_extension || 'mp4';
            const resumeOffset = Math.max(0, Math.floor(Number(resumeTime) || 0));
            const playbackHint = MediaUtils.playbackHintFromItem
                ? MediaUtils.playbackHintFromItem(movie, { container })
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
            await this.prepareForPlaybackSession();
            const result = await API.proxy.xtream.getStreamUrl(
                movie.sourceId,
                movie.stream_id,
                'movie',
                container,
                playbackHint
            );

            if (result && result.url) {
                if (this.app.pages.watch) {
                    const versionList = (versions || [movie]).map(v => ({
                        sourceId: v.sourceId,
                        streamId: v.stream_id,
                        container: v.container_extension || 'mp4',
                        type: 'movie',
                        label: MediaUtils.versionLabel(v, this.getSourceName(v.sourceId))
                    }));

                    this.app.pages.watch.play({
                        type: 'movie',
                        id: movie.stream_id,
                        title: movie.tmdb?.title || movie.name,
                        poster: MediaUtils.safeImageUrl(movie.stream_icon || movie.cover || MediaUtils.tmdbPosterUrl(movie.tmdb)),
                        description: movie.plot || movie.tmdb?.overview || '',
                        year: this.getItemYear(movie),
                        rating: movie.rating || movie.tmdb?.vote_average,
                        sourceId: movie.sourceId,
                        categoryId: movie.category_id,
                        containerExtension: container,
                        resumeTime: resumeOffset,
                        playbackPreferences,
                        durationHint: movie.tmdb?.runtime ? movie.tmdb.runtime * 60 : null,
                        versions: versionList,
                        versionIndex: 0,
                        cloudPlaybackSessionId: result.sessionId
                    }, result.url, { ...result, seekOffset: resumeOffset, startOffset: resumeOffset });
                }
            }
        } catch (err) {
            console.error('Error playing movie:', err);
        }
    }

    async toggleFavorite(group, btn) {
        // Favorites apply to the representative version of the group
        const movie = group.representative;
        const favKey = `${movie.sourceId}:${movie.stream_id}`;
        const isFav = group.items.some(i => this.favoriteIds.has(`${i.sourceId}:${i.stream_id}`));
        const iconSpan = btn.querySelector('.fav-icon');

        try {
            if (isFav) {
                // Remove all versions from favorites to fully unfavorite the group
                for (const item of group.items) {
                    const key = `${item.sourceId}:${item.stream_id}`;
                    if (this.favoriteIds.has(key)) {
                        this.favoriteIds.delete(key);
                        await API.favorites.remove(item.sourceId, item.stream_id, 'movie');
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
                await API.favorites.add(movie.sourceId, movie.stream_id, 'movie');
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            await this.loadFavorites();
            this.filterAndRender();
        }
    }
}

window.MoviesPage = MoviesPage;
