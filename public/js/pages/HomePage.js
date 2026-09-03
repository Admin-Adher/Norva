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
        this.loadGeneration = 0;
        this.lastLoadedAt = 0;
        this.dashboardTtlMs = 60000;
        this.homeRequestTimeoutMs = 10000;
        this.homeRailDisplayLimit = 18;
        // Keep enough headroom for client-side language ranking without asking
        // the Edge endpoint to hydrate 60 cards (and up to 200 ranking
        // candidates) for every rail. Continue Watching has its own explicit
        // history limit of 60 below; catalogue rails only paint 18 cards.
        this.homeRailFetchLimit = 24;
        this._homeAbortControllers = new Set();
        this.railItems = [];
        this.historyItems = [];
        this.heroItem = null;
        this.contentPreferences = {};
        this.contentPreferenceKey = '';
        this._freshRailsPending = false;
        this.setupRefreshTimer = null;
        this.setupRecoverySession = null;
        this.setupRecoveryCooldowns = new Map();
        document.addEventListener('norva:source-health-changed', () => {
            this.lastLoadedAt = 0;
            if (this.app?.currentPage === 'home') {
                this.loadDashboardData();
            }
        });
        document.addEventListener('norva:title-rating-changed', () => {
            this.invalidateRatingRecommendations();
        });
        window.addEventListener('norva:notification-permission-changed', () => {
            if (this.app?.currentPage === 'home') {
                this.renderEcosystemCard(this.sourceSummary);
            }
        });

        // Hover preview (desktop): rails render via innerHTML + delegation, so the
        // preview data is resolved from the card's rail/history indices on demand.
        window.NorvaHoverPreview?.register('.dashboard-card', (card) => {
            // Only resolve for Home's own cards. Movies/Series rails render the same
            // `.dashboard-card` class but index into their own data — resolving those
            // against Home's rails would surface an unrelated title. Those pages pin
            // each card's `__norvaHover` (used before any resolver), but guard here too.
            if (this.app && this.app.currentPage && this.app.currentPage !== 'home') return null;
            let item = null;
            if (card.dataset.historyIndex !== undefined) {
                item = this.historyItems?.[Number(card.dataset.historyIndex)] || null;
            } else if (card.dataset.railIndex !== undefined) {
                const rail = this.railItems?.[Number(card.dataset.railIndex)];
                item = rail?.items?.[Number(card.dataset.itemIndex)] || null;
            }
            if (!item) return null;
            const isResume = card.dataset.historyIndex !== undefined;
            const type = item.item_type || item.itemType || item.type || 'movie';
            return {
                title: this.displayTitle(item),
                meta: this.cardMeta(item) || this.typeLabel(type),
                poster: this.resolveImageUrl(this.posterFromItem(item), ''),
                backdrop: this.backdropFromItem(item) ? this.resolveImageUrl(this.backdropFromItem(item), '') : null,
                onPlay: () => isResume || type === 'channel'
                    ? this.openRailItem(item, isResume)
                    : this.openRailItemWithAutoplay(item),
                onDetails: () => this.openRailItem(item, false)
            };
        });
    }

    /**
     * Hover-preview "Play": open the fiche through the normal path, then press
     * its primary action once it's enabled (resume-aware label and all).
     */
    openRailItemWithAutoplay(item) {
        this.openRailItem(item, false);
        // Guarded autoclick (home audit 2026-07-04): the old blind poll could press Play on a
        // DIFFERENT fiche if the user opened another title (or navigated away) inside its 3s
        // window — starting the wrong content. Token = superseded-by-newer-open; page check =
        // user left; title check = the visible fiche must be the one the click asked for.
        const token = (this._autoplayToken = (this._autoplayToken || 0) + 1);
        const wanted = String(this.displayTitle(item) || '').trim().toLowerCase();
        let tries = 0;
        const tick = () => {
            if (token !== this._autoplayToken) return;
            const page = String(this.app?.currentPage || '');
            if (page && page !== 'home' && page !== 'movies' && page !== 'series') return;
            const btn = document.querySelector(
                '#movie-details:not(.hidden) #movie-primary-action, '
                + '#series-details:not(.hidden) #series-primary-action');
            if (btn && !btn.disabled) {
                const shownEl = document.querySelector(
                    '#movie-details:not(.hidden) #movie-detail-title, '
                    + '#series-details:not(.hidden) h3, #series-details:not(.hidden) h1');
                const shown = String(shownEl?.textContent || '').trim().toLowerCase();
                if (!wanted || !shown || shown.includes(wanted) || wanted.includes(shown)) btn.click();
                return;
            }
            if (++tries < 12) setTimeout(tick, 250);
        };
        setTimeout(tick, 200);
    }

    async init() {
        // Initialization if needed.
    }

    // Foreground SWR (called when the app returns to the foreground while Home is the
    // active page): refetch history + rails so a title corrected/merged in the background
    // shows without a manual reload. Throttled by the same warm-DOM TTL used by show(), so
    // a brief tab-blur → focus is a no-op; only a real "was away a while" return refetches.
    // Reuses the exact path the source-health-changed handler already uses.
    maybeRevalidate() {
        if (this.isLoading) return;
        if (this.lastLoadedAt && Date.now() - this.lastLoadedAt < this.dashboardTtlMs) return;
        this.lastLoadedAt = 0;
        this.loadDashboardData();
    }

    invalidateRatingRecommendations() {
        this.lastLoadedAt = 0;
        this._freshRailsPending = true;
        try { window.API?.media?.clearRailCache?.(); } catch (_) { /* best-effort */ }
        try { window.NorvaCatalogCache?.remove?.(this.homeCacheKey()); } catch (_) { /* best-effort */ }

        if (this.app?.currentPage !== 'home') return;
        // A refresh already in flight may have started before the confirmed rating.
        // Retire that generation so it cannot repaint stale personalized rails.
        if (this.isLoading) this.cancelPendingLoad();
        this.loadDashboardData({ skipCache: true, freshRails: true });
    }

    async show() {
        const _homeDone = window.NorvaTrace?.time?.('HomePage.show() — home rails');
        const _firstPaintSummary = () => {
            // Print the whole refresh timeline once, at the first Home paint — not on
            // every in-app navigation back to Home (that would spam the console).
            if (window.__norvaSummaryPrinted) return;
            window.__norvaSummaryPrinted = true;
            window.NorvaTrace?.summary?.();
        };
        if (!document.getElementById('home-content')) {
            this.renderLayout();
        } else {
            this.container = document.getElementById('home-content');
        }

        const preferencesChanged = await this.refreshContentPreferences();
        if (preferencesChanged) {
            this.lastLoadedAt = 0;
        }

        if (this.lastLoadedAt && Date.now() - this.lastLoadedAt < this.dashboardTtlMs) {
            this.updateScrollArrows();
            this._startHeroRotation(); // hide() stops the rotation — resume it on the warm DOM
            if (_homeDone) _homeDone('served from warm in-memory DOM (no fetch)');
            _firstPaintSummary();
            return;
        }

        await this.loadDashboardData();
        if (_homeDone) _homeDone('rails fetched + rendered');
        _firstPaintSummary();
    }

    hide() {
        // Keep the dashboard DOM warm so returning to Home feels instant — but stop the
        // background work: the 9s hero rotation and the setup-gate poll have no business
        // ticking on Live TV, Settings or during playback (home audit 2026-07-04).
        if (this._heroTimer) { clearInterval(this._heroTimer); this._heroTimer = null; }
        if (this.setupRefreshTimer) { clearTimeout(this.setupRefreshTimer); this.setupRefreshTimer = null; }
    }

    renderLayout() {
        const pageHome = document.getElementById('page-home');
        if (!pageHome) return;

        pageHome.innerHTML = `
            <div class="dashboard-content" id="home-content">
                <section id="home-loading-state" class="home-loading-state tv-home-loading-state" role="status" aria-live="polite">
                    <div class="tv-home-loading-copy">
                        <span>Norva Home</span>
                        <strong>Building your screen</strong>
                        <p>Loading your picks, progress and connected catalogue.</p>
                    </div>
                    <div class="tv-home-loading-visual" aria-hidden="true">
                        <i class="tv-home-loading-hero"></i>
                        <i class="tv-home-loading-title"></i>
                        <span>${'<i></i>'.repeat(6)}</span>
                    </div>
                </section>
                <section id="home-service-health" class="dashboard-section hidden"></section>

                <section class="home-hero-section hidden" id="home-hero"></section>

                <section id="home-ecosystem" class="dashboard-section home-ecosystem-card hidden"
                    aria-labelledby="home-ecosystem-title"></section>

                <section class="dashboard-section hidden" id="continue-watching-section">
                    <div class="section-header">
                        <h2>Continue Watching</h2>
                    </div>
                    ${this.scrollSection('continue-watching-list', 'Loading history...')}
                </section>

                <!-- The viewer's OWN content (list + channels) sits right under Continue
                     Watching, Netflix-style — it used to be buried below ~10 algorithmic
                     rails, several screen-heights of scrolling away (home audit 2026-07-04). -->
                <section class="dashboard-section hidden" id="my-list-section">
                    <div class="section-header">
                        <h2>My List</h2>
                    </div>
                    ${this.scrollSection('my-list-list', 'Loading your list...')}
                </section>

                <section class="dashboard-section hidden" id="favorite-channels-section">
                    <div class="section-header">
                        <h2>Favorite Channels</h2>
                    </div>
                    ${this.scrollSection('favorite-channels-list', 'Loading favorites...', 'channel-tiles')}
                </section>

                <div id="home-rails">
                    <section class="dashboard-section">
                        <div class="section-header">
                            <h2>Selection Norva</h2>
                        </div>
                        <div class="horizontal-scroll">${window.MediaUtils.skeletonCards(8)}</div>
                    </section>
                </div>
            </div>
        `;

        this.container = document.getElementById('home-content');
        this.initScrollArrows();

        // Delegated interactions on the persistent container (survives innerHTML swaps):
        // — retry button of the "couldn't load" empty state;
        // — keyboard access for every card (they are plain divs: without this, desktop
        //   keyboard/screen-reader users could not activate anything on Home — the spatial
        //   nav helper only runs in TV mode).
        if (!this.container.dataset.homeDelegates) {
            this.container.dataset.homeDelegates = '1';
            this.container.addEventListener('click', (e) => {
                if (e.target.closest('[data-home-retry]')) {
                    this.lastLoadedAt = 0;
                    this.loadDashboardData();
                    return;
                }
                if (e.target.closest('[data-open-live]')) {
                    this.app?.navigateTo?.('live');
                    return;
                }
                if (e.target.closest('[data-open-movies]')) {
                    this.app?.navigateTo?.('movies');
                    return;
                }
                if (e.target.closest('[data-open-series]')) {
                    this.app?.navigateTo?.('series');
                    return;
                }
                if (e.target.closest('[data-ecosystem-dismiss]')) {
                    try { localStorage.setItem('norva-ecosystem-card-dismissed-v1', '1'); } catch (_) { /* best effort */ }
                    document.getElementById('home-ecosystem')?.classList.add('hidden');
                    return;
                }
                const pairButton = e.target.closest('[data-ecosystem-pair]');
                if (pairButton) {
                    this.app?.openPairTvSheet?.(pairButton);
                    return;
                }
                const notificationsButton = e.target.closest('[data-ecosystem-notifications]');
                if (notificationsButton) {
                    const bridge = window.NorvaTVCloud || window.NodeCastNative;
                    if (typeof bridge?.requestNotificationPermission === 'function') {
                        notificationsButton.disabled = true;
                        notificationsButton.textContent = 'Opening permission...';
                        try {
                            bridge.requestNotificationPermission();
                        } catch (_) {
                            notificationsButton.disabled = false;
                            notificationsButton.textContent = 'Enable notifications';
                        }
                    }
                }
            });
            this.container.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                const card = e.target.closest('.dashboard-card, .channel-tile');
                if (!card) return;
                e.preventDefault();
                card.click();
            });
        }
    }

    setHomeLoadingState(active, {
        title = 'Building your screen',
        message = 'Loading your picks, progress and connected catalogue.'
    } = {}) {
        const state = document.getElementById('home-loading-state');
        if (!state) return;
        this.container?.classList.toggle('is-home-loading', active);
        state.classList.toggle('is-hidden', !active);
        state.setAttribute('aria-hidden', active ? 'false' : 'true');
        state.setAttribute('aria-busy', active ? 'true' : 'false');
        const titleEl = state.querySelector('strong');
        const messageEl = state.querySelector('p');
        if (titleEl) titleEl.textContent = title;
        if (messageEl) messageEl.textContent = message;
    }

    renderHomeLoadError() {
        this.setHomeLoadingState(false);
        const rails = document.getElementById('home-rails');
        if (!rails || this._paintedFromCache) {
            if (this._paintedFromCache) this._railsErrorNotice();
            return;
        }
        rails.innerHTML = `
            <section class="dashboard-section">
                <div class="premium-state premium-state-error" role="alert" data-home-state-panel="error">
                    <span class="premium-state-kicker">Norva Home</span>
                    <h3>Home needs another moment</h3>
                    <p>Your catalogue is still connected. We could not refresh this screen just now.</p>
                    <button class="btn btn-primary" data-home-retry type="button">Try again</button>
                </div>
            </section>`;
    }

    scrollSection(id, loadingText, extraClass = '', content = '') {
        // Skeleton cards instead of a bare spinner+text, so every rail matches the
        // main "Selection" rail's loading treatment (no layout jump on swap-in).
        const body = content || (window.MediaUtils?.skeletonCards
            ? window.MediaUtils.skeletonCards(8)
            : `<div class="loading-state"><div class="loading"></div><span>${this.escapeHtml(loadingText)}</span></div>`);
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
            const scrollContainer = wrapper.querySelector('.horizontal-scroll');
            if (scrollContainer && window.MediaUtils?.enhanceRailScroll) {
                window.MediaUtils.enhanceRailScroll(scrollContainer);
            }
            if (wrapper.dataset.scrollReady === '1') return;
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

    normalizeContentPreferences(settings = {}) {
        return window.MediaUtils?.normalizeContentPreferences
            ? window.MediaUtils.normalizeContentPreferences(settings || {})
            : (settings || {});
    }

    setContentPreferences(settings = {}) {
        const prefs = this.normalizeContentPreferences(settings);
        const key = [
            prefs.preferredAudioLanguage || '',
            prefs.preferredSubtitleLanguage || '',
            prefs.strictLanguageMatching ? 'strict' : 'soft',
            JSON.stringify(prefs.preferredGenres || []),
            prefs.preferredQuality || ''
        ].join('|');
        const changed = key !== this.contentPreferenceKey;
        this.contentPreferences = prefs;
        this.contentPreferenceKey = key;
        return changed;
    }

    async refreshContentPreferences() {
        if (!window.API?.settings?.get) return false;
        try {
            const settings = await this.boundedHomeTask(
                window.API.settings.get(),
                'content preferences'
            );
            return this.setContentPreferences(settings || {});
        } catch (err) {
            console.warn('[Dashboard] Unable to refresh content preferences:', err);
            return false;
        }
    }

    // Per-profile key for the persistent Home cache (history + rails). Scoped by
    // profile because history/continue-watching and personalized rails differ per
    // profile; NorvaCatalogCache already namespaces by account.
    homeCacheKey() {
        // The profiles API lives on NorvaCloud, not window.API — the old lookup silently
        // returned '' for every profile, so all profiles shared 'home-dashboard:default' and
        // a profile switch flashed the PREVIOUS profile's Continue Watching (home audit
        // 2026-07-04, privacy-relevant inside a household).
        let pid = '';
        try { pid = window.NorvaCloud?.profiles?.getActiveId?.() || window.API?.profiles?.getActiveId?.() || ''; } catch (_) { /* default scope */ }
        // Lang-scoped: rails carry localized titles/overviews, so a synopsis-language change
        // must not paint the previous language on cold load.
        const lang = window.NorvaCloud?.contentLanguage?.() || 'en';
        return 'home-dashboard:' + (pid || 'default') + ':' + lang;
    }

    boundedHomeTask(task, label, timeoutMs = this.homeRequestTimeoutMs) {
        let timer = null;
        const controller = typeof task === 'function' && typeof AbortController !== 'undefined'
            ? new AbortController()
            : null;
        if (controller) this._homeAbortControllers.add(controller);
        let running;
        try {
            running = typeof task === 'function' ? task(controller?.signal) : task;
        } catch (error) {
            if (controller) this._homeAbortControllers.delete(controller);
            return Promise.reject(error);
        }
        const timeout = new Promise((_, reject) => {
            timer = window.setTimeout(() => {
                controller?.abort();
                const error = new Error(`Home ${label || 'request'} timed out`);
                error.code = 'HOME_REQUEST_TIMEOUT';
                reject(error);
            }, timeoutMs);
        });
        return Promise.race([Promise.resolve(running), timeout])
            .finally(() => {
                if (timer !== null) window.clearTimeout(timer);
                if (controller) this._homeAbortControllers.delete(controller);
            });
    }

    cancelPendingLoad() {
        // Profile selection can happen while the locked background Home is still
        // waiting on requests made without the selected profile. Retire that
        // generation so it can neither block nor repaint the newly selected one.
        this.loadGeneration += 1;
        for (const controller of this._homeAbortControllers) controller.abort();
        this._homeAbortControllers.clear();
        this.isLoading = false;
        this.loadPromise = null;
    }

    isCurrentLoad(generation) {
        return generation === this.loadGeneration;
    }

    async loadDashboardData({ skipCache = false, freshRails = false } = {}) {
        if (this.isLoading) return this.loadPromise;
        const generation = ++this.loadGeneration;
        const forceFreshRails = Boolean(freshRails || this._freshRailsPending);
        this.isLoading = true;
        this.setHomeLoadingState(true);

        this.loadPromise = (async () => {
            try {
                // Stale-while-revalidate: if a previous Home is cached for this
                // profile, paint it immediately so a cold relaunch shows real content
                // (not skeletons) while the fresh data loads below. contentPreferences
                // is already applied (show() awaits settings first), so badges match.
                this._paintedFromCache = false;
                try {
                    // Skip the paint when the LAST known health state was gating (expired
                    // credentials, first-run): flashing yesterday's rails for the round-trip
                    // and then replacing them with the repair gate reads as a glitch.
                    const gatedBefore = this.sourceSummary && this.shouldShowSetupGate(this.sourceSummary);
                    const cached = !skipCache && !forceFreshRails && !gatedBefore
                        ? window.NorvaCatalogCache?.read?.(
                            this.homeCacheKey(),
                            { version: window.API?.catalogSignature?.() }
                        )
                        : null;
                    if (cached?.data?.rails) {
                        const ch = Array.isArray(cached.data.history) ? cached.data.history : [];
                        this.renderHistory(ch);
                        this.renderCloudRails(cached.data.rails);
                        this.renderHero(ch, this.railItems);
                        this._paintedFromCache = true;
                        this.setHomeLoadingState(false);
                    }
                } catch (_) { /* cache paint is best-effort */ }

                // Start the catalogue GETs (history + rails) up front, in parallel
                // with health/settings, so a ready home doesn't wait out a second
                // network round-trip. They're pure data fetches rendered only after
                // the setup-gate check; if the gate shows, the results go unused.
                const railFetchLimit = Math.max(this.homeRailDisplayLimit, this.homeRailFetchLimit);
                // limit=60 (not 18): finished/too-short rows are filtered CLIENT-side, so a
                // user who recently completed a dozen titles used to get an under-filled (or
                // empty) Continue Watching while resumable older titles sat beyond the window.
                const historyP = this.boundedHomeTask(
                    window.API.request('GET', '/history?limit=60'),
                    'history'
                );
                const railsP = this.boundedHomeTask(
                    (signal) => window.API.request(
                        'GET',
                        `/home/rails?limit=${railFetchLimit}`
                        + (forceFreshRails ? `&fresh=${Date.now()}-${generation}` : ''),
                        null,
                        { signal }
                    ),
                    'rails'
                );
                // A cold personalized Home can still spend several seconds on
                // history/rating ranking. In parallel, read the generation-
                // fenced genre materialisation used by Movies and Series. It is
                // already bounded and gives an uncached Home real catalogue
                // content quickly; the complete personalized rails replace this
                // provisional paint as soon as they arrive.
                const fastRailsP = this._paintedFromCache
                    ? Promise.resolve(null)
                    : this.boundedHomeTask(async (signal) => {
                        const [movies, series] = await Promise.allSettled([
                            window.API.request('GET', '/media/genre-rails?type=movie&limit=12', null, { signal }),
                            window.API.request('GET', '/media/genre-rails?type=series&limit=12', null, { signal })
                        ]);
                        const movieRails = movies.status === 'fulfilled' && Array.isArray(movies.value?.rails)
                            ? movies.value.rails.slice(0, 2)
                            : [];
                        const seriesRails = series.status === 'fulfilled' && Array.isArray(series.value?.rails)
                            ? series.value.rails.slice(0, 1)
                            : [];
                        const rails = [...movieRails, ...seriesRails];
                        return rails.length ? { contract: 'norva.home.fast-rails.v1', rails } : null;
                    }, 'fast rails');

                const [healthResult, settingsResult] = await Promise.allSettled([
                    this.boundedHomeTask(
                        this.app?.refreshSourceHealth?.() || window.NorvaSourceHealth?.loadSummary?.(),
                        'source health'
                    ),
                    this.boundedHomeTask(window.API.settings.get(), 'settings')
                ]);
                if (!this.isCurrentLoad(generation)) return;

                if (settingsResult.status === 'fulfilled') {
                    this.setContentPreferences(settingsResult.value || {});
                }

                const sourceSummary = healthResult.status === 'fulfilled' && healthResult.value
                    ? healthResult.value
                    : null;

                this.sourceSummary = sourceSummary || null;
                if (sourceSummary) {
                    this.renderServiceHealth(sourceSummary);
                }
                this.renderEcosystemCard(sourceSummary);

                if (this.shouldShowSetupGate(sourceSummary)) {
                    // Gate is showing; the in-flight fetches are unused — attach a
                    // handler so a rejection never surfaces as an unhandled rejection.
                    Promise.allSettled([historyP, railsP, fastRailsP]);
                    this.renderSetupGate(sourceSummary || {});
                    this.lastLoadedAt = Date.now();
                    return;
                }

                this.clearSetupGate();
                this.renderImportRibbon(sourceSummary);

                if (!this._paintedFromCache) {
                    const earlyRails = await Promise.race([
                        railsP.then(() => null, () => null),
                        fastRailsP.catch(() => null)
                    ]);
                    if (!this.isCurrentLoad(generation)) return;
                    if (earlyRails?.rails?.length) {
                        this.renderCloudRails(earlyRails);
                        this.renderHero([], this.railItems);
                        this.setHomeLoadingState(false);
                    }
                }

                const [historyResult, railsResult, favoritesResult] = await Promise.allSettled([
                    historyP,
                    railsP,
                    this.boundedHomeTask(this.renderFavoriteChannels(), 'favorite channels')
                ]);
                if (!this.isCurrentLoad(generation)) return;
                this.renderMyList();

                const history = historyResult.status === 'fulfilled' && Array.isArray(historyResult.value)
                    ? historyResult.value
                    : [];

                this.renderHistory(history);

                if (railsResult.status === 'fulfilled') {
                    this.renderCloudRails(railsResult.value);
                    this.renderHero(history, this.railItems);
                    this._freshRailsPending = false;
                    // Cache this Home for an instant next cold launch (SWR).
                    try {
                        window.NorvaCatalogCache?.write?.(this.homeCacheKey(), {
                            history,
                            rails: railsResult.value
                        }, { version: window.API?.catalogSignature?.() });
                    } catch (_) { /* best-effort */ }
                } else {
                    console.warn('[Dashboard] Home rails unavailable:', railsResult.reason);
                    if (this._paintedFromCache) {
                        // The SWR paint already shows real (cached) rails — keep them instead
                        // of overwriting good content with a degraded fallback, and let the
                        // service-health banner carry the "temporarily unavailable" message.
                        this._railsErrorNotice();
                    } else {
                        await this.boundedHomeTask(this.renderFallbackRails(), 'fallback rails');
                        if (!this.isCurrentLoad(generation)) return;
                        this.renderHero(history, this.railItems);
                    }
                }

                if (favoritesResult.status === 'rejected') {
                    console.warn('[Dashboard] Favorites unavailable:', favoritesResult.reason);
                }

                this.lastLoadedAt = Date.now();
            } catch (err) {
                if (!this.isCurrentLoad(generation)) return;
                console.error('[Dashboard] Error loading data:', err);
                this.renderHomeLoadError();
            } finally {
                if (this.isCurrentLoad(generation)) {
                    this.setHomeLoadingState(false);
                    this.isLoading = false;
                    this.loadPromise = null;
                }
            }
        })();

        return this.loadPromise;
    }

    // Home rails are empty. If a service is still syncing, say so and point at the
    // content that is already browsable, instead of the "no service configured" copy.
    renderHomeRailsEmptyState() {
        const summary = this.sourceSummary || {};
        if (summary.state === 'syncing') {
            const manager = this.app?.sourceManager || window.app?.sourceManager;
            const source = this.syncingSourceFromSummary(summary);
            const preparation = manager?.catalogPreparationView?.(source || {});
            const progress = preparation?.progress || {};
            const percent = Math.max(0, Math.min(100, Math.round(Number(progress.percent) || 0)));
            const policy = window.NorvaSourceHealth?.catalogAvailability?.(summary) || {};
            const liveReady = policy.categories?.live === true;
            const moviesReady = policy.categories?.movies === true;
            const seriesReady = policy.categories?.series === true;
            const cinemaReady = moviesReady || seriesReady;
            const fullyReady = liveReady && moviesReady && seriesReady;
            if (!this.setupRefreshTimer) {
                this.setupRefreshTimer = setTimeout(() => {
                    this.setupRefreshTimer = null;
                    if (this.app?.currentPage !== 'home') return;
                    this.lastLoadedAt = 0;
                    this.loadDashboardData();
                }, 4000);
            }
            return `
                <section class="norva-setup-building norva-setup-building-home home-sync-hint home-state-panel" role="status" aria-live="polite">
                    <div class="norva-setup-building-copy">
                        <p class="norva-setup-kicker">${fullyReady ? 'Your full library is ready' : cinemaReady ? 'Your cinema is ready' : liveReady ? 'Live TV is ready' : 'Building your cinema'}</p>
                        <h2>${cinemaReady || liveReady ? 'Start watching while the import continues' : 'Movies and series are arriving'}</h2>
                        <p>${fullyReady
                            ? 'Movies, series and Live TV are now available.'
                            : cinemaReady
                                ? 'Open each ready section now. Live TV is added last in the background.'
                                : liveReady
                                    ? 'Open Live TV now. Movies and series will appear as soon as their first batches are ready.'
                                    : 'Movies and series unlock from their first ready batch. Live TV follows last.'}</p>
                        <div class="norva-setup-building-actions">
                            ${moviesReady ? '<button type="button" class="btn btn-primary" data-open-movies>Open Movies</button>' : ''}
                            ${seriesReady ? `<button type="button" class="btn ${moviesReady ? 'btn-secondary' : 'btn-primary'}" data-open-series>Open Series</button>` : ''}
                            ${liveReady ? `<button type="button" class="btn ${cinemaReady ? 'btn-secondary' : 'btn-primary'}" data-open-live>Open Live</button>` : ''}
                        </div>
                    </div>
                    ${this.renderSetupPosterStrip()}
                    ${this.renderSetupProgressBar(percent)}
                </section>
            `;
        }
        // "Add a service" copy is ONLY honest for a genuinely unconfigured account. For a
        // connected user whose rails fetch failed (or produced nothing), it was factually
        // wrong and dead-ended them (home audit 2026-07-04) — offer a retry instead.
        if (summary.state === 'not_configured' || !summary.state) {
            return `
                <section class="dashboard-section">
                    <div class="empty-state hint home-state-panel" role="status">Add a TV service from Settings to build your Home.</div>
                </section>
            `;
        }
        return `
            <section class="dashboard-section">
                <div class="empty-state hint home-state-panel home-state-panel-error" role="alert">
                    <strong>We couldn't load your Home right now</strong>
                    <p>Your services are fine — this is a temporary hiccup.</p>
                    <button class="btn btn-secondary" data-home-retry type="button">Retry</button>
                </div>
            </section>
        `;
    }

    // Small non-destructive notice when a rails refresh fails while cached rails are showing.
    _railsErrorNotice() {
        const container = document.getElementById('home-rails');
        if (!container || container.querySelector('[data-rails-stale-notice]')) return;
        const note = document.createElement('div');
        note.setAttribute('data-rails-stale-notice', '');
        note.className = 'empty-state hint home-state-inline';
        note.textContent = "Showing your last Home — we couldn't refresh it just now.";
        container.prepend(note);
        setTimeout(() => { try { note.remove(); } catch (_) { /* gone */ } }, 8000);
    }

    shouldShowSetupGate(summary = null) {
        if (!summary) return true;
        const policy = window.NorvaSourceHealth?.catalogAvailability?.(summary);
        if (policy) return policy.gate === true;
        if (summary.state === 'ready') return false;
        // API outage (state 'unknown'): we could not LIST the sources — that is not the same
        // as having none. Never take over Home with the onboarding gate for a blip; the
        // service-health banner carries the "can't reach" message over cached rails.
        if (summary.state === 'unknown') return false;
        if ((summary.ready || []).length) return false;
        // Non-blocking onboarding uses the shared authoritative `usable` policy.
        // Discovery counts and intermediate stage names are not enough: the server can
        // publish them before rows are materialized. Once the shared policy says the
        // catalog is browsable, keep the remaining long-tail import in the background.
        if (summary.state === 'syncing' && this.syncImportBrowsable(summary)) return false;
        return true;
    }

    // Compatibility seam for existing callers; the shared policy owns the decision.
    syncImportBrowsable(summary = {}) {
        const policy = window.NorvaSourceHealth?.catalogAvailability?.(summary);
        if (policy) return policy.browsable === true;
        return false;
    }

    clearSetupGate() {
        if (this.setupRefreshTimer) {
            clearTimeout(this.setupRefreshTimer);
            this.setupRefreshTimer = null;
        }
        this.setupRecoverySession?.cancel?.();
        this.setupRecoverySession = null;
        document.getElementById('page-home')?.classList.remove('home-setup-active', 'home-setup-connect-active', 'home-service-paused-active');
        document.getElementById('home-service-health')?.classList.remove('setup-suppressed');
        document.getElementById('home-hero')?.classList.remove('hidden');
        document.getElementById('continue-watching-section')?.classList.remove('hidden');
        document.getElementById('favorite-channels-section')?.classList.remove('hidden');
    }

    notificationPermissionState() {
        const bridge = window.NorvaTVCloud || window.NodeCastNative;
        if (typeof bridge?.notificationPermissionState !== 'function') return 'unavailable';
        try {
            const state = String(bridge.notificationPermissionState() || '').toLowerCase();
            return ['granted', 'prompt', 'denied'].includes(state) ? state : 'unavailable';
        } catch (_) {
            return 'unavailable';
        }
    }

    renderEcosystemCard(summary = this.sourceSummary) {
        const container = document.getElementById('home-ecosystem');
        if (!container) return;

        const isPhoneApp = Boolean(this.app?.isNativePhoneShell?.());
        const isCloud = Boolean(this.app?.currentUser?.cloud || window.API?.isCloudMode?.());
        const ready = Boolean(this.app?.isCatalogReady?.(summary));
        let dismissed = false;
        try { dismissed = localStorage.getItem('norva-ecosystem-card-dismissed-v1') === '1'; } catch (_) { /* best effort */ }

        if (!isPhoneApp || !isCloud || !ready || dismissed) {
            container.classList.add('hidden');
            container.innerHTML = '';
            return;
        }

        const permissionState = this.notificationPermissionState();
        const notificationPrompt = permissionState === 'prompt'
            ? `
                <div class="home-ecosystem-notifications">
                    <span>
                        <strong>Know when Norva is ready</strong>
                        <small>Get a notification when imports and subtitles finish.</small>
                    </span>
                    <button type="button" class="btn btn-secondary" data-ecosystem-notifications>Enable notifications</button>
                </div>`
            : '';

        container.innerHTML = `
            <div class="home-ecosystem-surface">
                <button type="button" class="home-ecosystem-dismiss" data-ecosystem-dismiss
                    aria-label="Dismiss TV setup tip">
                    <img src="/img/icons/norva-close-simple.svg?v=1" alt="" aria-hidden="true">
                </button>

                <div class="home-ecosystem-copy">
                    <span class="home-ecosystem-kicker">TV setup · about a minute</span>
                    <h2 id="home-ecosystem-title">Ready for the big screen?</h2>
                    <p>Open Norva on your TV, enter the code, and keep watching with the same account.</p>
                </div>

                <div class="home-ecosystem-visual" aria-hidden="true">
                    <div class="home-ecosystem-tv">
                        <div class="home-ecosystem-tv-screen">
                            <div class="home-ecosystem-brand">
                                <img src="/img/norva-app-icon-96.png?v=1" width="20" height="20"
                                    alt="" aria-hidden="true" decoding="async" draggable="false">
                            </div>
                            <span class="home-ecosystem-code-label">Pairing code</span>
                            <strong class="home-ecosystem-code">K7M 4Q9</strong>
                            <small>Enter this code on your phone</small>
                        </div>
                        <span class="home-ecosystem-tv-stand"></span>
                    </div>
                    <svg class="home-ecosystem-connection" viewBox="0 0 640 420"
                        preserveAspectRatio="none" aria-hidden="true">
                        <path d="M354 209C405 209 425 257 467 257"></path>
                        <circle cx="435" cy="251" r="7"></circle>
                    </svg>
                    <div class="home-ecosystem-phone">
                        <span class="home-ecosystem-phone-camera"></span>
                        <div class="home-ecosystem-phone-status">
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="m7.5 12.5 3 3 6-7"></path>
                            </svg>
                            <strong>TV connected</strong>
                            <small>Ready to watch</small>
                        </div>
                    </div>
                </div>

                <div class="home-ecosystem-actions">
                    <button type="button" class="btn btn-primary" data-ecosystem-pair>Pair a TV</button>
                    <a class="home-ecosystem-install"
                        href="https://play.google.com/store/apps/details?id=tv.norva.tv"
                        target="_blank" rel="noopener noreferrer">
                        <span>Need the TV app?</span><strong>Get it on Google Play</strong>
                    </a>
                </div>
            </div>
            ${notificationPrompt}
        `;
        container.classList.remove('hidden');
    }

    renderSetupGate(summary = {}) {
        const container = document.getElementById('home-rails');
        if (!container) return;

        if (this.setupRefreshTimer) {
            clearTimeout(this.setupRefreshTimer);
            this.setupRefreshTimer = null;
        }

        document.getElementById('home-hero')?.classList.add('hidden');
        document.getElementById('continue-watching-section')?.classList.add('hidden');
        document.getElementById('favorite-channels-section')?.classList.add('hidden');
        document.getElementById('home-service-health')?.classList.add('setup-suppressed');
        document.getElementById('page-home')?.classList.add('home-setup-active');
        document.getElementById('page-home')?.classList.remove('home-service-paused-active');

        const state = summary.state || 'not_configured';
        const copy = this.setupCopy(summary);
        const steps = this.setupSteps(state);
        const secondaryLabel = copy.secondary || 'Check again';
        const showSecondary = secondaryLabel && secondaryLabel !== copy.primary;

        if (state === 'disabled' && !this.isPairedScreen()) {
            this.renderPausedServicesGate(container, summary);
            return;
        }

        if (state === 'not_configured' && !this.isPairedScreen()) {
            this.renderSetupConnectionGate(container, summary, steps);
            return;
        }
        document.getElementById('page-home')?.classList.remove('home-setup-connect-active');

        if (state === 'syncing') {
            this.renderSetupSyncingGate(container, summary);
            return;
        }

        container.innerHTML = `
            <section class="norva-setup-gate" data-setup-state="${this.escapeAttr(state)}" data-paired-screen="${this.isPairedScreen() ? 'true' : 'false'}">
                <div class="norva-setup-card">
                    <div class="norva-setup-kicker">Norva setup</div>
                    <h1>${this.escapeHtml(copy.title)}</h1>
                    <p>${this.escapeHtml(copy.message)}</p>
                    <div class="norva-setup-actions">
                        <button class="btn btn-primary" id="norva-setup-primary">${this.escapeHtml(copy.primary)}</button>
                        ${showSecondary ? `<button class="btn btn-secondary" id="norva-setup-refresh">${this.escapeHtml(secondaryLabel)}</button>` : ''}
                    </div>
                </div>
                <div class="norva-setup-steps" role="list" aria-label="Norva setup progress">
                    ${steps.map((step, index) => `
                        <div class="norva-setup-step ${step.state}" role="listitem" ${['active', 'attention'].includes(step.state) ? 'aria-current="step"' : ''} aria-label="${this.escapeAttr(`Step ${index + 1}: ${step.title}. ${this.setupStepStatusLabel(step.state)}.`)}">
                            <span class="norva-setup-step-index" aria-hidden="true">${this.escapeHtml(step.index)}</span>
                            <div>
                                <strong>${this.escapeHtml(step.title)}</strong>
                                <span>${this.escapeHtml(step.hint)}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </section>
        `;

        container.querySelector('#norva-setup-primary')?.addEventListener('click', () => {
            if (copy.primaryAction === 'refresh') {
                this.lastLoadedAt = 0;
                this.loadDashboardData();
                return;
            }
            window.NorvaSourceHealth?.openAction?.(summary, this.app);
        });
        container.querySelector('#norva-setup-refresh')?.addEventListener('click', () => {
            this.lastLoadedAt = 0;
            this.loadDashboardData();
        });
        // (No syncing timer here: state === 'syncing' returns early into
        // renderSetupSyncingGate above, which schedules its own 4s poll.)
    }

    renderPausedServicesGate(container, summary = {}) {
        const pausedCount = Math.max(1, Number(summary.disabled?.length || summary.sources?.length || 0));
        const multiple = pausedCount > 1;
        const page = document.getElementById('page-home');
        page?.classList.remove('home-setup-connect-active');
        page?.classList.add('home-service-paused-active');

        container.innerHTML = `
            <section class="norva-paused-home" data-setup-state="disabled" aria-labelledby="norva-paused-home-title">
                <div class="norva-paused-home-main">
                    <div class="norva-paused-home-status" role="status">
                        <span class="norva-paused-home-dot" aria-hidden="true"></span>
                        <span>${multiple ? 'TV services paused' : 'TV service paused'}</span>
                        <span class="norva-paused-home-count">${this.escapeHtml(pausedCount)} saved</span>
                    </div>
                    <h1 id="norva-paused-home-title">${multiple ? 'All TV services are paused' : 'Your TV service is paused'}</h1>
                    <p>Your saved ${multiple ? 'catalogs are' : 'catalog is'} preserved. Enable ${multiple ? 'any service' : 'the service'} when you are ready to bring its channels, movies and series back.</p>
                    <div class="norva-paused-home-actions">
                        <button class="btn btn-primary" id="norva-paused-home-manage" type="button">Enable ${multiple ? 'a service' : 'service'}</button>
                    </div>
                    <ul class="norva-paused-home-assurances" aria-label="What stays safe while services are paused">
                        <li><strong>Catalog preserved</strong><span>Norva keeps the saved library while the service is paused.</span></li>
                        <li><strong>No automatic renewal</strong><span>Provider access dates and reminders remain separate.</span></li>
                    </ul>
                </div>
                <aside class="norva-paused-home-next" aria-label="Next step">
                    <img src="/img/icons/norva-live-tv.svg" alt="" aria-hidden="true">
                    <span>Next step</span>
                    <strong>Choose the service you want to enable.</strong>
                    <p>You can review its access period or login separately before syncing.</p>
                </aside>
            </section>
        `;

        container.querySelector('#norva-paused-home-manage')?.addEventListener('click', () => {
            window.NorvaSourceHealth?.openAction?.(summary, this.app);
        });
    }

    renderSetupPosterStrip() {
        return `
            <div class="norva-setup-poster-row" aria-hidden="true">
                ${Array.from({ length: 7 }, () => '<span class="norva-setup-poster"></span>').join('')}
            </div>
        `;
    }

    renderSetupProgressBar(percent = 0) {
        const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
        return `
            <div class="norva-setup-building-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100"${value ? ` aria-valuenow="${value}"` : ''} aria-label="Catalog import progress">
                <span style="width:${value}%"></span>
            </div>
            <p class="norva-setup-building-status">${value ? `${value}% · Movies and series first · Live TV last` : 'Connecting to your TV service'}</p>
        `;
    }

    renderImportRibbon(summary = {}) {
        const host = document.getElementById('home-content');
        if (!host) return;
        host.querySelector('#home-import-ribbon')?.remove();
        const policy = window.NorvaSourceHealth?.catalogAvailability?.(summary);
        if (!policy?.backgrounding) return;
        const ribbon = document.createElement('div');
        ribbon.id = 'home-import-ribbon';
        ribbon.className = 'norva-setup-import-ribbon';
        ribbon.setAttribute('role', 'status');
        ribbon.textContent = 'Still adding the rest of your library in the background.';
        host.prepend(ribbon);
    }

    renderSetupSyncingGate(container, summary = {}) {
        const manager = this.app?.sourceManager || window.app?.sourceManager;
        const source = this.syncingSourceFromSummary(summary);
        const type = source?.type || source?.source_type || source?.sourceType || 'xtream';
        const preparation = manager?.catalogPreparationView?.(source || {}, type);
        const sourceView = preparation?.source || source || {};
        const percent = Math.max(0, Math.min(100, Math.round(Number(preparation?.progress?.percent) || 0)));

        container.innerHTML = `
            <section class="norva-setup-gate norva-setup-building norva-setup-sync-embedded" data-setup-state="syncing">
                <div class="norva-setup-building-copy">
                    <div class="norva-setup-kicker">Building your cinema</div>
                    <h1>Your movies and series are arriving first</h1>
                    <p>Each cinema section unlocks from its first ready batch. Live TV is imported last.</p>
                    ${this.renderSetupProgressBar(percent)}
                    <div class="norva-setup-actions">
                        <button class="btn btn-secondary" id="norva-setup-sync-settings" type="button">TV Service settings</button>
                    </div>
                </div>
                <div class="norva-setup-sync-panel" aria-label="Catalog import progress">
                    ${this.renderSetupPosterStrip()}
                </div>
            </section>
        `;

        container.querySelector('#norva-setup-sync-settings')?.addEventListener('click', () => {
            this.app?.navigateTo?.('settings');
            setTimeout(() => this.app?.pages?.settings?.switchTab?.('sources'), 0);
        });

        this.maybeRecoverSetupCatalogFinalization(sourceView, type);

        const gateSourceId = sourceView.cloudId || sourceView.cloud_id || sourceView.id || sourceView.source_id || null;
        this.scheduleSetupSyncRefresh(container, gateSourceId, type, 0);
    }

    // Pendant l'import, rafraîchir SEULEMENT le panneau de progression (un GET de la
    // source + patch en place) au lieu d'un loadDashboardData complet toutes les 4 s :
    // moins de travail, zéro flicker, et l'élément barre survit aux ticks — condition
    // pour que sa transition CSS anime les paliers. Garde-fous : refresh complet dès
    // que la phase change (le gate doit basculer ready/error) et périodiquement
    // (toutes les ~32 s) au cas où l'état global aurait bougé autrement.
    scheduleSetupSyncRefresh(container, sourceId, type, tick = 0) {
        if (this.setupRefreshTimer) clearTimeout(this.setupRefreshTimer);
        this.setupRefreshTimer = setTimeout(async () => {
            if (this.app?.currentPage !== 'home') return;
            const fullRefresh = () => {
                this.lastLoadedAt = 0;
                this.loadDashboardData();
            };
            const manager = this.app?.sourceManager || window.app?.sourceManager;
            const api = window.API || (typeof API !== 'undefined' ? API : null);
            const panel = container.querySelector('.norva-setup-sync-panel');
            if (!panel || !panel.isConnected || !sourceId || tick >= 7 ||
                !manager?.catalogPreparationView || !api?.sources?.getById) {
                fullRefresh();
                return;
            }
            try {
                const latest = await api.sources.getById(sourceId);
                const preparation = manager.catalogPreparationView(latest || {}, type);
                if (preparation.phase === 'ready' || preparation.phase === 'error') {
                    fullRefresh();
                    return;
                }
                if (!preparation.patch(panel)) {
                    panel.innerHTML = preparation.render();
                }
                this.scheduleSetupSyncRefresh(container, sourceId, type, tick + 1);
            } catch (_) {
                fullRefresh();
            }
        }, 4000);
    }

    maybeRecoverSetupCatalogFinalization(sourceView = {}, type = 'xtream') {
        const manager = this.app?.sourceManager || window.app?.sourceManager;
        if (!manager?.catalogPreparationView || !manager?.startCatalogPreparationRecovery) return;
        const sourceId = manager.catalogPreparationView(sourceView, type).sourceId;
        if (!sourceId) return;

        const sourceKey = String(sourceId);
        const retryAt = Number(this.setupRecoveryCooldowns.get(sourceKey) || 0);
        if (retryAt && Date.now() < retryAt) return;
        if (this.setupRecoverySession?.sourceId === sourceKey && this.setupRecoverySession.isActive?.()) return;

        let session = null;
        const render = (latestSource) => {
            if (this.setupRecoverySession !== session || !session?.isActive?.() || this.app?.currentPage !== 'home') return;
            const preparation = manager.catalogPreparationView(latestSource || sourceView, type);
            const panel = document.querySelector('.norva-setup-sync-panel');
            if (panel) {
                // Patch-first : garder l'élément barre vivant pour que sa transition anime.
                if (!preparation.patch(panel)) {
                    panel.innerHTML = preparation.render();
                }
            }
        };

        session = manager.startCatalogPreparationRecovery(sourceView, { onProgress: render });
        if (!session) return;
        this.setupRecoverySession = session;
        session.promise
            .then(() => {
                if (this.setupRecoverySession !== session) return;
                this.setupRecoveryCooldowns.delete(sourceKey);
                this.lastLoadedAt = 0;
                document.dispatchEvent(new CustomEvent('norva:source-health-changed'));
                if (this.app?.currentPage === 'home') {
                    this.loadDashboardData();
                }
            })
            .catch(err => {
                this.setupRecoveryCooldowns.set(sourceKey, Date.now() + 60_000);
                console.warn('[HomePage] Catalog finalization recovery failed:', err);
            })
            .finally(() => {
                if (this.setupRecoverySession === session) this.setupRecoverySession = null;
            });
    }

    syncingSourceFromSummary(summary = {}) {
        const candidates = [
            ...(summary.issues || []),
            ...(summary.sources || [])
        ];
        return (candidates.find(item => item?.state === 'syncing') || candidates[0] || {})?.source || null;
    }

    renderSetupSyncFallback(summary = {}) {
        const steps = this.setupSteps(summary.state || 'syncing');
        return `
            <div class="norva-setup-steps" role="list" aria-label="Norva setup progress">
                ${steps.map((step, index) => `
                    <div class="norva-setup-step ${step.state}" role="listitem" ${['active', 'attention'].includes(step.state) ? 'aria-current="step"' : ''} aria-label="${this.escapeAttr(`Step ${index + 1}: ${step.title}. ${this.setupStepStatusLabel(step.state)}.`)}">
                        <span class="norva-setup-step-index" aria-hidden="true">${this.escapeHtml(step.index)}</span>
                        <div>
                            <strong>${this.escapeHtml(step.title)}</strong>
                            <span>${this.escapeHtml(step.hint)}</span>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    renderSetupConnectionGate(container, summary = {}, steps = []) {
        const manager = this.app?.sourceManager || window.app?.sourceManager;
        document.getElementById('page-home')?.classList.add('home-setup-connect-active');
        container.innerHTML = `
            <section class="norva-setup-gate norva-setup-connect" data-setup-state="not_configured" data-paired-screen="false">
                <div class="norva-setup-connect-card">
                    <div class="norva-setup-kicker">One step to watch</div>
                    <div class="norva-setup-flow-progress" data-setup-flow-progress data-setup-flow-steps="2" aria-label="Setup progress, 2 steps">
                        <span class="is-current" data-setup-flow-marker="connection"><i>1</i><b>Connect</b></span>
                        <span class="norva-setup-flow-line"></span>
                        <span class="hidden" data-setup-flow-marker="access" data-setup-flow-access-only hidden><i>2</i><b>Access</b></span>
                        <span class="norva-setup-flow-line hidden" data-setup-flow-access-only hidden></span>
                        <span data-setup-flow-marker="finish"><i data-setup-flow-finish-index>2</i><b>Finish</b></span>
                    </div>
                    <h1 data-setup-flow-title>Paste your TV service link</h1>
                    <p data-setup-flow-description>We’ll organize your catalog. Nothing else.</p>
                    <form class="norva-setup-inline-form" id="home-tv-service-form" data-setup-flow-step="connection" data-setup-connection-type="m3u" data-setup-assistance-view="connection" autocomplete="off" novalidate>
                        <div data-setup-connection-step>
                            <div data-setup-connection-main>
                                <div class="setup-mode-tabs" role="tablist" aria-label="Connection format">
                                    <button class="setup-mode-tab" id="home-source-mode-m3u" type="button" role="tab" aria-selected="true" aria-controls="home-source-panel-m3u" data-setup-mode="m3u">M3U link</button>
                                    <button class="setup-mode-tab" id="home-source-mode-xtream" type="button" role="tab" aria-selected="false" aria-controls="home-source-panel-xtream" data-setup-mode="xtream" tabindex="-1">Xtream login</button>
                                </div>
                                <input type="hidden" id="home-source-name" name="provider-display-name" value="">
                                <div class="setup-mode-panel" id="home-source-panel-m3u" role="tabpanel" aria-labelledby="home-source-mode-m3u" data-setup-panel="m3u">
                                    <div class="form-group">
                                        <label for="home-source-url">Full M3U or M3U8 link</label>
                                        <input type="url" id="home-source-url" class="form-input setup-form-input"
                                               placeholder="https://provider.example/get.php?…"
                                               name="provider-playlist-url" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false"
                                               aria-describedby="home-source-url-hint home-source-url-error">
                                        <p class="setup-form-hint" id="home-source-url-hint" role="status" aria-live="polite" aria-atomic="true">Usually found in your provider email or account area.</p>
                                        <p class="setup-field-error hidden" id="home-source-url-error"></p>
                                    </div>
                                </div>
                                <div class="setup-mode-panel" id="home-source-panel-xtream" role="tabpanel" aria-labelledby="home-source-mode-xtream" data-setup-panel="xtream" hidden>
                                    <div class="form-group">
                                        <label for="home-source-server">Server address</label>
                                        <input type="url" id="home-source-server" class="form-input setup-form-input"
                                               placeholder="https://provider.example:8080"
                                               name="provider-server-url" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false"
                                               aria-describedby="home-source-server-hint home-source-server-error">
                                        <p class="setup-form-hint" id="home-source-server-hint" role="status" aria-live="polite" aria-atomic="true">Paste a complete Xtream link to fill the login automatically.</p>
                                        <p class="setup-field-error hidden" id="home-source-server-error"></p>
                                    </div>
                                    <div class="setup-credentials-grid">
                                        <div class="form-group">
                                            <label for="home-source-username">Username</label>
                                            <input type="text" id="home-source-username" name="provider-login" class="form-input setup-form-input" placeholder="Username" autocomplete="off" autocapitalize="none" spellcheck="false" data-1p-ignore="true" data-lpignore="true" data-form-type="other" aria-describedby="home-source-username-error">
                                            <p class="setup-field-error hidden" id="home-source-username-error"></p>
                                        </div>
                                        <div class="form-group">
                                            <label for="home-source-password">Password</label>
                                            <div class="setup-password-field">
                                                <input type="password" id="home-source-password" name="provider-secret" class="form-input setup-form-input" placeholder="Password" autocomplete="new-password" data-1p-ignore="true" data-lpignore="true" data-form-type="other" aria-describedby="home-source-password-error">
                                                <button type="button" class="setup-password-toggle" id="home-source-password-toggle" aria-label="Show password" aria-pressed="false">${Icons.hide}</button>
                                            </div>
                                            <p class="setup-field-error hidden" id="home-source-password-error"></p>
                                        </div>
                                    </div>
                                </div>
                                <button class="setup-compatibility-help" type="button" data-setup-app-login-trigger>
                                    <span class="setup-compatibility-icon" aria-hidden="true">${Icons.info}</span>
                                    <span><strong>My provider only gave me an app login</strong><small>No M3U link or Xtream server details</small></span>
                                    <span class="setup-compatibility-arrow" aria-hidden="true">${Icons.chevronRight}</span>
                                </button>
                                <div class="setup-player-note"><span aria-hidden="true">${Icons.fingerprint}</span><span>Your service details are encrypted. Norva is a player and never supplies content.</span></div>
                            </div>
                            <section class="setup-assistance-panel" data-setup-app-login-panel aria-labelledby="home-app-login-title" hidden>
                                <button class="setup-back-button" type="button" data-setup-assist-back><span aria-hidden="true">${Icons.chevronRight}</span>Back to connection formats</button>
                                <span class="setup-assistance-icon" aria-hidden="true">${Icons.info}</span>
                                <h2 id="home-app-login-title" tabindex="-1">An app login cannot be imported directly</h2>
                                <p>Norva needs an <strong>M3U/M3U8 link</strong> or <strong>Xtream server credentials</strong> from your provider.</p>
                                <div class="setup-privacy-callout"><span aria-hidden="true">${Icons.fingerprint}</span><span>Do not enter your provider app password here.</span></div>
                                <button class="btn btn-primary setup-guide-open" type="button" data-setup-guide-open>How to get M3U or Xtream access</button>
                            </section>
                            <section class="setup-assistance-panel setup-access-guide" data-setup-access-guide aria-labelledby="home-access-guide-title" hidden>
                                <button class="setup-back-button" type="button" data-setup-guide-back><span aria-hidden="true">${Icons.chevronRight}</span>Back</button>
                                <h2 id="home-access-guide-title" tabindex="-1">Ask your provider for compatible access</h2>
                                <p>Look in your welcome email, account area or provider support.</p>
                                <div class="setup-access-formats" aria-label="Compatible formats">
                                    <div><span aria-hidden="true">${Icons.link}</span><span><strong>M3U / M3U8 playlist</strong><small>A complete URL, often ending in .m3u or containing get.php</small></span></div>
                                    <div><span aria-hidden="true">${Icons.fingerprint}</span><span><strong>Xtream access</strong><small>Server URL, username and password</small></span></div>
                                </div>
                                <div class="setup-provider-request">
                                    <strong>Message for your provider</strong>
                                    <div class="setup-provider-message" data-setup-provider-message>
                                        <p>Hello, could you please send me one of these access formats?</p>
                                        <ol>
                                            <li>My complete M3U/M3U8 playlist URL</li>
                                            <li>My Xtream Codes details: server URL (including the port), username and password</li>
                                        </ol>
                                        <p>Thank you.</p>
                                    </div>
                                </div>
                                <button class="btn btn-primary setup-copy-message" type="button" data-setup-copy-message>Copy message</button>
                                <p class="setup-copy-feedback" data-setup-copy-feedback role="status" aria-live="polite" aria-atomic="true"></p>
                            </section>
                        </div>
                        <div class="norva-setup-error hidden" id="home-tv-service-error" role="alert" aria-atomic="true" tabindex="-1"></div>
                        ${manager?.getProviderAccessTermsFields?.({ prefix: 'home-provider-access', onboarding: true, deferred: true }) || ''}
                        <button class="btn btn-primary norva-setup-submit" id="home-tv-service-submit" type="submit">Check playlist</button>
                    </form>
                </div>
            </section>
        `;
        this.bindSetupConnectionForm(container);
    }

    renderSetupProgressStep(step, index) {
        const stepMark = step.state === 'complete' ? Icons.check : String(index + 1);
        const lock = step.state === 'pending' ? `<span class="norva-setup-lock" aria-hidden="true">${Icons.circle}</span>` : '';
        return `
            <div class="norva-setup-step norva-setup-progress-step ${this.escapeAttr(step.state)}" role="listitem" ${['active', 'attention'].includes(step.state) ? 'aria-current="step"' : ''} aria-label="${this.escapeAttr(`Step ${index + 1}: ${step.title}. ${this.setupStepStatusLabel(step.state)}.`)}">
                <span class="norva-setup-step-index" aria-hidden="true">${stepMark}</span>
                <div>
                    <strong>${this.escapeHtml(index + 1)}. ${this.escapeHtml(step.title)}</strong>
                    <span>${this.escapeHtml(step.hint)}</span>
                </div>
                ${lock}
            </div>
        `;
    }

    setupStepStatusLabel(state) {
        return ({
            active: 'Current step',
            complete: 'Completed',
            attention: 'Needs attention',
            pending: 'Locked until the previous step is complete'
        })[state] || 'Pending';
    }

    setupConnectionFailureFamily(error = {}, type = 'xtream') {
        const payload = error?.payload || {};
        const code = String(payload.error_code || payload.errorCode || payload.code || error?.code || '').trim().toUpperCase();
        const status = Number(payload.status ?? payload.upstreamStatus ?? error?.status ?? error?.upstreamStatus);
        const message = String(error?.message || payload.message || '').toLowerCase();
        if (status === 401 || status === 403 || code.includes('CREDENTIAL') || code.includes('AUTH')) return 'credentials';
        if (status === 458 || code.includes('BUSY')) return 'provider_busy';
        if (status === 413 || code.includes('PAYLOAD_TOO_LARGE') || code.includes('RESPONSE_TOO_LARGE')) return 'payload_too_large';
        if (status === 408 || status === 504 || code.includes('TIMEOUT') || message.includes('timed out')) return 'timeout';
        if (status === 404 || code.includes('ENDPOINT_NOT_FOUND') || code.includes('NOT_FOUND')) return 'provider_unreachable';
        if ([502, 503].includes(status) || /DNS|TLS|CONNECTION|NETWORK|UNREACHABLE/.test(code)) return 'provider_unreachable';
        if (type === 'm3u' && ([400, 415, 422].includes(status) || /PLAYLIST|FORMAT|M3U/.test(code))) return 'format';
        if (message.includes('network') || message.includes('fetch')) return 'network';
        return 'unknown';
    }

    setupConnectionErrorCopy(error = {}, type = 'xtream') {
        const payload = error?.payload || {};
        const code = String(payload.error_code || payload.errorCode || payload.code || error?.code || '').trim().toUpperCase();
        const status = Number(payload.status ?? payload.upstreamStatus ?? error?.status ?? error?.upstreamStatus);
        const family = this.setupConnectionFailureFamily(error, type);
        if (status === 404 || code.includes('ENDPOINT_NOT_FOUND') || code.includes('NOT_FOUND')) {
            return {
                title: 'This provider address was not found',
                body: 'We reached the server, but this path does not exist. Check the complete link or server address.'
            };
        }
        if (family === 'credentials') {
            return {
                title: 'The provider rejected this login',
                body: 'Check the server address, username and password supplied by your provider.'
            };
        }
        if (family === 'provider_busy') {
            return {
                title: 'This TV service is busy',
                body: 'Your details were kept. Wait a few seconds, then try again.'
            };
        }
        if (family === 'payload_too_large') {
            return {
                title: 'This playlist contains an oversized entry',
                body: 'Your link was kept, but one playlist line exceeded the safe parsing limit. Ask your provider for a standard M3U or filtered playlist, then try again.'
            };
        }
        if (family === 'provider_unreachable' || family === 'timeout' || family === 'network') {
            return {
                title: 'Your provider server is not responding',
                body: 'Your details were kept. Try again in a few minutes, or ask your provider whether the server is online.'
            };
        }
        if (family === 'format') {
            return {
                title: 'This isn’t a complete playlist link',
                body: 'Paste the full M3U/M3U8 link from your provider. It may end in .m3u or include get.php.'
            };
        }
        return type === 'm3u'
            ? {
                title: 'Norva could not connect this playlist',
                body: 'Your link was kept. Check it with your provider, then try again.'
            }
            : {
                title: 'Norva could not connect this TV service',
                body: 'Check the server address and login, then try again.'
            };
    }

    bindSetupConnectionForm(container) {
        const form = container.querySelector('#home-tv-service-form');
        const m3uInput = container.querySelector('#home-source-url');
        const serverInput = container.querySelector('#home-source-server');
        const nameInput = container.querySelector('#home-source-name');
        const usernameInput = container.querySelector('#home-source-username');
        const passwordInput = container.querySelector('#home-source-password');
        const passwordToggle = container.querySelector('#home-source-password-toggle');
        const m3uHint = container.querySelector('#home-source-url-hint');
        const serverHint = container.querySelector('#home-source-server-hint');
        const error = container.querySelector('#home-tv-service-error');
        const submit = container.querySelector('#home-tv-service-submit');
        const connectionStep = container.querySelector('[data-setup-connection-step]');
        const connectionMain = container.querySelector('[data-setup-connection-main]');
        const appLoginTrigger = container.querySelector('[data-setup-app-login-trigger]');
        const appLoginPanel = container.querySelector('[data-setup-app-login-panel]');
        const accessGuide = container.querySelector('[data-setup-access-guide]');
        const guideOpen = container.querySelector('[data-setup-guide-open]');
        const copyMessage = container.querySelector('[data-setup-copy-message]');
        const copyFeedback = container.querySelector('[data-setup-copy-feedback]');
        const modeTabs = Array.from(container.querySelectorAll('[data-setup-mode]'));
        const modePanels = Array.from(container.querySelectorAll('[data-setup-panel]'));
        const accessTerms = form?.querySelector('[data-provider-access-terms]');
        const flowProgress = container.querySelector('[data-setup-flow-progress]');
        const accessOnlyProgressItems = Array.from(container.querySelectorAll('[data-setup-flow-access-only]'));
        const finishProgressIndex = container.querySelector('[data-setup-flow-finish-index]');
        const flowTitle = container.querySelector('[data-setup-flow-title]');
        const flowDescription = container.querySelector('[data-setup-flow-description]');
        const manager = this.app?.sourceManager || window.app?.sourceManager;
        if (!form || !m3uInput || !serverInput || !usernameInput || !passwordInput || !submit) return;
        const accessWizard = manager?.bindProviderAccessTerms?.(form);
        let accessWizardApproved = false;
        const defaultM3uHint = 'Usually found in your provider email or account area.';
        const defaultServerHint = 'Paste a complete Xtream link to fill the login automatically.';

        const fieldErrors = new Map([
            [m3uInput, container.querySelector('#home-source-url-error')],
            [serverInput, container.querySelector('#home-source-server-error')],
            [usernameInput, container.querySelector('#home-source-username-error')],
            [passwordInput, container.querySelector('#home-source-password-error')]
        ]);
        const clearSummaryError = () => {
            if (!error) return;
            error.classList.add('hidden');
            error.replaceChildren();
        };
        const clearFieldError = (input) => {
            input?.removeAttribute('aria-invalid');
            const message = fieldErrors.get(input);
            if (message) {
                message.textContent = '';
                message.classList.add('hidden');
            }
        };
        const clearErrors = () => {
            clearSummaryError();
            fieldErrors.forEach((_message, input) => clearFieldError(input));
        };
        const setFieldError = (input, message) => {
            if (!input) return;
            input.setAttribute('aria-invalid', 'true');
            const target = fieldErrors.get(input);
            if (target) {
                target.textContent = message;
                target.classList.remove('hidden');
            }
        };
        const showSummaryError = (value, { focus = false } = {}) => {
            if (!error) return;
            const copy = typeof value === 'string' ? { title: '', body: value } : (value || {});
            const fragment = document.createDocumentFragment();
            if (copy.title) {
                const title = document.createElement('strong');
                title.textContent = copy.title;
                fragment.append(title);
            }
            if (copy.body) {
                const body = document.createElement('span');
                body.textContent = copy.body;
                fragment.append(body);
            }
            error.replaceChildren(fragment);
            error.classList.remove('hidden');
            if (focus) {
                try { error.focus({ preventScroll: true }); } catch (_) { /* noop */ }
            }
        };
        const resetInputHint = (input) => {
            const hint = input === serverInput ? serverHint : m3uHint;
            if (!hint) return;
            hint.textContent = input === serverInput ? defaultServerHint : defaultM3uHint;
            delete hint.dataset.validationState;
        };
        const applyEarlyInputFeedback = (input, type) => {
            const feedback = manager?.sourceInputFeedback?.(input?.value, type);
            if (!input || !feedback) return null;
            if (feedback.pathShape && (!input.dataset.sourceInputPathShape || feedback.pathShape !== 'root')) {
                input.dataset.sourceInputPathShape = feedback.pathShape;
            }
            const hint = input === serverInput ? serverHint : m3uHint;
            if (feedback.state === 'invalid') {
                setFieldError(input, feedback.message);
                if (hint) {
                    hint.textContent = input === serverInput ? defaultServerHint : defaultM3uHint;
                    delete hint.dataset.validationState;
                }
                return feedback;
            }
            clearFieldError(input);
            if (hint && feedback.message) {
                hint.textContent = feedback.message;
                hint.dataset.validationState = feedback.state;
            }
            return feedback;
        };
        const selectedType = () => form.dataset.setupConnectionType === 'xtream' ? 'xtream' : 'm3u';
        const hasAccessStep = () => selectedType() === 'xtream' && Boolean(accessTerms);
        const activeUrlInput = () => selectedType() === 'xtream' ? serverInput : m3uInput;
        const connectionSubmitLabel = () => selectedType() === 'xtream' ? 'Connect source' : 'Check playlist';
        const updateFlowTopology = () => {
            const accessAvailable = hasAccessStep();
            accessOnlyProgressItems.forEach((item) => {
                item.hidden = !accessAvailable;
                item.classList.toggle('hidden', !accessAvailable);
            });
            if (finishProgressIndex) finishProgressIndex.textContent = accessAvailable ? '3' : '2';
            if (flowProgress) {
                const totalSteps = accessAvailable ? '3' : '2';
                flowProgress.dataset.setupFlowSteps = totalSteps;
                flowProgress.setAttribute('aria-label', `Setup progress, ${totalSteps} steps`);
            }
        };
        const updateSubmitVisibility = () => {
            const hidden = form.dataset.setupFlowStep === 'access' || form.dataset.setupAssistanceView !== 'connection';
            submit.hidden = hidden;
            submit.classList.toggle('hidden', hidden);
        };
        const setSubmitting = (busy, label = '') => {
            submit.disabled = busy;
            submit.textContent = label || connectionSubmitLabel();
            if (busy) submit.setAttribute('aria-busy', 'true');
            else submit.removeAttribute('aria-busy');
            if (accessTerms && form.dataset.setupFlowStep === 'access') {
                accessTerms.setAttribute('aria-busy', String(busy));
                accessTerms.querySelectorAll('button,input,select').forEach((control) => { control.disabled = busy; });
            }
        };

        const setConnectionMode = (nextMode) => {
            const mode = nextMode === 'xtream' ? 'xtream' : 'm3u';
            form.dataset.setupConnectionType = mode;
            accessWizardApproved = false;
            modeTabs.forEach((tab) => {
                const selected = tab.dataset.setupMode === mode;
                tab.setAttribute('aria-selected', String(selected));
                tab.tabIndex = selected ? 0 : -1;
            });
            modePanels.forEach((panel) => { panel.hidden = panel.dataset.setupPanel !== mode; });
            updateFlowTopology();
            clearErrors();
            if (!submit.disabled) submit.textContent = connectionSubmitLabel();
        };

        const showAssistanceView = (view, { focus = true, focusTarget = null } = {}) => {
            const next = ['connection', 'app-login', 'guide'].includes(view) ? view : 'connection';
            form.dataset.setupAssistanceView = next;
            if (connectionMain) connectionMain.hidden = next !== 'connection';
            if (appLoginPanel) appLoginPanel.hidden = next !== 'app-login';
            if (accessGuide) accessGuide.hidden = next !== 'guide';
            clearErrors();
            updateSubmitVisibility();
            if (!focus) return;
            const target = focusTarget || (next === 'app-login'
                ? appLoginPanel?.querySelector('h2')
                : next === 'guide'
                    ? accessGuide?.querySelector('h2')
                    : appLoginTrigger);
            requestAnimationFrame(() => {
                try { target?.focus({ preventScroll: true }); } catch (_) { /* noop */ }
            });
        };

        const setFlowStep = (step, { focus = true } = {}) => {
            const accessActive = step === 'access';
            form.dataset.setupFlowStep = step;
            container.querySelector('.norva-setup-connect-card')?.classList.toggle('is-access-step', accessActive);
            if (connectionStep) connectionStep.hidden = accessActive;
            if (accessTerms) accessTerms.hidden = !accessActive;
            updateSubmitVisibility();
            if (flowTitle) flowTitle.textContent = accessActive ? 'When can you use this service?' : 'Paste your TV service link';
            if (flowDescription) flowDescription.textContent = accessActive
                ? 'Add the access period now, or safely choose to do it later.'
                : 'We’ll organize your catalog. Nothing else.';
            container.querySelectorAll('[data-setup-flow-marker]').forEach((marker) => {
                const markerStep = marker.dataset.setupFlowMarker;
                marker.classList.toggle('is-current', markerStep === step);
                marker.classList.toggle('is-complete', accessActive && markerStep === 'connection');
            });
            if (accessActive) accessWizard?.showStep?.(0);
            else {
                accessWizardApproved = false;
                if (focus) requestAnimationFrame(() => activeUrlInput()?.focus({ preventScroll: true }));
            }
        };

        accessTerms?.addEventListener('norva:provider-access-cancel', () => setFlowStep('connection'));
        accessTerms?.addEventListener('norva:provider-access-complete', () => {
            accessWizardApproved = true;
            form.requestSubmit();
        });

        const applyParsedLink = (force = false) => {
            const currentPathShape = manager?.sourceInputPathShape?.(serverInput.value) || 'invalid';
            const parsed = manager?.parseXtreamLink?.(serverInput.value);
            if (!parsed) {
                if (serverHint) serverHint.textContent = 'Paste a complete Xtream link to fill the login automatically.';
                return null;
            }
            if (!serverInput.dataset.sourceInputPathShape || currentPathShape !== 'root') {
                serverInput.dataset.sourceInputPathShape = currentPathShape;
            }
            if (parsed.serverUrl) serverInput.value = parsed.serverUrl;
            if (nameInput && !nameInput.value.trim() && parsed.host) {
                nameInput.value = parsed.host.replace(/^www\./i, '');
            }
            if (parsed.username && (force || !usernameInput.value.trim())) usernameInput.value = parsed.username;
            if (parsed.password && (force || !passwordInput.value.trim())) passwordInput.value = parsed.password;
            if (serverHint) {
                serverHint.textContent = usernameInput.value.trim() && passwordInput.value.trim()
                    ? 'Login detected from the link. You can review it before connecting.'
                    : 'Server detected. Add the username and password if they were provided separately.';
            }
            clearFieldError(serverInput);
            if (usernameInput.value.trim()) clearFieldError(usernameInput);
            if (passwordInput.value.trim()) clearFieldError(passwordInput);
            return parsed;
        };

        modeTabs.forEach((tab, index) => {
            tab.addEventListener('click', () => setConnectionMode(tab.dataset.setupMode));
            tab.addEventListener('keydown', (event) => {
                let nextIndex = null;
                if (event.key === 'ArrowRight') nextIndex = (index + 1) % modeTabs.length;
                if (event.key === 'ArrowLeft') nextIndex = (index - 1 + modeTabs.length) % modeTabs.length;
                if (event.key === 'Home') nextIndex = 0;
                if (event.key === 'End') nextIndex = modeTabs.length - 1;
                if (nextIndex === null) return;
                event.preventDefault();
                const next = modeTabs[nextIndex];
                setConnectionMode(next.dataset.setupMode);
                next.focus();
            });
        });

        [m3uInput, serverInput].forEach((input) => {
            input.addEventListener('input', () => {
                delete input.dataset.sourceInputPathShape;
                resetInputHint(input);
            });
        });
        m3uInput.addEventListener('paste', () => setTimeout(() => applyEarlyInputFeedback(m3uInput, 'm3u'), 0));
        m3uInput.addEventListener('blur', () => applyEarlyInputFeedback(m3uInput, 'm3u'));
        m3uInput.addEventListener('change', () => applyEarlyInputFeedback(m3uInput, 'm3u'));
        serverInput.addEventListener('paste', () => setTimeout(() => {
            if (!applyParsedLink(true)) applyEarlyInputFeedback(serverInput, 'xtream');
        }, 0));
        serverInput.addEventListener('blur', () => {
            if (!applyParsedLink(false)) applyEarlyInputFeedback(serverInput, 'xtream');
        });
        serverInput.addEventListener('change', () => {
            if (!applyParsedLink(false)) applyEarlyInputFeedback(serverInput, 'xtream');
        });

        passwordToggle?.addEventListener('click', () => {
            const visible = passwordInput.type === 'text';
            passwordInput.type = visible ? 'password' : 'text';
            passwordToggle.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
            passwordToggle.setAttribute('aria-pressed', String(!visible));
        });

        fieldErrors.forEach((_message, input) => {
            input.addEventListener('input', () => {
                clearFieldError(input);
                clearSummaryError();
            });
        });

        appLoginTrigger?.addEventListener('click', () => showAssistanceView('app-login'));
        appLoginPanel?.querySelector('[data-setup-assist-back]')?.addEventListener('click', () => showAssistanceView('connection'));
        guideOpen?.addEventListener('click', () => showAssistanceView('guide'));
        accessGuide?.querySelector('[data-setup-guide-back]')?.addEventListener('click', () => showAssistanceView('app-login', { focusTarget: guideOpen }));

        const providerRequest = [
            'Hello, could you please send me one of these access formats?',
            '',
            '1. My complete M3U/M3U8 playlist URL',
            '2. My Xtream Codes details: server URL (including the port), username and password',
            '',
            'Thank you.'
        ].join('\n');
        const writeClipboard = async (value) => {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
                return;
            }
            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.append(textarea);
            textarea.select();
            const copied = document.execCommand?.('copy');
            textarea.remove();
            if (!copied) throw new Error('Clipboard unavailable');
        };
        let copyResetTimer = null;
        copyMessage?.addEventListener('click', async () => {
            copyMessage.disabled = true;
            if (copyResetTimer) clearTimeout(copyResetTimer);
            try {
                await writeClipboard(providerRequest);
                copyMessage.textContent = 'Copied';
                if (copyFeedback) copyFeedback.textContent = 'Message copied to clipboard.';
            } catch (_) {
                copyMessage.textContent = 'Copy message';
                if (copyFeedback) copyFeedback.textContent = 'Could not copy automatically. Select the message above to copy it.';
            } finally {
                copyMessage.disabled = false;
                copyResetTimer = setTimeout(() => {
                    copyMessage.textContent = 'Copy message';
                    if (copyFeedback) copyFeedback.textContent = '';
                }, 2200);
            }
        });

        const validateSelectedConnection = () => {
            const type = selectedType();
            const urlInput = activeUrlInput();
            const rawUrl = urlInput.value.trim();
            const feedback = manager?.sourceInputFeedback?.(rawUrl, type);
            const pathShape = feedback?.pathShape || manager?.sourceInputPathShape?.(rawUrl) || 'invalid';
            if (rawUrl && !urlInput.dataset.sourceInputPathShape) urlInput.dataset.sourceInputPathShape = pathShape;
            let firstInvalid = null;
            if (!rawUrl) {
                const message = type === 'm3u' ? 'Paste your complete M3U or M3U8 link.' : 'Enter the server address supplied by your provider.';
                setFieldError(urlInput, message);
                showSummaryError({
                    title: type === 'm3u' ? 'Add your playlist link' : 'Add your Xtream server',
                    body: message
                });
                firstInvalid = urlInput;
            } else if (feedback?.state === 'invalid' || pathShape === 'invalid' || pathShape === 'web_page') {
                const copy = type === 'm3u'
                    ? {
                        title: 'This isn’t a complete playlist link',
                        body: feedback?.message || 'Paste the full M3U/M3U8 link from your provider. It may end in .m3u or include get.php.'
                    }
                    : {
                        title: 'This isn’t a valid Xtream server address',
                        body: feedback?.message || 'Enter the complete http or https server address supplied by your provider.'
                    };
                setFieldError(urlInput, copy.body);
                showSummaryError(copy);
                firstInvalid = urlInput;
            }
            if (type === 'xtream') {
                if (!usernameInput.value.trim()) {
                    setFieldError(usernameInput, 'Enter the username supplied by your provider.');
                    firstInvalid = firstInvalid || usernameInput;
                }
                if (!passwordInput.value.trim()) {
                    setFieldError(passwordInput, 'Enter the password supplied by your provider.');
                    firstInvalid = firstInvalid || passwordInput;
                }
                if (!firstInvalid && pathShape !== 'invalid' && pathShape !== 'web_page') return true;
                if (rawUrl && (!usernameInput.value.trim() || !passwordInput.value.trim())) {
                    showSummaryError({
                        title: 'Complete your Xtream login',
                        body: 'Enter the server address, username and password supplied by your provider.'
                    });
                }
            }
            if (!firstInvalid) return true;
            if (rawUrl) {
                manager?.reportSourceConnectionValidationAttempt?.({
                    type,
                    url: rawUrl,
                    username: usernameInput.value,
                    password: passwordInput.value,
                    inputPathShape: urlInput.dataset.sourceInputPathShape || '',
                    failureFamily: type === 'xtream' && (!usernameInput.value.trim() || !passwordInput.value.trim())
                        ? 'missing_credentials'
                        : 'invalid_input'
                });
            }
            try { firstInvalid.focus({ preventScroll: true }); } catch (_) { /* noop */ }
            return false;
        };

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            clearErrors();

            if (!validateSelectedConnection()) return;

            let payload;
            let accessTerms = null;
            try {
                payload = this.readSetupConnectionForm(container);
                const needsAccessStep = payload.type === 'xtream' && manager?.providerAccessUiEnabled?.();
                if (needsAccessStep && !accessWizardApproved) {
                    setFlowStep('access');
                    return;
                }
                if (needsAccessStep) {
                    accessTerms = manager.readProviderAccessTerms(form);
                }
            } catch (validationError) {
                if (/^Enter a valid provider access /.test(String(validationError?.message || ''))) {
                    const fieldset = form.querySelector('[data-provider-access-terms]');
                    const accessError = fieldset?.querySelector('[data-access-error]');
                    const message = String(validationError.message);
                    if (accessError) {
                        accessError.textContent = message;
                        accessError.hidden = false;
                    }
                    const target = fieldset?.querySelector('[data-access-wizard-stage]:not([hidden]) input, [data-access-wizard-stage]:not([hidden]) select');
                    target?.setAttribute('aria-invalid', 'true');
                    showSummaryError(message);
                    try { target?.focus({ preventScroll: true }); } catch (_) { /* noop */ }
                    return;
                }
                showSummaryError('Review the provider access details, then try again.');
                return;
            }

            setSubmitting(true, 'Connecting…');
            try {
                manager?.trackProduct?.('provider_connect_started', {
                    source: 'onboarding', journey: 'provider_onboarding', step: 'provider_connect', state: 'started'
                });
                if (manager?.confirmLargePlaylistIfNeeded && !await manager.confirmLargePlaylistIfNeeded(payload)) {
                    setSubmitting(false);
                    const focusTarget = form.dataset.setupFlowStep === 'access'
                        ? form.querySelector('[data-provider-access-terms] [data-access-wizard-next]')
                        : submit;
                    try { focusTarget?.focus({ preventScroll: true }); } catch (_) { /* noop */ }
                    return;
                }
                const created = await window.API.sources.create(payload);
                manager?.trackProduct?.('provider_connected', {
                    source: 'onboarding', journey: 'provider_onboarding', step: 'provider_connect', state: 'completed', outcome: 'success'
                });
                let accessSaveFailed = false;
                if (accessTerms) {
                    const sourceId = created.cloudId || created.cloud_id || created.id;
                    const action = 'home-onboarding-cycle';
                    try {
                        await window.API.providerAccess.createCycle(sourceId, accessTerms, {
                            idempotencyKey: manager.providerAccessIdempotency(sourceId, action)
                        });
                        manager.clearProviderAccessIdempotency(sourceId, action);
                        manager?.trackProduct?.('provider_access_saved', {
                            source: 'onboarding', journey: 'provider_onboarding', step: 'provider_access', state: 'completed', outcome: 'success'
                        });
                    } catch (accessError) {
                        accessSaveFailed = true;
                        manager?.trackProduct?.('journey_error', {
                            source: 'onboarding', journey: 'provider_onboarding', step: 'provider_access', outcome: 'error',
                            failureFamily: manager?.productFailureFamily?.(accessError) || 'unknown'
                        });
                        console.warn('[Dashboard] TV service connected but Provider Access terms remain retryable:', accessError?.code || 'request_failed');
                    }
                }
                await this.app?.sourceManager?.loadSources?.();
                manager?.trackProduct?.('catalog_sync_started', {
                    source: 'onboarding', journey: 'catalog', step: 'catalog_sync', state: 'started', catalogState: 'syncing'
                });
                document.dispatchEvent(new CustomEvent('norva:source-health-changed'));
                if (accessSaveFailed) {
                    NorvaModal.toast('Your service is connected. Add its access period later from Settings → TV Service.', 'error');
                }
                submit.textContent = 'Preparing catalog…';
                this.lastLoadedAt = 0;
                await this.app?.refreshSourceHealth?.();
                await this.loadDashboardData();
            } catch (creationError) {
                console.error('[Dashboard] TV service connection failed.');
                const type = selectedType();
                const family = this.setupConnectionFailureFamily(creationError, type);
                manager?.trackProduct?.('journey_error', {
                    source: 'onboarding', journey: 'provider_onboarding', step: 'provider_connect', outcome: 'error', failureFamily: family
                });
                if (form.dataset.setupFlowStep === 'access') setFlowStep('connection', { focus: false });
                showSummaryError(this.setupConnectionErrorCopy(creationError, type), { focus: true });
                setSubmitting(false);
            }
        });

        setConnectionMode('m3u');
        showAssistanceView('connection', { focus: false });
    }

    readSetupConnectionForm(container) {
        const manager = this.app?.sourceManager || window.app?.sourceManager;
        if (!manager?.buildSourceConnection) throw new Error('TV service connection is unavailable.');
        const form = container.querySelector('#home-tv-service-form');
        const type = form?.dataset?.setupConnectionType === 'xtream' ? 'xtream' : 'm3u';
        const urlInput = container.querySelector(type === 'xtream' ? '#home-source-server' : '#home-source-url');
        return manager.buildSourceConnection({
            type,
            name: container.querySelector('#home-source-name')?.value || '',
            url: urlInput?.value || '',
            username: container.querySelector('#home-source-username')?.value || '',
            password: container.querySelector('#home-source-password')?.value || '',
            inputPathShape: urlInput?.dataset?.sourceInputPathShape || ''
        });
    }

    isPairedScreen() {
        return Boolean(
            this.app?.currentUser?.device ||
            window.NorvaCloud?.deviceToken ||
            localStorage.getItem('norva-cloud-device-token')
        );
    }

    setupCopy(summary = {}) {
        const state = summary.state || 'not_configured';
        const pairedScreen = this.isPairedScreen();

        if (pairedScreen) {
            if (state === 'disabled') {
                return {
                    title: 'Your TV service is paused',
                    message: 'Enable it from your phone or web account, then check again here.',
                    primary: 'Check again',
                    primaryAction: 'refresh'
                };
            }
            if (state === 'syncing') {
                return {
                    title: 'Norva is preparing your catalog',
                    message: 'Keep this screen open. Finish setup from your phone or web account; this TV will update automatically.',
                    primary: 'Check again',
                    primaryAction: 'refresh'
                };
            }
            if (['auth_failed', 'expired', 'unreachable', 'degraded'].includes(state)) {
                return {
                    title: 'Repair your TV service from your phone',
                    message: summary.message || 'This TV is paired, but your TV service needs attention. Open Norva on your phone or web account to repair it, then check again here.',
                    primary: 'Check again',
                    primaryAction: 'refresh'
                };
            }
            return {
                title: 'Finish setup from your phone',
                message: 'This TV is paired to your Norva account. Connect your TV service from your phone or web account, then return here to start watching.',
                primary: 'Check again',
                primaryAction: 'refresh'
            };
        }

        if (state === 'syncing') {
            return {
                title: 'Norva is preparing your catalog',
                message: summary.message || 'Channels, movies and series are being imported. You can keep this page open; Norva will refresh automatically.',
                primary: 'View TV service'
            };
        }
        if (state === 'disabled') {
            return {
                title: 'Your TV service is paused',
                message: summary.message || 'Enable it from TV Service settings to make its saved catalog available again.',
                primary: 'Manage TV service'
            };
        }
        if (['auth_failed', 'expired'].includes(state)) {
            return {
                title: 'Repair your TV service',
                message: summary.message || 'Your provider login needs attention before Norva can play content again.',
                primary: summary.action || 'Update login'
            };
        }
        if (['unreachable', 'degraded'].includes(state)) {
            return {
                title: 'Your TV service needs attention',
                message: summary.message || 'Norva cannot confirm that this service is ready. Check it before inviting anyone to watch.',
                primary: summary.action || 'Check service'
            };
        }
        return {
            title: 'Connect your TV service to start watching',
            message: 'Paste the complete Xtream or M3U link from your TV service. Norva will prepare your channels, movies and series automatically.',
            primary: summary.action || 'Connect TV service'
        };
    }

    setupSteps(state) {
        const connected = state !== 'not_configured';
        const ready = state === 'ready';
        const disabled = state === 'disabled';
        const needsRepair = ['auth_failed', 'expired', 'unreachable', 'degraded'].includes(state);
        return [
            {
                index: '1',
                title: connected ? 'TV service connected' : 'Connect TV service',
                hint: connected ? 'Norva has a service saved for this account.' : 'Use your full Xtream or M3U link.',
                state: connected && !needsRepair ? 'complete' : state === 'not_configured' ? 'active' : 'attention'
            },
            {
                index: '2',
                title: state === 'syncing' ? 'Preparing catalog' : 'Catalog preparation',
                hint: state === 'syncing' ? 'Importing content now.' : ready ? 'Catalog ready.' : disabled ? 'Enable the service to restore its saved catalog.' : 'Norva prepares channels, movies and series after connection.',
                state: ready ? 'complete' : state === 'syncing' ? 'active' : 'pending'
            },
            {
                index: '3',
                title: 'Start watching',
                hint: 'Home, Live TV, Movies and Series unlock when the catalog is ready.',
                state: ready ? 'complete' : 'pending'
            }
        ];
    }

    renderServiceHealth(summary) {
        const container = document.getElementById('home-service-health');
        if (!container || !window.NorvaSourceHealth) return;

        container.innerHTML = window.NorvaSourceHealth.cardHtml(summary, {
            hideWhenReady: true,
            prominent: !summary?.ready?.length
        });
        container.classList.toggle('hidden', summary?.state === 'ready');
        container.querySelectorAll('[data-source-health-action]').forEach(button => {
            button.addEventListener('click', () => {
                const action = button.dataset.sourceHealthAction;
                if (action === 'view-progress' && window.NorvaSourceHealth.openProgress) {
                    window.NorvaSourceHealth.openProgress(summary, this.app);
                    return;
                }
                window.NorvaSourceHealth.openAction(summary, this.app);
            });
        });
    }

    async renderFallbackRails() {
        const container = document.getElementById('home-rails');
        if (!container) return;

        const railFetchLimit = Math.max(this.homeRailDisplayLimit, this.homeRailFetchLimit);
        const [moviesResult, seriesResult] = await Promise.allSettled([
            window.API.request('GET', `/channels/recent?type=movie&limit=${railFetchLimit}`),
            window.API.request('GET', `/channels/recent?type=series&limit=${railFetchLimit}`)
        ]);

        // The raw fallback feed is one row PER PROVIDER VARIANT: two providers carrying the
        // same film used to render two adjacent identical cards. Collapse on identity
        // (tmdb id, else normalized clean title) keeping the first (most recent) row.
        const dedupByIdentity = (items = []) => {
            const seen = new Set();
            return items.filter((it) => {
                const tmdb = it?.provider_tmdb_id || it?.providerTmdbId || it?.data?.tmdbId || '';
                const key = tmdb ? `t:${tmdb}` : `n:${String(this.displayTitle(it) || '').toLowerCase()}`;
                if (!key || key === 'n:' || seen.has(key)) return !key || key === 'n:';
                seen.add(key);
                return true;
            });
        };
        const rails = [];
        if (moviesResult.status === 'fulfilled' && moviesResult.value?.length) {
            rails.push({ id: 'recently-added-movies', title: 'Recently Added Movies', items: dedupByIdentity(moviesResult.value) });
        }
        if (seriesResult.status === 'fulfilled' && seriesResult.value?.length) {
            rails.push({ id: 'recently-added-series', title: 'Recently Added Series', items: dedupByIdentity(seriesResult.value) });
        }

        this.renderCloudRails({ rails });
    }

    /**
     * Rotating billboard: a resume entry (if any) followed by a curated set of
     * rail items with a real backdrop, crossfaded every 9s. Rotation pauses on
     * hover and while the tab is hidden; a trailer button appears when TMDB has
     * one for the current item.
     */
    renderHero(history = [], rails = []) {
        const hero = document.getElementById('home-hero');
        if (!hero) return;

        const usable = (item) => this.posterFromItem(item) && this.hasUsefulDisplayTitle(item);
        // The resume slide must be genuinely RESUMABLE (a title watched to the end got a
        // "Resume" button that restarted it from zero) and carry a real backdrop (history
        // rows rarely do — a w342 portrait poster stretched across the billboard reads
        // broken). Home audit 2026-07-04.
        const firstHistory = history.find((item) => {
            if (!usable(item) || !this.backdropFromItem(item)) return false;
            const progress = Number(item.progress_seconds ?? item.progress ?? 0);
            const duration = Number(item.duration_seconds ?? item.duration ?? 0);
            return this.getResumeOffset(progress, duration) > 0;
        }) || null;
        const seen = new Set();
        const railPicks = [];
        // Billboard = promotional quality: draw from the POPULAR rails first (views+rating
        // ranked), then the rest — not "whatever synced most recently".
        const heroRails = [
            ...rails.filter(r => /popular|because-you-(?:watched|liked)/.test(String(r.id || ''))),
            ...rails.filter(r => !/popular|because-you-(?:watched|liked)/.test(String(r.id || ''))),
        ];
        // Editorial reason per hero slide, derived from the rail it was drawn from —
        // so the billboard can say WHY a title is featured (Popular / For You / New).
        const reasonOf = (rail) => {
            const rid = String(rail.id || '').toLowerCase();
            if (/popular/.test(rid)) return 'popular';
            if (/because-you-(?:watched|liked)/.test(rid)) return 'foryou';
            if (/recently-added/.test(rid)) return 'new';
            return 'featured';
        };
        for (const rail of heroRails) {
            if (railPicks.length >= 6) break;
            const reason = reasonOf(rail);
            for (const item of (rail.items || [])) {
                if (railPicks.length >= 6) break;
                if (!usable(item) || !this.backdropFromItem(item)) continue;
                const key = `${item.source_id || item.sourceId || ''}:${item.item_id || item.itemId || item.id || ''}`;
                if (seen.has(key)) continue;
                seen.add(key);
                railPicks.push({ item, reason });
            }
        }
        const slides = [
            ...(firstHistory ? [{ item: firstHistory, isResume: true, reason: 'resume' }] : []),
            ...railPicks.map(p => ({ item: p.item, isResume: false, reason: p.reason }))
        ];

        clearInterval(this._heroTimer);
        this._heroTimer = null;

        if (!slides.length) {
            this.heroItem = null;
            hero.classList.add('hidden');
            hero.innerHTML = '';
            return;
        }

        this._heroSlides = slides;
        this._heroIndex = 0;

        hero.classList.remove('hidden');
        hero.innerHTML = `
            <div class="home-hero-bg" data-hero-layer="a"></div>
            <div class="home-hero-bg" data-hero-layer="b" style="opacity:0"></div>
            <div class="home-hero-content">
                <div class="home-hero-reason hidden"></div>
                <div class="home-hero-kicker"></div>
                <h1></h1>
                <p class="home-hero-desc"></p>
                <div class="home-hero-actions">
                    <button class="btn btn-primary home-hero-play" id="home-hero-play"></button>
                    <button class="btn btn-ghost home-hero-more" id="home-hero-more">Details</button>
                    <button class="btn btn-ghost home-hero-trailer hidden" id="home-hero-trailer">▶ Trailer</button>
                </div>
                ${slides.length > 1 ? `<div class="home-hero-dots">${slides.map((_, i) =>
                    `<button type="button" class="home-hero-dot" data-hero-dot="${i}" aria-label="Billboard ${i + 1}"></button>`).join('')}</div>` : ''}
            </div>
        `;

        const currentSlide = () => this._heroSlides[this._heroIndex] || this._heroSlides[0];
        hero.querySelector('#home-hero-play')?.addEventListener('click', () => {
            const s = currentSlide();
            s.isResume ? this.openRailItem(s.item, true) : this.openRailItemWithAutoplay(s.item);
        });
        hero.querySelector('#home-hero-more')?.addEventListener('click', () => {
            const s = currentSlide();
            const type = s.item.item_type || s.item.itemType || s.item.type || 'movie';
            if (type === 'series') this.navigateToSeries(s.item);
            else this.openRailItem(s.item, false);
        });
        hero.querySelector('#home-hero-trailer')?.addEventListener('click', () => {
            const key = this._heroTrailerKey;
            if (key) MediaUtils.openTrailerLightbox(key, this.displayTitle(currentSlide().item));
        });
        hero.querySelectorAll('.home-hero-dot').forEach((dot) => {
            dot.addEventListener('click', () => this.showHeroSlide(Number(dot.dataset.heroDot)));
        });
        // #home-hero is a persistent node: renderHero runs several times per load (cache
        // paint + fresh), so guard against stacking duplicate hover listeners. Keyboard
        // focus pauses the rotation too (a11y — same rule as hover).
        if (!hero.dataset.heroHoverBound) {
            hero.dataset.heroHoverBound = '1';
            hero.addEventListener('mouseenter', () => { this._heroHovered = true; });
            hero.addEventListener('mouseleave', () => { this._heroHovered = false; });
            hero.addEventListener('focusin', () => { this._heroHovered = true; });
            hero.addEventListener('focusout', () => { this._heroHovered = false; });
            this._bindHeroSwipe(hero);
        }

        this.showHeroSlide(0, { instant: true });
        this._startHeroRotation();
    }

    // (Re)arm the 9s billboard rotation. Split out so show() can resume it on the warm DOM
    // after hide() cleared it — the interval must never tick while another page is active.
    _startHeroRotation() {
        clearInterval(this._heroTimer);
        this._heroTimer = null;
        if (!this._heroSlides || this._heroSlides.length < 2) return;
        this._heroTimer = setInterval(() => {
            if (document.hidden || this._heroHovered || this._heroInteracting) return;
            if (this.app?.currentPage !== 'home') return;
            this.showHeroSlide((this._heroIndex + 1) % this._heroSlides.length);
        }, 9000);
    }

    // Touch/drag swipe on the billboard: a horizontal swipe changes the featured
    // title (left → next, right → previous) so recommendations aren't reachable
    // only via the dots or the 9s auto-rotation — the phone gesture users expect.
    // touch-action: pan-y lets vertical drags fall through to the page scroll, and
    // the click a swipe synthesizes is swallowed so it never fires Play/Details.
    // Bound once on the persistent #home-hero node; reads live slide state at
    // gesture time, so it stays correct across renderHero's cache-paint + fresh runs.
    _bindHeroSwipe(hero) {
        hero.style.touchAction = 'pan-y';
        const H_COMMIT = 45;    // horizontal travel (px) that commits a slide change
        const LOCK_SLOP = 10;   // travel (px) before we lock horizontal vs vertical intent
        let startX = 0, startY = 0, pid = null, tracking = false, horizontal = false, decided = false;

        const reset = () => {
            tracking = false; horizontal = false; decided = false;
            this._heroInteracting = false;
            if (pid != null) { try { hero.releasePointerCapture(pid); } catch (_) { /* ignore */ } }
            pid = null;
        };

        hero.addEventListener('pointerdown', (e) => {
            if (e.button != null && e.button > 0) return;   // primary button / touch only
            pid = e.pointerId; startX = e.clientX; startY = e.clientY;
            tracking = true; horizontal = false; decided = false;
        });
        hero.addEventListener('pointermove', (e) => {
            if (!tracking || e.pointerId !== pid) return;
            const dx = e.clientX - startX, dy = e.clientY - startY;
            if (decided) return;
            if (Math.abs(dx) < LOCK_SLOP && Math.abs(dy) < LOCK_SLOP) return;
            decided = true;
            horizontal = Math.abs(dx) > Math.abs(dy);
            if (horizontal) {
                this._heroInteracting = true;               // pause auto-rotation during the drag
                try { hero.setPointerCapture(pid); } catch (_) { /* not critical */ }
            } else {
                tracking = false;                           // vertical → let the page scroll
            }
        });
        const onUp = (e) => {
            if (!tracking || e.pointerId !== pid) { reset(); return; }
            const dx = e.clientX - startX;
            const wasHorizontal = horizontal;
            reset();
            if (!wasHorizontal) return;                     // vertical / tap → leave the click alone
            // A real horizontal drag happened → swallow the click it synthesizes so it
            // can't land on Play/Details/a dot.
            const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
            hero.addEventListener('click', swallow, true);
            setTimeout(() => hero.removeEventListener('click', swallow, true), 60);
            const n = this._heroSlides?.length || 0;
            if (n < 2 || Math.abs(dx) < H_COMMIT) return;   // too short to commit a change
            const dir = dx < 0 ? 1 : -1;                    // swipe left → next, right → previous
            this.showHeroSlide((this._heroIndex + dir + n) % n);
            this._startHeroRotation();                      // restart the 9s timer from this slide
        };
        hero.addEventListener('pointerup', onUp);
        hero.addEventListener('pointercancel', reset);
    }

    showHeroSlide(index, { instant = false } = {}) {
        const hero = document.getElementById('home-hero');
        const slide = this._heroSlides?.[index];
        if (!hero || !slide) return;
        this._heroIndex = index;
        this.heroItem = slide.item;

        const item = slide.item;
        const type = item.item_type || item.itemType || item.type || 'movie';
        // Full-bleed billboard: upgrade a TMDB w780 to w1280 (w780 is visibly soft on
        // desktop; the smaller size stays right for cards and hover previews).
        const backdrop = this.resolveImageUrl(
            this.backdropFromItem(item) || this.posterFromItem(item), '/img/norva-media-placeholder.png')
            .replace('image.tmdb.org/t/p/w780/', 'image.tmdb.org/t/p/w1280/');

        // Crossfade: paint the hidden layer, then swap opacities once the image
        // is decoded so the fade never shows a half-loaded backdrop.
        const layers = hero.querySelectorAll('.home-hero-bg');
        const front = [...layers].find(l => l.style.opacity !== '0') || layers[0];
        const back = [...layers].find(l => l !== front) || layers[0];
        const paint = () => {
            back.style.backgroundImage = `url('${String(backdrop).replace(/'/g, '%27')}')`;
            if (instant || front === back) {
                back.style.opacity = '1';
                if (front !== back) front.style.opacity = '0';
            } else {
                back.style.transition = front.style.transition = 'opacity 0.9s ease';
                back.style.opacity = '1';
                front.style.opacity = '0';
            }
        };
        const img = new Image();
        img.onload = paint;
        img.onerror = paint;
        img.src = backdrop;

        // Editorial reason pill (WHY this title is on the billboard).
        const reasonEl = hero.querySelector('.home-hero-reason');
        if (reasonEl) {
            const R = {
                resume: ['▶ Resume', 'is-resume'],
                popular: ['🔥 Popular', 'is-popular'],
                foryou: ['💡 For You', 'is-foryou'],
                new: ['✨ New', 'is-new'],
            }[slide.reason];
            reasonEl.className = 'home-hero-reason' + (R ? ' ' + R[1] : ' hidden');
            reasonEl.textContent = R ? R[0] : '';
        }
        const kicker = hero.querySelector('.home-hero-kicker');
        if (kicker) kicker.textContent = this.heroSubtitle(item);
        const titleEl = hero.querySelector('h1');
        if (titleEl) titleEl.textContent = this.displayTitle(item);
        const desc = hero.querySelector('.home-hero-desc');
        if (desc) {
            const text = this.descriptionFromItem(item) || '';
            desc.textContent = text;
            desc.classList.toggle('hidden', !text);
        }
        const playBtn = hero.querySelector('#home-hero-play');
        if (playBtn) playBtn.textContent = slide.isResume ? 'Resume' : 'Play';
        hero.querySelectorAll('.home-hero-dot').forEach((dot, i) =>
            dot.classList.toggle('active', i === index));

        // Trailer availability for THIS slide (async, guarded by index).
        this._heroTrailerKey = null;
        const trailerBtn = hero.querySelector('#home-hero-trailer');
        trailerBtn?.classList.add('hidden');
        const tmdbId = item.provider_tmdb_id || item.providerTmdbId || item.tmdb_id
            || item.data?.providerTmdbId || item.metadata?.providerTmdbId;
        if (tmdbId && !/^(tt)?0+$/i.test(String(tmdbId)) && window.NorvaCloud?.media?.tmdbMeta) {
            NorvaCloud.media.tmdbMeta({ type: type === 'series' ? 'series' : 'movie', tmdbId: String(tmdbId) })
                .then((meta) => {
                    if (this._heroIndex !== index || !meta?.trailerKey) return;
                    this._heroTrailerKey = meta.trailerKey;
                    trailerBtn?.classList.remove('hidden');
                })
                .catch(() => { /* trailer is optional */ });
        }
    }

    heroSubtitle(item) {
        const type = item.item_type || item.itemType || item.type;
        const data = item.data || {};
        const bits = [];
        if (item.progress || data.progress) bits.push('Resume');
        bits.push(type === 'series' ? 'Series' : type === 'channel' ? 'Live TV' : 'Movie');
        const year = item.year || data.year || data.releaseYear;
        if (year) bits.push(year);
        const rating = item.rating || data.rating || data.voteAverage;
        if (rating) bits.push(`★ ${String(rating).slice(0, 3)}`);
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
            .map(rail => ({
                ...rail,
                // Language-preference re-ranking is for GENRE/suggestion rails only. On the
                // popular rails it silently re-numbered the Top 10 by language match instead
                // of the server's views+rating order; on recently-added it scattered the
                // recency order (home audit 2026-07-04). Ordered rails pass through as-is.
                items: (this.isRankedRail(rail) || /^recently-added/.test(String(rail.id || '')))
                    ? (rail.items || []).slice(0, this.homeRailDisplayLimit)
                    : this.rankRailItemsByLanguagePreference(rail.items).slice(0, this.homeRailDisplayLimit)
            }))
            .filter(rail => rail.items.length);

        this.railItems = rails;

        if (!rails.length) {
            container.innerHTML = this.renderHomeRailsEmptyState();
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
        container.querySelectorAll('.home-rail-seeall').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); this.app?.navigateTo?.(btn.dataset.seeallPage); });
        });

        this.initScrollArrows();
        this.updateScrollArrows();
    }

    rankRailItemsByLanguagePreference(items = []) {
        if (!window.MediaUtils?.scoreTitleForPreferences) return items;
        return [...items].sort((a, b) =>
            MediaUtils.scoreTitleForPreferences(b, this.contentPreferences) -
            MediaUtils.scoreTitleForPreferences(a, this.contentPreferences)
        );
    }

    createRailSection(rail, railIndex) {
        const ranked = this.isRankedRail(rail);
        const title = ranked
            ? (rail.itemType === 'series' ? 'Top 10 Series' : 'Top 10 Movies')
            : this.railTitle(rail);
        const subtitle = ranked ? '' : this.railSubtitle(rail);
        const id = `home-rail-${this.slug(String(rail.id || railIndex))}`;
        const items = ranked ? (rail.items || []).slice(0, 10) : rail.items;
        const seeAllPage = this.railSeeAllPage(rail);

        return `
            <section class="dashboard-section home-rail-section${ranked ? ' is-ranked-rail' : ''}" data-rail-id="${this.escapeAttr(rail.id || id)}">
                <div class="section-header home-rail-header">
                    <div>
                        <h2>${this.escapeHtml(title)}</h2>
                        ${subtitle ? `<p class="home-rail-subtitle">${this.escapeHtml(subtitle)}</p>` : ''}
                    </div>
                    ${seeAllPage ? `<button type="button" class="home-rail-seeall" data-seeall-page="${this.escapeAttr(seeAllPage)}">See all <span aria-hidden="true">→</span></button>` : ''}
                </div>
                ${this.scrollSection(id, 'Loading...', '', items.map((item, itemIndex) => this.createRailCard(item, railIndex, itemIndex, ranked)).join(''))}
            </section>
        `;
    }

    // "See all" target for a rail — the catalog page that matches its content type
    // (null when a rail has no clean single-type destination, e.g. mixed suggestions).
    railSeeAllPage(rail = {}) {
        const id = String(rail.id || '').toLowerCase();
        if (id.startsWith('because-you-liked') || rail.curation?.kind === 'because_you_liked') {
            return null;
        }
        const t = String(rail.itemType || rail.item_type || '').toLowerCase();
        if (t === 'series') return 'series';
        if (t === 'movie' || t === 'movies') return 'movies';
        if (t === 'channel' || t === 'live') return 'live';
        if (this.isRankedRail(rail)) return rail.itemType === 'series' ? 'series' : 'movies';
        if (/series/.test(id)) return 'series';
        if (/movie/.test(id)) return 'movies';
        return null;
    }

    // The server's "popular" rail (ranked by TMDB rating + provider ubiquity) is
    // rendered as a numbered Top 10.
    isRankedRail(rail = {}) {
        const id = String(rail.id || '').toLowerCase();
        return rail.curation?.kind === 'popular' || id === 'popular-movies' || id === 'popular-series';
    }

    railTitle(rail = {}) {
        const id = String(rail.id || '').toLowerCase();
        if (id === 'recently-added-movies') return 'Recently Added Movies';
        if (id === 'recently-added-series') return 'Recently Added Series';
        if (id === 'action-movies') return 'Action Movies';
        if (id === 'popular-movies') return 'Popular Movies';
        if (id === 'popular-series') return 'Popular Series';
        if (id.startsWith('because-you-watched')) {
            // Netflix names the anchor — "Because You Watched Inception" carries the WHY.
            const anchor = String(rail.curation?.anchorTitle || '').trim();
            return anchor ? `Because You Watched ${anchor}` : 'Because You Watched';
        }
        if (id.startsWith('because-you-liked')) {
            const anchor = String(rail.curation?.anchorTitle || '').trim();
            return anchor ? `Because You Liked ${anchor}` : 'Because You Liked';
        }
        const title = rail.title || rail.name || 'Norva Selection';
        // The fast first paint intentionally combines movie and series genre
        // rails. A genre such as Action can exist in both payloads; without a
        // type suffix Home briefly showed two indistinguishable "Action" rows
        // before the personalized response arrived.
        if (['genre', 'genre_bucket'].includes(rail.curation?.kind)) {
            const type = String(rail.itemType || rail.item_type || '').toLowerCase();
            const suffix = type === 'series' ? 'Series' : type === 'movie' ? 'Movies' : '';
            if (suffix && !new RegExp(`\\b${suffix}$`, 'i').test(String(title))) {
                return `${title} ${suffix}`;
            }
        }
        return title;
    }

    railSubtitle(rail = {}) {
        const id = String(rail.id || '').toLowerCase();
        if (id.startsWith('because-you-watched')) return 'Suggestions based on your watch history';
        if (id.startsWith('because-you-liked')) return 'Suggestions inspired by titles you liked';
        if (id === 'action-movies') return 'Verified titles with enriched genres';
        if (id === 'popular-movies') return 'Verified titles with top ratings';
        return '';
    }

    createRailCard(item, railIndex, itemIndex, ranked = false) {
        const data = item.data || {};
        const itemId = item.item_id || item.itemId || item.id || '';
        const type = item.item_type || item.itemType || item.type || 'movie';
        const title = this.displayTitle(item);
        const posterUrl = this.resolveImageUrl(this.posterFromItem(item), '/img/norva-media-placeholder.png');
        const meta = this.cardMeta(item);
        const variantCount = Number(item.variantCount || item.variant_count || data.variantCount || 0);
        const languageBadge = this.cardLanguageBadge(item);
        // "New" corner badge, except on the ranked Top-10 rails (the numeral owns that corner).
        const isNew = !ranked && MediaUtils.isRecentlyAdded?.(item);

        return `
            <div class="dashboard-card" tabindex="0" role="button" aria-label="${this.escapeAttr(title)}" data-id="${this.escapeAttr(itemId)}" data-type="${this.escapeAttr(type)}" data-rail-index="${railIndex}" data-item-index="${itemIndex}">
                <div class="card-image">
                    ${ranked ? `<div class="rank-numeral">${itemIndex + 1}</div>` : ''}
                    ${isNew ? '<span class="new-badge">NEW</span>' : ''}
                    <img src="${this.escapeAttr(posterUrl)}" alt="${this.escapeAttr(title)}" loading="lazy" decoding="async"
                         ${MediaUtils.tmdbSrcset?.(posterUrl) ? `srcset="${this.escapeAttr(MediaUtils.tmdbSrcset(posterUrl))}" sizes="(max-width: 640px) 40vw, 220px"` : ''}
                         onerror="this.onerror=null;this.srcset='';this.src='/img/norva-media-placeholder.png'">
                    ${variantCount > 1 ? `<div class="home-card-badge">${variantCount} versions</div>` : ''}
                    ${languageBadge ? `<div class="home-card-language-badge">${this.escapeHtml(languageBadge)}</div>` : ''}
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

    cardLanguageBadge(item) {
        const prefs = this.contentPreferences || {};
        if (!prefs.preferredAudioLanguage && !prefs.preferredSubtitleLanguage) return '';
        const variants = Array.isArray(item.variants) && item.variants.length
            ? item.variants
            : [item.defaultVariant || item.default_variant || item];
        const best = [...variants].sort((a, b) =>
            MediaUtils.scoreVersionLanguage({ ...item, ...b }, prefs) -
            MediaUtils.scoreVersionLanguage({ ...item, ...a }, prefs)
        )[0] || item;
        const label = MediaUtils.versionLanguageBadge({ ...item, ...best }, prefs);
        return label;
    }

    cardMeta(item = {}) {
        const data = item.data || {};
        const metadata = item.metadata || {};
        const year = item.year || data.year || data.releaseYear || metadata.year;
        const rating = item.rating || data.rating || data.voteAverage || metadata.rating;
        const genres = this.genreList(item).slice(0, 2);
        return [year, ...genres, rating ? `★ ${String(rating).slice(0, 3)}` : ''].filter(Boolean).join(' - ');
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
        return position;
    }

    renderHistory(items) {
        const list = document.getElementById('continue-watching-list');
        const section = document.getElementById('continue-watching-section');
        if (!list || !section) return;

        // Netflix semantics (home audit 2026-07-04):
        //  — ONE card per SERIES (history is one row per episode: two half-watched episodes
        //    used to render two cards for the same show);
        //  — a FINISHED episode advances the card to the NEXT episode (the player saves
        //    data.nextEpisode on every progress write; it was never consumed — finishing an
        //    episode simply made the show vanish from Continue Watching);
        //  — one card per MOVIE identity (the same film from two providers showed twice).
        const entries = [];
        const seenSeries = new Set();
        const seenMovies = new Set();
        for (const item of (items || [])) {
            const data = item.data || {};
            const progress = Number(item.progress || item.progress_seconds || data.progress || 0);
            const duration = Number(item.duration || item.duration_seconds || data.duration || 0);
            const type = item.item_type || item.itemType || item.type || 'movie';
            const isEpisode = type === 'episode' || !!(data.seriesId || item.parent_item_id);
            const finished = duration > 0 && progress >= duration * 0.95;
            if (isEpisode) {
                const sKey = `${item.source_id || item.sourceId || ''}:${data.seriesId || item.parent_item_id || item.item_id || ''}`;
                if (seenSeries.has(sKey)) continue; // most recent episode wins (server sorts DESC)
                const next = data.nextEpisode;
                if (finished && next && next.id) {
                    seenSeries.add(sKey);
                    entries.push(this._nextEpisodeHistoryItem(item, next));
                    continue;
                }
                if (this.getResumeOffset(progress, duration) <= 0) continue;
                seenSeries.add(sKey);
                entries.push(item);
                continue;
            }
            if (this.getResumeOffset(progress, duration) <= 0) continue;
            const mKey = data.titleId ? `t:${data.titleId}` : `n:${String(this.displayTitle(item) || '').toLowerCase()}`;
            if (seenMovies.has(mKey)) continue;
            seenMovies.add(mKey);
            entries.push(item);
        }
        this.historyItems = entries.slice(0, 18);

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

        list.querySelectorAll('.ch-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeHistoryItem(Number(btn.dataset.historyIndex));
            });
        });

        this.updateScrollArrows();
    }

    // Synthetic "up next" row: a finished episode's card becomes the NEXT episode at 0%,
    // playable in one click. Everything else (source, series linkage, poster) rides along
    // from the finished row, so playItem resolves the stream exactly like a resume would.
    _nextEpisodeHistoryItem(prev, next) {
        const data = prev.data || {};
        const label = (next.season && next.episode) ? `S${next.season} E${next.episode}` : 'Next episode';
        return {
            ...prev,
            item_id: String(next.id),
            progress: 0,
            progress_seconds: 0,
            duration: Number(next.duration) || 0,
            duration_seconds: Number(next.duration) || 0,
            _upNext: true,
            data: {
                ...data,
                subtitle: next.title ? `${label} · ${next.title}` : label,
                containerExtension: next.containerExtension || data.containerExtension,
                resumeTime: 0,
                progress: 0,
                currentEpisode: next.episode ?? data.currentEpisode,
                currentSeason: next.season ?? data.currentSeason,
                nextEpisode: null,
            },
        };
    }

    // Remove a title from Continue Watching: drop it from the row immediately, then
    // delete the history record server-side (best-effort — it returns on a failed
    // delete at the next refresh).
    async removeHistoryItem(index) {
        const item = this.historyItems[index];
        if (!item) return;
        this.historyItems.splice(index, 1);
        this.renderHistory(this.historyItems);
        const recordId = item.id;

        // Undo window: hold the server delete for a few seconds so a mis-tap is
        // fully recoverable (Netflix removes silently — this is friendlier).
        let undone = false;
        const commit = async () => {
            if (undone || recordId == null) return;
            try { await window.API?.history?.remove?.(recordId); } catch (_) { /* best-effort */ }
        };
        const toast = this.app?.showToast?.('Removed from Continue Watching', {
            action: 'Undo',
            duration: 5000,
            onAction: () => {
                undone = true;
                this.historyItems.splice(Math.min(index, this.historyItems.length), 0, item);
                this.renderHistory(this.historyItems);
            }
        });
        // Persist the delete once the undo window closes (toast auto-dismiss ≈ 5s) — and on
        // pagehide too: closing the tab inside the undo window used to drop the DELETE
        // entirely, resurrecting the card on the next visit.
        const onPageHide = () => { commit(); };
        window.addEventListener('pagehide', onPageHide, { once: true });
        setTimeout(() => { window.removeEventListener('pagehide', onPageHide); commit(); }, 5200);
        if (!toast) commit(); // no toast host (edge case) → delete immediately
    }

    createHistoryCard(item, index) {
        const data = item.data || {};
        const progress = Number(item.progress || item.progress_seconds || data.progress || 0);
        const duration = Number(item.duration || item.duration_seconds || data.duration || 0);
        const percent = duration > 0 ? Math.min(100, Math.round((progress / duration) * 100)) : 0;
        const itemId = item.item_id || item.itemId || item.id || '';
        const type = item.item_type || item.itemType || item.type || 'movie';
        const title = this.displayTitle(item);
        const subtitle = type === 'episode'
            ? MediaUtils.formatEpisodeDisplayLabel(data.subtitle || '', {
                season: data.currentSeason,
                episode: data.currentEpisode
            })
            : (data.subtitle || this.typeLabel(type));
        const posterUrl = this.resolveImageUrl(this.posterFromItem(item), '/img/norva-media-placeholder.png');
        const remainingMin = duration > progress ? Math.max(1, Math.round((duration - progress) / 60)) : 0;
        const timeLeft = item._upNext ? 'Next episode' : (remainingMin > 0 ? `${remainingMin} min left` : '');
        // A zero-duration row can't compute progress — an empty bar reads broken, hide it.
        const showBar = duration > 0 && !item._upNext;

        return `
            <div class="dashboard-card" tabindex="0" role="button" aria-label="${this.escapeAttr(item._upNext ? `Play next episode of ${title}` : `Resume ${title}`)}" data-id="${this.escapeAttr(itemId)}" data-type="${this.escapeAttr(type)}" data-history-index="${index}">
                <div class="card-image">
                    <img src="${this.escapeAttr(posterUrl)}" alt="${this.escapeAttr(title)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.srcset='';this.src='/img/norva-media-placeholder.png'">
                    <button class="ch-remove" type="button" data-history-index="${index}" aria-label="Remove from Continue Watching">✕</button>
                    ${timeLeft ? `<div class="card-timeleft">${timeLeft}</div>` : ''}
                    ${showBar ? `<div class="progress-bar-container">
                        <div class="progress-bar" style="width: ${percent}%"></div>
                    </div>` : ''}
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
        // "Details" on an episode history card = the SERIES fiche. It used to fall through
        // to playItem with resumeOffset 0 — neither details nor resume, just a restart.
        if (type === 'episode' && !isResume) {
            const data = item.data || {};
            if (data.seriesId) {
                this.navigateToSeries({ ...item, item_id: data.seriesId, item_type: 'series' });
                return;
            }
        }
        if (type === 'movie' && !isResume) {
            this.navigateToMovie(item);
            return;
        }
        if (type === 'channel') {
            this.playChannel(item.item_id || item.streamId || item.stream_id, item.source_id || item.sourceId);
            return;
        }
        this.playItem(item, isResume);
    }

    /**
     * Unified "My List" rail: favourited movies + series (rendered from the
     * name/poster persisted on the favorite row) in one cross-type rail. Channels
     * keep their own "Favorite Channels" rail. Rows without a poster (favorited
     * before name/meta persistence) are skipped — they self-heal on re-favorite.
     */
    async renderMyList() {
        const list = document.getElementById('my-list-list');
        const section = document.getElementById('my-list-section');
        if (!list || !section) return;
        try {
            const favs = await window.API.request('GET', '/favorites');
            const seen = new Set();
            const rows = (Array.isArray(favs) ? favs : (favs?.favorites || []))
                .filter(f => ['movie', 'series'].includes(f.item_type || f.itemType))
                .map(f => {
                    const meta = f.item_meta || f.itemMeta || {};
                    return {
                        item_id: f.item_id ?? f.itemId,
                        source_id: f.source_id ?? f.sourceId,
                        item_type: f.item_type ?? f.itemType,
                        title: f.item_name ?? f.itemName ?? '',
                        poster: meta.poster || '',
                    };
                })
                // A favorite saved before name/meta persistence has no poster — it used to be
                // silently DROPPED (invisible forever, since the heart shows as already-active
                // so "re-favorite to heal" never happens). A placeholder card beats a ghost.
                .filter(r => r.title)
                // One card per title: favorites of the same film added from two providers.
                .filter(r => {
                    const key = `${r.item_type}:${String(r.title).toLowerCase()}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                })
                .slice(0, 20);

            if (!rows.length) { section.classList.add('hidden'); return; }
            section.classList.remove('hidden');
            list.innerHTML = rows.map((r, i) => `
                <div class="dashboard-card" tabindex="0" role="button" aria-label="${this.escapeAttr(r.title)}" data-mylist-index="${i}" data-type="${this.escapeAttr(r.item_type)}">
                    <div class="card-image">
                        <img src="${this.escapeAttr(this.resolveImageUrl(r.poster, '/img/norva-media-placeholder.png'))}"
                             alt="${this.escapeAttr(r.title)}" loading="lazy" decoding="async"
                             onerror="this.onerror=null;this.srcset='';this.src='/img/norva-media-placeholder.png'">
                        <div class="play-icon-overlay"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
                    </div>
                    <div class="card-info">
                        <div class="card-title" title="${this.escapeHtml(r.title)}">${this.escapeHtml(r.title)}</div>
                        <div class="card-subtitle">${this.typeLabel(r.item_type)}</div>
                    </div>
                </div>`).join('');
            this._myListRows = rows;
            list.querySelectorAll('.dashboard-card').forEach(card => {
                card.addEventListener('click', () => {
                    const r = this._myListRows[Number(card.dataset.mylistIndex)];
                    if (r) this.openRailItem(r, false);
                });
            });
            this.updateScrollArrows();
        } catch (_) {
            // Transient /favorites failure: keep whatever is already rendered (an error must
            // not read as "your list is empty"); only hide when nothing was ever shown.
            if (!this._myListRows?.length) section.classList.add('hidden');
        }
    }

    async renderFavoriteChannels() {
        const list = document.getElementById('favorite-channels-list');
        const section = document.getElementById('favorite-channels-section');
        if (!list || !section) return;

        try {
            const payload = await window.API.request('GET', '/favorites?itemType=channel');
            const favorites = Array.isArray(payload) ? payload : (payload?.favorites || []);

            if (favorites.length === 0) {
                this._favoriteChannelRows = [];
                section.classList.add('hidden');
                return;
            }

            // The Home rail must stay independent from the Live catalogue. Loading
            // ChannelList here used to parse tens of thousands of logical channels
            // merely to paint a handful of favorites, eventually exhausting the TV
            // WebView heap. Favorite rows already carry enough display metadata; old
            // rows remain visible with an honest fallback until they are refreshed.
            const channels = favorites
                .map(fav => {
                    const meta = fav.item_meta || fav.itemMeta || {};
                    const itemId = String(fav.item_id ?? fav.itemId ?? '');
                    const sourceId = fav.source_id ?? fav.sourceId;
                    if (!itemId || sourceId == null) return null;
                    return {
                        id: String(meta.channelId || itemId),
                        streamId: String(meta.streamId || ''),
                        sourceId,
                        sourceType: meta.sourceType || 'xtream',
                        name: fav.item_name || fav.itemName || meta.name || 'Favorite channel',
                        tvgLogo: meta.poster || meta.logo || '',
                        favoriteId: fav.id || '',
                        favoriteItemId: itemId
                    };
                })
                .filter(Boolean);

            if (!channels.length) {
                this._favoriteChannelRows = [];
                section.classList.add('hidden');
                return;
            }

            this._favoriteChannelRows = channels;
            section.classList.remove('hidden');
            list.innerHTML = channels.map(ch => this.createChannelTile(ch)).join('');

            list.querySelectorAll('.channel-tile').forEach(tile => {
                tile.addEventListener('click', () => {
                    const channel = this._favoriteChannelRows.find(row =>
                        String(row.id) === String(tile.dataset.channelId)
                        && String(row.sourceId) === String(tile.dataset.sourceId)
                    );
                    this.playChannel(tile.dataset.channelId, tile.dataset.sourceId, channel || {});
                });
            });

            this.updateScrollArrows();
        } catch (err) {
            console.error('[Dashboard] Error loading favorite channels:', err);
            // A transient favorites outage must not make an already-painted rail
            // disappear and read as "you have no favorites".
            if (!this._favoriteChannelRows?.length) section.classList.add('hidden');
        }
    }

    createChannelTile(channel) {
        const logoUrl = this.getChannelLogoSrc(channel);
        const fallbackLogo = this.getChannelLogoFallback(channel);
        const name = channel.name || 'Unknown';

        return `
            <div class="channel-tile" tabindex="0" role="button" aria-label="${this.escapeAttr(`Play ${name}`)}" data-channel-id="${this.escapeAttr(channel.id)}" data-source-id="${this.escapeAttr(channel.sourceId)}">
                <div class="tile-logo">
                    <img src="${this.escapeAttr(logoUrl)}" alt="${this.escapeAttr(name)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${this.escapeAttr(fallbackLogo)}'">
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

    playChannel(channelId, sourceId, metadata = {}) {
        const channelList = this.app.channelList;
        if (!channelList?.queueChannelSelection) {
            this.app?.showToast?.('This channel is no longer available');
            return;
        }

        // Queue before changing route: Live owns the bounded lookup and consumes
        // this intent after its first lightweight page is ready. Home never
        // bootstraps, hydrates or waits on the full channel catalogue.
        channelList.queueChannelSelection({
            channelId,
            itemId: metadata.favoriteItemId || channelId,
            streamId: metadata.streamId || '',
            sourceId,
            sourceType: metadata.sourceType || 'xtream',
            name: metadata.name || ''
        });
        this.app.navigateTo('live');
    }

    homeVariantToMediaItem(variant, parent, type) {
        const data = parent.data || {};
        const metadata = parent.metadata || {};
        const tmdb = data.tmdb || metadata.tmdb || parent.tmdb || {};
        const sourceId = variant.sourceId || variant.source_id || parent.sourceId || parent.source_id || data.sourceId;
        const itemId = String(
            variant.stream_id ||
            variant.streamId ||
            variant.series_id ||
            variant.seriesId ||
            variant.item_id ||
            variant.itemId ||
            variant.external_id ||
            variant.externalId ||
            parent.item_id ||
            parent.itemId ||
            ''
        );
        const title = this.firstUsefulTitle(
            variant.name,
            variant.title,
            variant.rawTitle,
            variant.raw_title,
            parent.name,
            parent.title,
            data.title
        ) || this.displayTitle(parent);
        const poster = variant.stream_icon ||
            variant.poster_url ||
            variant.posterUrl ||
            variant.cover ||
            parent.stream_icon ||
            parent.poster_url ||
            parent.posterUrl ||
            parent.cover ||
            data.poster ||
            data.posterUrl ||
            null;
        const container = variant.container_extension ||
            variant.containerExtension ||
            variant.playbackHint?.container ||
            variant.playback_hint?.container ||
            parent.container_extension ||
            parent.containerExtension ||
            data.containerExtension ||
            'mp4';
        const providerTmdbId = parent.providerTmdbId || parent.provider_tmdb_id || data.providerTmdbId || metadata.providerTmdbId || null;
        const titleId = parent.titleId || parent.title_id || data.titleId || null;
        const fileAudioTracks = variant.audio_tracks_scope === 'file' || variant.audioTracksScope === 'file'
            ? (variant.audio_tracks || variant.audioTracks || [])
            : null;
        const fileSubtitleTracks = variant.subtitle_tracks_scope === 'file' || variant.subtitleTracksScope === 'file'
            ? (variant.subtitle_tracks || variant.subtitleTracks || [])
            : null;
        const fileAudioLanguages = fileAudioTracks
            ? [...new Set(fileAudioTracks
                .map(track => MediaUtils.normalizeLanguagePreference(track?.lang || track?.language || ''))
                .filter(code => code && code !== 'und' && code !== 'unknown'))]
            : null;

        return {
            ...parent,
            ...variant,
            sourceId,
            source_id: sourceId,
            stream_id: itemId,
            streamId: itemId,
            series_id: itemId,
            seriesId: itemId,
            item_id: itemId,
            itemId,
            item_type: type,
            itemType: type,
            type,
            name: title,
            title,
            raw_title: variant.raw_title || variant.rawTitle || title,
            rawTitle: variant.rawTitle || variant.raw_title || title,
            stream_icon: poster,
            poster_url: poster,
            posterUrl: poster,
            cover: poster,
            container_extension: container,
            containerExtension: container,
            plot: parent.overview || parent.description || parent.plot || data.overview || data.description || data.plot || metadata.overview || tmdb.overview || '',
            overview: parent.overview || data.overview || metadata.overview || tmdb.overview || '',
            year: data.year || parent.year || metadata.year || '',
            rating: parent.rating || data.rating || metadata.rating || metadata.voteAverage || tmdb.vote_average || '',
            provider_tmdb_id: providerTmdbId,
            providerTmdbId,
            tmdb_id: providerTmdbId,
            title_id: titleId,
            titleId,
            // Never inherit a grouped title's absolute stream indices into a
            // sibling provider file. Only explicitly file-scoped tracks survive.
            audio_tracks: fileAudioTracks,
            audioTracks: fileAudioTracks,
            audio_tracks_scope: fileAudioTracks !== null ? 'file' : null,
            audioTracksScope: fileAudioTracks !== null ? 'file' : null,
            audio_languages: fileAudioLanguages,
            audioLanguages: fileAudioLanguages,
            subtitle_tracks: fileSubtitleTracks,
            subtitleTracks: fileSubtitleTracks,
            subtitle_tracks_scope: fileSubtitleTracks !== null ? 'file' : null,
            subtitleTracksScope: fileSubtitleTracks !== null ? 'file' : null,
            tmdb,
            metadata: {
                ...metadata,
                ...(variant.metadata || {}),
                tmdb
            },
            data: {
                ...metadata,
                ...data,
                ...(variant.data || {}),
                title,
                poster,
                sourceId,
                containerExtension: container,
                providerTmdbId,
                titleId,
                tmdb
            }
        };
    }

    buildHomeMediaGroup(item, type) {
        const data = item.data || {};
        const sourceId = item.source_id || item.sourceId || data.sourceId;
        const variants = Array.isArray(item.variants) && item.variants.length
            ? item.variants
            : (item.defaultVariant || item.default_variant ? [item.defaultVariant || item.default_variant] : []);
        const fallbackItem = this.homeVariantToMediaItem({
            ...item,
            item_id: item.item_id || item.itemId || item.stream_id || item.streamId || item.series_id,
            sourceId,
            name: this.displayTitle(item)
        }, item, type);
        const items = variants
            .map(variant => this.homeVariantToMediaItem(variant, item, type))
            .filter(variant => variant.sourceId && (type === 'series' ? variant.series_id : variant.stream_id));
        const unique = [];
        const seen = new Set();
        for (const version of (items.length ? items : [fallbackItem])) {
            const key = `${version.sourceId}:${type === 'series' ? version.series_id : version.stream_id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(version);
        }
        const title = this.displayTitle(item);
        const representative = {
            ...fallbackItem,
            name: title,
            title,
            stream_icon: item.stream_icon || item.poster_url || item.posterUrl || data.poster || data.posterUrl || fallbackItem.stream_icon,
            poster_url: item.poster_url || item.posterUrl || data.poster || data.posterUrl || fallbackItem.poster_url,
            posterUrl: item.posterUrl || item.poster_url || data.posterUrl || data.poster || fallbackItem.posterUrl,
            cover: item.cover || data.cover || fallbackItem.cover,
            plot: data.description || data.plot || item.plot || item.overview || fallbackItem.plot,
            overview: data.overview || item.overview || fallbackItem.overview,
            variantCount: item.variantCount || item.variant_count || unique.length,
            variants: unique
        };

        return {
            representative,
            items: unique.length ? unique : [representative]
        };
    }

    // A rail item that carries its sibling variants (home rails payload) can open the
    // fiche directly. A SKINNY row (My List favorite / Continue Watching history: just
    // {item_id, source_id, title, poster}) cannot — buildHomeMediaGroup would produce a
    // single-variant group with no tmdb, so the fiche opens "empty" (1 season, no
    // synopsis, no version picker) AND tryNextHealthyVersion has no sibling to switch
    // to. Skinny rows go through the pages' openByItem — the same resolver global
    // search uses — which re-fetches the sibling versions and rebuilds the full group.
    _isSkinnyRailItem(item) {
        return !(Array.isArray(item?.variants) && item.variants.length);
    }

    navigateToSeries(item) {
        if (!this.app.pages.series) return;
        const group = this.buildHomeMediaGroup(item, 'series');

        this.app.navigateTo('series');
        const intentPage = this.app.pages.series;
        const intentToken = intentPage.beginFicheIntent?.();
        setTimeout(async () => {
            const page = this.app.pages.series;
            const isCurrent = () => intentToken == null
                || page.isFicheIntentCurrent?.(intentToken) !== false;
            if (!isCurrent()) return;
            if (this._isSkinnyRailItem(item)) {
                const data = item.data || {};
                const mapped = {
                    series_id: item.item_id ?? item.itemId ?? item.series_id,
                    sourceId: item.source_id ?? item.sourceId ?? data.sourceId,
                    name: this.displayTitle(item),
                    tmdb: item.tmdb || data.tmdb,
                    stream_icon: item.poster || item.stream_icon || item.poster_url,
                    poster_url: item.poster || item.poster_url,
                };
                try {
                    if (await page.openByItem(mapped, { intentToken })) return;
                } catch (_) { /* fall back below */ }
                if (!isCurrent()) return;
            }
            const versions = MediaUtils.orderVersionsByPreference(group.items, page.getPreferences?.() || {});
            const series = versions[0] || group.representative;
            page.currentSeriesGroup = group;
            page.showSeriesDetailsV2(series, group, { intentToken });
        }, 100);
    }

    navigateToMovie(item) {
        if (!this.app.pages.movies) return;
        const group = this.buildHomeMediaGroup(item, 'movie');

        this.app.navigateTo('movies');
        const intentPage = this.app.pages.movies;
        const intentToken = intentPage.beginFicheIntent?.();
        setTimeout(async () => {
            const page = this.app.pages.movies;
            const isCurrent = () => intentToken == null
                || page.isFicheIntentCurrent?.(intentToken) !== false;
            if (!isCurrent()) return;
            if (this._isSkinnyRailItem(item)) {
                const data = item.data || {};
                const mapped = {
                    stream_id: item.item_id ?? item.itemId ?? item.stream_id,
                    sourceId: item.source_id ?? item.sourceId ?? data.sourceId,
                    name: this.displayTitle(item),
                    tmdb: item.tmdb || data.tmdb,
                    stream_icon: item.poster || item.stream_icon || item.poster_url,
                    poster_url: item.poster || item.poster_url,
                };
                try {
                    if (await page.openByItem(mapped, { intentToken })) return;
                } catch (_) { /* fall back below */ }
                if (!isCurrent()) return;
            }
            const versions = MediaUtils.orderVersionsByPreference(group.items, page.getPreferences?.() || {});
            const selected = versions[0] || group.representative;
            page.showMovieDetails(group, selected, { versions, intentToken });
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
            // Display-clean scene-release names ("[ Torrent911.me ] Name.Year.X264" → "Name Year").
            return MediaUtils.cleanReleaseName(title) || title;
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
        const watch = this.app.pages.watch;
        if (!watch) return;

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
            console.error('[Dashboard] Missing source or stream identifier');
            return;
        }

        const playbackHint = MediaUtils.playbackHintFromItem
            ? MediaUtils.playbackHintFromItem(item, { container })
            : { container };
        if (resumeOffset > 0) {
            playbackHint.seekOffset = resumeOffset;
            playbackHint.startOffset = resumeOffset;
            playbackHint.resumeTime = resumeOffset;
        }
        if (MediaUtils.applyPlaybackPreferencesToHint) {
            Object.assign(playbackHint, MediaUtils.applyPlaybackPreferencesToHint(playbackHint, playbackPreferences));
        } else {
            const preferredAudioStreamIndex = playbackPreferences?.audio?.streamIndex
                ?? playbackPreferences?.audio?.stream_index;
            if (preferredAudioStreamIndex !== null && preferredAudioStreamIndex !== undefined) {
                const audioStreamIndex = Number(preferredAudioStreamIndex);
                if (Number.isInteger(audioStreamIndex) && audioStreamIndex >= 0) {
                    playbackHint.audioStreamIndex = audioStreamIndex;
                }
            }
        }

        // Live H.264 → remux (copy video), H.265/HEVC → full transcode.
        if (streamType === 'live' && !playbackHint.gatewayMode && window.MediaUtils?.liveGatewayMode) {
            playbackHint.gatewayMode = MediaUtils.liveGatewayMode(item);
        }

        const content = {
            id: streamId,
            type,
            title: this.displayTitle(item),
            rawTitle: item.raw_title || item.rawTitle || item.name || item.title
                || data.rawTitle || data.raw_title || null,
            subtitle: type === 'episode'
                ? MediaUtils.formatEpisodeDisplayLabel(data.subtitle || '', {
                    season: data.currentSeason,
                    episode: data.currentEpisode
                })
                : (data.subtitle || this.typeLabel(type)),
            poster: item.stream_icon || item.poster_url || item.posterUrl || data.poster || data.posterUrl,
            sourceId,
            cloudSourceId: item.cloudSourceId || data.cloudSourceId || null,
            resumeTime: resumeOffset,
            playbackPreferences,
            containerExtension: container,
            titleId: data.titleId || item.titleId || item.title_id || null,
            codecProfile: item.codecProfile || item.codec_profile
                || data.codecProfile || data.codec_profile
                || item.playbackHint?.codecProfile || item.playback_hint?.codec_profile || null,
            variantCount: item.variantCount || item.variant_count || data.variantCount || 1,
            defaultVariant: item.defaultVariant || item.default_variant || null,
            audioLanguages: item.audioLanguages || item.audio_languages || data.audioLanguages || data.audio_languages || null,
            versionLanguages: item.versionLanguages || item.version_languages || data.versionLanguages || data.version_languages || null,
            originalLanguage: item.originalLanguage || item.original_language || data.originalLanguage || data.original_language || null,
            // Precomputed ordered per-track language map (from the rail item / detail) so
            // the player labels every audio track with zero playback-time probe.
            audioTracks: item.audioTracks || item.audio_tracks || data.audioTracks || data.audio_tracks || null
        };
        if (type === 'episode' && item.data) {
            content.seriesId = item.data.seriesId || null;
            content.currentSeason = item.data.currentSeason || null;
            content.currentEpisode = item.data.currentEpisode || null;
        }

        // Open the player immediately (poster + loading animation), then resolve
        // the stream URL — and, for episodes, the series info for next-episode
        // handoff — into the already-visible shell.
        await watch.play(content, async ({ signal } = {}) => {
            const result = await window.API.proxy.xtream.getStreamUrl(
                sourceId,
                streamId,
                streamType,
                container,
                playbackHint,
                { signal }
            );
            if (!result || !result.url) return null;
            if (signal?.aborted) return result;
            if (type === 'episode' && content.seriesId && sourceId) {
                try {
                    const seriesInfo = await window.API.request(
                        'GET',
                        `/proxy/xtream/${sourceId}/series_info?series_id=${content.seriesId}`,
                        null,
                        { signal }
                    );
                    if (seriesInfo) content.seriesInfo = seriesInfo;
                } catch (e) {
                    console.warn('[Dashboard] Could not fetch seriesInfo for next episode:', e);
                }
            }
            return { ...result, url: result.url, seekOffset: resumeOffset, startOffset: resumeOffset };
        }, {});
    }
}

window.HomePage = HomePage;
