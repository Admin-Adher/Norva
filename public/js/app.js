/**
 * Norva Application Entry Point
 */

class App {
    constructor() {
        this.currentPage = 'home';
        this.pages = {};
        this.currentUser = null;

        // Initialize components
        this.player = new VideoPlayer();
        this.channelList = new ChannelList();
        this.sourceManager = new SourceManager();
        this.epgGuide = new EpgGuide();
        this.liveGuideFusion = new LiveGuideFusion(this);

        // Initialize page controllers
        this.pages.home = new HomePage(this);
        this.pages.live = new LivePage(this);
        this.pages.movies = new MoviesPage(this);
        this.pages.series = new SeriesPage(this);
        this.pages.settings = new SettingsPage(this);
        this.pages.watch = new WatchPage(this);
        this.entitlement = null;
        this.sourceHealthSummary = null;
        this.catalogPages = new Set(['live', 'movies', 'series']);

        this.init();
    }

    async init() {
        // On the hosted web app, Norva Account is the product entry point.
        const host = window.location.hostname;
        const isRemote = host !== 'localhost' && host !== '127.0.0.1' && host !== '';
        if (isRemote && !this.hasCloudSession()) {
            const returnTo = window.location.pathname + window.location.search + window.location.hash;
            window.location.replace('/account.html?returnTo=' + encodeURIComponent(returnTo || '/'));
            return;
        }

        // Check authentication first
        await this.checkAuth();
        if (!await this.checkCloudAccess()) return;
        // Netflix-style "who's watching": pick a profile before entering the app.
        try { if (window.NorvaProfiles?.ensureSelected) await window.NorvaProfiles.ensureSelected(); } catch (_) { }
        // Surface the always-visible navbar profile avatar (one-tap switcher).
        try { if (window.NorvaProfiles?.refreshNavAvatar) await window.NorvaProfiles.refreshNavAvatar(); } catch (_) { }
        this.applyCatalogAvailability(null);
        this.startCloudWarmKeep();
        this.startEnrichmentProgressPoll();

        // Mobile menu toggle
        const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
        const navbarMenu = document.getElementById('navbar-menu');

        if (mobileMenuToggle && navbarMenu) {
            mobileMenuToggle.addEventListener('click', () => {
                mobileMenuToggle.classList.toggle('active');
                navbarMenu.classList.toggle('active');
            });

            // Close menu when a nav link is clicked
            document.querySelectorAll('.nav-link').forEach(link => {
                link.addEventListener('click', () => {
                    mobileMenuToggle.classList.remove('active');
                    navbarMenu.classList.remove('active');
                });
            });

            // Close menu when clicking outside
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.navbar')) {
                    mobileMenuToggle.classList.remove('active');
                    navbarMenu.classList.remove('active');
                }
            });
        }

        // Channel drawer toggle (mobile)
        const channelToggleBtn = document.getElementById('channel-toggle-btn');
        const channelSidebar = document.getElementById('channel-sidebar');
        const channelOverlay = document.getElementById('channel-sidebar-overlay');
        const homeLayout = document.querySelector('.home-layout');

        const syncLiveNavigationState = () => {
            if (!homeLayout || !channelSidebar) return;
            const isMobileDrawer = window.matchMedia('(max-width: 768px)').matches;
            const isSidebarOpen = isMobileDrawer
                ? channelSidebar.classList.contains('active')
                : !channelSidebar.classList.contains('collapsed');

            homeLayout.classList.toggle('sidebar-open', isSidebarOpen);
            homeLayout.classList.toggle('sidebar-collapsed', !isSidebarOpen);
            this.liveGuideFusion?.syncNavigationState?.();
        };

        if (channelToggleBtn && channelSidebar && channelOverlay) {
            const toggleChannelDrawer = () => {
                channelSidebar.classList.toggle('active');
                channelOverlay.classList.toggle('active');
                syncLiveNavigationState();
            };

            channelToggleBtn.addEventListener('click', toggleChannelDrawer);
            channelOverlay.addEventListener('click', toggleChannelDrawer);

            // Close drawer when a channel is selected
            channelSidebar.addEventListener('click', (e) => {
                if (e.target.closest('.channel-item')) {
                    // Small delay to let the channel selection happen
                    setTimeout(() => {
                        channelSidebar.classList.remove('active');
                        channelOverlay.classList.remove('active');
                        syncLiveNavigationState();
                    }, 300);
                }
            });
        }

        // Desktop sidebar collapse toggle
        const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
        const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');

        const toggleSidebarCollapse = () => {
            channelSidebar?.classList.toggle('collapsed');

            // Persist preference
            const isCollapsed = channelSidebar?.classList.contains('collapsed');
            localStorage.setItem('sidebarCollapsed', isCollapsed ? 'true' : 'false');
            syncLiveNavigationState();
        };

        sidebarCollapseBtn?.addEventListener('click', toggleSidebarCollapse);
        sidebarExpandBtn?.addEventListener('click', toggleSidebarCollapse);

        // Restore sidebar state from localStorage
        if (localStorage.getItem('sidebarCollapsed') === 'true') {
            channelSidebar?.classList.add('collapsed');
        }
        syncLiveNavigationState();
        window.addEventListener('resize', syncLiveNavigationState);

        // Navigation handling
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                if (link.dataset.external === 'true') return;
                // Downloads opens the NATIVE offline screen (not an SPA page) so
                // it works with no connectivity. Phone/tablet app only.
                if (link.dataset.action === 'account') {
                    e.preventDefault();
                    this.openAccountSheet();
                    return;
                }
                if (link.dataset.action === 'downloads') {
                    e.preventDefault();
                    document.getElementById('mobile-menu-toggle')?.classList.remove('active');
                    document.getElementById('navbar-menu')?.classList.remove('active');
                    try { window.NorvaTVCloud?.openDownloads?.(); } catch (_) { /* no bridge */ }
                    return;
                }
                e.preventDefault();
                this.navigateTo(link.dataset.page);
            });
        });

        // Global search (movies + series) from the top bar.
        document.getElementById('nav-search')?.addEventListener('click', () => this.openSearch());

        // Surface the Downloads menu entry once the native app has ≥1 download.
        this.refreshDownloadsNav();
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this.refreshDownloadsNav();
        });

        const navbarBrandHome = document.getElementById('navbar-brand-home');
        const goHomeFromBrand = (event) => {
            event.preventDefault();
            mobileMenuToggle?.classList.remove('active');
            navbarMenu?.classList.remove('active');
            this.navigateTo('home');
        };
        navbarBrandHome?.addEventListener('click', goHomeFromBrand);
        navbarBrandHome?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            goHomeFromBrand(event);
        });

        document.addEventListener('norva:source-health-changed', () => {
            this.refreshSourceHealth({ redirectIfBlocked: true });
        });

        // Now Playing indicator
        const nowPlayingBtn = document.getElementById('now-playing-indicator');
        if (nowPlayingBtn) {
            nowPlayingBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo('watch');
            });
        }

        this.initMobileCatalogControls();

        // Toggle groups button
        document.getElementById('toggle-groups').addEventListener('click', () => {
            this.channelList.toggleAllGroups();
        });

        // Search clear buttons (global handler for all)
        document.querySelectorAll('.search-clear').forEach(btn => {
            btn.addEventListener('click', () => {
                const wrapper = btn.closest('.search-wrapper');
                const input = wrapper?.querySelector('.search-input');
                if (input) {
                    input.value = '';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.focus();
                }
            });
        });

        // Handle browser back/forward buttons
        window.addEventListener('popstate', (e) => {
            const page = e.state?.page || 'home';
            this.navigateTo(page, false); // false = don't add to history
        });

        // Initialize home page first (it's needed for channel list)
        await this.pages.home.init();

        await this.refreshSourceHealth();

        // Preload EPG data in background (non-blocking)
        // This ensures EPG info is available on Live TV page without visiting Guide first
        this.epgGuide.loadEpg().catch(err => {
            console.warn('Background EPG load failed:', err.message);
        });

        // Navigate to the page from URL hash, or default to home
        const hash = window.location.hash.slice(1); // Remove #
        const requestedInitialPage = hash && this.pages[hash] ? hash : 'home';
        const initialPage = this.guardCatalogPage(requestedInitialPage);
        this.navigateTo(initialPage, true); // true = replace history (don't add)

        this.maybeShowTrialBanner();
        this.maybeShowBillingIssueBanner();

        // Keep the catalogue fresh: a few seconds after launch, silently re-sync
        // any provider that's gone stale. Non-blocking, and cheap when nothing
        // changed (server-side change-detection skips the rebuild).
        setTimeout(() => { this.maybeAutoRefreshSources().catch(() => {}); }, 4000);

        console.log('Norva initialized');
    }

    /**
     * Refresh-on-open: silently re-sync providers that are older than the user's
     * chosen interval. Single-flight (skips anything already syncing), background
     * (never blocks the UI), and a no-op server-side when the catalogue is
     * unchanged. The visible "Keep up to date" toggle lives in TV Service.
     */
    async maybeAutoRefreshSources() {
        if (!window.API?.sources?.getAll) return;
        const settings = this.player?.settings || {};
        const enabled = settings.autoRefreshEnabled !== false;
        const intervalHours = Number(settings.autoRefreshIntervalHours);
        const staleMs = (Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 24) * 3600000;

        let sources = [];
        try { sources = await API.sources.getAll(); } catch (_) { sources = []; }
        const providers = (sources || []).filter(s => s.type === 'xtream' || s.type === 'm3u');
        const now = Date.now();
        const syncs = [];

        if (enabled) {
            for (const src of providers) {
                const status = src.syncStatus || src.sync_status || '';
                if (status === 'syncing') continue; // single-flight: don't pile on
                const lastRaw = src.last_synced_at || src.lastSyncedAt || src.last_sync || null;
                const lastMs = lastRaw ? new Date(lastRaw).getTime() : 0;
                if (lastMs && (now - lastMs) < staleMs) continue; // still fresh enough

                // Stale → fire a silent background sync (cheap when unchanged).
                console.log('[AutoRefresh] background sync (stale provider):', src.id);
                syncs.push(Promise.resolve(API.sources.sync(src.id))
                    .catch((e) => console.warn('[AutoRefresh] background sync failed', src.id, e?.message || e)));
            }
        }

        // Let the background syncs settle, then surface the "what's new" feed
        // (also catches events from a previous session or another device).
        try { await Promise.allSettled(syncs); } catch (_) { /* noop */ }
        try { this.refreshSourceHealth?.(); } catch (_) { /* noop */ }
        await this.surfaceWhatsNew();
    }

    /**
     * Free in-app notification: show unseen "what's new" events (new movies /
     * shows / channels detected on a recent sync), then mark them read so they
     * don't repeat. Best-effort and silent on any error.
     */
    async surfaceWhatsNew() {
        try {
            if (!window.NorvaCloud?.contentEvents?.list) return;
            const res = await window.NorvaCloud.contentEvents.list();
            const events = (res && res.events) || [];
            if (!events.length) return;
            const summary = events.map(e => e && e.summary).filter(Boolean).slice(0, 3).join(' · ');
            if (summary) {
                try { this.sourceManager?.toast?.(`✨ What’s new: ${summary}`); } catch (_) { /* noop */ }
            }
            const ids = events.map(e => e && e.id).filter(Boolean);
            if (ids.length) window.NorvaCloud.contentEvents.markSeen(ids);
        } catch (_) { /* never break launch over a notification */ }
    }

    async refreshSourceHealth({ redirectIfBlocked = false } = {}) {
        if (!window.NorvaSourceHealth?.loadSummary) {
            this.applyCatalogAvailability(null);
            return null;
        }

        try {
            const summary = await window.NorvaSourceHealth.loadSummary();
            this.sourceHealthSummary = summary;
            this.applyCatalogAvailability(summary);

            if (redirectIfBlocked && this.isCatalogPage(this.currentPage) && !this.isCatalogReady()) {
                this.navigateTo('home', true);
            }

            window.dispatchEvent(new CustomEvent('norva:catalog-availability-changed', {
                detail: {
                    ready: this.isCatalogReady(),
                    summary
                }
            }));

            return summary;
        } catch (err) {
            console.warn('[Norva] Unable to refresh TV service health:', err);
            this.applyCatalogAvailability(this.sourceHealthSummary);
            return this.sourceHealthSummary;
        }
    }

    isCatalogPage(pageName) {
        return this.catalogPages.has(pageName);
    }

    isCatalogReady(summary = this.sourceHealthSummary) {
        if (!summary) return false;
        return summary.state === 'ready' || Boolean(summary.ready?.length);
    }

    guardCatalogPage(pageName) {
        return this.isCatalogPage(pageName) && !this.isCatalogReady() ? 'home' : pageName;
    }

    applyCatalogAvailability(summary = this.sourceHealthSummary) {
        const ready = this.isCatalogReady(summary);
        document.body.classList.toggle('catalog-locked', !ready);
        document.querySelectorAll('.nav-link[data-page="live"], .nav-link[data-page="movies"], .nav-link[data-page="series"]').forEach(link => {
            link.classList.toggle('catalog-nav-hidden', !ready);
            link.hidden = !ready;
            link.setAttribute('aria-hidden', ready ? 'false' : 'true');
            link.tabIndex = ready ? 0 : -1;
        });
    }

    hasCloudSession() {
        try {
            if (window.NorvaCloud?.deviceToken || localStorage.getItem('norva-cloud-device-token')) {
                return true;
            }

            const session = JSON.parse(localStorage.getItem('norva-cloud-session') || 'null');
            const now = Math.floor(Date.now() / 1000);
            return Boolean(
                session?.access_token &&
                session?.refresh_token &&
                session?.user?.id &&
                (!session.expires_at || Number(session.expires_at) > now + 30)
            );
        } catch (_) {
            return false;
        }
    }

    // Keep the Supabase edge functions warm so the first catalog call after a
    // lull (or returning to the tab/app) doesn't pay a cold start. Only while
    // visible and signed in; pauses when hidden.
    startCloudWarmKeep() {
        if (!window.API?.isCloudMode?.() || typeof window.NorvaCloud?.warmUp !== 'function') return;
        const ping = () => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            if (!this.hasCloudSession()) return;
            try { window.NorvaCloud.warmUp(); } catch (_) { /* best-effort */ }
        };
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') ping();
            });
        }
        if (this._warmKeepTimer) clearInterval(this._warmKeepTimer);
        this._warmKeepTimer = setInterval(ping, 4 * 60 * 1000);
    }

    // Thin header bar showing background catalog enrichment (TMDB matching) progress, so a
    // freshly-onboarded user understands missing posters are filling in — not broken. Hidden
    // once the catalog is essentially enriched (>=98%) or empty. Cloud mode only, best-effort.
    startEnrichmentProgressPoll() {
        if (!window.API?.isCloudMode?.()) return;
        const bar = document.getElementById('enrichment-bar');
        if (!bar) return;
        const fill = bar.querySelector('.enrichment-bar__fill');
        const text = bar.querySelector('.enrichment-bar__text');
        const tick = async () => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            if (!this.hasCloudSession?.()) { bar.hidden = true; return; }
            try {
                const p = await window.NorvaCloud?.mediaItems?.enrichmentProgress?.();
                const percent = Number(p?.percent);
                const total = Number(p?.total) || 0;
                // The server reports "settled" once the background enrichment crons have
                // finished their pass. The matched % plateaus permanently (some titles never
                // match TMDB / never verify), so settled — not the % — is what ends the bar.
                const settled = p?.settled === true;
                // Fallback for older edge builds without the flag: hide once the % stops
                // climbing for ~3 polls.
                if (percent === this._lastEnrichPercent) {
                    this._enrichStall = (this._enrichStall || 0) + 1;
                } else {
                    this._enrichStall = 0;
                    this._lastEnrichPercent = percent;
                }
                const stalled = (this._enrichStall || 0) >= 3;
                if (!Number.isFinite(percent) || total < 1 || settled || stalled) {
                    bar.hidden = true;
                } else {
                    if (fill) fill.style.width = percent + '%';
                    if (text) text.textContent = `Enrichissement du catalogue… ${percent}%`;
                    bar.hidden = false;
                }
            } catch (_) { /* best-effort; keep the last shown state */ }
        };
        tick();
        if (this._enrichTimer) clearInterval(this._enrichTimer);
        this._enrichTimer = setInterval(tick, 45 * 1000);
    }

    async checkAuth() {
        if (window.API?.isCloudMode?.()) {
            try {
                const user = window.NorvaAuth
                    ? await window.NorvaAuth.getUser()
                    : JSON.parse(localStorage.getItem('norva-cloud-session') || 'null')?.user;

                if (!user && !window.NorvaCloud?.deviceToken) {
                    const returnTo = window.location.pathname + window.location.search + window.location.hash;
                    window.location.replace('/account.html?returnTo=' + encodeURIComponent(returnTo || '/'));
                    return;
                }

                this.currentUser = {
                    id: user?.id || localStorage.getItem('norva-cloud-device-id') || 'paired-device',
                    username: user?.email || 'Paired Norva screen',
                    email: user?.email || '',
                    role: 'admin',
                    cloud: true,
                    device: !user
                };
                this.addLogoutButton();
                return;
            } catch (err) {
                console.error('Cloud authentication error:', err);
                const returnTo = window.location.pathname + window.location.search + window.location.hash;
                window.location.replace('/account.html?returnTo=' + encodeURIComponent(returnTo || '/'));
                return;
            }
        }

        const token = localStorage.getItem('authToken');
        const hub = _hubBase();

        if (!token) {
            // No token, redirect to login (replace to avoid back button issues)
            window.location.replace(hub ? `${hub}/login.html` : '/login.html');
            return;
        }

        try {
            // Verify token with server
            const response = await fetch(`${hub}/api/auth/me`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error('Invalid token');
            }

            this.currentUser = await response.json();

            // Hide settings for viewers
            if (this.currentUser.role === 'viewer') {
                const settingsLink = document.querySelector('.nav-link[data-page="settings"]');
                if (settingsLink) {
                    settingsLink.style.display = 'none';
                }
            }

            // Add logout button to navbar
            this.addLogoutButton();

        } catch (err) {
            console.error('Authentication error:', err);
            localStorage.removeItem('authToken');
            window.location.replace('/login.html');
        }
    }

    async checkCloudAccess() {
        if (!window.API?.isCloudMode?.() || !window.NorvaCloud?.entitlements) return true;

        try {
            const decision = this.currentUser?.device
                ? await window.NorvaCloud.entitlements.device()
                : await window.NorvaCloud.entitlements.get();

            this.entitlement = decision;
            window.NorvaEntitlement = decision;

            if (decision && decision.allowed === false) {
                this.redirectToPaywall(decision);
                return false;
            }
        } catch (err) {
            if (err?.status === 401) {
                const returnTo = window.location.pathname + window.location.search + window.location.hash;
                window.location.replace('/account.html?returnTo=' + encodeURIComponent(returnTo || '/'));
                return false;
            }
            // Billing uncertainty must fail open: a temporary entitlement outage
            // should not lock a household out of their own TV service.
            console.warn('[Norva] Unable to verify access, continuing temporarily:', err);
            this.entitlement = {
                allowed: true,
                failOpen: true,
                reason: 'client_entitlement_check_failed',
                message: 'Norva access could not be verified locally.'
            };
            window.NorvaEntitlement = this.entitlement;
        }
        return true;
    }

    redirectToPaywall(decision) {
        const returnTo = window.location.pathname + window.location.search + window.location.hash;
        sessionStorage.setItem('norva-entitlement-denied', JSON.stringify({
            reason: decision?.reason || 'subscription_required',
            status: decision?.status || '',
            message: decision?.message || 'Norva access is required.'
        }));
        window.location.replace('/paywall.html?returnTo=' + encodeURIComponent(returnTo || '/'));
    }

    // Gentle "X days left in your trial" banner. Only shows when a trial is
    // actually enforced (dormant in observe mode), reads the entitlement's
    // trial end date, is dismissible, and re-appears as the day count changes so
    // it never nags twice in the same day.
    maybeShowTrialBanner() {
        try {
            const ent = this.entitlement || window.NorvaEntitlement;
            if (!ent || ent.enforced !== true || ent.status !== 'trialing') return;
            const endIso = ent.projection?.trial_ends_at || ent.projection?.current_period_end;
            if (!endIso) return;
            const msLeft = new Date(endIso).getTime() - Date.now();
            if (!(msLeft > 0)) return;
            const daysLeft = Math.max(1, Math.ceil(msLeft / 86400000));
            if (sessionStorage.getItem('norva-trial-banner-dismissed') === String(daysLeft)) return;
            if (document.getElementById('norva-trial-banner')) return;

            const here = location.pathname + location.search + location.hash;
            const bar = document.createElement('div');
            bar.id = 'norva-trial-banner';
            bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:14px;max-width:calc(100% - 24px);padding:10px 16px;border-radius:999px;background:#11151d;border:1px solid #283246;color:#f8fafc;font:600 14px/1 Inter,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.45)';

            const span = document.createElement('span');
            span.textContent = daysLeft === 1 ? 'Last day of your Norva trial' : daysLeft + ' days left in your Norva trial';

            const link = document.createElement('a');
            link.href = '/subscribe.html?returnTo=' + encodeURIComponent(here);
            link.textContent = 'Manage plan';
            link.style.cssText = 'color:#b579ff;text-decoration:none;font-weight:700';

            const close = document.createElement('button');
            close.type = 'button';
            close.setAttribute('aria-label', 'Dismiss');
            close.textContent = '✕';
            close.style.cssText = 'background:transparent;border:0;color:#a8b3c7;font-size:16px;cursor:pointer;line-height:1';
            close.addEventListener('click', () => {
                try { sessionStorage.setItem('norva-trial-banner-dismissed', String(daysLeft)); } catch (_) { }
                bar.remove();
            });

            bar.appendChild(span);
            bar.appendChild(link);
            bar.appendChild(close);
            document.body.appendChild(bar);
        } catch (_) { /* never break the app over a banner */ }
    }

    // Payment-issue banner: a failed renewal puts the account in a short grace
    // window (still enforced). Nudge the user to fix billing before access is
    // cut, linking to the subscription manager. Dormant in observe mode.
    maybeShowBillingIssueBanner() {
        try {
            const ent = this.entitlement || window.NorvaEntitlement;
            if (!ent || ent.enforced !== true) return;
            const status = ent.status || (ent.projection && ent.projection.status) || '';
            if (!(status === 'past_due' || status === 'grace' || ent.reason === 'billing_grace')) return;
            if (sessionStorage.getItem('norva-billing-banner-dismissed') === '1') return;
            if (document.getElementById('norva-billing-banner')) return;

            const here = location.pathname + location.search + location.hash;
            const bar = document.createElement('div');
            bar.id = 'norva-billing-banner';
            bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:14px;max-width:calc(100% - 24px);padding:10px 16px;border-radius:999px;background:#2a1d12;border:1px solid #7a5326;color:#fde8b0;font:600 14px/1 Inter,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.45)';

            const span = document.createElement('span');
            span.textContent = 'Payment issue — update your payment method to keep watching';

            const link = document.createElement('a');
            link.href = '/subscription.html?returnTo=' + encodeURIComponent(here);
            link.textContent = 'Fix billing';
            link.style.cssText = 'color:#ffd479;text-decoration:none;font-weight:700';

            const close = document.createElement('button');
            close.type = 'button';
            close.setAttribute('aria-label', 'Dismiss');
            close.textContent = '✕';
            close.style.cssText = 'background:transparent;border:0;color:#d9c08a;font-size:16px;cursor:pointer;line-height:1';
            close.addEventListener('click', () => {
                try { sessionStorage.setItem('norva-billing-banner-dismissed', '1'); } catch (_) { }
                bar.remove();
            });

            bar.appendChild(span);
            bar.appendChild(link);
            bar.appendChild(close);
            document.body.appendChild(bar);
        } catch (_) { /* never break the app over a banner */ }
    }

    addLogoutButton() {
        const navbar = document.querySelector('.navbar-menu');
        if (!navbar || document.getElementById('logout-btn')) return;

        const logoutLink = document.createElement('a');
        logoutLink.href = '#';
        logoutLink.className = 'nav-link';
        logoutLink.id = 'logout-btn';
        logoutLink.innerHTML = `
            <span class="nav-icon"><img class="icon norva-ui-icon" src="/img/icons/norva-logout.svg" alt=""></span>
            <span>Logout</span>
        `;

        logoutLink.addEventListener('click', async (e) => {
            e.preventDefault();

            const token = localStorage.getItem('authToken');
            if (this.currentUser?.cloud && window.NorvaAuth) {
                await window.NorvaAuth.signOut();
                window.location.replace('/account.html');
                return;
            }

            if (token) {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });
            }

            localStorage.removeItem('authToken');
            window.location.replace('/login.html');
        });

        navbar.appendChild(logoutLink);
    }

    initMobileCatalogControls() {
        const setups = [
            this.createMobileCatalogSetup({
                key: 'movies',
                title: 'Movie filters',
                labels: {
                    source: 'Source',
                    category: 'Category',
                    genre: 'Genre',
                    year: 'Year',
                    rating: 'Rating',
                    watched: 'Watch status',
                    added: 'Added',
                    duration: 'Duration',
                    group: 'Group duplicates',
                    hide: 'Hide broken',
                    favorite: 'Favorites only',
                    reset: 'Reset'
                },
                controls: {
                    source: 'movies-source-select',
                    category: 'movies-category-multi',
                    sort: 'movies-sort',
                    genre: 'movies-genre',
                    year: 'movies-year',
                    rating: 'movies-rating',
                    watched: 'movies-watched',
                    added: 'movies-added',
                    duration: 'movies-duration',
                    group: 'movies-group-toggle',
                    hide: 'movies-hide-broken-btn',
                    random: 'movies-random',
                    favorite: 'movies-favorites-btn',
                    reset: 'movies-reset'
                }
            }),
            this.createMobileCatalogSetup({
                key: 'series',
                title: 'Series filters',
                labels: {
                    source: 'Source',
                    category: 'Category',
                    genre: 'Genre',
                    year: 'Year',
                    rating: 'Rating',
                    watched: 'Watch status',
                    added: 'Added',
                    status: 'Status',
                    group: 'Group duplicates',
                    hide: 'Hide broken',
                    favorite: 'Favorites only',
                    reset: 'Reset'
                },
                controls: {
                    source: 'series-source-select',
                    category: 'series-category-multi',
                    sort: 'series-sort',
                    genre: 'series-genre',
                    year: 'series-year',
                    rating: 'series-rating',
                    watched: 'series-watched',
                    added: 'series-added',
                    status: 'series-status',
                    group: 'series-group-toggle',
                    hide: 'series-hide-broken-btn',
                    random: 'series-random',
                    favorite: 'series-favorites-btn',
                    reset: 'series-reset'
                }
            })
        ].filter(Boolean);

        const sync = () => setups.forEach(setup => setup.sync());
        sync();
        window.matchMedia('(max-width: 1024px)').addEventListener?.('change', sync);
        window.addEventListener('resize', sync);
    }

    createMobileCatalogSetup(config) {
        const page = document.getElementById(`page-${config.key}`);
        const controls = page?.querySelector(`.${config.key}-controls`);
        const filterBar = document.getElementById(`${config.key}-filter-bar`);
        const searchWrapper = controls?.querySelector('.search-wrapper');
        if (!page || !controls || !filterBar || !searchWrapper) return null;

        const elements = {};
        Object.entries(config.controls).forEach(([name, id]) => {
            elements[name] = document.getElementById(id);
        });

        const moveNames = Object.keys(elements).filter(name => elements[name]);
        const markers = new Map();
        moveNames.forEach(name => {
            const el = elements[name];
            const marker = document.createComment(`${config.key}-${name}-origin`);
            el.parentNode?.insertBefore(marker, el);
            markers.set(name, marker);
        });

        const filterBtn = document.createElement('button');
        filterBtn.type = 'button';
        filterBtn.id = `${config.key}-mobile-filters-btn`;
        filterBtn.className = 'btn btn-sm mobile-filter-button';
        filterBtn.setAttribute('aria-controls', `${config.key}-filter-bar`);
        filterBtn.setAttribute('aria-expanded', 'false');
        filterBtn.innerHTML = `Filters <span class="mobile-filter-badge" id="${config.key}-mobile-filter-badge"></span>`;

        const backdrop = document.createElement('div');
        backdrop.id = `${config.key}-mobile-filter-backdrop`;
        backdrop.className = 'mobile-filter-backdrop';
        filterBar.before(backdrop);
        filterBar.setAttribute('aria-label', config.title);

        const sheetHeader = document.createElement('div');
        sheetHeader.className = 'mobile-filter-sheet-header';
        sheetHeader.innerHTML = `
            <span class="mobile-filter-sheet-title">${config.title}</span>
            <button type="button" class="btn btn-sm btn-ghost mobile-filter-close" aria-label="Close filters">&times;</button>
        `;

        const sheetBody = document.createElement('div');
        sheetBody.className = 'mobile-filter-body';
        const catalogSection = this.createMobileFilterSection('Catalog');
        const displaySection = this.createMobileFilterSection('Display');
        sheetBody.append(catalogSection.section, displaySection.section);
        filterBar.prepend(sheetHeader, sheetBody);

        const fieldWrappers = new Map();
        const addField = (section, name) => {
            const el = elements[name];
            if (!el) return;
            const field = document.createElement('div');
            field.className = 'mobile-filter-field';
            field.dataset.mobileField = name;
            field.innerHTML = `<span class="mobile-filter-label">${config.labels[name] || name}</span>`;
            field.append(el);
            section.append(field);
            fieldWrappers.set(name, field);
        };

        ['source', 'category', 'genre', 'year', 'rating', 'watched', 'added', 'duration', 'status'].forEach(name => addField(catalogSection.body, name));
        ['group', 'hide', 'favorite', 'reset'].forEach(name => addField(displaySection.body, name));

        const close = () => {
            filterBar.classList.remove('mobile-open');
            backdrop.classList.remove('mobile-open');
            filterBtn.setAttribute('aria-expanded', 'false');
            document.body.classList.remove('catalog-filter-open');
        };
        const open = () => {
            filterBar.classList.add('mobile-open');
            backdrop.classList.add('mobile-open');
            filterBtn.setAttribute('aria-expanded', 'true');
            document.body.classList.add('catalog-filter-open');
        };

        filterBtn.addEventListener('click', open);
        backdrop.addEventListener('click', close);
        sheetHeader.querySelector('.mobile-filter-close')?.addEventListener('click', close);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') close();
        });

        const updateHiddenFields = () => {
            fieldWrappers.forEach((field, name) => {
                const el = elements[name];
                field.classList.toggle('hidden', !el || el.classList.contains('hidden'));
            });
        };

        const updateBadge = () => {
            const categoryBtn = document.getElementById(`${config.key}-category-btn`);
            const count = [
                elements.source?.value,
                categoryBtn?.classList.contains('has-selection') ? 'category' : '',
                elements.genre?.value,
                elements.year?.value,
                elements.rating?.value,
                elements.watched?.value,
                elements.added?.value,
                elements.duration?.value,
                elements.status?.value,
                elements.group && !elements.group.classList.contains('active') ? 'group-off' : '',
                elements.hide && !elements.hide.classList.contains('active') ? 'hide-off' : '',
                elements.favorite?.classList.contains('active') ? 'favorites' : ''
            ].filter(Boolean).length;
            const badge = filterBtn.querySelector('.mobile-filter-badge');
            badge.textContent = String(count);
            badge.classList.toggle('active', count > 0);
            updateHiddenFields();
        };

        const restore = () => {
            moveNames.forEach(name => {
                const marker = markers.get(name);
                const el = elements[name];
                if (marker?.parentNode && el) marker.parentNode.insertBefore(el, marker.nextSibling);
            });
            filterBtn.remove();
            close();
            updateBadge();
        };

        const apply = () => {
            if (!filterBtn.isConnected) controls.append(filterBtn);
            if (elements.sort) controls.append(elements.sort);
            if (elements.random) controls.append(elements.random);
            updateBadge();
        };

        const watched = [...moveNames.map(name => elements[name]), document.getElementById(`${config.key}-category-btn`)]
            .filter(Boolean);
        watched.forEach(el => {
            el.addEventListener('change', () => setTimeout(updateBadge, 0));
            el.addEventListener('click', () => setTimeout(updateBadge, 0));
            new MutationObserver(updateBadge).observe(el, { attributes: true, attributeFilter: ['class'] });
        });

        return {
            sync: () => {
                if (window.matchMedia('(max-width: 1024px)').matches) apply();
                else restore();
            }
        };
    }

    createMobileFilterSection(title) {
        const section = document.createElement('section');
        section.className = 'mobile-filter-section';
        section.innerHTML = `<div class="mobile-filter-section-title">${title}</div>`;
        const body = document.createElement('div');
        body.className = 'mobile-filter-section-body mobile-filter-section';
        section.append(body);
        return { section, body };
    }

    /**
     * Show the "Downloads" entry only inside the phone/tablet APK AND only once
     * the user actually has a download (queued, downloading or saved). It appears
     * with the first download and disappears when the list is emptied, so it never
     * permanently occupies a slot in the already 5-item mobile bottom bar. Applies
     * to both the phone bottom tab bar and the tablet hamburger entry.
     */
    refreshDownloadsNav() {
        const links = [
            document.getElementById('nav-downloads'),
            document.getElementById('nav-downloads-bottom'),
        ].filter(Boolean);
        if (!links.length) return;
        // Phone/tablet APK only, and only with ≥1 download. Gate on the APK's UA
        // marker so it can never leak onto the web or the Android TV app, where
        // the native downloads screen doesn't exist.
        const isApk = /NorvaTV-AndroidPhone/i.test(navigator.userAgent || '');
        const show = isApk && this.downloadsCount() >= 1;
        for (const link of links) {
            link.hidden = !show;
            // .nav-link forces display:flex with no [hidden] override, so toggle
            // display too — otherwise the entry shows where it shouldn't.
            link.style.display = show ? '' : 'none';
            link.setAttribute('aria-hidden', show ? 'false' : 'true');
            link.tabIndex = show ? 0 : -1;
        }
    }

    /**
     * How many real downloads the native app holds — queued, downloading or done
     * (a finished offline title still counts, so the entry stays reachable). Read
     * synchronously from the native getDownloads() bridge; absent bridge → 0.
     */
    downloadsCount() {
        const bridge = window.NorvaTVCloud || window.NodeCastNative;
        if (!bridge || typeof bridge.getDownloads !== 'function') return 0;
        try {
            const list = JSON.parse(bridge.getDownloads() || '[]');
            if (!Array.isArray(list)) return 0;
            return list.filter((d) => d && ['queued', 'downloading', 'done'].includes(d.state)).length;
        } catch (_) {
            return 0;
        }
    }

    // ---- Account sheet (mobile Profile tab) -------------------------------
    // A bottom sheet that consolidates the account actions that were scattered
    // before — profile switch (top-right avatar), Settings (bottom tab) and
    // log out (hidden in the desktop hamburger) — into one reachable place.

    openAccountSheet() {
        const sheet = document.getElementById('account-sheet') || this.buildAccountSheet();
        this.refreshAccountSheet(sheet);
        sheet.classList.add('active');
    }

    closeAccountSheet() {
        document.getElementById('account-sheet')?.classList.remove('active');
    }

    buildAccountSheet() {
        const overlay = document.createElement('div');
        overlay.id = 'account-sheet';
        overlay.className = 'modal-overlay account-sheet';
        overlay.innerHTML = `
            <div class="account-panel" role="dialog" aria-modal="true" aria-label="Account">
                <div class="account-head">
                    <img id="account-avatar" class="account-avatar" src="/img/avatars/placeholder.svg" alt="">
                    <div class="account-id">
                        <div id="account-name" class="account-name">Profile</div>
                        <div id="account-email" class="account-email"></div>
                    </div>
                    <button type="button" class="account-close" aria-label="Close">&times;</button>
                </div>
                <button type="button" class="account-row" data-act="switch">
                    <img class="account-ic" src="/img/avatars/placeholder.svg" alt=""><span>Switch profile</span>
                </button>
                <button type="button" class="account-row" data-act="settings">
                    <img class="account-ic" src="/img/icons/norva-settings.svg" alt=""><span>Settings</span>
                </button>
                <button type="button" class="account-row account-row-danger" data-act="logout">
                    <img class="account-ic" src="/img/icons/norva-logout.svg" alt=""><span>Log out</span>
                </button>
            </div>`;
        // Tapping the dimmed backdrop (not the panel) closes the sheet.
        overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeAccountSheet(); });
        overlay.querySelector('.account-close').addEventListener('click', () => this.closeAccountSheet());
        overlay.querySelectorAll('.account-row').forEach((row) => {
            row.addEventListener('click', () => {
                const act = row.dataset.act;
                this.closeAccountSheet();
                if (act === 'switch') window.NorvaProfiles?.openSwitcher?.();
                else if (act === 'settings') this.navigateTo('settings');
                else if (act === 'logout') this.signOut();
            });
        });
        document.body.appendChild(overlay);
        return overlay;
    }

    refreshAccountSheet(sheet) {
        const cur = (window.NorvaProfiles?.current?.()) || {};
        const avatar = sheet.querySelector('#account-avatar');
        const switchIc = sheet.querySelector('[data-act="switch"] .account-ic');
        const name = sheet.querySelector('#account-name');
        const email = sheet.querySelector('#account-email');
        const switchRow = sheet.querySelector('[data-act="switch"]');
        if (avatar && cur.avatarUrl) avatar.src = cur.avatarUrl;
        if (switchIc && cur.avatarUrl) switchIc.src = cur.avatarUrl;
        if (name) name.textContent = cur.name || 'Profile';
        if (email) email.textContent = this.currentUser?.email || this.currentUser?.username || '';
        // Profile switching only exists in cloud mode.
        if (switchRow) switchRow.style.display = cur.isCloud ? '' : 'none';
    }

    // Canonical sign-out (cloud → Supabase + /account.html, else local token).
    async signOut() {
        const token = localStorage.getItem('authToken');
        if (this.currentUser?.cloud && window.NorvaAuth) {
            try { await window.NorvaAuth.signOut(); } catch (_) { /* best effort */ }
            window.location.replace('/account.html');
            return;
        }
        if (token) {
            try {
                await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
            } catch (_) { /* best effort */ }
        }
        localStorage.removeItem('authToken');
        window.location.replace('/login.html');
    }

    // ---- Global catalogue search (movies + series) -----------------------
    // First-class search reachable from anywhere via the top-bar icon. Queries
    // the movie and series catalogue in parallel (same /media-items endpoint the
    // pages use), so it spans the whole library instead of one content type.

    openSearch() {
        const ov = document.getElementById('gsearch-overlay') || this.buildSearchOverlay();
        ov.classList.add('active');
        const input = ov.querySelector('#gsearch-input');
        setTimeout(() => { try { input.focus(); input.select(); } catch (_) { /* noop */ } }, 50);
    }

    closeSearch() {
        document.getElementById('gsearch-overlay')?.classList.remove('active');
    }

    buildSearchOverlay() {
        const ov = document.createElement('div');
        ov.id = 'gsearch-overlay';
        ov.className = 'modal-overlay gsearch-overlay';
        ov.innerHTML = `
            <div class="gsearch-panel" role="dialog" aria-modal="true" aria-label="Search">
                <div class="gsearch-bar">
                    <span class="gsearch-ic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></span>
                    <input id="gsearch-input" type="search" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Search movies & series…">
                    <button type="button" class="gsearch-cancel">Cancel</button>
                </div>
                <div class="gsearch-results" id="gsearch-results">
                    <div class="gsearch-hint">Type at least 2 characters to search the catalogue.</div>
                </div>
            </div>`;
        ov.addEventListener('click', (e) => { if (e.target === ov) this.closeSearch(); });
        ov.querySelector('.gsearch-cancel').addEventListener('click', () => this.closeSearch());
        const input = ov.querySelector('#gsearch-input');
        input.addEventListener('input', () => {
            clearTimeout(this._searchDebounce);
            this._searchDebounce = setTimeout(() => this.runSearch(input.value.trim()), 250);
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeSearch(); });
        document.body.appendChild(ov);
        return ov;
    }

    async runSearch(q) {
        const box = document.getElementById('gsearch-results');
        if (!box) return;
        if (q.length < 2) {
            box.innerHTML = '<div class="gsearch-hint">Type at least 2 characters to search the catalogue.</div>';
            return;
        }
        const reqId = (this._searchReq = (this._searchReq || 0) + 1);
        box.innerHTML = '<div class="gsearch-hint"><div class="loading-spinner"></div></div>';
        const empty = { items: [] };
        const [mv, sr] = await Promise.all([
            window.API.media.page({ type: 'movie', q, limit: 24 }).catch(() => empty),
            window.API.media.page({ type: 'series', q, limit: 24 }).catch(() => empty),
        ]);
        if (reqId !== this._searchReq) return; // a newer keystroke superseded this
        this._gsMovies = mv.items || [];
        this._gsSeries = sr.items || [];
        this.renderSearchResults(box, q, this._gsMovies, this._gsSeries);
    }

    renderSearchResults(box, q, movies, series) {
        const M = window.MediaUtils;
        const row = (item, type, idx) => {
            const title = item.tmdb?.title || item.tmdb?.name || item.name || 'Untitled';
            const poster = M.safeImageUrl(
                item.stream_icon || item.cover || M.tmdbPosterUrl(item.tmdb),
                '/img/norva-media-placeholder.png');
            const year = String(item.tmdb?.release_date || item.tmdb?.first_air_date || '').slice(0, 4);
            return `
                <button type="button" class="gsearch-result" data-type="${type}" data-idx="${idx}">
                    <img class="gsearch-poster" src="${M.escapeHtml(poster)}" alt="" loading="lazy"
                         onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'">
                    <span class="gsearch-text">
                        <span class="gsearch-title">${M.escapeHtml(title)}</span>
                        <span class="gsearch-sub">${type === 'series' ? 'Series' : 'Movie'}${year ? ' · ' + year : ''}</span>
                    </span>
                </button>`;
        };
        let html = '';
        if (movies.length) html += '<div class="gsearch-section">Movies</div>' + movies.map((m, i) => row(m, 'movie', i)).join('');
        if (series.length) html += '<div class="gsearch-section">Series</div>' + series.map((s, i) => row(s, 'series', i)).join('');
        if (!html) {
            box.innerHTML = `<div class="gsearch-hint">No results for “${M.escapeHtml(q)}”.</div>`;
            return;
        }
        box.innerHTML = html;
        box.querySelectorAll('.gsearch-result').forEach((el) => {
            el.addEventListener('click', () => this.openSearchResult(el.dataset.type, parseInt(el.dataset.idx, 10)));
        });
    }

    // Open the tapped result's detail directly via the page's openByItem(). If
    // that can't resolve a detail (page not ready, fetch failed), fall back to
    // landing on the page pre-searched to the title — the page's cloudRequestId
    // guard makes that prefill race-safe.
    openSearchResult(type, idx) {
        const item = (type === 'series' ? this._gsSeries : this._gsMovies)?.[idx];
        this.closeSearch();
        const page = type === 'series' ? 'series' : 'movies';
        this.navigateTo(page);
        const pageObj = type === 'series' ? this.pages?.series : this.pages?.movies;
        const title = item ? (item.tmdb?.title || item.tmdb?.name || item.name || '') : '';
        setTimeout(async () => {
            let opened = false;
            try { if (item && pageObj?.openByItem) opened = await pageObj.openByItem(item); } catch (_) { opened = false; }
            if (!opened) {
                const input = document.getElementById(page === 'series' ? 'series-search' : 'movies-search');
                if (input && title) {
                    input.value = title;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }, 140);
    }

    navigateTo(pageName, replaceHistory = false) {
        const requestedPage = pageName;
        pageName = this.guardCatalogPage(pageName);
        if (pageName !== requestedPage) {
            replaceHistory = true;
        }

        // Don't navigate if already on this page
        if (this.currentPage === pageName && !replaceHistory) {
            return;
        }

        // Update browser history
        if (replaceHistory) {
            // Replace current history entry (used on initial load)
            history.replaceState({ page: pageName }, '', `#${pageName}`);
        } else {
            // Add new history entry
            history.pushState({ page: pageName }, '', `#${pageName}`);
        }

        // Update nav
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.toggle('active', link.dataset.page === pageName);
        });

        // Update pages
        document.querySelectorAll('.page').forEach(page => {
            page.classList.toggle('active', page.id === `page-${pageName}`);
        });

        // Notify page controllers
        if (this.pages[this.currentPage]?.hide) {
            this.pages[this.currentPage].hide();
        }

        this.currentPage = pageName;
        // Hide the mobile bottom tab bar while watching (full-screen video).
        document.body.classList.toggle('is-watching', pageName === 'watch');

        if (this.pages[pageName]?.show) {
            this.pages[pageName].show();
        }
    }

    /**
     * Apply a profile switch WITHOUT a full page reload (Step B). setActiveProfileId
     * has already dropped the previous profile's favorites/history caches; land on
     * Home (Netflix-style) and force it to refetch with the new profile, then
     * refresh the navbar avatar. Active playback is never interrupted. Falls back
     * to a hard reload on any error so a switch never silently leaves stale data.
     */
    async applyProfileSwitch(profileName) {
        try {
            if (this.pages.home) this.pages.home.lastLoadedAt = 0; // force a refetch
            if (this.currentPage === 'watch') {
                // Don't interrupt playback — Home refetches when next opened.
            } else if (this.currentPage === 'home') {
                await this.pages.home.show();
            } else {
                this.navigateTo('home');
            }
            if (window.NorvaProfiles?.refreshNavAvatar) await window.NorvaProfiles.refreshNavAvatar();
            try { this.sourceManager?.toast?.(profileName ? `Profil : ${profileName}` : 'Profil changé'); } catch (_) { /* noop */ }
        } catch (e) {
            console.warn('[profiles] soft profile switch failed, reloading', e);
            window.location.reload();
        }
    }
}

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
