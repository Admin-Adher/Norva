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
        this.audioSelect = document.getElementById('movies-audio');
        this.subtitleSelect = document.getElementById('movies-subtitle');
        this.groupToggleBtn = document.getElementById('movies-group-toggle');
        this.hideBrokenBtn = document.getElementById('movies-hide-broken-btn');
        this.randomBtn = document.getElementById('movies-random');
        this.countEl = document.getElementById('movies-count');
        this.resetBtn = document.getElementById('movies-reset');
        this.continueRow = document.getElementById('movies-continue');
        this.continueList = document.getElementById('movies-continue-list');
        this.pageEl = document.getElementById('page-movies');
        this.detailsPanel = document.getElementById('movie-details');
        this.primaryActionBtn = document.getElementById('movie-primary-action');
        this.detailFavoriteBtn = document.getElementById('movie-detail-favorite');
        this.detailDownloadBtn = document.getElementById('movie-detail-download');
        this.versionsList = document.getElementById('movie-versions-list');
        this.versionSummary = document.getElementById('movie-version-summary');

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
        this.currentMovie = null;
        this.currentMovieGroup = null;
        this.currentMovieVersions = [];

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
         this.watchedSelect, this.addedSelect, this.durationSelect,
         this.audioSelect, this.subtitleSelect].forEach(sel => {
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

        this.detailsPanel?.querySelector('.movie-back-btn')?.addEventListener('click', () => this.hideDetails());
        this.primaryActionBtn?.addEventListener('click', () => this.playPrimaryMovie());
        this.detailFavoriteBtn?.addEventListener('click', () => {
            if (this.currentMovieGroup) this.toggleFavorite(this.currentMovieGroup, this.detailFavoriteBtn);
        });
        this.detailDownloadBtn?.addEventListener('click', () => this.onDownloadClick());

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
        if (this.audioSelect && s.audio) this.audioSelect.value = s.audio;
        if (this.subtitleSelect && s.subtitle) this.subtitleSelect.value = s.subtitle;
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
            audio: this.audioSelect?.value || '',
            subtitle: this.subtitleSelect?.value || '',
            search: this.searchInput?.value || '',
            group: this.groupDuplicates,
            hideBroken: this.hideBroken,
            favoritesOnly: this.showFavoritesOnly,
            categories: [...(this.categoryMulti?.getSelected() || [])]
        });
    }

    onFiltersChanged() {
        this.persistFilters();
        // Cloud: picking a genre opens that genre's full grid — the same dense,
        // server-side view as a rail's "See all" — so the dropdown behaves like
        // Manage Content's genres.
        if (this.isCloudPagedMode()) {
            const buckets = [...(this.categoryMulti?.getSelected() || [])];
            if (buckets.length) { this.openGenreBucket(buckets[0]); return; }
            // Audio/subtitle/burned-in filter (or "best for my languages" sort) with
            // no genre selected → a catalogue-wide grid filtered server-side by each
            // title's available version languages.
            if (this.isLanguageFilterActive()) { this.openLanguageBucket(); return; }
        }
        if (this.shouldShowRails()) {
            this.renderGenreRails();
            return;
        }
        if (this.isCloudPagedMode()) {
            this.loadMovies();
            return;
        }
        this.filterAndRender();
    }

    // True when an audio/subtitle filter or the language-match sort is set, so the
    // grid must go through the language-aware (title-based) server path.
    isLanguageFilterActive() {
        return Boolean(this.audioSelect?.value || this.subtitleSelect?.value ||
            this.sortSelect?.value === 'lang-match');
    }

    // Catalogue-wide "All" grid carrying the active language params — reuses the
    // genre "See all" infinite-scroll grid with the synthetic 'all' bucket.
    openLanguageBucket() {
        const langKey = JSON.stringify(this.currentLanguageParams());
        if (this.activeBucket === 'all' && this.activeBucketLangKey === langKey) return;
        this.openBucket({ id: 'genre-all', title: 'All movies', curation: { bucket: 'all' } });
    }

    // Audio-language / burned-in-subtitle filter params + "best for my languages"
    // sort, forwarded to the server genre-items endpoint. Empty keys are omitted.
    currentLanguageParams() {
        const params = {};
        if (this.audioSelect?.value) params.audio = this.audioSelect.value;
        if (this.subtitleSelect?.value) params.subs = this.subtitleSelect.value;
        if (this.sortSelect?.value === 'lang-match') {
            params.sort = 'lang-match';
            const prefs = this.getPreferences();
            if (prefs.preferredAudioLanguage) params.prefAudio = prefs.preferredAudioLanguage;
            if (prefs.preferredSubtitleLanguage && prefs.preferredSubtitleLanguage !== 'none') {
                params.prefSubs = prefs.preferredSubtitleLanguage;
            }
        }
        const search = (this.searchInput?.value || '').trim();
        if (search) params.q = search;
        return params;
    }

    // Dynamic filter menus: only show audio/subtitle languages actually present in
    // the catalogue (server facets). Falls back to the static <option>s on failure.
    async populateLanguageFacets() {
        if (!this.isCloudPagedMode()) return;
        // Re-fetch at most once per 60s so the menu tracks the background crawl (new
        // languages get detected over the first day) instead of freezing at first load.
        // applyFacetOptions preserves the current selection and skips the DOM rebuild
        // when nothing changed, so refreshing never disturbs the user.
        const now = Date.now();
        if (this._facetsLoadedAt && (now - this._facetsLoadedAt) < 60000) return;
        this._facetsLoadedAt = now;
        try {
            const facets = await API.media.languageFacets({ type: 'movie' });
            this.applyFacetOptions(this.audioSelect, 'Any Audio', facets && facets.audio);
            this.applyFacetOptions(this.subtitleSelect, 'Any Subtitles', facets && facets.subtitles);
        } catch (_) {
            this._facetsLoadedAt = 0; // allow a retry on the next show
        }
    }

    applyFacetOptions(select, anyLabel, facets) {
        if (!select || !Array.isArray(facets) || !facets.length) return;
        const desired = [`<option value="">${anyLabel}</option>`]
            .concat(facets.map(f => `<option value="${MediaUtils.escapeHtml(f.value)}">${MediaUtils.escapeHtml(f.label)}</option>`))
            .join('');
        if (select.innerHTML === desired) return; // unchanged → don't disturb an open dropdown
        const current = select.value;
        select.innerHTML = desired;
        if (current && facets.some(f => f.value === current)) select.value = current;
    }

    // Open a genre bucket from the filter dropdown, reusing the rail "See all"
    // grid (paged, server-side). No-op if that bucket is already showing.
    openGenreBucket(bucket) {
        if (!bucket) return;
        // Re-open (re-render) when the same genre is active but the language params
        // changed, so toggling an audio/subtitle filter refreshes the grid.
        const langKey = JSON.stringify(this.currentLanguageParams());
        if (this.activeBucket === bucket && this.activeBucketLangKey === langKey) return;
        const T = window.GenreTaxonomy;
        const label = (T && T.label) ? T.label(bucket) : bucket;
        this.openBucket({ id: `genre-${bucket}`, title: label, curation: { bucket } });
    }

    // Netflix-style default: with no active filter/search, the cloud Movies page
    // shows curated genre rails instead of a flat grid. Any filter or search
    // flips back to the grid via the normal path.
    shouldShowRails() {
        return this.isCloudPagedMode() && !!window.GenreRails && !this.hasActiveFilters();
    }

    async renderGenreRails() {
        this.railsView = true;
        if (this.countEl) this.countEl.textContent = '';
        this.resetBtn?.classList.add('hidden');
        if (this.randomBtn) this.randomBtn.disabled = true; // "Random" needs the flat grid.
        try {
            const payload = await API.media.genreRails({ type: 'movie', limit: 18 });
            const rails = (payload && payload.rails) || [];
            if (!rails.length) {
                // Nothing classifiable yet → fall back to the grid so the page is
                // never empty.
                this.railsView = false;
                return this.loadMovies();
            }
            window.GenreRails.render(this.container, rails, {
                emptyText: 'No movies to show yet.',
                onItemClick: (item) => this.openRailItem(item),
                onSeeAll: (rail) => this.openBucket(rail)
            });
        } catch (err) {
            console.warn('[Movies] Genre rails unavailable, falling back to grid:', err);
            this.railsView = false;
            return this.loadMovies();
        }
    }

    // Reuse the Home page's rail→detail path (builds the version group and opens
    // the movie detail on this page), so clicks behave exactly like Home rails.
    openRailItem(item) {
        const home = this.app?.pages?.home;
        if (home?.navigateToMovie) home.navigateToMovie(item);
    }

    // "See all" on a genre rail → a full, paged grid of that genre.
    openBucket(rail) {
        const bucket = (rail && rail.curation && rail.curation.bucket) || String((rail && rail.id) || '').replace(/^genre-/, '');
        if (!bucket) return;
        this.activeBucket = bucket;
        this.activeBucketLangKey = JSON.stringify(this.currentLanguageParams());
        this.bucketLabel = (rail && (rail.title || rail.name)) || '';
        this.bucketOffset = 0;
        this.bucketHasMore = true;
        this.bucketLoading = false;
        this.bucketObserver?.disconnect();

        // Block layout so the head / grid / loader stack vertically (see .rail-host).
        this.container.classList.add('rail-host');
        this.container.innerHTML = `
            <div class="genre-bucket-head" style="display:flex;align-items:center;gap:14px;margin:4px 0 18px">
                <button class="btn btn-secondary btn-sm" id="genre-bucket-back" type="button">‹ All genres</button>
                <h2 style="margin:0;font-size:21px">${MediaUtils.escapeHtml(this.bucketLabel)}</h2>
            </div>
            <div class="genre-bucket-grid" style="display:flex;flex-wrap:wrap;gap:16px"></div>
            <div class="genre-bucket-loader" style="height:1px"></div>`;
        document.getElementById('genre-bucket-back')?.addEventListener('click', () => this.closeBucket());
        this.bucketGridEl = this.container.querySelector('.genre-bucket-grid');
        try { this.container.scrollIntoView({ block: 'start' }); } catch (_) { /* noop */ }

        const loaderEl = this.container.querySelector('.genre-bucket-loader');
        this.bucketObserver = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) this.loadBucketPage();
        }, { rootMargin: '700px' });
        this.loadBucketPage().then(() => {
            if (loaderEl) this.bucketObserver.observe(loaderEl);
        });
    }

    async loadBucketPage() {
        if (this.bucketLoading || !this.bucketHasMore || !this.activeBucket) return;
        this.bucketLoading = true;
        try {
            const payload = await API.media.genreItems({ type: 'movie', bucket: this.activeBucket, limit: 36, offset: this.bucketOffset, ...this.currentLanguageParams() });
            const items = (payload && payload.items) || [];
            window.GenreRails.appendCards(this.bucketGridEl, items, {
                startIndex: this.bucketOffset,
                onItemClick: (item) => this.openRailItem(item)
            });
            this.bucketOffset += items.length;
            this.bucketHasMore = Boolean(payload && payload.hasMore) && items.length > 0;
        } catch (err) {
            console.warn('[Movies] Genre bucket page failed:', err);
            this.bucketHasMore = false;
        } finally {
            this.bucketLoading = false;
        }
    }

    closeBucket() {
        this.activeBucket = null;
        this.activeBucketLangKey = null;
        this.bucketObserver?.disconnect();
        this.bucketObserver = null;
        // Drop the genre + language filter selection (set silently — rails below).
        if (this.categoryMulti?.getSelected().size) this.categoryMulti.setSelected([]);
        if (this.audioSelect) this.audioSelect.value = '';
        if (this.subtitleSelect) this.subtitleSelect.value = '';
        if (this.sortSelect?.value === 'lang-match') this.sortSelect.value = 'default';
        this.persistFilters();
        this.renderGenreRails();
    }

    // Local-mode genre rails: group already-loaded movies by curated bucket and
    // render them with the page's own cards (so clicks open details normally).
    renderGenreRailsLocal() {
        const T = window.GenreTaxonomy;
        if (!T || !window.GenreRails || !Array.isArray(this.movies) || !this.movies.length) return false;

        const byBucket = new Map();
        for (const m of this.movies) {
            if (this.hideBroken && this.isBrokenItem(m)) continue;
            const genres = (m.tmdb && m.tmdb.genres) || [];
            for (const b of T.classifyTitle(m.category_name || m.category_id, genres)) {
                if (b === 'autres') continue;
                const arr = byBucket.get(b) || [];
                if (arr.length < 30) arr.push(m);
                byBucket.set(b, arr);
            }
        }

        const sections = [];
        for (const def of T.BUCKETS) {
            if (def.id === 'autres') continue;
            const movies = byBucket.get(def.id);
            if (!movies || !movies.length) continue;
            const groups = this.groupDuplicates
                ? MediaUtils.groupItems(movies, { idField: 'stream_id' })
                : movies.map((it) => ({ key: it.id, items: [it], representative: it }));
            sections.push({ title: def.label, cards: groups.map((g) => this.buildCard(g)) });
        }
        if (!sections.length) return false;

        if (this.countEl) this.countEl.textContent = '';
        this.resetBtn?.classList.add('hidden');
        if (this.randomBtn) this.randomBtn.disabled = true;
        window.GenreRails.renderCustom(this.container, sections);
        return true;
    }

    resetFilters() {
        [this.sortSelect, this.genreSelect, this.yearSelect, this.ratingSelect,
         this.watchedSelect, this.addedSelect, this.durationSelect,
         this.audioSelect, this.subtitleSelect].forEach(sel => {
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
            this.audioSelect?.value || this.subtitleSelect?.value ||
            this.searchInput?.value || this.showFavoritesOnly || this.hideBroken === false ||
            (this.categoryMulti?.getSelected().size > 0)
        );
    }

    // === Page lifecycle ===

    async show() {
        const summary = await this.app?.refreshSourceHealth?.();
        if (this.app?.isCatalogReady && !this.app.isCatalogReady(summary || undefined)) {
            this.renderCatalogLocked();
            return;
        }

        if (this.sources.length === 0) {
            await this.loadSources();
        }

        await Promise.all([this.loadFavorites(), this.loadWatchState(), this.loadServerSettings(), this.loadPlaybackStatuses()]);
        this.renderContinueWatching();
        this.populateLanguageFacets();
        // While the page is visible, refresh the language menus periodically so they
        // track the crawl in near-real-time. Gentle (server-memoized 60s, skips DOM work
        // when unchanged); cleared in hide().
        if (this._facetTimer) clearInterval(this._facetTimer);
        this._facetTimer = setInterval(() => this.populateLanguageFacets(), 120000);

        // A genre is selected (e.g. returning to the page) → (re)open its grid.
        if (this.isCloudPagedMode()) {
            const selectedBuckets = [...(this.categoryMulti?.getSelected() || [])];
            if (selectedBuckets.length) {
                if (!this.categories.length) await this.loadCategories();
                this.activeBucket = null;
                this.openGenreBucket(selectedBuckets[0]);
                return;
            }
        }

        // Default cloud view with no active filters → Netflix-style genre rails.
        if (this.shouldShowRails()) {
            if (!this.categories.length) this.loadCategories(); // keep the filter dropdown ready
            await this.renderGenreRails();
            return;
        }

        if (this.movies.length === 0) {
            // Categories only feed the filter dropdown — load them alongside the
            // movie page instead of gating the grid's first paint on them.
            await Promise.all([this.loadCategories(), this.loadMovies()]);
        } else {
            this.filterAndRender();
        }
    }

    hide() {
        if (this._facetTimer) { clearInterval(this._facetTimer); this._facetTimer = null; }
    }

    renderCatalogLocked() {
        this.hideDetails?.();
        this.movies = [];
        this.filteredCards = [];
        this.historyItems = [];
        this.watchState = new Map();
        this.cloudHasMore = false;
        this.cloudLoadingMore = false;
        this.continueRow?.classList.add('hidden');
        if (this.countEl) this.countEl.textContent = '';
        if (this.container) {
            this.container.classList.remove('rail-host');
            this.container.innerHTML = `
                <div class="catalog-locked-empty">
                    <h2>Connect your TV service first</h2>
                    <p>Movies unlock as soon as Norva finishes preparing your catalog.</p>
                    <button class="btn btn-primary" id="movies-connect-service">Connect TV Service</button>
                </div>
            `;
            this.container.querySelector('#movies-connect-service')?.addEventListener('click', () => {
                this.app?.navigateTo?.('home');
            });
        }
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
            const activeSourceIds = new Set((this.sources || []).map(source => String(source.id)));
            this.watchState = new Map();
            this.historyItems = (history || []).filter(item => {
                const sourceId = item.source_id || item.sourceId || item.data?.sourceId;
                return sourceId && activeSourceIds.has(String(sourceId));
            });
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
            this.hiddenCategoryIds = new Set();
            // Mirror Manage Content: the dropdown lists the clean, curated genre
            // buckets (with counts) instead of the raw provider category names.
            // Picking a genre opens that genre's full grid (see onFiltersChanged).
            const payload = await API.media.genreSummary({ type: 'movie' });
            const genres = Array.isArray(payload) ? payload : (payload?.genres || []);
            this.categories = genres;
            const options = genres
                .filter(g => Number(g.count) > 0)
                .map(g => ({ value: g.bucket, label: `${g.label} · ${Number(g.count).toLocaleString('en-US')}` }));
            this.categoryMulti.setOptions(options);
        } catch (err) {
            console.error('Error loading cloud movie genres:', err);
        }
    }

    async loadMovies() {
        if (this.isCloudPagedMode()) {
            return this.loadCloudMovies({ reset: true });
        }

        this.isLoading = true;
        this.container.classList.remove('rail-host');
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
            sort: this.sortSelect?.value || 'default',
            q: (this.searchInput?.value || '').trim(),
            limit: this.cloudPageSize,
            offset
        };
    }

    catalogCacheKey() {
        // Only the DEFAULT first screen (no source/category/search filter, default
        // sort) is cached — that's the cold-load view worth painting instantly.
        // Returns null otherwise so searches/sorted/filtered views never bloat storage.
        const p = this.cloudPageParams(0);
        if (p.sourceId || p.categoryId || p.q || (p.sort && p.sort !== 'default')) return null;
        return 'movies:default';
    }

    async loadCloudMovies({ reset = false } = {}) {
        if (this.cloudLoadingMore || (this.isLoading && !reset)) return;

        let paintedFromCache = false;
        if (reset) {
            this.isLoading = true;
            this.cloudRequestId += 1;
            this.cloudOffset = 0;
            this.cloudHasMore = false;
            this.cloudTotal = null;
            this.movies = [];
            this.filteredCards = [];
            this.currentBatch = 0;
            // Stale-while-revalidate: paint the cached first page instantly, then
            // refresh from the network below and replace it.
            const cacheKey = this.catalogCacheKey();
            const cached = cacheKey && window.NorvaCatalogCache?.read?.(cacheKey);
            if (cached?.data?.items?.length) {
                this.movies = cached.data.items.slice();
                this.cloudHasMore = Boolean(cached.data.hasMore);
                this.cloudTotal = cached.data.count ?? null;
                this.populateGenres();
                this.filterAndRender();
                paintedFromCache = true;
            } else {
                this.container.classList.remove('rail-host');
                this.container.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
            }
        } else {
            this.cloudLoadingMore = true;
        }

        try {
            const requestId = this.cloudRequestId;
            const renderedBefore = reset ? 0 : this.container.querySelectorAll('.movie-card').length;
            // On reset always refetch page 1 (offset 0), even after a cache paint.
            const page = await API.media.page(this.cloudPageParams(reset ? 0 : this.cloudOffset));
            if (reset && requestId !== this.cloudRequestId) return;
            const incoming = (page.items || [])
                .filter(m => !this.hiddenCategoryIds.has(`${m.sourceId}:${m.category_id}`))
                .map(m => ({
                    ...m,
                    sourceId: m.sourceId,
                    id: `${m.sourceId}:${m.stream_id}`
                }));

            // Fresh page 1 replaces the cache paint; later pages append.
            if (reset) { this.movies = []; this.cloudOffset = 0; }
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
                // Cache the fresh first page for an instant next cold entry.
                try {
                    const ck = this.catalogCacheKey();
                    if (ck) window.NorvaCatalogCache?.write?.(ck, {
                        items: this.movies.slice(0, this.cloudPageSize),
                        hasMore: this.cloudHasMore,
                        count: this.cloudTotal
                    });
                } catch (_) { /* best-effort */ }
            } else {
                this.filteredCards = this.buildFilteredCards();
                this.updateResultChrome(this.filteredCards);
                this.currentBatch = Math.ceil(renderedBefore / this.batchSize);
                this.renderNextBatch();
            }
        } catch (err) {
            console.error('Error loading cloud movies:', err);
            // Keep the cached paint on error; only show an error with nothing shown.
            if (reset && !paintedFromCache) {
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

        // Cloud mode filters genre via the dedicated grid (openGenreBucket); the
        // self-hosted grid still filters by the selected provider category here.
        if (!this.isCloudPagedMode()) {
            const selectedCats = this.categoryMulti?.getSelected();
            if (selectedCats && selectedCats.size > 0 &&
                !selectedCats.has(`${item.sourceId}:${item.category_id}`)) {
                return false;
            }
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
        cards = this.applyLanguagePreferencesToCards(cards);
        if (this.getPreferences().strictLanguageMatching) {
            cards = cards.filter(c => !this.isStrictLanguageExcluded(c));
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
        // Local (self-hosted) mode default with no active filter → genre rails,
        // built client-side from already-loaded titles. Cloud mode is untouched
        // (it renders rails via the server in renderGenreRails).
        if (!this.isCloudPagedMode() && !this.hasActiveFilters() && this.renderGenreRailsLocal()) {
            return;
        }

        const cards = this.buildFilteredCards();

        this.filteredCards = cards;

        // Counter + reset visibility
        this.updateResultChrome(cards);

        console.log(`[Movies] Displaying ${cards.length} cards from ${this.movies.length} movies`);

        this.currentBatch = 0;
        // Flat card grid → drop the rail-host modifier so the grid centers/wraps.
        this.container.classList.remove('rail-host');
        this.container.innerHTML = '';

        // No results → disable "Random" so it isn't a silent no-op.
        if (this.randomBtn) this.randomBtn.disabled = cards.length === 0;

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
        const pref = (a, b) => (b.preferenceScore || 0) - (a.preferenceScore || 0);
        const sortWithPreference = (compare) => cards.sort((a, b) => compare(a, b) || pref(a, b));
        switch (sort) {
            case 'added':
                sortWithPreference((a, b) => this.parseAddedMs(rep(b)) - this.parseAddedMs(rep(a)));
                break;
            case 'rating':
                sortWithPreference((a, b) => (parseFloat(rep(b).rating) || 0) - (parseFloat(rep(a).rating) || 0));
                break;
            case 'year':
                sortWithPreference((a, b) => (this.getItemYear(rep(b)) || 0) - (this.getItemYear(rep(a)) || 0));
                break;
            case 'year-asc':
                sortWithPreference((a, b) => (this.getItemYear(rep(a)) || 9999) - (this.getItemYear(rep(b)) || 9999));
                break;
            case 'name':
                sortWithPreference((a, b) => (rep(a).name || '').localeCompare(rep(b).name || ''));
                break;
            default:
                cards.sort(pref); // language preference first, stable provider order for ties
                break;
        }
    }

    applyLanguagePreferencesToCards(cards) {
        const prefs = this.getPreferences();
        if (!window.MediaUtils?.orderVersionsByPreference) return cards;
        return cards.map(card => {
            const ordered = MediaUtils.orderVersionsByPreference(card.items || [], prefs);
            const representative = ordered[0] || card.representative;
            const preferenceScore = window.MediaUtils?.scoreTitleForPreferences
                ? MediaUtils.scoreTitleForPreferences({ ...representative, variants: ordered }, prefs)
                : 0;
            return { ...card, items: ordered, representative, preferenceScore };
        });
    }

    isStrictLanguageExcluded(card) {
        const prefs = this.getPreferences();
        if (!prefs.strictLanguageMatching || !window.MediaUtils?.analyzeLanguageCompatibility) return false;
        const wantsAudio = Boolean(prefs.preferredAudioLanguage);
        const wantsSubtitle = Boolean(prefs.preferredSubtitleLanguage && prefs.preferredSubtitleLanguage !== 'none');
        if (!wantsAudio && !wantsSubtitle) return false;
        return (card.items || []).every(item => {
            const analysis = MediaUtils.analyzeLanguageCompatibility(item, prefs);
            const audioAbsent = wantsAudio && analysis.audio?.state === 'confirmed_absent';
            const subtitleAbsent = wantsSubtitle && analysis.subtitle?.state === 'confirmed_absent';
            return audioAbsent || subtitleAbsent;
        });
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
        const languageBadge = MediaUtils.versionLanguageBadge(movie, this.getPreferences());

        card.innerHTML = `
            <div class="movie-poster">
                <img src="${MediaUtils.escapeHtml(poster)}" alt="${MediaUtils.escapeHtml(displayName)}"
                     onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'" loading="lazy">
                <div class="movie-play-overlay">
                    <span class="play-icon">${Icons.play}</span>
                </div>
                ${groupBroken ? '<span class="playback-badge" title="Playback failed">HS</span>' : ''}
                ${versionCount > 1 ? `<button class="version-badge" title="Choose version">${versionCount} versions</button>` : ''}
                ${languageBadge ? `<span class="version-language-badge ${versionCount > 1 ? 'with-version-badge' : ''}">${MediaUtils.escapeHtml(languageBadge)}</span>` : ''}
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
                this.openGroup(group, { focusVersions: true });
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

    // === Movie detail destination ===

    openGroup(group, { focusVersions = false, selectedMovie = null } = {}) {
        const ordered = MediaUtils.orderVersionsByPreference(group.items, this.getPreferences());
        const resumeVersion = ordered.find(item => {
            const state = this.watchState.get(String(item.stream_id));
            return state && state.ratio > 0.01 && state.ratio < 0.9;
        });
        this.showMovieDetails(group, selectedMovie || resumeVersion || ordered[0], {
            versions: ordered,
            focusVersions
        });
    }

    // Open a movie's detail directly from a search result: best-effort fetch its
    // sibling versions, group them exactly like the grid, and open the matching
    // group (so the version picker is complete). Falls back to a single-item group,
    // and returns false on any failure so the caller can fall back to its own path.
    async openByItem(item) {
        try {
            if (!item || item.stream_id == null) return false;
            const title = item.tmdb?.title || item.name || '';
            const tapped = { ...item, sourceId: item.sourceId, id: `${item.sourceId}:${item.stream_id}` };
            const items = [tapped];
            try {
                const page = await API.media.page({ type: 'movie', q: title, limit: 60 });
                const seen = new Set([`${tapped.sourceId}:${tapped.stream_id}`]);
                for (const m of (page.items || [])) {
                    const k = `${m.sourceId}:${m.stream_id}`;
                    if (!seen.has(k)) { seen.add(k); items.push({ ...m, sourceId: m.sourceId, id: k }); }
                }
            } catch (_) { /* best-effort: keep just the tapped item */ }
            const inGroup = (g) => g.items.some(i =>
                String(i.stream_id) === String(item.stream_id) && String(i.sourceId) === String(item.sourceId));
            const group = MediaUtils.groupItems(items, { idField: 'stream_id' }).find(inGroup)
                || { key: 'search', items: [tapped], representative: tapped };
            const selected = group.items.find(i => String(i.stream_id) === String(item.stream_id)) || null;
            this.openGroup(group, { selectedMovie: selected });
            return true;
        } catch (_) {
            return false;
        }
    }

    getMovieDisplayTitle(movie = this.currentMovie) {
        return movie?.tmdb?.title || movie?.title || movie?.name || 'Movie';
    }

    getMoviePoster(movie = this.currentMovie) {
        return MediaUtils.safeImageUrl(
            movie?.stream_icon || movie?.cover || MediaUtils.tmdbPosterUrl(movie?.tmdb, 'w600_and_h900_bestv2'),
            '/img/norva-media-placeholder.png'
        );
    }

    getTmdbImageUrl(path, size = 'w1280') {
        const raw = String(path || '').trim();
        if (!raw) return null;
        if (/^https?:\/\//i.test(raw)) return MediaUtils.safeImageUrl(raw);
        if (raw.startsWith('/')) return MediaUtils.safeImageUrl(`https://image.tmdb.org/t/p/${size}${raw}`);
        return null;
    }

    getMovieBackdrop(movie = this.currentMovie) {
        return this.getTmdbImageUrl(
            movie?.backdrop_path || movie?.tmdb?.backdrop_path || movie?.backdrop || movie?.tmdb?.backdrop,
            'w1280'
        ) || this.getMoviePoster(movie);
    }

    getMovieGenres(movie = this.currentMovie) {
        const genres = movie?.tmdb?.genres || movie?.genres || [];
        if (Array.isArray(genres)) {
            return genres.map(g => typeof g === 'string' ? g : g?.name).filter(Boolean);
        }
        return String(genres || '').split(',').map(g => g.trim()).filter(Boolean);
    }

    getCategoryName(movie = this.currentMovie) {
        return movie?.category_name
            || movie?.metadata?.categoryName
            || movie?.metadata?.category_name
            || '';
    }

    getMovieDuration(movie = this.currentMovie) {
        const runtime = Number(movie?.tmdb?.runtime || movie?.runtime || movie?.duration_minutes);
        if (Number.isFinite(runtime) && runtime > 0) return `${Math.round(runtime)} min`;
        const seconds = MediaUtils.parseDurationToSeconds(movie?.duration || movie?.duration_secs || movie?.duration_seconds);
        if (!seconds) return '';
        const minutes = Math.round(seconds / 60);
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        if (h <= 0) return `${minutes} min`;
        return m ? `${h} h ${m} min` : `${h} h`;
    }

    getMovieWatchState(movie = this.currentMovie) {
        const state = this.watchState.get(String(movie?.stream_id));
        if (!state) return { status: 'unwatched', ratio: 0, progress: 0, duration: 0, resumeTime: 0 };
        const resumeTime = this.getResumeOffset(state.progress, state.duration);
        if (state.ratio >= 0.9) return { ...state, status: 'watched', resumeTime: 0 };
        if (resumeTime > 0) return { ...state, status: 'inprogress', resumeTime };
        return { ...state, status: 'unwatched', resumeTime: 0 };
    }

    getMovieActionLabel(movie = this.currentMovie) {
        const state = this.getMovieWatchState(movie);
        if (state.status === 'inprogress') return 'Resume';
        if (state.status === 'watched') return 'Recommencer';
        return 'Lire';
    }

    syncDetailFavoriteButton() {
        if (!this.detailFavoriteBtn || !this.currentMovieGroup) return;
        const isFav = this.currentMovieGroup.items.some(i => this.favoriteIds.has(`${i.sourceId}:${i.stream_id}`));
        this.detailFavoriteBtn.classList.toggle('active', isFav);
        this.detailFavoriteBtn.title = isFav ? 'Remove from Favorites' : 'Add to Favorites';
        const icon = this.detailFavoriteBtn.querySelector('.fav-icon');
        const label = this.detailFavoriteBtn.querySelector('.fav-label');
        if (icon) icon.innerHTML = isFav ? Icons.favorite : Icons.favoriteOutline;
        if (label) label.textContent = 'Favorite';
    }

    // === Offline downloads (native phone/tablet app only) ===

    /** The native download bridge, present only inside the Norva mobile APK. */
    nativeDownloadBridge() {
        const b = window.NorvaTVCloud;
        return (b && typeof b.downloadMedia === 'function') ? b : null;
    }

    /** Current download state for the open movie: none | queued | downloading | done | failed. */
    downloadStateFor(movie) {
        const bridge = this.nativeDownloadBridge();
        if (!bridge || !movie) return 'none';
        try {
            const id = `${movie.sourceId}:${movie.stream_id}`;
            if (typeof bridge.downloadState === 'function') return bridge.downloadState(id) || 'none';
        } catch (_) { /* fall through */ }
        return 'none';
    }

    /** Reflect the download bridge + state on the fiche button (hidden in the browser). */
    syncDownloadButton() {
        const btn = this.detailDownloadBtn;
        if (!btn) return;
        const bridge = this.nativeDownloadBridge();
        if (!bridge || !this.currentMovie) {
            btn.style.display = 'none';
            this.stopDownloadPolling();
            return;
        }
        btn.style.display = '';
        const state = this.downloadStateFor(this.currentMovie);
        const label = btn.querySelector('.download-label');
        const icon = btn.querySelector('.download-icon');
        btn.classList.remove('is-downloading', 'is-done');
        btn.disabled = false;
        let text = 'Download';
        if (state === 'done') {
            text = 'Downloaded';
            btn.classList.add('is-done');
            if (icon) icon.innerHTML = '&#x2713;'; // check
        } else if (state === 'downloading' || state === 'queued') {
            text = state === 'queued' ? 'Queued…' : 'Downloading…';
            btn.classList.add('is-downloading');
            if (icon) icon.innerHTML = '&#x2193;';
        } else {
            if (icon) icon.innerHTML = '&#x2193;';
        }
        if (label) label.textContent = text;
        btn.title = state === 'done' ? 'Open downloads' : 'Download for offline';
        // Reveal the Downloads menu entry as soon as something is downloading.
        window.app?.refreshDownloadsNav?.();
        // Poll while in flight so the label tracks progress and flips to Downloaded.
        if (state === 'downloading' || state === 'queued') this.startDownloadPolling();
        else this.stopDownloadPolling();
    }

    startDownloadPolling() {
        if (this._downloadPollTimer) return;
        this._downloadPollTimer = setInterval(() => {
            if (!this.currentMovie || !this.detailDownloadBtn || this.detailsPanel?.classList.contains('hidden')) {
                this.stopDownloadPolling();
                return;
            }
            this.syncDownloadButton();
        }, 1500);
    }

    stopDownloadPolling() {
        if (this._downloadPollTimer) {
            clearInterval(this._downloadPollTimer);
            this._downloadPollTimer = null;
        }
    }

    async onDownloadClick() {
        const bridge = this.nativeDownloadBridge();
        if (!bridge || !this.currentMovie) return;
        const state = this.downloadStateFor(this.currentMovie);
        // Already saved (or in flight) → open the native Downloads screen.
        if (state === 'done' || state === 'downloading' || state === 'queued') {
            try { bridge.openDownloads?.(); } catch (_) { /* no-op */ }
            return;
        }
        await this.startMovieDownload(this.currentMovie);
    }

    /** Resolve the direct provider URL (residential IP, no gateway) and queue it natively. */
    async startMovieDownload(movie) {
        const bridge = this.nativeDownloadBridge();
        if (!bridge || !movie) return;
        const btn = this.detailDownloadBtn;
        const label = btn?.querySelector('.download-label');
        try {
            if (btn) { btn.disabled = true; }
            if (label) label.textContent = 'Preparing…';
            const container = movie.container_extension || 'mp4';
            const playbackHint = MediaUtils.playbackHintFromItem
                ? MediaUtils.playbackHintFromItem(movie, { container })
                : { container };
            await this.prepareForPlaybackSession();
            const result = await API.proxy.xtream.getStreamUrl(
                movie.sourceId, movie.stream_id, 'movie', container, playbackHint
            );
            if (!result || !result.url) throw new Error('No stream URL');
            const payload = {
                url: result.url,
                sourceId: String(movie.sourceId),
                itemId: String(movie.stream_id),
                itemType: 'movie',
                title: movie.tmdb?.title || movie.name || 'Movie',
                subtitle: '',
                posterUrl: MediaUtils.downloadablePosterUrl(movie),
                container,
                durationSeconds: movie.tmdb?.runtime ? movie.tmdb.runtime * 60 : 0
            };
            bridge.downloadMedia(JSON.stringify(payload));
        } catch (err) {
            console.warn('[Download] Could not start:', err?.message || err);
            if (label) label.textContent = 'Download failed';
        } finally {
            if (btn) btn.disabled = false;
            // Give the native side a moment to register the entry, then refresh.
            setTimeout(() => this.syncDownloadButton(), 600);
        }
    }

    renderMovieVersions(selectedMovie = this.currentMovie) {
        if (!this.versionsList || !this.versionSummary) return;
        const versions = this.currentMovieVersions || [];
        if (versions.length <= 1) {
            this.versionsList.innerHTML = '';
            this.versionSummary.textContent = 'Best version selected automatically.';
            this.versionsList.closest('.movie-versions-section')?.classList.add('single-version');
            return;
        }

        this.versionsList.closest('.movie-versions-section')?.classList.remove('single-version');
        this.versionSummary.textContent = `${versions.length} versions available. Play uses the selected version.`;
        this.versionsList.innerHTML = versions.map((item, index) => {
            const version = MediaUtils.parseVersionInfo(item.name);
            const state = this.getMovieWatchState(item);
            const active = String(item.stream_id) === String(selectedMovie?.stream_id) &&
                String(item.sourceId) === String(selectedMovie?.sourceId);
            const languageBadge = MediaUtils.versionLanguageBadge(item, this.getPreferences());
            const bits = [
                version.quality,
                languageBadge,
                item.container_extension,
                this.getSourceName(item.sourceId)
            ].filter(Boolean);
            return `
                <button class="movie-version-item ${active ? 'active' : ''}" type="button" data-index="${index}">
                    <span class="movie-version-main">${MediaUtils.escapeHtml(bits.join(' - ') || `Version ${index + 1}`)}</span>
                    <span class="movie-version-sub">${MediaUtils.escapeHtml(item.name || this.getMovieDisplayTitle(item))}</span>
                    ${state.status === 'inprogress' ? '<span class="movie-version-progress">En cours</span>' : ''}
                    ${state.status === 'watched' ? '<span class="movie-version-progress">Vu</span>' : ''}
                </button>`;
        }).join('');

        this.versionsList.querySelectorAll('.movie-version-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.index);
                const movie = versions[index];
                if (movie) this.showMovieDetails(this.currentMovieGroup, movie, { versions });
            });
        });
    }

    showMovieDetails(group, selectedMovie = null, { versions = null, focusVersions = false } = {}) {
        if (!group?.items?.length || !this.detailsPanel) return;
        const ordered = versions || MediaUtils.orderVersionsByPreference(group.items, this.getPreferences());
        const movie = selectedMovie || ordered[0] || group.representative;
        const displayMovie = group.representative || movie;

        this.currentMovieGroup = group;
        this.currentMovieVersions = ordered;
        this.currentMovie = movie;

        this.pageEl?.classList.add('movie-detail-open');
        this.container.classList.add('hidden');
        this.detailsPanel.classList.remove('hidden');
        this.detailsPanel.scrollTop = 0;

        const hero = document.getElementById('movie-detail-hero');
        const poster = this.getMoviePoster(displayMovie);
        const backdrop = this.getMovieBackdrop(displayMovie);
        if (hero) hero.style.setProperty('--movie-hero-bg', `url("${String(backdrop).replace(/"/g, '%22')}")`);

        const posterEl = document.getElementById('movie-detail-poster');
        if (posterEl) {
            posterEl.src = poster;
            posterEl.alt = this.getMovieDisplayTitle(displayMovie);
        }

        const titleEl = document.getElementById('movie-detail-title');
        if (titleEl) titleEl.textContent = this.getMovieDisplayTitle(displayMovie);

        const plotEl = document.getElementById('movie-detail-plot');
        if (plotEl) plotEl.textContent = displayMovie.tmdb?.overview || displayMovie.plot || 'No summary available yet.';

        const version = MediaUtils.parseVersionInfo(movie.name);
        const rating = parseFloat(displayMovie.rating || displayMovie.tmdb?.vote_average);
        const ratingLabel = Number.isFinite(rating) && rating > 0 ? `Note ${rating.toFixed(1).replace('.0', '')}` : '';
        const metaParts = [
            this.getItemYear(displayMovie),
            this.getMovieDuration(displayMovie),
            ratingLabel,
            ...this.getMovieGenres(displayMovie).slice(0, 3),
            version.quality,
            MediaUtils.versionLanguageBadge(movie, this.getPreferences()),
            ordered.length > 1 ? `${ordered.length} versions` : '',
            this.getCategoryName(displayMovie)
        ].filter(Boolean);

        const metaEl = document.getElementById('movie-detail-meta');
        if (metaEl) metaEl.innerHTML = metaParts.map(part => `<span>${MediaUtils.escapeHtml(part)}</span>`).join('');

        const state = this.getMovieWatchState(movie);
        const progressEl = document.getElementById('movie-detail-progress');
        if (progressEl) {
            progressEl.classList.toggle('hidden', !(state.ratio > 0.01 && state.ratio < 0.9));
            const fill = progressEl.querySelector('div');
            if (fill) fill.style.width = `${Math.max(0, Math.min(100, Math.round((state.ratio || 0) * 100)))}%`;
        }

        if (this.primaryActionBtn) {
            this.primaryActionBtn.disabled = false;
            this.primaryActionBtn.dataset.streamId = movie.stream_id;
            this.primaryActionBtn.dataset.sourceId = movie.sourceId;
            this.primaryActionBtn.innerHTML = `<span class="play-icon">${Icons.play}</span><span>${MediaUtils.escapeHtml(this.getMovieActionLabel(movie))}</span>`;
        }

        this.syncDetailFavoriteButton();
        this.syncDownloadButton();
        this.renderMovieVersions(movie);

        if (focusVersions) {
            setTimeout(() => {
                this.detailsPanel?.querySelector('.movie-versions-section')?.scrollIntoView({ block: 'start' });
            }, 50);
        }
    }

    hideDetails() {
        this.stopDownloadPolling();
        this.detailsPanel?.classList.add('hidden');
        this.container?.classList.remove('hidden');
        this.pageEl?.classList.remove('movie-detail-open');
        this.currentMovie = null;
        this.currentMovieGroup = null;
        this.currentMovieVersions = [];
    }

    async playPrimaryMovie() {
        if (!this.currentMovie) return;
        const versions = this.currentMovieVersions?.length
            ? [this.currentMovie, ...this.currentMovieVersions.filter(item =>
                String(item.stream_id) !== String(this.currentMovie.stream_id) ||
                String(item.sourceId) !== String(this.currentMovie.sourceId)
            )]
            : [this.currentMovie];
        const state = this.getMovieWatchState(this.currentMovie);
        await this.playMovie(this.currentMovie, {
            versions,
            resumeTime: state.resumeTime || 0,
            playbackPreferences: state.data?.playbackPreferences || state.data?.playback_preferences || null
        });
    }

    // === Playback ===

    getPreferences() {
        return {
            preferredLanguage: this.serverSettings.preferredLanguage || '',
            preferredAudioLanguage: this.serverSettings.preferredAudioLanguage || '',
            preferredSubtitleLanguage: this.serverSettings.preferredSubtitleLanguage || '',
            strictLanguageMatching: Boolean(this.serverSettings.strictLanguageMatching),
            preferredGenres: this.serverSettings.preferredGenres || [],
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

    getGatewayResumePlan(resumeOffset, requestedPreRoll = 0) {
        const target = Math.max(0, Math.floor(Number(resumeOffset) || 0));
        const requested = Math.max(0, Math.floor(Number(requestedPreRoll) || 0));
        // The gateway now seeks cleanly (linear read + accurate output seek), so
        // no client pre-roll is needed — it only added a delay while the
        // transcoder ground up to the resume point.
        const preRoll = target > 5 ? Math.min(target, requested) : 0;
        const sessionStart = Math.max(0, target - preRoll);
        return {
            target,
            sessionStart,
            localSeekTarget: Math.max(0, target - sessionStart)
        };
    }

    async playMovie(movie, { versions = null, resumeTime = 0, playbackPreferences = null } = {}) {
        const watch = this.app.pages.watch;
        if (!watch) return;
        const container = movie.container_extension || 'mp4';
        const resumeOffset = Math.max(0, Math.floor(Number(resumeTime) || 0));
        const resumePlan = this.getGatewayResumePlan(resumeOffset);
        const playbackHint = MediaUtils.playbackHintFromItem
            ? MediaUtils.playbackHintFromItem(movie, { container })
            : { container };
        if (resumePlan.sessionStart > 0) {
            playbackHint.seekOffset = resumePlan.sessionStart;
            playbackHint.startOffset = resumePlan.sessionStart;
            playbackHint.resumeTime = resumePlan.sessionStart;
        }
        const audioStreamIndex = Number(playbackPreferences?.audio?.streamIndex ?? playbackPreferences?.audio?.stream_index);
        if (Number.isInteger(audioStreamIndex)) {
            playbackHint.audioStreamIndex = audioStreamIndex;
        }
        const versionList = (versions || [movie]).map(v => ({
            sourceId: v.sourceId,
            streamId: v.stream_id,
            container: v.container_extension || 'mp4',
            type: 'movie',
            label: MediaUtils.versionLabel(v, this.getSourceName(v.sourceId))
        }));
        const content = {
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
            resumeTime: resumePlan.target,
            playbackPreferences,
            durationHint: movie.tmdb?.runtime ? movie.tmdb.runtime * 60 : null,
            versions: versionList,
            versionIndex: 0,
            audioLanguages: movie.audioLanguages || movie.audio_languages || null,
            versionLanguages: movie.versionLanguages || movie.version_languages || null,
            originalLanguage: movie.originalLanguage || movie.original_language || null,
            // Precomputed ordered per-track language map (served on the grid item by
            // norva-catalog attachMediaLanguages). Lets the player label every audio
            // track with zero playback-time probe — see WatchPage.getContentAudioTracks.
            audioTracks: movie.audioTracks || movie.audio_tracks || null
        };

        // Open the player immediately (poster + loading animation), then resolve
        // the stream URL into the already-visible shell.
        await watch.play(content, async () => {
            await this.prepareForPlaybackSession();
            const result = await API.proxy.xtream.getStreamUrl(
                movie.sourceId,
                movie.stream_id,
                'movie',
                container,
                playbackHint
            );
            if (!result || !result.url) return null;
            return {
                ...result,
                url: result.url,
                seekOffset: resumePlan.sessionStart,
                startOffset: resumePlan.sessionStart,
                resumeTarget: resumePlan.target
            };
        }, {});
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
