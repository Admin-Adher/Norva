/**
 * Norva Application Entry Point
 */

/**
 * Companion apps advertised by the navbar "Devices" popover ("Use Norva
 * elsewhere"). The store listings aren't live yet, so every row renders a
 * Coming-soon badge; fill in a storeUrl (e.g. the Play Store listing) and that
 * row flips to a real Install link — nothing else to change.
 */
const NORVA_DEVICE_APPS = [
    { key: 'mobile', name: 'Mobile app', hint: 'For your phone or tablet', storeUrl: '' },
    { key: 'tv', name: 'TV app', hint: 'For the big screen, remote-friendly', storeUrl: '' },
];

class App {
    constructor() {
        // The phone APK plays everything in the native fullscreen player, so the
        // Live page's inline preview is dead space and its "Fullscreen" button just
        // duplicates "Watch". Flag it so CSS + LiveGuideFusion can drop both.
        if (document.body && /NorvaTV-AndroidPhone/i.test(navigator.userAgent || '')) {
            document.body.classList.add('norva-phone-apk');
        }
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
        // AdminPage (76 KB) is admin-only: loaded on demand (ensureAdminPage) so
        // every non-admin phone stops downloading/parsing it at boot.
        this.pages.admin = null;
        this.entitlement = null;
        this.sourceHealthSummary = null;
        this.catalogPages = new Set(['live', 'movies', 'series']);

        this.init();
    }

    finishTvLaunchScreen() {
        const root = document.documentElement;
        if (!root.classList.contains('tv-launching')) return;
        root.classList.add('tv-launch-ready');
        window.setTimeout(() => {
            root.classList.remove('tv-launching', 'tv-launch-ready');
            document.getElementById('tv-launch-screen')?.setAttribute('hidden', '');
        }, 420);
    }

    async init() {
        // Failsafe: the launch splash must never outlive the boot. If any cloud call
        // hangs or an interactive step stalls, force the splash down after 12s so an
        // Android TV can't sit on "Preparing your cinema" forever. finishTvLaunchScreen
        // is idempotent, so the normal (faster) path is unaffected.
        window.setTimeout(() => { try { this.finishTvLaunchScreen(); } catch (_) { /* noop */ } }, 12000);
        // On the hosted web app, Norva Account is the product entry point.
        const host = window.location.hostname;
        const isRemote = host !== 'localhost' && host !== '127.0.0.1' && host !== '';
        if (isRemote && !this.hasCloudSession()) {
            const returnTo = window.location.pathname + window.location.search + window.location.hash;
            window.location.replace('/account.html?returnTo=' + encodeURIComponent(returnTo || '/'));
            return;
        }

        // Check authentication first
        window.NorvaTrace?.log?.('checkAuth() — validates the session with GoTrue (network /auth/v1/user, blocking)');
        await this.checkAuth();
        window.NorvaTrace?.log?.('checkAuth() done', this.currentUser ? (this.currentUser.email || (this.currentUser.device ? 'paired device' : 'user')) : 'no user → redirect');
        // Collapse the launch fan-out: one /boot call seeds profile / profiles /
        // entitlements / sources / trial-eligibility so the calls right below
        // (checkCloudAccess, ensureSelected, refreshSourceHealth, the trial
        // banner …) resolve from cache instead of each paying a separate
        // norva-cloud cold start — the dominant cause of slow first paint. Fire
        // it synchronously here: boot() claims the in-flight cache slots before
        // it returns, so the very next line already dedups onto it. User
        // sessions only — paired-device screens use the device-token path.
        if (this.currentUser && !this.currentUser.device) {
            window.NorvaTrace?.log?.('boot() fired — one /boot call seeds the caches the lines below read');
            try { window.NorvaCloud?.boot?.(); } catch (_) { /* best-effort speedup */ }
        }
        window.NorvaTrace?.log?.('checkCloudAccess() — entitlements (served from boot cache if seeded)');
        if (!await this.checkCloudAccess()) return;
        window.NorvaTrace?.log?.('checkCloudAccess() done');
        // Drop the TV launch splash BEFORE the profile step. The "who's watching?" /
        // profile-setup overlay would otherwise render UNDER the launch splash (which
        // has a near-max z-index), so on Android TV the viewer can't see or pick a
        // profile, ensureSelected()'s promise never resolves, and the splash sticks
        // forever on "Preparing your cinema" (browsers have no TV splash, so they were
        // unaffected). The picker is a real interactive screen, not the auth flicker the
        // splash hides. finishTvLaunchScreen() schedules its own fade and returns at once.
        this.finishTvLaunchScreen();
        // Netflix-style "who's watching": pick a profile before entering the app.
        try { if (window.NorvaProfiles?.ensureSelected) await window.NorvaProfiles.ensureSelected(); } catch (_) { }
        // Surface the always-visible navbar profile avatar (one-tap switcher).
        try { if (window.NorvaProfiles?.refreshNavAvatar) await window.NorvaProfiles.refreshNavAvatar(); } catch (_) { }
        window.NorvaTrace?.log?.('app shell ready — profile picked, router/page renders next. NorvaTrace.summary() for the full table.');
        this.applyCatalogAvailability(null);
        this.startCloudWarmKeep();
        this.startSessionKeepFresh();
        this.startEnrichmentProgressPoll();
        if (this.currentUser && !this.currentUser.device) this.registerPushToken(); // native FCM token (Android wrapper only; no-op in browser)

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
                if (link.dataset.action === 'search') {
                    e.preventDefault();
                    this.openSearch();
                    return;
                }
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

        // "Use Norva elsewhere" devices popover (web only, never in the shells).
        this.setupDevicesButton();

        // Surface the Downloads menu entry once the native app has ≥1 download.
        this.refreshDownloadsNav();
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this.refreshDownloadsNav();
        });

        // In-session freshness: when the app returns to the foreground after being hidden
        // (tab switch, phone unlock, resumed from background), let the VISIBLE page revalidate
        // its catalog so background title corrections/merges and newly-synced content surface
        // without a manual reload — answering "does a title change show mid-session, or only at
        // startup?" with: on the next foreground too, not just cold launch. Each page throttles
        // itself (no-ops while its data is still within its warm window), and only the active
        // page is touched, so this is a foreground-triggered SWR refresh, not a background poll.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            try { this.pages?.[this.currentPage]?.maybeRevalidate?.('foreground'); } catch (_) { /* best-effort */ }
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

        // When a catalog first becomes ready (e.g. the first import finishes while
        // the app is open), surface the deferred onboarding nudges — but only then,
        // so they never appear on the empty "connect your service" screen.
        window.addEventListener('norva:catalog-availability-changed', (e) => {
            if (!e.detail?.ready) return;
            this.maybeShowRegionPrompt();
            this.maybeShowTrialBanner();
        });

        // Picking a content region (onboarding prompt or Settings) reorganizes the
        // LIVE catalog — categories/channels are fetched per region and the device
        // live cache is region-agnostic. Drop the stale cache and re-render Live in
        // place if it's the visible page; other pages pick up the cleared cache on
        // their next visit. Movies/Series/Home rails don't depend on region.
        document.addEventListener('norva:content-region-changed', async () => {
            try { await this.channelList?.clearLiveCatalogCache?.(); } catch (_) { /* noop */ }
            if (this.currentPage === 'live' && this.pages.live?.show) {
                try { this.pages.live.show(); } catch (_) { /* noop */ }
            }
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

        // Handle browser back/forward buttons. The browser has already moved the
        // history pointer, so reflect the popped entry WITHOUT pushing a new one
        // (applyPage, not navigateTo) — otherwise Back stacks duplicate entries.
        window.addEventListener('popstate', (e) => {
            const page = e.state?.page || 'home';
            this._histIdx = (typeof e.state?.idx === 'number') ? e.state.idx : 0;
            if (this.currentPage === page) return; // already showing it; idx synced
            this.applyPage(page);
        });

        // Offline banner: the SPA can't fetch fresh data with no network, so tell
        // the user instead of leaving stale/empty rails looking broken.
        window.addEventListener('offline', () => this.updateOfflineBanner(false));
        window.addEventListener('online', () => this.updateOfflineBanner(true));
        if (!navigator.onLine) this.updateOfflineBanner(false);

        // Initialize home page first (it's needed for channel list)
        await this.pages.home.init();

        // Source health gates the catalogue-page guard + nav availability, but the Home
        // page is always allowed and its rails fetch does not depend on it. Start health
        // in PARALLEL so Home's data fetch overlaps it (saves a full round-trip on the
        // common cold start to Home); only block on it when guarding a deep-link to a
        // catalogue page, where the guard must see real availability.
        const healthReady = this.refreshSourceHealth().catch(() => null);

        // Preload EPG data in background (non-blocking)
        // This ensures EPG info is available on Live TV page without visiting Guide first
        this.epgGuide.loadEpg().catch(err => {
            console.warn('Background EPG load failed:', err.message);
        });

        // Navigate to the page from URL hash, or default to home. Sub-routes use
        // "#page/sub" (e.g. #admin/client:<id>): the page key is the first segment.
        const hash = window.location.hash.slice(1); // Remove #
        const hashKey = hash.split('/')[0];
        // Stash the admin sub-route BEFORE navigateTo rewrites the hash to "#admin" —
        // AdminPage.show() consumes it to restore the exact CRM view (fiche, ticket…).
        this._adminSubRoute = hashKey === 'admin' ? hash.slice('admin/'.length) : '';
        // Fiche deep link (subtitle-ready emails, bell entries): #movies/open:… or #series/open:…
        // — stashed the same way, consumed by openFicheFromRoute after the page has landed.
        this._openFicheRoute = ((hashKey === 'movies' || hashKey === 'series') && hash.slice(hashKey.length + 1).startsWith('open:'))
            ? hash.slice(hashKey.length + 1) : '';
        // `in` (not truthiness): lazy pages register as null until loaded (this.pages.admin),
        // which used to send a refresh on #admin back to home.
        const requestedInitialPage = hashKey && (hashKey in this.pages) ? hashKey : 'home';
        if (requestedInitialPage !== 'home') await healthReady;
        const initialPage = this.guardCatalogPage(requestedInitialPage);
        // Capture any fiche open before a refresh BEFORE navigating (applyPage may clear
        // the stash), then re-open it once we've landed on its catalogue page.
        const pendingFiche = this.readOpenFiche();
        this.navigateTo(initialPage, true); // true = replace history (don't add)
        this.restoreOpenFiche(initialPage, pendingFiche);
        this.openFicheFromRoute(initialPage);

        // Defer the trial / billing nudges AND the region prompt until source
        // health is known. None of them belong on the pre-catalog onboarding
        // screen ("Connect your TV service"), where they collide with each other
        // in the bottom-of-screen zone and bury the single action that matters.
        // Once health resolves we show them only when a source is connected.
        healthReady.then(() => {
            this.maybeShowTrialBanner();
            this.maybeShowBillingIssueBanner();
            this.maybeShowRegionPrompt();
        });
        // New content and support replies can land mid-session — refresh the bell inbox
        // (catalog events + support replies) every 5 min so the unread badge stays live.
        setInterval(() => this.refreshNotifications().catch(() => {}), 5 * 60 * 1000);

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
     * Notifications inbox: a bell in the navbar with an unread dot and a dropdown
     * feed of recent "what's new" events (new movies/shows/channels + catalog
     * ready). Replaces the old one-shot toast — the feed persists and opening it
     * (not app launch) is what marks entries read. Best-effort, silent on error.
     */
    async surfaceWhatsNew() {
        try {
            await this.refreshNotifications();
        } catch (_) { /* never break launch over a notification */ }
    }

    async refreshNotifications() {
        const bell = document.getElementById('nav-bell');
        if (!bell || !window.NorvaCloud?.contentEvents?.inbox) return;
        // One inbox, two feeds: catalog "what's new" events + support replies (merged,
        // newest first). Support entries deep-link into their ticket from the dropdown.
        const [res, support] = await Promise.all([
            window.NorvaCloud.contentEvents.inbox(),
            this._fetchSupportReplies().catch(() => []),
        ]);
        const catalog = ((res && res.events) || []).map(e => ({ ...e, kind: 'catalog' }));
        this._notifEvents = [...support, ...catalog]
            .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
        this._notifUnread = (Number(res && res.unread) || 0) + support.filter(e => !e.seen_at).length;
        bell.hidden = false;
        bell.setAttribute('aria-expanded', 'false');
        const dot = document.getElementById('nav-bell-dot');
        if (dot) {
            // Count pill (not a bare dot): "anything new in here" is visible at a glance.
            dot.textContent = this._notifUnread > 9 ? '9+' : (this._notifUnread > 0 ? String(this._notifUnread) : '');
            dot.hidden = this._notifUnread === 0;
        }
        if (!this._notifBound) {
            this._notifBound = true;
            bell.addEventListener('click', (e) => { e.stopPropagation(); this.toggleNotifications(); });
        }
    }

    // Support replies as inbox entries. Read/unread comes from the 'norva-support-seen'
    // watermark (newest server last_message_at the user has seen — written by support.html
    // on load/poll and by opening this inbox). Server timestamps only, string-compared —
    // client clock skew can't hide or replay an entry. Signed-out → empty (no noise).
    async _fetchSupportReplies() {
        try {
            if (!(window.NorvaAuth && NorvaAuth.getSession && NorvaAuth.getSession())) return [];
            const token = await NorvaAuth.getAccessToken();
            if (!token) return [];
            const base = ((NorvaAuth.supabaseUrl || '')).replace(/\/+$/, '');
            const res = await fetch(base + '/functions/v1/norva-support/mine?tickets=only', {
                headers: { apikey: NorvaAuth.publishableKey || '', Authorization: 'Bearer ' + token }
            });
            if (!res.ok) return [];
            const data = await res.json().catch(() => ({}));
            const seen = localStorage.getItem('norva-support-seen') || '';
            return (Array.isArray(data.tickets) ? data.tickets : [])
                .filter(t => t.last_from === 'admin')
                .slice(0, 10)
                .map(t => ({
                    kind: 'support',
                    id: 'support:' + t.id,
                    ticket_id: t.id,
                    summary: `Support replied to “${String(t.subject || '').slice(0, 60)}”`,
                    created_at: t.last_message_at,
                    seen_at: String(t.last_message_at || '') > seen ? null : (t.last_message_at || ''),
                }));
        } catch (_) { return []; }
    }

    toggleNotifications() {
        const open = document.getElementById('norva-notif-panel');
        if (open) { open.remove(); document.getElementById('nav-bell')?.setAttribute('aria-expanded', 'false'); return; }
        const bell = document.getElementById('nav-bell');
        const panel = document.createElement('div');
        panel.id = 'norva-notif-panel';
        panel.className = 'norva-notif-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Notifications');
        const events = this._notifEvents || [];
        const timeAgo = (iso) => {
            const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
            if (s < 3600) return `${Math.floor(s / 60)}m ago`;
            if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
            return `${Math.floor(s / 86400)}d ago`;
        };
        const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        // Support entries are links straight into their ticket (support.html auto-expands
        // & scrolls ?ticket=); catalog entries stay informational.
        const here = location.pathname + location.search + location.hash;
        // Subtitle-ready events carry payload.watch ("movies/open:…") — render them as deep
        // links into the fiche (handled in-app below; the href keeps middle-click working).
        const watchRoute = (e) => {
            const w = e.kind !== 'support' && e.payload && typeof e.payload.watch === 'string' ? e.payload.watch : '';
            return /^(movies|series)\/open:/.test(w) ? w : '';
        };
        const item = (e) => e.kind === 'support'
            ? `<a class="norva-notif-item${e.seen_at ? '' : ' unread'}" href="/support.html?ticket=${encodeURIComponent(e.ticket_id)}&returnTo=${encodeURIComponent(here)}">
                    <div class="norva-notif-summary">💬 ${esc(e.summary || 'Support replied')}</div>
                    <div class="norva-notif-time">${esc(timeAgo(e.created_at))} · tap to open the ticket</div>
                </a>`
            : watchRoute(e)
                ? `<a class="norva-notif-item${e.seen_at ? '' : ' unread'}" href="/app.html#${esc(watchRoute(e))}" data-watch="${esc(watchRoute(e))}">
                    <div class="norva-notif-summary">✨ ${esc(e.summary || 'New content')}</div>
                    <div class="norva-notif-time">${esc(timeAgo(e.created_at))} · tap to open</div>
                </a>`
                : `<div class="norva-notif-item${e.seen_at ? '' : ' unread'}">
                    <div class="norva-notif-summary">✨ ${esc(e.summary || 'New content')}</div>
                    <div class="norva-notif-time">${esc(timeAgo(e.created_at))}</div>
                </div>`;
        panel.innerHTML = `
            <div class="norva-notif-head">Notifications</div>
            <div class="norva-notif-list">
                ${events.length ? events.map(item).join('') : '<div class="norva-notif-empty">No notifications yet.</div>'}
            </div>`;
        document.body.appendChild(panel);
        // Watch deep links navigate IN-APP (a hash-only href would not reload the SPA): route to
        // the catalogue page and reuse the same openFicheFromRoute the boot deep link goes through.
        panel.querySelectorAll('[data-watch]').forEach((a) => a.addEventListener('click', (ev) => {
            ev.preventDefault();
            const w = a.getAttribute('data-watch') || '';
            const page = w.split('/')[0];
            if (!this.pages?.[page]) return;
            this._openFicheRoute = w.slice(page.length + 1);
            panel.remove();
            bell?.setAttribute('aria-expanded', 'false');
            this.navigateTo(page);
            this.openFicheFromRoute(page);
        }));
        // Position under the bell.
        try {
            const r = bell.getBoundingClientRect();
            panel.style.top = `${Math.round(r.bottom + 8)}px`;
            panel.style.right = `${Math.round(window.innerWidth - r.right)}px`;
        } catch (_) { /* default CSS position */ }
        bell?.setAttribute('aria-expanded', 'true');
        // Opening the inbox marks the unseen entries read — each feed via its own mechanism:
        // catalog ids → contentEvents.markSeen (NEVER send it the synthetic support ids),
        // support → advance the shared 'norva-support-seen' watermark (server timestamps).
        const unseenIds = events.filter(e => !e.seen_at && e.kind !== 'support').map(e => e.id).filter(Boolean);
        if (unseenIds.length) window.NorvaCloud.contentEvents.markSeen(unseenIds);
        const unseenSupport = events.filter(e => e.kind === 'support' && !e.seen_at);
        if (unseenSupport.length) {
            const newest = unseenSupport.reduce((m, e) => (String(e.created_at || '') > m ? String(e.created_at) : m), '');
            try { if (newest) localStorage.setItem('norva-support-seen', newest); } catch (_) { /* private mode */ }
        }
        if (unseenIds.length || unseenSupport.length) {
            this._notifUnread = 0;
            const dot = document.getElementById('nav-bell-dot');
            if (dot) { dot.textContent = ''; dot.setAttribute('hidden', ''); }
            events.forEach(e => { e.seen_at = e.seen_at || new Date().toISOString(); });
        }
        // Dismiss on outside click / Escape.
        const close = (ev) => {
            if (ev.type === 'keydown' && ev.key !== 'Escape') return;
            if (ev.type === 'click' && (panel.contains(ev.target) || bell?.contains(ev.target))) return;
            panel.remove();
            bell?.setAttribute('aria-expanded', 'false');
            document.removeEventListener('click', close, true);
            document.removeEventListener('keydown', close, true);
        };
        setTimeout(() => {
            document.addEventListener('click', close, true);
            document.addEventListener('keydown', close, true);
        }, 0);
    }

    /**
     * "Devices" navbar button → "Use Norva elsewhere" popover (same anatomy as
     * the notifications bell above). Web-only discovery surface: the Android
     * phone/TV shells and tv-mode ARE those devices, so they never see it.
     */
    setupDevicesButton() {
        const btn = document.getElementById('nav-devices');
        if (!btn) return;
        // Mirrors the native-shell detection used by app.html / Settings.js.
        const ua = navigator.userAgent || '';
        const nativeShell = /NorvaTV-/i.test(ua) || !!window.NorvaTVCloud || !!window.NodeCastNative
            || /[?&]mobile=1\b/.test(window.location.search || '')
            || document.documentElement.classList.contains('tv-mode');
        if (nativeShell) return;
        btn.hidden = false;
        // "New" dot: only once at least one app is actually installable, and
        // only until the first open — a Coming-soon teaser doesn't earn a nudge.
        const hasLinks = NORVA_DEVICE_APPS.some(a => a.storeUrl);
        let seen = false;
        try { seen = localStorage.getItem('norva-devices-seen') === '1'; } catch (_) { /* noop */ }
        const dot = document.getElementById('nav-devices-dot');
        if (dot) dot.hidden = !hasLinks || seen;
        btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleDevicesPopover(); });
    }

    toggleDevicesPopover() {
        const open = document.getElementById('norva-devices-panel');
        const btn = document.getElementById('nav-devices');
        if (open) { open.remove(); btn?.setAttribute('aria-expanded', 'false'); return; }
        const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        // Same icon family as the landing availability grid.
        const icons = {
            mobile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
            tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="13" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>',
        };
        const panel = document.createElement('div');
        panel.id = 'norva-devices-panel';
        panel.className = 'norva-notif-panel norva-devices-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Use Norva elsewhere');
        panel.innerHTML = `
            <div class="norva-notif-head">Use Norva elsewhere</div>
            <div class="norva-devices-list">
                ${NORVA_DEVICE_APPS.map(a => `
                    <div class="norva-device-row">
                        <span class="norva-device-ic">${icons[a.key] || icons.mobile}</span>
                        <span class="norva-device-text">
                            <span class="norva-device-name">${esc(a.name)}</span>
                            <span class="norva-device-hint">${esc(a.hint)}</span>
                        </span>
                        ${a.storeUrl
                            ? `<a class="norva-device-get" href="${esc(a.storeUrl)}" target="_blank" rel="noopener noreferrer">Install</a>`
                            : '<span class="norva-device-soon">Coming soon</span>'}
                    </div>`).join('')}
            </div>`;
        document.body.appendChild(panel);
        // Position under the button (mirrors the notifications panel).
        try {
            const r = btn.getBoundingClientRect();
            panel.style.top = `${Math.round(r.bottom + 8)}px`;
            panel.style.right = `${Math.round(window.innerWidth - r.right)}px`;
        } catch (_) { /* default CSS position */ }
        btn?.setAttribute('aria-expanded', 'true');
        // First open clears the "new" dot for good.
        try { localStorage.setItem('norva-devices-seen', '1'); } catch (_) { /* noop */ }
        document.getElementById('nav-devices-dot')?.setAttribute('hidden', '');
        const doClose = () => {
            panel.remove();
            btn?.setAttribute('aria-expanded', 'false');
            document.removeEventListener('click', close, true);
            document.removeEventListener('keydown', close, true);
        };
        // Dismiss on outside click / Escape; an Install click closes too (bubble
        // phase, so the new tab is already on its way).
        const close = (ev) => {
            if (ev.type === 'keydown' && ev.key !== 'Escape') return;
            if (ev.type === 'click' && (panel.contains(ev.target) || btn?.contains(ev.target))) return;
            doClose();
        };
        panel.addEventListener('click', (ev) => { if (ev.target.closest('a.norva-device-get')) doClose(); });
        setTimeout(() => {
            document.addEventListener('click', close, true);
            document.addEventListener('keydown', close, true);
        }, 0);
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
            this.startImportWatcher(); // self-stops when nothing is importing

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

    // In-app completion banner: poll the sources list and toast when a catalog import finishes
    // (syncing -> ready) while the app is open. Self-stopping — it only runs while something is
    // importing, and the add-provider flow re-kicks it. Pairs with the email/push notifications for
    // when the app is closed. The first tick records a baseline (no toast on initial load).
    startImportWatcher() {
        if (this._importWatchTimer) return;
        if (!this._importStates) this._importStates = new Map();
        const SYNCING = new Set(['syncing', 'checking', 'pending', 'connecting', 'discovering', 'discovered', 'importing', 'materializing', 'building_titles', 'building_live_channels', 'building_live_variants', 'finalizing']);
        const tick = async () => {
            let anySyncing = false;
            try {
                const sources = await (window.API?.sources?.getAll?.() ?? []);
                for (const s of (Array.isArray(sources) ? sources : [])) {
                    const id = String(s.id ?? s.sourceId ?? '');
                    if (!id) continue;
                    const status = String(s.sync_status || s.syncStatus || '').toLowerCase();
                    const was = this._importStates.get(id);
                    this._importStates.set(id, status);
                    if (SYNCING.has(status)) anySyncing = true;
                    // Toast only on a real syncing -> ready transition (skip the baseline pass).
                    if (was && was !== status && status === 'ready' && SYNCING.has(was)) {
                        try { this.sourceManager?.toast?.(`🎉 ${s.name || s.display_name || 'Your catalog'} is ready to watch!`); } catch (_) { /* noop */ }
                        // The Home page listens to this to bust its cache — without it, a user
                        // staring at "Preparing your Home" kept the placeholder (or day-old
                        // rails) until a manual reload even after the import finished.
                        try { document.dispatchEvent(new CustomEvent('norva:source-health-changed')); } catch (_) { /* noop */ }
                    }
                }
            } catch (_) { /* best-effort */ }
            if (!anySyncing) this.stopImportWatcher();
        };
        this._importWatchTimer = setInterval(tick, 30 * 1000);
        tick(); // prime baseline immediately
    }

    stopImportWatcher() {
        if (this._importWatchTimer) { clearInterval(this._importWatchTimer); this._importWatchTimer = null; }
    }

    // Phase 2 native push: read the FCM token the Android wrapper exposes via its JS bridge
    // (window.NorvaTVCloud.getPushToken) and register it with the backend so the digest sender can push
    // to this device when the app is closed. No-op in a plain browser (no bridge). Best-effort.
    async registerPushToken() {
        try {
            const bridge = window.NorvaTVCloud;
            if (!bridge || typeof bridge.getPushToken !== 'function') return;
            let token = '';
            for (let i = 0; i < 6 && !token; i++) {                 // FCM token may not be ready at first launch
                try { token = String(bridge.getPushToken() || ''); } catch (_) { token = ''; }
                if (!token) await new Promise((r) => setTimeout(r, 1500));
            }
            if (!token || this._lastPushToken === token) return;
            await window.API?.request?.('POST', '/push-token', { token, platform: 'android' });
            this._lastPushToken = token;
        } catch (_) { /* best-effort */ }
    }

    isCatalogPage(pageName) {
        return this.catalogPages.has(pageName);
    }

    isCatalogReady(summary = this.sourceHealthSummary) {
        if (!summary) return false;
        return summary.state === 'ready' || Boolean(summary.ready?.length);
    }

    guardCatalogPage(pageName) {
        if (!this.isCatalogPage(pageName)) return pageName;
        // Allow a catalog page during sync once its own category has content.
        return (this.isCatalogReady() || this.catalogCategoryAvailable(pageName)) ? pageName : 'home';
    }

    // True once a syncing (or ready) source has at least one item of this category.
    // The page name ('live' | 'movies' | 'series') maps directly to the progress
    // counts keys, which fill progressively during discovery (movies/live first,
    // series once reached) — so each tab can be revealed as soon as it has content.
    catalogCategoryAvailable(category, summary = this.sourceHealthSummary) {
        if (this.isCatalogReady(summary)) return true;
        const sources = [...(summary?.issues || []), ...(summary?.sources || [])];
        return sources.some(item => {
            const src = (item && item.source) || item || {};
            const cfg = src.configHint || src.config_hint || {};
            const prog = src.syncProgress || src.sync_progress || cfg.syncProgress || cfg.sync_progress || {};
            const counts = (prog && prog.counts) || {};
            return Number(counts[category]) > 0;
        });
    }

    applyCatalogAvailability(summary = this.sourceHealthSummary) {
        // A transient/unknown summary (a temporary /sources hiccup that loadSummary maps to
        // state='unknown') must NEVER hide already-visible catalog tabs — otherwise a network blip
        // makes Live/Movies/Series vanish under an onboarded user. Keep the last-known-good tab
        // visibility until a real summary (ready / syncing / not_configured) arrives.
        if (summary && (summary.state === 'unknown' || summary.error)) return;
        const ready = this.isCatalogReady(summary);
        let anyShown = false;
        document.querySelectorAll('.nav-link[data-page="live"], .nav-link[data-page="movies"], .nav-link[data-page="series"]').forEach(link => {
            // Reveal each catalog tab individually as soon as its category has at least
            // one item — Movies/Live TV/Series appear progressively during onboarding
            // instead of all-or-nothing once the whole catalogue is ready.
            const show = ready || this.catalogCategoryAvailable(link.getAttribute('data-page'), summary);
            if (show) anyShown = true;
            link.classList.toggle('catalog-nav-hidden', !show);
            link.hidden = !show;
            link.setAttribute('aria-hidden', show ? 'false' : 'true');
            link.tabIndex = show ? 0 : -1;
        });
        document.body.classList.toggle('catalog-locked', !ready && !anyShown);
    }

    hasCloudSession() {
        try {
            if (window.NorvaCloud?.deviceToken || localStorage.getItem('norva-cloud-device-token')) {
                return true;
            }

            const session = JSON.parse(localStorage.getItem('norva-cloud-session') || 'null');
            // No expiry condition: an expired access token + refresh_token is still a
            // signed-in user — checkAuth()/getAccessToken() rotates it at boot.
            // Expiry-gating here bounced still-valid sessions to login after >1h idle.
            return Boolean(
                session?.access_token &&
                session?.refresh_token &&
                session?.user?.id
            );
        } catch (_) {
            return false;
        }
    }

    // Keep the Supabase session fresh while the app is open: rotate the access
    // token shortly BEFORE it expires (and on tab wake) instead of on the first
    // failing call after it — so an idle-but-open tab never carries an expired
    // token into a burst of requests. Runs only for real USER sessions (paired
    // device-token screens have nothing to refresh). Safe with many tabs:
    // NorvaAuth.refreshSession is single-flighted + cross-tab locked.
    startSessionKeepFresh() {
        if (!window.NorvaAuth?.refreshSession) return;
        const tick = () => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            let session = null;
            try { session = JSON.parse(localStorage.getItem('norva-cloud-session') || 'null'); } catch (_) { /* noop */ }
            if (!session?.refresh_token || !session?.user?.id) return;   // device-token TV: skip
            const now = Math.floor(Date.now() / 1000);
            if (session.expires_at && Number(session.expires_at) - now < 120) {
                // Transient failures keep the session (next tick retries); a definitive
                // failure clears it and the next navigation lands on the login page —
                // which at that point is a real, unavoidable logout (token revoked).
                window.NorvaAuth.refreshSession().catch(() => { /* handled above */ });
            }
        };
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') tick();
            });
        }
        if (this._sessionFreshTimer) clearInterval(this._sessionFreshTimer);
        this._sessionFreshTimer = setInterval(tick, 60 * 1000);
        tick();
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

    // Thin header bar showing background catalog enrichment (TMDB matching) progress. Kept
    // OFF for end users — a red "Enrichissement… 18%" banner reads as an error, and a
    // background re-enrichment of an already-live catalog is an internal concern, not
    // something to surface. Opt-in via localStorage['norva-show-enrichment']='1' for debugging.
    startEnrichmentProgressPoll() {
        if (!window.API?.isCloudMode?.()) return;
        const bar = document.getElementById('enrichment-bar');
        if (!bar) return;
        let showEnrichment = false;
        try { showEnrichment = localStorage.getItem('norva-show-enrichment') === '1'; } catch (_) { /* ignore */ }
        if (!showEnrichment) { bar.hidden = true; return; }
        const fill = bar.querySelector('.enrichment-bar__fill');
        const text = bar.querySelector('.enrichment-bar__text');
        const stop = () => { if (this._enrichTimer) { clearInterval(this._enrichTimer); this._enrichTimer = null; } };
        this._stopEnrichPoll = stop;
        const tick = async () => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            if (!this.hasCloudSession?.()) { bar.hidden = true; stop(); return; }
            // Never overlap: enrichment-progress can be slow under DB load, and an
            // unguarded 45s interval stacked several in-flight requests that EACH held a
            // connection for up to the 150s edge limit — a real contributor to connection-
            // pool exhaustion (the whole-DB stall seen in the refresh trace). One at a time.
            if (this._enrichInFlight) return;
            this._enrichInFlight = true;
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
                this._enrichFails = 0;
                if (!Number.isFinite(percent) || total < 1 || settled || stalled) {
                    bar.hidden = true;
                    stop(); // done/settled — stop polling entirely instead of hitting the DB forever
                } else {
                    if (fill) fill.style.width = percent + '%';
                    if (text) text.textContent = `Enrichissement du catalogue… ${percent}%`;
                    bar.hidden = false;
                }
            } catch (_) {
                // Back off a struggling DB: give up after a few consecutive failures
                // rather than re-polling a slow endpoint forever.
                this._enrichFails = (this._enrichFails || 0) + 1;
                if (this._enrichFails >= 3) { bar.hidden = true; stop(); }
            } finally {
                this._enrichInFlight = false;
            }
        };
        tick();
        if (this._enrichTimer) clearInterval(this._enrichTimer);
        this._enrichTimer = setInterval(tick, 60 * 1000);
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
                // Identify the RevenueCat App User ID as the Supabase user id at boot,
                // so a store purchase is attributed to THIS account. Doing it here
                // (not lazily right before purchase) avoids the async logIn/purchase
                // race, and re-aliases any purchase made before identity was set on
                // the next launch. Guarded no-op on web / without the native bridge.
                if (user?.id) { try { window.NorvaBilling?.login?.(user.id); } catch (_) { /* noop */ } }
                // Reveal the Admin nav ONLY for real admins. In cloud mode currentUser.role is
                // always 'admin' (hardcoded above), so it can't gate — the authoritative check is
                // the server-side is_admin() RPC (app_metadata.role in the JWT). Non-admins never
                // see the link, and even if they did, every admin RPC rejects them.
                this.checkIsAdmin().then((ok) => {
                    if (!ok) return;
                    document.querySelectorAll('[data-page="admin"]').forEach((l) => {
                        l.hidden = false;
                        l.removeAttribute('aria-hidden');
                        l.style.display = '';
                        l.tabIndex = 0;
                    });
                }).catch(() => {});
                return;
            } catch (err) {
                // TRANSIENT failure (network not up at wake, Supabase 5xx/429): the
                // session in storage is still valid — boot with the cached user
                // instead of bouncing to the login page (that bounce WAS the
                // "logged out after inactivity" bug). Only a DEFINITIVE auth failure
                // (refresh token revoked/invalid → err.definitive, session already
                // cleared by authApi) falls through to the redirect.
                let cachedUser = null;
                try { cachedUser = JSON.parse(localStorage.getItem('norva-cloud-session') || 'null')?.user || null; } catch (_) { /* noop */ }
                if (!err?.definitive && (cachedUser?.id || window.NorvaCloud?.deviceToken)) {
                    console.warn('Cloud auth check failed transiently — continuing with the cached session:', err);
                    this.currentUser = {
                        id: cachedUser?.id || localStorage.getItem('norva-cloud-device-id') || 'paired-device',
                        username: cachedUser?.email || 'Paired Norva screen',
                        email: cachedUser?.email || '',
                        role: 'admin',
                        cloud: true,
                        device: !cachedUser
                    };
                    this.addLogoutButton();
                    if (cachedUser?.id) { try { window.NorvaBilling?.login?.(cachedUser.id); } catch (_) { /* noop */ } }
                    return;
                }
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
                // A 401 here can be a momentarily-stale token, not a dead session.
                // Redirect to login ONLY when a refresh attempt fails definitively
                // (revoked/invalid token — authApi clears the session); a transient
                // refresh failure falls through to the fail-open branch below.
                let refreshedOk = false;
                try {
                    const refreshed = await window.NorvaAuth?.refreshSession?.();
                    refreshedOk = Boolean(refreshed?.access_token);
                } catch (refreshErr) {
                    if (refreshErr?.definitive || !window.NorvaAuth) {
                        const returnTo = window.location.pathname + window.location.search + window.location.hash;
                        window.location.replace('/account.html?returnTo=' + encodeURIComponent(returnTo || '/'));
                        return false;
                    }
                }
                if (!refreshedOk && !window.NorvaAuth?.getSession?.()?.refresh_token && !this.currentUser?.device) {
                    const returnTo = window.location.pathname + window.location.search + window.location.hash;
                    window.location.replace('/account.html?returnTo=' + encodeURIComponent(returnTo || '/'));
                    return false;
                }
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

    // Gentle "X days left in your trial" banner. Shows whenever the REAL status
    // is a running trial — the decision carries it even while billing is only
    // observed, and the countdown is true information either way. Dismissible,
    // re-appears as the day count changes so it never nags twice in the same day.
    // The region prompt organizes a catalog, so it only makes sense once one
    // exists. Delegated to NorvaCloud; called from the catalog-ready flow so it
    // never fires on the empty onboarding screen.
    maybeShowRegionPrompt() {
        try {
            if (!this.isCatalogReady()) return;
            window.NorvaCloud?.regions?.maybeShowPrompt?.();
        } catch (_) { /* never break the app over a prompt */ }
    }

    maybeShowTrialBanner() {
        try {
            // Only on a working Home — never on the pre-catalog onboarding screen,
            // where a "manage plan" nudge is premature and collides with the region
            // prompt in the same bottom-of-screen zone.
            if (!this.isCatalogReady()) return;
            const ent = this.entitlement || window.NorvaEntitlement;
            if (!ent || ent.status !== 'trialing') return;
            const endIso = ent.projection?.trial_ends_at || ent.projection?.current_period_end;
            if (!endIso) return;
            const msLeft = new Date(endIso).getTime() - Date.now();
            if (!(msLeft > 0)) return;
            const daysLeft = Math.max(1, Math.ceil(msLeft / 86400000));
            const lastDay = daysLeft === 1;

            // A single, ambient trial indicator on ALL platforms: a compact chip in
            // the header. It replaces the old floating bottom pill, whose prominent
            // "Manage plan" CTA put a cancel doorway in front of trialing users every
            // session (a churn accelerant, and out of step with how premium streaming
            // apps handle trials — the real reminder belongs in email). The chip is
            // transparent (days left are visible) but not pushy; tapping it opens an
            // informative recap where converting is the positive action.
            const navbar = document.querySelector('.navbar');
            if (!navbar) return; // header not mounted yet — re-runs on catalog-ready
            const labelText = lastDay ? 'Last day' : daysLeft + 'd left';
            const title = lastDay ? 'Last day of your Norva free trial' : daysLeft + ' days left in your Norva free trial';
            // Urgency palette: purple normally, amber on the last day.
            const accent = lastDay ? '#f6b64b' : '#b579ff';
            const bg = lastDay ? 'rgba(246,182,75,.13)' : 'rgba(181,121,255,.12)';
            const border = lastDay ? 'rgba(246,182,75,.5)' : 'rgba(181,121,255,.42)';
            this._trialEndIso = endIso; // read by showTrialRecap()
            let chip = document.getElementById('norva-trial-chip');
            if (!chip) {
                chip = document.createElement('button');
                chip.type = 'button';
                chip.id = 'norva-trial-chip';
                chip.setAttribute('aria-haspopup', 'dialog');
                chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:999px;font:800 13px/1 Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap;flex:0 0 auto';
                chip.innerHTML = '<span aria-hidden="true" style="width:6px;height:6px;border-radius:50%;background:currentColor"></span><span data-chip-label></span>';
                // Sit in the right-hand header cluster, before the search button.
                const anchor = navbar.querySelector('#nav-search');
                if (anchor) navbar.insertBefore(chip, anchor); else navbar.appendChild(chip);
                chip.addEventListener('click', () => this.showTrialRecap());
            }
            // (Re)apply text + palette so a day rollover updates in place.
            chip.title = title;
            chip.setAttribute('aria-label', title + ' — view details');
            chip.style.background = bg;
            chip.style.border = '1px solid ' + border;
            chip.style.color = accent;
            chip.querySelector('[data-chip-label]').textContent = labelText;
        } catch (_) { /* never break the app over a banner */ }
    }

    // Informative recap opened from the trial chip. Transparent about the end date
    // and the no-auto-charge model; the positive action is converting ("See plans"),
    // not a prominent cancel path. A dimmed backdrop keeps it the only thing on
    // screen; Escape/backdrop-tap dismiss.
    showTrialRecap() {
        try {
            const endIso = this._trialEndIso;
            if (!endIso) return;
            if (document.getElementById('norva-trial-recap')) return;
            const end = new Date(endIso);
            const msLeft = end.getTime() - Date.now();
            if (!(msLeft > 0)) return;
            const daysLeft = Math.max(1, Math.ceil(msLeft / 86400000));
            const lastDay = daysLeft === 1;
            const accent = lastDay ? '#f6b64b' : '#b579ff';
            let dateStr;
            try { dateStr = end.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); }
            catch (_) { dateStr = end.toISOString().slice(0, 10); }
            const here = location.pathname + location.search + location.hash;
            const seePlansHref = '/subscribe.html?returnTo=' + encodeURIComponent(here);
            const prevFocus = document.activeElement;

            const backdrop = document.createElement('div');
            backdrop.id = 'norva-trial-recap';
            backdrop.setAttribute('role', 'dialog');
            backdrop.setAttribute('aria-modal', 'true');
            backdrop.setAttribute('aria-label', 'Your free trial');
            backdrop.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(2,6,15,.62);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;opacity:0;transition:opacity .16s ease';

            const card = document.createElement('div');
            card.style.cssText = 'position:relative;box-sizing:border-box;width:100%;max-width:400px;background:#121722;border:1px solid #2b3448;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.5);color:#f8fafc;padding:22px;font:15px/1.5 Inter,system-ui,sans-serif;transform:translateY(10px);transition:transform .18s ease';
            card.innerHTML =
                '<div style="display:flex;align-items:center;gap:8px;font-weight:800;font-size:12px;letter-spacing:.4px;text-transform:uppercase;color:' + accent + ';margin-bottom:10px">' +
                    '<span aria-hidden="true" style="width:7px;height:7px;border-radius:50%;background:currentColor"></span> Free trial' +
                '</div>' +
                '<div style="font-size:22px;font-weight:800;margin-bottom:6px">' + (lastDay ? 'Last day' : daysLeft + ' days left') + '</div>' +
                '<p style="color:#aeb8cc;margin:0 0 6px">Your free trial ends <strong style="color:#f8fafc">' + dateStr + '</strong>.</p>' +
                '<p style="color:#aeb8cc;margin:0 0 20px">You\'re never charged automatically — subscribe before then to keep your catalogue, offline downloads and cross-device sync.</p>' +
                '<div style="display:flex;flex-direction:column;gap:10px">' +
                    '<a href="' + seePlansHref + '" data-recap-primary style="display:block;text-align:center;width:100%;box-sizing:border-box;min-height:46px;line-height:46px;border-radius:12px;background:#5b7cfa;color:#fff;font-weight:800;font-size:15px;text-decoration:none">See plans</a>' +
                    '<button type="button" data-recap-dismiss style="width:100%;min-height:44px;border:0;border-radius:12px;background:transparent;color:#aeb8cc;font-weight:700;font-size:14px;cursor:pointer">Not now</button>' +
                '</div>';

            const teardown = () => {
                document.removeEventListener('keydown', onKey, true);
                backdrop.remove();
                try { prevFocus && prevFocus.focus && prevFocus.focus(); } catch (_) { /* noop */ }
            };
            const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); teardown(); } };

            backdrop.appendChild(card);
            document.body.appendChild(backdrop);
            backdrop.addEventListener('click', (e) => { if (e.target === backdrop) teardown(); });
            card.querySelector('[data-recap-dismiss]')?.addEventListener('click', teardown);
            document.addEventListener('keydown', onKey, true);
            setTimeout(() => {
                backdrop.style.opacity = '1';
                card.style.transform = 'translateY(0)';
                try { card.querySelector('[data-recap-primary]')?.focus(); } catch (_) { /* noop */ }
            }, 0);
        } catch (_) { /* never break the app over a recap */ }
    }

    // Payment-issue banner: a failed renewal puts the account in a short grace
    // window. Nudge the user to fix billing before access is cut, linking to the
    // subscription manager. Keyed on the REAL status (true even in observe mode).
    maybeShowBillingIssueBanner() {
        try {
            // Not on the empty onboarding screen: a source-less brand-new account has
            // nothing to fix yet, and the banner would collide with the region prompt.
            if (this.sourceHealthSummary && ['not_configured', 'unknown'].includes(this.sourceHealthSummary.state)) return;
            const ent = this.entitlement || window.NorvaEntitlement;
            if (!ent) return;
            const status = ent.status || (ent.projection && ent.projection.status) || '';
            if (!(status === 'past_due' || status === 'grace' || ent.reason === 'billing_grace')) return;
            if (sessionStorage.getItem('norva-billing-banner-dismissed') === '1') return;
            if (document.getElementById('norva-billing-banner')) return;

            const here = location.pathname + location.search + location.hash;
            const bar = document.createElement('div');
            bar.id = 'norva-billing-banner';
            bar.style.cssText = 'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:14px;max-width:calc(100% - 24px);padding:10px 16px;border-radius:999px;background:#2a1d12;border:1px solid #7a5326;color:#fde8b0;font:600 14px/1 Inter,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.45)';

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

            // TV = a device-paired screen. It must unpair (server-side revoke +
            // clear the local device token) so the pairing screen starts fresh
            // instead of silently resuming the SAME account. Detected strictly by
            // the TV user agent so phone/web are untouched. Mirrors Settings.js
            // signOut(); this is the top-nav Logout button, the one used on TV.
            if (/NorvaTV-AndroidTV/i.test(navigator.userAgent || '')) {
                try { await window.NorvaCloud?.device?.unpairSelf?.(); } catch (_) { /* best-effort */ }
                try { window.NorvaCloud?.setDeviceToken?.(''); } catch (_) { /* noop */ }
                try { localStorage.removeItem('norva-cloud-device-id'); } catch (_) { /* noop */ }
                try { if (window.NorvaAuth) await window.NorvaAuth.signOut(); } catch (_) { /* noop */ }
                window.location.replace('/cloud-pair.html?device=tv&returnTo=%2Fapp.html%3Fpaired%3D1%23home');
                return;
            }

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
        // Android TV navigates with a D-pad, not a finger. The touch bottom-sheet
        // collapses every filter into a hidden drawer behind a single "Filters"
        // button — which the remote cannot reach, leaving TV users unable to
        // filter at all. On TV, keep the INLINE filter bar (every select/toggle is
        // a real focusable element the D-pad walks through). CSS keeps that bar
        // laid out inline at TV widths (see the html.tv-mode filter-bar override).
        const isTv = navigator.userAgent.includes('NorvaTV-AndroidTV')
            || new URLSearchParams(location.search).has('tv');
        if (isTv) return null;

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
        // Always visible in the APK (Netflix keeps its Downloads tab even at
        // zero state — the native screen owns the empty-state guidance).
        const isApk = /NorvaTV-AndroidPhone/i.test(navigator.userAgent || '');
        const show = isApk;
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
        // Stash the opener so closeSearch()/hardware-BACK can return the D-pad ring to it (TV).
        this._searchOpener = (document.activeElement && document.activeElement !== document.body)
            ? document.activeElement : document.getElementById('nav-search');
        if (this._searchOpener?.id) ov.dataset.restoreFocus = this._searchOpener.id;
        // Focus SYNCHRONOUSLY inside the opening gesture: Android TV WebViews raise the
        // leanback keyboard only for a gesture-synchronous focus. A deferred (setTimeout)
        // focus is outside the gesture, so the IME then often never rises — an empty,
        // untypeable box, the #1 reason menu search felt broken on TV. Re-assert after paint.
        try { input.focus(); input.select(); } catch (_) { /* noop */ }
        setTimeout(() => {
            try { if (document.activeElement !== input) { input.focus(); input.select(); } } catch (_) { /* noop */ }
        }, 50);
    }

    closeSearch(restoreFocus = true) {
        const ov = document.getElementById('gsearch-overlay');
        if (!ov) return;
        ov.classList.remove('active');
        const opener = this._searchOpener;
        this._searchOpener = null;
        // TV: return the ring to the Search icon so no arrow press is wasted and re-open
        // is one press away. Skipped when navigating to a result (focus lands on the fiche).
        if (restoreFocus && opener && document.documentElement.classList.contains('tv-mode')) {
            try { opener.focus(); } catch (_) { /* noop */ }
        }
    }

    buildSearchOverlay() {
        const ov = document.createElement('div');
        ov.id = 'gsearch-overlay';
        ov.className = 'modal-overlay gsearch-overlay';
        ov.innerHTML = `
            <div class="gsearch-panel" role="dialog" aria-modal="true" aria-label="Search">
                <div class="gsearch-bar">
                    <span class="gsearch-ic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></span>
                    <input id="gsearch-input" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Search movies & series…">
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
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { this.closeSearch(); return; }
            if (e.key === 'Enter') {
                e.preventDefault();
                // On TV, the remote's OK/Enter (and the leanback keyboard's Search/Done
                // key) is the "confirm my query and let me browse" gesture — NOT a pick.
                // So Enter from the field must move the ring INTO the results (dismissing
                // the IME), never auto-open the first result. Opening happens only on a
                // deliberate second OK once a result is focused.
                if (document.documentElement.classList.contains('tv-mode')) {
                    const first = ov.querySelector('.gsearch-result') || ov.querySelector('.gsearch-seeall');
                    if (first) { try { first.focus(); first.scrollIntoView({ block: 'nearest' }); } catch (_) { /* noop */ } return; }
                    // No results yet → run the search now (don't wait out the debounce);
                    // focus stays on the field so the user can then press Down/OK.
                    clearTimeout(this._searchDebounce);
                    const qTv = input.value.trim();
                    if (qTv.length >= 2) this.runSearch(qTv);
                    return;
                }
                // Web/mobile: Enter opens the first result (a keyboard-user shortcut);
                // otherwise run the search immediately.
                if (this._gsMovies && this._gsMovies.length) this.openSearchResult('movie', 0);
                else if (this._gsSeries && this._gsSeries.length) this.openSearchResult('series', 0);
                else {
                    clearTimeout(this._searchDebounce);
                    const q = input.value.trim();
                    if (q.length >= 2) this.runSearch(q);
                }
            }
        });
        document.body.appendChild(ov);
        return ov;
    }

    async runSearch(q) {
        const box = document.getElementById('gsearch-results');
        if (!box) return;
        if (q.length < 2) {
            box.innerHTML = '<div class="gsearch-hint">Type at least 2 characters to search the catalogue.</div>';
            this._gsMovies = [];
            this._gsSeries = [];
            return;
        }
        const reqId = (this._searchReq = (this._searchReq || 0) + 1);
        box.innerHTML = '<div class="gsearch-hint"><div class="loading-spinner"></div></div>';
        const empty = { items: [] };
        // dedup=1 → the search RPC collapses to one representative row per film SERVER-SIDE
        // (grid parity, durable across clients), so 48 rows ≈ 48 distinct films. openByItem's
        // sibling re-fetch deliberately OMITS the flag — the version picker needs raw rows.
        const [mv, sr] = await Promise.all([
            window.API.media.page({ type: 'movie', q, limit: 48, dedup: 1 }).catch(() => empty),
            window.API.media.page({ type: 'series', q, limit: 48, dedup: 1 }).catch(() => empty),
        ]);
        if (reqId !== this._searchReq) return; // a newer keystroke superseded this
        // Re-group client-side on top of the server dedup. Still load-bearing for two cases:
        // (1) tmdb-split duplicates — same film under different dedup_keys (one tmdb-keyed, one
        // norm-keyed) survive the server's DISTINCT ON exactly like on the grid, and the
        // title+year fold below merges them; (2) the edge's fallback to the un-deduped RPC path
        // (pre-migration edge, RPC error). prep() hoists metadata.providerTmdbId onto tmdb_id and
        // backfills the year from release_year / the dedup_key's :YYYY suffix so groupItems has
        // reliable keys. openSearchResult() indexes into the representative arrays, so store them
        // in rendered order.
        const M = window.MediaUtils;
        const prep = (arr) => (arr || []).map((it) => {
            const tmdbId = it.tmdb_id || it.metadata?.providerTmdbId || it.providerTmdbId || undefined;
            let year = it.year ?? it.release_year ?? null;
            if (!year) {
                const m = /(?:^|[:|])((?:19|20)\d{2})$/.exec(String(it.dedup_key || ''));
                if (m) year = Number(m[1]);
            }
            return (tmdbId || year) ? { ...it, tmdb_id: tmdbId, year: year ?? it.year } : it;
        });
        const grp = (arr, idField) => {
            const prepped = prep(arr);
            return M?.groupItems
                ? M.groupItems(prepped, { idField })
                : prepped.map((it) => ({ representative: it, items: [it] }));
        };
        const gMovies = grp(mv.items, 'stream_id');
        const gSeries = grp(sr.items, 'series_id'); // series dedup by series_id, mirroring SeriesPage
        this._gsMovies = gMovies.map((g) => g.representative);
        this._gsSeries = gSeries.map((g) => g.representative);
        this.renderSearchResults(box, q, gMovies, gSeries);
    }

    renderSearchResults(box, q, movies, series) {
        const M = window.MediaUtils;
        const row = (group, type, idx) => {
            const item = group.representative || group;
            const count = Array.isArray(group.items) ? group.items.length : 1;
            const title = item.tmdb?.title || item.tmdb?.name || item.name || 'Untitled';
            const poster = M.safeImageUrl(
                item.stream_icon || item.cover || M.tmdbPosterUrl(item.tmdb),
                '/img/norva-media-placeholder.png');
            const year = String(item.tmdb?.release_date || item.tmdb?.first_air_date || item.year || '').slice(0, 4);
            const versions = count > 1 ? ` · ${count} versions` : '';
            return `
                <button type="button" class="gsearch-result" data-type="${type}" data-idx="${idx}">
                    <img class="gsearch-poster" src="${M.escapeHtml(poster)}" alt="" loading="lazy"
                         onerror="this.onerror=null;this.srcset='';this.src='/img/norva-media-placeholder.png'">
                    <span class="gsearch-text">
                        <span class="gsearch-title">${M.escapeHtml(title)}</span>
                        <span class="gsearch-sub">${type === 'series' ? 'Series' : 'Movie'}${year ? ' · ' + year : ''}${versions}</span>
                    </span>
                </button>`;
        };
        // Reachable-count on the section header ("Movies · 6") + a "See all" escape hatch to the
        // fully-paged in-page grid, since the overlay caps at 48 raw rows/type before grouping.
        const seeAll = (type, label) =>
            `<button type="button" class="gsearch-seeall" data-seeall="${type}">See all in ${label} →</button>`;
        let html = '';
        if (movies.length) html += `<div class="gsearch-section">Movies · ${movies.length}</div>`
            + movies.map((m, i) => row(m, 'movie', i)).join('') + seeAll('movie', 'Movies');
        if (series.length) html += `<div class="gsearch-section">Series · ${series.length}</div>`
            + series.map((s, i) => row(s, 'series', i)).join('') + seeAll('series', 'Series');
        if (!html) {
            box.innerHTML = `<div class="gsearch-hint">No results for “${M.escapeHtml(q)}”.</div>`;
            return;
        }
        box.innerHTML = html;
        box.querySelectorAll('.gsearch-result').forEach((el) => {
            el.addEventListener('click', () => this.openSearchResult(el.dataset.type, parseInt(el.dataset.idx, 10)));
        });
        box.querySelectorAll('.gsearch-seeall').forEach((el) => {
            el.addEventListener('click', () => this.seeAllInPage(el.dataset.seeall, q));
        });
    }

    // "See all in Movies/Series": land on the fully-paged in-page grid, pre-searched to the same
    // query — the same navigate+prefill path openSearchResult() falls back to (race-safe via the
    // page's cloudRequestId guard). Removes the overlay's 48-row ceiling as the limiting factor.
    seeAllInPage(type, q) {
        this.closeSearch(false);
        const page = type === 'series' ? 'series' : 'movies';
        this.navigateTo(page);
        setTimeout(() => {
            const input = document.getElementById(page === 'series' ? 'series-search' : 'movies-search');
            if (input) { input.value = q; input.dispatchEvent(new Event('input', { bubbles: true })); }
            // TV: once the searched grid re-renders, land the D-pad ring on the first card
            // so the first arrow press isn't wasted waking focus onto <body>.
            if (document.documentElement.classList.contains('tv-mode')) {
                setTimeout(() => {
                    const card = document.querySelector(`#${page}-grid .${type === 'series' ? 'series' : 'movie'}-card`);
                    try { card?.focus?.(); card?.scrollIntoView?.({ block: 'nearest' }); } catch (_) { /* noop */ }
                }, 450);
            }
        }, 140);
    }

    // Open the tapped result's detail directly via the page's openByItem(). If
    // that can't resolve a detail (page not ready, fetch failed), fall back to
    // landing on the page pre-searched to the title — the page's cloudRequestId
    // guard makes that prefill race-safe.
    openSearchResult(type, idx) {
        const item = (type === 'series' ? this._gsSeries : this._gsMovies)?.[idx];
        this.closeSearch(false);
        const page = type === 'series' ? 'series' : 'movies';
        this.navigateTo(page);
        const pageObj = type === 'series' ? this.pages?.series : this.pages?.movies;
        const title = item ? (item.tmdb?.title || item.tmdb?.name || item.name || '') : '';
        setTimeout(async () => {
            let opened = false;
            try { if (item && pageObj?.openByItem) opened = await pageObj.openByItem(item); } catch (_) { opened = false; }
            if (opened) {
                // TV: land the D-pad ring on the opened fiche's primary action (Play/Voir),
                // mirroring the in-page card-commit focus — otherwise focus falls to <body>
                // and the first arrow press wakes a grid card behind the fiche.
                if (document.documentElement.classList.contains('tv-mode')) {
                    requestAnimationFrame(() => {
                        const btn = pageObj?.primaryActionBtn;
                        try {
                            if (btn && !btn.disabled && btn.offsetParent) { btn.focus(); btn.scrollIntoView({ block: 'nearest' }); }
                        } catch (_) { /* noop */ }
                    });
                }
                return;
            }
            const input = document.getElementById(page === 'series' ? 'series-search' : 'movies-search');
            if (input && title) {
                input.value = title;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, 140);
    }

    // ---- Keep the open movie/series fiche across a page refresh -------------
    // The detail panel is a sub-view of the catalogue page, not a routed page, so a
    // reload would otherwise drop back to the list. We stash the open title in
    // sessionStorage (survives a refresh, dies with the tab) and re-open it on load
    // via the page's openByItem() — the same id->fiche resolver the global search uses.
    rememberOpenFiche(fiche) {
        try {
            if (!fiche || fiche.id == null || fiche.sourceId == null) return;
            sessionStorage.setItem('norva-open-fiche', JSON.stringify(fiche));
        } catch (_) { /* private mode: sessionStorage may throw */ }
    }

    forgetOpenFiche() {
        try { sessionStorage.removeItem('norva-open-fiche'); } catch (_) { /* noop */ }
    }

    readOpenFiche() {
        try { return JSON.parse(sessionStorage.getItem('norva-open-fiche') || 'null'); } catch (_) { return null; }
    }

    fichePageFor(fiche) {
        return fiche?.type === 'series' ? 'series' : 'movies';
    }

    // Fiche deep link: "open:<sourceId>:<id>:<title>" (segments encodeURIComponent-encoded) —
    // the URL shape the subtitle-ready email button and the bell entries carry. Opens the fiche
    // via the same openByItem resolver the global search and the Home rails use (the title makes
    // the sibling-versions lookup work, so the fiche arrives full, not sparse). Best-effort: a
    // stale/foreign id just leaves the catalogue page open.
    openFicheFromRoute(pageName) {
        const route = String(this._openFicheRoute || '');
        this._openFicheRoute = '';
        if (!route.startsWith('open:')) return;
        const dec = (s) => { try { return decodeURIComponent(s || ''); } catch (_) { return ''; } };
        const [rawSourceId, id, title] = route.slice('open:'.length).split(':').map(dec);
        const pageObj = this.pages?.[pageName];
        if (!rawSourceId || !id || typeof pageObj?.openByItem !== 'function') return;
        // The link carries the CLOUD source UUID; the catalog pages key on the LOCAL alias.
        const sourceId = window.API?.localSourceIdFor ? window.API.localSourceIdFor(rawSourceId) : rawSourceId;
        // Defer so the page's show()/DOM has settled (mirrors restoreOpenFiche).
        setTimeout(() => {
            const item = pageName === 'series'
                ? { sourceId, series_id: id, name: title, ...(title ? { tmdb: { name: title } } : {}) }
                : { sourceId, stream_id: id, name: title, ...(title ? { tmdb: { title } } : {}) };
            Promise.resolve(pageObj.openByItem(item)).catch(() => {});
        }, 200);
    }

    // Re-open the saved fiche once, on the page it belongs to, after a refresh.
    restoreOpenFiche(pageName, fiche = this.readOpenFiche()) {
        if (!fiche || this.fichePageFor(fiche) !== pageName) return;
        const pageObj = this.pages?.[pageName];
        if (!pageObj) return;
        // Defer so the page's show()/DOM has settled (mirrors openSearchResult).
        setTimeout(async () => {
            try {
                // Rebuild the EXACT fiche from the stashed version group (all versions, no
                // re-search). Fall back to openByItem for older id-only stashes.
                if (fiche.type === 'series' && fiche.series && pageObj.showSeriesDetailsV2) {
                    await pageObj.showSeriesDetailsV2(fiche.series, fiche.group || null);
                    return;
                }
                if (fiche.type === 'movie' && fiche.group?.items?.length && pageObj.showMovieDetails) {
                    const selected = fiche.group.items.find(i => String(i.stream_id) === String(fiche.id)) || null;
                    pageObj.showMovieDetails(fiche.group, selected, {});
                    return;
                }
                if (pageObj.openByItem) {
                    const item = fiche.item || (fiche.type === 'series'
                        ? { sourceId: fiche.sourceId, series_id: fiche.id, name: fiche.title, tmdb: { name: fiche.title } }
                        : { sourceId: fiche.sourceId, stream_id: fiche.id, name: fiche.title, tmdb: { title: fiche.title } });
                    if (!(await pageObj.openByItem(item))) this.forgetOpenFiche();
                }
            } catch (_) { this.forgetOpenFiche(); }
        }, 150);
    }

    // ---- Live mini-player (web) -------------------------------------------
    // Leaving Live TV while a channel plays docks the inline player into a small
    // floating window (YouTube-style) so it keeps playing while you browse, then
    // pops back into the page on return. Re-parenting the <video>'s container in
    // the DOM doesn't interrupt playback. Web only: the APK plays live in a native
    // fullscreen activity, and if the viewer chose the browser's PiP that owns the
    // float instead.

    isLiveMiniActive() {
        return Boolean(document.getElementById('norva-mini')?.classList.contains('active'));
    }

    enterLiveMini() {
        if (window.NorvaTVCloud || window.NodeCastNative) return;          // native shell
        if (document.body.classList.contains('norva-phone-apk')) return;   // APK
        if (document.pictureInPictureElement) return;                      // browser PiP owns it
        if (this.isLiveMiniActive()) return;
        const player = this.player;
        const container = document.getElementById('video-container');
        if (!player || !container) return;
        // Only dock a LIVE channel that is actually playing.
        const playing = (typeof player.hasCurrentMedia === 'function' && player.hasCurrentMedia())
            && (typeof player.isLivePlayback !== 'function' || player.isLivePlayback())
            && Boolean(this.channelList?.currentChannel);
        if (!playing) return;

        const mini = document.getElementById('norva-mini') || this.buildLiveMini();
        mini.querySelector('.norva-mini-stage').appendChild(container); // playback continues
        container.classList.add('in-mini');
        mini.classList.add('active');
        this.refreshLiveMiniMeta();
        this.placeLiveMini(true); // snap to the remembered corner (no entrance slide)
    }

    exitLiveMini(opts = {}) {
        const mini = document.getElementById('norva-mini');
        const stop = () => { if (opts.stop) { try { this.player?.stop?.(); } catch (_) { /* noop */ } } };
        if (!mini || !mini.classList.contains('active')) { stop(); return; }
        const container = document.getElementById('video-container');
        const section = document.querySelector('#page-live .player-section');
        if (container && section) {
            // Put the player back as the FIRST child, before #live-guide-fusion.
            section.insertBefore(container, section.firstChild);
            container.classList.remove('in-mini');
        }
        mini.classList.remove('active');
        stop();
    }

    refreshLiveMiniMeta() {
        const title = document.getElementById('norva-mini')?.querySelector('.norva-mini-title');
        if (title) title.textContent = this.channelList?.currentChannel?.name || 'Live TV';
    }

    buildLiveMini() {
        const mini = document.createElement('div');
        mini.id = 'norva-mini';
        mini.className = 'norva-mini';
        mini.innerHTML = `
            <div class="norva-mini-stage"></div>
            <button type="button" class="norva-mini-hit" title="Back to Live TV" aria-label="Back to Live TV"></button>
            <div class="norva-mini-bar">
                <span class="norva-mini-title">Live TV</span>
                <button type="button" class="norva-mini-btn norva-mini-expand" title="Back to Live TV" aria-label="Back to Live TV">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
                </button>
                <button type="button" class="norva-mini-btn norva-mini-close" title="Close" aria-label="Close">&times;</button>
            </div>`;
        // Expand / tapping the video → return to Live TV (show() restores the
        // surface). A transparent hit-layer captures the gesture so the moved
        // #video-container's own click/dblclick (toggle controls / fullscreen)
        // never fires inside the mini. A real drag suppresses the expand.
        const expand = () => this.navigateTo('live');
        mini.querySelector('.norva-mini-hit').addEventListener('click', () => {
            if (this._miniDragged) { this._miniDragged = false; return; }
            expand();
        });
        mini.querySelector('.norva-mini-expand').addEventListener('click', (e) => { e.stopPropagation(); expand(); });
        // Close → stop the stream (frees the provider slot) and restore the surface.
        mini.querySelector('.norva-mini-close').addEventListener('click', (e) => {
            e.stopPropagation();
            this.exitLiveMini({ stop: true });
        });
        document.body.appendChild(mini);
        this.initLiveMiniDrag(mini);
        // Keep the mini pinned to its corner when the viewport changes.
        window.addEventListener('resize', () => this.placeLiveMini(true));
        return mini;
    }

    /** Position the mini at its saved corner (left/top px). instant = no slide. */
    placeLiveMini(instant) {
        const mini = document.getElementById('norva-mini');
        if (!mini || !mini.classList.contains('active')) return;
        const corner = this._miniCorner || localStorage.getItem('norva_mini_corner') || 'br';
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = mini.offsetWidth, h = mini.offsetHeight;
        const mobile = vw <= 768;
        const side = mobile ? 10 : 18;
        const navH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--navbar-height'), 10) || 64;
        const topInset = navH + (mobile ? 10 : 12);          // clear the top navbar
        const bottomInset = mobile ? 78 : 18;                // clear the mobile bottom nav
        const left = corner.includes('l') ? side : Math.max(side, vw - w - side);
        const top = corner.charAt(0) === 't' ? topInset : Math.max(topInset, vh - h - bottomInset);
        if (instant) mini.style.transition = 'none';
        mini.style.left = `${left}px`;
        mini.style.top = `${top}px`;
        mini.style.right = 'auto';
        mini.style.bottom = 'auto';
        if (instant) { void mini.offsetWidth; mini.style.transition = ''; } // re-arm the snap easing
    }

    /** Drag the mini with mouse or finger; on release, snap to the nearest corner
     *  and remember it (localStorage). A <6px move counts as a tap, not a drag. */
    initLiveMiniDrag(mini) {
        if (!this._miniCorner) this._miniCorner = localStorage.getItem('norva_mini_corner') || 'br';
        const THRESH = 6;
        let pid = null, sx = 0, sy = 0, bl = 0, bt = 0, dragging = false;
        const move = (e) => {
            if (e.pointerId !== pid) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!dragging) {
                if (Math.hypot(dx, dy) < THRESH) return;
                dragging = true;
                mini.classList.add('is-dragging');
            }
            const nl = Math.max(4, Math.min(bl + dx, window.innerWidth - mini.offsetWidth - 4));
            const nt = Math.max(4, Math.min(bt + dy, window.innerHeight - mini.offsetHeight - 4));
            mini.style.left = `${nl}px`;
            mini.style.top = `${nt}px`;
            mini.style.right = 'auto';
            mini.style.bottom = 'auto';
        };
        const up = (e) => {
            if (e.pointerId !== pid) return;
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            document.removeEventListener('pointercancel', up);
            pid = null;
            if (!dragging) return;        // a tap → let the expand click run
            mini.classList.remove('is-dragging');
            this._miniDragged = true;     // suppress the expand click that follows
            const r = mini.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            this._miniCorner = (cy < window.innerHeight / 2 ? 't' : 'b') + (cx < window.innerWidth / 2 ? 'l' : 'r');
            try { localStorage.setItem('norva_mini_corner', this._miniCorner); } catch (_) { /* noop */ }
            this.placeLiveMini();         // animate to the snapped corner
        };
        mini.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.norva-mini-btn')) return;  // buttons aren't drag handles
            if (e.button != null && e.button > 0) return;     // primary mouse button / touch only
            pid = e.pointerId;
            const r = mini.getBoundingClientRect();
            bl = r.left; bt = r.top; sx = e.clientX; sy = e.clientY; dragging = false;
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', up);
            document.addEventListener('pointercancel', up);
        });
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

        // Update browser history. A monotonic `idx` lets the native Back button
        // tell the root app entry (idx 0 → exit the app) from a step it can pop
        // (idx > 0 → history.back()), and keeps Back tied to real tab order.
        if (replaceHistory) {
            // Replace current history entry (used on initial load)
            this._histIdx = 0;
            history.replaceState({ page: pageName, idx: 0 }, '', `#${pageName}`);
        } else {
            // Add new history entry
            this._histIdx = (this._histIdx || 0) + 1;
            history.pushState({ page: pageName, idx: this._histIdx }, '', `#${pageName}`);
        }

        this.applyPage(pageName);
    }

    /**
     * Switch the visible page WITHOUT touching history. Used by navigateTo (after
     * it records history) and by the popstate handler — which must NOT re-push the
     * entry the browser just popped, or Back would stack duplicates and need
     * several presses to move one tab.
     */
    applyPage(pageName) {
        pageName = this.guardCatalogPage(pageName);

        // Navigating to a page that doesn't own the open fiche abandons it — drop the
        // saved-fiche token so a later refresh doesn't resurrect a detail you closed.
        const openFiche = this.readOpenFiche();
        if (openFiche && this.fichePageFor(openFiche) !== pageName) this.forgetOpenFiche();

        // Remember where the outgoing page was scrolled (page-level scroller, e.g.
        // #page-home; Movies/Series grids save their own scroller in hide()).
        this._pageScroll = this._pageScroll || {};
        const prevPageEl = document.getElementById(`page-${this.currentPage}`);
        if (prevPageEl) this._pageScroll[this.currentPage] = prevPageEl.scrollTop || 0;

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

        // Playback pages want hls.js in flight before any stream resolves.
        if (pageName === 'live' || pageName === 'watch') window.ensureHls?.();

        if (pageName === 'admin' && !this.pages.admin) {
            // Lazy web-only route: re-verify the admin claim server-side BEFORE
            // even downloading AdminPage.js; APK shells and non-admins bounce home.
            this.checkIsAdmin()
                .then((ok) => {
                    if (!ok) { this.navigateTo('home'); return null; }
                    return this.ensureAdminPage();
                })
                .then((page) => { if (page && this.currentPage === 'admin') page.show?.(); })
                .catch((err) => console.error('[App] AdminPage load failed:', err));
        } else if (this.pages[pageName]?.show) {
            this.pages[pageName].show();
        }

        // Restore the incoming page's position (two passes: instant, and once
        // async content has had a beat to paint back at full height).
        const savedTop = this._pageScroll[pageName] || 0;
        if (savedTop > 0) {
            const restore = () => {
                const el = document.getElementById(`page-${pageName}`);
                if (el && Math.abs(el.scrollTop - savedTop) > 4 && el.scrollHeight > savedTop) {
                    el.scrollTop = savedTop;
                }
            };
            requestAnimationFrame(restore);
            setTimeout(restore, 350);
        }

        // After the switch: the watch page is its own fullscreen player, so a movie
        // /episode must never play under a still-floating live mini. Run this LAST —
        // the page being left has already had hide() (which may have just docked the
        // mini), so stopping here undocks + kills it before the movie starts.
        if (pageName === 'watch') {
            try { this.exitLiveMini({ stop: true }); } catch (_) { /* noop */ }
        }
    }

    /**
     * Lightweight toast with an optional action button (used for undo, etc.).
     * Auto-dismisses after `duration` ms; clicking the action fires `onAction`
     * and cancels the dismiss. Returns the element so callers can dismiss early.
     */
    showToast(message, { action = '', onAction = null, type = 'info', duration = 5000 } = {}) {
        let host = document.getElementById('norva-toasts');
        if (!host) {
            host = document.createElement('div');
            host.id = 'norva-toasts';
            host.className = 'norva-toasts';
            host.setAttribute('role', 'status');
            host.setAttribute('aria-live', 'polite');
            document.body.appendChild(host);
        }
        const toast = document.createElement('div');
        toast.className = `norva-toast norva-toast-${type}`;
        const span = document.createElement('span');
        span.className = 'norva-toast-msg';
        span.textContent = message;
        toast.appendChild(span);
        let timer = null;
        const dismiss = () => { clearTimeout(timer); toast.classList.remove('show'); setTimeout(() => toast.remove(), 200); };
        if (action && typeof onAction === 'function') {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'norva-toast-action';
            btn.textContent = action;
            btn.addEventListener('click', () => { dismiss(); try { onAction(); } catch (_) { /* noop */ } });
            toast.appendChild(btn);
        }
        host.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        timer = setTimeout(dismiss, duration);
        return { dismiss };
    }

    /** Show/hide the "You're offline" banner. */
    updateOfflineBanner(online) {
        let banner = document.getElementById('norva-offline-banner');
        if (online) { banner?.remove(); return; }
        if (banner) return;
        banner = document.createElement('div');
        banner.id = 'norva-offline-banner';
        banner.className = 'norva-offline-banner';
        banner.setAttribute('role', 'status');
        banner.textContent = "You're offline — showing what's cached. Reconnect to browse and play.";
        document.body.appendChild(banner);
    }

    /** Load AdminPage's script on demand and instantiate it (admin-only route). */
    async ensureAdminPage() {
        if (this.pages.admin) return this.pages.admin;
        if (!this._adminPageLoading) {
            this._adminPageLoading = new Promise((resolve, reject) => {
                if (window.AdminPage) { resolve(); return; }
                const s = document.createElement('script');
                // Bump this ?v= whenever AdminPage.js changes — it's lazy-loaded (not an
                // HTML <script>), so hash:assets can't rewrite it, and /js/* is cached
                // immutable for a year. Forgetting to bump = users keep the old admin code.
                s.src = '/js/pages/AdminPage.js?v=64';
                s.onload = () => resolve();
                s.onerror = () => { this._adminPageLoading = null; reject(new Error('AdminPage.js failed to load')); };
                document.head.appendChild(s);
            });
        }
        await this._adminPageLoading;
        if (!this.pages.admin && window.AdminPage) this.pages.admin = new AdminPage(this);
        return this.pages.admin;
    }

    /**
     * Lightweight authoritative admin check (server-side is_admin() RPC) that
     * doesn't require AdminPage to be loaded — it gates whether the Admin nav
     * link (and thus the lazy AdminPage download) is ever offered at all.
     */
    async checkIsAdmin() {
        if (this._isAdminCached !== undefined) return this._isAdminCached;
        try {
            // Admin is a web-only surface: the APK shells never show the entry
            // (ops work belongs on a desktop browser, not a phone/TV WebView).
            if (/NorvaTV-Android/i.test(navigator.userAgent || '')) { this._isAdminCached = false; return false; }
            if (!window.API?.isCloudMode?.()) { this._isAdminCached = false; return false; }
            const sbUrl = (localStorage.getItem('norva-supabase-url') || window.NORVA_SUPABASE_URL
                || 'https://api.norva.tv').replace(/\/+$/, '');
            const sbKey = localStorage.getItem('norva-supabase-key') || window.NORVA_SUPABASE_PUBLISHABLE_KEY
                || 'sb_publishable_LJwYVgPGHYNYTDk7s3eOew_6TU73Fcw';
            let token = '';
            try { token = (JSON.parse(localStorage.getItem('norva-cloud-session') || 'null') || {}).access_token || ''; } catch (_) { }
            const res = await fetch(`${sbUrl}/rest/v1/rpc/is_admin`, {
                method: 'POST',
                headers: { apikey: sbKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: '{}'
            });
            this._isAdminCached = res.ok && (await res.json()) === true;
        } catch (_) {
            this._isAdminCached = false;
        }
        return this._isAdminCached;
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
            try { this.sourceManager?.toast?.(profileName ? `Profile: ${profileName}` : 'Profile changed'); } catch (_) { /* noop */ }
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
