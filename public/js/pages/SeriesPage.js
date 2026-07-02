/**
 * Series Page Controller
 * Handles TV series browsing and playback with rich filtering,
 * duplicate grouping (one card per title) and version selection.
 */

class SeriesPage {
    constructor(app) {
        this.app = app;
        // Native player reports a natural end → autoplay the next episode (no-op on
        // movies / when the fiche isn't open). Harmlessly inert until the APK sends it.
        window.addEventListener('norva-native-ended', (e) => this.onNativeEpisodeEnded(e.detail));
        this.pageEl = document.getElementById('page-series');
        this.container = document.getElementById('series-grid');
        this.sourceSelect = document.getElementById('series-source-select');
        this.searchInput = document.getElementById('series-search');
        this.detailsPanel = document.getElementById('series-details');
        this.seasonsContainer = document.getElementById('series-seasons');
        this.seasonSelect = document.getElementById('series-season-select');
        this.primaryActionBtn = document.getElementById('series-primary-action');
        this.detailFavoriteBtn = document.getElementById('series-detail-favorite');

        // Filter bar elements
        this.sortSelect = document.getElementById('series-sort');
        this.genreSelect = document.getElementById('series-genre');
        this.yearSelect = document.getElementById('series-year');
        this.ratingSelect = document.getElementById('series-rating');
        this.watchedSelect = document.getElementById('series-watched');
        this.addedSelect = document.getElementById('series-added');
        this.statusSelect = document.getElementById('series-status');
        this.audioSelect = document.getElementById('series-audio');
        this.subtitleSelect = document.getElementById('series-subtitle');
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
        this.currentSeriesGroup = null;
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
         this.watchedSelect, this.addedSelect, this.statusSelect,
         this.audioSelect, this.subtitleSelect].forEach(sel => {
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

        this.seasonSelect?.addEventListener('change', () => this.applySelectedSeason());
        this.primaryActionBtn?.addEventListener('click', () => this.playPrimaryEpisode());
        this.detailFavoriteBtn?.addEventListener('click', async (e) => {
            e.preventDefault();
            if (!this.currentSeriesGroup) return;
            await this.toggleFavorite(this.currentSeriesGroup, this.detailFavoriteBtn);
            this.syncDetailFavoriteButton();
        });

        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this.isLoading) {
                this.renderNextBatch();
            }
        }, { rootMargin: '200px' });

        // Continue Watching shrinks to a compact pinned strip while the grid scrolls,
        // reclaiming vertical space without disappearing.
        this.container?.addEventListener('scroll', () => this.updateContinueCompact(), { passive: true });

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
        if (this.audioSelect && s.audio) this.audioSelect.value = s.audio;
        if (this.subtitleSelect && s.subtitle) this.subtitleSelect.value = s.subtitle;
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
            this.loadSeries();
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
        this.openBucket({ id: 'genre-all', title: 'All series', curation: { bucket: 'all' } });
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
            const facets = await API.media.languageFacets({ type: 'series' });
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

    // Netflix-style default: with no active filter/search, the cloud Series page
    // shows curated genre rails instead of a flat grid. Any filter or search
    // flips back to the grid via the normal path.
    shouldShowRails() {
        return this.isCloudPagedMode() && !!window.GenreRails && !this.hasActiveFilters();
    }

    async renderGenreRails() {
        this.railsView = true;
        this.activeBucket = null;
        this.bucketObserver?.disconnect();
        if (this.countEl) this.countEl.textContent = '';
        this.resetBtn?.classList.add('hidden');
        if (this.randomBtn) this.randomBtn.disabled = true; // "Random" needs the flat grid.
        try {
            const payload = await API.media.genreRails({ type: 'series', limit: 18 });
            const rails = (payload && payload.rails) || [];
            if (!rails.length) {
                this.railsView = false;
                return this.loadSeries();
            }
            window.GenreRails.render(this.container, rails, {
                emptyText: 'No shows to show yet.',
                onItemClick: (item) => this.openRailItem(item),
                onSeeAll: (rail) => this.openBucket(rail)
            });
        } catch (err) {
            console.warn('[Series] Genre rails unavailable, falling back to grid:', err);
            this.railsView = false;
            return this.loadSeries();
        }
    }

    // Reuse the Home page's rail→detail path (builds the version group and opens
    // the series detail on this page), so clicks behave exactly like Home rails.
    openRailItem(item) {
        const home = this.app?.pages?.home;
        if (home?.navigateToSeries) home.navigateToSeries(item);
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
            const payload = await API.media.genreItems({ type: 'series', bucket: this.activeBucket, limit: 36, offset: this.bucketOffset, ...this.currentLanguageParams() });
            const items = (payload && payload.items) || [];
            window.GenreRails.appendCards(this.bucketGridEl, items, {
                startIndex: this.bucketOffset,
                onItemClick: (item) => this.openRailItem(item)
            });
            this.bucketOffset += items.length;
            this.bucketHasMore = Boolean(payload && payload.hasMore) && items.length > 0;
        } catch (err) {
            console.warn('[Series] Genre bucket page failed:', err);
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

    // Local-mode genre rails: group already-loaded series by curated bucket and
    // render them with the page's own cards (so clicks open details normally).
    renderGenreRailsLocal() {
        const T = window.GenreTaxonomy;
        if (!T || !window.GenreRails || !Array.isArray(this.seriesList) || !this.seriesList.length) return false;

        const byBucket = new Map();
        for (const s of this.seriesList) {
            if (this.hideBroken && this.isBrokenItem(s)) continue;
            const genres = (s.tmdb && s.tmdb.genres) || [];
            for (const b of T.classifyTitle(s.category_name || s.category_id, genres)) {
                if (b === 'autres') continue;
                const arr = byBucket.get(b) || [];
                if (arr.length < 30) arr.push(s);
                byBucket.set(b, arr);
            }
        }

        const sections = [];
        for (const def of T.BUCKETS) {
            if (def.id === 'autres') continue;
            const list = byBucket.get(def.id);
            if (!list || !list.length) continue;
            const groups = this.groupDuplicates
                ? MediaUtils.groupItems(list, { idField: 'series_id' })
                : list.map((it) => ({ key: it.id, items: [it], representative: it }));
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
         this.watchedSelect, this.addedSelect, this.statusSelect,
         this.audioSelect, this.subtitleSelect].forEach(sel => {
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
            this.audioSelect?.value || this.subtitleSelect?.value ||
            this.searchInput?.value || this.showFavoritesOnly || this.hideBroken === false ||
            (this.categoryMulti?.getSelected().size > 0)
        );
    }

    // === Page lifecycle ===

    async show() {
        this.hideDetails();

        const summary = await this.app?.refreshSourceHealth?.();
        // Show the grid as soon as SERIES are available (even mid-sync), not only when
        // the whole catalogue is "ready" — Live TV already does this. Falls back to the
        // ready check if the per-category helper isn't present.
        const seriesLocked = this.app?.catalogCategoryAvailable
            ? !this.app.catalogCategoryAvailable('series', summary || undefined)
            : (this.app?.isCatalogReady && !this.app.isCatalogReady(summary || undefined));
        if (seriesLocked) {
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
        this._facetTimer = setInterval(() => this.populateLanguageFacets(), 600000);

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

        if (this.seriesList.length === 0) {
            // Categories only feed the filter dropdown — load them alongside the
            // series page instead of gating the grid's first paint on them.
            await Promise.all([this.loadCategories(), this.loadSeries()]);
        } else {
            this.filterAndRender();
        }
    }

    hide() {
        if (this._facetTimer) { clearInterval(this._facetTimer); this._facetTimer = null; }
    }

    renderCatalogLocked() {
        this.hideDetails();
        this.seriesList = [];
        this.filteredCards = [];
        this.historyItems = [];
        this.startedSeriesIds = new Set();
        this.cloudHasMore = false;
        this.cloudLoadingMore = false;
        this.continueRow?.classList.add('hidden');
        if (this.countEl) this.countEl.textContent = '';
        if (this.container) {
            this.container.classList.remove('rail-host');
            this.container.innerHTML = `
                <div class="catalog-locked-empty">
                    <h2>Connect your TV service first</h2>
                    <p>Series unlock as soon as Norva finishes preparing your catalog.</p>
                    <button class="btn btn-primary" id="series-connect-service">Connect TV Service</button>
                </div>
            `;
            this.container.querySelector('#series-connect-service')?.addEventListener('click', () => {
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
            const favs = await API.favorites.getAll(null, 'series');
            this.favoriteIds = new Set(favs.map(f => `${f.source_id}:${f.item_id}`));
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }

    async loadWatchState() {
        try {
            const history = await API.history.getAll(500);
            const activeSourceIds = new Set((this.sources || []).map(source => String(source.id)));
            this.historyItems = (history || []).filter(item => {
                const sourceId = item.source_id || item.sourceId || item.data?.sourceId;
                return sourceId && activeSourceIds.has(String(sourceId));
            });
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
            this.hiddenCategoryIds = new Set();
            // Mirror Manage Content: list the clean, curated genre buckets (with
            // counts) instead of raw provider category names. Picking a genre
            // opens that genre's full grid (see onFiltersChanged).
            const payload = await API.media.genreSummary({ type: 'series' });
            const genres = Array.isArray(payload) ? payload : (payload?.genres || []);
            this.categories = genres;
            const options = genres
                .filter(g => Number(g.count) > 0)
                .map(g => ({ value: g.bucket, label: `${g.label} · ${Number(g.count).toLocaleString('en-US')}` }));
            this.categoryMulti.setOptions(options);
        } catch (err) {
            console.error('Error loading cloud series genres:', err);
        }
    }

    async loadSeries() {
        if (this.isCloudPagedMode()) {
            return this.loadCloudSeries({ reset: true });
        }

        this.isLoading = true;
        this.container.classList.remove('rail-host');
        this.container.innerHTML = MediaUtils.skeletonCards(12);

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
            sort: this.sortSelect?.value || 'default',
            q: (this.searchInput?.value || '').trim(),
            limit: this.cloudPageSize,
            offset
        };
    }

    catalogCacheKey() {
        // Only the DEFAULT first screen is cached (see MoviesPage for rationale).
        const p = this.cloudPageParams(0);
        if (p.sourceId || p.categoryId || p.q || (p.sort && p.sort !== 'default')) return null;
        return 'series:default';
    }

    async loadCloudSeries({ reset = false } = {}) {
        if (this.cloudLoadingMore || (this.isLoading && !reset)) return;

        let paintedFromCache = false;
        if (reset) {
            this.isLoading = true;
            this.cloudRequestId += 1;
            this.cloudOffset = 0;
            this.cloudHasMore = false;
            this.cloudTotal = null;
            this.seriesList = [];
            this.filteredCards = [];
            this.currentBatch = 0;
            // Stale-while-revalidate: paint the cached first page instantly, then
            // refresh from the network below and replace it.
            const cacheKey = this.catalogCacheKey();
            const cached = cacheKey && window.NorvaCatalogCache?.read?.(cacheKey);
            if (cached?.data?.items?.length) {
                this.seriesList = cached.data.items.slice();
                this.cloudHasMore = Boolean(cached.data.hasMore);
                this.cloudTotal = cached.data.count ?? null;
                this.populateGenres();
                this.filterAndRender();
                paintedFromCache = true;
            } else {
                this.container.classList.remove('rail-host');
                this.container.innerHTML = MediaUtils.skeletonCards(12);
            }
        } else {
            this.cloudLoadingMore = true;
        }

        try {
            const requestId = this.cloudRequestId;
            const renderedBefore = reset ? 0 : this.container.querySelectorAll('.series-card').length;
            // On reset always refetch page 1 (offset 0), even after a cache paint.
            const page = await API.media.page(this.cloudPageParams(reset ? 0 : this.cloudOffset));
            if (reset && requestId !== this.cloudRequestId) return;
            const incoming = (page.items || [])
                .filter(s => !this.hiddenCategoryIds.has(`${s.sourceId}:${s.category_id}`))
                .map(s => ({
                    ...s,
                    sourceId: s.sourceId,
                    id: `${s.sourceId}:${s.series_id}`
                }));

            // Fresh page 1 replaces the cache paint; later pages append.
            if (reset) { this.seriesList = []; this.cloudOffset = 0; }
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
                try {
                    const ck = this.catalogCacheKey();
                    if (ck) window.NorvaCatalogCache?.write?.(ck, {
                        items: this.seriesList.slice(0, this.cloudPageSize),
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
            console.error('Error loading cloud series:', err);
            if (reset && !paintedFromCache) {
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

        // Cloud mode filters genre via the dedicated grid (openGenreBucket); the
        // self-hosted grid still filters by the selected provider category here.
        if (!this.isCloudPagedMode()) {
            const selectedCats = this.categoryMulti?.getSelected();
            if (selectedCats && selectedCats.size > 0 &&
                !selectedCats.has(`${item.sourceId}:${item.category_id}`)) {
                return false;
            }
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
        cards = this.applyLanguagePreferencesToCards(cards);
        if (this.getPreferences().strictLanguageMatching) {
            cards = cards.filter(c => !this.isStrictLanguageExcluded(c));
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
        // Local (self-hosted) mode default with no active filter → genre rails,
        // built client-side. Cloud mode is untouched (server rails).
        if (!this.isCloudPagedMode() && !this.hasActiveFilters() && this.renderGenreRailsLocal()) {
            return;
        }

        const cards = this.buildFilteredCards();
        this.filteredCards = cards;

        this.updateResultChrome(cards);

        console.log(`[Series] Displaying ${cards.length} cards from ${this.seriesList.length} series`);

        this.currentBatch = 0;
        // Flat card grid → drop the rail-host modifier so the grid centers/wraps.
        this.container.classList.remove('rail-host');
        this.container.innerHTML = '';
        // Re-rendering resets scrollTop to 0 without firing a scroll event, so
        // re-sync the compact strip to avoid it sticking shrunk at the top.
        this.updateContinueCompact();

        // No results → disable "Random" so it isn't a silent no-op.
        if (this.randomBtn) this.randomBtn.disabled = cards.length === 0;

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
                cards.sort(pref);
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
        const languageBadge = MediaUtils.versionLanguageBadge(series, this.getPreferences());

        card.innerHTML = `
            <div class="series-poster">
                <img src="${MediaUtils.escapeHtml(poster)}" alt="${MediaUtils.escapeHtml(displayName)}"
                     onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'" loading="lazy" decoding="async">
                <div class="series-play-overlay">
                    <span class="play-icon">${Icons.play}</span>
                </div>
                ${groupBroken ? '<span class="playback-badge" title="Playback failed">HS</span>' : ''}
                ${versionCount > 1 ? `<button class="version-badge" title="Choose version">${versionCount} versions</button>` : ''}
                ${languageBadge ? `<span class="version-language-badge ${versionCount > 1 ? 'with-version-badge' : ''}">${MediaUtils.escapeHtml(languageBadge)}</span>` : ''}
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
                     onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'" loading="lazy" decoding="async" alt="">
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
        this.updateContinueCompact();
    }

    // Toggle the compact pinned strip based on how far the grid is scrolled.
    // Hysteresis (compact at >32px, expand at <8px) prevents flicker at the edge.
    updateContinueCompact() {
        if (!this.continueRow || !this.container) return;
        const y = this.container.scrollTop || 0;
        const compact = this.continueRow.classList.contains('is-compact');
        if (!compact && y > 32) this.continueRow.classList.add('is-compact');
        else if (compact && y < 8) this.continueRow.classList.remove('is-compact');
    }

    async resumeEpisodeFromHistory(h) {
        const watch = this.app.pages.watch;
        if (!watch) return;
        const sourceId = parseInt(h.source_id || h.data?.sourceId);
        const seriesId = h.data?.seriesId;
        if (!sourceId || !seriesId) return;

        const resumeOffset = this.getResumeOffset(h.progress, h.duration);
        const resumePlan = this.getGatewayResumePlan(resumeOffset);
        const playbackPreferences = h.data?.playbackPreferences || h.data?.playback_preferences || null;
        // Preliminary content from history data so the player shows instantly;
        // the exact episode details are filled in by the resolver below.
        const content = {
            type: 'series',
            id: h.item_id,
            title: h.data?.title || 'Series',
            subtitle: h.data?.currentSeason ? `S${h.data.currentSeason} E${h.data.currentEpisode || ''}` : 'Series',
            poster: MediaUtils.safeImageUrl(h.data?.poster),
            sourceId,
            seriesId,
            currentSeason: h.data?.currentSeason,
            currentEpisode: h.data?.currentEpisode,
            containerExtension: h.data?.containerExtension || 'mp4',
            resumeTime: resumePlan.target,
            playbackPreferences,
            durationHint: h.duration || 0
        };

        await watch.play(content, async () => {
            await this.prepareForPlaybackSession();
            const info = await API.proxy.xtream.seriesInfo(sourceId, seriesId);
            if (!info?.episodes) return null;

            // Find the episode in seriesInfo
            let episode = null, seasonNum = h.data?.currentSeason, episodeNum = h.data?.currentEpisode;
            for (const [sn, eps] of Object.entries(info.episodes)) {
                const found = eps.find(ep => String(ep.id) === String(h.item_id));
                if (found) { episode = found; seasonNum = sn; episodeNum = found.episode_num; break; }
            }
            if (!episode) return null;

            const container = episode.container_extension || h.data?.containerExtension || 'mp4';
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
            const result = await API.proxy.xtream.getStreamUrl(
                sourceId,
                episode.id,
                'series',
                container,
                playbackHint
            );
            if (!result?.url) return null;

            // Enrich content now that we know the exact episode (play() re-renders these).
            content.id = episode.id;
            content.subtitle = `S${seasonNum} E${episodeNum} - ${episode.title || `Episode ${episodeNum}`}`;
            content.seriesInfo = info;
            content.currentSeason = seasonNum;
            content.currentEpisode = episodeNum;
            content.containerExtension = container;
            content.durationHint = h.duration || MediaUtils.parseDurationToSeconds(episode.duration);
            return {
                ...result,
                url: result.url,
                seekOffset: resumePlan.sessionStart,
                startOffset: resumePlan.sessionStart,
                resumeTarget: resumePlan.target
            };
        }, {});
    }

    // === Group interaction ===

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

    openGroup(group) {
        const ordered = MediaUtils.orderVersionsByPreference(group.items, this.getPreferences());
        this.currentSeriesGroup = group;
        this.showSeriesDetailsV2(ordered[0], group);
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
                this.currentSeriesGroup = group;
                this.showSeriesDetailsV2(ordered[parseInt(btn.dataset.index)], group);
            });
        });

        modal.classList.add('active');
    }

    getSeriesDisplayTitle(series = this.currentSeries) {
        return series?.tmdb?.title || series?.tmdb?.name || series?.name || 'Series';
    }

    getSeriesPoster(series = this.currentSeries) {
        return MediaUtils.safeImageUrl(
            series?.cover || series?.stream_icon || MediaUtils.tmdbPosterUrl(series?.tmdb, 'w600_and_h900_bestv2'),
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

    getSeriesBackdrop(series = this.currentSeries) {
        return this.getTmdbImageUrl(
            series?.backdrop_path || series?.tmdb?.backdrop_path || series?.backdrop || series?.tmdb?.backdrop,
            'w1280'
        ) || this.getSeriesPoster(series);
    }

    getSeriesYear(series = this.currentSeries) {
        const firstAir = series?.tmdb?.first_air_date || series?.first_air_date || series?.releaseDate;
        const fromDate = firstAir ? String(firstAir).match(/(19|20)\d{2}/)?.[0] : null;
        return fromDate || this.getItemYear(series) || '';
    }

    getSeriesGenres(series = this.currentSeries) {
        const genres = series?.tmdb?.genres || series?.genres || [];
        if (Array.isArray(genres)) {
            return genres.map(g => typeof g === 'string' ? g : g?.name).filter(Boolean);
        }
        return String(genres || '').split(',').map(g => g.trim()).filter(Boolean);
    }

    escapeRegExp(value) {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    cleanEpisodeTitle(ep, seasonNum) {
        let title = String(ep?.title || ep?.name || '').trim();
        const episodeNum = ep?.episode_num || ep?.episodeNumber || '';
        if (!title) return `Episode ${episodeNum || ''}`.trim();
        // Scene-release episode names ("[ Torrent911.my ] Station.19.S07E08.FRENCH.WEBRip.x264")
        // come straight from the panel's series-info payload — display-clean them first.
        title = MediaUtils.cleanReleaseName(title) || title;

        const seriesNames = [
            this.getSeriesDisplayTitle(),
            this.currentSeries?.name,
            this.currentSeries?.tmdb?.original_name,
            this.currentSeries?.tmdb?.original_title
        ].filter(Boolean);

        for (const name of seriesNames) {
            title = title.replace(new RegExp(`^${this.escapeRegExp(name)}\\s*[-:–—|]+\\s*`, 'i'), '');
        }
        title = title
            .replace(new RegExp(`^S0?${seasonNum}\\s*E0?${episodeNum}\\s*[-:–—|]+\\s*`, 'i'), '')
            .replace(/^S\d{1,2}E\d{1,3}\s*[-:–—|]+\s*/i, '')
            .trim();

        return title || `Episode ${episodeNum || ''}`.trim();
    }

    getEpisodeImage(ep, series = this.currentSeries) {
        return MediaUtils.safeImageUrl(
            ep?.info?.movie_image || ep?.movie_image || ep?.cover || ep?.stream_icon || this.getSeriesPoster(series),
            '/img/norva-media-placeholder.png'
        );
    }

    formatEpisodeDuration(value) {
        const seconds = MediaUtils.parseDurationToSeconds(value);
        if (!seconds) return String(value || '').trim();
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `${minutes} min`;
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return m ? `${h} h ${m} min` : `${h} h`;
    }

    getSeriesHistoryMap(series = this.currentSeries) {
        const watchedEpisodes = new Map();
        for (const h of (this.historyItems || [])) {
            if (h.item_type === 'episode' && String(h.data?.seriesId) === String(series?.series_id)) {
                const ratio = h.duration > 0 ? h.progress / h.duration : 0;
                watchedEpisodes.set(String(h.item_id), { ...h, ratio });
            }
        }
        return watchedEpisodes;
    }

    flattenEpisodes(info) {
        const rows = [];
        const seasons = Object.keys(info?.episodes || {}).sort((a, b) => parseInt(a) - parseInt(b));
        for (const seasonNum of seasons) {
            const episodes = Array.isArray(info.episodes[seasonNum]) ? info.episodes[seasonNum] : [];
            episodes.forEach((episode, index) => {
                rows.push({
                    seasonNum,
                    episode,
                    episodeNum: episode.episode_num || episode.episodeNumber || index + 1
                });
            });
        }
        return rows;
    }

    getFeaturedEpisode(flatEpisodes, watchedEpisodes) {
        if (!flatEpisodes.length) return null;

        const inProgress = flatEpisodes.find(row => {
            const ratio = watchedEpisodes.get(String(row.episode.id))?.ratio || 0;
            return ratio > 0.02 && ratio < 0.95;
        });
        if (inProgress) {
            return {
                ...inProgress,
                label: `Resume S${inProgress.seasonNum}:E${inProgress.episodeNum}`
            };
        }

        let lastCompletedIndex = -1;
        flatEpisodes.forEach((row, index) => {
            const ratio = watchedEpisodes.get(String(row.episode.id))?.ratio || 0;
            if (ratio >= 0.95) lastCompletedIndex = Math.max(lastCompletedIndex, index);
        });

        const next = flatEpisodes[lastCompletedIndex + 1] || flatEpisodes.find(row => {
            const ratio = watchedEpisodes.get(String(row.episode.id))?.ratio || 0;
            return ratio < 0.95;
        });

        if (next) {
            return {
                ...next,
                label: lastCompletedIndex >= 0
                    ? `Next episode S${next.seasonNum}:E${next.episodeNum}`
                    : `Play S${next.seasonNum}:E${next.episodeNum}`
            };
        }

        const first = flatEpisodes[0];
        return { ...first, label: `Restart S${first.seasonNum}:E${first.episodeNum}` };
    }

    syncDetailFavoriteButton() {
        if (!this.detailFavoriteBtn || !this.currentSeriesGroup) return;
        const isFav = this.currentSeriesGroup.items.some(i => this.favoriteIds.has(`${i.sourceId}:${i.series_id}`));
        this.detailFavoriteBtn.classList.toggle('active', isFav);
        this.detailFavoriteBtn.title = isFav ? 'Remove from Favorites' : 'Add to Favorites';
        const icon = this.detailFavoriteBtn.querySelector('.fav-icon');
        const label = this.detailFavoriteBtn.querySelector('.fav-label');
        if (icon) icon.innerHTML = isFav ? Icons.favorite : Icons.favoriteOutline;
        if (label) label.textContent = 'Favorite';
    }

    playPrimaryEpisode() {
        const episodeId = this.primaryActionBtn?.dataset?.episodeId;
        if (!episodeId) return;
        const episodeEl = [...this.seasonsContainer.querySelectorAll('.episode-item')]
            .find(el => String(el.dataset.episodeId) === String(episodeId));
        if (episodeEl) this.playEpisode(episodeEl);
    }

    applySelectedSeason() {
        if (!this.seasonSelect || !this.seasonsContainer) return;
        const selected = this.seasonSelect.value;
        this.seasonsContainer.querySelectorAll('.season-group').forEach(group => {
            group.classList.toggle('hidden-by-select', selected && group.dataset.season !== selected);
        });
    }

    // Open a series' detail directly from a search result: best-effort fetch its
    // sibling versions, group them like the grid, and open the matching group.
    // Falls back to a single-item group; returns false on failure so the caller
    // can fall back to its own path.
    async openByItem(item) {
        try {
            if (!item || item.series_id == null) return false;
            const title = item.tmdb?.name || item.tmdb?.title || item.name || '';
            const items = [item];
            try {
                const page = await API.media.page({ type: 'series', q: title, limit: 60 });
                const seen = new Set([`${item.sourceId}:${item.series_id}`]);
                for (const s of (page.items || [])) {
                    const k = `${s.sourceId}:${s.series_id}`;
                    if (!seen.has(k)) { seen.add(k); items.push(s); }
                }
            } catch (_) { /* best-effort: keep just the tapped item */ }
            const inGroup = (g) => g.items.some(i =>
                String(i.series_id) === String(item.series_id) && String(i.sourceId) === String(item.sourceId));
            const group = MediaUtils.groupItems(items, { idField: 'series_id' }).find(inGroup)
                || { key: 'search', items: [item], representative: item };
            const series = group.items.find(i => String(i.series_id) === String(item.series_id)) || group.representative || item;
            await this.showSeriesDetailsV2(series, group);
            return true;
        } catch (_) {
            return false;
        }
    }

    async showSeriesDetailsV2(series, group = null) {
        this.currentSeries = series;
        this.currentSeriesGroup = group || this.currentSeriesGroup || { representative: series, items: [series] };
        // Remember the open fiche so a page refresh restores it (see app.restoreOpenFiche).
        try {
            window.app?.rememberOpenFiche?.({
                type: 'series', sourceId: series.sourceId, id: series.series_id,
                title: this.getSeriesDisplayTitle(series),
                // Stash the series + its version group so the restore rebuilds the EXACT fiche.
                series, group: this.currentSeriesGroup,
            });
        } catch (_) { /* best-effort */ }

        this.pageEl?.classList.add('series-detail-open');
        this.container.classList.add('hidden');
        this.detailsPanel.classList.remove('hidden');
        this.detailsPanel.scrollTop = 0;

        const poster = this.getSeriesPoster(series);
        const backdrop = this.getSeriesBackdrop(series);
        const hero = document.getElementById('series-detail-hero');
        if (hero) hero.style.setProperty('--series-hero-bg', `url("${String(backdrop).replace(/"/g, '%22')}")`);
        document.getElementById('series-poster').src = poster;
        document.getElementById('series-title').textContent = this.getSeriesDisplayTitle(series);
        document.getElementById('series-plot').textContent = series.tmdb?.overview || series.plot || 'No summary available yet.';
        this.syncDetailFavoriteButton();
        this.renderMoreLikeThis(series);

        this.seasonsContainer.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
        if (this.primaryActionBtn) {
            this.primaryActionBtn.disabled = true;
            this.primaryActionBtn.textContent = 'Loading...';
            delete this.primaryActionBtn.dataset.episodeId;
        }

        try {
            const info = await API.proxy.xtream.seriesInfo(series.sourceId, series.series_id);
            if (!info || !info.episodes) {
                this.seasonsContainer.innerHTML = '<p class="hint">No episodes found</p>';
                if (this.primaryActionBtn) this.primaryActionBtn.textContent = 'No episodes';
                return;
            }

            this.currentSeriesInfo = info;
            const watchedEpisodes = this.getSeriesHistoryMap(series);
            const flatEpisodes = this.flattenEpisodes(info);
            const seasons = Object.keys(info.episodes).sort((a, b) => parseInt(a) - parseInt(b));
            const episodeCount = flatEpisodes.length;
            const seasonCount = seasons.length;
            const genres = this.getSeriesGenres(series).slice(0, 3);
            const rating = parseFloat(series.rating || series.tmdb?.vote_average);
            const ratingLabel = Number.isFinite(rating) && rating > 0
                ? `★ ${rating.toFixed(1).replace('.0', '')}`
                : '';
            const version = MediaUtils.parseVersionInfo(series.name);
            const metaParts = [
                this.getSeriesYear(series),
                seasonCount ? `${seasonCount} season${seasonCount > 1 ? 's' : ''}` : '',
                episodeCount ? `${episodeCount} episodes` : '',
                ratingLabel,
                ...genres,
                version.quality,
                MediaUtils.versionLanguageBadge(series, this.getPreferences())
            ].filter(Boolean);

            const metaEl = document.getElementById('series-meta');
            if (metaEl) {
                metaEl.innerHTML = metaParts.map(part => `<span>${MediaUtils.escapeHtml(part)}</span>`).join('');
            }

            const featured = this.getFeaturedEpisode(flatEpisodes, watchedEpisodes);
            if (this.seasonSelect) {
                this.seasonSelect.innerHTML = seasons.map(seasonNum =>
                    `<option value="${MediaUtils.escapeHtml(seasonNum)}">Season ${MediaUtils.escapeHtml(seasonNum)}</option>`
                ).join('');
                this.seasonSelect.disabled = seasons.length <= 1;
                if (featured) this.seasonSelect.value = featured.seasonNum;
            }

            if (this.primaryActionBtn) {
                if (featured) {
                    this.primaryActionBtn.disabled = false;
                    this.primaryActionBtn.dataset.episodeId = featured.episode.id;
                    this.primaryActionBtn.innerHTML = `<span class="play-icon">${Icons.play}</span><span>${MediaUtils.escapeHtml(featured.label)}</span>`;
                } else {
                    this.primaryActionBtn.disabled = true;
                    this.primaryActionBtn.textContent = 'No episodes';
                }
            }

            let html = '';
            seasons.forEach(seasonNum => {
                const episodes = Array.isArray(info.episodes[seasonNum]) ? info.episodes[seasonNum] : [];
                html += `
                <div class="season-group" data-season="${MediaUtils.escapeHtml(seasonNum)}">
                    <div class="season-dl-bar" data-season="${MediaUtils.escapeHtml(seasonNum)}" style="display:none">
                        <span class="season-dl-name">Season ${MediaUtils.escapeHtml(seasonNum)}</span>
                        <span class="season-dl-count"></span>
                        <button class="season-download-btn" type="button" data-season="${MediaUtils.escapeHtml(seasonNum)}" title="Download every episode of this season">
                            <span class="season-download-label">Download season</span>
                        </button>
                    </div>
                    <div class="episode-list">
                        ${episodes.map(ep => {
                            const history = watchedEpisodes.get(String(ep.id));
                            const ratio = history?.ratio || 0;
                            const ratioPercent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
                            const marker = ratio >= 0.95 ? '<span class="episode-watched" title="Watched">✓</span>'
                                : (ratio > 0.02 ? '<span class="episode-watched inprogress" title="En cours">◐</span>' : '');
                            const cleanTitle = this.cleanEpisodeTitle(ep, seasonNum);
                            const duration = this.formatEpisodeDuration(ep.duration);
                            const description = ep.plot || ep.info?.plot || ep.overview || '';
                            const thumb = this.getEpisodeImage(ep, series);
                            return `
                            <div class="episode-item" data-episode-id="${MediaUtils.escapeHtml(ep.id)}" data-source-id="${series.sourceId}" data-container="${MediaUtils.escapeHtml(ep.container_extension || 'mp4')}" data-season="${MediaUtils.escapeHtml(seasonNum)}" data-episode-num="${MediaUtils.escapeHtml(ep.episode_num || '')}">
                                <span class="episode-number">${MediaUtils.escapeHtml(ep.episode_num || '')}</span>
                                <div class="episode-thumb">
                                    <img src="${MediaUtils.escapeHtml(thumb)}" alt="" onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'" loading="lazy" decoding="async">
                                    <span class="episode-play">${Icons.play}</span>
                                </div>
                                <div class="episode-copy">
                                    <div class="episode-title-row">
                                        <span class="episode-title">${MediaUtils.escapeHtml(cleanTitle)}</span>
                                        ${marker}
                                    </div>
                                    ${description ? `<p class="episode-description">${MediaUtils.escapeHtml(description)}</p>` : ''}
                                    ${ratioPercent > 0 && ratioPercent < 95 ? `<div class="episode-progress"><div style="width:${ratioPercent}%"></div></div>` : ''}
                                </div>
                                <span class="episode-duration">${MediaUtils.escapeHtml(duration)}</span>
                                <button class="episode-download" type="button" title="Download for offline" style="display:none">
                                    <span class="episode-download-icon">&#x2193;</span>
                                </button>
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
            });

            this.seasonsContainer.innerHTML = html;
            this.seasonsContainer.querySelectorAll('.episode-item').forEach(ep => {
                ep.addEventListener('click', () => this.playEpisode(ep));
            });
            // Offline download per episode + per season (native phone/tablet app only).
            if (this.nativeDownloadBridge()) {
                this.seasonsContainer.querySelectorAll('.episode-download').forEach(btn => {
                    btn.style.display = '';
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.downloadEpisode(btn.closest('.episode-item'), btn);
                    });
                });
                this.seasonsContainer.querySelectorAll('.season-dl-bar').forEach(bar => {
                    bar.style.display = '';
                    const seasonBtn = bar.querySelector('.season-download-btn');
                    seasonBtn?.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.downloadSeason(bar.dataset.season, seasonBtn);
                    });
                });
                this.refreshEpisodeDownloadStates();
            }
            this.applySelectedSeason();
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

    // "More like this": a genre-matched rail at the bottom of the series fiche so the
    // user keeps browsing instead of backing out. Fire-and-forget; a token guards a
    // stale fetch from landing on a newer fiche.
    async renderMoreLikeThis(series) {
        const host = this.detailsPanel;
        if (!host || !window.GenreRails?.appendCards || !API.media?.genreItems) return;
        const token = (this._mltToken = (this._mltToken || 0) + 1);
        host.querySelector('.more-like-this')?.remove();
        try {
            const T = window.GenreTaxonomy;
            const catName = series?.category_name || series?.metadata?.categoryName || '';
            const bucket = T ? T.classifyTitle(catName, this.getSeriesGenres(series))[0] : null;
            if (!bucket) return;
            const payload = await API.media.genreItems({ type: 'series', bucket, limit: 24, ...this.currentLanguageParams() });
            if (token !== this._mltToken || host.classList.contains('hidden')) return;
            const curKey = `${series?.sourceId}:${series?.series_id}`;
            const items = (payload?.items || [])
                .filter(i => `${i.sourceId}:${i.series_id}` !== curKey)
                .slice(0, 18);
            if (!items.length) return;
            host.querySelector('.more-like-this')?.remove();
            const section = document.createElement('section');
            section.className = 'more-like-this';
            section.innerHTML = '<h3 class="more-like-title">More like this</h3><div class="horizontal-scroll more-like-grid"></div>';
            host.appendChild(section);
            window.GenreRails.appendCards(section.querySelector('.more-like-grid'), items, {
                onItemClick: (item) => this.openRailItem(item)
            });
        } catch (_) { /* the fiche works fine without related titles */ }
    }

    hideDetails() {
        try { window.app?.forgetOpenFiche?.(); } catch (_) { /* noop */ }
        this.cancelNextEpisodePrompt();
        this.detailsPanel?.querySelector('.more-like-this')?.remove();
        if (this._epDlTimer) { clearInterval(this._epDlTimer); this._epDlTimer = null; }
        this.detailsPanel.classList.add('hidden');
        this.container.classList.remove('hidden');
        this.pageEl?.classList.remove('series-detail-open');
        this.currentSeries = null;
        this.currentSeriesGroup = null;
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

    // Native-player autoplay: when an episode finishes in the native player, queue
    // the next one with a brief, cancellable "Up next" prompt. Web playback handles
    // its own next-episode flow (WatchPage.onEnded); this only covers the native path.
    onNativeEpisodeEnded(detail = {}) {
        if (!detail || (detail.itemType !== 'episode' && detail.itemType !== 'series')) return;
        // Only when this series fiche is still the open view, with its episode list.
        if (!this.currentSeriesInfo || !this.seasonsContainer || this.detailsPanel?.classList.contains('hidden')) return;
        const all = [...this.seasonsContainer.querySelectorAll('.episode-item')];
        const idx = all.findIndex(el => String(el.dataset.episodeId) === String(detail.itemId));
        if (idx < 0) return;                 // ended episode isn't in this open series
        const nextEl = all[idx + 1];
        if (!nextEl) return;                 // last episode — nothing to autoplay
        this.promptNextEpisode(nextEl);
    }

    promptNextEpisode(nextEl) {
        this.cancelNextEpisodePrompt();
        const title = nextEl.querySelector('.episode-title')?.textContent || 'Next episode';
        const banner = document.createElement('div');
        banner.className = 'up-next-banner';
        banner.innerHTML =
            '<span class="up-next-label">Up next</span>' +
            '<span class="up-next-title"></span>' +
            '<button class="up-next-play" type="button">Play</button>' +
            '<button class="up-next-cancel" type="button" aria-label="Cancel">✕</button>';
        banner.querySelector('.up-next-title').textContent = title;
        document.body.appendChild(banner);
        this._upNextBanner = banner;
        const play = () => { this.cancelNextEpisodePrompt(); this.playEpisode(nextEl); };
        banner.querySelector('.up-next-play').addEventListener('click', play);
        banner.querySelector('.up-next-cancel').addEventListener('click', () => this.cancelNextEpisodePrompt());
        this._upNextTimer = setTimeout(play, 8000);
    }

    cancelNextEpisodePrompt() {
        clearTimeout(this._upNextTimer);
        this._upNextTimer = null;
        if (this._upNextBanner) { this._upNextBanner.remove(); this._upNextBanner = null; }
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
        const seasonNum = episodeEl.dataset.season || (seasonMatch ? seasonMatch[1] : '1');
        const episodeNum = episodeEl.dataset.episodeNum || episodeEl.querySelector('.episode-number')?.textContent?.replace('E', '') || '1';

        const watch = this.app.pages.watch;
        if (!watch) return;
        const h = (this.historyItems || []).find(x =>
            x.item_type === 'episode' && String(x.item_id) === String(episodeId));
        const resumeOffset = h ? this.getResumeOffset(h.progress, h.duration) : 0;
        const resumePlan = this.getGatewayResumePlan(resumeOffset);
        const playbackPreferences = h?.data?.playbackPreferences || h?.data?.playback_preferences || null;
        const playbackHint = MediaUtils.playbackHintFromItem
            ? MediaUtils.playbackHintFromItem(episode, { container, streamType: 'series' })
            : { container, streamType: 'series' };
        // The played stream id is the EPISODE; pass the series id so the server can map
        // back to this title's catalog row to reuse/persist the probed audio map.
        if (this.currentSeries?.series_id) playbackHint.audioSeriesId = this.currentSeries.series_id;
        if (resumePlan.sessionStart > 0) {
            playbackHint.seekOffset = resumePlan.sessionStart;
            playbackHint.startOffset = resumePlan.sessionStart;
            playbackHint.resumeTime = resumePlan.sessionStart;
        }
        const audioStreamIndex = Number(playbackPreferences?.audio?.streamIndex ?? playbackPreferences?.audio?.stream_index);
        if (Number.isInteger(audioStreamIndex)) {
            playbackHint.audioStreamIndex = audioStreamIndex;
        }
        const episodeTitle = episodeEl.querySelector('.episode-title')?.textContent || `Episode ${episodeNum}`;
        // Episode duration ("00:42:10") as timeline fallback
        const durationText = episodeEl.querySelector('.episode-duration')?.textContent;
        const durationHint = (h?.duration) || MediaUtils.parseDurationToSeconds(durationText);
        const content = {
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
            audioLanguages: this.currentSeries?.audioLanguages || this.currentSeries?.audio_languages || null,
            versionLanguages: this.currentSeries?.versionLanguages || this.currentSeries?.version_languages || null,
            // TMDB source language: lets the player resolve a VOSTFR/VO ("original") track to its
            // real language ("Japanese"…) — never assumes one from the VOSTFR tag. Comes from the
            // grid item (norva-catalog) or the series-info response (norva-series-info).
            originalLanguage: this.currentSeries?.originalLanguage || this.currentSeries?.original_language
                || this.currentSeriesInfo?.original_language || null,
            // Precomputed ordered per-track language map (when the series was crawled) so
            // the player labels every audio track with ZERO playback probe — same as movies.
            audioTracks: this.currentSeries?.audioTracks || this.currentSeries?.audio_tracks || null
        };

        // Open the player immediately, then resolve the stream URL into the shell.
        await watch.play(content, async () => {
            await this.prepareForPlaybackSession();
            const result = await API.proxy.xtream.getStreamUrl(
                sourceId,
                episodeId,
                'series',
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

    // === Offline downloads (native phone/tablet app only) ===

    nativeDownloadBridge() {
        const b = window.NorvaTVCloud;
        return (b && typeof b.downloadMedia === 'function') ? b : null;
    }

    episodeDownloadState(id) {
        const bridge = this.nativeDownloadBridge();
        if (!bridge || typeof bridge.downloadState !== 'function') return 'none';
        try { return bridge.downloadState(id) || 'none'; } catch (_) { return 'none'; }
    }

    /**
     * Resolve the direct provider URL for one episode and queue it natively.
     * No UI side-effects (so it can be looped for a whole season). Returns
     * 'queued' | 'skip' (already saved/in flight); throws if the URL can't resolve.
     */
    async queueEpisodeDownload(episodeEl) {
        const bridge = this.nativeDownloadBridge();
        if (!bridge || !episodeEl) return 'skip';
        const episodeId = episodeEl.dataset.episodeId;
        const sourceId = parseInt(episodeEl.dataset.sourceId);
        const container = episodeEl.dataset.container || 'mp4';
        const id = `${sourceId}:${episodeId}`;
        const state = this.episodeDownloadState(id);
        if (state === 'done' || state === 'downloading' || state === 'queued') return 'skip';
        const episode = this.findEpisodeById(episodeId)
            || { id: episodeId, container_extension: container, type: 'episode', streamType: 'series' };
        const seasonNum = episodeEl.dataset.season || '1';
        const episodeNum = episodeEl.dataset.episodeNum || '';
        const episodeTitle = episodeEl.querySelector('.episode-title')?.textContent || `Episode ${episodeNum}`;
        const playbackHint = MediaUtils.playbackHintFromItem
            ? MediaUtils.playbackHintFromItem(episode, { container, streamType: 'series' })
            : { container, streamType: 'series' };
        const result = await API.proxy.xtream.getStreamUrl(sourceId, episodeId, 'series', container, playbackHint);
        if (!result || !result.url) throw new Error('No stream URL');
        const showTitle = this.currentSeries?.tmdb?.title || this.currentSeries?.name || 'Series';
        const payload = {
            url: result.url,
            sourceId: String(sourceId),
            itemId: String(episodeId),
            itemType: 'episode',
            title: showTitle,
            subtitle: `S${seasonNum}E${episodeNum} · ${episodeTitle}`,
            season: parseInt(seasonNum, 10) || 0,
            episode: parseInt(episodeNum, 10) || 0,
            episodeTitle,
            posterUrl: MediaUtils.downloadablePosterUrl(this.currentSeries),
            container,
            durationSeconds: 0
        };
        bridge.downloadMedia(JSON.stringify(payload));
        return 'queued';
    }

    /** Queue a single episode for offline download (per-episode button). */
    async downloadEpisode(episodeEl, btn) {
        const bridge = this.nativeDownloadBridge();
        if (!bridge || !episodeEl) return;
        const id = `${parseInt(episodeEl.dataset.sourceId)}:${episodeEl.dataset.episodeId}`;
        if (['done', 'downloading', 'queued'].includes(this.episodeDownloadState(id))) {
            try { bridge.openDownloads?.(); } catch (_) { /* no-op */ }
            return;
        }
        try {
            btn?.classList.add('busy');
            await this.prepareForPlaybackSession();
            await this.queueEpisodeDownload(episodeEl);
            window.app?.refreshDownloadsNav?.();
        } catch (err) {
            console.warn('[Download] episode failed:', err?.message || err);
        } finally {
            btn?.classList.remove('busy');
            setTimeout(() => this.refreshEpisodeDownloadStates(), 600);
        }
    }

    /** Queue every not-yet-saved episode of one season, in order. */
    async downloadSeason(seasonNum, btn) {
        const bridge = this.nativeDownloadBridge();
        if (!bridge || !this.seasonsContainer) return;
        const sel = (window.CSS && CSS.escape) ? CSS.escape(String(seasonNum)) : String(seasonNum);
        const group = this.seasonsContainer.querySelector(`.season-group[data-season="${sel}"]`);
        if (!group) return;
        const pending = [...group.querySelectorAll('.episode-item')].filter(ep => {
            const id = `${parseInt(ep.dataset.sourceId)}:${ep.dataset.episodeId}`;
            return !['done', 'downloading', 'queued'].includes(this.episodeDownloadState(id));
        });
        if (!pending.length) { try { bridge.openDownloads?.(); } catch (_) { /* no-op */ } return; }
        const label = btn?.querySelector('.season-download-label');
        const original = label ? label.textContent : '';
        if (btn) btn.disabled = true;
        try {
            await this.prepareForPlaybackSession();
            let n = 0;
            for (const ep of pending) {
                if (label) label.textContent = `Queuing ${++n}/${pending.length}…`;
                try { await this.queueEpisodeDownload(ep); }
                catch (err) { console.warn('[Download] season episode failed:', err?.message || err); }
                this.refreshEpisodeDownloadStates();
            }
            window.app?.refreshDownloadsNav?.();
        } finally {
            if (btn) btn.disabled = false;
            if (label) label.textContent = original || 'Download season';
            setTimeout(() => this.refreshEpisodeDownloadStates(), 600);
        }
    }

    /** Reflect each episode's download state on its button; poll while in flight. */
    refreshEpisodeDownloadStates() {
        const bridge = this.nativeDownloadBridge();
        if (!bridge || typeof bridge.downloadState !== 'function' || !this.seasonsContainer) return;
        let anyActive = false;
        const seasonAgg = {};
        this.seasonsContainer.querySelectorAll('.episode-item').forEach(ep => {
            const id = `${parseInt(ep.dataset.sourceId)}:${ep.dataset.episodeId}`;
            const state = this.episodeDownloadState(id);
            const agg = seasonAgg[ep.dataset.season || ''] || (seasonAgg[ep.dataset.season || ''] = { done: 0, total: 0 });
            agg.total++;
            if (state === 'done') agg.done++;
            if (state === 'downloading' || state === 'queued') anyActive = true;
            const btn = ep.querySelector('.episode-download');
            if (!btn) return;
            const icon = btn.querySelector('.episode-download-icon');
            btn.classList.remove('is-done', 'is-active');
            if (state === 'done') {
                btn.classList.add('is-done');
                if (icon) icon.innerHTML = '&#x2713;';
                btn.title = 'Downloaded — open Downloads';
            } else if (state === 'downloading' || state === 'queued') {
                btn.classList.add('is-active');
                if (icon) icon.innerHTML = '&#x22EF;';
                btn.title = 'Downloading';
            } else {
                if (icon) icon.innerHTML = '&#x2193;';
                btn.title = 'Download for offline';
            }
        });
        // Reflect per-season progress on each "Download season" bar.
        this.seasonsContainer.querySelectorAll('.season-dl-bar').forEach(bar => {
            const agg = seasonAgg[bar.dataset.season || ''] || { done: 0, total: 0 };
            const countEl = bar.querySelector('.season-dl-count');
            const seasonBtn = bar.querySelector('.season-download-btn');
            const labelEl = bar.querySelector('.season-download-label');
            if (countEl) countEl.textContent = agg.total ? `${agg.done}/${agg.total} offline` : '';
            const allDone = agg.total > 0 && agg.done === agg.total;
            if (seasonBtn) seasonBtn.classList.toggle('is-done', allDone);
            // Don't stomp the transient "Queuing x/y…" label while a batch runs.
            if (labelEl && seasonBtn && !seasonBtn.disabled) {
                labelEl.textContent = allDone ? 'Saved offline' : 'Download season';
            }
        });
        if (anyActive) {
            if (!this._epDlTimer) this._epDlTimer = setInterval(() => this.refreshEpisodeDownloadStates(), 1500);
        } else if (this._epDlTimer) {
            clearInterval(this._epDlTimer);
            this._epDlTimer = null;
        }
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
