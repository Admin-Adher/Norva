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
        this.randomBtn = document.getElementById('movies-random');
        this.countEl = document.getElementById('movies-count');
        this.resetBtn = document.getElementById('movies-reset');
        this.activeFiltersEl = document.getElementById('movies-active-filters');
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
        this._tvPendingCloudReset = false;
        this._tvSearchTextCache = new WeakMap();
        this._tvSearchGeneration = 0;
        this._searchTimeout = null;
        this._searchIdleCallback = null;
        this.observer = null;
        this.favoriteIds = new Set();
        this.showFavoritesOnly = false;
        this.groupDuplicates = true;
        this.watchState = new Map(); // source_id:item_id -> { progress, duration, ratio }
        this.serverSettings = {};
        this.hiddenCategoryIds = new Set();
        this._genreFilterHydrated = false;
        this._categoriesRestored = false;
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
            onChange: () => {
                // An explicit category interaction wins over any still-pending
                // restore from a partial provider response.
                this._categoriesRestored = true;
                this.onFiltersChanged();
            }
        });
        this.restoreSavedCategories([]);

        // Source change reloads everything
        this.sourceSelect?.addEventListener('change', async () => {
            // Save immediately: a refresh while the scoped facets are loading must
            // keep the provider the user just selected.
            this.persistFilters();
            await this.loadCategories();
            // Category availability can change with the provider scope. Persist the
            // still-valid selection after setOptions has removed unavailable buckets.
            this.persistFilters();
            await this.loadPlaybackStatuses();
            const buckets = [...(this.categoryMulti?.getSelected() || [])];
            if (buckets.length || this.isLanguageFilterActive()) {
                this.onFiltersChanged();
            } else {
                await this.loadMovies();
            }
        });

        // Search with debounce. Android TV gets a little more breathing room so
        // remote-key repeats/IME composition can paint before the catalogue work.
        this.searchInput?.addEventListener('input', () => {
            clearTimeout(this._searchTimeout);
            // Persist the text immediately: a refresh during the render debounce
            // must not lose the user's latest query.
            this.persistFilters();
            if (this._searchIdleCallback !== null) {
                if (typeof window.cancelIdleCallback === 'function') {
                    window.cancelIdleCallback(this._searchIdleCallback);
                }
                this._searchIdleCallback = null;
            }
            const isTv = this._isTvMode();
            const generation = isTv ? ++this._tvSearchGeneration : 0;
            const runSearch = () => {
                if (isTv && generation !== this._tvSearchGeneration) return;
                this._searchIdleCallback = null;
                this.onFiltersChanged();
            };
            this._searchTimeout = setTimeout(() => {
                if (isTv && typeof window.requestIdleCallback === 'function') {
                    this._searchIdleCallback = window.requestIdleCallback(runSearch, { timeout: 250 });
                } else {
                    runSearch();
                }
            }, isTv ? 650 : 300);
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
        document.getElementById('movie-thumb-up')?.addEventListener('click', () => this.setRating(1));
        document.getElementById('movie-thumb-down')?.addEventListener('click', () => this.setRating(-1));

        // Android TV split-view: moving D-pad focus across grid cards live-previews
        // the focused card synchronously in the docked panel. This avoids a delayed
        // rebuild invalidating a panel button after ArrowRight. The lightweight preview
        // never moves focus; heavy extras load only when the panel is entered.
        this.container?.addEventListener('focusin', (event) => {
            if (!this._isTvMode()) return;
            const card = event.target.closest?.('.movie-card');
            if (!card) return;
            // Render immediately: a delayed panel rebuild could otherwise destroy
            // the action button already reached with ArrowRight.
            if (card.isConnected) this.previewCard(card);
        });
        // Stepping INTO the panel is the "commit" signal: only now do we pay for the
        // heavy extras (more-like-this + cast credits), so browsing the grid stays cheap.
        this.detailsPanel?.addEventListener('focusin', () => {
            if (this._isTvMode()) this._loadPanelExtras();
        });

        // Lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this.isLoading) {
                this.renderNextBatch();
            }
        }, { rootMargin: '200px' });

        // Continue Watching shrinks to a compact pinned strip while the grid scrolls,
        // reclaiming vertical space without disappearing. Hysteresis avoids flicker
        // right at the threshold. The same listener drives the virtualization
        // window (re-materialize recycled cards when scrolling back up).
        this.container?.addEventListener('scroll', () => {
            this.updateContinueCompact();
            this.restoreRecycledCards();
        }, { passive: true });

        // Favorites filter toggle
        const favBtn = document.getElementById('movies-favorites-btn');
        favBtn?.addEventListener('click', () => {
            this.showFavoritesOnly = !this.showFavoritesOnly;
            favBtn.classList.toggle('active', this.showFavoritesOnly);
            this.onFiltersChanged();
        });

        // Build the mockup-oriented Movies chrome only in the Android TV client.
        // Moving existing controls keeps every listener/reference intact while the
        // web and mobile DOM remains exactly as authored.
        if (this._isTvMode()) this._setupTvMoviesLayout();

        this.applyFiltersToUI();
    }

    // === Filter persistence ===

    restoreFilters() {
        const saved = MediaUtils.loadFilters('movies') || {};
        this.savedFilters = saved;
        this.groupDuplicates = saved.group !== undefined ? saved.group : true;
        this.showFavoritesOnly = !!saved.favoritesOnly;
    }

    applyFiltersToUI() {
        const s = this.savedFilters || {};
        if (this.sourceSelect && s.source && Array.from(this.sourceSelect.options || [])
            .some(option => String(option.value) === String(s.source))) {
            this.sourceSelect.value = String(s.source);
        }
        if (this.sortSelect && s.sort) this.sortSelect.value = s.sort;
        if (this.yearSelect && s.year) this.yearSelect.value = s.year;
        if (this.ratingSelect && s.rating) this.ratingSelect.value = s.rating;
        if (this.watchedSelect && s.watched) this.watchedSelect.value = s.watched;
        if (this.addedSelect && s.added) this.addedSelect.value = s.added;
        if (this.durationSelect && s.duration) this.durationSelect.value = s.duration;
        if (this.audioSelect && s.audio) this.audioSelect.value = s.audio;
        if (this.subtitleSelect && s.subtitle) this.subtitleSelect.value = s.subtitle;
        if (this.searchInput && s.search) this.searchInput.value = s.search;
        this.groupToggleBtn?.classList.toggle('active', this.groupDuplicates);
        document.getElementById('movies-favorites-btn')?.classList.toggle('active', this.showFavoritesOnly);
    }

    persistFilters() {
        const selectedCategories = [...(this.categoryMulti?.getSelected() || [])];
        const filters = {
            source: this.sourceSelect?.value || '',
            sort: this.sortSelect?.value || 'default',
            genre: this.genreSelect?.value ||
                (!this._genreFilterHydrated ? this.savedFilters?.genre || '' : ''),
            year: this.yearSelect?.value || '',
            rating: this.ratingSelect?.value || '',
            watched: this.watchedSelect?.value || '',
            added: this.addedSelect?.value || '',
            duration: this.durationSelect?.value || '',
            audio: this.audioSelect?.value || '',
            subtitle: this.subtitleSelect?.value || '',
            search: this.searchInput?.value || '',
            group: this.groupDuplicates,
            favoritesOnly: this.showFavoritesOnly,
            categories: (!this._categoriesRestored && this.savedFilters?.categories?.length)
                ? [...new Set([...this.savedFilters.categories, ...selectedCategories])]
                : selectedCategories
        };
        // Async facet/category refreshes consult savedFilters. Keep that snapshot
        // in lockstep with the controls so Clear never resurrects an old value.
        this.savedFilters = filters;
        MediaUtils.saveFilters('movies', filters);
    }

    restoreSavedCategories(availableOptions = this.categoryMulti?.options || []) {
        const saved = this.savedFilters?.categories;
        if (!Array.isArray(saved) || !saved.length || this._categoriesRestored || !this.categoryMulti) return;
        // Keep a saved bucket visible and active even before the category request
        // completes (or when one provider returns a partial response). Fresh real
        // options replace these provisional labels on the next successful load.
        const realOptions = Array.isArray(availableOptions) ? availableOptions : [];
        const available = new Set(realOptions.map(option => option.value));
        const missing = saved.filter(value => !available.has(value));
        const taxonomy = window.GenreTaxonomy;
        const provisional = missing.map(value => ({
            value,
            label: taxonomy?.label?.(value) || value
        }));
        this.categoryMulti.setOptions([...realOptions, ...provisional], { keepSelection: false });
        this.categoryMulti.setSelected(saved);
        this._categoriesRestored = missing.length === 0;
    }

    onFiltersChanged() {
        this.persistFilters();
        this.renderActiveFilterChips();
        // Cloud: picking a genre opens that genre's full grid — the same dense,
        // server-side view as a rail's "See all" — so the dropdown behaves like
        // Manage Content's genres.
        if (this.isCloudPagedMode()) {
            const buckets = [...(this.categoryMulti?.getSelected() || [])];
            if (buckets.length) { this.openGenreBucket(buckets); return; }
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
        const langKey = this.currentBucketViewKey();
        if (this.activeBucket === 'all' && this.activeBucketLangKey === langKey) return;
        this.openBucket({ id: 'genre-all', title: 'All movies', curation: { bucket: 'all' } });
    }

    // Audio-language / burned-in-subtitle / year / rating filter params + "best
    // for my languages" sort, forwarded to the server genre-items endpoint (the
    // bucket grids). Empty keys are omitted. Also the bucket views' re-render
    // key, so changing ANY of these refreshes an open genre grid.
    currentLanguageParams() {
        const params = {};
        const source = this.selectedCloudSourceId();
        if (source) params.source = source;
        if (this.audioSelect?.value) params.audio = this.audioSelect.value;
        if (this.subtitleSelect?.value) params.subs = this.subtitleSelect.value;
        if (this.yearSelect?.value) params.year = this.yearSelect.value;
        if (this.ratingSelect?.value) params.minRating = this.ratingSelect.value;
        if (this.addedSelect?.value) params.addedDays = this.addedSelect.value;
        const sort = this.sortSelect?.value || '';
        if (sort && sort !== 'default') params.sort = sort;
        if (sort === 'lang-match') {
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

    selectedCloudSourceId() {
        const selected = String(this.sourceSelect?.value || '').trim();
        if (!selected) return '';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selected)) {
            return selected;
        }
        const source = (this.sources || []).find(item => String(item.id) === selected);
        return String(source?.cloudId || source?.cloud_id || '').trim();
    }

    // A bucket grid's identity is the full set of server-side params plus the
    // client-only grouping/favorite/watch controls. If any of these changes, the
    // current language/genre bucket must be rebuilt instead of keeping stale order.
    currentBucketViewKey() {
        return JSON.stringify({
            ...this.currentLanguageParams(),
            watched: this.watchedSelect?.value || '',
            favoritesOnly: Boolean(this.showFavoritesOnly),
            group: Boolean(this.groupDuplicates)
        });
    }

    // Dynamic filter menus: only show audio/subtitle languages actually present in
    // the catalogue (server facets). Falls back to the static <option>s on failure.
    async populateLanguageFacets() {
        // Local (self-hosted) libraries carry no per-title language facets — the two
        // selects would be dead filters there, so hide them instead of lying.
        const cloud = this.isCloudPagedMode();
        this.audioSelect?.classList.toggle('hidden', !cloud);
        this.subtitleSelect?.classList.toggle('hidden', !cloud);
        if (!cloud) return;
        // Restore saved choices synchronously. Facet counts can be temporarily
        // empty while a catalogue is crawling, but the saved filter is still valid.
        this.applyFacetOptions(this.audioSelect, 'Any Audio', [], this.savedFilters?.audio);
        this.applyFacetOptions(this.subtitleSelect, 'Any Subtitles', [], this.savedFilters?.subtitle);
        // Re-fetch at most once per 60s so the menu tracks the background crawl (new
        // languages get detected over the first day) instead of freezing at first load.
        // applyFacetOptions preserves the current selection and skips the DOM rebuild
        // when nothing changed, so refreshing never disturbs the user.
        const now = Date.now();
        if (this._facetsLoadedAt && (now - this._facetsLoadedAt) < 60000) return;
        this._facetsLoadedAt = now;
        try {
            const facets = await API.media.languageFacets({ type: 'movie' });
            this.applyFacetOptions(this.audioSelect, 'Any Audio', facets && facets.audio, this.savedFilters?.audio);
            this.applyFacetOptions(this.subtitleSelect, 'Any Subtitles', facets && facets.subtitles, this.savedFilters?.subtitle);
            this.renderActiveFilterChips();
        } catch (_) {
            this._facetsLoadedAt = 0; // allow a retry on the next show
        }
    }

    applyFacetOptions(select, anyLabel, facets, savedValue = '') {
        if (!select || !Array.isArray(facets)) return;
        const current = select.value || savedValue || '';
        if (!facets.length && !current) return;
        const existing = Array.from(select.options || []);
        // The synchronous restore also runs on the 60s refresh timer. If the menu
        // is already hydrated, leave every existing choice untouched while the
        // request is pending (and if that request fails).
        if (!facets.length && existing.some(option => option.value === current)) {
            if (!select.value) select.value = current;
            return;
        }
        const options = facets.length
            ? facets.slice()
            : existing
                .filter(option => option.value)
                .map(option => ({ value: option.value, label: option.text?.trim() || option.value.toUpperCase() }));
        if (current && !options.some(f => f.value === current)) {
            const previous = existing.find(option => option.value === current)?.text?.trim();
            options.push({ value: current, label: previous || current.toUpperCase() });
        }
        const desired = [`<option value="">${anyLabel}</option>`]
            .concat(options.map(f => `<option value="${MediaUtils.escapeHtml(f.value)}">${MediaUtils.escapeHtml(f.label)}</option>`))
            .join('');
        if (select.innerHTML === desired && savedValue && !select.value
            && options.some(f => f.value === savedValue)) {
            select.value = savedValue;
        }
        if (select.innerHTML === desired) return; // unchanged → don't disturb an open dropdown
        select.innerHTML = desired;
        if (current && options.some(f => f.value === current)) select.value = current;
    }

    // Open a genre bucket from the filter dropdown, reusing the rail "See all"
    // grid (paged, server-side). No-op if that bucket is already showing.
    openGenreBucket(bucket) {
        const buckets = [...new Set((Array.isArray(bucket) ? bucket : String(bucket || '').split(','))
            .map(value => String(value || '').trim())
            .filter(Boolean))];
        if (!buckets.length) return;
        // Re-open (re-render) when the same genre is active but the language params
        // changed, so toggling an audio/subtitle filter refreshes the grid.
        const langKey = this.currentBucketViewKey();
        const bucketParam = buckets.join(',');
        if (this.activeBucket === bucketParam && this.activeBucketLangKey === langKey) return;
        const T = window.GenreTaxonomy;
        const labels = buckets.map(value => (T && T.label) ? T.label(value) : value);
        const label = labels.length === 1 ? labels[0] : labels.join(' + ');
        this.openBucket({ id: `genre-${bucketParam}`, title: label, curation: { bucket: bucketParam } });
    }

    // Netflix-style default: with no active filter/search, the cloud Movies page
    // shows curated genre rails instead of a flat grid. Any filter or search
    // flips back to the grid via the normal path.
    shouldShowRails() {
        // The TV mockup is a stable flat poster grid feeding the persistent preview
        // panel. Web/mobile keep the curated genre rails.
        return !this._isTvMode() && this.isCloudPagedMode() && !!window.GenreRails
            && !this.sourceSelect?.value && !this.hasActiveFilters();
    }

    async renderGenreRails() {
        this.railsView = true;
        if (this.countEl) this.countEl.textContent = '';
        this.resetBtn?.classList.add('hidden');
        if (this.randomBtn) this.randomBtn.disabled = true; // "Random" needs the flat grid.
        try {
            const payload = await API.media.genreRails({ type: 'movie', limit: 18 });
            const rails = (payload && payload.rails) || [];
            // Fall back to the flat grid whenever the rails carry NO items — not only
            // when the rails array is empty. A mid-sync / incomplete materialization can
            // return bucket shells whose .items are empty; GenreRails.render would then
            // paint a terminal "No movies to show yet." AND stamp the warm-view marker,
            // stranding the page even though the flat grid (built from the raw, complete
            // items) has content. Mirror GenreRails.render's own usability test.
            const railsHaveItems = rails.some((r) => Array.isArray(r.items) && r.items.length);
            if (!railsHaveItems) {
                this.railsView = false;
                return this.loadMovies();
            }
            window.GenreRails.render(this.container, rails, {
                emptyText: 'No movies to show yet.',
                onItemClick: (item) => this.openRailItem(item),
                onSeeAll: (rail) => this.openBucket(rail)
            });
            // Stamp the warm view only AFTER a successful rails render: stamping
            // up-front left the marker set when the fallback path errored without
            // reaching filterAndRender, freezing an empty/error view on back-nav.
            this._viewRenderedAt = Date.now();
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
        this.activeBucketLangKey = this.currentBucketViewKey();
        this.bucketLabel = (rail && (rail.title || rail.name)) || '';
        this.bucketOffset = 0;
        this.bucketHasMore = true;
        this.bucketLoading = false;
        this.bucketSeen = new Set(); // title identities already in the grid
        this.bucketRequestId = (this.bucketRequestId || 0) + 1;
        this.bucketObserver?.disconnect();

        // Block layout so the head / grid / loader stack vertically (see .rail-host).
        this.container.classList.add('rail-host');
        this.container.innerHTML = `
            <div class="genre-bucket-head" style="display:flex;align-items:center;gap:14px;margin:4px 0 18px">
                <button class="norva-back" id="genre-bucket-back" type="button" aria-label="Back to all genres">
                    <svg class="back-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
                    <span class="back-label">All genres</span>
                </button>
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
        // Switching buckets/filters mid-flight must not append the old grid's page
        // into the new grid (or corrupt its offset).
        const requestId = this.bucketRequestId;
        try {
            const payload = await API.media.genreItems({ type: 'movie', bucket: this.activeBucket, limit: 36, offset: this.bucketOffset, ...this.currentLanguageParams() });
            if (requestId !== this.bucketRequestId || !this.bucketGridEl?.isConnected) return;
            const items = (payload && payload.items) || [];
            // Offset pagination over a live catalog can re-serve a boundary row —
            // never render the same title twice.
            const fresh = items.filter((item) => {
                const key = String(item.title_id || item.titleId || item.id || '');
                if (!key || this.bucketSeen?.has(key)) return false;
                this.bucketSeen?.add(key);
                return true;
            });
            window.GenreRails.appendCards(this.bucketGridEl, fresh, {
                startIndex: this.bucketOffset,
                onItemClick: (item) => this.openRailItem(item)
            });
            this.bucketOffset += items.length;
            this.bucketHasMore = Boolean(payload && payload.hasMore) && items.length > 0;
            // The endpoint returns the exact filtered count — show it (the grid view
            // otherwise leaves the header count blank).
            if (this.countEl && typeof payload?.count === 'number') {
                this.countEl.textContent = `${payload.count} titles`;
            }
        } catch (err) {
            console.warn('[Movies] Genre bucket page failed:', err);
            this.bucketHasMore = false;
        } finally {
            this.bucketLoading = false;
        }
    }

    closeBucket() {
        const wasLanguageBucket = this.activeBucket === 'all';
        this.activeBucket = null;
        this.activeBucketLangKey = null;
        this.bucketRequestId = (this.bucketRequestId || 0) + 1;
        this.bucketObserver?.disconnect();
        this.bucketObserver = null;
        // Drop the genre selection (set silently — the next view renders below).
        if (this.categoryMulti?.getSelected().size) {
            this._categoriesRestored = true;
            this.categoryMulti.setSelected([]);
        }
        // Backing out of a GENRE keeps the user's language/year/rating filters
        // (they weren't set by the bucket) — onFiltersChanged routes to the right
        // view for whatever remains. Backing out of the catalogue-wide language
        // grid clears its own language filters, else it would just reopen itself.
        if (wasLanguageBucket) {
            if (this.audioSelect) this.audioSelect.value = '';
            if (this.subtitleSelect) this.subtitleSelect.value = '';
            if (this.sortSelect?.value === 'lang-match') this.sortSelect.value = 'default';
        }
        this.persistFilters();
        this.onFiltersChanged();
    }

    // Local-mode genre rails: group already-loaded movies by curated bucket and
    // render them with the page's own cards (so clicks open details normally).
    renderGenreRailsLocal() {
        if (this._isTvMode()) return false;
        const T = window.GenreTaxonomy;
        if (!T || !window.GenreRails || !Array.isArray(this.movies) || !this.movies.length) return false;

        const byBucket = new Map();
        for (const m of this.movies) {
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
        // Clear is an explicit choice: pending dynamic values must not be preserved
        // by persistFilters while their option lists are still loading.
        this._genreFilterHydrated = true;
        this._categoriesRestored = true;
        [this.sortSelect, this.genreSelect, this.yearSelect, this.ratingSelect,
         this.watchedSelect, this.addedSelect, this.durationSelect,
         this.audioSelect, this.subtitleSelect].forEach(sel => {
            if (sel) sel.value = sel.querySelector('option')?.value ?? '';
        });
        if (this.sortSelect) this.sortSelect.value = 'default';
        if (this.searchInput) this.searchInput.value = '';
        this.showFavoritesOnly = false;
        document.getElementById('movies-favorites-btn')?.classList.remove('active');
        this.categoryMulti?.setSelected([]);
        this.onFiltersChanged();
    }

    hasActiveFilters() {
        return Boolean(
            (this.sortSelect?.value && this.sortSelect.value !== 'default') ||
            this.genreSelect?.value ||
            (!this._genreFilterHydrated && this.savedFilters?.genre) ||
            this.yearSelect?.value || this.ratingSelect?.value ||
            this.watchedSelect?.value || this.addedSelect?.value || this.durationSelect?.value ||
            this.audioSelect?.value || this.subtitleSelect?.value ||
            this.searchInput?.value || this.showFavoritesOnly ||
            (this.categoryMulti?.getSelected().size > 0)
        );
    }

    // Active-filter chips: mirror what's currently narrowing the grid as removable
    // pills below the filter bar. Each chip reads the real control value (labels come
    // straight from the selected <option>), so nothing here can drift from the actual
    // filters. Clearing a chip resets just that control and re-applies.
    renderActiveFilterChips() {
        const host = this.activeFiltersEl;
        if (!host) return;
        const optText = (sel) => (sel && sel.selectedIndex >= 0)
            ? (sel.options[sel.selectedIndex]?.text || '').trim() : '';
        const chips = [];

        const q = this.searchInput?.value?.trim();
        if (q) chips.push({ label: `Search: “${q}”`, clear: () => { if (this.searchInput) this.searchInput.value = ''; } });

        const catCount = this.categoryMulti?.getSelected().size || 0;
        if (catCount > 0) chips.push({ label: catCount === 1 ? '1 category' : `${catCount} categories`,
            clear: () => {
                this._categoriesRestored = true;
                this.categoryMulti?.setSelected([]);
            } });

        if (this.sortSelect?.value && this.sortSelect.value !== 'default')
            chips.push({ label: optText(this.sortSelect), clear: () => { this.sortSelect.value = 'default'; } });
        if (this.genreSelect?.value) chips.push({ label: optText(this.genreSelect), clear: () => { this.genreSelect.value = ''; } });
        if (this.yearSelect?.value) chips.push({ label: optText(this.yearSelect), clear: () => { this.yearSelect.value = ''; } });
        if (this.ratingSelect?.value) chips.push({ label: optText(this.ratingSelect), clear: () => { this.ratingSelect.value = ''; } });
        if (this.watchedSelect?.value) chips.push({ label: optText(this.watchedSelect), clear: () => { this.watchedSelect.value = ''; } });
        if (this.addedSelect?.value) chips.push({ label: optText(this.addedSelect), clear: () => { this.addedSelect.value = ''; } });
        if (this.durationSelect?.value) chips.push({ label: optText(this.durationSelect), clear: () => { this.durationSelect.value = ''; } });
        if (this.audioSelect?.value) chips.push({ label: `Audio: ${optText(this.audioSelect)}`, clear: () => { this.audioSelect.value = ''; } });
        if (this.subtitleSelect?.value) chips.push({ label: `Subtitles: ${optText(this.subtitleSelect)}`, clear: () => { this.subtitleSelect.value = ''; } });
        if (this.showFavoritesOnly) chips.push({ label: 'Favorites', clear: () => {
            this.showFavoritesOnly = false;
            document.getElementById('movies-favorites-btn')?.classList.remove('active');
        } });

        if (!chips.length) { host.classList.add('hidden'); host.innerHTML = ''; return; }

        host.classList.remove('hidden');
        host.innerHTML = chips.map((c, i) =>
            `<button type="button" class="filter-chip" data-chip="${i}">${MediaUtils.escapeHtml(c.label)}<span class="filter-chip-x" aria-hidden="true">×</span></button>`
        ).join('') + '<button type="button" class="filter-chip filter-chip-clear" data-chip="clear">Clear all</button>';

        host.querySelectorAll('.filter-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.chip === 'clear') { this.resetFilters(); return; }
                const chip = chips[parseInt(btn.dataset.chip, 10)];
                if (chip) { chip.clear(); this.onFiltersChanged(); }
            });
        });
    }

    // === Page lifecycle ===

    // Foreground SWR (called when the app returns to the foreground while Movies is the
    // active page). Throttled by the same warm-view window show() uses, so a brief blur is a
    // no-op; only a real "was away past the warm window" return revalidates. When it does, it
    // invalidates the warm marker so the next entry rebuilds fresh, and — only when it won't
    // disrupt the user (at the top of the default, unfiltered paged grid) — refreshes page 1
    // in place via the SWR path. A scrolled, filtered or searched view is left untouched and
    // simply refreshes on its next entry.
    maybeRevalidate() {
        if (this.isLoading || this.cloudLoadingMore) return;
        if (this._viewRenderedAt && Date.now() - this._viewRenderedAt < 300000) return;
        this._viewRenderedAt = 0;
        const atTop = (this.container?.scrollTop || 0) < 40;
        if (atTop && this.movies.length && this.catalogCacheKey()) {
            this.loadCloudMovies({ reset: true });
        }
    }

    // Instant cold-load paint (perf): a returning user's default first screen is already cached,
    // but the normal paint happens only AFTER the awaited health/sources/settings round-trips in
    // show() below — several seconds on a busy backend, during which the grid is blank. Paint the
    // cached first page NOW, synchronously, then let show() revalidate and replace it (SWR).
    // Guarded to the default paged-grid view with a real cache and a non-gating last-known health,
    // and skipped when the DOM is already warm — so it never fights the rails view or the gate.
    _coldPaintFromCache() {
        try {
            if (!this.container) return;
            if (this.hasActiveFilters() || this.savedFilters?.source || this.savedFilters?.audio || this.savedFilters?.subtitle
                || this.savedFilters?.categories?.length) return;
            if (this.movies && this.movies.length) return;                        // real data already in memory
            if (this._viewRenderedAt && Date.now() - this._viewRenderedAt < 300000) return; // warm in-session return
            const s = this.app?.sourceSummary;
            if (s && this.app?.isCatalogReady && !this.app.isCatalogReady(s)) return; // last known state was gating
            if (typeof this.shouldShowRails === 'function' && this.shouldShowRails()) return; // rails owns the grid
            const ck = this.catalogCacheKey();
            if (!ck) return;
            const cached = window.NorvaCatalogCache?.read?.(ck); // time-only; loadCloudMovies re-reads WITH the version
            if (!cached?.data?.items?.length) return;
            this.movies = cached.data.items.slice();
            this.cloudHasMore = Boolean(cached.data.hasMore);
            this.cloudTotal = cached.data.count ?? null;
            this._coldPaintPending = true;   // force show() to still revalidate despite movies.length > 0
            this.populateGenres();
            this.filterAndRender();
            this._viewRenderedAt = 0;         // keep show()'s warm-view guard from short-circuiting the revalidate
        } catch (_) { /* best-effort instant paint */ }
    }

    async show() {
        document.documentElement.classList.toggle('tv-movies-active', this._isTvMode());
        this._coldPaintFromCache();
        const summary = await this.app?.refreshSourceHealth?.();
        // Show the grid as soon as MOVIES are available (even mid-sync), not only when
        // the whole catalogue is "ready" — Live TV already does this. Falls back to the
        // ready check if the per-category helper isn't present.
        const moviesLocked = this.app?.catalogCategoryAvailable
            ? !this.app.catalogCategoryAvailable('movies', summary || undefined)
            : (this.app?.isCatalogReady && !this.app.isCatalogReady(summary || undefined));
        if (moviesLocked) {
            this.renderCatalogLocked();
            return;
        }

        if (this.sources.length === 0) {
            await this.loadSources();
        }

        this.populateLanguageFacets();
        const initialLoads = [
            this.loadFavorites(),
            this.loadWatchState(),
            this.loadServerSettings(),
            this.loadPlaybackStatuses()
        ];
        if (this.savedFilters?.categories?.length && !this._categoriesRestored) {
            initialLoads.push(this.loadCategories());
        }
        await Promise.all(initialLoads);
        this.renderContinueWatching();
        this.renderActiveFilterChips();
        // While the page is visible, refresh the language menus periodically so they
        // track the crawl in near-real-time. Gentle (server-memoized 60s, skips DOM work
        // when unchanged); cleared in hide().
        if (this._facetTimer) clearInterval(this._facetTimer);
        this._facetTimer = setInterval(() => this.populateLanguageFacets(), 60000);

        // Returning to a recently rendered view (grid or rails): keep the DOM as-is
        // and restore the scroll position instead of re-rendering back to the top.
        if (this._viewRenderedAt && Date.now() - this._viewRenderedAt < 300000
            && this.container?.childElementCount > 0
            && !this.container.querySelector('.catalog-locked-empty')) {
            const saved = this._savedScrollTop || 0;
            if (saved > 0) requestAnimationFrame(() => { this.container.scrollTop = saved; });
            return;
        }

        // A genre is selected (e.g. returning to the page) → (re)open its grid.
        if (this.isCloudPagedMode()) {
            const selectedBuckets = [...(this.categoryMulti?.getSelected() || [])];
            if (selectedBuckets.length) {
                if (!this.categories.length) await this.loadCategories();
                this.activeBucket = null;
                this.openGenreBucket(selectedBuckets);
                return;
            }
            if (this.isLanguageFilterActive()) {
                this.openLanguageBucket();
                return;
            }
        }

        // Default cloud view with no active filters → Netflix-style genre rails.
        if (this.shouldShowRails()) {
            if (!this.categories.length) this.loadCategories(); // keep the filter dropdown ready
            await this.renderGenreRails();
            return;
        }

        if (this.movies.length === 0 || this._coldPaintPending) {
            // Categories only feed the filter dropdown — load them alongside the
            // movie page instead of gating the grid's first paint on them. The
            // _coldPaintPending clause forces a revalidate even though the cold paint
            // above left movies.length > 0, so the cached first screen is refreshed.
            this._coldPaintPending = false;
            await Promise.all([this.loadCategories(), this.loadMovies()]);
        } else {
            this.filterAndRender();
        }
    }

    hide() {
        document.documentElement.classList.remove('tv-movies-active');
        if (this._isTvMode()) {
            clearTimeout(this._searchTimeout);
            this._searchTimeout = null;
            this._tvSearchGeneration += 1;
            if (this._searchIdleCallback !== null) {
                if (typeof window.cancelIdleCallback === 'function') {
                    window.cancelIdleCallback(this._searchIdleCallback);
                }
                this._searchIdleCallback = null;
            }
        }
        if (this._facetTimer) { clearInterval(this._facetTimer); this._facetTimer = null; }
        this._disarmCatalogRefreshWatch();
        // Scroll restoration: the grid is its own scroller, remembered per visit.
        this._savedScrollTop = this.container?.scrollTop || 0;
    }

    // Onboarding: while an empty/locked grid is shown during a first-run catalog
    // sync, watch for the catalog coming online and reload automatically — the
    // user should never have to leave the page and come back to see their movies
    // appear. Self-cleans the moment content renders (filterAndRender) or the page
    // is hidden. Armed only while an empty state is on screen, so it is idle for
    // the normal populated case.
    _armCatalogRefreshWatch() {
        if (this._catalogWatch) return;
        const reload = () => {
            if (this._catalogWatchReloading) return; // guard re-entry: show() re-dispatches health events
            this._catalogWatchReloading = true;
            Promise.resolve(this.show()).catch(() => {}).finally(() => { this._catalogWatchReloading = false; });
        };
        const w = { reload, ticks: 0, timer: 0 };
        this._catalogWatch = w;
        document.addEventListener('norva:source-health-changed', reload);
        window.addEventListener('norva:catalog-availability-changed', reload);
        // Safety net for partial availability (movies can fill before the whole
        // source flips to "ready", so the completion event never fires): gently
        // re-check, bounded to ~10 min so a forgotten page never polls forever.
        w.timer = setInterval(() => {
            if (++w.ticks > 40) { this._disarmCatalogRefreshWatch(); return; }
            reload();
        }, 15000);
    }

    _disarmCatalogRefreshWatch() {
        const w = this._catalogWatch;
        if (!w) return;
        this._catalogWatch = null;
        document.removeEventListener('norva:source-health-changed', w.reload);
        window.removeEventListener('norva:catalog-availability-changed', w.reload);
        if (w.timer) clearInterval(w.timer);
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
        this._armCatalogRefreshWatch();
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
            const history = await API.history.getAll(5000);
            const activeSourceIds = new Set((this.sources || []).map(source => String(source.id)));
            this.watchState = new Map();
            this.historyItems = (history || []).filter(item => {
                const sourceId = item.source_id || item.sourceId || item.data?.sourceId;
                return sourceId && activeSourceIds.has(String(sourceId));
            });
            for (const h of this.historyItems) {
                if (h.item_type !== 'movie') continue;
                const ratio = h.duration > 0 ? h.progress / h.duration : 0;
                const sourceId = h.source_id || h.sourceId || h.data?.sourceId || null;
                this.watchState.set(this._watchStateKey(sourceId, h.item_id), {
                    progress: h.progress,
                    duration: h.duration,
                    ratio,
                    completed: Boolean(h.completed),
                    updatedAt: h.updated_at,
                    sourceId,
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
        let watched = false;
        for (const item of items) {
            const state = this._watchStateFor(item);
            if (state?.completed || state?.ratio >= 0.95) watched = true;
            if (state && this.getResumeOffset(state.progress, state.duration) > 0
                && (!best || state.ratio > best.ratio)) best = state;
        }
        if (watched) return { status: 'watched', ratio: 1 };
        if (!best) return { status: 'unwatched', ratio: 0 };
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
            const savedSource = String(this.savedFilters?.source || '');
            if (savedSource && Array.from(this.sourceSelect.options || [])
                .some(option => String(option.value) === savedSource)) {
                this.sourceSelect.value = savedSource;
            }
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

            // Restore saved category selection once.
            this.restoreSavedCategories(options);
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
            const source = this.selectedCloudSourceId();
            const payload = await API.media.genreSummary({ type: 'movie', ...(source ? { source } : {}) });
            const genres = Array.isArray(payload) ? payload : (payload?.genres || []);
            // The API exposes the profile mask at payload.hidden. Keep accepting
            // the per-row flag as well for compatibility with an older response
            // shape, but never restore a hidden saved selection into the picker.
            const hiddenBuckets = new Set([
                ...(Array.isArray(payload?.hidden) ? payload.hidden.map(String) : []),
                ...genres.filter(g => g.hidden).map(g => String(g.bucket))
            ]);
            if (Array.isArray(this.savedFilters?.categories)) {
                const visibleSaved = this.savedFilters.categories.filter(bucket => !hiddenBuckets.has(String(bucket)));
                if (visibleSaved.length !== this.savedFilters.categories.length) {
                    this.savedFilters.categories = visibleSaved;
                    MediaUtils.saveFilters('movies', this.savedFilters);
                }
            }
            this.categories = genres;
            const options = genres
                .filter(g => Number(g.count) > 0 && !hiddenBuckets.has(String(g.bucket)))
                .map(g => ({ value: g.bucket, label: `${g.label} · ${Number(g.count).toLocaleString('en-US')}` }));
            this.categoryMulti.setOptions(options);
            this.restoreSavedCategories(options);
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
        this.container.innerHTML = MediaUtils.skeletonCards(12);

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
        const sourceId = this.sourceSelect?.value || '';
        const categoryId = '';
        const tvLanguageParams = {};

        // Defensive fallback for direct flat-grid TV loads. Normal category and
        // language interactions route through genre-items on every device.
        if (this._isTvMode()) {
            if (this.audioSelect?.value) tvLanguageParams.audio = this.audioSelect.value;
            if (this.subtitleSelect?.value) tvLanguageParams.subs = this.subtitleSelect.value;
            if (this.sortSelect?.value === 'lang-match') {
                const prefs = this.getPreferences();
                if (prefs.preferredAudioLanguage) tvLanguageParams.prefAudio = prefs.preferredAudioLanguage;
                if (prefs.preferredSubtitleLanguage && prefs.preferredSubtitleLanguage !== 'none') {
                    tvLanguageParams.prefSubs = prefs.preferredSubtitleLanguage;
                }
            }
        }

        return {
            type: 'movie',
            sourceId,
            categoryId,
            sort: this.sortSelect?.value || 'default',
            q: (this.searchInput?.value || '').trim(),
            // Server-side over the denormalized columns, so the filter spans the
            // WHOLE catalogue instead of the loaded pages only.
            year: this.yearSelect?.value || '',
            minRating: this.ratingSelect?.value || '',
            addedDays: this.addedSelect?.value || '',
            ...tvLanguageParams,
            limit: this.cloudPageSize,
            offset
        };
    }

    catalogCacheKey() {
        // Only the DEFAULT first screen (no source/category/search filter, default
        // sort) is cached — that's the cold-load view worth painting instantly.
        // Returns null otherwise so searches/sorted/filtered views never bloat storage.
        const p = this.cloudPageParams(0);
        if (p.sourceId || p.categoryId || p.q || (p.sort && p.sort !== 'default') ||
            p.year || p.minRating || p.addedDays || p.audio || p.subs ||
            p.prefAudio || p.prefSubs) return null;
        // Lang-scoped: the persisted first screen carries localized titles/overviews, so a
        // synopsis-language change must not paint the previous language on cold load.
        return 'movies:default:' + (window.NorvaCloud?.contentLanguage?.() || 'en');
    }

    async loadCloudMovies({ reset = false } = {}) {
        // A TV search can arrive while the infinite-scroll page is still loading.
        // Never drop that reset: coalesce it and replay once the append completes.
        if (this.cloudLoadingMore) {
            if (reset && this._isTvMode()) this._tvPendingCloudReset = true;
            return;
        }
        if (reset && this._isTvMode() && this.isLoading) {
            this._tvPendingCloudReset = true;
            return;
        }
        if (this.isLoading && !reset) return;

        let paintedFromCache = false;
        let requestId = this.cloudRequestId;
        if (reset) {
            if (this._isTvMode()) this._tvPendingCloudReset = false;
            this.isLoading = true;
            this.cloudRequestId += 1;
            requestId = this.cloudRequestId;
            this.cloudOffset = 0;
            this.cloudHasMore = false;
            this.cloudTotal = null;
            this.movies = [];
            this.filteredCards = [];
            this.currentBatch = 0;
            // Stale-while-revalidate: paint the cached first page instantly, then
            // refresh from the network below and replace it.
            const cacheKey = this.catalogCacheKey();
            const cached = cacheKey && window.NorvaCatalogCache?.read?.(cacheKey, { version: window.API?.catalogSignature?.() });
            if (cached?.data?.items?.length) {
                this.movies = cached.data.items.slice();
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
            const renderedBefore = reset ? 0 : this.container.querySelectorAll('.movie-card').length;
            // On reset always refetch page 1 (offset 0), even after a cache paint.
            const page = await API.media.page(this.cloudPageParams(reset ? 0 : this.cloudOffset));
            if (!reset && this._isTvMode() && this._tvPendingCloudReset) return;
            if (reset && (
                requestId !== this.cloudRequestId ||
                (this._isTvMode() && this._tvPendingCloudReset)
            )) return;
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

            // The grid is paginated by FILM server-side (each film ships all its version
            // rows), so advance the cursor by the film count, not the row count.
            this.cloudOffset = (page.offset || this.cloudOffset) + (page.films ?? page.items?.length ?? 0);
            this.cloudHasMore = Boolean(page.hasMore);
            this.cloudTotal = page.count ?? this.cloudTotal;
            this.populateGenres();

            if (reset) {
                this.filterAndRender();
                // Cache the fresh first page for an instant next cold entry.
                try {
                    const ck = this.catalogCacheKey();
                    // Only cache a NON-EMPTY page. Caching an empty result (e.g. the enrichment
                    // queries timed out under import load) poisons the cold-entry paint: the next
                    // visit paints the stale empty "No movies here yet" and, if the network refresh
                    // also fails, it never gets replaced. A miss instead shows the skeleton → retry.
                    if (ck && this.movies.length) window.NorvaCatalogCache?.write?.(ck, {
                        items: this.movies.slice(0, this.cloudPageSize),
                        hasMore: this.cloudHasMore,
                        count: this.cloudTotal
                    }, { version: window.API?.catalogSignature?.() });
                } catch (_) { /* best-effort */ }
            } else {
                this.filteredCards = this.buildFilteredCards();
                this.updateResultChrome(this.filteredCards);
                this.currentBatch = Math.ceil(renderedBefore / this.batchSize);
                this.renderNextBatch();
            }
        } catch (err) {
            console.error('Error loading cloud movies:', err);
            // A newer TV query owns the surface now; an older failure must not
            // replace its loading/result state with an error message.
            if (reset && this._isTvMode() && (
                requestId !== this.cloudRequestId || this._tvPendingCloudReset
            )) return;
            // Keep the cached paint on error; only show an error with nothing shown.
            if (reset && !paintedFromCache) {
                this.container.innerHTML = '<div class="empty-state"><p>Error loading movies</p></div>';
            }
        } finally {
            if (reset && (!this._isTvMode() || requestId === this.cloudRequestId)) {
                this.isLoading = false;
            }
            if (!reset) this.cloudLoadingMore = false;
            if (this._isTvMode() && this._tvPendingCloudReset && !this.cloudLoadingMore) {
                this._tvPendingCloudReset = false;
                // Read the current controls when this runs: several keystrokes may
                // have been coalesced while the append request was in flight.
                Promise.resolve().then(() => this.loadCloudMovies({ reset: true }));
            }
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
        this._genreFilterHydrated = true;
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
        // Cloud mode filters genre via the dedicated grid (openGenreBucket); the
        // self-hosted grid still filters by the selected provider category here.
        // Year / rating / recently-added are ALSO server-side in cloud mode
        // (cloudPageParams), so re-filtering here would only drop rows where the
        // client's heuristic (name-derived year, provider rating string) disagrees
        // with the server's denormalized column.
        const cloud = this.isCloudPagedMode();
        if (!cloud) {
            const selectedCats = this.categoryMulti?.getSelected();
            if (selectedCats && selectedCats.size > 0 &&
                !selectedCats.has(`${item.sourceId}:${item.category_id}`)) {
                return false;
            }
        }

        // Year / decade
        const yearFilter = cloud ? '' : this.yearSelect?.value;
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
        const minRating = cloud ? NaN : parseFloat(this.ratingSelect?.value);
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
        const addedDays = cloud ? NaN : parseInt(this.addedSelect?.value);
        if (addedDays) {
            const addedMs = this.parseAddedMs(item);
            if (!addedMs || (Date.now() - addedMs) > addedDays * 86400000) return false;
        }

        return true;
    }

    isBrokenItem(item) {
        const health = window.PlaybackHealth;
        const itemEntry = {
            status: item?.playback_status,
            lastError: item?.playback_last_error || item?.playbackLastError || item?.last_error || item?.lastError || null,
            modeReason: item?.playback_mode_reason || item?.playbackModeReason || item?.mode_reason || item?.modeReason || null
        };
        return (health?.isUnavailableEntry
            ? health.isUnavailableEntry(itemEntry)
            : item?.playback_status === 'broken') ||
            (health?.isUnavailable
                ? health.isUnavailable(item.sourceId, 'movie', item.stream_id)
                : health?.isBroken(item.sourceId, 'movie', item.stream_id));
    }

    buildFilteredCards() {
        const searchTerm = MediaUtils.searchableText(this.searchInput?.value || '').trim();

        let items = this.movies.filter(m => this.matchesFilters(m));

        if (searchTerm && !this.isCloudPagedMode()) {
            if (this._isTvMode()) {
                // Normalising every provider/TMDB title on every TV keystroke is
                // expensive on a WebView. Cache both values per movie while keeping
                // the exact old rule (match provider name OR TMDB title).
                items = items.filter(m => {
                    const rawName = m.name || '';
                    const rawTitle = m.tmdb?.title || '';
                    let cached = this._tvSearchTextCache.get(m);
                    if (!cached || cached.rawName !== rawName || cached.rawTitle !== rawTitle) {
                        cached = {
                            rawName,
                            rawTitle,
                            name: MediaUtils.searchableText(rawName),
                            title: rawTitle ? MediaUtils.searchableText(rawTitle) : ''
                        };
                        this._tvSearchTextCache.set(m, cached);
                    }
                    return cached.name.includes(searchTerm) || cached.title.includes(searchTerm);
                });
            } else {
                items = items.filter(m =>
                    MediaUtils.searchableText(m.name).includes(searchTerm) ||
                    (m.tmdb?.title && MediaUtils.searchableText(m.tmdb.title).includes(searchTerm)));
            }
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

    // Filters the SERVER cannot see (they run over the loaded pages only), so the
    // server's exact count can't be shown while any of them is active.
    hasClientOnlyFilters() {
        return Boolean(
            this.genreSelect?.value || this.durationSelect?.value ||
            this.watchedSelect?.value || this.showFavoritesOnly
        );
    }

    updateResultChrome(cards) {
        if (this.countEl) {
            let total = this.groupDuplicates ? `${cards.length} titles` : `${cards.length} movies`;
            // The server count is exact for every server-side dimension (search,
            // sort, year, rating, added) — only client-only filters force the
            // open-ended "N+" fallback.
            if (this.isCloudPagedMode() && this.cloudTotal !== null && !this.hasClientOnlyFilters()) {
                total = `${this.cloudTotal} titles`;
            } else if (this.isCloudPagedMode() && this.cloudHasMore) {
                total = `${cards.length}+ titles`;
            }
            this.countEl.textContent = total;
        }
        // Reset stays visible in the TV action row, matching the 10-foot mockup.
        this.resetBtn?.classList.toggle('hidden', !this._isTvMode() && !this.hasActiveFilters());
        this.renderActiveFilterChips();
    }

    filterAndRender() {
        // Any real render supersedes a pending empty-state auto-refresh watch;
        // re-armed below only if this render lands on an empty (non-filtered) grid.
        this._disarmCatalogRefreshWatch();
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
        this._winStart = 0; // virtualization: index of the first card still in the DOM
        // The previous loader is about to be detached. Keeping it observed makes
        // repeated TV searches accumulate stale observer targets.
        if (this._isTvMode()) this.observer?.disconnect();
        // Flat card grid → drop the rail-host modifier so the grid centers/wraps.
        this.container.classList.remove('rail-host');
        this.container.innerHTML = '';
        // Only a populated grid counts as a "warm view". Leave an empty render
        // (zero cards — e.g. a transient empty catalogue fetch mid-sync) UN-stamped
        // so show()'s warm early-return (~line 650) does not freeze the empty
        // "No movies here yet" grid on back-nav; the next entry reloads instead.
        this._viewRenderedAt = cards.length ? Date.now() : 0;
        // Re-rendering resets scrollTop to 0 without firing a scroll event, so
        // re-sync the compact strip to avoid it sticking shrunk at the top.
        this.updateContinueCompact();

        // No results → disable "Random" so it isn't a silent no-op.
        if (this.randomBtn) this.randomBtn.disabled = cards.length === 0;

        if (cards.length === 0) {
            const filtered = this.hasActiveFilters();
            this.container.innerHTML = `
                <div class="empty-state rich-empty">
                    <div class="empty-icon">🎬</div>
                    <h3>${filtered ? 'No movies match these filters' : 'No movies here yet'}</h3>
                    <p>${filtered ? 'Try widening your search, genre or language filters.' : 'Movies appear as soon as Norva finishes preparing your catalog.'}</p>
                    ${filtered ? '<button class="btn btn-primary" id="movies-empty-reset">Clear filters</button>' : ''}
                </div>`;
            this.container.querySelector('#movies-empty-reset')?.addEventListener('click', () => this.resetFilters?.());
            // A non-filtered empty grid means the catalog is still filling — auto-reload
            // when it comes online instead of stranding the user on an empty page.
            if (!filtered) this._armCatalogRefreshWatch();
            return;
        }

        // Virtualization spacer: stands in for the recycled cards above the
        // window so the scrollbar geometry (and position) never jumps.
        const spacer = document.createElement('div');
        spacer.className = 'grid-spacer';
        spacer.style.height = '0px';
        this.container.appendChild(spacer);

        const loader = document.createElement('div');
        loader.className = 'movies-loader';
        loader.innerHTML = '<div class="loading-spinner"></div>';
        this.container.appendChild(loader);

        // One batch fills several TV rows and keeps the first search paint light.
        // Desktop/mobile retain their existing five-batch behaviour.
        const initialBatches = this._isTvMode() ? 1 : 5;
        for (let i = 0; i < initialBatches; i++) {
            this.renderNextBatch();
        }

        this.observer.observe(loader);

        // TV split-view: seed the docked panel with the first card so it's never empty
        // on entry (the grid keeps focus; this is a passive preview).
        if (this._isTvMode()) this._previewFirstCard();
    }

    // === Grid virtualization =================================================
    // The infinite scroll used to append 24-card batches FOREVER (a 500k-title
    // catalog = unbounded DOM). The window keeps at most ~15 batches alive:
    // scrolling down recycles the top cards into a height-preserving spacer;
    // scrolling back up rebuilds them from `filteredCards` (cards are pure
    // functions of their data, so nothing needs to be retained).

    static get GRID_DOM_CARD_CAP() { return 360; }

    recycleOffscreenCards() {
        const spacer = this.container?.querySelector('.grid-spacer');
        if (!spacer) return;
        let rendered = this.currentBatch * this.batchSize - (this._winStart || 0);
        while (rendered > MoviesPage.GRID_DOM_CARD_CAP) {
            const before = this.container.scrollHeight;
            let removed = 0;
            let node = spacer.nextElementSibling;
            while (node && removed < this.batchSize && node.classList.contains('movie-card')) {
                const next = node.nextElementSibling;
                node.remove();
                removed++;
                node = next;
            }
            if (!removed) break;
            const delta = before - this.container.scrollHeight;
            spacer.style.height = `${(parseFloat(spacer.style.height) || 0) + Math.max(0, delta)}px`;
            this._winStart = (this._winStart || 0) + removed;
            rendered -= removed;
        }
    }

    restoreRecycledCards() {
        const spacer = this.container?.querySelector('.grid-spacer');
        if (!spacer || !(this._winStart > 0)) return;
        const spacerHeight = parseFloat(spacer.style.height) || 0;
        if (spacerHeight <= 0 || this.container.scrollTop > spacerHeight + 600) return;

        const start = Math.max(0, this._winStart - this.batchSize);
        const fragment = document.createDocumentFragment();
        for (let i = start; i < this._winStart; i++) {
            const data = this.filteredCards[i];
            if (data) fragment.appendChild(this.buildCard(data));
        }
        const before = this.container.scrollHeight;
        spacer.after(fragment);
        const delta = this.container.scrollHeight - before;
        spacer.style.height = `${Math.max(0, spacerHeight - delta)}px`;
        this._winStart = start;
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
        this.recycleOffscreenCards();

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
        // cleanReleaseName: grid cards render the provider's raw stream name ("[ Torrent911.cc ] …")
        // straight from the client catalog cache — display-clean it (the raw value stays in the
        // data for the version/quality parsers).
        const displayName = (this.groupDuplicates && movie.tmdb?.title) ? movie.tmdb.title : MediaUtils.cleanReleaseName(movie.name);
        if (this._isTvMode()) {
            card.tabIndex = 0;
            card.setAttribute('role', 'button');
            card.setAttribute('aria-label', displayName || 'Movie');
        }
        const groupBroken = group.items.every(item => this.isBrokenItem(item));
        const languageBadge = MediaUtils.versionLanguageBadge(movie, this.getPreferences());
        // "New" corner badge for titles added in the last two weeks (unwatched).
        const isNew = watch.status !== 'watched' && group.items.some(i => MediaUtils.isRecentlyAdded(i));

        const srcset = MediaUtils.tmdbSrcset(poster);
        card.innerHTML = `
            <div class="movie-poster">
                ${isNew ? '<span class="new-badge">NEW</span>' : ''}
                <img src="${MediaUtils.escapeHtml(poster)}" alt="${MediaUtils.escapeHtml(displayName)}"
                     ${srcset ? `srcset="${MediaUtils.escapeHtml(srcset)}" sizes="(max-width: 640px) 45vw, 190px"` : ''}
                     onerror="this.onerror=null;this.srcset='';this.src='/img/norva-media-placeholder.png'" loading="lazy" decoding="async">
                <div class="movie-play-overlay">
                    <span class="play-icon">${Icons.play}</span>
                </div>
                ${groupBroken ? '<span class="playback-badge" title="Playback failed">⚠</span>' : ''}
                ${versionCount > 1 ? `<button class="version-badge" title="Choose version">${versionCount} versions</button>` : ''}
                ${languageBadge ? `<span class="version-language-badge ${versionCount > 1 ? 'with-version-badge' : ''}">${MediaUtils.escapeHtml(languageBadge)}</span>` : ''}
                ${watch.status === 'watched' ? '<span class="watched-badge" title="Watched">✓</span>' : ''}
                ${watch.status === 'inprogress' ? `<div class="card-progress"><div class="card-progress-fill" style="width:${Math.round(watch.ratio * 100)}%"></div></div>` : ''}
                <button class="favorite-btn ${isFav ? 'active' : ''}" aria-label="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
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

        // A TV card is one composite D-pad stop. Its corner controls remain
        // clickable with a pointer but must not become nested focus targets.
        if (this._isTvMode()) {
            card.querySelectorAll('.version-badge, .favorite-btn').forEach(button => {
                button.tabIndex = -1;
            });
        }

        // Stash the group so the TV panel can preview this card from the delegated
        // grid focusin listener (which has no access to this closure).
        card.__movieGroup = group;

        card.addEventListener('click', (e) => {
            if (e.target.closest('.favorite-btn')) {
                e.stopPropagation();
                this.toggleFavorite(group, e.target.closest('.favorite-btn'));
                return;
            }
            // TV split-view: the panel already previews this card. Committing plays a
            // single version, or (multi) sends focus to the labelled version list —
            // never a fullscreen fiche takeover. The version badge lands there too.
            if (this._isTvMode()) {
                e.stopPropagation();
                this._tvCommitCard(group);
                return;
            }
            if (e.target.closest('.version-badge')) {
                e.stopPropagation();
                this.openGroup(group, { focusVersions: true });
            } else {
                this.openGroup(group);
            }
        });

        // Hover preview (desktop): bigger art + instant Play / Details.
        card.__norvaHover = () => ({
            title: displayName,
            meta: [year, movie.tmdb?.runtime ? `${movie.tmdb.runtime} min` : '', movie.rating ? `★ ${movie.rating}` : '']
                .filter(Boolean).join(' · '),
            poster,
            backdrop: MediaUtils.safeImageUrl(this.getMovieBackdrop(movie), '') || null,
            onPlay: () => {
                this.openGroup(group);
                let tries = 0;
                const tick = () => {
                    const btn = document.querySelector('#movie-details:not(.hidden) #movie-primary-action');
                    if (btn && !btn.disabled) { btn.click(); return; }
                    if (++tries < 12) setTimeout(tick, 250);
                };
                setTimeout(tick, 150);
            },
            onDetails: () => this.openGroup(group)
        });

        return card;
    }

    // === Continue Watching row ===

    getResumeOffset(progress, duration = 0) {
        const position = Math.max(0, Math.floor(Number(progress) || 0));
        const total = Math.max(0, Math.floor(Number(duration) || 0));
        if (position < 12) return 0;
        if (total > 0 && position >= total * 0.95) return 0;
        return position;
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
                     onerror="this.onerror=null;this.srcset='';this.src='/img/norva-media-placeholder.png'" loading="lazy" decoding="async" alt="">
                <div class="continue-card-info">
                    <p class="continue-card-title">${MediaUtils.escapeHtml(MediaUtils.cleanReleaseName(h.data?.title || '') || 'Unknown')}</p>
                    <div class="card-progress"><div class="card-progress-fill" style="width:${ratio}%"></div></div>
                </div>
            </div>`;
        }).join('');

        this.continueList.querySelectorAll('.continue-card').forEach(card => {
            if (this._isTvMode()) {
                const h = inProgress.find(x => String(x.item_id) === card.dataset.itemId);
                card.tabIndex = 0;
                card.setAttribute('role', 'button');
                card.setAttribute('aria-label', `Resume ${MediaUtils.cleanReleaseName(h?.data?.title || '') || 'movie'}`);
            }
            card.addEventListener('click', () => {
                const h = inProgress.find(x => String(x.item_id) === card.dataset.itemId);
                if (h) this.resumeFromHistory(h);
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
        const resumeVersion = this._selectInProgressVersion(ordered);
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
        return movie?.tmdb?.title || MediaUtils.cleanReleaseName(movie?.title || movie?.name || '') || 'Movie';
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

    getMovieBackdrop(movie = this.currentMovie, size = 'w1280') {
        return this.getTmdbImageUrl(
            movie?.backdrop_path || movie?.tmdb?.backdrop_path || movie?.backdrop || movie?.tmdb?.backdrop,
            size
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

    _watchStateKey(sourceId, itemId) {
        const id = String(itemId ?? '');
        return sourceId == null || sourceId === '' ? id : `${String(sourceId)}:${id}`;
    }

    // Xtream stream ids are only unique inside one provider account. Exact
    // source+stream identity prevents one provider's progress from being painted
    // onto another provider's card. Legacy id-only fallback is allowed only when
    // the item itself genuinely has no source identity.
    _watchStateFor(item) {
        const itemId = item?.stream_id ?? item?.streamId ?? item?.item_id ?? item?.id;
        const sourceId = item?.sourceId ?? item?.source_id ?? item?.cloudSourceId ?? item?.cloud_source_id;
        if (sourceId != null && sourceId !== '') {
            return this.watchState.get(this._watchStateKey(sourceId, itemId)) || null;
        }
        return this.watchState.get(this._watchStateKey(null, itemId)) || null;
    }

    getMovieWatchState(movie = this.currentMovie) {
        const state = this._watchStateFor(movie);
        if (!state) return { status: 'unwatched', ratio: 0, progress: 0, duration: 0, resumeTime: 0 };
        const resumeTime = this.getResumeOffset(state.progress, state.duration);
        if (state.completed || state.ratio >= 0.95) return { ...state, status: 'watched', resumeTime: 0 };
        if (resumeTime > 0) return { ...state, status: 'inprogress', resumeTime };
        return { ...state, status: 'unwatched', resumeTime: 0 };
    }

    getMovieActionLabel(movie = this.currentMovie) {
        const state = this.getMovieWatchState(movie);
        if (state.status === 'inprogress') return 'Resume';
        if (state.status === 'watched') return 'Restart';
        return 'Play';
    }

    _selectInProgressVersion(items = []) {
        return items
            .map((item, order) => ({ item, order, state: this.getMovieWatchState(item) }))
            .filter(entry => entry.state.status === 'inprogress')
            .sort((left, right) => {
                const leftUpdated = Date.parse(left.state.updatedAt || 0) || 0;
                const rightUpdated = Date.parse(right.state.updatedAt || 0) || 0;
                return rightUpdated - leftUpdated
                    || Number(right.state.progress || 0) - Number(left.state.progress || 0)
                    || left.order - right.order;
            })[0]?.item || null;
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

    // === Thumbs up/down (per-profile title rating) ===

    paintThumbButtons(rating) {
        document.getElementById('movie-thumb-up')?.classList.toggle('active', rating === 1);
        document.getElementById('movie-thumb-down')?.classList.toggle('active', rating === -1);
    }

    async loadRating() {
        this._currentRating = 0;
        this.paintThumbButtons(0);
        const movie = this.currentMovie;
        if (!movie || !window.NorvaCloud?.ratings) return;
        try {
            const res = await NorvaCloud.ratings.get({ itemType: 'movie', itemId: movie.stream_id });
            this._currentRating = Number(res?.rating) || 0;
            this.paintThumbButtons(this._currentRating);
        } catch (_) { /* ratings are cloud-only / best-effort */ }
    }

    async setRating(value) {
        const movie = this.currentMovie;
        if (!movie || !window.NorvaCloud?.ratings) return;
        // Clicking the active thumb clears it (toggle-off), like Netflix.
        const next = this._currentRating === value ? 0 : value;
        this._currentRating = next;
        this.paintThumbButtons(next);
        try {
            await NorvaCloud.ratings.set({ sourceId: movie.sourceId, itemId: movie.stream_id, itemType: 'movie', rating: next });
        } catch (_) {
            this.app?.showToast?.('Could not save your rating', { type: 'error' });
        }
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
        this.versionSummary.textContent = this._isTvMode()
            ? `${versions.length} versions available. Press OK to play a version.`
            : `${versions.length} versions available. Play uses the selected version.`;
        this.versionsList.innerHTML = versions.map((item, index) => {
            const desc = MediaUtils.versionDescriptor(item, {
                siblings: versions,
                index,
                resolveSourceName: (id) => this.getSourceName(id)
            });
            const state = this.getMovieWatchState(item);
            const active = String(item.stream_id) === String(selectedMovie?.stream_id) &&
                String(item.sourceId) === String(selectedMovie?.sourceId);
            const dot = desc.tier
                ? `<span class="version-tier-dot ${MediaUtils.escapeHtml(desc.tier.cls)}" title="${MediaUtils.escapeHtml(desc.tier.label)}"></span>`
                : '';
            const badge = desc.badge
                ? `<span class="version-quality-badge ${/(4k|2160|uhd)/i.test(desc.badge) ? 'hi' : ''}">${MediaUtils.escapeHtml(desc.badge)}</span>`
                : '';
            const meta = desc.meta ? `<span class="version-meta">${MediaUtils.escapeHtml(desc.meta)}</span>` : '';
            return `
                <button class="movie-version-item ${active ? 'active' : ''}" type="button" data-index="${index}">
                    <span class="version-head">${dot}<span class="version-headline">${MediaUtils.escapeHtml(desc.headline)}</span>${badge}</span>
                    ${meta}
                    ${state.status === 'inprogress' ? '<span class="movie-version-progress">In progress</span>' : ''}
                    ${state.status === 'watched' ? '<span class="movie-version-progress">Watched</span>' : ''}
                </button>`;
        }).join('');

        this.versionsList.querySelectorAll('.movie-version-item').forEach(btn => {
            btn.addEventListener('click', async () => {
                const index = parseInt(btn.dataset.index);
                const movie = versions[index];
                if (!movie) return;

                // On TV, OK on a labelled version is the commit action. Re-rendering
                // this list used to destroy focus, while Play returned to the same list.
                if (this._isTvMode()) {
                    const state = this.getMovieWatchState(movie);
                    const fallbacks = [
                        movie,
                        ...versions.filter(item => this._movieKey(item) !== this._movieKey(movie))
                    ];
                    await this.playMovie(movie, {
                        versions: fallbacks,
                        resumeTime: state.resumeTime || 0,
                        playbackPreferences: state.data?.playbackPreferences ||
                            state.data?.playback_preferences || null
                    });
                    return;
                }

                this.showMovieDetails(this.currentMovieGroup, movie, { versions, isVersionSwitch: true });
            });
        });
    }

    _isTvMode() {
        return document.documentElement.classList.contains('tv-mode');
    }

    // Android TV only: arrange the existing controls into the same visual bands as
    // the supplied mockup. Existing nodes are MOVED (never cloned), so their event
    // listeners, values and controller references remain valid. This method never
    // runs on web/mobile.
    _setupTvMoviesLayout() {
        const page = this.pageEl;
        const header = page?.querySelector('.movies-header');
        const controls = header?.querySelector('.movies-controls');
        const legacyFilterBar = document.getElementById('movies-filter-bar');
        if (!page || !header || !controls || !legacyFilterBar || !this.container) return;

        // Explicit contract with tvNavigation.js: this visible panel is a docked
        // split-view region, never a modal scope. Clear any stale web fiche state too.
        if (this.detailsPanel) this.detailsPanel.dataset.tvSplitPreview = 'true';
        page.classList.remove('movie-detail-open');
        this.container.classList.remove('hidden');
        if (page.classList.contains('tv-movies-layout-ready')) return;

        const primary = document.createElement('div');
        primary.id = 'movies-tv-primary-filters';
        primary.className = 'tv-movies-filter-row tv-movies-primary-filters';
        primary.setAttribute('aria-label', 'Movie filters');
        primary.dataset.tvNavRegion = 'movies-filters';

        const secondary = document.createElement('div');
        secondary.id = 'movies-tv-secondary-filters';
        secondary.className = 'tv-movies-filter-row tv-movies-secondary-filters';
        secondary.setAttribute('aria-label', 'Availability and view options');
        secondary.dataset.tvNavRegion = 'movies-filters';

        const catalogHead = document.createElement('div');
        catalogHead.id = 'movies-tv-catalog-head';
        catalogHead.className = 'tv-movies-catalog-head';
        catalogHead.dataset.tvNavRegion = 'movies-filters';

        const catalogTitle = document.createElement('h3');
        catalogTitle.className = 'tv-movies-catalog-title';
        catalogTitle.textContent = 'All Movies';
        const catalogMeta = document.createElement('div');
        catalogMeta.className = 'tv-movies-catalog-meta';
        catalogMeta.appendChild(catalogTitle);
        catalogHead.appendChild(catalogMeta);

        const categoryControl = document.getElementById('movies-category-btn')?.closest('.multi-select');
        const searchWrapper = this.searchInput?.closest('.search-wrapper');
        const favoriteBtn = document.getElementById('movies-favorites-btn');
        const append = (host, element) => { if (host && element) host.appendChild(element); };

        // Header: title/subtitle at left, search at right.
        append(controls, searchWrapper);

        // Row 1: source, categories, year, rating, audio and subtitles.
        [this.sourceSelect, categoryControl, this.yearSelect, this.ratingSelect,
         this.audioSelect, this.subtitleSelect].forEach(element => append(primary, element));

        // Row 2: watch state, recency and the main catalogue actions.
        [this.watchedSelect, this.addedSelect, favoriteBtn,
         this.groupToggleBtn, this.resetBtn].forEach(element => append(secondary, element));

        // One compact TV toolbar owns title/count, active chips + Clear all, and
        // sort. This removes a full row without changing mobile/web structure.
        append(catalogMeta, this.countEl);
        append(catalogHead, this.activeFiltersEl);
        append(catalogHead, this.sortSelect);
        this.resetBtn?.classList.remove('hidden');
        // The whole merged toolbar is one D-pad region, so chips can continue
        // horizontally into Sort before the right-edge jump to the fiche.
        this.activeFiltersEl?.removeAttribute('data-tv-nav-region');

        // Nodes deliberately left in the hidden legacy bar are not TV D-pad stops.
        legacyFilterBar.querySelectorAll('button, input, select, textarea, [tabindex]').forEach(element => {
            element.tabIndex = -1;
        });
        const backButton = this.detailsPanel?.querySelector('.movie-back-btn');
        if (backButton) backButton.tabIndex = -1;

        const anchor = [this.continueRow, this.container, this.detailsPanel]
            .find(element => element?.parentElement === page) || null;
        page.insertBefore(primary, anchor);
        page.insertBefore(secondary, anchor);
        page.insertBefore(catalogHead, anchor);
        page.classList.add('tv-movies-layout-ready');
    }

    _movieKey(movie) {
        return movie ? `${movie.sourceId}:${movie.stream_id}` : '';
    }

    // TV split-view: render the D-pad-focused card into the docked panel as a light
    // preview (no grid takeover, no heavy extras, no focus steal). Extras load only
    // when the user steps into the panel (_loadPanelExtras).
    previewCard(card) {
        const group = card?.__movieGroup;
        if (!group?.items?.length) return;
        // Re-focusing the SAME card (focusin re-fires; a fast D-pad burst that lands back
        // here) must be free — showMovieDetails below rebuilds the entire panel. The panel
        // already shows this card, so skip. Cleared on commit (_tvCommitCard) so backing out
        // of the fiche re-previews correctly.
        if (card === this._lastPreviewCard) return;
        this._lastPreviewCard = card;
        this.container?.querySelectorAll('.movie-card.tv-preview-active').forEach(active => {
            if (active !== card) active.classList.remove('tv-preview-active');
        });
        card.classList.add('tv-preview-active');
        const ordered = MediaUtils.orderVersionsByPreference(group.items, this.getPreferences());
        const selected = this._selectInProgressVersion(ordered) || ordered[0];
        this.showMovieDetails(group, selected, { versions: ordered, isTvPreview: true });
    }

    // On page entry, seed the panel with the first card so it's never empty.
    _previewFirstCard() {
        const first = this.container?.querySelector('.movie-card');
        if (first) this.previewCard(first);
    }

    // Committing a card on TV (Enter/click): a single healthy version plays straight
    // away; multiple versions ALWAYS send the user to the labelled version list to
    // choose — never auto-play a guessed variant.
    _tvCommitCard(group) {
        if (!group?.items?.length) return;
        // Committing loads heavy extras into the panel, so invalidate the light-preview
        // guard: backing out to the grid and re-focusing this same card must re-preview.
        this._lastPreviewCard = null;
        const ordered = MediaUtils.orderVersionsByPreference(group.items, this.getPreferences());
        const selected = this._selectInProgressVersion(ordered) || ordered[0];
        // Make sure the panel reflects THIS card even if the preview debounce hasn't fired.
        this.showMovieDetails(group, selected, { versions: ordered, isTvPreview: true });
        // OK/commit ENTERS the fiche so the viewer can navigate it (Play, versions, favorite,
        // more-like-this) rather than auto-playing.
        this._loadPanelExtras();
        this._focusPanelPrimary();
    }

    // Land the D-pad ring on the fiche's primary action (Play/Resume); fall back to the
    // versions list, then Favorite, if it isn't ready yet. Shared by the grid commit
    // (_tvCommitCard) and external committed opens (Home rails / global search / restore
    // via showMovieDetails) — the docked TV panel is a split-preview that tvNavigation
    // deliberately never anchors into, so every committed entry must move the ring itself.
    _focusPanelPrimary() {
        requestAnimationFrame(() => {
            const panel = this.detailsPanel;
            if (!panel || panel.classList.contains('hidden')) return;
            const primary = this.primaryActionBtn;
            let target = (primary && !primary.disabled && primary.offsetParent) ? primary : null;
            if (!target) target = this.versionsList?.querySelector('.movie-version-item.active, .movie-version-item') || null;
            if (!target && this.detailFavoriteBtn && !this.detailFavoriteBtn.disabled) target = this.detailFavoriteBtn;
            if (target) { target.focus(); target.scrollIntoView({ block: 'nearest' }); }
        });
    }

    // Move focus into the version list, pre-selecting the in-progress version if any
    // (so a resume is one press away) else the recommended (top) one. Loads extras too.
    _focusVersionsList() {
        this._loadPanelExtras();
        const list = this.versionsList;
        if (!list) return;
        requestAnimationFrame(() => {
            const items = [...list.querySelectorAll('.movie-version-item')];
            if (!items.length) return;
            const target = items.find(b => b.querySelector('.movie-version-progress')) || items[0];
            target.focus();
            target.scrollIntoView({ block: 'nearest' });
        });
    }

    // Heavy fiche extras (more-like-this rail + cast/trailer) — loaded once per movie,
    // only when the panel is entered, so grid browsing never pays for them.
    _loadPanelExtras() {
        const movie = this.currentMovie;
        if (!movie) return;
        const key = this._movieKey(movie);
        if (this._extrasLoadedFor === key) return;
        this._extrasLoadedFor = key;
        this.loadRating();
        this.renderMoreLikeThis(movie);
        this.renderFicheExtras(this.currentMovieGroup?.representative || movie);
    }

    showMovieDetails(group, selectedMovie = null, { versions = null, focusVersions = false, isVersionSwitch = false, isTvPreview = false } = {}) {
        if (!group?.items?.length || !this.detailsPanel) return;
        const isTv = this._isTvMode();
        const ordered = versions || MediaUtils.orderVersionsByPreference(group.items, this.getPreferences());
        const movie = selectedMovie || ordered[0] || group.representative;
        const displayMovie = group.representative || movie;

        this.currentMovieGroup = group;
        this.currentMovieVersions = ordered;
        this.currentMovie = movie;
        // Remember the open fiche so a page refresh restores it (see app.restoreOpenFiche).
        // Skipped on TV: the panel is derived live from grid focus, not a persisted "open" state.
        if (!isTv) {
            try {
                window.app?.rememberOpenFiche?.({
                    type: 'movie', sourceId: movie.sourceId, id: movie.stream_id,
                    title: this.getMovieDisplayTitle(displayMovie),
                    // Stash the whole version group so the restore rebuilds the EXACT fiche
                    // (all versions + the selected one) without re-searching.
                    group: this.currentMovieGroup,
                });
            } catch (_) { /* best-effort */ }
        }

        // TV keeps the grid AND the panel visible side-by-side (split-view). Only the
        // phone/web fiche does the fullscreen takeover (hide grid, mark page open).
        if (!isTv) {
            this.pageEl?.classList.add('movie-detail-open');
            this.container.classList.add('hidden');
        } else {
            this.pageEl?.classList.remove('movie-detail-open');
            this.container.classList.remove('hidden');
        }
        this.detailsPanel.classList.remove('hidden');
        // A version switch re-renders in place while the user is scrolled down at the
        // versions list — don't yank them back to the hero. On a fresh TV preview,
        // reset to the top and drop any stale extras from the previously-focused card.
        if (!isVersionSwitch && !isTv) this.detailsPanel.scrollTop = 0;
        if (isTvPreview) {
            this.detailsPanel.scrollTop = 0;
            this.detailsPanel.querySelector('.more-like-this')?.remove();
            this.detailsPanel.querySelector('.detail-credits')?.remove();
            this.detailsPanel.querySelector('.detail-trailer-btn')?.remove();
            this._extrasLoadedFor = null;
        }

        // Context-aware back label — return to the search results, the open genre,
        // or the Movies home, whichever the fiche was opened from.
        const backBtn = this.detailsPanel.querySelector('.movie-back-btn');
        if (backBtn) {
            const ctx = this.searchInput?.value?.trim()
                ? 'Search results'
                : (this.activeBucket && this.bucketLabel ? this.bucketLabel : 'Movies');
            // Update only the label span — the button holds an SVG arrow icon that a
            // raw textContent write would destroy.
            const label = backBtn.querySelector('.back-label');
            if (label) label.textContent = ctx;
            else backBtn.textContent = `← ${ctx}`;
        }

        const hero = document.getElementById('movie-detail-hero');
        const poster = this.getMoviePoster(displayMovie);
        // A smaller backdrop for the TV panel: it's a modest split-view hero, so a w780
        // image decodes far cheaper than w1280 on the weak TV GPU (indistinguishable at
        // that size). The web/mobile fullscreen fiche keeps w1280.
        const backdrop = this.getMovieBackdrop(displayMovie, isTv ? 'w780' : 'w1280');

        const posterEl = document.getElementById('movie-detail-poster');
        if (posterEl) {
            // A stale/404 poster (e.g. TMDB replaced the image) must fall back to the
            // placeholder, not render a broken-image icon. Clear srcset (the browser
            // prefers it over src) so the fallback actually shows.
            posterEl.onerror = () => { posterEl.onerror = null; posterEl.removeAttribute('srcset'); posterEl.src = '/img/norva-media-placeholder.png'; };
            posterEl.setAttribute('decoding', 'async');  // never block a D-pad move on decode
            posterEl.alt = this.getMovieDisplayTitle(displayMovie);
        }

        // The backdrop (CSS hero background + the panel poster <img>, which on TV IS the
        // cinematic backdrop) is the single most expensive per-preview cost: a large
        // image the weak TV GPU must fetch, decode and upload. During a D-pad sweep the
        // focused card changes several times a second, so on a TV PREVIEW we DEBOUNCE the
        // image swap — only the card the user settles on decodes an image. A momentarily
        // stale backdrop is purely cosmetic (it never affects focus or the panel's
        // buttons/labels, which are updated synchronously below), so this is safe even if
        // the user steps into the panel before it lands. URL guards skip redundant work.
        const heroBg = `url("${String(backdrop).replace(/"/g, '%22')}")`;
        const posterSrc = isTv && backdrop ? backdrop : poster;
        const applyBackdrop = () => {
            if (hero && this._lastHeroBg !== heroBg) {
                hero.style.setProperty('--movie-hero-bg', heroBg);
                this._lastHeroBg = heroBg;
            }
            if (posterEl && this._lastPosterSrc !== posterSrc) {
                posterEl.removeAttribute('srcset');
                posterEl.src = posterSrc;
                this._lastPosterSrc = posterSrc;
            }
        };
        if (this._previewBackdropTimer) { clearTimeout(this._previewBackdropTimer); this._previewBackdropTimer = null; }
        if (isTvPreview) {
            this._previewBackdropTimer = setTimeout(() => { this._previewBackdropTimer = null; applyBackdrop(); }, 110);
        } else {
            applyBackdrop();
        }

        const titleEl = document.getElementById('movie-detail-title');
        if (titleEl) titleEl.textContent = this.getMovieDisplayTitle(displayMovie);

        const plotEl = document.getElementById('movie-detail-plot');
        if (plotEl) plotEl.textContent = displayMovie.tmdb?.overview || displayMovie.overview || displayMovie.description || displayMovie.plot || 'No summary available yet.';

        const version = MediaUtils.parseVersionInfo(movie.name);
        const rating = parseFloat(displayMovie.rating || displayMovie.tmdb?.vote_average);
        const ratingLabel = Number.isFinite(rating) && rating > 0 ? `★ ${rating.toFixed(1).replace('.0', '')}` : '';
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
            progressEl.classList.toggle('hidden', state.status !== 'inprogress');
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
        // A TV grid preview can change several times per second. Defer the cloud
        // rating request until the user actually enters the panel, preventing
        // stale responses and network churn while navigating posters.
        if (!isTvPreview) this.loadRating();
        this.syncDownloadButton();
        this.renderMovieVersions(movie);
        // A version switch keeps the same title — re-highlighting the versions list above is
        // enough; don't refetch/rebuild the "More like this" rail + extras on every tap
        // (network churn + a visible flash of the recommendations). On TV, a preview also
        // defers the extras — they load lazily when the user steps into the panel
        // (_loadPanelExtras), so flying through the grid never triggers fetches.
        if (!isVersionSwitch && !isTvPreview) {
            this.renderMoreLikeThis(movie);
            this.renderFicheExtras(displayMovie);
        }

        if (focusVersions) {
            setTimeout(() => {
                this.detailsPanel?.querySelector('.movie-versions-section')?.scrollIntoView({ block: 'start' });
            }, 50);
        }

        // External committed open on TV — Home rails, Movies-page rails (they route through
        // Home), global search, fiche restore: every internal grid path passes isTvPreview,
        // so a bare TV call here means the user explicitly picked THIS title elsewhere. The
        // docked panel is a split-preview tvNavigation never anchors into; without moving the
        // ring in, the D-pad stays in the grid and the very first arrow press re-previews
        // another card OVER the fiche the user asked for. Mirror _tvCommitCard: sync the
        // preview/extras guards and land the ring on the primary action (or the versions list
        // when the caller asked for it). Version switches keep the user's place, and a ring
        // already inside the panel is never yanked.
        if (isTv && !isTvPreview && !isVersionSwitch) {
            this._lastPreviewCard = null;
            this._extrasLoadedFor = this._movieKey(movie); // extras just rendered inline above
            const ae = document.activeElement;
            if (!(ae && ae !== document.body && this.detailsPanel.contains(ae))) {
                if (focusVersions) this._focusVersionsList();
                else this._focusPanelPrimary();
            }
        }
    }

    // Live TMDB extras on the fiche: trailer button + cast/director credits.
    // Fire-and-forget with a token so a stale fetch never paints a newer fiche.
    async renderFicheExtras(displayMovie) {
        const token = (this._ficheExtrasToken = (this._ficheExtrasToken || 0) + 1);
        this.detailsPanel?.querySelector('.detail-credits')?.remove();
        this.detailsPanel?.querySelector('.detail-trailer-btn')?.remove();
        const tmdbId = displayMovie?.provider_tmdb_id || displayMovie?.providerTmdbId
            || displayMovie?.tmdb_id || displayMovie?.tmdb?.id || displayMovie?.metadata?.providerTmdbId;
        if (!tmdbId || /^(tt)?0+$/i.test(String(tmdbId)) || !window.NorvaCloud?.media?.tmdbMeta) return;
        try {
            const meta = await NorvaCloud.media.tmdbMeta({ type: 'movie', tmdbId: String(tmdbId) });
            if (token !== this._ficheExtrasToken || !meta?.available) return;

            const plotEl = document.getElementById('movie-detail-plot');
            const liveOverview = String(meta.overview || '').trim();
            if (plotEl && liveOverview
                && (!String(plotEl.textContent || '').trim()
                    || plotEl.textContent === 'No summary available yet.')) {
                plotEl.textContent = liveOverview;
            }
            const people = [];
            const castNames = (meta.cast || []).slice(0, 6).map(c => c.name).filter(Boolean);
            if (castNames.length) people.push(`<span class="detail-credits-label">Cast</span> ${MediaUtils.escapeHtml(castNames.join(', '))}`);
            if ((meta.directors || []).length) people.push(`<span class="detail-credits-label">Director</span> ${MediaUtils.escapeHtml(meta.directors.join(', '))}`);
            if (people.length && plotEl) {
                const credits = document.createElement('div');
                credits.className = 'detail-credits';
                credits.innerHTML = people.map(p => `<div class="detail-credits-row">${p}</div>`).join('');
                plotEl.insertAdjacentElement('afterend', credits);
            }

            if (meta.trailerKey) {
                const actions = this.detailsPanel?.querySelector('.movie-detail-actions');
                if (actions && !actions.querySelector('.detail-trailer-btn')) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'btn btn-ghost detail-trailer-btn';
                    btn.innerHTML = '▶ Trailer';
                    btn.addEventListener('click', () =>
                        MediaUtils.openTrailerLightbox(meta.trailerKey, this.getMovieDisplayTitle(displayMovie)));
                    actions.appendChild(btn);
                }
            }
        } catch (_) { /* extras are progressive enhancement */ }
    }

    // "More like this": a genre-matched rail at the bottom of the fiche so the user
    // keeps browsing instead of backing out. Fire-and-forget; a token guards against
    // a stale fetch landing on a newer fiche.
    async renderMoreLikeThis(movie) {
        const host = this.detailsPanel;
        if (!host || !window.GenreRails?.appendCards || !API.media?.genreItems) return;
        const token = (this._mltToken = (this._mltToken || 0) + 1);
        host.querySelector('.more-like-this')?.remove();
        try {
            const T = window.GenreTaxonomy;
            const bucket = T ? T.classifyTitle(this.getCategoryName(movie), this.getMovieGenres(movie))[0] : null;
            if (!bucket) return;
            const payload = await API.media.genreItems({ type: 'movie', bucket, limit: 24, ...this.currentLanguageParams() });
            if (token !== this._mltToken || host.classList.contains('hidden')) return;
            const curKey = `${movie?.sourceId}:${movie?.stream_id}`;
            const items = (payload?.items || [])
                .filter(i => `${i.sourceId}:${i.stream_id}` !== curKey)
                .slice(0, 18);
            if (!items.length) return;
            host.querySelector('.more-like-this')?.remove();
            const section = document.createElement('section');
            section.className = 'more-like-this';
            section.innerHTML = '<h3 class="more-like-title">More like this</h3><div class="horizontal-scroll more-like-grid"></div>';
            host.appendChild(section);
            const rail = section.querySelector('.more-like-grid');
            window.GenreRails.appendCards(rail, items, {
                onItemClick: (item) => this.openRailItem(item)
            });
            // GenreRails may use different card classes across catalogue modes.
            // Stamp a stable TV-only hook so sizing and D-pad focus never depend on
            // whichever desktop percentage rule that card happens to inherit.
            if (this._isTvMode()) {
                [...rail.children].forEach(card => {
                    if (card.matches('.scroll-arrow, .empty-state')) return;
                    card.classList.add('tv-more-like-card');
                    card.tabIndex = 0;
                    if (!card.hasAttribute('role')) card.setAttribute('role', 'button');
                });
            }
        } catch (_) { /* the fiche works fine without related titles */ }
    }

    hideDetails() {
        // On TV the panel is persistent (split-view) — there is nothing to close.
        if (this._isTvMode()) return;
        try { window.app?.forgetOpenFiche?.(); } catch (_) { /* noop */ }
        this.detailsPanel?.querySelector('.more-like-this')?.remove();
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
        // TV: never auto-play a guessed variant. Multiple versions → send the user to
        // the labelled version list to choose (pre-focused on the in-progress one).
        // Single version → play straight through.
        if (this._isTvMode() && (this.currentMovieVersions?.length || 0) > 1) {
            this._focusVersionsList();
            return;
        }
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
        const best = this._selectInProgressVersion(ordered) || ordered[0];
        const watch = this._watchStateFor(best);
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
                        <span class="version-item-name">${MediaUtils.escapeHtml(MediaUtils.cleanReleaseName(item.name))}</span>
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
        const fileAudioTracks = movie.audio_tracks_scope === 'file' || movie.audioTracksScope === 'file'
            ? (movie.audioTracks || movie.audio_tracks || [])
            : null;
        const audioLanguageValidationStatus = String(
            movie.audioLanguageValidationStatus ||
            movie.audio_language_validation_status ||
            (fileAudioTracks !== null ? 'pending' : 'not_analyzed')
        ).toLowerCase();
        const audioLanguageKnown = ['verified', 'verified_union', 'probed', 'probed_union']
            .includes(audioLanguageValidationStatus);
        const fileAudioLanguages = fileAudioTracks &&
            audioLanguageKnown
            ? [...new Set([
                ...(movie.audioLanguages || movie.audio_languages || []),
                ...fileAudioTracks
                    .map(track => track?.lang || track?.language || '')
            ].map(code => MediaUtils.normalizeLanguagePreference(code))
                .filter(code => code && code !== 'und' && code !== 'unknown'))]
            : null;
        const versionList = (versions || [movie]).map(v => ({
            sourceId: v.sourceId,
            cloudSourceId: v.cloudSourceId || v.cloud_source_id || null,
            streamId: v.stream_id,
            container: v.container_extension || 'mp4',
            type: 'movie',
            label: MediaUtils.versionLabel(v, this.getSourceName(v.sourceId)),
            audioTracks: v.audio_tracks_scope === 'file' || v.audioTracksScope === 'file'
                ? (v.audioTracks || v.audio_tracks || [])
                : null,
            audioLanguageValidationStatus: String(
                v.audioLanguageValidationStatus ||
                v.audio_language_validation_status ||
                'not_analyzed'
            ).toLowerCase(),
            audioLanguageVerifiedAt: v.audioLanguageVerifiedAt || v.audio_language_verified_at || null,
            subtitleTracks: v.subtitle_tracks_scope === 'file' || v.subtitleTracksScope === 'file'
                ? (v.subtitleTracks || v.subtitle_tracks || [])
                : null
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
            cloudSourceId: movie.cloudSourceId || movie.cloud_source_id || null,
            titleId: movie.titleId || movie.title_id || null,
            categoryId: movie.category_id,
            containerExtension: container,
            resumeTime: resumePlan.target,
            playbackPreferences,
            durationHint: movie.tmdb?.runtime ? movie.tmdb.runtime * 60 : null,
            versions: versionList,
            versionIndex: 0,
            variantCount: Math.max(1, Number(movie.variantCount || movie.variant_count || versionList.length || 1)),
            audioLanguages: fileAudioLanguages,
            audioLanguageValidationStatus,
            audioLanguageVerifiedAt: movie.audioLanguageVerifiedAt || movie.audio_language_verified_at || null,
            audioLanguageVerification: movie.audioLanguageVerification || movie.audio_language_verification || {},
            versionLanguages: movie.versionLanguages || movie.version_languages || null,
            originalLanguage: movie.originalLanguage || movie.original_language || null,
            // Exact-file ordered language map served on the selected variant by
            // norva-catalog. It can label tracks without inheriting a sibling dub.
            audioTracks: fileAudioTracks,
            audioTracksScope: fileAudioTracks !== null ? 'file' : null,
            subtitleTracks: movie.subtitle_tracks_scope === 'file' || movie.subtitleTracksScope === 'file'
                ? (movie.subtitleTracks || movie.subtitle_tracks || [])
                : null,
            subtitleTracksScope: movie.subtitle_tracks_scope === 'file' || movie.subtitleTracksScope === 'file'
                ? 'file'
                : null
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
                await API.favorites.add(movie.sourceId, movie.stream_id, 'movie', {
                    name: this.getMovieDisplayTitle(movie),
                    poster: this.getMoviePoster(movie),
                    type: 'movie'
                });
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            await this.loadFavorites();
            this.filterAndRender();
            // The fiche (not the grid) is what's on screen — re-sync its favorite button
            // off the reloaded truth, else it stays stuck on the wrong optimistic state.
            this.syncDetailFavoriteButton?.();
        }
    }
}

window.MoviesPage = MoviesPage;
