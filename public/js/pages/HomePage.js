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
        this.homeRailDisplayLimit = 18;
        this.homeRailFetchLimit = 60;
        this.railItems = [];
        this.historyItems = [];
        this.heroItem = null;
        this.contentPreferences = {};
        this.contentPreferenceKey = '';
        this.setupRefreshTimer = null;
        this.setupRecoveryToken = null;
        this.setupRecoverySourceId = null;
        this.setupRecoveryCooldowns = new Map();
        document.addEventListener('norva:source-health-changed', () => {
            this.lastLoadedAt = 0;
            if (this.app?.currentPage === 'home') {
                this.loadDashboardData();
            }
        });
    }

    async init() {
        // Initialization if needed.
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
            if (_homeDone) _homeDone('served from warm in-memory DOM (no fetch)');
            _firstPaintSummary();
            return;
        }

        await this.loadDashboardData();
        if (_homeDone) _homeDone('rails fetched + rendered');
        _firstPaintSummary();
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
                        <h2>Continue Watching</h2>
                    </div>
                    ${this.scrollSection('continue-watching-list', 'Loading history...')}
                </section>

                <div id="home-rails">
                    <section class="dashboard-section">
                        <div class="section-header">
                            <h2>Selection Norva</h2>
                        </div>
                        <div class="horizontal-scroll">${window.MediaUtils.skeletonCards(8)}</div>
                    </section>
                </div>

                <section class="dashboard-section" id="favorite-channels-section">
                    <div class="section-header">
                        <h2>Favorite Channels</h2>
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
            const settings = await window.API.settings.get();
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
        let pid = '';
        try { pid = window.API?.profiles?.getActiveId?.() || ''; } catch (_) { /* default scope */ }
        return 'home-dashboard:' + (pid || 'default');
    }

    async loadDashboardData() {
        if (this.isLoading) return this.loadPromise;
        this.isLoading = true;

        this.loadPromise = (async () => {
            try {
                // Stale-while-revalidate: if a previous Home is cached for this
                // profile, paint it immediately so a cold relaunch shows real content
                // (not skeletons) while the fresh data loads below. contentPreferences
                // is already applied (show() awaits settings first), so badges match.
                try {
                    const cached = window.NorvaCatalogCache?.read?.(this.homeCacheKey());
                    if (cached?.data?.rails) {
                        const ch = Array.isArray(cached.data.history) ? cached.data.history : [];
                        this.renderHistory(ch);
                        this.renderCloudRails(cached.data.rails);
                        this.renderHero(ch, this.railItems);
                    }
                } catch (_) { /* cache paint is best-effort */ }

                // Start the catalogue GETs (history + rails) up front, in parallel
                // with health/settings, so a ready home doesn't wait out a second
                // network round-trip. They're pure data fetches rendered only after
                // the setup-gate check; if the gate shows, the results go unused.
                const railFetchLimit = Math.max(this.homeRailDisplayLimit, this.homeRailFetchLimit);
                const historyP = window.API.request('GET', '/history?limit=18');
                const railsP = window.API.request('GET', `/home/rails?limit=${railFetchLimit}`);

                const [healthResult, settingsResult] = await Promise.allSettled([
                    this.app?.refreshSourceHealth?.() || window.NorvaSourceHealth?.loadSummary?.(),
                    window.API.settings.get()
                ]);

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

                if (this.shouldShowSetupGate(sourceSummary)) {
                    // Gate is showing; the in-flight fetches are unused — attach a
                    // handler so a rejection never surfaces as an unhandled rejection.
                    Promise.allSettled([historyP, railsP]);
                    this.renderSetupGate(sourceSummary || {});
                    this.lastLoadedAt = Date.now();
                    return;
                }

                this.clearSetupGate();

                const [historyResult, railsResult, favoritesResult] = await Promise.allSettled([
                    historyP,
                    railsP,
                    this.renderFavoriteChannels()
                ]);

                const history = historyResult.status === 'fulfilled' && Array.isArray(historyResult.value)
                    ? historyResult.value
                    : [];

                this.renderHistory(history);

                if (railsResult.status === 'fulfilled') {
                    this.renderCloudRails(railsResult.value);
                    this.renderHero(history, this.railItems);
                    // Cache this Home for an instant next cold launch (SWR).
                    try {
                        window.NorvaCatalogCache?.write?.(this.homeCacheKey(), {
                            history,
                            rails: railsResult.value
                        });
                    } catch (_) { /* best-effort */ }
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

    // Home rails are empty. If a service is still syncing, say so and point at the
    // content that is already browsable, instead of the "no service configured" copy.
    renderHomeRailsEmptyState() {
        const summary = this.sourceSummary || {};
        if (summary.state === 'syncing') {
            const manager = this.app?.sourceManager || window.app?.sourceManager;
            const source = this.syncingSourceFromSummary(summary);
            const counts = (manager && manager.catalogCountsFromSource) ? manager.catalogCountsFromSource(source || {}) : {};
            const progress = (manager && manager.syncProgressFromSource) ? manager.syncProgressFromSource(source || {}) : {};
            const fmt = (n) => (manager && manager.formatCatalogCount) ? manager.formatCatalogCount(n) : String(Number(n) || 0);
            const percent = Math.max(0, Math.min(100, Math.round(Number(progress.percent) || 0)));
            const ready = [];
            if (Number(counts.movies) > 0) ready.push(`${fmt(counts.movies)} movies`);
            if (Number(counts.live) > 0) ready.push(`${fmt(counts.live)} live channels`);
            if (Number(counts.series) > 0) ready.push(`${fmt(counts.series)} series`);
            const readyLine = ready.length
                ? `${ready.join(' · ')} already available — open Movies, Live TV or Series while Home finishes building.`
                : 'Your channels and movies will appear here shortly.';
            return `
                <section class="dashboard-section">
                    <div class="empty-state hint home-sync-hint">
                        <strong>Preparing your Home${percent ? ` — ${percent}%` : ''}</strong>
                        <p>${this.escapeHtml(readyLine)}</p>
                    </div>
                </section>
            `;
        }
        return `
            <section class="dashboard-section">
                <div class="empty-state hint">Add a TV service from Settings to build your Home.</div>
            </section>
        `;
    }

    shouldShowSetupGate(summary = null) {
        if (!summary) return true;
        if (summary.state === 'ready') return false;
        if ((summary.ready || []).length) return false;
        // Non-blocking onboarding: once a syncing source has finished its IMPORT, the
        // Movies/Series grids and Live channels are browsable, so don't take over Home
        // with the full-screen gate — render whatever is ready (with a "preparing"
        // notice) and let the rest finalize in the background. The full gate stays only
        // while the initial import is still discovering (nothing to browse yet).
        if (summary.state === 'syncing' && this.syncImportBrowsable(summary)) return false;
        return true;
    }

    // True once at least one syncing source has imported its catalogue (import step
    // done, or already in a finalize stage) — i.e. there is content to browse.
    syncImportBrowsable(summary = {}) {
        const finalizing = new Set(['materializing', 'building_live_channels', 'building_live_variants', 'building_titles', 'finalizing']);
        return [...(summary.issues || []), ...(summary.sources || [])].some(item => {
            const src = (item && item.source) || item || {};
            const cfg = src.configHint || src.config_hint || {};
            const prog = src.syncProgress || src.sync_progress || cfg.syncProgress || cfg.sync_progress || {};
            const steps = (prog && prog.steps) || {};
            const stage = String((prog && prog.stage) || '').toLowerCase();
            return String((steps.import && steps.import.status) || '').toLowerCase() === 'done' || finalizing.has(stage);
        });
    }

    clearSetupGate() {
        if (this.setupRefreshTimer) {
            clearTimeout(this.setupRefreshTimer);
            this.setupRefreshTimer = null;
        }
        const manager = this.app?.sourceManager || window.app?.sourceManager;
        if (this.setupRecoveryToken && manager?.catalogPreparationToken === this.setupRecoveryToken) {
            manager.catalogPreparationToken = null;
        }
        this.setupRecoveryToken = null;
        this.setupRecoverySourceId = null;
        document.getElementById('page-home')?.classList.remove('home-setup-active', 'home-setup-connect-active');
        document.getElementById('home-service-health')?.classList.remove('setup-suppressed');
        document.getElementById('home-hero')?.classList.remove('hidden');
        document.getElementById('continue-watching-section')?.classList.remove('hidden');
        document.getElementById('favorite-channels-section')?.classList.remove('hidden');
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

        const state = summary.state || 'not_configured';
        const copy = this.setupCopy(summary);
        const steps = this.setupSteps(state);
        const secondaryLabel = copy.secondary || 'Check again';
        const showSecondary = secondaryLabel && secondaryLabel !== copy.primary;

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
                <div class="norva-setup-steps" aria-label="Norva setup progress">
                    ${steps.map(step => `
                        <div class="norva-setup-step ${step.state}">
                            <span class="norva-setup-step-index">${this.escapeHtml(step.index)}</span>
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

        if (state === 'syncing') {
            this.setupRefreshTimer = setTimeout(() => {
                this.lastLoadedAt = 0;
                if (this.app?.currentPage === 'home') this.loadDashboardData();
            }, 8000);
        }
    }

    renderSetupSyncingGate(container, summary = {}) {
        const manager = this.app?.sourceManager || window.app?.sourceManager;
        const source = this.syncingSourceFromSummary(summary);
        const type = source?.type || source?.source_type || source?.sourceType || 'xtream';
        const sourceView = manager?.sourceWithStatus ? manager.sourceWithStatus(source || {}) : (source || {});
        const progressHtml = manager?.renderCatalogPreparation
            ? manager.renderCatalogPreparation(sourceView, type)
            : this.renderSetupSyncFallback(summary);

        container.innerHTML = `
            <section class="norva-setup-gate norva-setup-sync-embedded" data-setup-state="syncing">
                <div class="norva-setup-sync-copy">
                    <div class="norva-setup-kicker">Norva setup</div>
                    <h1>Preparing your catalog</h1>
                    <p>Norva is importing your TV service and unlocking Home, Live TV, Movies and Series as soon as the catalog is ready.</p>
                    <div class="norva-setup-actions">
                        <button class="btn btn-primary" id="norva-setup-sync-refresh">Refresh progress</button>
                        <button class="btn btn-secondary" id="norva-setup-sync-settings">TV Service settings</button>
                    </div>
                </div>
                <div class="norva-setup-sync-panel" aria-label="Catalog import progress">
                    ${progressHtml}
                </div>
            </section>
        `;

        container.querySelector('#norva-setup-sync-refresh')?.addEventListener('click', () => {
            this.lastLoadedAt = 0;
            this.loadDashboardData();
        });
        container.querySelector('#norva-setup-sync-settings')?.addEventListener('click', () => {
            this.app?.navigateTo?.('settings');
            setTimeout(() => this.app?.pages?.settings?.switchTab?.('sources'), 0);
        });

        this.maybeRecoverSetupCatalogFinalization(sourceView, type);

        this.setupRefreshTimer = setTimeout(() => {
            this.lastLoadedAt = 0;
            if (this.app?.currentPage === 'home') this.loadDashboardData();
        }, 4000);
    }

    maybeRecoverSetupCatalogFinalization(sourceView = {}, type = 'xtream') {
        const manager = this.app?.sourceManager || window.app?.sourceManager;
        if (!manager?.shouldRecoverCatalogFinalization || !manager?.recoverCatalogFinalization) return;
        const api = window.API || (typeof API !== 'undefined' ? API : null);
        if (!api?.sources?.finalize || !api?.sources?.getById) return;

        const sourceId = sourceView.cloudId || sourceView.cloud_id || sourceView.id || sourceView.source_id;
        if (!sourceId || !this.shouldRecoverSetupCatalogFinalization(sourceView, manager)) return;

        const sourceKey = String(sourceId);
        const retryAt = Number(this.setupRecoveryCooldowns.get(sourceKey) || 0);
        if (retryAt && Date.now() < retryAt) return;
        if (this.setupRecoveryToken && this.setupRecoverySourceId === sourceKey) return;

        const token = Symbol('home-catalog-recovery');
        this.setupRecoveryToken = token;
        this.setupRecoverySourceId = sourceKey;
        manager.catalogPreparationToken = token;

        const render = (latestSource) => {
            if (this.setupRecoveryToken !== token || this.app?.currentPage !== 'home') return;
            const latestView = manager.sourceWithStatus
                ? manager.sourceWithStatus(latestSource || sourceView)
                : (latestSource || sourceView);
            const panel = document.querySelector('.norva-setup-sync-panel');
            if (panel && manager.renderCatalogPreparation) {
                panel.innerHTML = manager.renderCatalogPreparation(latestView, type);
            }
        };

        manager.recoverCatalogFinalization(sourceId, token, render)
            .then(() => {
                if (this.setupRecoveryToken !== token) return;
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
                if (manager.catalogPreparationToken === token) manager.catalogPreparationToken = null;
                if (this.setupRecoveryToken === token) {
                    this.setupRecoveryToken = null;
                    this.setupRecoverySourceId = null;
                }
            });
    }

    shouldRecoverSetupCatalogFinalization(sourceView = {}, manager = null) {
        if (manager?.shouldRecoverCatalogFinalization?.(sourceView)) return true;

        const progress = manager?.syncProgressFromSource?.(sourceView)
            || sourceView.syncProgress
            || sourceView.sync_progress
            || sourceView.configHint?.syncProgress
            || sourceView.config_hint?.syncProgress
            || {};
        const steps = progress.steps && typeof progress.steps === 'object' ? progress.steps : {};
        const counts = progress.counts && typeof progress.counts === 'object' ? progress.counts : {};
        const status = String(progress.status || sourceView.syncStatus || sourceView.sync_status || '').toLowerCase();
        const stage = String(progress.stage || '').toLowerCase();
        const importStatus = String(steps.import?.status || '').toLowerCase();
        const finalizeStatus = String(steps.finalize?.status || '').toLowerCase();
        const total = Number(counts.total || counts.items || manager?.catalogCountsFromSource?.(sourceView)?.total || 0) || 0;

        const finalizingStages = new Set([
            'materializing',
            'building_live_channels',
            'building_live_variants',
            'building_titles',
            'finalizing'
        ]);
        const finalizing = finalizingStages.has(stage) || ['running', 'in_progress', 'pending'].includes(finalizeStatus);

        return status === 'syncing'
            && importStatus === 'done'
            && total > 0
            && finalizing;
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
            <div class="norva-setup-steps">
                ${steps.map(step => `
                    <div class="norva-setup-step ${step.state}">
                        <span class="norva-setup-step-index">${this.escapeHtml(step.index)}</span>
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
        document.getElementById('page-home')?.classList.add('home-setup-connect-active');
        container.innerHTML = `
            <section class="norva-setup-gate norva-setup-connect" data-setup-state="not_configured" data-paired-screen="false">
                <div class="norva-setup-connect-card">
                    <div class="norva-setup-kicker">Norva setup</div>
                    <h1>Enter your service details</h1>
                    <p>Paste the complete link from your TV service, or enter the server URL, username and password separately.</p>
                    <form class="norva-setup-inline-form" id="home-tv-service-form" autocomplete="off">
                        <div class="form-group">
                            <label for="home-source-url">Provider URL or complete Xtream link</label>
                            <input type="text" id="home-source-url" class="form-input setup-form-input"
                                   placeholder="https://provider.com/get.php?username=...&password=..."
                                   inputmode="url" autocomplete="off">
                            <p class="setup-form-hint" id="home-source-url-hint">If you paste a full Xtream link, Norva will fill the login fields automatically.</p>
                        </div>
                        <div class="form-group setup-service-name-group">
                            <label for="home-source-name">Service name <span class="label-optional">(optional)</span></label>
                            <input type="text" id="home-source-name" class="form-input setup-form-input" placeholder="Family TV" autocomplete="off">
                        </div>
                        <details class="source-advanced-login setup-manual-login" id="home-source-advanced" open>
                            <summary>Enter server login manually</summary>
                            <p class="setup-form-hint">Auto-filled when a complete link is pasted above.</p>
                            <div class="setup-manual-grid">
                                <div class="form-group">
                                    <label for="home-source-username">Username</label>
                                    <input type="text" id="home-source-username" class="form-input setup-form-input" placeholder="username" autocomplete="off">
                                </div>
                                <div class="form-group">
                                    <label for="home-source-password">Password</label>
                                    <div class="setup-password-field">
                                        <input type="password" id="home-source-password" class="form-input setup-form-input" placeholder="password" autocomplete="off">
                                        <button type="button" class="setup-password-toggle" id="home-source-password-toggle" aria-label="Show password">${Icons.hide}</button>
                                    </div>
                                </div>
                            </div>
                        </details>
                        <div class="norva-setup-error hidden" id="home-tv-service-error" role="alert"></div>
                        <button class="btn btn-primary norva-setup-submit" id="home-tv-service-submit" type="submit">Connect TV Service</button>
                    </form>
                </div>
                <aside class="norva-setup-progress-panel" aria-label="Norva setup progress">
                    <div class="norva-setup-progress-kicker">Progress panel</div>
                    ${steps.map((step, index) => this.renderSetupProgressStep(step, index)).join('')}
                </aside>
            </section>
        `;
        this.bindSetupConnectionForm(container);
    }

    renderSetupProgressStep(step, index) {
        const stepMark = step.state === 'complete' ? Icons.check : String(index + 1);
        const lock = step.state === 'pending' ? `<span class="norva-setup-lock" aria-label="Locked">${Icons.circle}</span>` : '';
        return `
            <div class="norva-setup-step norva-setup-progress-step ${this.escapeAttr(step.state)}">
                <span class="norva-setup-step-index">${stepMark}</span>
                <div>
                    <strong>${this.escapeHtml(index + 1)}. ${this.escapeHtml(step.title)}</strong>
                    <span>${this.escapeHtml(step.hint)}</span>
                </div>
                ${lock}
            </div>
        `;
    }

    bindSetupConnectionForm(container) {
        const form = container.querySelector('#home-tv-service-form');
        const urlInput = container.querySelector('#home-source-url');
        const nameInput = container.querySelector('#home-source-name');
        const usernameInput = container.querySelector('#home-source-username');
        const passwordInput = container.querySelector('#home-source-password');
        const passwordToggle = container.querySelector('#home-source-password-toggle');
        const advancedLogin = container.querySelector('#home-source-advanced');
        const hint = container.querySelector('#home-source-url-hint');
        const error = container.querySelector('#home-tv-service-error');
        const submit = container.querySelector('#home-tv-service-submit');
        const manager = this.app?.sourceManager || window.app?.sourceManager;
        if (!form || !urlInput || !usernameInput || !passwordInput || !submit) return;

        const applyParsedLink = (force = false) => {
            const parsed = manager?.parseXtreamLink?.(urlInput.value);
            if (!parsed) {
                if (hint) hint.textContent = 'If you paste a full Xtream link, Norva will fill the login fields automatically.';
                return;
            }
            if (parsed.serverUrl) urlInput.value = parsed.serverUrl;
            if (nameInput && !nameInput.value.trim() && parsed.host) {
                nameInput.value = parsed.host.replace(/^www\./i, '');
            }
            if (parsed.username && (force || !usernameInput.value.trim())) usernameInput.value = parsed.username;
            if (parsed.password && (force || !passwordInput.value.trim())) passwordInput.value = parsed.password;
            if ((!parsed.username || !parsed.password) && advancedLogin) advancedLogin.open = true;
            if (hint) {
                hint.textContent = parsed.username && parsed.password
                    ? 'Login detected from the link. You can review it before connecting.'
                    : 'Server detected. Add the username and password if they were provided separately.';
            }
        };

        urlInput.addEventListener('paste', () => setTimeout(() => applyParsedLink(true), 0));
        urlInput.addEventListener('blur', () => applyParsedLink(false));
        urlInput.addEventListener('change', () => applyParsedLink(false));

        passwordToggle?.addEventListener('click', () => {
            const visible = passwordInput.type === 'text';
            passwordInput.type = visible ? 'password' : 'text';
            passwordToggle.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
        });

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (error) {
                error.classList.add('hidden');
                error.textContent = '';
            }

            let payload;
            try {
                payload = this.readSetupConnectionForm(container);
            } catch (err) {
                if (error) {
                    error.textContent = err.message;
                    error.classList.remove('hidden');
                }
                advancedLogin.open = true;
                return;
            }

            submit.disabled = true;
            submit.textContent = 'Connecting...';
            try {
                const createdSource = await window.API.sources.create({ type: 'xtream', ...payload });
                await this.app?.sourceManager?.loadSources?.();
                document.dispatchEvent(new CustomEvent('norva:source-health-changed'));
                submit.textContent = 'Preparing catalog...';
                this.lastLoadedAt = 0;
                await this.app?.refreshSourceHealth?.();
                await this.loadDashboardData();
            } catch (err) {
                console.error('[Dashboard] TV service connection failed:', err);
                if (error) {
                    error.textContent = err.message || 'Unable to connect this TV service.';
                    error.classList.remove('hidden');
                }
                submit.disabled = false;
                submit.textContent = 'Connect TV Service';
            }
        });
    }

    readSetupConnectionForm(container) {
        const manager = this.app?.sourceManager || window.app?.sourceManager;
        let url = container.querySelector('#home-source-url')?.value.trim() || '';
        let name = container.querySelector('#home-source-name')?.value.trim() || '';
        let username = container.querySelector('#home-source-username')?.value.trim() || '';
        let password = container.querySelector('#home-source-password')?.value.trim() || '';
        const parsed = manager?.parseXtreamLink?.(url);

        if (parsed) {
            url = parsed.serverUrl || url;
            username = username || parsed.username || '';
            password = password || parsed.password || '';
        }

        if (!url) throw new Error('Provider URL is required.');
        if (!username || !password) throw new Error('Username and password are required.');

        if (!name) {
            const hostName = parsed?.host || manager?.hostFromUrl?.(url) || 'TV service';
            name = hostName ? hostName.replace(/^www\./i, '') : 'TV service';
        }
        return { name, url, username, password };
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
                hint: state === 'syncing' ? 'Importing content now.' : ready ? 'Catalog ready.' : 'Norva prepares channels, movies and series after connection.',
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

        const rails = [];
        if (moviesResult.status === 'fulfilled' && moviesResult.value?.length) {
            rails.push({ id: 'recently-added-movies', title: 'Recently Added Movies', items: moviesResult.value });
        }
        if (seriesResult.status === 'fulfilled' && seriesResult.value?.length) {
            rails.push({ id: 'recently-added-series', title: 'Recently Added Series', items: seriesResult.value });
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
                items: this.rankRailItemsByLanguagePreference(rail.items).slice(0, this.homeRailDisplayLimit)
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

        return `
            <section class="dashboard-section home-rail-section${ranked ? ' is-ranked-rail' : ''}" data-rail-id="${this.escapeAttr(rail.id || id)}">
                <div class="section-header home-rail-header">
                    <div>
                        <h2>${this.escapeHtml(title)}</h2>
                        ${subtitle ? `<p class="home-rail-subtitle">${this.escapeHtml(subtitle)}</p>` : ''}
                    </div>
                </div>
                ${this.scrollSection(id, 'Loading...', '', items.map((item, itemIndex) => this.createRailCard(item, railIndex, itemIndex, ranked)).join(''))}
            </section>
        `;
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
        if (id.startsWith('because-you-watched')) return 'Because You Watched';
        return rail.title || rail.name || 'Norva Selection';
    }

    railSubtitle(rail = {}) {
        const id = String(rail.id || '').toLowerCase();
        if (id.startsWith('because-you-watched')) return 'Suggestions based on your watch history';
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

        return `
            <div class="dashboard-card" data-id="${this.escapeAttr(itemId)}" data-type="${this.escapeAttr(type)}" data-rail-index="${railIndex}" data-item-index="${itemIndex}">
                <div class="card-image">
                    ${ranked ? `<div class="rank-numeral">${itemIndex + 1}</div>` : ''}
                    <img src="${this.escapeAttr(posterUrl)}" alt="${this.escapeAttr(title)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'">
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

        list.querySelectorAll('.ch-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeHistoryItem(Number(btn.dataset.historyIndex));
            });
        });

        this.updateScrollArrows();
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
        if (recordId == null) return;
        try { await window.API?.history?.remove?.(recordId); } catch (_) { /* best-effort */ }
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
        const remainingMin = duration > progress ? Math.max(1, Math.round((duration - progress) / 60)) : 0;
        const timeLeft = remainingMin > 0 ? `${remainingMin} min left` : '';

        return `
            <div class="dashboard-card" data-id="${this.escapeAttr(itemId)}" data-type="${this.escapeAttr(type)}" data-history-index="${index}">
                <div class="card-image">
                    <img src="${this.escapeAttr(posterUrl)}" alt="${this.escapeAttr(title)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'">
                    <button class="ch-remove" type="button" data-history-index="${index}" aria-label="Remove from Continue Watching">✕</button>
                    ${timeLeft ? `<div class="card-timeleft">${timeLeft}</div>` : ''}
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

    navigateToSeries(item) {
        if (!this.app.pages.series) return;
        const group = this.buildHomeMediaGroup(item, 'series');

        this.app.navigateTo('series');
        setTimeout(() => {
            const page = this.app.pages.series;
            const versions = MediaUtils.orderVersionsByPreference(group.items, page.getPreferences?.() || {});
            const series = versions[0] || group.representative;
            page.currentSeriesGroup = group;
            page.showSeriesDetailsV2(series, group);
        }, 100);
    }

    navigateToMovie(item) {
        if (!this.app.pages.movies) return;
        const group = this.buildHomeMediaGroup(item, 'movie');

        this.app.navigateTo('movies');
        setTimeout(() => {
            const page = this.app.pages.movies;
            const versions = MediaUtils.orderVersionsByPreference(group.items, page.getPreferences?.() || {});
            const selected = versions[0] || group.representative;
            page.showMovieDetails(group, selected, { versions });
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
        const audioStreamIndex = Number(playbackPreferences?.audio?.streamIndex ?? playbackPreferences?.audio?.stream_index);
        if (Number.isInteger(audioStreamIndex)) {
            playbackHint.audioStreamIndex = audioStreamIndex;
        }

        // Live H.264 → remux (copy video), H.265/HEVC → full transcode.
        if (streamType === 'live' && !playbackHint.gatewayMode && window.MediaUtils?.liveGatewayMode) {
            playbackHint.gatewayMode = MediaUtils.liveGatewayMode(item);
        }

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
            titleId: data.titleId || item.titleId || item.title_id || null,
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
        await watch.play(content, async () => {
            const result = await window.API.proxy.xtream.getStreamUrl(
                sourceId,
                streamId,
                streamType,
                container,
                playbackHint
            );
            if (!result || !result.url) return null;
            if (type === 'episode' && content.seriesId && sourceId) {
                try {
                    const seriesInfo = await window.API.request('GET', `/proxy/xtream/${sourceId}/series_info?series_id=${content.seriesId}`);
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
