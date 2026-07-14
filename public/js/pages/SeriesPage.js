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
        this.seasonTabs = document.getElementById('series-season-tabs');
        this._activeSeason = null;
        this.primaryActionBtn = document.getElementById('series-primary-action');
        this.playStartBtn = document.getElementById('series-play-start');
        this.detailFavoriteBtn = document.getElementById('series-detail-favorite');
        this.versionsList = document.getElementById('series-versions-list');
        this.versionSummary = document.getElementById('series-version-summary');

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
        this.randomBtn = document.getElementById('series-random');
        this.countEl = document.getElementById('series-count');
        this.resetBtn = document.getElementById('series-reset');
        this.activeFiltersEl = document.getElementById('series-active-filters');
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
        this._tvPendingCloudReset = false;
        this._tvSearchTextCache = new WeakMap();
        this._tvSearchGeneration = 0;
        this._searchTimeout = null;
        this._searchIdleCallback = null;
        this._tvPreviewCard = null;
        this._tvPreviewGroup = null;
        this._tvDetailOriginCard = null;
        this.observer = null;
        this.hiddenCategoryIds = new Set();
        this.currentSeries = null;
        this.currentSeriesGroup = null;
        this.favoriteIds = new Set();
        this.showFavoritesOnly = false;
        this.groupDuplicates = true;
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
            // Preserve the rest of the active TV filter state. In particular, a TV
            // Audio/Subtitles or genre view lives on the title-level bucket route;
            // jumping straight to /media/page here silently discarded that filter.
            if (this._isTvMode()) this.onFiltersChanged();
            else await this.loadSeries();
        });

        // TV remotes and IMEs can emit dense input bursts. Give the WebView time
        // to paint, then discard stale generations before touching the catalogue.
        this.searchInput?.addEventListener('input', () => {
            clearTimeout(this._searchTimeout);
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


        this.randomBtn?.addEventListener('click', () => this.openRandom());
        this.resetBtn?.addEventListener('click', () => this.resetFilters());

        document.querySelector('.series-back-btn')?.addEventListener('click', () => {
            this.hideDetails();
        });

        this.primaryActionBtn?.addEventListener('click', () => this.playPrimaryEpisode());
        this.playStartBtn?.addEventListener('click', () => this.playPrimaryEpisode({ fromStart: true }));
        this.detailFavoriteBtn?.addEventListener('click', async (e) => {
            e.preventDefault();
            if (!this.currentSeriesGroup) return;
            await this.toggleFavorite(this.currentSeriesGroup, this.detailFavoriteBtn);
            this.syncDetailFavoriteButton();
        });
        document.getElementById('series-thumb-up')?.addEventListener('click', () => this.setRating(1));
        document.getElementById('series-thumb-down')?.addEventListener('click', () => this.setRating(-1));

        // The catalogue panel is only a lightweight preview. Moving focus across
        // posters never fetches seriesInfo, seasons, episodes or recommendations.
        this.container?.addEventListener('focusin', (event) => {
            if (!this._isTvMode() || this.pageEl?.classList.contains('series-detail-open')) return;
            const card = event.target.closest?.('.series-card');
            if (card?.isConnected) this.previewCard(card);
        });

        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this.isLoading) {
                this.renderNextBatch();
            }
        }, { rootMargin: '200px' });

        // Continue Watching shrinks to a compact pinned strip while the grid scrolls,
        // reclaiming vertical space without disappearing.
        this.container?.addEventListener('scroll', () => {
            this.updateContinueCompact();
            this.restoreRecycledCards();
        }, { passive: true });

        const favBtn = document.getElementById('series-favorites-btn');
        favBtn?.addEventListener('click', () => {
            this.showFavoritesOnly = !this.showFavoritesOnly;
            favBtn.classList.toggle('active', this.showFavoritesOnly);
            this.onFiltersChanged();
        });

        if (this._isTvMode()) this._setupTvSeriesLayout();

        this.applyFiltersToUI();
    }

    // === Filter persistence ===

    restoreFilters() {
        const saved = MediaUtils.loadFilters('series') || {};
        this.savedFilters = saved;
        this.groupDuplicates = saved.group !== undefined ? saved.group : true;
        this.showFavoritesOnly = !!saved.favoritesOnly;
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
            favoritesOnly: this.showFavoritesOnly,
            categories: [...(this.categoryMulti?.getSelected() || [])]
        });
    }

    onFiltersChanged() {
        this.persistFilters();
        this.renderActiveFilterChips();
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
            // A chip/reset can clear the bucket without pressing its dedicated Back
            // button. Drop the stale identity so selecting the same genre later
            // cannot be mistaken for an already-open view.
            if (this.activeBucket) {
                this.activeBucket = null;
                this.activeBucketLangKey = null;
                this.bucketRequestId = (this.bucketRequestId || 0) + 1;
                this.bucketObserver?.disconnect();
            }
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
        const langKey = this.currentBucketViewKey();
        if (this.activeBucket === 'all' && this.activeBucketLangKey === langKey) return;
        this.openBucket({ id: 'genre-all', title: 'All series', curation: { bucket: 'all' } });
    }

    // Audio-language / burned-in-subtitle / year / rating filter params + "best
    // for my languages" sort, forwarded to the server genre-items endpoint (the
    // bucket grids). Empty keys are omitted. Also the bucket views' re-render
    // key, so changing ANY of these refreshes an open genre grid.
    currentLanguageParams() {
        const params = {};
        const tv = this._isTvMode();
        if (tv && this.sourceSelect?.value) params.sourceId = this.sourceSelect.value;
        if (this.audioSelect?.value) params.audio = this.audioSelect.value;
        if (this.subtitleSelect?.value) params.subs = this.subtitleSelect.value;
        if (this.yearSelect?.value) params.year = this.yearSelect.value;
        if (this.ratingSelect?.value) params.minRating = this.ratingSelect.value;
        if (tv && this.addedSelect?.value) params.addedDays = this.addedSelect.value;
        const sort = this.sortSelect?.value || '';
        if (tv && sort && sort !== 'default') params.sort = sort;
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

    // The request params are only half of a bucket's identity: Favorites and
    // grouping are evaluated against the returned variants on TV. Include them
    // in the refresh key so changing one cannot be mistaken for an
    // already-rendered bucket.
    currentBucketViewKey() {
        if (!this._isTvMode()) return JSON.stringify(this.currentLanguageParams());
        return JSON.stringify({
            ...this.currentLanguageParams(),
            watched: this.watchedSelect?.value || '',
            status: this.statusSelect?.value || '',
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
        const langKey = this.currentBucketViewKey();
        if (this.activeBucket === bucket && this.activeBucketLangKey === langKey) return;
        const T = window.GenreTaxonomy;
        const label = (T && T.label) ? T.label(bucket) : bucket;
        this.openBucket({ id: `genre-${bucket}`, title: label, curation: { bucket } });
    }

    // Netflix-style default: with no active filter/search, the cloud Series page
    // shows curated genre rails instead of a flat grid. Any filter or search
    // flips back to the grid via the normal path.
    shouldShowRails() {
        // TV follows the supplied flat-grid mockup. Web/mobile retain the curated
        // genre rails exactly as before.
        return !this._isTvMode() && this.isCloudPagedMode() &&
            !!window.GenreRails && !this.hasActiveFilters();
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
            // Stamp the warm view only AFTER a successful rails render: stamping
            // up-front left the marker set when the fallback path errored without
            // reaching filterAndRender, freezing an empty/error view on back-nav.
            this._viewRenderedAt = Date.now();
        } catch (err) {
            console.warn('[Series] Genre rails unavailable, falling back to grid:', err);
            this.railsView = false;
            return this.loadSeries();
        }
    }

    // Reuse the Home page's rail→detail path (builds the version group and opens
    // the series detail on this page), so clicks behave exactly like Home rails.
    async openRailItem(item) {
        if (this._isTvMode()) {
            const replacingOpenFiche = this.pageEl?.classList.contains('series-detail-open');
            const opened = await this.openByItem(item);
            // A recommendation swaps the contents of an already-visible fiche, so the
            // detail-panel MutationObserver does not see a new open transition. The
            // recommendation card is removed during that swap; explicitly re-anchor the
            // D-pad on the new fiche's primary action instead of leaving focus on <body>.
            if (opened && replacingOpenFiche) {
                requestAnimationFrame(() => {
                    const target = (!this.primaryActionBtn?.disabled && this.primaryActionBtn)
                        || this.detailsPanel?.querySelector('.series-back-btn, .series-secondary-action, button:not([disabled])');
                    if (!target?.isConnected) return;
                    target.focus({ preventScroll: true });
                    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                });
            }
            return;
        }
        const home = this.app?.pages?.home;
        if (home?.navigateToSeries) home.navigateToSeries(item);
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
        this.bucketRenderedCount = 0;
        this.bucketRequestId = (this.bucketRequestId || 0) + 1;
        this.bucketObserver?.disconnect();
        if (this._isTvMode()) this._clearTvPreview();

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
            const payload = await API.media.genreItems({ type: 'series', bucket: this.activeBucket, limit: 36, offset: this.bucketOffset, ...this.currentLanguageParams() });
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
            if (this._isTvMode()) {
                const groups = fresh.flatMap(item => this._tvBucketGroups(item));
                this.sortCards(groups);
                const fragment = document.createDocumentFragment();
                groups.forEach(group => fragment.appendChild(this.buildCard(group)));
                this.bucketGridEl.appendChild(fragment);
                this.bucketRenderedCount = (this.bucketRenderedCount || 0) + groups.length;
                if (!this.container.querySelector('.series-card.tv-preview-active')) {
                    this._previewFirstCard();
                }
            } else {
                window.GenreRails.appendCards(this.bucketGridEl, fresh, {
                    startIndex: this.bucketOffset,
                    onItemClick: (item) => this.openRailItem(item)
                });
            }
            this.bucketOffset += items.length;
            this.bucketHasMore = Boolean(payload && payload.hasMore) && items.length > 0;
            // The endpoint returns the exact filtered count — show it (the grid view
            // otherwise leaves the header count blank).
            if (this.countEl && typeof payload?.count === 'number') {
                this.countEl.textContent = this._isTvMode()
                    ? `${this.bucketRenderedCount || 0}${this.bucketHasMore ? '+' : ''} titles`
                    : `${payload.count} titles`;
            }
            // A source/favorites filter can remove a whole server page.
            // Keep paging while the loader is still empty instead of requiring a
            // scroll event that can never occur without any rendered cards.
            if (this._isTvMode() && !this.bucketGridEl.childElementCount && this.bucketHasMore) {
                setTimeout(() => this.loadBucketPage(), 0);
            }
        } catch (err) {
            console.warn('[Series] Genre bucket page failed:', err);
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
        if (this.categoryMulti?.getSelected().size) this.categoryMulti.setSelected([]);
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

    // Local-mode genre rails: group already-loaded series by curated bucket and
    // render them with the page's own cards (so clicks open details normally).
    renderGenreRailsLocal() {
        const T = window.GenreTaxonomy;
        if (!T || !window.GenreRails || !Array.isArray(this.seriesList) || !this.seriesList.length) return false;

        const byBucket = new Map();
        for (const s of this.seriesList) {
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
            this.searchInput?.value || this.showFavoritesOnly ||
            (this.categoryMulti?.getSelected().size > 0)
        );
    }

    // Active-filter chips: a removable summary of what's narrowing the grid, mirroring
    // Movies. Labels read straight from the live controls so they never drift; each chip
    // clears just its filter and re-applies.
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
            clear: () => this.categoryMulti?.setSelected([]) });

        if (this.sortSelect?.value && this.sortSelect.value !== 'default')
            chips.push({ label: optText(this.sortSelect), clear: () => { this.sortSelect.value = 'default'; } });
        if (this.genreSelect?.value) chips.push({ label: optText(this.genreSelect), clear: () => { this.genreSelect.value = ''; } });
        if (this.yearSelect?.value) chips.push({ label: optText(this.yearSelect), clear: () => { this.yearSelect.value = ''; } });
        if (this.ratingSelect?.value) chips.push({ label: optText(this.ratingSelect), clear: () => { this.ratingSelect.value = ''; } });
        if (this.watchedSelect?.value) chips.push({ label: optText(this.watchedSelect), clear: () => { this.watchedSelect.value = ''; } });
        if (this.addedSelect?.value) chips.push({ label: optText(this.addedSelect), clear: () => { this.addedSelect.value = ''; } });
        if (this.statusSelect?.value) chips.push({ label: optText(this.statusSelect), clear: () => { this.statusSelect.value = ''; } });
        if (this.audioSelect?.value) chips.push({ label: `Audio: ${optText(this.audioSelect)}`, clear: () => { this.audioSelect.value = ''; } });
        if (this.subtitleSelect?.value) chips.push({ label: `Subtitles: ${optText(this.subtitleSelect)}`, clear: () => { this.subtitleSelect.value = ''; } });
        if (this.showFavoritesOnly) chips.push({ label: 'Favorites', clear: () => {
            this.showFavoritesOnly = false;
            document.getElementById('series-favorites-btn')?.classList.remove('active');
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

    // Foreground SWR (called when the app returns to the foreground while Series is the
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
        if (atTop && this.seriesList.length && this.catalogCacheKey()) {
            this.loadCloudSeries({ reset: true });
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
            if (this.seriesList && this.seriesList.length) return;                // real data already in memory
            if (this._viewRenderedAt && Date.now() - this._viewRenderedAt < 300000) return; // warm in-session return
            const s = this.app?.sourceSummary;
            if (s && this.app?.isCatalogReady && !this.app.isCatalogReady(s)) return; // last known state was gating
            if (typeof this.shouldShowRails === 'function' && this.shouldShowRails()) return; // rails owns the grid
            const ck = this.catalogCacheKey();
            if (!ck) return;
            const cached = window.NorvaCatalogCache?.read?.(ck); // time-only; loadCloudSeries re-reads WITH the version
            if (!cached?.data?.items?.length) return;
            this.seriesList = cached.data.items.slice();
            this.cloudHasMore = Boolean(cached.data.hasMore);
            this.cloudTotal = cached.data.count ?? null;
            this._coldPaintPending = true;   // force show() to still revalidate despite seriesList.length > 0
            this.populateGenres();
            this.filterAndRender();
            this._viewRenderedAt = 0;         // keep show()'s warm-view guard from short-circuiting the revalidate
        } catch (_) { /* best-effort instant paint */ }
    }

    async show() {
        document.documentElement.classList.toggle('tv-series-active', this._isTvMode());
        if (this._isTvMode()) this._setupTvSeriesLayout();
        this.hideDetails();

        this._coldPaintFromCache();
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
                this.openGenreBucket(selectedBuckets[0]);
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

        if (this.seriesList.length === 0 || this._coldPaintPending) {
            // Categories only feed the filter dropdown — load them alongside the
            // series page instead of gating the grid's first paint on them. The
            // _coldPaintPending clause forces a revalidate even though the cold paint
            // above left seriesList.length > 0, so the cached first screen is refreshed.
            this._coldPaintPending = false;
            await Promise.all([this.loadCategories(), this.loadSeries()]);
        } else {
            this.filterAndRender();
        }
    }

    hide() {
        document.documentElement.classList.remove('tv-series-active');
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
    // user should never have to leave the page and come back to see their series
    // appear. Self-cleans the moment content renders (filterAndRender) or the page
    // is hidden. Armed only while an empty state is on screen.
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
        // Safety net for partial availability (series can fill before the whole
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
            // Server-side over the denormalized columns, so the filter spans the
            // WHOLE catalogue instead of the loaded pages only.
            year: this.yearSelect?.value || '',
            minRating: this.ratingSelect?.value || '',
            addedDays: this.addedSelect?.value || '',
            limit: this.cloudPageSize,
            offset
        };
    }

    catalogCacheKey() {
        // Only the DEFAULT first screen is cached (see MoviesPage for rationale).
        const p = this.cloudPageParams(0);
        if (p.sourceId || p.categoryId || p.q || (p.sort && p.sort !== 'default') ||
            p.year || p.minRating || p.addedDays) return null;
        // Lang-scoped (see MoviesPage): the persisted first screen carries localized text.
        return 'series:default:' + (window.NorvaCloud?.contentLanguage?.() || 'en');
    }

    async loadCloudSeries({ reset = false } = {}) {
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
            this.seriesList = [];
            this.filteredCards = [];
            this.currentBatch = 0;
            // Stale-while-revalidate: paint the cached first page instantly, then
            // refresh from the network below and replace it.
            const cacheKey = this.catalogCacheKey();
            const cached = cacheKey && window.NorvaCatalogCache?.read?.(cacheKey, { version: window.API?.catalogSignature?.() });
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
            const renderedBefore = reset ? 0 : this.container.querySelectorAll('.series-card').length;
            // On reset always refetch page 1 (offset 0), even after a cache paint.
            const page = await API.media.page(this.cloudPageParams(reset ? 0 : this.cloudOffset));
            if (!reset && this._isTvMode() && this._tvPendingCloudReset) return;
            if (reset && (
                requestId !== this.cloudRequestId ||
                (this._isTvMode() && this._tvPendingCloudReset)
            )) return;
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

            // The grid is paginated by title server-side (each ships all its version
            // rows), so advance the cursor by the title count, not the row count.
            this.cloudOffset = (page.offset || this.cloudOffset) + (page.films ?? page.items?.length ?? 0);
            this.cloudHasMore = Boolean(page.hasMore);
            this.cloudTotal = page.count ?? this.cloudTotal;
            this.populateGenres();

            if (reset) {
                this.filterAndRender();
                try {
                    const ck = this.catalogCacheKey();
                    // Only cache a NON-EMPTY page. Caching an empty result (e.g. the enrichment
                    // queries timed out under import load) poisons the cold-entry paint: the next
                    // visit paints the stale empty "No series here yet" and, if the network refresh
                    // also fails, it never gets replaced. A miss instead shows the skeleton → retry.
                    if (ck && this.seriesList.length) window.NorvaCatalogCache?.write?.(ck, {
                        items: this.seriesList.slice(0, this.cloudPageSize),
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
            console.error('Error loading cloud series:', err);
            if (reset && this._isTvMode() && (
                requestId !== this.cloudRequestId || this._tvPendingCloudReset
            )) return;
            if (reset && !paintedFromCache) {
                this.container.innerHTML = '<div class="empty-state"><p>Error loading series</p></div>';
            }
        } finally {
            if (reset && (!this._isTvMode() || requestId === this.cloudRequestId)) {
                this.isLoading = false;
            }
            if (!reset) this.cloudLoadingMore = false;
            if (this._isTvMode() && this._tvPendingCloudReset && !this.cloudLoadingMore) {
                this._tvPendingCloudReset = false;
                Promise.resolve().then(() => this.loadCloudSeries({ reset: true }));
            }
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

        const minRating = cloud ? NaN : parseFloat(this.ratingSelect?.value);
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

        const addedDays = cloud ? NaN : parseInt(this.addedSelect?.value);
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
            if (this._isTvMode()) {
                items = items.filter(s => {
                    const rawName = s.name || '';
                    const rawTitle = s.tmdb?.title || s.tmdb?.name || '';
                    let cached = this._tvSearchTextCache.get(s);
                    if (!cached || cached.rawName !== rawName || cached.rawTitle !== rawTitle) {
                        cached = {
                            rawName,
                            rawTitle,
                            name: MediaUtils.searchableText(rawName),
                            title: rawTitle ? MediaUtils.searchableText(rawTitle) : ''
                        };
                        this._tvSearchTextCache.set(s, cached);
                    }
                    return cached.name.includes(searchTerm) || cached.title.includes(searchTerm);
                });
            } else {
                items = items.filter(s =>
                    MediaUtils.searchableText(s.name).includes(searchTerm) ||
                    ((s.tmdb?.title || s.tmdb?.name) &&
                        MediaUtils.searchableText(s.tmdb?.title || s.tmdb?.name).includes(searchTerm)));
            }
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

    // Filters the SERVER cannot see (they run over the loaded pages only), so the
    // server's exact count can't be shown while any of them is active.
    hasClientOnlyFilters() {
        return Boolean(
            this.genreSelect?.value || this.statusSelect?.value ||
            this.watchedSelect?.value || this.showFavoritesOnly
        );
    }

    updateResultChrome(cards) {
        if (this.countEl) {
            let total = this.groupDuplicates ? `${cards.length} titles` : `${cards.length} series`;
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
        this.resetBtn?.classList.toggle('hidden', !this.hasActiveFilters());
        this.renderActiveFilterChips();
    }

    filterAndRender() {
        // Any real render supersedes a pending empty-state auto-refresh watch;
        // re-armed below only if this render lands on an empty (non-filtered) grid.
        this._disarmCatalogRefreshWatch();
        // Local (self-hosted) mode default with no active filter → genre rails,
        // built client-side. Cloud mode is untouched (server rails).
        if (!this._isTvMode() && !this.isCloudPagedMode() &&
            !this.hasActiveFilters() && this.renderGenreRailsLocal()) {
            return;
        }

        const cards = this.buildFilteredCards();
        this.filteredCards = cards;

        this.updateResultChrome(cards);

        console.log(`[Series] Displaying ${cards.length} cards from ${this.seriesList.length} series`);

        this.currentBatch = 0;
        this._winStart = 0; // virtualization: index of the first card still in the DOM
        if (this._isTvMode()) this.observer?.disconnect();
        // Flat card grid → drop the rail-host modifier so the grid centers/wraps.
        this.container.classList.remove('rail-host');
        this.container.innerHTML = '';
        // Only a populated grid counts as a "warm view" (parity with MoviesPage —
        // same bug, fixed there in 9a55879): an empty render (zero cards, e.g. a
        // transient empty catalogue fetch) must stay UN-stamped, or show()'s warm
        // early-return (childElementCount sees the empty-state div as content)
        // freezes "No series here yet · 0 titles" for 5 minutes on back-nav from
        // playback. Un-stamped, the next entry reloads instead.
        this._viewRenderedAt = cards.length ? Date.now() : 0;
        // Re-rendering resets scrollTop to 0 without firing a scroll event, so
        // re-sync the compact strip to avoid it sticking shrunk at the top.
        this.updateContinueCompact();

        // No results → disable "Random" so it isn't a silent no-op.
        if (this.randomBtn) this.randomBtn.disabled = cards.length === 0;

        if (cards.length === 0) {
            if (this._isTvMode()) this._clearTvPreview();
            const filtered = this.hasActiveFilters();
            this.container.innerHTML = `
                <div class="empty-state rich-empty">
                    <div class="empty-icon">📺</div>
                    <h3>${filtered ? 'No series match these filters' : 'No series here yet'}</h3>
                    <p>${filtered ? 'Try widening your search, genre or language filters.' : 'Series appear as soon as Norva finishes preparing your catalog.'}</p>
                    ${filtered ? '<button class="btn btn-primary" id="series-empty-reset">Clear filters</button>' : ''}
                </div>`;
            this.container.querySelector('#series-empty-reset')?.addEventListener('click', () => this.resetFilters?.());
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
        loader.className = 'series-loader';
        loader.innerHTML = '<div class="loading-spinner"></div>';
        this.container.appendChild(loader);

        const initialBatches = this._isTvMode() ? 1 : 5;
        for (let i = 0; i < initialBatches; i++) {
            this.renderNextBatch();
        }

        this.observer.observe(loader);
        if (this._isTvMode()) this._previewFirstCard();
    }

    // === Grid virtualization (same window/recycle scheme as MoviesPage) ===

    static get GRID_DOM_CARD_CAP() { return 360; }

    recycleOffscreenCards() {
        const spacer = this.container?.querySelector('.grid-spacer');
        if (!spacer) return;
        let rendered = this.currentBatch * this.batchSize - (this._winStart || 0);
        while (rendered > SeriesPage.GRID_DOM_CARD_CAP) {
            const before = this.container.scrollHeight;
            let removed = 0;
            let node = spacer.nextElementSibling;
            while (node && removed < this.batchSize && node.classList.contains('series-card')) {
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
        this.recycleOffscreenCards();

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
        card.__seriesGroup = group;

        const poster = MediaUtils.safeImageUrl(
            series.cover || series.stream_icon || MediaUtils.tmdbPosterUrl(series.tmdb),
            '/img/norva-media-placeholder.png'
        );
        const year = this.getItemYear(series) || '';
        const rating = series.rating ? `${Icons.star} ${series.rating}` : '';
        const isFav = group.items.some(i => this.favoriteIds.has(`${i.sourceId}:${i.series_id}`));
        const started = this.isGroupStarted(group.items);
        const versionCount = group.items.length;
        const displayName = (this.groupDuplicates && series.tmdb?.title) ? series.tmdb.title : MediaUtils.cleanReleaseName(series.name);
        const groupBroken = group.items.every(item => this.isBrokenItem(item));
        const languageBadge = MediaUtils.versionLanguageBadge(series, this.getPreferences());
        // "New" corner badge for series added in the last two weeks (not started).
        const isNew = !started && group.items.some(i => MediaUtils.isRecentlyAdded(i));

        const srcset = MediaUtils.tmdbSrcset(poster);
        card.innerHTML = `
            <div class="series-poster">
                ${isNew ? '<span class="new-badge">NEW</span>' : ''}
                <img src="${MediaUtils.escapeHtml(poster)}" alt="${MediaUtils.escapeHtml(displayName)}"
                     ${srcset ? `srcset="${MediaUtils.escapeHtml(srcset)}" sizes="(max-width: 640px) 45vw, 190px"` : ''}
                     onerror="this.onerror=null;this.srcset='';this.src='/img/norva-media-placeholder.png'" loading="lazy" decoding="async">
                <div class="series-play-overlay">
                    <span class="play-icon">${Icons.play}</span>
                </div>
                ${groupBroken ? '<span class="playback-badge" title="Unavailable — failed the health scan">⚠</span>' : ''}
                ${versionCount > 1 ? `<button class="version-badge" title="Choose version">${versionCount} versions</button>` : ''}
                ${languageBadge ? `<span class="version-language-badge ${versionCount > 1 ? 'with-version-badge' : ''}">${MediaUtils.escapeHtml(languageBadge)}</span>` : ''}
                ${started ? '<span class="watched-badge inprogress-badge" title="Watching">▶</span>' : ''}
                <button class="favorite-btn ${isFav ? 'active' : ''}" aria-label="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
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

        if (this._isTvMode()) {
            card.tabIndex = 0;
            card.setAttribute('role', 'button');
            card.setAttribute('aria-label', `View ${displayName || 'series'} details`);
            card.querySelectorAll('.favorite-btn, .version-badge').forEach(button => {
                button.tabIndex = -1;
            });
        }

        card.addEventListener('click', (e) => {
            if (e.target.closest('.favorite-btn')) {
                e.stopPropagation();
                this.toggleFavorite(group, e.target.closest('.favorite-btn'));
            } else if (e.target.closest('.version-badge')) {
                e.stopPropagation();
                if (this._isTvMode()) this._openTvSeriesDetails(group, { focusVersions: true, originCard: card });
                else this.openGroup(group, { focusVersions: true });
            } else {
                if (this._isTvMode()) this._openTvSeriesDetails(group, { originCard: card });
                else this.openGroup(group);
            }
        });

        // Hover preview (desktop): bigger art + instant Play (featured episode) / Details.
        card.__norvaHover = () => ({
            title: displayName,
            meta: [year, series.tmdb?.number_of_seasons ? `${series.tmdb.number_of_seasons} seasons` : '',
                series.rating ? `★ ${series.rating}` : ''].filter(Boolean).join(' · '),
            poster,
            backdrop: MediaUtils.safeImageUrl(this.getSeriesBackdrop(series), '') || null,
            onPlay: () => {
                this.openGroup(group);
                let tries = 0;
                const tick = () => {
                    const btn = document.querySelector('#series-details:not(.hidden) #series-primary-action');
                    if (btn && !btn.disabled) { btn.click(); return; }
                    if (++tries < 16) setTimeout(tick, 250);
                };
                setTimeout(tick, 200);
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
                     onerror="this.onerror=null;this.srcset='';this.src='/img/norva-media-placeholder.png'" loading="lazy" decoding="async" alt="">
                <div class="continue-card-info">
                    <p class="continue-card-title">${MediaUtils.escapeHtml(h.data?.title || 'Unknown')}</p>
                    <p class="continue-card-subtitle">${MediaUtils.escapeHtml(h.data?.subtitle || '')}</p>
                    <div class="card-progress"><div class="card-progress-fill" style="width:${ratio}%"></div></div>
                </div>
            </div>`;
        }).join('');

        this.continueList.querySelectorAll('.continue-card').forEach(card => {
            if (this._isTvMode()) {
                card.tabIndex = 0;
                card.setAttribute('role', 'button');
                const title = card.querySelector('.continue-card-title')?.textContent || 'series';
                card.setAttribute('aria-label', `Resume ${title}`);
            }
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

    _isTvMode() {
        return document.documentElement.classList.contains('tv-mode');
    }

    // Android TV catalogue shell. Existing live controls are moved, never cloned,
    // so their listeners and values stay intact. The real #series-details fiche
    // remains inside .series-content and is only shown after the preview CTA.
    _setupTvSeriesLayout() {
        const page = this.pageEl;
        const header = page?.querySelector('.series-header');
        const controls = header?.querySelector('.series-controls');
        const legacyFilterBar = document.getElementById('series-filter-bar');
        const content = page?.querySelector('.series-content');
        if (!page || !header || !controls || !legacyFilterBar || !content || !this.container) return;

        page.classList.remove('series-detail-open');
        this.container.classList.remove('hidden');
        if (page.classList.contains('tv-series-layout-ready')) return;

        const primary = document.createElement('div');
        primary.id = 'series-tv-primary-filters';
        primary.className = 'tv-series-filter-row tv-series-primary-filters';
        primary.setAttribute('aria-label', 'Series filters');
        primary.dataset.tvNavRegion = 'series-filters';

        const secondary = document.createElement('div');
        secondary.id = 'series-tv-secondary-filters';
        secondary.className = 'tv-series-filter-row tv-series-secondary-filters';
        secondary.setAttribute('aria-label', 'Availability and view options');
        secondary.dataset.tvNavRegion = 'series-filters';

        const catalogHead = document.createElement('div');
        catalogHead.id = 'series-tv-catalog-head';
        catalogHead.className = 'tv-series-catalog-head';
        catalogHead.dataset.tvNavRegion = 'series-filters';
        const catalogMeta = document.createElement('div');
        catalogMeta.className = 'tv-series-catalog-meta';
        const catalogTitle = document.createElement('h3');
        catalogTitle.className = 'tv-series-catalog-title';
        catalogTitle.textContent = 'All Series';
        catalogMeta.appendChild(catalogTitle);
        catalogHead.appendChild(catalogMeta);

        const preview = document.createElement('aside');
        preview.id = 'series-tv-preview';
        preview.className = 'tv-series-preview is-empty';
        preview.dataset.tvSplitPreview = 'true';
        preview.setAttribute('aria-label', 'Selected series preview');
        preview.setAttribute('aria-live', 'polite');

        const categoryControl = document.getElementById('series-category-btn')?.closest('.multi-select');
        const searchWrapper = this.searchInput?.closest('.search-wrapper');
        const favoriteBtn = document.getElementById('series-favorites-btn');
        const append = (host, element) => { if (host && element) host.appendChild(element); };

        append(controls, searchWrapper);
        [this.sourceSelect, categoryControl, this.yearSelect, this.ratingSelect,
         this.audioSelect, this.subtitleSelect].forEach(element => append(primary, element));
        [this.watchedSelect, this.addedSelect, favoriteBtn,
         this.groupToggleBtn, this.resetBtn].forEach(element => append(secondary, element));
        append(catalogMeta, this.countEl);
        append(catalogHead, this.activeFiltersEl);
        append(catalogHead, this.sortSelect);
        this.activeFiltersEl?.removeAttribute('data-tv-nav-region');

        // Anything left in the legacy bar is intentionally absent from the TV mockup.
        legacyFilterBar.querySelectorAll('button, input, select, textarea, [tabindex]').forEach(element => {
            element.tabIndex = -1;
        });

        preview.addEventListener('click', async (event) => {
            const open = event.target.closest('#series-tv-preview-open');
            if (open && this._tvPreviewGroup) {
                this._openTvSeriesDetails(this._tvPreviewGroup, { originCard: this._tvPreviewCard });
                return;
            }
            const favorite = event.target.closest('#series-tv-preview-favorite');
            if (favorite && this._tvPreviewGroup) {
                await this.toggleFavorite(this._tvPreviewGroup, favorite);
                const active = this._tvPreviewGroup.items.some(item =>
                    this.favoriteIds.has(`${item.sourceId}:${item.series_id}`));
                favorite.classList.toggle('active', active);
                favorite.setAttribute('aria-pressed', String(active));
                const label = favorite.querySelector('.tv-series-preview-favorite-label');
                if (label) label.textContent = active ? 'Remove from Favorites' : 'Add to Favorites';
                if (this.showFavoritesOnly && !active) {
                    this.activeBucketLangKey = null;
                    this.onFiltersChanged();
                }
            }
        });

        page.insertBefore(primary, content);
        page.insertBefore(secondary, content);
        page.insertBefore(catalogHead, content);
        page.appendChild(preview);
        page.classList.add('tv-series-layout-ready');
        this._clearTvPreview();
    }

    // genreItems() returns a logical title carrying normalized provider variants.
    // Convert it to the same { representative, items } shape as the flat catalogue.
    _groupFromCloudTitle(title) {
        const rawVariants = Array.isArray(title?.variants) && title.variants.length
            ? title.variants
            : (Array.isArray(title?.exposedVariants) && title.exposedVariants.length
                ? title.exposedVariants
                : [title?.defaultVariant || title?.default_variant || title]);
        const items = rawVariants.filter(Boolean).map((variant) => ({
            ...variant,
            sourceId: variant.sourceId ?? variant.source_id ?? title?.sourceId ?? title?.source_id,
            series_id: variant.series_id ?? variant.seriesId ?? variant.item_id ?? variant.itemId ?? variant.id,
            name: variant.name || variant.title || title?.name || title?.title || 'Series',
            cover: variant.cover || variant.stream_icon || variant.poster_url || title?.cover || title?.poster_url,
            stream_icon: variant.stream_icon || variant.cover || variant.poster_url || title?.stream_icon || title?.cover,
            tmdb: variant.tmdb || title?.tmdb,
            rating: variant.rating || title?.rating,
            year: variant.year || title?.year,
            category_name: variant.category_name || title?.category_name,
            category_id: variant.category_id ?? title?.category_id,
            added: variant.added || title?.added,
            added_at: variant.added_at || title?.added_at,
            last_modified: variant.last_modified || title?.last_modified,
            playback_status: variant.playback_status || title?.playback_status,
            provider_tmdb_id: variant.provider_tmdb_id || variant.providerTmdbId ||
                title?.provider_tmdb_id || title?.providerTmdbId
        })).filter(item => item.series_id != null && item.sourceId != null);
        const fallback = items[0] || title;
        const preferredRaw = title?.defaultVariant || title?.default_variant;
        const representative = items.find(item => preferredRaw &&
            String(item.series_id) === String(preferredRaw.series_id ?? preferredRaw.item_id ?? preferredRaw.id) &&
            String(item.sourceId) === String(preferredRaw.sourceId ?? preferredRaw.source_id ?? item.sourceId)) || fallback;
        return {
            key: String(title?.title_id || title?.titleId || title?.id || `${representative?.sourceId}:${representative?.series_id}`),
            items: items.length ? items : [fallback],
            representative
        };
    }

    // genreItems() returns logical titles, while several TV controls are local to
    // the loaded user state (favorites, watch progress, playback health). Normalize
    // each title to the standard group shape, apply those controls to its variants,
    // and only then build the TV cards. Web/mobile keep their existing GenreRails
    // path untouched.
    _tvBucketGroups(title) {
        const rawGroup = this._groupFromCloudTitle(title);
        const sourceId = this.sourceSelect?.value || '';
        const addedDays = parseInt(this.addedSelect?.value, 10);
        let items = (rawGroup.items || []).filter((item) => {
            if (sourceId && String(item.sourceId) !== String(sourceId)) return false;
            if (this.hiddenCategoryIds?.has(`${item.sourceId}:${item.category_id}`)) return false;
            if (!this.matchesFilters(item)) return false;
            if (addedDays) {
                const addedMs = this.parseAddedMs(item);
                if (!addedMs || (Date.now() - addedMs) > addedDays * 86400000) return false;
            }
            return true;
        });
        if (!items.length) return [];

        const representative = items.find(item => this.isSameSeriesVersion(item, rawGroup.representative)) || items[0];
        let groups = this.groupDuplicates
            ? [{ ...rawGroup, items, representative }]
            : items.map(item => ({
                key: `${rawGroup.key}:${item.sourceId}:${item.series_id}`,
                items: [item],
                representative: item
            }));

        groups = this.applyLanguagePreferencesToCards(groups);
        if (this.getPreferences().strictLanguageMatching) {
            groups = groups.filter(group => !this.isStrictLanguageExcluded(group));
        }
        if (this.showFavoritesOnly) {
            groups = groups.filter(group => group.items.some(item =>
                this.favoriteIds.has(`${item.sourceId}:${item.series_id}`)));
        }
        const watched = this.watchedSelect?.value || '';
        if (watched === 'inprogress') {
            groups = groups.filter(group => this.isGroupStarted(group.items));
        } else if (watched === 'unwatched') {
            groups = groups.filter(group => !this.isGroupStarted(group.items));
        }
        return groups;
    }

    _tvPreviewProgress(group) {
        const keys = new Set((group?.items || []).map(item => `${item.sourceId}:${item.series_id}`));
        return (this.historyItems || []).find((history) => {
            if (history.item_type !== 'episode' || !history.data?.seriesId) return false;
            const sourceId = history.data?.sourceId ?? history.source_id;
            return keys.has(`${sourceId}:${history.data.seriesId}`) &&
                this.getResumeOffset(history.progress, history.duration) > 0;
        }) || null;
    }

    _clearTvPreview() {
        const preview = document.getElementById('series-tv-preview');
        if (!preview) return;
        this._tvPreviewCard = null;
        this._tvPreviewGroup = null;
        preview.classList.add('is-empty');
        preview.innerHTML = `
            <div class="tv-series-preview-empty">
                <strong>Select a series</strong>
                <span>Move through the catalogue to see its details.</span>
            </div>`;
    }

    previewCard(card) {
        if (!this._isTvMode() || this.pageEl?.classList.contains('series-detail-open')) return;
        const group = card?.__seriesGroup;
        if (!group?.items?.length) return;
        this.container?.querySelectorAll('.series-card.tv-preview-active').forEach(active => {
            if (active !== card) active.classList.remove('tv-preview-active');
        });
        card.classList.add('tv-preview-active');
        this._tvPreviewCard = card;
        this._tvPreviewGroup = group;
        this._paintTvSeriesPreview(group);
    }

    _previewFirstCard() {
        const first = this.container?.querySelector('.series-card');
        if (first) this.previewCard(first);
        else this._clearTvPreview();
    }

    _paintTvSeriesPreview(group) {
        const preview = document.getElementById('series-tv-preview');
        if (!preview || !group?.items?.length) return;
        preview.scrollTop = 0;
        const ordered = MediaUtils.orderVersionsByPreference(group.items, this.getPreferences());
        const selected = this.getRememberedVersion(group) || ordered[0] || group.representative;
        const display = group.representative || selected;
        const title = this.getSeriesDisplayTitle(display);
        const art = this.getSeriesBackdrop(display) || this.getSeriesPoster(display);
        const plot = display?.tmdb?.overview || display?.overview || display?.description ||
            display?.plot || 'No summary available yet.';
        const rating = parseFloat(display?.rating || display?.tmdb?.vote_average);
        const version = MediaUtils.parseVersionInfo(selected?.name || '');
        const meta = [
            this.getSeriesYear(display),
            display?.tmdb?.number_of_seasons ? `${display.tmdb.number_of_seasons} seasons` : '',
            ...this.getSeriesGenres(display).slice(0, 2),
            Number.isFinite(rating) && rating > 0 ? `★ ${rating.toFixed(1).replace('.0', '')}` : '',
            version.quality,
            MediaUtils.versionLanguageBadge(selected, this.getPreferences())
        ].filter(Boolean);
        const history = this._tvPreviewProgress(group);
        const ratio = history?.duration > 0
            ? Math.max(0, Math.min(100, Math.round((history.progress / history.duration) * 100)))
            : 0;
        const minsLeft = history?.duration > history?.progress
            ? Math.max(1, Math.round((history.duration - history.progress) / 60))
            : 0;
        const progressLabel = history
            ? [history.data?.currentSeason ? `S${history.data.currentSeason}` : '',
               history.data?.currentEpisode ? `E${history.data.currentEpisode}` : ''].filter(Boolean).join(' ') +
              (minsLeft ? ` · ${minsLeft} min left` : '')
            : '';
        const sources = [...new Set(group.items.map(item => this.getSourceName(item.sourceId)).filter(Boolean))];
        const isFav = group.items.some(item => this.favoriteIds.has(`${item.sourceId}:${item.series_id}`));

        preview.classList.remove('is-empty');
        preview.innerHTML = `
            <div class="tv-series-preview-art">
                <img src="${MediaUtils.escapeHtml(art)}" alt="${MediaUtils.escapeHtml(title)}"
                     onerror="this.onerror=null;this.srcset='';this.src='/img/norva-media-placeholder.png'">
            </div>
            <div class="tv-series-preview-body">
                <h3>${MediaUtils.escapeHtml(title)}</h3>
                <div class="tv-series-preview-meta">${meta.map(part => `<span>${MediaUtils.escapeHtml(part)}</span>`).join('')}</div>
                <p>${MediaUtils.escapeHtml(plot)}</p>
                ${history ? `
                    <div class="tv-series-preview-progress-copy">${MediaUtils.escapeHtml(progressLabel)}</div>
                    <div class="tv-series-preview-progress"><div style="width:${ratio}%"></div></div>` : ''}
                <div class="tv-series-preview-actions">
                    <button id="series-tv-preview-open" class="btn btn-primary tv-series-preview-primary" type="button">View Series Details</button>
                    <button id="series-tv-preview-favorite" class="btn btn-ghost tv-series-preview-favorite ${isFav ? 'active' : ''}"
                            type="button" aria-pressed="${isFav ? 'true' : 'false'}">
                        <span class="fav-icon">${isFav ? Icons.favorite : Icons.favoriteOutline}</span>
                        <span class="tv-series-preview-favorite-label">${isFav ? 'Remove from Favorites' : 'Add to Favorites'}</span>
                    </button>
                </div>
                ${sources.length ? `
                    <div class="tv-series-preview-sources">
                        <span class="tv-series-preview-sources-label">Available on</span>
                        ${sources.slice(0, 3).map(source => `<span class="tv-series-preview-source">${MediaUtils.escapeHtml(source)}</span>`).join('')}
                        ${sources.length > 3 ? `<span class="tv-series-preview-source">+${sources.length - 3}</span>` : ''}
                    </div>` : ''}
            </div>`;
    }

    async _openTvSeriesDetails(group, { focusVersions = false, originCard = null } = {}) {
        if (!group?.items?.length) return;
        const ordered = MediaUtils.orderVersionsByPreference(group.items, this.getPreferences());
        const selected = this.getRememberedVersion(group) || ordered[0] || group.representative;
        this._tvDetailOriginCard = originCard?.isConnected ? originCard : this._tvPreviewCard;
        this.currentSeriesGroup = group;
        await this.showSeriesDetailsV2(selected, group, { focusVersions });
    }

    _ensureTvEpisodeCount() {
        if (!this._isTvMode()) return null;
        const toolbar = this.detailsPanel?.querySelector('.series-episodes-toolbar');
        if (!toolbar) return null;
        let count = toolbar.querySelector('.series-tv-episode-count');
        if (!count) {
            count = document.createElement('span');
            count.className = 'series-tv-episode-count';
            count.setAttribute('aria-live', 'polite');
            toolbar.appendChild(count);
        }
        return count;
    }

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

    openGroup(group, { focusVersions = false } = {}) {
        if (this._isTvMode()) {
            this._openTvSeriesDetails(group, { focusVersions, originCard: this._tvPreviewCard });
            return;
        }
        const ordered = MediaUtils.orderVersionsByPreference(group.items, this.getPreferences());
        // Restore the version the user last chose for this title (across grid / search /
        // rails / restore), falling back to the best auto-picked one.
        const remembered = this.getRememberedVersion(group);
        this.currentSeriesGroup = group;
        this.showSeriesDetailsV2(remembered || ordered[0], group, { focusVersions });
    }

    // === In-fiche version switcher (parity with the movie fiche) ===

    // Stable signature for a version within a group (source + provider series id).
    _versionSig(item) { return `${item?.sourceId}:${item?.series_id}`; }

    // A series "version" is a whole alternate series_id subtree. Match on series_id +
    // sourceId, but tolerate a missing sourceId (search/openByItem fallback groups).
    isSameSeriesVersion(a, b) {
        if (!a || !b) return false;
        const idMatch = String(a.series_id) === String(b.series_id);
        if (a.sourceId != null && b.sourceId != null) {
            return idMatch && String(a.sourceId) === String(b.sourceId);
        }
        return idMatch;
    }

    // Compact, language-first chip label ("VF", "VOSTFR", "EN"…) — the axis users
    // actually decide on. Empty when the provider name carries no language tag.
    seriesVersionLangTag(item) {
        const v = MediaUtils.parseVersionInfo(item?.name);
        return v.languageSummary || v.language || '';
    }

    // localStorage map: title identity (tmdb, else dedup_key) -> { sourceId, series_id }.
    _versionChoiceKey(itemOrGroup) {
        const rep = itemOrGroup?.representative || itemOrGroup || {};
        const tmdb = rep.tmdb_id || rep.tmdb?.id || rep.provider_tmdb_id || rep.providerTmdbId;
        if (tmdb && !/^(tt)?0+$/i.test(String(tmdb))) return `tmdb:${tmdb}`;
        return rep.dedup_key ? `dk:${rep.dedup_key}` : null;
    }

    rememberVersionChoice(item) {
        try {
            const key = this._versionChoiceKey(item);
            if (!key) return;
            const map = JSON.parse(localStorage.getItem('norva.series.versionChoice') || '{}');
            map[key] = { sourceId: item.sourceId, series_id: item.series_id };
            localStorage.setItem('norva.series.versionChoice', JSON.stringify(map));
        } catch (_) { /* best-effort */ }
    }

    getRememberedVersion(group) {
        try {
            const key = this._versionChoiceKey(group);
            if (!key || !Array.isArray(group?.items)) return null;
            const map = JSON.parse(localStorage.getItem('norva.series.versionChoice') || '{}');
            const choice = map[key];
            if (!choice) return null;
            // Validate against the live group: a source re-sync can retire a series_id.
            return group.items.find(i => String(i.series_id) === String(choice.series_id)
                && (choice.sourceId == null || String(i.sourceId) === String(choice.sourceId))) || null;
        } catch (_) { return null; }
    }

    // Render the in-fiche version list from the in-memory group (no network), so it
    // survives even when the episode fetch fails — the recovery affordance.
    renderSeriesVersions(selectedSeries = this.currentSeries) {
        const section = document.getElementById('series-versions-section');
        if (!this.versionsList || !this.versionSummary || !section) return;
        const versions = MediaUtils.orderVersionsByPreference(
            this.currentSeriesGroup?.items || [selectedSeries], this.getPreferences());
        this._orderedVersions = versions;
        if (versions.length <= 1) {
            this.versionsList.innerHTML = '';
            this.versionSummary.textContent = '';
            section.classList.add('single-version');
            return;
        }
        section.classList.remove('single-version');
        this.versionSummary.textContent = `${versions.length} versions — choose language / source.`;
        this.versionsList.innerHTML = versions.map((item, index) => {
            const active = this.isSameSeriesVersion(item, selectedSeries);
            const broken = this.isBrokenItem(item);
            const desc = MediaUtils.versionDescriptor(item, {
                siblings: versions,
                index,
                resolveSourceName: (id) => this.getSourceName(id)
            });
            const dot = desc.tier
                ? `<span class="version-tier-dot ${MediaUtils.escapeHtml(desc.tier.cls)}" title="${MediaUtils.escapeHtml(desc.tier.label)}"></span>`
                : '';
            const badge = desc.badge
                ? `<span class="version-quality-badge ${/(4k|2160|uhd)/i.test(desc.badge) ? 'hi' : ''}">${MediaUtils.escapeHtml(desc.badge)}</span>`
                : '';
            const meta = desc.meta ? `<span class="version-meta">${MediaUtils.escapeHtml(desc.meta)}</span>` : '';
            return `
                <button class="series-version-item ${active ? 'active' : ''} ${broken ? 'is-broken' : ''}" type="button" data-index="${index}" aria-pressed="${active ? 'true' : 'false'}">
                    <span class="version-head">${dot}<span class="version-headline">${MediaUtils.escapeHtml(desc.headline)}</span>${badge}</span>
                    ${meta}
                    ${broken ? '<span class="series-version-flag" title="Unavailable — failed the health scan">Unavailable</span>' : ''}
                </button>`;
        }).join('');
        this.versionsList.querySelectorAll('.series-version-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const item = versions[parseInt(btn.dataset.index)];
                if (!item || this.isSameSeriesVersion(item, this.currentSeries)) return;
                // Switching a version reloads its own season/episode subtree. manualPick
                // keeps an explicit choice from being auto-redirected to a sibling; the
                // choice is remembered only once its episodes actually load (rememberOnSuccess).
                this.showSeriesDetailsV2(item, this.currentSeriesGroup, { isVersionSwitch: true, manualPick: true, rememberOnSuccess: true });
            });
        });
    }

    // Auto-recover: the opened version has no/failed episodes — jump to the next
    // untried (preferably healthy) sibling instead of dead-ending. `tried` guards
    // against looping when every version is empty.
    // `remember` = persist the sibling we land on as the group's version choice. Only
    // safe when the preferred version is DEFINITIVELY unusable (no episodes) — a TRANSIENT
    // fetch error must NOT durably degrade the choice, or every future open reopens the
    // worse version even after the preferred one is healthy again.
    tryNextHealthyVersion(current, tried, focusVersions = false, remember = true) {
        const group = this.currentSeriesGroup;
        if (!group || (group.items?.length || 0) <= 1) return false;
        const triedSet = tried || new Set();
        triedSet.add(this._versionSig(current));
        const ordered = MediaUtils.orderVersionsByPreference(group.items, this.getPreferences());
        const next = ordered.find(i => !triedSet.has(this._versionSig(i)) && !this.isBrokenItem(i))
            || ordered.find(i => !triedSet.has(this._versionSig(i)));
        if (!next) return false;
        this.showSeriesDetailsV2(next, group, { isVersionSwitch: true, triedVersions: triedSet, focusVersions, rememberOnSuccess: remember });
        return true;
    }

    openRandom() {
        if (this.filteredCards.length === 0) return;
        const group = this.filteredCards[Math.floor(Math.random() * this.filteredCards.length)];
        this.openGroup(group);
    }

    // (Removed showVersionPicker: the pre-fiche modal is superseded by the in-fiche
    //  version switcher — the grid badge now deep-links into the fiche instead.)

    getSeriesDisplayTitle(series = this.currentSeries) {
        return series?.tmdb?.title || series?.tmdb?.name || MediaUtils.cleanReleaseName(series?.name || '') || 'Series';
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

        // The "<series name> - " strip patterns depend only on currentSeries, not the
        // episode, so compile them ONCE per fiche (memoized) rather than recompiling the
        // same ~4 RegExps for every one of a large series' episodes on the render path.
        for (const re of this._seriesNameStripRes()) title = title.replace(re, '');
        title = title
            .replace(new RegExp(`^S0?${seasonNum}\\s*E0?${episodeNum}\\s*[-:–—|]+\\s*`, 'i'), '')
            .replace(/^S\d{1,2}E\d{1,3}\s*[-:–—|]+\s*/i, '')
            .trim();

        return title || `Episode ${episodeNum || ''}`.trim();
    }

    // Compile the leading "<series name> - " strip patterns once per series and memoize
    // them on the series identity, so a fiche's per-episode title cleaning reuses the
    // same RegExps instead of recompiling them for every row.
    _seriesNameStripRes() {
        const s = this.currentSeries;
        const key = s
            ? [s.series_id, s.stream_id, s.id, s.name, this.getSeriesDisplayTitle()].map(v => v ?? '').join('|')
            : '';
        if (this._epStripKey === key && this._epStripRes) return this._epStripRes;
        const names = [
            this.getSeriesDisplayTitle(),
            s?.name,
            s?.tmdb?.original_name,
            s?.tmdb?.original_title
        ].filter(Boolean);
        this._epStripRes = names.map(name => new RegExp(`^${this.escapeRegExp(name)}\\s*[-:–—|]+\\s*`, 'i'));
        this._epStripKey = key;
        return this._epStripRes;
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

    // === Manual "mark watched / unwatched" (per episode + per season) ===

    // Persist watched=true as a completed history row (progress≈duration), or delete the
    // row for watched=false, then mirror it into this.historyItems so the UI reflects it
    // without a full reload. Uses the same POST /history shape as the player's saveProgress.
    async setEpisodeWatched(episodeId, seasonNum, episodeNum, watched, series = this.currentSeries) {
        if (!series || episodeId == null) return;
        const eid = String(episodeId);
        const sid = String(series.series_id);
        // Scope every lookup by (episode item_id + this series) so a movie or another
        // series that happens to share the numeric id is never touched.
        const sameEp = (h) => h.item_type === 'episode' && String(h.item_id) === eid && String(h.data?.seriesId) === sid;
        if (watched) {
            const ep = this.findEpisodeById(eid) || {};
            const duration = MediaUtils.parseDurationToSeconds(ep.duration)
                || Number(ep.info?.duration_secs) || 1800;
            const data = {
                title: this.getSeriesDisplayTitle(series),
                subtitle: `S${seasonNum} E${episodeNum}`,
                poster: this.getSeriesPoster(series),
                sourceId: series.sourceId,
                seriesId: series.series_id,
                currentSeason: seasonNum,
                currentEpisode: episodeNum,
            };
            const saved = await API.history.save({
                id: eid, type: 'episode', sourceId: series.sourceId,
                progress: duration, duration, data,
            });
            this.historyItems = (this.historyItems || []).filter(h => !sameEp(h));
            // Keep the server's DB id so a later unwatch deletes THIS exact row.
            this.historyItems.push({ id: saved?.id ?? saved?.item?.id ?? null, item_type: 'episode', item_id: eid, progress: duration, duration, completed: true, data });
        } else {
            // Delete the exact row by its DB id when known — item_id alone is ambiguous
            // (shared VOD/episode namespace) and the server only scans the newest 500 rows.
            const existing = (this.historyItems || []).find(sameEp);
            await API.history.remove(existing?.id != null ? existing.id : eid);
            this.historyItems = (this.historyItems || []).filter(h => !sameEp(h));
        }
        // Keep the grid's "started" set in sync for BOTH mark and unmark (mirrors how
        // loadWatchState derives it), so the watched-filter isn't stale before a reload.
        if (this.startedSeriesIds) {
            const stillStarted = (this.historyItems || []).some(
                h => h.item_type === 'episode' && String(h.data?.seriesId) === sid);
            if (stillStarted) this.startedSeriesIds.add(series.series_id);
            else this.startedSeriesIds.delete(series.series_id);
        }
    }

    async toggleEpisodeWatched(row) {
        const episodeId = row?.dataset?.episodeId;
        if (!episodeId || !this.currentSeries) return;
        const watched = (this.getSeriesHistoryMap().get(String(episodeId))?.ratio || 0) >= 0.95;
        const btn = row.querySelector('.episode-mark');
        if (btn) btn.disabled = true;
        try {
            await this.setEpisodeWatched(episodeId, row.dataset.season, row.dataset.episodeNum, !watched);
            this.repaintEpisodeWatchState();
        } catch (_) {
            this.app?.showToast?.('Could not update watch state', { type: 'error' });
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async toggleSeasonWatched(seasonNum) {
        if (seasonNum == null || !this.currentSeriesInfo) return;
        const series = this.currentSeries;                       // pin the target series
        if (!series) return;
        const eps = Array.isArray(this.currentSeriesInfo.episodes?.[seasonNum])
            ? this.currentSeriesInfo.episodes[seasonNum] : [];
        if (!eps.length) return;
        const map = this.getSeriesHistoryMap(series);
        // If every episode is already watched → the button un-watches the whole season.
        const allWatched = eps.every(ep => (map.get(String(ep.id))?.ratio || 0) >= 0.95);
        const target = !allWatched;
        // Guard CSS.escape like the sibling downloadSeason (some WebViews lack it).
        const esc = (window.CSS && CSS.escape) ? CSS.escape(String(seasonNum)) : String(seasonNum);
        const btn = this.seasonsContainer?.querySelector(`.season-mark-all[data-season="${esc}"]`);
        if (btn) { btn.disabled = true; btn.textContent = target ? 'Marking…' : 'Updating…'; }
        let failed = false;
        try {
            // Sequential to keep the history writes gentle and deterministic.
            for (const ep of eps) {
                // Bail if the user switched version / left mid-loop, so we never write
                // watch rows for these episodes onto a DIFFERENT series.
                if (this.currentSeries !== series) break;
                const already = (map.get(String(ep.id))?.ratio || 0) >= 0.95;
                if (already === target) continue;
                try {
                    await this.setEpisodeWatched(ep.id, seasonNum, ep.episode_num || '', target, series);
                } catch (_) { failed = true; }
            }
        } finally {
            // Repaint whatever DID change (even on a partial failure), only if still on this fiche.
            if (this.currentSeries === series) this.repaintEpisodeWatchState();
            if (btn) btn.disabled = false;
            this.refreshSeasonMarkButtons();
            if (failed) this.app?.showToast?.('Some episodes could not be updated', { type: 'error' });
        }
    }

    // Toggle each season button's label between "Mark season as watched" / "…unwatched".
    refreshSeasonMarkButtons() {
        if (!this.seasonsContainer || !this.currentSeriesInfo) return;
        const map = this.getSeriesHistoryMap();
        this.seasonsContainer.querySelectorAll('.season-mark-all').forEach(btn => {
            const s = btn.dataset.season;
            const eps = Array.isArray(this.currentSeriesInfo.episodes?.[s]) ? this.currentSeriesInfo.episodes[s] : [];
            const allWatched = eps.length > 0 && eps.every(ep => (map.get(String(ep.id))?.ratio || 0) >= 0.95);
            btn.textContent = allWatched ? 'Mark season as unwatched' : 'Mark season as watched';
            btn.classList.toggle('is-watched', allWatched);
        });
    }

    // Patch markers / progress / up-next / mark buttons / the primary action in place,
    // without re-fetching or re-rendering the whole episode list.
    repaintEpisodeWatchState() {
        if (!this.seasonsContainer || !this.currentSeries) return;
        const map = this.getSeriesHistoryMap();
        const flat = this.currentSeriesInfo ? this.flattenEpisodes(this.currentSeriesInfo) : [];
        const featured = this.getFeaturedEpisode(flat, map);
        const featuredId = featured ? String(featured.episode.id) : null;

        this.seasonsContainer.querySelectorAll('.episode-item').forEach(row => {
            const id = String(row.dataset.episodeId);
            const ratio = map.get(id)?.ratio || 0;
            const watched = ratio >= 0.95;
            const inProgress = ratio > 0.02 && ratio < 0.95;
            const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
            const titleRow = row.querySelector('.episode-title-row');

            // In-progress marker (◐) only. A WATCHED episode is shown by the filled mark
            // button, so we don't also stamp a ✓ in the title (avoids a double checkmark).
            let marker = row.querySelector('.episode-watched');
            if (inProgress && !watched) {
                if (!marker) {
                    marker = document.createElement('span');
                    marker.className = 'episode-watched inprogress';
                    row.querySelector('.episode-title')?.insertAdjacentElement('afterend', marker);
                }
                marker.classList.add('inprogress');
                marker.textContent = '◐';
                marker.title = 'In progress';
            } else if (marker) {
                marker.remove();
            }

            // progress bar
            let bar = row.querySelector('.episode-progress');
            if (pct > 0 && pct < 95) {
                if (!bar) {
                    bar = document.createElement('div');
                    bar.className = 'episode-progress';
                    bar.innerHTML = '<div></div>';
                    row.querySelector('.episode-copy')?.appendChild(bar);
                }
                if (bar.firstElementChild) bar.firstElementChild.style.width = `${pct}%`;
            } else if (bar) {
                bar.remove();
            }

            // up-next highlight
            const isUp = featuredId && id === featuredId;
            row.classList.toggle('episode-up-next', !!isUp);
            let flag = row.querySelector('.episode-upnext-flag');
            if (isUp && !flag) {
                flag = document.createElement('span');
                flag.className = 'episode-upnext-flag';
                flag.textContent = 'Up next';
                titleRow?.appendChild(flag);
            } else if (!isUp && flag) {
                flag.remove();
            }

            // mark button — ✓ only when watched, empty circle otherwise (so an unwatched
            // row's button doesn't read as "already watched", esp. on touch).
            const btn = row.querySelector('.episode-mark');
            if (btn) {
                btn.classList.toggle('is-watched', watched);
                btn.setAttribute('aria-pressed', watched ? 'true' : 'false');
                btn.title = watched ? 'Mark as unwatched' : 'Mark as watched';
                btn.textContent = watched ? '✓' : '';
            }
        });

        // primary action + "Play from start" reflect the recomputed featured episode
        if (this.primaryActionBtn && featured) {
            const h = map.get(featuredId);
            const isResuming = (h?.ratio || 0) > 0.02 && (h?.ratio || 0) < 0.95;
            const minsLeft = (isResuming && h?.duration > 0) ? Math.max(0, Math.round((h.duration - h.progress) / 60)) : 0;
            const label = `${featured.label}${minsLeft ? ` · ${minsLeft} min left` : ''}`;
            this.primaryActionBtn.disabled = false;
            this.primaryActionBtn.dataset.episodeId = featured.episode.id;
            this.primaryActionBtn.innerHTML = `<span class="play-icon">${Icons.play}</span><span>${MediaUtils.escapeHtml(label)}</span>`;
            if (this.playStartBtn) {
                this.playStartBtn.style.display = isResuming ? '' : 'none';
                this.playStartBtn.dataset.episodeId = featured.episode.id;
            }
        }
        this.refreshSeasonMarkButtons();
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

        // Among in-progress episodes prefer the MOST RECENTLY watched (by history
        // updated_at), not the earliest by position — else, with two episodes mid-way,
        // resume/Up-next targets the older one instead of the one you were just watching.
        const tsOf = (v) => (v && v.updated_at) ? (Date.parse(v.updated_at) || 0) : 0;
        let inProgress = null, inProgressTs = -1;
        for (const row of flatEpisodes) {
            const st = watchedEpisodes.get(String(row.episode.id));
            const ratio = st?.ratio || 0;
            if (ratio > 0.02 && ratio < 0.95 && tsOf(st) > inProgressTs) {
                inProgressTs = tsOf(st); inProgress = row;
            }
        }
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

    // === Thumbs up/down (per-profile title rating) ===

    paintThumbButtons(rating) {
        document.getElementById('series-thumb-up')?.classList.toggle('active', rating === 1);
        document.getElementById('series-thumb-down')?.classList.toggle('active', rating === -1);
    }

    async loadRating() {
        this._currentRating = 0;
        this.paintThumbButtons(0);
        const series = this.currentSeries;
        if (!series || !window.NorvaCloud?.ratings) return;
        try {
            const res = await NorvaCloud.ratings.get({ itemType: 'series', itemId: series.series_id });
            this._currentRating = Number(res?.rating) || 0;
            this.paintThumbButtons(this._currentRating);
        } catch (_) { /* ratings are cloud-only / best-effort */ }
    }

    async setRating(value) {
        const series = this.currentSeries;
        if (!series || !window.NorvaCloud?.ratings) return;
        const next = this._currentRating === value ? 0 : value;
        this._currentRating = next;
        this.paintThumbButtons(next);
        try {
            await NorvaCloud.ratings.set({ sourceId: series.sourceId, itemId: series.series_id, itemType: 'series', rating: next });
        } catch (_) {
            this.app?.showToast?.('Could not save your rating', { type: 'error' });
        }
    }

    playPrimaryEpisode({ fromStart = false } = {}) {
        const episodeId = this.primaryActionBtn?.dataset?.episodeId;
        if (!episodeId) return;
        const episodeEl = [...this.seasonsContainer.querySelectorAll('.episode-item')]
            .find(el => String(el.dataset.episodeId) === String(episodeId));
        if (episodeEl) this.playEpisode(episodeEl, { fromStart });
    }

    applySelectedSeason() {
        if (!this.seasonsContainer) return;
        const selected = this._activeSeason;
        this.seasonsContainer.querySelectorAll('.season-group').forEach(group => {
            group.classList.toggle('hidden-by-select', selected != null && group.dataset.season !== String(selected));
        });
        this.seasonTabs?.querySelectorAll('.season-tab').forEach(tab => {
            const on = String(tab.dataset.season) === String(selected);
            tab.classList.toggle('active', on);
            tab.setAttribute('aria-selected', on ? 'true' : 'false');
            tab.tabIndex = on ? 0 : -1; // roving tabindex: one stop for the whole tablist
        });
    }

    setActiveSeason(seasonNum) {
        this._activeSeason = seasonNum == null ? null : String(seasonNum);
        this._ensureSeasonBuilt(this._activeSeason);
        this.applySelectedSeason();
        this.enrichSeasonWithTmdb(this._activeSeason);
    }

    _seasonGroupEl(seasonNum) {
        if (seasonNum == null || !this.seasonsContainer) return null;
        return [...this.seasonsContainer.querySelectorAll('.season-group')]
            .find(g => String(g.dataset.season) === String(seasonNum)) || null;
    }

    // Wire the per-episode controls WITHIN one season group (play on click/Enter/Space,
    // mark-watched, native download). Scoped to `root` so materializing a lazy season
    // never re-wires the already-built ones (which would double-fire playback).
    _wireEpisodeItems(root) {
        if (!root) return;
        root.querySelectorAll('.episode-item').forEach(ep => {
            ep.addEventListener('click', () => this.playEpisode(ep));
            // Rows are role=button tabindex=0 → activate on Enter/Space. Ignore keys that
            // bubbled from a focused child (mark/download) so they don't also start play.
            ep.addEventListener('keydown', (e) => {
                if (e.target !== ep) return;
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault();
                    this.playEpisode(ep);
                }
            });
            ep.querySelector('.episode-mark')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleEpisodeWatched(ep);
            });
        });
        if (this.nativeDownloadBridge()) {
            root.querySelectorAll('.episode-download').forEach(btn => {
                btn.style.display = '';
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.downloadEpisode(btn.closest('.episode-item'), btn);
                });
            });
        }
    }

    // Materialize a season's episode rows the first time it's activated (lazy render).
    // The wrapper + season controls were built up front; here we fill the empty
    // .episode-list from live data and wire it. No-op once the season is built.
    _ensureSeasonBuilt(seasonNum) {
        const group = this._seasonGroupEl(seasonNum);
        if (!group || !group.hasAttribute('data-episodes-pending')) return;
        const episodes = Array.isArray(this.currentSeriesInfo?.episodes?.[seasonNum])
            ? this.currentSeriesInfo.episodes[seasonNum] : [];
        const list = group.querySelector('.episode-list');
        // Live history; no featured highlight (up-next lives in the featured season,
        // which is always the one built up front).
        if (list) {
            list.innerHTML = this._episodeListInnerHtml(
                episodes, seasonNum, this.getSeriesHistoryMap(), null, this.currentSeries
            );
        }
        group.removeAttribute('data-episodes-pending');
        this._wireEpisodeItems(group);
        this.refreshSeasonMarkButtons();
        if (this.nativeDownloadBridge()) this.refreshEpisodeDownloadStates();
    }

    // The inner HTML of one season's .episode-list. Extracted so it can be built up front
    // for the active season and lazily for the rest (identical markup in both paths).
    _episodeListInnerHtml(episodes, seasonNum, watchedEpisodes, featured, series) {
        return (Array.isArray(episodes) ? episodes : []).map(ep => {
            const history = watchedEpisodes.get(String(ep.id));
            const ratio = history?.ratio || 0;
            const ratioPercent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
            const watched = ratio >= 0.95;
            const marker = (ratio > 0.02 && ratio < 0.95)
                ? '<span class="episode-watched inprogress" title="In progress">◐</span>' : '';
            const cleanTitle = this.cleanEpisodeTitle(ep, seasonNum);
            const duration = this.formatEpisodeDuration(ep.duration);
            const description = ep.plot || ep.info?.plot || ep.overview || '';
            const thumb = this.getEpisodeImage(ep, series);
            const isUpNext = featured && String(ep.id) === String(featured.episode.id);
            return `
                            <div class="episode-item ${isUpNext ? 'episode-up-next' : ''}" role="button" tabindex="0" aria-label="${MediaUtils.escapeHtml(cleanTitle)}" data-episode-id="${MediaUtils.escapeHtml(ep.id)}" data-source-id="${series.sourceId}" data-container="${MediaUtils.escapeHtml(ep.container_extension || 'mp4')}" data-season="${MediaUtils.escapeHtml(seasonNum)}" data-episode-num="${MediaUtils.escapeHtml(ep.episode_num || '')}">
                                <span class="episode-number">${MediaUtils.escapeHtml(ep.episode_num || '')}</span>
                                <div class="episode-thumb">
                                    <img src="${MediaUtils.escapeHtml(thumb)}" alt="" onerror="this.onerror=null;this.srcset='';this.src='/img/norva-media-placeholder.png'" loading="lazy" decoding="async">
                                    <span class="episode-play">${Icons.play}</span>
                                </div>
                                <div class="episode-copy">
                                    <div class="episode-title-row">
                                        <span class="episode-title">${MediaUtils.escapeHtml(cleanTitle)}</span>
                                        ${marker}
                                        ${isUpNext ? '<span class="episode-upnext-flag">Up next</span>' : ''}
                                    </div>
                                    ${description ? `<p class="episode-description">${MediaUtils.escapeHtml(description)}</p>` : ''}
                                    ${ratioPercent > 0 && ratioPercent < 95 ? `<div class="episode-progress"><div style="width:${ratioPercent}%"></div></div>` : ''}
                                </div>
                                <div class="episode-actions">
                                    <span class="episode-duration">${MediaUtils.escapeHtml(duration)}</span>
                                    <button class="episode-mark ${watched ? 'is-watched' : ''}" type="button" aria-pressed="${watched ? 'true' : 'false'}" title="${watched ? 'Mark as unwatched' : 'Mark as watched'}">${watched ? '✓' : ''}</button>
                                    <button class="episode-download" type="button" title="Download for offline" style="display:none">
                                        <span class="episode-download-icon">&#x2193;</span>
                                    </button>
                                </div>
                            </div>`;
        }).join('');
    }

    // Progressive enhancement: overlay TMDB per-episode data onto the shown season's
    // provider rows. Stills always win (kills the repeated series-poster look); a
    // generic "Episode N"/empty title is upgraded to the localized TMDB name, but a real
    // provider title is never overwritten (avoids swapping a clean FR title for an EN one).
    // Lazy per active season + memoized; token-guarded so it never patches a newer fiche.
    async enrichSeasonWithTmdb(seasonNum) {
        if (seasonNum == null || !this.seasonsContainer) return;
        const series = this.currentSeries;
        const tmdbId = series?.provider_tmdb_id || series?.providerTmdbId
            || series?.tmdb?.id || series?.tmdb_id || series?.metadata?.providerTmdbId;
        if (!tmdbId || /^(tt)?0+$/i.test(String(tmdbId)) || !window.NorvaCloud?.media?.tmdbEpisodes) return;
        this._tmdbEnriched = this._tmdbEnriched || new Set();
        const memo = `${tmdbId}:${seasonNum}`;
        if (this._tmdbEnriched.has(memo)) return;
        this._tmdbEnriched.add(memo);
        const token = this._detailToken;
        try {
            // Language is resolved by cloudApi (subtitle → audio → region → locale → en)
            // and auto-injected as ?lang= — the SAME chain the series overview resolves
            // through, so episode synopses stay coherent with the fiche (VOD i18n C.4).
            const res = await NorvaCloud.media.tmdbEpisodes({
                type: 'series', tmdbId: String(tmdbId), season: String(seasonNum) });
            if (token !== this._detailToken || !res?.available || !Array.isArray(res.episodes)) return;
            const byNum = new Map(res.episodes
                .filter(e => e.episode_number != null)
                .map(e => [String(e.episode_number), e]));
            const group = [...this.seasonsContainer.querySelectorAll('.season-group')]
                .find(g => String(g.dataset.season) === String(seasonNum));
            if (!group) return;
            group.querySelectorAll('.episode-item').forEach(row => {
                const te = byNum.get(String(row.dataset.episodeNum));
                if (!te) return;
                if (te.still_path) {
                    const img = row.querySelector('.episode-thumb img');
                    if (img) { img.removeAttribute('srcset'); img.src = `https://image.tmdb.org/t/p/w300${te.still_path}`; }
                }
                if (te.name) {
                    const titleEl = row.querySelector('.episode-title');
                    const cur = (titleEl?.textContent || '').trim();
                    if (titleEl && (/^Episode\s*\d*$/i.test(cur) || !cur)) {
                        titleEl.textContent = te.name;
                        row.setAttribute('aria-label', te.name);
                    }
                }
                if (te.air_date && !row.querySelector('.episode-airdate')) {
                    const year = String(te.air_date).match(/(19|20)\d{2}/)?.[0];
                    const titleRow = row.querySelector('.episode-title-row');
                    if (year && titleRow) {
                        const span = document.createElement('span');
                        span.className = 'episode-airdate';
                        span.textContent = year;
                        titleRow.appendChild(span);
                    }
                }
                // Fill a MISSING synopsis from TMDB (a real provider description is kept),
                // so an episode reads the same across versions even when one provider ships
                // no plot. Never overwrites an existing description.
                if (te.overview && !row.querySelector('.episode-description')) {
                    const desc = document.createElement('p');
                    desc.className = 'episode-description';
                    desc.textContent = te.overview;
                    const titleRow = row.querySelector('.episode-title-row');
                    if (titleRow) titleRow.insertAdjacentElement('afterend', desc);
                    else row.querySelector('.episode-copy')?.appendChild(desc);
                }
            });
        } catch (_) {
            this._tmdbEnriched.delete(memo); // let a later season revisit retry
        }
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

    async showSeriesDetailsV2(series, group = null, { focusVersions = false, isVersionSwitch = false, triedVersions = null, manualPick = false, rememberOnSuccess = false } = {}) {
        this.currentSeries = series;
        this.currentSeriesGroup = group || this.currentSeriesGroup || { representative: series, items: [series] };
        // Guard rapid version switches: a slow older seriesInfo must not paint over a newer one.
        const detailToken = (this._detailToken = (this._detailToken || 0) + 1);
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
        if (!isVersionSwitch) {
            this.detailsPanel.scrollTop = 0;
            // Opening a DIFFERENT title (not a version switch): tear down any armed "Up next"
            // auto-play banner + its countdown left over from the previous fiche, so it can't
            // fire the previous series' next episode over this one (e.g. after picking a
            // recommendation). hideDetails() does this too, but a fiche→fiche swap never hides.
            try { this.cancelNextEpisodePrompt?.(); } catch (_) { /* noop */ }
            if (this._epDlTimer) { clearInterval(this._epDlTimer); this._epDlTimer = null; }
        }

        // Context-aware back label — return to the search results, the open genre, or Series.
        const backBtn = this.detailsPanel.querySelector('.series-back-btn');
        if (backBtn) {
            const ctx = this.searchInput?.value?.trim()
                ? 'Search results'
                : (this.activeBucket && this.bucketLabel ? this.bucketLabel : 'Series');
            // Update only the label span — the button holds an SVG arrow icon that a
            // raw textContent write would destroy (the old circle-with-spilled-text bug).
            const label = backBtn.querySelector('.back-label');
            if (label) label.textContent = ctx;
            else backBtn.textContent = `← ${ctx}`;
        }

        // Hero / poster / plot / related come from the group representative and are the
        // same across versions, so a VERSION SWITCH skips them (and their TMDB fetches)
        // and only reloads the episode subtree below — keeping the switch responsive.
        if (!isVersionSwitch) {
            const poster = this.getSeriesPoster(series);
            const backdrop = this.getSeriesBackdrop(series);
            const hero = document.getElementById('series-detail-hero');
            if (hero) hero.style.setProperty('--series-hero-bg', `url("${String(backdrop).replace(/"/g, '%22')}")`);
            const seriesPosterEl = document.getElementById('series-poster');
            if (seriesPosterEl) {
                // Stale/404 poster → placeholder, not a broken-image icon (clear srcset first).
                seriesPosterEl.onerror = () => { seriesPosterEl.onerror = null; seriesPosterEl.removeAttribute('srcset'); seriesPosterEl.src = '/img/norva-media-placeholder.png'; };
                seriesPosterEl.removeAttribute('srcset');
                seriesPosterEl.src = poster;
            }
            document.getElementById('series-title').textContent = this.getSeriesDisplayTitle(series);
            document.getElementById('series-plot').textContent = series.tmdb?.overview || series.overview || series.description || series.plot || 'No summary available yet.';
            this.renderMoreLikeThis(series);
            this.renderFicheExtras(series);
        }
        this.renderSeriesVersions(series);
        this.syncDetailFavoriteButton();
        this.loadRating();
        // The switcher DOM is populated synchronously above, so honor the grid badge's
        // deep-link now — independent of whether the episode fetch succeeds/recovers.
        if (focusVersions && this.currentSeriesGroup?.items?.length > 1) {
            document.getElementById('series-versions-section')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        this.seasonsContainer.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
        const tvEpisodeCount = this._ensureTvEpisodeCount();
        if (tvEpisodeCount) tvEpisodeCount.textContent = '';
        if (this.primaryActionBtn) {
            this.primaryActionBtn.disabled = true;
            this.primaryActionBtn.textContent = 'Loading...';
            delete this.primaryActionBtn.dataset.episodeId;
        }
        // Clear any stale "Play from start" state before the fetch — failure exits below
        // return early, so without this it could leak a previous fiche's visible button.
        if (this.playStartBtn) this.playStartBtn.style.display = 'none';

        // Reset the meta line synchronously from `series` (year / versions / genres — none
        // need seriesInfo) so an error/empty path never leaves the PREVIOUS fiche's meta
        // pills. The success path below overwrites it with season/episode counts too.
        const seriesMetaEarly = document.getElementById('series-meta');
        if (seriesMetaEarly) {
            const earlyMeta = [
                this.getSeriesYear(series),
                (this.currentSeriesGroup?.items?.length > 1) ? `${this.currentSeriesGroup.items.length} versions` : '',
                ...this.getSeriesGenres(series).slice(0, 3),
            ].filter(Boolean);
            seriesMetaEarly.innerHTML = earlyMeta.map(p => `<span>${MediaUtils.escapeHtml(p)}</span>`).join('');
        }

        try {
            const info = await API.proxy.xtream.seriesInfo(series.sourceId, series.series_id);
            if (detailToken !== this._detailToken) return; // a newer switch superseded this one
            // A present-but-EMPTY episodes collection ({} / []) is truthy, so `!info.episodes`
            // missed it — the fiche then rendered a blank episode area AND skipped the failover
            // to a healthy sibling version. Treat "no season actually has episodes" as empty.
            const hasEpisodes = info && info.episodes &&
                Object.keys(info.episodes).some(k => Array.isArray(info.episodes[k]) && info.episodes[k].length);
            if (!info || !hasEpisodes) {
                // Auto-pick landed on an empty version → jump to a healthy sibling. But an
                // EXPLICIT pick (manualPick) is respected: show "No episodes" for that very
                // version, with the switcher still visible so the user can choose another.
                if (!manualPick && this.tryNextHealthyVersion(series, triedVersions, focusVersions)) return;
                this.seasonsContainer.innerHTML = '<p class="hint">No episodes found</p>';
                if (this.primaryActionBtn) this.primaryActionBtn.textContent = 'No episodes';
                return;
            }

            this.currentSeriesInfo = info;
            this._tmdbEnriched = new Set(); // per-season TMDB enrichment memo, reset per load
            // Persist the chosen version only now that its episodes actually loaded, so a
            // broken/empty pick never gets remembered (which would re-bounce every open).
            if (rememberOnSuccess) this.rememberVersionChoice(series);
            const watchedEpisodes = this.getSeriesHistoryMap(series);
            const flatEpisodes = this.flattenEpisodes(info);
            const seasons = Object.keys(info.episodes).sort((a, b) => parseInt(a) - parseInt(b));
            const episodeCount = flatEpisodes.length;
            const seasonCount = seasons.length;
            if (tvEpisodeCount) {
                tvEpisodeCount.textContent = `${episodeCount} episode${episodeCount === 1 ? '' : 's'}`;
            }
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
                (this.currentSeriesGroup?.items?.length > 1) ? `${this.currentSeriesGroup.items.length} versions` : '',
                ...genres,
                version.quality,
                MediaUtils.versionLanguageBadge(series, this.getPreferences())
            ].filter(Boolean);

            const metaEl = document.getElementById('series-meta');
            if (metaEl) {
                metaEl.innerHTML = metaParts.map(part => `<span>${MediaUtils.escapeHtml(part)}</span>`).join('');
            }

            const featured = this.getFeaturedEpisode(flatEpisodes, watchedEpisodes);
            // On a version switch, keep the season the user was browsing if the new version
            // still has it — otherwise the featured-episode recompute (history is filtered by
            // the NEW version's id, so it finds nothing) would bounce them back to S1.
            const prevSeason = this._activeSeason;
            this._activeSeason = (isVersionSwitch && prevSeason != null && info.episodes[prevSeason])
                ? String(prevSeason)
                : (featured ? String(featured.seasonNum) : (seasons.length ? String(seasons[0]) : null));
            if (this.seasonTabs) {
                const seasonLabel = (n) => String(n) === '0' ? 'Specials' : `Season ${n}`;
                this.seasonTabs.innerHTML = seasons.map(seasonNum => {
                    const count = Array.isArray(info.episodes[seasonNum]) ? info.episodes[seasonNum].length : 0;
                    const on = String(seasonNum) === String(this._activeSeason);
                    return `<button class="season-tab ${on ? 'active' : ''}" type="button" role="tab" aria-selected="${on ? 'true' : 'false'}" tabindex="${on ? 0 : -1}" data-season="${MediaUtils.escapeHtml(seasonNum)}"><span class="season-tab-label">${MediaUtils.escapeHtml(seasonLabel(seasonNum))}</span><span class="season-tab-count">${count}</span></button>`;
                }).join('');
                this.seasonTabs.classList.toggle('single-season', seasons.length <= 1);
                const tabEls = [...this.seasonTabs.querySelectorAll('.season-tab')];
                tabEls.forEach(tab => {
                    tab.addEventListener('click', () => this.setActiveSeason(tab.dataset.season));
                    // Tablist keyboard: Left/Right move + activate the adjacent season.
                    tab.addEventListener('keydown', (e) => {
                        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                        e.preventDefault();
                        const idx = tabEls.indexOf(tab);
                        const next = tabEls[e.key === 'ArrowRight' ? idx + 1 : idx - 1];
                        if (next) { this.setActiveSeason(next.dataset.season); next.focus(); }
                    });
                });
            }

            // Resume context: how far into the featured episode we are, and minutes left.
            const featuredHist = featured ? watchedEpisodes.get(String(featured.episode.id)) : null;
            const featuredRatio = featuredHist?.ratio || 0;
            const isResuming = featuredRatio > 0.02 && featuredRatio < 0.95;
            const minsLeft = (isResuming && featuredHist?.duration > 0)
                ? Math.max(0, Math.round((featuredHist.duration - featuredHist.progress) / 60)) : 0;
            if (this.primaryActionBtn) {
                if (featured) {
                    const label = `${featured.label}${minsLeft ? ` · ${minsLeft} min left` : ''}`;
                    this.primaryActionBtn.disabled = false;
                    this.primaryActionBtn.dataset.episodeId = featured.episode.id;
                    this.primaryActionBtn.innerHTML = `<span class="play-icon">${Icons.play}</span><span>${MediaUtils.escapeHtml(label)}</span>`;
                } else {
                    this.primaryActionBtn.disabled = true;
                    this.primaryActionBtn.textContent = 'No episodes';
                }
            }
            if (this.playStartBtn) {
                // "Play from start" only matters when the primary button would resume mid-episode.
                this.playStartBtn.style.display = (featured && isResuming) ? '' : 'none';
                if (featured) this.playStartBtn.dataset.episodeId = featured.episode.id;
            }

            // Build ONLY the active season's episode rows up front; other seasons render
            // their list lazily on first activation (_ensureSeasonBuilt). A large series
            // otherwise parses + lays out thousands of hidden episode nodes on every
            // fiche-open. Season-level controls live in the always-present wrapper.
            let html = '';
            seasons.forEach(seasonNum => {
                const isActive = String(seasonNum) === String(this._activeSeason);
                const episodes = Array.isArray(info.episodes[seasonNum]) ? info.episodes[seasonNum] : [];
                html += `
                <div class="season-group" data-season="${MediaUtils.escapeHtml(seasonNum)}"${isActive ? '' : ' data-episodes-pending="1"'}>
                    <div class="season-dl-bar" data-season="${MediaUtils.escapeHtml(seasonNum)}" style="display:none">
                        <span class="season-dl-name">Season ${MediaUtils.escapeHtml(seasonNum)}</span>
                        <span class="season-dl-count"></span>
                        <button class="season-download-btn" type="button" data-season="${MediaUtils.escapeHtml(seasonNum)}" title="Download every episode of this season">
                            <span class="season-download-label">Download season</span>
                        </button>
                    </div>
                    <div class="season-actions">
                        <button class="season-mark-all" type="button" data-season="${MediaUtils.escapeHtml(seasonNum)}">Mark season as watched</button>
                    </div>
                    <div class="episode-list">${isActive ? this._episodeListInnerHtml(episodes, seasonNum, watchedEpisodes, featured, series) : ''}</div>
                </div>`;
            });

            this.seasonsContainer.innerHTML = html;
            // Season-level controls exist for EVERY season (they live in the always-built
            // wrapper), so wire them container-wide once.
            this.seasonsContainer.querySelectorAll('.season-mark-all').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleSeasonWatched(btn.dataset.season);
                });
            });
            this.refreshSeasonMarkButtons();
            // Per-season download bar (native app only) — also wrapper-level, wire for all.
            if (this.nativeDownloadBridge()) {
                this.seasonsContainer.querySelectorAll('.season-dl-bar').forEach(bar => {
                    bar.style.display = '';
                    const seasonBtn = bar.querySelector('.season-download-btn');
                    seasonBtn?.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.downloadSeason(bar.dataset.season, seasonBtn);
                    });
                });
            }
            // Episode-level wiring for the built (active) season only; the rest are wired
            // when _ensureSeasonBuilt materializes them on first activation.
            this._wireEpisodeItems(this._seasonGroupEl(this._activeSeason));
            if (this.nativeDownloadBridge()) this.refreshEpisodeDownloadStates();
            this.applySelectedSeason();
            this.enrichSeasonWithTmdb(this._activeSeason);
        } catch (err) {
            if (detailToken !== this._detailToken) return; // superseded — don't stomp the newer fiche
            // A failed fetch on the auto-picked version → try a healthy sibling first
            // (but respect an explicit manual pick: surface its error rather than redirect).
            // remember=false: a fetch error may be transient, so DON'T durably switch the
            // remembered version — the next open should retry the preferred one.
            if (!manualPick && this.tryNextHealthyVersion(series, triedVersions, focusVersions, false)) return;
            const { friendly, detail } = this.getSeriesInfoError(err);
            console.error('Error loading series info:', err);
            this.seasonsContainer.innerHTML = `
                <div class="series-error" style="color: var(--color-error);">
                    <p class="hint">${MediaUtils.escapeHtml(friendly)}</p>
                    ${detail ? `<p class="hint" style="opacity: .75;">${MediaUtils.escapeHtml(detail.slice(0, 240))}</p>` : ''}
                </div>`;
            // Put the primary button in a terminal state — it was left disabled on
            // "Loading..." at the top, and the catch never reset it.
            if (this.primaryActionBtn) { this.primaryActionBtn.disabled = true; this.primaryActionBtn.textContent = 'Unavailable'; }
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

    // Live TMDB extras on the fiche: trailer button + cast/creator credits.
    // Fire-and-forget with a token so a stale fetch never paints a newer fiche.
    async renderFicheExtras(series) {
        const token = (this._ficheExtrasToken = (this._ficheExtrasToken || 0) + 1);
        this.detailsPanel?.querySelector('.detail-credits')?.remove();
        this.detailsPanel?.querySelector('.detail-trailer-btn')?.remove();
        const tmdbId = series?.provider_tmdb_id || series?.providerTmdbId
            || series?.tmdb_id || series?.tmdb?.id || series?.metadata?.providerTmdbId;
        if (!tmdbId || /^(tt)?0+$/i.test(String(tmdbId)) || !window.NorvaCloud?.media?.tmdbMeta) return;
        try {
            const meta = await NorvaCloud.media.tmdbMeta({ type: 'series', tmdbId: String(tmdbId) });
            if (token !== this._ficheExtrasToken || !meta?.available) return;

            const plotEl = document.getElementById('series-plot');
            const people = [];
            const castNames = (meta.cast || []).slice(0, 6).map(c => c.name).filter(Boolean);
            if (castNames.length) people.push(`<span class="detail-credits-label">Cast</span> ${MediaUtils.escapeHtml(castNames.join(', '))}`);
            const makers = (meta.creators || []).length ? meta.creators : (meta.directors || []);
            if (makers.length) people.push(`<span class="detail-credits-label">Created by</span> ${MediaUtils.escapeHtml(makers.join(', '))}`);
            if (people.length && plotEl) {
                const credits = document.createElement('div');
                credits.className = 'detail-credits';
                credits.innerHTML = people.map(p => `<div class="detail-credits-row">${p}</div>`).join('');
                plotEl.insertAdjacentElement('afterend', credits);
            }

            if (meta.trailerKey) {
                const actions = this.detailsPanel?.querySelector('.series-detail-actions');
                if (actions && !actions.querySelector('.detail-trailer-btn')) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'btn btn-ghost detail-trailer-btn';
                    btn.innerHTML = '▶ Trailer';
                    btn.addEventListener('click', () =>
                        MediaUtils.openTrailerLightbox(meta.trailerKey, this.getSeriesDisplayTitle(series)));
                    actions.appendChild(btn);
                }
            }
        } catch (_) { /* extras are progressive enhancement */ }
    }

    // Recommendations must not inherit a catalogue search/year/rating. Doing so can
    // reduce the rail to the open title itself and leave the fiche visibly empty.
    recommendationLanguageParams() {
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
        return params;
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
            const payload = await API.media.genreItems({
                type: 'series', bucket, limit: 24, ...this.recommendationLanguageParams()
            });
            if (token !== this._mltToken || host.classList.contains('hidden')) return;
            const curKey = `${series?.sourceId}:${series?.series_id}`;
            const curTitleId = String(series?.title_id || series?.titleId || '');
            const items = (payload?.items || [])
                .filter(i => {
                    const itemTitleId = String(i?.title_id || i?.titleId || '');
                    if (curTitleId && itemTitleId && itemTitleId === curTitleId) return false;
                    return `${i.sourceId}:${i.series_id}` !== curKey;
                })
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
            if (this._isTvMode()) {
                const cards = [...rail.children].filter(card =>
                    !card.matches('.scroll-arrow, .empty-state'));
                cards.forEach((card, index) => {
                    card.classList.add('tv-more-like-card');
                    card.tabIndex = 0;
                    if (!card.hasAttribute('role')) card.setAttribute('role', 'button');
                    const backdrop = this.getSeriesBackdrop(items[index]);
                    const image = card.querySelector('img');
                    if (backdrop && image) {
                        image.removeAttribute('srcset');
                        image.src = backdrop;
                    }
                });
            }
        } catch (_) { /* the fiche works fine without related titles */ }
    }

    hideDetails() {
        const restoreTvGrid = this._isTvMode() &&
            this.pageEl?.classList.contains('series-detail-open');
        try { window.app?.forgetOpenFiche?.(); } catch (_) { /* noop */ }
        this._detailToken = (this._detailToken || 0) + 1;
        this._mltToken = (this._mltToken || 0) + 1;
        this._ficheExtrasToken = (this._ficheExtrasToken || 0) + 1;
        this.cancelNextEpisodePrompt();
        this.detailsPanel?.querySelector('.more-like-this')?.remove();
        if (this._epDlTimer) { clearInterval(this._epDlTimer); this._epDlTimer = null; }
        this.detailsPanel.classList.add('hidden');
        this.container.classList.remove('hidden');
        this.pageEl?.classList.remove('series-detail-open');
        this.currentSeries = null;
        this.currentSeriesGroup = null;
        this.currentSeriesInfo = null;

        if (restoreTvGrid) {
            const origin = this._tvDetailOriginCard?.isConnected
                ? this._tvDetailOriginCard
                : (this._tvPreviewCard?.isConnected
                    ? this._tvPreviewCard
                    : this.container?.querySelector('.series-card'));
            this._tvDetailOriginCard = null;
            if (origin) {
                this.previewCard(origin);
                requestAnimationFrame(() => {
                    if (origin.isConnected) {
                        origin.focus();
                        origin.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                    }
                });
            }
        }
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
        // The native "À suivre" overlay already ran its own countdown/choice:
        // chain straight into the next episode, no second prompt.
        if (detail.immediate) {
            this.cancelNextEpisodePrompt();
            this.playEpisode(nextEl);
            return;
        }
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

    async playEpisode(episodeEl, { fromStart = false } = {}) {
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
        // "Play from start" forces offset 0; otherwise resume where history left off.
        const resumeOffset = (!fromStart && h) ? this.getResumeOffset(h.progress, h.duration) : 0;
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
        // Follower label for the native player's end-of-stream "À suivre" overlay
        // (season boundaries included: the flat episode list is in play order).
        let nextEpisodeLabel = null;
        const flatEpisodes = this.seasonsContainer
            ? [...this.seasonsContainer.querySelectorAll('.episode-item')] : [];
        const flatIdx = flatEpisodes.indexOf(episodeEl);
        const nextEpisodeEl = flatIdx >= 0 ? flatEpisodes[flatIdx + 1] : null;
        if (nextEpisodeEl) {
            const nTitle = nextEpisodeEl.querySelector('.episode-title')?.textContent || '';
            const nNum = nextEpisodeEl.dataset.episodeNum
                || nextEpisodeEl.querySelector('.episode-number')?.textContent?.replace('E', '') || '';
            const nSeason = nextEpisodeEl.dataset.season
                || nextEpisodeEl.closest('.season-group')?.querySelector('.season-name')?.textContent?.match(/Season (\d+)/)?.[1]
                || seasonNum;
            nextEpisodeLabel = `S${nSeason} E${nNum}${nTitle ? ' - ' + nTitle : ''}`;
        }
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
            // TMDB id keys the cross-user skip-intro markers for this season.
            providerTmdbId: this.currentSeries?.provider_tmdb_id || this.currentSeries?.providerTmdbId
                || this.currentSeries?.tmdb?.id || null,
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
            audioTracks: this.currentSeries?.audioTracks || this.currentSeries?.audio_tracks || null,
            nextEpisodeLabel
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
    async queueEpisodeDownload(episodeEl, { includeNext = false } = {}) {
        const bridge = this.nativeDownloadBridge();
        if (!bridge || !episodeEl) return 'skip';
        const payload = await this.buildEpisodeDownloadPayload(episodeEl);
        if (!payload) return 'skip';
        // Smart downloads: attach the FOLLOWING episode's payload so the native
        // service can auto-queue it when this one completes (single-episode
        // downloads only — season batches already queue everything).
        if (includeNext) {
            const all = [...(this.seasonsContainer?.querySelectorAll('.episode-item') || [])];
            const nextEl = all[all.indexOf(episodeEl) + 1];
            if (nextEl && !['done', 'downloading', 'queued'].includes(
                this.episodeDownloadState(`${parseInt(nextEl.dataset.sourceId)}:${nextEl.dataset.episodeId}`))) {
                try {
                    payload.next = await this.buildEpisodeDownloadPayload(nextEl, { allowInFlight: true });
                } catch (_) { /* the chain link is optional */ }
            }
        }
        bridge.downloadMedia(JSON.stringify(payload));
        return 'queued';
    }

    /** Resolve one episode's direct URL + metadata into a native download payload. */
    async buildEpisodeDownloadPayload(episodeEl, { allowInFlight = false } = {}) {
        const episodeId = episodeEl.dataset.episodeId;
        const sourceId = parseInt(episodeEl.dataset.sourceId);
        const container = episodeEl.dataset.container || 'mp4';
        const id = `${sourceId}:${episodeId}`;
        const state = this.episodeDownloadState(id);
        if (!allowInFlight && (state === 'done' || state === 'downloading' || state === 'queued')) return null;
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
        return {
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
            await this.queueEpisodeDownload(episodeEl, { includeNext: true });
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
        // A season may not have been opened yet (episode rows render lazily), so its
        // .episode-list would be empty — materialize it before enumerating episodes.
        this._ensureSeasonBuilt(String(seasonNum));
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
                await API.favorites.add(series.sourceId, series.series_id, 'series', {
                    name: this.getSeriesDisplayTitle(series),
                    poster: this.getSeriesPoster(series),
                    type: 'series'
                });
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            await this.loadFavorites();
            this.filterAndRender();
        }
    }
}

window.SeriesPage = SeriesPage;
