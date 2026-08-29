/**
 * Norva Application Entry Point
 */

/**
 * Companion apps advertised by the navbar "Devices" popover ("Use Norva
 * elsewhere"). Keep the canonical public listings here so every web visitor
 * gets the same install destination.
 */
const NORVA_DEVICE_APPS = [
    {
        key: 'mobile',
        name: 'Android mobile app',
        hint: 'For your phone or tablet',
        storeUrl: 'https://play.google.com/store/apps/details?id=tv.norva.phone',
        available: true,
    },
    {
        key: 'tv',
        name: 'Android TV app',
        hint: 'For the big screen, remote-friendly',
        storeUrl: 'https://play.google.com/store/apps/details?id=tv.norva.tv',
        available: true,
    },
];

const NORVA_NATIVE_CONTINUITY_KEY = 'norva-native-continuity-v1';
const NORVA_NATIVE_FICHE_KEY = 'norva-native-fiche-v1';
const NORVA_NATIVE_CONTINUITY_TTL_MS = 12 * 60 * 60 * 1000;
const NORVA_PARTNERS_TV_RELAY_SESSION_KEY = 'norva-partners-tv-relay-v1';
const NORVA_PARTNERS_TV_RELAY_PATTERN = /^v1\.[A-Za-z0-9_-]{43}\.[0-9a-f]{64}$/;
const NORVA_PARTNERS_TV_RELAY_CLIENT_TTL_MS = 15 * 60 * 1000;
const NORVA_PARTNERS_KYC_CERTIFICATION_SESSION_KEY =
    'norva-partners-kyc-certification-v1';
const NORVA_PARTNERS_KYC_CERTIFICATION_RETURN_TTL_MS = 2 * 60 * 60 * 1000;
const NORVA_PARTNERS_KYC_SESSION_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NORVA_PARTNERS_KYC_RETURN_STATUSES = new Set([
    'Approved',
    'Declined',
    'In Review'
]);

class App {
    constructor() {
        // The phone APK plays everything in the native fullscreen player, so the
        // Live page's inline preview is dead space and its "Fullscreen" button just
        // duplicates "Watch". Flag it so CSS + LiveGuideFusion can drop both.
        if (document.body && /NorvaTV-AndroidPhone/i.test(navigator.userAgent || '')) {
            document.body.classList.add('norva-phone-apk');
        }
        this.navigation = window.NorvaNavigation || null;
        this.currentPage = 'home';
        this.pages = {};
        this.currentUser = null;
        this._partnersKycReturn = this.capturePartnersKycReturn();
        this._nativeRecovery = this.isNativeContinuityRecovery();
        this._nativeContinuity = this.readNativeContinuity();
        this._pendingPartnersTvRelay = this.capturePartnersTvRelay();
        this._pageScroll = { ...(this._nativeContinuity?.pageScroll || {}) };

        // Initialize components
        this.player = new VideoPlayer();
        this.channelList = new ChannelList();
        this.sourceManager = new SourceManager();
        this.epgGuide = new EpgGuide();
        this.liveGuideFusion = new LiveGuideFusion(this);
        this.pairTvSheet = new PairTvSheet(this);

        // Initialize page controllers
        this.pages.home = new HomePage(this);
        this.pages.live = new LivePage(this);
        this.pages.movies = new MoviesPage(this);
        this.pages.series = new SeriesPage(this);
        this.pages.settings = new SettingsPage(this);
        this.pages.partners = new PartnersPage(this);
        this.pages.watch = new WatchPage(this);
        // AdminPage (76 KB) is admin-only: loaded on demand (ensureAdminPage) so
        // every non-admin phone stops downloading/parsing it at boot.
        this.pages.admin = null;
        this.entitlement = null;
        this.sourceHealthSummary = null;
        for (const page of ['movies', 'series']) {
            const top = Number(this._nativeContinuity?.gridScroll?.[page]) || 0;
            if (top > 0 && this.pages[page]) this.pages[page]._savedScrollTop = top;
        }
        this.installNativeContinuityListeners();
        this._accountMenuRequest = (event) => this.openAccountMenu(event?.detail?.opener || null);
        window.addEventListener('norva:account-menu-request', this._accountMenuRequest);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            const elapsed = Date.now() - (this._providerAccessNotificationCheckedAt || 0);
            if (elapsed >= 5 * 60 * 1000) this.refreshProviderAccessNotifications();
        });

        this.init();
    }

    isNativePhoneShell() {
        return /NorvaTV-AndroidPhone/i.test(navigator.userAgent || '');
    }

    isNativeContinuityRecovery() {
        if (!this.isNativePhoneShell()) return false;
        try {
            return new URLSearchParams(window.location.search).get('_nativeRecovery') === '1';
        } catch (_) {
            return false;
        }
    }

    capturePartnersKycReturn() {
        try {
            const url = new URL(window.location.href);
            const sessions = url.searchParams.getAll('verificationSessionId');
            const statuses = url.searchParams.getAll('status');
            const hasSensitiveDiditParams = sessions.length > 0 || statuses.length > 0;
            const validProviderReturn = sessions.length === 1
                && statuses.length === 1
                && NORVA_PARTNERS_KYC_SESSION_PATTERN.test(sessions[0])
                && NORVA_PARTNERS_KYC_RETURN_STATUSES.has(statuses[0]);
            const sanitizedBoundaryReturn = !hasSensitiveDiditParams
                && url.hash === '#partners/kyc-return';

            // Didit adds its opaque session id and status to the return URL.
            // They are useful only to confirm that the hosted flow returned;
            // the signed webhook remains authoritative. Remove both values
            // before any referrer, analytics request or authentication return
            // can retain a provider identifier.
            let certificationReturn = false;
            let certificationStartedAt = 0;
            try {
                const stored = sessionStorage.getItem(
                    NORVA_PARTNERS_KYC_CERTIFICATION_SESSION_KEY
                );
                certificationStartedAt = /^\d{13}$/.test(stored || '')
                    ? Number(stored)
                    : 0;
                certificationReturn = Number.isSafeInteger(certificationStartedAt)
                    && certificationStartedAt <= Date.now()
                    && Date.now() - certificationStartedAt
                        <= NORVA_PARTNERS_KYC_CERTIFICATION_RETURN_TTL_MS;
                if (stored && !certificationReturn) {
                    sessionStorage.removeItem(
                        NORVA_PARTNERS_KYC_CERTIFICATION_SESSION_KEY
                    );
                }
            } catch (_) { /* private mode may deny sessionStorage */ }

            // The public callback deliberately strips every provider query
            // parameter before redirecting through a static hash-only marker.
            // The marker carries no decision or provider identifier. A same-tab,
            // timestamp-only marker remains the sole safe way to distinguish an
            // Admin certification return from an ordinary member KYC return.
            const sanitizedCertificationReturn = !hasSensitiveDiditParams
                && certificationReturn
                && (sanitizedBoundaryReturn || url.hash === '#partners');
            if (!hasSensitiveDiditParams
                && !sanitizedBoundaryReturn
                && !sanitizedCertificationReturn) {
                return null;
            }

            url.searchParams.delete('verificationSessionId');
            url.searchParams.delete('status');
            if (validProviderReturn
                || sanitizedBoundaryReturn
                || sanitizedCertificationReturn) {
                url.hash = certificationReturn ? '#admin/partners' : '#partners';
            }
            window.history.replaceState(
                window.history.state,
                '',
                `${url.pathname}${url.search}${url.hash}`
            );
            if (!validProviderReturn
                && !sanitizedBoundaryReturn
                && !sanitizedCertificationReturn) return null;
            if (certificationReturn) {
                try {
                    sessionStorage.removeItem(
                        NORVA_PARTNERS_KYC_CERTIFICATION_SESSION_KEY
                    );
                } catch (_) { /* private mode may deny sessionStorage */ }
            }
            return {
                capturedAt: Date.now(),
                kind: certificationReturn ? 'certification' : 'member'
            };
        } catch (_) {
            return null;
        }
    }

    consumePartnersKycReturnNotice() {
        const returned = this._partnersKycReturn;
        if (returned?.kind === 'certification') return false;
        this._partnersKycReturn = null;
        return Boolean(
            returned
            && Number.isSafeInteger(returned.capturedAt)
            && Date.now() - returned.capturedAt < 15 * 60 * 1000
        );
    }

    consumePartnersKycCertificationReturnNotice() {
        const returned = this._partnersKycReturn;
        if (returned?.kind !== 'certification') return false;
        this._partnersKycReturn = null;
        return Boolean(
            Number.isSafeInteger(returned.capturedAt)
            && Date.now() - returned.capturedAt < 15 * 60 * 1000
        );
    }

    capturePartnersTvRelay() {
        const safeRecord = (value) => {
            if (!value || typeof value !== 'object') return null;
            const relayToken = String(value.relayToken || '');
            const idempotencyKey = String(value.idempotencyKey || '');
            const capturedAt = Number(value.capturedAt);
            if (!NORVA_PARTNERS_TV_RELAY_PATTERN.test(relayToken)
                || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)
                || !Number.isSafeInteger(capturedAt)
                || capturedAt > Date.now() + 60_000
                || Date.now() - capturedAt > NORVA_PARTNERS_TV_RELAY_CLIENT_TTL_MS) {
                return null;
            }
            return { relayToken, idempotencyKey, capturedAt };
        };
        const readStored = () => {
            try {
                const record = safeRecord(JSON.parse(
                    sessionStorage.getItem(NORVA_PARTNERS_TV_RELAY_SESSION_KEY) || 'null'
                ));
                if (!record) sessionStorage.removeItem(NORVA_PARTNERS_TV_RELAY_SESSION_KEY);
                return record;
            } catch (_) {
                try { sessionStorage.removeItem(NORVA_PARTNERS_TV_RELAY_SESSION_KEY); } catch (_) { /* noop */ }
                return null;
            }
        };

        let relayToken = '';
        try {
            const match = String(window.location.hash || '').match(/^#relay=(.+)$/);
            if (match) relayToken = decodeURIComponent(match[1]);
        } catch (_) { relayToken = ''; }
        if (!NORVA_PARTNERS_TV_RELAY_PATTERN.test(relayToken)) return readStored();

        let idempotencyKey = '';
        try {
            idempotencyKey = `norva.tv-relay.${crypto.randomUUID()}`;
        } catch (_) {
            const bytes = new Uint8Array(18);
            crypto.getRandomValues(bytes);
            idempotencyKey = `norva.tv-relay.${
                Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
            }`;
        }
        const record = { relayToken, idempotencyKey, capturedAt: Date.now() };
        try {
            sessionStorage.setItem(
                NORVA_PARTNERS_TV_RELAY_SESSION_KEY,
                JSON.stringify(record)
            );
        } catch (_) { /* the in-memory copy still works for an existing session */ }

        // The bearer-like relay lives in a URL fragment so it is never sent in
        // HTTP requests or Referer headers. Scrub it before an authentication
        // redirect can copy it into a returnTo query string or an access log.
        try {
            window.history.replaceState(
                window.history.state,
                '',
                `${window.location.pathname}${window.location.search}#partners`
            );
        } catch (_) { /* best-effort; never echo the token elsewhere */ }
        return record;
    }

    clearPendingPartnersTvRelay() {
        this._pendingPartnersTvRelay = null;
        try { sessionStorage.removeItem(NORVA_PARTNERS_TV_RELAY_SESSION_KEY); } catch (_) { /* noop */ }
    }

    async consumePendingPartnersTvRelay() {
        if (this._partnersTvRelayInFlight
            || !this._pendingPartnersTvRelay
            || !this.currentUser?.cloud
            || this.currentUser?.device
            || typeof window.NorvaCloud?.partners?.consumeTvRelay !== 'function') return false;
        const pending = this._pendingPartnersTvRelay;
        this._partnersTvRelayInFlight = true;
        try {
            await window.NorvaCloud.partners.consumeTvRelay({
                relayToken: pending.relayToken,
                idempotencyKey: pending.idempotencyKey
            });
            this.clearPendingPartnersTvRelay();
            window.NorvaModal?.toast?.(
                'TV hand-off confirmed. Norva Partners is open securely on this device.',
                'success'
            );
            return true;
        } catch (error) {
            const terminal = new Set([
                'tv_relay_not_found',
                'partners_action_not_allowed',
                'invalid_request',
                'partners_tv_relay_invalid'
            ]);
            if (terminal.has(error?.code)) {
                this.clearPendingPartnersTvRelay();
                window.NorvaModal?.toast?.(
                    'This TV hand-off expired. Start a new one from the TV.',
                    'warning'
                );
            }
            // Transient failures retain the same token and idempotency key in
            // sessionStorage. A reload resumes the one authoritative consume.
            return false;
        } finally {
            this._partnersTvRelayInFlight = false;
        }
    }

    readNativeContinuity() {
        if (!this._nativeRecovery) return null;
        try {
            const parsed = JSON.parse(localStorage.getItem(NORVA_NATIVE_CONTINUITY_KEY) || 'null');
            if (!parsed || Date.now() - Number(parsed.updatedAt || 0) > NORVA_NATIVE_CONTINUITY_TTL_MS) {
                return null;
            }
            const allowed = new Set(
                this.navigation?.model?.continuityPageNames?.() || ['home']
            );
            const page = allowed.has(parsed.page) ? parsed.page : 'home';
            const boundedScrollMap = (value) => Object.fromEntries(
                Object.entries(value && typeof value === 'object' ? value : {})
                    .filter(([key]) => allowed.has(key))
                    .map(([key, top]) => [
                        key,
                        Math.max(0, Math.min(10_000_000, Math.floor(Number(top) || 0)))
                    ])
            );
            return {
                page,
                pageScroll: boundedScrollMap(parsed.pageScroll),
                gridScroll: boundedScrollMap(parsed.gridScroll),
                updatedAt: Number(parsed.updatedAt) || 0,
            };
        } catch (_) {
            return null;
        }
    }

    persistNativeContinuity() {
        if (!this.isNativePhoneShell()) return;
        try {
            const allowed = new Set(
                this.navigation?.model?.continuityPageNames?.() || ['home']
            );
            const page = allowed.has(this.currentPage) ? this.currentPage : 'home';
            const currentPage = this.getPageScrollElement(page);
            this._pageScroll = this._pageScroll || {};
            if (currentPage) this._pageScroll[page] = currentPage.scrollTop || 0;
            const bounded = (value) => Math.max(
                0,
                Math.min(10_000_000, Math.floor(Number(value) || 0))
            );
            const pageScroll = {};
            const gridScroll = {};
            for (const key of allowed) {
                if (this._pageScroll[key] != null) pageScroll[key] = bounded(this._pageScroll[key]);
                const container = this.pages?.[key]?.container;
                if (container) gridScroll[key] = bounded(container.scrollTop);
            }
            const snapshot = { page, pageScroll, gridScroll, updatedAt: Date.now() };
            localStorage.setItem(NORVA_NATIVE_CONTINUITY_KEY, JSON.stringify(snapshot));
            this._nativeContinuity = snapshot;
        } catch (_) {
            // Private/low-storage mode remains usable; continuity is best-effort.
        }
    }

    getPageScrollElement(pageName) {
        const ownedScroller = this.pages?.[pageName]?.getScrollElement?.();
        return ownedScroller || document.getElementById(`page-${pageName}`);
    }

    restorePageScroll(pageName, top = 0) {
        const boundedTop = Math.max(
            0,
            Math.min(10_000_000, Math.floor(Number(top) || 0))
        );
        if (boundedTop <= 0) return;
        const restore = () => {
            const element = this.getPageScrollElement(pageName);
            if (this.currentPage === pageName
                && element
                && element.scrollHeight > boundedTop
                && Math.abs(element.scrollTop - boundedTop) > 4) {
                element.scrollTop = boundedTop;
            }
        };
        requestAnimationFrame(restore);
        window.setTimeout(restore, 350);
    }

    installNativeContinuityListeners() {
        if (!this.isNativePhoneShell() || this._nativeContinuityListenersInstalled) return;
        this._nativeContinuityListenersInstalled = true;
        let scheduled = false;
        const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                this.persistNativeContinuity();
            });
        };
        document.querySelectorAll('.page').forEach((page) => {
            page.addEventListener('scroll', schedule, { passive: true });
        });
        for (const pageName of ['movies', 'series']) {
            this.pages?.[pageName]?.container?.addEventListener('scroll', schedule, { passive: true });
        }
        window.addEventListener('pagehide', () => this.persistNativeContinuity());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.persistNativeContinuity();
        });
    }

    restoreNativeGridScroll(pageName) {
        if (!this._nativeRecovery || !['movies', 'series'].includes(pageName)) return;
        const top = Number(this._nativeContinuity?.gridScroll?.[pageName]) || 0;
        if (top <= 0) return;
        const restore = () => {
            const container = this.pages?.[pageName]?.container;
            if (this.currentPage === pageName && container
                    && container.scrollHeight > top
                    && Math.abs(container.scrollTop - top) > 4) {
                container.scrollTop = top;
            }
        };
        requestAnimationFrame(restore);
        window.setTimeout(restore, 350);
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

    isTvMode() {
        return document.documentElement.classList.contains('tv-mode');
    }

    setTvLaunchPhase(title, detail) {
        if (!this.isTvMode()) return;
        const splash = document.getElementById('tv-launch-screen');
        if (!splash) return;
        const heading = splash.querySelector('h1');
        const copy = splash.querySelector('.tv-launch-copy p:not(.tv-launch-kicker)');
        if (heading && title) heading.textContent = title;
        if (copy && detail) copy.textContent = detail;
    }

    /**
     * Keep every TV route visually deterministic while its controller prepares.
     * The layer is intentionally non-interactive: D-pad ownership stays with the
     * destination page and the skeleton disappears as soon as show() settles.
     */
    beginTvRouteTransition(pageName) {
        if (!this.isTvMode() || pageName === 'watch') return 0;
        const main = document.querySelector('.main-content');
        if (!main) return 0;

        const transition = this.navigation?.model?.transitionFor?.(pageName);
        const title = transition?.title || 'Opening Norva';
        const detail = transition?.detail || 'Preparing this screen.';
        let stage = document.getElementById('tv-route-stage');
        if (!stage) {
            stage = document.createElement('div');
            stage.id = 'tv-route-stage';
            stage.className = 'tv-route-stage';
            stage.setAttribute('role', 'status');
            stage.setAttribute('aria-live', 'polite');
            stage.setAttribute('aria-atomic', 'true');
            main.appendChild(stage);
        }

        const token = (this._tvRouteToken || 0) + 1;
        this._tvRouteToken = token;
        this._tvRouteStartedAt = performance.now();
        clearTimeout(this._tvRouteFailsafe);
        stage.dataset.page = pageName;
        stage.innerHTML = `
            <div class="tv-route-stage-copy">
                <span class="tv-route-stage-kicker">Norva TV</span>
                <strong>${title}</strong>
                <span>${detail}</span>
            </div>
            <div class="tv-route-stage-rails" aria-hidden="true">
                <span class="tv-route-stage-hero"></span>
                <span class="tv-route-stage-line"></span>
                <span class="tv-route-stage-cards">${'<i></i>'.repeat(6)}</span>
                <span class="tv-route-stage-line is-short"></span>
                <span class="tv-route-stage-cards">${'<i></i>'.repeat(6)}</span>
            </div>`;
        stage.hidden = false;
        stage.classList.remove('is-leaving');
        main.setAttribute('aria-busy', 'true');
        requestAnimationFrame(() => stage.classList.add('is-visible'));
        // A page with a stalled request must still hand control back. Its own
        // explicit loading/error state remains underneath this short transition.
        this._tvRouteFailsafe = window.setTimeout(() => this.endTvRouteTransition(token), 6500);
        return token;
    }

    endTvRouteTransition(token) {
        if (!token || token !== this._tvRouteToken) return;
        const stage = document.getElementById('tv-route-stage');
        if (!stage || stage.hidden) return;
        const elapsed = performance.now() - (this._tvRouteStartedAt || 0);
        const finish = () => {
            if (token !== this._tvRouteToken) return;
            clearTimeout(this._tvRouteFailsafe);
            stage.classList.add('is-leaving');
            stage.classList.remove('is-visible');
            document.querySelector('.main-content')?.removeAttribute('aria-busy');
            window.setTimeout(() => {
                if (token === this._tvRouteToken) stage.hidden = true;
            }, 220);
        };
        window.setTimeout(finish, Math.max(0, 360 - elapsed));
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
        this.setTvLaunchPhase('Connecting your screen', 'Checking your secure Norva session.');
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
        this.setTvLaunchPhase('Checking your access', 'Keeping your paired screen and catalogue in sync.');
        window.NorvaTrace?.log?.('checkCloudAccess() — entitlements (served from boot cache if seeded)');
        if (!await this.checkCloudAccess()) return;
        window.NorvaTrace?.log?.('checkCloudAccess() done');
        // A scanned Partners TV relay is consumed only after both Auth and the
        // account entitlement gate succeed. It stays non-blocking so a transient
        // relay outage can never delay the catalogue or profile picker.
        void this.consumePendingPartnersTvRelay();
        // Keep the premium launch surface UNDER the profile overlay. The overlay has a
        // deliberately higher z-index, so it stays interactive, while dismissing it can
        // never expose the empty app shell that used to sit between profile and Home.
        this.setTvLaunchPhase('Choose your profile', 'Your personal picks and progress are ready.');
        const launchParams = new URLSearchParams(window.location.search);
        const rendererRecovery = /NorvaTV-AndroidTV/i.test(navigator.userAgent || '')
            && launchParams.get('_rendererRecovery') === '1';
        const continuityRecovery = rendererRecovery || this._nativeRecovery;
        if (!this._profileGateComplete) {
            try {
                if (window.NorvaProfiles?.ensureSelected) {
                    await window.NorvaProfiles.ensureSelected({ resumeActive: continuityRecovery });
                }
            } catch (_) { }
            this._profileGateComplete = true;
        }

        // Home is the overwhelmingly common cold-start destination. Start its
        // cache paint and catalogue reads as soon as the active profile is known,
        // while the remaining shell/avatar wiring finishes. navigateTo('home')
        // below reuses HomePage's in-flight promise, so this never duplicates a
        // request. Deep links and native continuity to another page stay untouched.
        const warmHashKey = window.location.hash.slice(1).split('/')[0];
        const warmPersistedPage = this._nativeRecovery
            && this._nativeContinuity
            && (this._nativeContinuity.page in this.pages)
            ? this._nativeContinuity.page
            : '';
        const shouldPrimeHome = (!warmHashKey || warmHashKey === 'home')
            && (!warmPersistedPage || warmPersistedPage === 'home');
        if (shouldPrimeHome) {
            Promise.resolve(this.pages.home?.show?.())
                .catch((error) => console.warn('[App] Early Home preparation failed:', error));
        }
        if (continuityRecovery) {
            try {
                const cleanUrl = new URL(window.location.href);
                cleanUrl.searchParams.delete('_rendererRecovery');
                cleanUrl.searchParams.delete('_nativeRecovery');
                window.history.replaceState(
                    window.history.state,
                    '',
                    cleanUrl.pathname + cleanUrl.search + cleanUrl.hash
                );
            } catch (_) { /* recovery marker cleanup is best-effort */ }
        }
        // Surface the navbar identity control (account menu on Web, direct
        // profile switcher on TV; phone uses the Profile bottom tab).
        try { if (window.NorvaProfiles?.refreshNavAvatar) await window.NorvaProfiles.refreshNavAvatar(); } catch (_) { }
        window.NorvaTrace?.log?.('app shell ready — profile picked, router/page renders next. NorvaTrace.summary() for the full table.');
        this.applyCatalogAvailability(null);
        this.startCloudWarmKeep();
        this.startSessionKeepFresh();
        this.startEnrichmentProgressPoll();
        if (this.currentUser && !this.currentUser.device) this.registerPushToken(); // native FCM token (Android wrapper only; no-op in browser)

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

        // Navigation policy and projection stay in the shared model. App owns
        // only the route/action effects that need page controllers or bridges.
        this.navigation?.bind((intent) => this.handleNavigationIntent(intent));

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

        this.initDesktopCatalogFilters();
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
            if (page === 'settings') {
                const stateTab = window.NorvaSettingsNavigation?.normalizeTab?.(e.state?.settingsTab) || '';
                const hashTab = window.NorvaSettingsNavigation?.tabFromHash?.(window.location.hash) || '';
                this._settingsSubRoute = stateTab || hashTab;
            }
            if (this.currentPage === page) {
                // Settings tabs replace (rather than push) their route. If a host
                // browser restores such an entry in place, reflect it immediately
                // without creating a duplicate Back step.
                if (page === 'settings' && this._settingsSubRoute) {
                    const settingsTab = this._settingsSubRoute;
                    this._settingsSubRoute = '';
                    this.pages.settings?.switchTab?.(settingsTab);
                }
                return; // already showing it; idx synced
            }
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
        // Preserve an allow-listed Settings section before navigateTo normalizes
        // the URL. SettingsPage restores the canonical section hash after paint.
        this._settingsSubRoute = hashKey === 'settings'
            ? (window.NorvaSettingsNavigation?.tabFromHash?.(window.location.hash) || '')
            : '';
        // Stash the admin sub-route BEFORE navigateTo rewrites the hash to "#admin" —
        // AdminPage.show() consumes it to restore the exact CRM view (fiche, ticket…).
        this._adminSubRoute = hashKey === 'admin' ? hash.slice('admin/'.length) : '';
        // Fiche deep link (subtitle-ready emails, bell entries): #movies/open:… or #series/open:…
        // — stashed the same way, consumed by openFicheFromRoute after the page has landed.
        this._openFicheRoute = ((hashKey === 'movies' || hashKey === 'series') && hash.slice(hashKey.length + 1).startsWith('open:'))
            ? hash.slice(hashKey.length + 1) : '';
        // `in` (not truthiness): lazy pages register as null until loaded (this.pages.admin),
        // which used to send a refresh on #admin back to home.
        const persistedPage = this._nativeRecovery
            && this._nativeContinuity
            && (this._nativeContinuity.page in this.pages)
            ? this._nativeContinuity.page
            : '';
        const requestedInitialPage = hashKey && (hashKey in this.pages)
            ? ((hashKey === 'home' && persistedPage && persistedPage !== 'home')
                ? persistedPage
                : hashKey)
            : (persistedPage || 'home');
        if (requestedInitialPage !== 'home') await healthReady;
        const initialPage = this.guardCatalogPage(requestedInitialPage);
        // Capture any fiche open before a refresh BEFORE navigating (applyPage may clear
        // the stash), then re-open it once we've landed on its catalogue page.
        const pendingFiche = this.readOpenFiche();
        this.navigateTo(initialPage, true); // true = replace history (don't add)
        this.restoreOpenFiche(initialPage, pendingFiche);
        this.openFicheFromRoute(initialPage);
        requestAnimationFrame(() => this.consumePendingPairCode());
        requestAnimationFrame(() => this.refreshProviderAccessNotifications());
        // The destination controller has synchronously painted either real content or
        // its route skeleton by now. Fade the launch surface only at this point.
        requestAnimationFrame(() => this.finishTvLaunchScreen());

        // Defer the trial / billing nudges AND the region prompt until source
        // health is known. None of them belong on the pre-catalog onboarding
        // screen ("Connect your TV service"), where they collide with each other
        // in the bottom-of-screen zone and bury the single action that matters.
        // Once health resolves we show them only when a source is connected.
        healthReady.then(() => {
            this.maybeShowTrialBanner();
            // Render one billing warning only, after onboarding/source health has
            // settled. checkCloudAccess used to create another warning earlier.
            this._maybeShowBillingAlert(this.entitlement || window.NorvaEntitlement);
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

    handleNavigationIntent(intent) {
        if (!intent) return false;
        if (intent.kind === 'route') {
            this.navigateTo(intent.target);
            return true;
        }
        if (intent.kind !== 'action') return false;
        if (intent.target === 'search') {
            this.openSearch();
            return true;
        }
        if (intent.target === 'account') {
            this.openAccountSheet();
            return true;
        }
        if (intent.target === 'downloads') {
            try { window.NorvaTVCloud?.openDownloads?.(); } catch (_) { /* no bridge */ }
            return true;
        }
        if (intent.target === 'logout') {
            void this.signOut();
            return true;
        }
        return false;
    }

    /**
     * Refresh-on-open: silently re-sync providers that are older than the user's
     * chosen interval. Single-flight (skips anything already syncing), background
     * (never blocks the UI), and a no-op server-side when the catalogue is
     * unchanged. The visible "Keep up to date" toggle lives in TV Service.
     */
    async maybeAutoRefreshSources() {
        if (!window.API?.sources?.getAll) return;

        // Cloud refreshes are owned by the durable, fair server scheduler. A
        // browser-open fan-out used to start every stale provider at once,
        // racing catalog visibility epochs and repeatedly retrying sources that
        // already required user action (for example a rejected login). Local
        // libraries have no server scheduler, so they keep the legacy behavior.
        if (window.API.isCloudMode?.() === true) {
            try { this.refreshSourceHealth?.(); } catch (_) { /* noop */ }
            await this.surfaceWhatsNew();
            return;
        }

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
        if (open) {
            if (this._closeNotifications) this._closeNotifications();
            else open.remove();
            document.getElementById('nav-bell')?.setAttribute('aria-expanded', 'false');
            return;
        }
        const bell = document.getElementById('nav-bell');
        const tv = this.isTvMode();
        const panel = document.createElement('div');
        panel.id = 'norva-notif-panel';
        const surface = tv ? document.createElement('section') : panel;
        if (tv) {
            // `modal-overlay active` is an intentional contract with tvNavigation:
            // arrows stay inside this panel and hardware Back clicks `.modal-close`.
            panel.className = 'modal-overlay active norva-notif-tv-overlay';
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-modal', 'true');
            panel.dataset.restoreFocus = 'nav-bell';
            surface.className = 'norva-notif-panel norva-notif-tv-surface';
            panel.appendChild(surface);
        } else {
            panel.className = 'norva-notif-panel';
            panel.setAttribute('role', 'dialog');
        }
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
                    <span class="norva-notif-kind">Support</span>
                    <div class="norva-notif-summary">${esc(e.summary || 'Support replied')}</div>
                    <div class="norva-notif-time">${esc(timeAgo(e.created_at))} · Open conversation</div>
                </a>`
            : watchRoute(e)
                ? `<a class="norva-notif-item${e.seen_at ? '' : ' unread'}" href="/app.html#${esc(watchRoute(e))}" data-watch="${esc(watchRoute(e))}">
                    <span class="norva-notif-kind">New</span>
                    <div class="norva-notif-summary">${esc(e.summary || 'New content')}</div>
                    <div class="norva-notif-time">${esc(timeAgo(e.created_at))} · View details</div>
                </a>`
                : `<div class="norva-notif-item${e.seen_at ? '' : ' unread'}" role="article" tabindex="0">
                    <span class="norva-notif-kind">Update</span>
                    <div class="norva-notif-summary">${esc(e.summary || 'New content')}</div>
                    <div class="norva-notif-time">${esc(timeAgo(e.created_at))}</div>
                </div>`;
        surface.innerHTML = `
            <div class="norva-notif-head">
                <div class="norva-notif-heading">
                    <strong>Notifications</strong>
                    <span>${events.length ? `${events.length} recent update${events.length === 1 ? '' : 's'}` : 'You are all caught up'}</span>
                </div>
                <button type="button" class="norva-notif-close modal-close" data-notif-close>Close</button>
            </div>
            <div class="norva-notif-list">
                ${events.length ? events.map(item).join('') : `
                    <div class="norva-notif-empty">
                        <strong>Nothing new right now</strong>
                        <span>Support replies and catalogue updates will appear here.</span>
                    </div>`}
            </div>`;
        document.body.appendChild(panel);
        let closed = false;
        const closePanel = ({ restoreFocus = true } = {}) => {
            if (closed) return;
            closed = true;
            panel.remove();
            bell?.setAttribute('aria-expanded', 'false');
            document.removeEventListener('click', closeOnOutside, true);
            document.removeEventListener('keydown', closeOnOutside, true);
            this._closeNotifications = null;
            if (restoreFocus && bell?.isConnected) {
                requestAnimationFrame(() => {
                    try { bell.focus({ preventScroll: true }); } catch (_) { bell.focus?.(); }
                });
            }
        };
        this._closeNotifications = closePanel;
        surface.querySelector('[data-notif-close]')?.addEventListener('click', () => closePanel());
        // Watch deep links navigate IN-APP (a hash-only href would not reload the SPA): route to
        // the catalogue page and reuse the same openFicheFromRoute the boot deep link goes through.
        surface.querySelectorAll('[data-watch]').forEach((a) => a.addEventListener('click', (ev) => {
            ev.preventDefault();
            const w = a.getAttribute('data-watch') || '';
            const page = w.split('/')[0];
            if (!this.pages?.[page]) return;
            this._openFicheRoute = w.slice(page.length + 1);
            closePanel({ restoreFocus: false });
            this.navigateTo(page);
            this.openFicheFromRoute(page);
        }));
        // Desktop/web remains a compact anchored popover. TV uses the viewport-safe
        // overlay CSS instead, because its bell sits at the bottom of the left rail.
        if (!tv) {
            try {
                const r = bell.getBoundingClientRect();
                const maxTop = Math.max(16, window.innerHeight - panel.offsetHeight - 16);
                panel.style.top = `${Math.max(16, Math.min(Math.round(r.bottom + 8), maxTop))}px`;
                panel.style.right = `${Math.max(16, Math.round(window.innerWidth - r.right))}px`;
            } catch (_) { /* default CSS position */ }
        }
        bell?.setAttribute('aria-expanded', 'true');
        // Focus is moved into the panel after layout. Combined with the TV modal scope
        // above, no D-pad move can leak behind it; close always restores the bell.
        requestAnimationFrame(() => {
            const first = surface.querySelector('a.norva-notif-item, .norva-notif-item[tabindex="0"], [data-notif-close]');
            try { first?.focus({ preventScroll: true }); } catch (_) { first?.focus?.(); }
        });
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
        // Dismiss on outside click / Escape. Tab is explicitly trapped for keyboard
        // parity; D-pad confinement comes from the modal scope above.
        const closeOnOutside = (ev) => {
            if (ev.type === 'keydown' && ev.key === 'Tab') {
                const focusable = [...surface.querySelectorAll('a[href], button:not([disabled]), [tabindex="0"]')]
                    .filter(el => el.offsetParent || el.getClientRects().length);
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (ev.shiftKey && document.activeElement === first) {
                    ev.preventDefault();
                    last.focus();
                } else if (!ev.shiftKey && document.activeElement === last) {
                    ev.preventDefault();
                    first.focus();
                }
                return;
            }
            if (ev.type === 'keydown' && ev.key !== 'Escape') return;
            if (ev.type === 'click' && (surface.contains(ev.target) || bell?.contains(ev.target))) return;
            closePanel();
        };
        setTimeout(() => {
            document.addEventListener('click', closeOnOutside, true);
            document.addEventListener('keydown', closeOnOutside, true);
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
        // only until the first open. A public install link earns the nudge;
        // availability alone does not create a dead-end notification.
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
                            : `<span class="norva-device-soon">${a.available ? 'Available now' : 'Unavailable'}</span>`}
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

            if (redirectIfBlocked && summary?.state !== 'unknown' && !summary?.error &&
                this.isCatalogPage(this.currentPage) && !this.catalogCategoryAvailable(this.currentPage, summary)) {
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
                        try { this.sourceManager?.toast?.(`${s.name || s.display_name || 'Your catalog'} is ready to watch!`, 'success'); } catch (_) { /* noop */ }
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
    // (window.NorvaTVCloud.getPushToken) and register it with the backend so marketing pushes and
    // the import digest can reach this device when the app is closed. No-op in a plain browser
    // (no bridge). Best-effort, but OBSERVABLE: the outcome lands in NorvaTrace + localStorage
    // ('norva-push-reg') — the historical bug (route jamais mappée dans CloudAdapter) est resté
    // invisible un mois précisément parce que tout était avalé en silence. Chemin DIRECT
    // NorvaCloud.push.register (pas API.request). Re-tenté au retour au premier plan : au premier
    // lancement, le token FCM peut mettre plus de temps que la fenêtre de retry du boot.
    async registerPushToken() {
        const note = (status, detail) => {
            try { localStorage.setItem('norva-push-reg', JSON.stringify({ status, detail: detail || '', at: new Date().toISOString() })); } catch (_) { /* plein/privé */ }
            window.NorvaTrace?.log?.('push-token', status + (detail ? ' — ' + detail : ''));
        };
        try {
            const bridge = window.NorvaTVCloud;
            if (!bridge || typeof bridge.getPushToken !== 'function') return; // navigateur / TV sans FCM
            if (!this._pushFgRetryWired) {
                this._pushFgRetryWired = true;
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible' && this.currentUser && !this.currentUser.device) this.registerPushToken();
                });
            }
            let token = '';
            for (let i = 0; i < 10 && !token; i++) {                // FCM token may not be ready at first launch
                try { token = String(bridge.getPushToken() || ''); } catch (_) { token = ''; }
                if (!token) await new Promise((r) => setTimeout(r, 2000));
            }
            if (!token) { note('no-token', 'FCM token absent après ~20 s (Firebase non initialisé dans ce build ?)'); return; }
            if (this._lastPushToken === token) return;              // déjà enregistré cette session
            await window.NorvaCloud.push.register(token, 'android');
            this._lastPushToken = token;
            note('registered', token.slice(0, 12) + '…');
        } catch (e) {
            note('error', e && e.message ? e.message : String(e));
        }
    }

    isCatalogPage(pageName) {
        return Boolean(this.navigation?.model?.isCatalogPage?.(pageName));
    }

    isCatalogReady(summary = this.sourceHealthSummary) {
        if (!summary) return false;
        const policy = window.NorvaSourceHealth?.catalogAvailability?.(summary);
        if (policy) return policy.catalogReady === true;
        return summary.state === 'ready' || Boolean(summary.ready?.length);
    }

    guardCatalogPage(pageName) {
        if (!this.isCatalogPage(pageName)) return pageName;
        // The shared policy only unlocks catalog routes after the server has marked
        // the initial materialized catalog usable; discovery counts alone are unsafe.
        return (this.isCatalogReady() || this.catalogCategoryAvailable(pageName)) ? pageName : 'home';
    }

    // Shared category decision. Today the server's `usable` threshold unlocks the
    // three catalog destinations together; this adapter keeps callers category-aware
    // without duplicating progress or count heuristics.
    catalogCategoryAvailable(category, summary = this.sourceHealthSummary) {
        const sharedDecision = window.NorvaSourceHealth?.isCatalogCategoryAvailable?.(summary, category);
        if (typeof sharedDecision === 'boolean') return sharedDecision;
        if (this.isCatalogReady(summary)) return true;
        return false;
    }

    applyCatalogAvailability(summary = this.sourceHealthSummary) {
        // A transient/unknown summary (a temporary /sources hiccup that loadSummary maps to
        // state='unknown') must NEVER hide already-visible catalog tabs — otherwise a network blip
        // makes Live/Movies/Series vanish under an onboarded user. Keep the last-known-good tab
        // visibility until a real summary (ready / syncing / not_configured) arrives.
        if (summary && (summary.state === 'unknown' || summary.error)) return;
        const ready = this.isCatalogReady(summary);
        // Every navigation adapter receives the same shared gate decision.
        const anyShown = this.navigation?.setCatalogAvailability((pageName) => (
            ready || this.catalogCategoryAvailable(pageName, summary)
        )) || false;
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
                if (user?.id) await this.refreshProviderAccessRollout();
                if (user?.id) this.claimPendingPartnerReferral();
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
                    this.navigation?.setVisible('admin', true);
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
                    if (cachedUser?.id) await this.refreshProviderAccessRollout();
                    if (cachedUser?.id) this.claimPendingPartnerReferral();
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
                this.navigation?.setVisible('settings', false);
            }

            // Add logout button to navbar
            this.addLogoutButton();

        } catch (err) {
            console.error('Authentication error:', err);
            localStorage.removeItem('authToken');
            window.location.replace('/login.html');
        }
    }

    claimPendingPartnerReferral() {
        if (this._partnersReferralClaimAttempted
            || this.currentUser?.device
            || typeof window.NorvaCloud?.partners?.claimReferral !== 'function') return;
        this._partnersReferralClaimAttempted = true;
        // The browser never reads the HttpOnly referral cookie. The same-origin
        // endpoint owns cookie consumption and forwards only the authenticated
        // claim to the account-scoped Edge Function. Attribution must not block
        // app boot; transient outcomes deliberately keep the cookie for a later
        // page load.
        Promise.resolve(window.NorvaCloud.partners.claimReferral())
            .then((result) => {
                if (result?.state === 'attributed') {
                    window.NorvaModal?.toast?.(
                        'Referral attribution saved to your Norva account.',
                        'success'
                    );
                }
                if (result?.state === 'temporarily_unavailable'
                    || result?.state === 'authentication_required') {
                    this._partnersReferralClaimAttempted = false;
                }
            })
            .catch(() => {
                this._partnersReferralClaimAttempted = false;
            });
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

    // Bandeau « paiement en échec » en tête de l'app : visible mais non bloquant,
    // affiché pendant la fenêtre de grâce (past_due/grace, accès maintenu). CTA
    // selon le rail : web → gestion d'abonnement Norva ; Play → Google Play
    // (politique Play : jamais de lien de paiement web dans l'app) ; TV → texte
    // seul (le paiement se règle sur téléphone/web). Fermable pour la session —
    // il revient à la prochaine ouverture tant que le paiement n'est pas réglé.
    _maybeShowBillingAlert(decision) {
        try {
            const status = String(decision?.status || decision?.projection?.status || '').toLowerCase();
            const provider = String(decision?.projection?.provider || '').toLowerCase();
            // Included access never belongs to a billable rail. Keep this guard in
            // addition to the database invariant so stale cached state cannot show
            // a payment action to a system/manual account.
            const includedProvider = provider === 'system' || provider === 'manual';
            const inGrace = !includedProvider && (decision?.reason === 'billing_grace' || status === 'past_due' || status === 'grace');
            const existing = document.getElementById('norva-billing-alert');
            if (!inGrace) { if (existing) existing.remove(); return; }
            if (existing || sessionStorage.getItem('norva-billing-alert-dismissed') === '1') return;
            if (!document.getElementById('norva-billing-alert-css')) {
                const st = document.createElement('style');
                st.id = 'norva-billing-alert-css';
                st.textContent = '#norva-billing-alert{position:relative;z-index:120;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;padding:9px 44px 9px 16px;background:linear-gradient(90deg,rgba(251,191,36,.14),rgba(251,146,60,.12));border-bottom:1px solid rgba(251,191,36,.35);color:#fde8b0;font-size:13.5px;line-height:1.45;}'
                    + '#norva-billing-alert a{color:#fff;font-weight:700;text-decoration:none;border-bottom:1px solid rgba(255,255,255,.45);}'
                    + '#norva-billing-alert .nba-x{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:0;color:#fde8b0;font-size:14px;cursor:pointer;padding:4px 6px;}';
                document.head.appendChild(st);
            }
            const bar = document.createElement('div');
            bar.id = 'norva-billing-alert';
            bar.setAttribute('role', 'status');
            const msg = document.createElement('span');
            msg.textContent = "⚠️ Your last payment didn't go through — your access stays on for a few days while it's sorted out.";
            bar.appendChild(msg);
            const isTv = /NorvaTV-AndroidTV/i.test(navigator.userAgent || '');
            if (isTv) {
                const hint = document.createElement('span');
                hint.textContent = 'Update your payment on norva.tv or in the Norva phone app.';
                bar.appendChild(hint);
            } else {
                const a = document.createElement('a');
                if (provider === 'google_play') {
                    a.href = 'https://play.google.com/store/account/subscriptions';
                    a.target = '_blank'; a.rel = 'noopener';
                    a.textContent = 'Fix it on Google Play →';
                } else if (provider === 'apple_app_store') {
                    a.href = 'https://apps.apple.com/account/subscriptions';
                    a.target = '_blank'; a.rel = 'noopener';
                    a.textContent = 'Fix it on the App Store';
                } else {
                    a.href = '/subscription.html?returnTo=' + encodeURIComponent('/app#home');
                    a.textContent = 'Update payment →';
                }
                bar.appendChild(a);
            }
            const x = document.createElement('button');
            x.type = 'button';
            x.className = 'nba-x';
            x.setAttribute('aria-label', 'Dismiss');
            x.textContent = '✕';
            x.addEventListener('click', () => {
                try { sessionStorage.setItem('norva-billing-alert-dismissed', '1'); } catch (_) { /* privé */ }
                bar.remove();
            });
            bar.appendChild(x);
            document.body.prepend(bar);
        } catch (_) { /* l'alerte ne doit jamais casser le boot */ }
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
    // and automatic conversion into the plan already selected. A dimmed backdrop keeps it the only thing on
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
            const managePlanHref = '/subscription.html?returnTo=' + encodeURIComponent(here);
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
                '<p style="color:#aeb8cc;margin:0 0 20px">Your selected plan starts and renews automatically when the trial ends unless you cancel before then. You can manage or cancel it anytime.</p>' +
                '<div style="display:flex;flex-direction:column;gap:10px">' +
                    '<a href="' + managePlanHref + '" data-recap-primary style="display:block;text-align:center;width:100%;box-sizing:border-box;min-height:46px;line-height:46px;border-radius:12px;background:#5b7cfa;color:#fff;font-weight:800;font-size:15px;text-decoration:none">Manage plan</a>' +
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

    addLogoutButton() {
        this.navigation?.setVisible('logout', true);
    }

    initDesktopCatalogFilters() {
        ['movies', 'series'].forEach((key) => {
            const button = document.getElementById(`${key}-catalog-filter-toggle`);
            const label = document.getElementById(`${key}-catalog-filter-label`);
            const badge = document.getElementById(`${key}-catalog-filter-badge`);
            const panel = document.getElementById(`${key}-filter-bar`);
            const activeFilters = document.getElementById(`${key}-active-filters`);
            if (!button || !label || !badge || !panel || !activeFilters) return;

            const isTv = () => document.documentElement.classList.contains('tv-mode')
                || navigator.userAgent.includes('NorvaTV-AndroidTV')
                || new URLSearchParams(location.search).has('tv');
            const isDesktopWeb = () => !isTv() && !window.matchMedia('(max-width: 1024px)').matches;
            let activeCount = 0;

            const syncAccessibleLabel = (expanded) => {
                const action = expanded ? 'Hide' : 'Show';
                const suffix = activeCount ? `, ${activeCount} active` : '';
                label.textContent = expanded ? 'Hide filters' : 'More filters';
                button.setAttribute('aria-label', `${action} ${key} filters${suffix}`);
            };
            const setExpanded = (expanded) => {
                button.setAttribute('aria-expanded', String(expanded));
                panel.classList.toggle('is-collapsed', !expanded);
                syncAccessibleLabel(expanded);
            };
            const updateBadge = () => {
                activeCount = activeFilters.querySelectorAll('.filter-chip:not(.filter-chip-clear)').length;
                badge.textContent = activeCount ? String(activeCount) : '';
                badge.classList.toggle('hidden', activeCount === 0);
                syncAccessibleLabel(button.getAttribute('aria-expanded') === 'true');
            };

            button.addEventListener('click', () => {
                if (!isDesktopWeb()) return;
                setExpanded(button.getAttribute('aria-expanded') !== 'true');
            });
            panel.addEventListener('keydown', (event) => {
                if (event.key !== 'Escape' || !isDesktopWeb()) return;
                if (button.getAttribute('aria-expanded') !== 'true') return;
                event.preventDefault();
                setExpanded(false);
                button.focus({ preventScroll: true });
            });

            new MutationObserver(updateBadge).observe(activeFilters, {
                attributes: true,
                childList: true,
                subtree: true,
                attributeFilter: ['class']
            });
            setExpanded(false);
            updateBadge();
        });
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
                    audio: 'Audio language',
                    subtitle: 'Subtitle language',
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
                    audio: 'movies-audio',
                    subtitle: 'movies-subtitle',
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
                    audio: 'Audio language',
                    subtitle: 'Subtitle language',
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
                    audio: 'series-audio',
                    subtitle: 'series-subtitle',
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
        const originalFilterSemantics = {
            ariaLabel: filterBar.getAttribute('aria-label'),
            role: filterBar.getAttribute('role'),
            ariaModal: filterBar.getAttribute('aria-modal'),
            ariaHidden: filterBar.getAttribute('aria-hidden'),
            tabIndex: filterBar.getAttribute('tabindex'),
            inert: filterBar.inert,
        };
        const restoreAttribute = (name, value) => {
            if (value == null) filterBar.removeAttribute(name);
            else filterBar.setAttribute(name, value);
        };
        const applyMobileSemantics = () => {
            filterBar.setAttribute('aria-label', config.title);
            filterBar.setAttribute('role', 'dialog');
            filterBar.setAttribute('aria-modal', 'true');
            filterBar.setAttribute('aria-hidden', 'true');
            filterBar.tabIndex = -1;
            filterBar.inert = true;
        };
        const restoreDesktopSemantics = () => {
            restoreAttribute('aria-label', originalFilterSemantics.ariaLabel);
            restoreAttribute('role', originalFilterSemantics.role);
            restoreAttribute('aria-modal', originalFilterSemantics.ariaModal);
            restoreAttribute('aria-hidden', originalFilterSemantics.ariaHidden);
            restoreAttribute('tabindex', originalFilterSemantics.tabIndex);
            filterBar.inert = originalFilterSemantics.inert;
        };
        applyMobileSemantics();

        const sheetHeader = document.createElement('div');
        sheetHeader.className = 'mobile-filter-sheet-header';
        sheetHeader.innerHTML = `
            <span class="mobile-filter-sheet-title">${config.title}</span>
            <button type="button" class="btn btn-sm btn-ghost mobile-filter-close">Done</button>
        `;

        const sheetBody = document.createElement('div');
        sheetBody.className = 'mobile-filter-body';
        const catalogSection = this.createMobileFilterSection('Catalog');
        const languageSection = this.createMobileFilterSection('Languages');
        const displaySection = this.createMobileFilterSection('Display');
        sheetBody.append(catalogSection.section, languageSection.section, displaySection.section);
        filterBar.prepend(sheetHeader, sheetBody);

        const fieldWrappers = new Map();
        const addField = (section, name) => {
            const el = elements[name];
            if (!el) return;
            const field = document.createElement('div');
            field.className = 'mobile-filter-field';
            field.dataset.mobileField = name;
            const labelText = config.labels[name] || name;
            const label = document.createElement(el.matches?.('select, input, textarea') ? 'label' : 'span');
            label.className = 'mobile-filter-label';
            label.textContent = labelText;
            if (label.tagName === 'LABEL' && el.id) label.htmlFor = el.id;
            if (!el.getAttribute?.('aria-label') && !el.getAttribute?.('aria-labelledby')) {
                el.setAttribute?.('aria-label', labelText);
            }
            field.append(label);
            field.append(el);
            section.append(field);
            fieldWrappers.set(name, field);
        };

        ['source', 'category', 'genre', 'year', 'rating', 'watched', 'added', 'duration', 'status'].forEach(name => addField(catalogSection.body, name));
        ['audio', 'subtitle'].forEach(name => addField(languageSection.body, name));
        ['group', 'hide', 'favorite', 'reset'].forEach(name => addField(displaySection.body, name));

        let previousFocus = null;
        let inertSnapshot = [];
        const setBackgroundInert = (active) => {
            if (!active) {
                inertSnapshot.forEach(({ element, inert }) => {
                    if (element?.isConnected) element.inert = inert;
                });
                inertSnapshot = [];
                return;
            }
            if (inertSnapshot.length) return;
            const candidates = new Set();
            let node = filterBar;
            while (node?.parentElement) {
                const parent = node.parentElement;
                [...parent.children].forEach((sibling) => {
                    if (sibling !== node && sibling !== backdrop) candidates.add(sibling);
                });
                if (parent === document.body) break;
                node = parent;
            }
            inertSnapshot = [...candidates].map(element => ({ element, inert: element.inert }));
            inertSnapshot.forEach(({ element }) => { element.inert = true; });
        };
        const focusable = () => [...filterBar.querySelectorAll(
            'button:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), '
            + 'input:not([disabled]):not([hidden]), [href]:not([hidden]), '
            + '[tabindex]:not([tabindex="-1"]):not([hidden])'
        )].filter(element => element.offsetParent !== null);
        const close = ({ restoreFocus = true } = {}) => {
            const wasOpen = filterBar.classList.contains('mobile-open');
            const focusTarget = wasOpen && restoreFocus && previousFocus?.isConnected ? previousFocus : null;
            setBackgroundInert(false);
            if (focusTarget) {
                try { focusTarget.focus({ preventScroll: true }); } catch (_) { /* noop */ }
            }
            filterBar.classList.remove('mobile-open');
            backdrop.classList.remove('mobile-open');
            filterBtn.setAttribute('aria-expanded', 'false');
            filterBar.setAttribute('aria-hidden', 'true');
            filterBar.inert = true;
            document.body.classList.remove('catalog-filter-open');
            previousFocus = null;
        };
        const open = () => {
            document.querySelectorAll('.filter-bar.mobile-open').forEach(openSheet => {
                if (openSheet !== filterBar) {
                    openSheet.querySelector('.mobile-filter-close')?.click();
                }
            });
            previousFocus = document.activeElement;
            filterBar.classList.add('mobile-open');
            backdrop.classList.add('mobile-open');
            filterBtn.setAttribute('aria-expanded', 'true');
            filterBar.setAttribute('aria-hidden', 'false');
            filterBar.inert = false;
            document.body.classList.add('catalog-filter-open');
            const first = focusable()[0] || filterBar;
            try { first.focus({ preventScroll: true }); } catch (_) { /* noop */ }
            setBackgroundInert(true);
            requestAnimationFrame(() => {
                if (!filterBar.contains(document.activeElement)) first.focus({ preventScroll: true });
            });
        };

        filterBtn.addEventListener('click', open);
        backdrop.addEventListener('click', close);
        sheetHeader.querySelector('.mobile-filter-close')?.addEventListener('click', close);
        filterBar.addEventListener('keydown', event => {
            if (!filterBar.classList.contains('mobile-open')) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
                return;
            }
            if (event.key !== 'Tab') return;
            const items = focusable();
            if (!items.length) {
                event.preventDefault();
                filterBar.focus({ preventScroll: true });
                return;
            }
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus({ preventScroll: true });
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus({ preventScroll: true });
            }
        });

        const updateHiddenFields = () => {
            fieldWrappers.forEach((field, name) => {
                const el = elements[name];
                field.classList.toggle('hidden', !el || el.classList.contains('hidden'));
            });
            languageSection.section.classList.toggle('hidden',
                !['audio', 'subtitle'].some(name => {
                    const field = fieldWrappers.get(name);
                    return field && !field.classList.contains('hidden');
                }));
        };

        const updateBadge = () => {
            const categoryBtn = document.getElementById(`${config.key}-category-btn`);
            const count = [
                categoryBtn?.classList.contains('has-selection') ? 'category' : '',
                elements.genre?.value,
                elements.year?.value,
                elements.rating?.value,
                elements.watched?.value,
                elements.added?.value,
                elements.duration?.value,
                elements.status?.value,
                elements.audio?.value,
                elements.subtitle?.value,
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
            const activeBefore = document.activeElement;
            const focusWasInside = Boolean(activeBefore && filterBar.contains(activeBefore));
            close({ restoreFocus: false });
            moveNames.forEach(name => {
                const marker = markers.get(name);
                const el = elements[name];
                if (marker?.parentNode && el) marker.parentNode.insertBefore(el, marker.nextSibling);
            });
            filterBtn.remove();
            restoreDesktopSemantics();
            updateBadge();
            if (focusWasInside) {
                requestAnimationFrame(() => {
                    const restored = moveNames.map(name => elements[name]).filter(Boolean);
                    const activeStillUsable = activeBefore?.isConnected
                        && activeBefore.matches?.('button, select, input, textarea, [href], [tabindex]:not([tabindex="-1"])')
                        && activeBefore.offsetParent !== null;
                    const target = activeStillUsable
                        ? activeBefore
                        : restored.find(element => !element.disabled && element.offsetParent !== null);
                    try { target?.focus?.({ preventScroll: true }); } catch (_) { /* noop */ }
                });
            }
        };

        const apply = () => {
            const activeBefore = document.activeElement;
            const focusWillBeHidden = [...fieldWrappers.keys()].some(name => {
                const element = elements[name];
                return Boolean(element && activeBefore
                    && (element === activeBefore || element.contains?.(activeBefore)));
            });
            applyMobileSemantics();
            fieldWrappers.forEach((field, name) => {
                const element = elements[name];
                if (element && element.parentElement !== field) field.append(element);
            });
            if (!filterBtn.isConnected) controls.append(filterBtn);
            if (elements.sort) controls.append(elements.sort);
            if (elements.random) controls.append(elements.random);
            updateBadge();
            if (focusWillBeHidden) {
                requestAnimationFrame(() => {
                    if (!filterBtn.isConnected || filterBtn.offsetParent === null) return;
                    try { filterBtn.focus({ preventScroll: true }); } catch (_) { /* noop */ }
                });
            }
        };

        const watched = [...moveNames.map(name => elements[name]), document.getElementById(`${config.key}-category-btn`)]
            .filter(Boolean);
        watched.forEach(el => {
            el.addEventListener('change', () => setTimeout(updateBadge, 0));
            el.addEventListener('click', () => setTimeout(updateBadge, 0));
            new MutationObserver(updateBadge).observe(el, { attributes: true, attributeFilter: ['class'] });
        });

        let layoutMode = null;
        return {
            sync: () => {
                const nextMode = window.matchMedia('(max-width: 1024px)').matches ? 'mobile' : 'desktop';
                // Android fires resize when the IME opens. Re-applying mobile
                // semantics while the sheet is already open would make the visible
                // dialog inert/aria-hidden, so mutate only on a real breakpoint.
                if (nextMode === layoutMode) return;
                layoutMode = nextMode;
                if (nextMode === 'mobile') apply();
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

    /** Show the model-owned Downloads action only inside the phone/tablet APK. */
    refreshDownloadsNav() {
        // The native screen owns both the empty state and downloaded content.
        const isApk = /NorvaTV-AndroidPhone/i.test(navigator.userAgent || '');
        this.navigation?.setVisible('downloads', isApk);
    }

    // ---- Account sheet (mobile Profile tab) -------------------------------
    // A bottom sheet that consolidates the account actions that were scattered
    // before — profile switch (top-right avatar), Settings (bottom tab) and
    // log out (hidden in the desktop hamburger) — into one reachable place.

    openAccountSheet() {
        const sheet = document.getElementById('account-sheet') || this.buildAccountSheet();
        if (sheet.classList.contains('active')) {
            try { sheet.querySelector('.account-close')?.focus(); } catch (_) { /* noop */ }
            return;
        }
        this._accountSheetOpener = (document.activeElement && document.activeElement !== document.body)
            ? document.activeElement
            : document.getElementById('nav-account');
        this.refreshAccountSheet(sheet);
        sheet.inert = false;
        sheet.removeAttribute('inert');
        sheet.setAttribute('aria-hidden', 'false');
        sheet.classList.add('active');
        const initialFocus = sheet.querySelector('.account-close')
            || sheet.querySelector('.account-row:not([style*="display: none"])');
        try { initialFocus?.focus(); } catch (_) { /* noop */ }
        this._setAccountSheetBackgroundInert(sheet, true);
        this._accountSheetKeydown = (event) => this._handleAccountSheetKeydown(event, sheet);
        document.addEventListener('keydown', this._accountSheetKeydown, true);
    }

    closeAccountSheet() {
        const sheet = document.getElementById('account-sheet');
        if (!sheet) return;
        sheet.classList.remove('active');
        sheet.setAttribute('aria-hidden', 'true');
        sheet.setAttribute('inert', '');
        sheet.inert = true;
        if (this._accountSheetKeydown) {
            document.removeEventListener('keydown', this._accountSheetKeydown, true);
            this._accountSheetKeydown = null;
        }
        this._setAccountSheetBackgroundInert(sheet, false);
        const opener = this._accountSheetOpener;
        this._accountSheetOpener = null;
        const fallback = document.getElementById('nav-account');
        const target = opener?.isConnected ? opener : fallback;
        try { target?.focus(); } catch (_) { /* noop */ }
    }

    _setAccountSheetBackgroundInert(sheet, active) {
        if (active) {
            this._accountSheetBackgroundState = [];
            [...document.body.children].forEach((node) => {
                if (node === sheet || node.matches?.('script, style, link')) return;
                this._accountSheetBackgroundState.push({
                    node,
                    hadInert: node.hasAttribute('inert'),
                    ariaHidden: node.getAttribute('aria-hidden')
                });
                node.setAttribute('inert', '');
                node.inert = true;
                node.setAttribute('aria-hidden', 'true');
            });
            return;
        }
        (this._accountSheetBackgroundState || []).forEach(({ node, hadInert, ariaHidden }) => {
            if (!node?.isConnected) return;
            if (hadInert) {
                node.setAttribute('inert', '');
                node.inert = true;
            } else {
                node.removeAttribute('inert');
                node.inert = false;
            }
            if (ariaHidden == null) node.removeAttribute('aria-hidden');
            else node.setAttribute('aria-hidden', ariaHidden);
        });
        this._accountSheetBackgroundState = [];
    }

    _accountSheetFocusables(sheet) {
        return [...sheet.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )].filter((node) => node.getAttribute('aria-hidden') !== 'true'
            && node.style.display !== 'none'
            && !node.closest('[inert]'));
    }

    _handleAccountSheetKeydown(event, sheet) {
        if (!sheet.classList.contains('active')) return;
        if (event.key === 'Escape' || event.key === 'GoBack' || event.key === 'BrowserBack') {
            event.preventDefault();
            event.stopPropagation();
            this.closeAccountSheet();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusables = this._accountSheetFocusables(sheet);
        if (!focusables.length) {
            event.preventDefault();
            return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) {
            event.preventDefault();
            first.focus();
        }
    }

    openScreensSettings() {
        if (this.currentPage !== 'settings') {
            this.navigateTo('settings');
        }
        // Settings.show() can still be completing its account/source refresh after the
        // page becomes visible. switchTab itself is synchronous, so one animation frame
        // is enough to select the permanent devices entry without flashing Advanced.
        requestAnimationFrame(() => this.pages.settings?.switchTab?.('screens'));
    }

    openPairTvSheet(opener = null, options = {}) {
        return this.pairTvSheet?.open?.(opener, options) || false;
    }

    consumePendingPairCode() {
        if (this.isTvMode() || this.currentUser?.device) return false;
        let params;
        try { params = new URLSearchParams(window.location.search); } catch (_) { return false; }
        const code = this.pairTvSheet?.normalizeCode?.(params.get('pair'));
        if (!code || code.length !== 6) return false;
        params.delete('pair');
        const query = params.toString();
        try {
            window.history.replaceState(
                window.history.state,
                '',
                window.location.pathname + (query ? `?${query}` : '') + window.location.hash
            );
        } catch (_) { /* best-effort */ }
        return this.openPairTvSheet(null, { code, force: true });
    }

    openPartners(opener = null) {
        const page = this.pages?.partners;
        if (!page?.canUsePartners?.()) return false;
        page.rememberOpener?.(opener || document.activeElement);
        this.navigateTo('partners');
        return true;
    }

    // ---- Account disclosure (desktop/tablet Web) -------------------------
    // Content remains in the primary navigation. Identity, profile management,
    // Settings, Admin, help and sign-out live behind the avatar as a predictable
    // second level. Phone keeps the modal bottom sheet; TV keeps its current
    // D-pad rail and direct profile switcher.

    usesAccountMenuPopover() {
        const tv = document.documentElement?.classList?.contains('tv-mode')
            || /NorvaTV-AndroidTV/i.test(navigator.userAgent || '');
        return !tv
            && !this.isNativePhoneShell()
            && window.matchMedia('(min-width: 641px)').matches;
    }

    openAccountMenu(opener = null) {
        if (!this.usesAccountMenuPopover()) {
            this.openAccountSheet();
            return true;
        }
        const menu = document.getElementById('account-menu-popover') || this.buildAccountMenu();
        const trigger = opener?.isConnected ? opener : document.getElementById('nav-profile');
        if (!menu.hidden) {
            this.closeAccountMenu({ restoreFocus: true });
            return true;
        }

        this._accountMenuOpener = trigger;
        this.refreshAccountMenu(menu);
        menu.hidden = false;
        menu.setAttribute('aria-hidden', 'false');
        trigger?.setAttribute('aria-expanded', 'true');
        this.positionAccountMenu(menu, trigger);

        this._accountMenuPointerDown = (event) => {
            if (menu.contains(event.target) || trigger?.contains?.(event.target)) return;
            this.closeAccountMenu();
        };
        this._accountMenuKeydown = (event) => this.handleAccountMenuKeydown(event, menu);
        this._accountMenuViewportChange = () => {
            if (!menu.hidden) this.positionAccountMenu(menu, trigger);
        };
        document.addEventListener('pointerdown', this._accountMenuPointerDown, true);
        document.addEventListener('keydown', this._accountMenuKeydown, true);
        window.addEventListener('resize', this._accountMenuViewportChange);
        window.addEventListener('scroll', this._accountMenuViewportChange, true);

        const first = this.accountMenuItems(menu)[0];
        try { first?.focus({ preventScroll: true }); } catch (_) { /* noop */ }
        return true;
    }

    closeAccountMenu({ restoreFocus = false } = {}) {
        const menu = document.getElementById('account-menu-popover');
        if (!menu || menu.hidden) return false;
        menu.hidden = true;
        menu.setAttribute('aria-hidden', 'true');
        const opener = this._accountMenuOpener;
        opener?.setAttribute('aria-expanded', 'false');
        if (this._accountMenuPointerDown) {
            document.removeEventListener('pointerdown', this._accountMenuPointerDown, true);
            this._accountMenuPointerDown = null;
        }
        if (this._accountMenuKeydown) {
            document.removeEventListener('keydown', this._accountMenuKeydown, true);
            this._accountMenuKeydown = null;
        }
        if (this._accountMenuViewportChange) {
            window.removeEventListener('resize', this._accountMenuViewportChange);
            window.removeEventListener('scroll', this._accountMenuViewportChange, true);
            this._accountMenuViewportChange = null;
        }
        this._accountMenuOpener = null;
        if (restoreFocus) {
            const target = opener?.isConnected ? opener : document.getElementById('nav-profile');
            try { target?.focus({ preventScroll: true }); } catch (_) { /* noop */ }
        }
        return true;
    }

    accountMenuItems(menu) {
        return [...menu.querySelectorAll('[role="menuitem"]:not([hidden]):not([disabled])')]
            .filter((item) => item.style.display !== 'none');
    }

    handleAccountMenuKeydown(event, menu) {
        if (menu.hidden) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.closeAccountMenu({ restoreFocus: true });
            return;
        }
        if (event.key === 'Tab') {
            this.closeAccountMenu();
            return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = this.accountMenuItems(menu);
        if (!items.length) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement);
        let next = 0;
        if (event.key === 'End') next = items.length - 1;
        else if (event.key === 'ArrowUp') next = current <= 0 ? items.length - 1 : current - 1;
        else if (event.key === 'ArrowDown') next = current < 0 || current === items.length - 1 ? 0 : current + 1;
        items[next]?.focus({ preventScroll: true });
    }

    positionAccountMenu(menu, opener) {
        if (!menu || !opener?.getBoundingClientRect) return;
        const rect = opener.getBoundingClientRect();
        const gutter = 16;
        const width = menu.offsetWidth || 320;
        const left = Math.max(gutter, Math.min(rect.right - width, window.innerWidth - width - gutter));
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(rect.bottom + 8)}px`;
        menu.style.setProperty('--account-menu-arrow-x', `${Math.round(rect.left + rect.width / 2 - left)}px`);
    }

    buildAccountMenu() {
        const menu = document.createElement('div');
        menu.id = 'account-menu-popover';
        menu.className = 'account-menu-popover';
        menu.hidden = true;
        menu.setAttribute('aria-hidden', 'true');
        menu.innerHTML = `
            <div class="account-menu-profile">
                <img id="account-menu-avatar" class="account-menu-avatar" src="/img/avatars/placeholder.svg" alt="">
                <div class="account-menu-identity">
                    <strong id="account-menu-name">Profile</strong>
                    <span id="account-menu-email"></span>
                </div>
            </div>
            <div class="account-menu-items" role="menu" aria-label="Profile and account">
                <button type="button" class="account-menu-item" data-act="switch" role="menuitem">
                    <img class="account-menu-icon account-menu-current-avatar" src="/img/avatars/placeholder.svg" alt="">
                    <span>Switch profile</span>
                </button>
                <button type="button" class="account-menu-item" data-act="manage" role="menuitem">
                    <img class="account-menu-icon" src="/img/icons/norva-account.svg?v=sharp-core-1" alt="">
                    <span>Manage profiles</span>
                </button>
                <button type="button" class="account-menu-item" data-act="settings" role="menuitem">
                    <img class="account-menu-icon" src="/img/icons/norva-settings.svg?v=sharp-core-1" alt="">
                    <span class="account-menu-copy"><strong>Settings</strong><small>Account, providers and playback</small></span>
                </button>
                <button type="button" class="account-menu-item" data-act="admin" role="menuitem" hidden aria-hidden="true">
                    <img class="account-menu-icon" src="/img/icons/norva-account.svg?v=sharp-core-1" alt="">
                    <span class="account-menu-copy"><strong>Administration</strong><small>Operations and member access</small></span>
                </button>
                <button type="button" class="account-menu-item" data-act="help" role="menuitem">
                    <span class="account-menu-symbol" aria-hidden="true">?</span>
                    <span>Help &amp; support</span>
                </button>
                <div class="account-menu-divider" role="separator"></div>
                <button type="button" class="account-menu-item account-menu-item-danger" data-act="logout" role="menuitem">
                    <img class="account-menu-icon" src="/img/icons/norva-logout.svg?v=sharp-core-1" alt="">
                    <span>Log out</span>
                </button>
            </div>`;
        menu.querySelectorAll('[data-act]').forEach((item) => {
            item.addEventListener('click', () => {
                const action = item.dataset.act;
                this.closeAccountMenu();
                this.performAccountAction(action, item);
            });
        });
        document.body.appendChild(menu);
        return menu;
    }

    refreshAccountMenu(menu) {
        const cur = window.NorvaProfiles?.current?.() || {};
        const avatar = menu.querySelector('#account-menu-avatar');
        const switchAvatar = menu.querySelector('.account-menu-current-avatar');
        if (cur.avatarUrl) {
            if (avatar) avatar.src = cur.avatarUrl;
            if (switchAvatar) switchAvatar.src = cur.avatarUrl;
        }
        const name = menu.querySelector('#account-menu-name');
        const email = menu.querySelector('#account-menu-email');
        if (name) name.textContent = cur.name || 'Profile';
        if (email) email.textContent = this.currentUser?.email || this.currentUser?.username || '';
        const switchRow = menu.querySelector('[data-act="switch"]');
        const manageRow = menu.querySelector('[data-act="manage"]');
        if (switchRow) switchRow.hidden = !(cur.isCloud && cur.count > 1);
        if (manageRow) manageRow.hidden = !cur.isCloud;
        this.refreshAccountAdminEntry(menu);
        const currentAction = this.currentPage === 'settings' || this.currentPage === 'admin'
            ? this.currentPage
            : '';
        menu.querySelectorAll('[data-act="settings"], [data-act="admin"]').forEach((item) => {
            const current = item.dataset.act === currentAction;
            item.classList.toggle('is-current', current);
            if (current) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        });
    }

    refreshAccountAdminEntry(surface) {
        const row = surface?.querySelector?.('[data-act="admin"]');
        if (!row) return;
        row.hidden = true;
        row.setAttribute('aria-hidden', 'true');
        this.checkIsAdmin().then((allowed) => {
            if (!row.isConnected || !allowed) return;
            row.hidden = false;
            row.setAttribute('aria-hidden', 'false');
        }).catch(() => {});
    }

    performAccountAction(action, trigger = null) {
        if (action === 'switch') window.NorvaProfiles?.openSwitcher?.();
        else if (action === 'manage') window.NorvaProfiles?.openManage?.();
        else if (action === 'screens') this.openScreensSettings();
        else if (action === 'partners') this.openPartners(trigger);
        else if (action === 'settings') this.navigateTo('settings');
        else if (action === 'admin') {
            this.checkIsAdmin().then((allowed) => {
                if (allowed) this.navigateTo('admin');
            }).catch(() => {});
        } else if (action === 'help') {
            const returnTo = window.location.pathname + window.location.search + window.location.hash;
            window.location.href = '/support.html?returnTo=' + encodeURIComponent(returnTo);
        } else if (action === 'logout') {
            void this.signOut();
        }
    }

    buildAccountSheet() {
        const overlay = document.createElement('div');
        overlay.id = 'account-sheet';
        overlay.className = 'modal-overlay account-sheet';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.setAttribute('inert', '');
        overlay.inert = true;
        overlay.innerHTML = `
            <div class="account-panel" role="dialog" aria-modal="true" aria-labelledby="account-sheet-title">
                <div class="account-head">
                    <img id="account-avatar" class="account-avatar" src="/img/avatars/placeholder.svg" alt="">
                    <div class="account-id">
                        <div id="account-sheet-title" class="account-name">Profile</div>
                        <div id="account-email" class="account-email"></div>
                    </div>
                    <button type="button" class="account-close modal-close" aria-label="Close">&times;</button>
                </div>
                <button type="button" class="account-row" data-act="switch">
                    <img class="account-ic" src="/img/avatars/placeholder.svg" alt=""><span>Switch profile</span>
                </button>
                <button type="button" class="account-row" data-act="manage">
                    <img class="account-ic" src="/img/icons/norva-account.svg?v=sharp-core-1" alt=""><span>Manage profiles</span>
                </button>
                <button type="button" class="account-row" data-act="screens">
                    <img class="account-ic account-ic-devices" src="/img/icons/norva-devices.svg?v=1" alt="">
                    <span class="account-row-copy">
                        <span class="account-row-title">Devices &amp; screens</span>
                        <span class="account-row-hint">Web, phone, tablet and TV</span>
                    </span>
                </button>
                <button type="button" class="account-row" data-act="partners" hidden aria-hidden="true">
                    <img class="account-ic" src="/img/norva-app-icon.png" alt="">
                    <span class="account-row-copy">
                        <span class="account-row-title">Norva Partners</span>
                        <span class="account-row-hint">Earn with eligible referrals</span>
                    </span>
                </button>
                <button type="button" class="account-row" data-act="settings">
                    <img class="account-ic" src="/img/icons/norva-settings.svg?v=sharp-core-1" alt="">
                    <span class="account-row-copy">
                        <span class="account-row-title">Settings</span>
                        <span class="account-row-hint">Account, providers and playback</span>
                    </span>
                </button>
                <button type="button" class="account-row" data-act="admin" hidden aria-hidden="true">
                    <img class="account-ic" src="/img/icons/norva-account.svg?v=sharp-core-1" alt=""><span>Administration</span>
                </button>
                <button type="button" class="account-row" data-act="help">
                    <span class="account-sheet-symbol" aria-hidden="true">?</span><span>Help &amp; support</span>
                </button>
                <button type="button" class="account-row account-row-danger" data-act="logout">
                    <img class="account-ic" src="/img/icons/norva-logout.svg?v=sharp-core-1" alt=""><span>Log out</span>
                </button>
            </div>`;
        // Tapping the dimmed backdrop (not the panel) closes the sheet.
        overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeAccountSheet(); });
        overlay.querySelector('.account-close').addEventListener('click', () => this.closeAccountSheet());
        overlay.querySelectorAll('.account-row').forEach((row) => {
            row.addEventListener('click', () => {
                const act = row.dataset.act;
                this.closeAccountSheet();
                this.performAccountAction(act, row);
            });
        });
        document.body.appendChild(overlay);
        return overlay;
    }

    refreshAccountSheet(sheet) {
        const cur = (window.NorvaProfiles?.current?.()) || {};
        const avatar = sheet.querySelector('#account-avatar');
        const switchIc = sheet.querySelector('[data-act="switch"] .account-ic');
        const name = sheet.querySelector('#account-sheet-title');
        const email = sheet.querySelector('#account-email');
        const switchRow = sheet.querySelector('[data-act="switch"]');
        const manageRow = sheet.querySelector('[data-act="manage"]');
        const screensRow = sheet.querySelector('[data-act="screens"]');
        const partnersRow = sheet.querySelector('[data-act="partners"]');
        if (avatar && cur.avatarUrl) avatar.src = cur.avatarUrl;
        if (switchIc && cur.avatarUrl) switchIc.src = cur.avatarUrl;
        if (name) name.textContent = cur.name || 'Profile';
        if (email) email.textContent = this.currentUser?.email || this.currentUser?.username || '';
        // Profile switching only exists in cloud mode.
        if (switchRow) switchRow.style.display = cur.isCloud && cur.count > 1 ? '' : 'none';
        if (manageRow) manageRow.style.display = cur.isCloud ? '' : 'none';
        if (screensRow) {
            const cloudUser = Boolean(cur.isCloud || this.currentUser?.cloud || window.API?.isCloudMode?.());
            screensRow.style.display = cloudUser ? '' : 'none';
        }
        if (partnersRow) {
            // Cloud users can always discover Partners or request early access.
            // Bootstrap remains authoritative for every operational action and
            // Android TV relay availability.
            this.pages?.partners?.setEntryVisibility?.(false);
            this.pages?.partners?.primeVisibility?.().catch(() => {});
        }
        this.refreshAccountAdminEntry(sheet);
    }

    // Canonical sign-out (cloud → Supabase + /account.html, else local token).
    async signOut() {
        if (this._signOutInFlight) return false;
        if (!window.NorvaModal || typeof window.NorvaModal.confirm !== 'function') {
            console.warn('[Norva] Sign-out confirmation is unavailable; keeping the session active.');
            return false;
        }
        const tv = /NorvaTV-AndroidTV/i.test(navigator.userAgent || '');
        const confirmed = await window.NorvaModal.confirm(
            tv
                ? 'This TV will be unpaired. You will need to scan a new pairing code to use it again.'
                : 'You will need to sign in again to use Norva on this device.',
            {
                title: 'Log out of Norva?',
                confirmLabel: 'Log out',
                cancelLabel: 'Stay signed in',
                danger: true
            }
        );
        if (!confirmed) return false;

        this._signOutInFlight = true;
        if (tv) {
            try { await window.NorvaCloud?.device?.unpairSelf?.(); } catch (_) { /* best-effort */ }
            try { window.NorvaCloud?.setDeviceToken?.(''); } catch (_) { /* noop */ }
            try { localStorage.removeItem('norva-cloud-device-id'); } catch (_) { /* noop */ }
            try { if (window.NorvaAuth) await window.NorvaAuth.signOut(); } catch (_) { /* noop */ }
            window.location.replace('/cloud-pair.html?device=tv&returnTo=%2Fapp.html%3Fpaired%3D1%23home');
            return true;
        }

        const token = localStorage.getItem('authToken');
        if (this.currentUser?.cloud && window.NorvaAuth) {
            try { await window.NorvaAuth.signOut(); } catch (_) { /* best effort */ }
            window.location.replace('/account.html');
            return true;
        }
        if (token) {
            try {
                await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
            } catch (_) { /* best effort */ }
        }
        localStorage.removeItem('authToken');
        window.location.replace('/login.html');
        return true;
    }

    // ---- Global catalogue search (movies + series) -----------------------
    // First-class search reachable from anywhere via the top-bar icon. Queries
    // the movie and series catalogue in parallel (same /media-items endpoint the
    // pages use), so it spans the whole library instead of one content type.

    openSearch() {
        const ov = document.getElementById('gsearch-overlay') || this.buildSearchOverlay();
        // Stash the opener before the background becomes inert so every input mode
        // (touch, keyboard, screen reader and D-pad) returns to the invoking control.
        this._searchOpener = (document.activeElement && document.activeElement !== document.body)
            ? document.activeElement : document.getElementById('nav-search');
        if (this._searchOpener?.id) ov.dataset.restoreFocus = this._searchOpener.id;
        const wasOpen = ov.classList.contains('active');
        ov.inert = false;
        ov.setAttribute('aria-hidden', 'false');
        ov.classList.add('active');
        const input = ov.querySelector('#gsearch-input');
        // Focus SYNCHRONOUSLY inside the opening gesture: Android TV WebViews raise the
        // leanback keyboard only for a gesture-synchronous focus. A deferred (setTimeout)
        // focus is outside the gesture, so the IME then often never rises — an empty,
        // untypeable box, the #1 reason menu search felt broken on TV. Re-assert after paint.
        try { input.focus(); input.select(); } catch (_) { /* noop */ }
        if (!wasOpen) {
            this._searchInertSnapshot = [...document.body.children]
                .filter(element => element !== ov)
                .map(element => ({ element, inert: element.inert }));
            this._searchInertSnapshot.forEach(({ element }) => { element.inert = true; });
        }
        setTimeout(() => {
            try { if (document.activeElement !== input) { input.focus(); input.select(); } } catch (_) { /* noop */ }
        }, 50);
    }

    closeSearch(restoreFocus = true) {
        const ov = document.getElementById('gsearch-overlay');
        if (!ov) return;
        ov.classList.remove('active');
        (this._searchInertSnapshot || []).forEach(({ element, inert }) => {
            if (element?.isConnected) element.inert = inert;
        });
        this._searchInertSnapshot = [];
        const opener = this._searchOpener;
        this._searchOpener = null;
        if (restoreFocus && opener?.isConnected) {
            try { opener.focus({ preventScroll: true }); } catch (_) { /* noop */ }
        } else if (ov.contains(document.activeElement)) {
            try { document.activeElement.blur(); } catch (_) { /* noop */ }
        }
        ov.setAttribute('aria-hidden', 'true');
        ov.inert = true;
    }

    buildSearchOverlay() {
        const ov = document.createElement('div');
        ov.id = 'gsearch-overlay';
        ov.className = 'modal-overlay gsearch-overlay';
        ov.setAttribute('aria-hidden', 'true');
        ov.inert = true;
        ov.innerHTML = `
            <div class="gsearch-panel" role="dialog" aria-modal="true" aria-label="Search" tabindex="-1">
                <div class="gsearch-bar">
                    <span class="gsearch-ic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></span>
                    <input id="gsearch-input" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Search movies & series…">
                    <button type="button" class="gsearch-cancel modal-close">Cancel</button>
                </div>
                <div class="gsearch-results" id="gsearch-results">
                    <div class="gsearch-hint">Type at least 2 characters to search the catalogue.</div>
                </div>
            </div>`;
        ov.addEventListener('click', (e) => { if (e.target === ov) this.closeSearch(); });
        ov.querySelector('.gsearch-cancel').addEventListener('click', () => this.closeSearch());
        ov.addEventListener('keydown', (event) => {
            if (!ov.classList.contains('active')) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                this.closeSearch();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = [...ov.querySelectorAll(
                'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), '
                + '[href]:not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])'
            )].filter(element => element.offsetParent !== null);
            if (!focusable.length) {
                event.preventDefault();
                ov.querySelector('.gsearch-panel')?.focus?.({ preventScroll: true });
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus({ preventScroll: true });
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus({ preventScroll: true });
            }
        });
        const input = ov.querySelector('#gsearch-input');
        input.addEventListener('input', () => {
            clearTimeout(this._searchDebounce);
            this._searchDebounce = setTimeout(() => this.runSearch(input.value.trim()), 250);
        });
        input.addEventListener('keydown', (e) => {
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
        // dedup=1 → the search RPC collapses to one representative row per film SERVER-SIDE
        // (grid parity, durable across clients), so 48 rows ≈ 48 distinct films. openByItem's
        // sibling re-fetch deliberately OMITS the flag — the version picker needs raw rows.
        const [mvResult, srResult] = await Promise.allSettled([
            Promise.resolve().then(() => window.API.media.page({ type: 'movie', q, limit: 48, dedup: 1 })),
            Promise.resolve().then(() => window.API.media.page({ type: 'series', q, limit: 48, dedup: 1 })),
        ]);
        if (reqId !== this._searchReq) return; // a newer keystroke superseded this
        const failedCount = Number(mvResult.status === 'rejected') + Number(srResult.status === 'rejected');
        if (failedCount === 2) {
            this._gsMovies = [];
            this._gsSeries = [];
            box.innerHTML = `
                <div class="gsearch-hint gsearch-error" role="alert">
                    Search is temporarily unavailable.
                    <button type="button" class="btn btn-sm gsearch-retry">Try again</button>
                </div>`;
            box.querySelector('.gsearch-retry')?.addEventListener('click', () => this.runSearch(q));
            return;
        }
        const mv = mvResult.status === 'fulfilled' ? mvResult.value : { items: [] };
        const sr = srResult.status === 'fulfilled' ? srResult.value : { items: [] };
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
        const rankGroups = (groups) => {
            const needle = M?.searchableText?.(q)?.trim() || String(q).toLowerCase();
            const score = (group) => {
                const item = group?.representative || group || {};
                const rawTitle = item.tmdb?.title || item.tmdb?.name || item.name || '';
                const cleanTitle = M?.cleanReleaseName?.(rawTitle) || rawTitle;
                const title = M?.searchableText?.(cleanTitle)?.trim() || String(cleanTitle).toLowerCase();
                if (title === needle) return 0;
                if (title.startsWith(`${needle} `) || title.startsWith(needle)) return 1;
                if (title.split(/\s+/).includes(needle)) return 2;
                if (title.includes(needle)) return 3;
                return 4;
            };
            return groups
                .map((group, index) => ({ group, index, score: score(group) }))
                .sort((a, b) => a.score - b.score || a.index - b.index)
                .map(entry => entry.group);
        };
        const gMovies = rankGroups(grp(mv.items, 'stream_id'));
        const gSeries = rankGroups(grp(sr.items, 'series_id')); // series dedup by series_id, mirroring SeriesPage
        this._gsMovies = gMovies.map((g) => g.representative);
        this._gsSeries = gSeries.map((g) => g.representative);
        this.renderSearchResults(box, q, gMovies, gSeries);
        if (failedCount === 1) {
            box.insertAdjacentHTML('afterbegin',
                '<div class="gsearch-hint gsearch-partial" role="status">Some results could not be loaded. You can retry the search.</div>');
        }
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
            el.addEventListener('click', (event) => this.openSearchResult(
                el.dataset.type,
                parseInt(el.dataset.idx, 10),
                { moveFocus: event.detail === 0 }
            ));
        });
        box.querySelectorAll('.gsearch-seeall').forEach((el) => {
            el.addEventListener('click', (event) => this.seeAllInPage(
                el.dataset.seeall,
                q,
                { moveFocus: event.detail === 0 }
            ));
        });
    }

    // "See all in Movies/Series": land on the fully-paged in-page grid, pre-searched to the same
    // query — the same navigate+prefill path openSearchResult() falls back to (race-safe via the
    // page's cloudRequestId guard). Removes the overlay's 48-row ceiling as the limiting factor.
    seeAllInPage(type, q, { moveFocus = true } = {}) {
        this.closeSearch(false);
        const page = type === 'series' ? 'series' : 'movies';
        this.navigateTo(page);
        const navigationToken = this._navigationToken;
        const pageObj = type === 'series' ? this.pages?.series : this.pages?.movies;
        // "See all" is itself a same-page intent. Invalidate a delayed fiche
        // restore/deep-link/search even when navigateTo() is a no-op here.
        pageObj?.beginFicheIntent?.();
        const isCurrent = () => navigationToken === this._navigationToken && this.currentPage === page;
        setTimeout(() => {
            if (!isCurrent()) return;
            const input = document.getElementById(page === 'series' ? 'series-search' : 'movies-search');
            if (input) { input.value = q; input.dispatchEvent(new Event('input', { bubbles: true })); }
            // TV: once the searched grid re-renders, land the D-pad ring on the first card
            // so the first arrow press isn't wasted waking focus onto <body>.
            if (document.documentElement.classList.contains('tv-mode')) {
                setTimeout(() => {
                    if (!isCurrent()) return;
                    const card = document.querySelector(`#${page}-grid .${type === 'series' ? 'series' : 'movie'}-card`);
                    try { card?.focus?.(); card?.scrollIntoView?.({ block: 'nearest' }); } catch (_) { /* noop */ }
                }, 450);
            } else if (moveFocus && input) {
                // Keyboard/TalkBack activation must not fall back to <body> once
                // the search dialog becomes inert.
                requestAnimationFrame(() => {
                    if (!isCurrent()) return;
                    try { input.focus({ preventScroll: true }); } catch (_) { /* noop */ }
                });
            }
        }, 140);
    }

    // Open the tapped result's detail directly via the page's openByItem(). If
    // that can't resolve a detail (page not ready, fetch failed), fall back to
    // landing on the page pre-searched to the title — the page's cloudRequestId
    // guard makes that prefill race-safe.
    openSearchResult(type, idx, { moveFocus = true } = {}) {
        const item = (type === 'series' ? this._gsSeries : this._gsMovies)?.[idx];
        this.closeSearch(false);
        const page = type === 'series' ? 'series' : 'movies';
        this.navigateTo(page);
        const navigationToken = this._navigationToken;
        const pageObj = type === 'series' ? this.pages?.series : this.pages?.movies;
        const ficheIntentToken = pageObj?.beginFicheIntent?.();
        const isRouteCurrent = () => navigationToken === this._navigationToken && this.currentPage === page;
        const isIntentCurrent = () => ficheIntentToken == null
            || pageObj?.isFicheIntentCurrent?.(ficheIntentToken) !== false;
        const isCurrent = () => isRouteCurrent() && isIntentCurrent();
        const title = item ? (item.tmdb?.title || item.tmdb?.name || item.name || '') : '';
        setTimeout(async () => {
            if (!isCurrent()) return;
            let opened = false;
            try {
                if (item && pageObj?.openByItem) {
                    opened = await pageObj.openByItem(item, { intentToken: ficheIntentToken });
                }
            } catch (_) { opened = false; }
            if (!isRouteCurrent()) {
                if (opened) pageObj?.hideDetails?.();
                this.forgetOpenFiche();
                return;
            }
            // A newer card/rail/fiche intent on this same route owns the visible
            // detail and its continuity state; never hide or clear it.
            if (!isIntentCurrent()) return;
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
                } else if (moveFocus) {
                    requestAnimationFrame(() => {
                        if (!isCurrent()) return;
                        const panel = pageObj?.detailsPanel;
                        const primary = pageObj?.primaryActionBtn;
                        const target = (primary && !primary.disabled && primary.offsetParent !== null)
                            ? primary
                            : panel?.querySelector?.(
                                '.movie-back-btn, .series-back-btn, button:not([disabled]), [href], [tabindex="0"]'
                            );
                        try { target?.focus?.({ preventScroll: true }); } catch (_) { /* noop */ }
                    });
                }
                return;
            }
            const input = document.getElementById(page === 'series' ? 'series-search' : 'movies-search');
            if (input && title) {
                input.value = title;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (moveFocus && input) {
                requestAnimationFrame(() => {
                    if (!isCurrent()) return;
                    try { input.focus({ preventScroll: true }); } catch (_) { /* noop */ }
                });
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
        // The full version group can contain provider-only fields, so it remains
        // session-scoped. Native Activity recreation gets only the bounded title
        // identity needed to resolve the exact fiche again after a WebView reload.
        if (this.isNativePhoneShell()) {
            try {
                const type = fiche.type === 'series' ? 'series' : 'movie';
                const sourceId = String(fiche.sourceId || '').slice(0, 200);
                const id = String(fiche.id || '').slice(0, 200);
                if (!sourceId || !id) return;
                localStorage.setItem(NORVA_NATIVE_FICHE_KEY, JSON.stringify({
                    type,
                    sourceId,
                    id,
                    title: String(fiche.title || '').slice(0, 240),
                    updatedAt: Date.now(),
                }));
            } catch (_) { /* best-effort, never blocks opening the fiche */ }
        }
    }

    forgetOpenFiche() {
        try { sessionStorage.removeItem('norva-open-fiche'); } catch (_) { /* noop */ }
        try { localStorage.removeItem(NORVA_NATIVE_FICHE_KEY); } catch (_) { /* noop */ }
    }

    readOpenFiche() {
        try {
            const live = JSON.parse(sessionStorage.getItem('norva-open-fiche') || 'null');
            if (live) return live;
        } catch (_) { /* fall through to the bounded native snapshot */ }
        if (!this._nativeRecovery) return null;
        try {
            const saved = JSON.parse(localStorage.getItem(NORVA_NATIVE_FICHE_KEY) || 'null');
            if (!saved || Date.now() - Number(saved.updatedAt || 0) > NORVA_NATIVE_CONTINUITY_TTL_MS) {
                return null;
            }
            if (!['movie', 'series'].includes(saved.type)) return null;
            const sourceId = String(saved.sourceId || '').slice(0, 200);
            const id = String(saved.id || '').slice(0, 200);
            if (!sourceId || !id) return null;
            return {
                type: saved.type,
                sourceId,
                id,
                title: String(saved.title || '').slice(0, 240),
            };
        } catch (_) {
            return null;
        }
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
        const navigationToken = this._navigationToken;
        const ficheIntentToken = pageObj.beginFicheIntent?.();
        const isRouteCurrent = () => navigationToken === this._navigationToken && this.currentPage === pageName;
        const isIntentCurrent = () => ficheIntentToken == null
            || pageObj.isFicheIntentCurrent?.(ficheIntentToken) !== false;
        const isCurrent = () => isRouteCurrent() && isIntentCurrent();
        // The link carries the CLOUD source UUID; the catalog pages key on the LOCAL alias.
        const sourceId = window.API?.localSourceIdFor ? window.API.localSourceIdFor(rawSourceId) : rawSourceId;
        // Defer so the page's show()/DOM has settled (mirrors restoreOpenFiche).
        setTimeout(async () => {
            if (!isCurrent()) return;
            const item = pageName === 'series'
                ? { sourceId, series_id: id, name: title, ...(title ? { tmdb: { name: title } } : {}) }
                : { sourceId, stream_id: id, name: title, ...(title ? { tmdb: { title } } : {}) };
            let opened = false;
            try {
                opened = Boolean(await pageObj.openByItem(item, { intentToken: ficheIntentToken }));
            } catch (_) { opened = false; }
            if (!isRouteCurrent()) {
                if (opened) pageObj.hideDetails?.();
                this.forgetOpenFiche();
            } else if (!isIntentCurrent()) {
                // A newer same-page intent owns the fiche and its persisted state.
                return;
            }
        }, 200);
    }

    // Re-open the saved fiche once, on the page it belongs to, after a refresh.
    restoreOpenFiche(pageName, fiche = this.readOpenFiche()) {
        if (!fiche || this.fichePageFor(fiche) !== pageName) return;
        const pageObj = this.pages?.[pageName];
        if (!pageObj) return;
        const navigationToken = this._navigationToken;
        const ficheIntentToken = pageObj.beginFicheIntent?.();
        const isRouteCurrent = () => navigationToken === this._navigationToken && this.currentPage === pageName;
        const isIntentCurrent = () => ficheIntentToken == null
            || pageObj.isFicheIntentCurrent?.(ficheIntentToken) !== false;
        const isCurrent = () => isRouteCurrent() && isIntentCurrent();
        // Defer so the page's show()/DOM has settled (mirrors openSearchResult).
        setTimeout(async () => {
            if (!isCurrent()) return;
            try {
                // Rebuild the EXACT fiche from the stashed version group (all versions, no
                // re-search). Fall back to openByItem for older id-only stashes.
                if (fiche.type === 'series' && fiche.series && pageObj.showSeriesDetailsV2) {
                    await pageObj.showSeriesDetailsV2(
                        fiche.series,
                        fiche.group || null,
                        { intentToken: ficheIntentToken }
                    );
                    if (!isRouteCurrent()) {
                        pageObj.hideDetails?.();
                        this.forgetOpenFiche();
                    }
                    return;
                }
                if (fiche.type === 'movie' && fiche.group?.items?.length && pageObj.showMovieDetails) {
                    const selected = fiche.group.items.find(i => String(i.stream_id) === String(fiche.id)) || null;
                    pageObj.showMovieDetails(fiche.group, selected, { intentToken: ficheIntentToken });
                    if (!isRouteCurrent()) {
                        pageObj.hideDetails?.();
                        this.forgetOpenFiche();
                    }
                    return;
                }
                if (pageObj.openByItem) {
                    const item = fiche.item || (fiche.type === 'series'
                        ? { sourceId: fiche.sourceId, series_id: fiche.id, name: fiche.title, tmdb: { name: fiche.title } }
                        : { sourceId: fiche.sourceId, stream_id: fiche.id, name: fiche.title, tmdb: { title: fiche.title } });
                    const opened = await pageObj.openByItem(item, { intentToken: ficheIntentToken });
                    if (!isRouteCurrent()) {
                        if (opened) pageObj.hideDetails?.();
                        this.forgetOpenFiche();
                    } else if (!isIntentCurrent()) {
                        return;
                    } else if (!opened) {
                        this.forgetOpenFiche();
                    }
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
        const navigationToken = (this._navigationToken || 0) + 1;
        this._navigationToken = navigationToken;
        if (this.currentPage && this.currentPage !== pageName) {
            this.pairTvSheet?.close?.();
            this.pages?.[this.currentPage]?.beginFicheIntent?.();
        }
        const tvRouteToken = this.beginTvRouteTransition(pageName);

        // Navigating to a page that doesn't own the open fiche abandons it — drop the
        // saved-fiche token so a later refresh doesn't resurrect a detail you closed.
        const openFiche = this.readOpenFiche();
        if (openFiche && this.fichePageFor(openFiche) !== pageName) this.forgetOpenFiche();

        // Remember where the outgoing page was scrolled (page-level scroller, e.g.
        // #page-home; Movies/Series grids save their own scroller in hide()).
        this._pageScroll = this._pageScroll || {};
        const prevPageEl = this.getPageScrollElement(this.currentPage);
        if (prevPageEl) this._pageScroll[this.currentPage] = prevPageEl.scrollTop || 0;

        // Update every platform projection through the navigation interface.
        this.navigation?.syncCurrent(pageName);

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

        let showResult = null;
        if (pageName === 'admin' && !this.pages.admin) {
            // Lazy web-only route: re-verify the admin claim server-side BEFORE
            // even downloading AdminPage.js; APK shells and non-admins bounce home.
            showResult = this.checkIsAdmin()
                .then((ok) => {
                    if (!ok) { this.navigateTo('home'); return null; }
                    return this.ensureAdminPage();
                })
                .then((page) => { if (page && this.currentPage === 'admin') page.show?.(); })
                .catch((err) => console.error('[App] AdminPage load failed:', err));
        } else if (this.pages[pageName]?.show) {
            try {
                showResult = this.pages[pageName].show();
            } catch (err) {
                console.error(`[App] ${pageName} page failed to open:`, err);
            }
        }
        Promise.resolve(showResult)
            .catch((err) => console.error(`[App] ${pageName} page preparation failed:`, err))
            .finally(() => {
                if (navigationToken !== this._navigationToken) return;
                this.endTvRouteTransition(tvRouteToken);
                this.restoreNativeGridScroll(pageName);
                this.restorePageScroll(pageName, this._pageScroll?.[pageName]);
                this.persistNativeContinuity();
            });

        // Restore the incoming page's position (two passes: instant, and once
        // async content has had a beat to paint back at full height).
        const savedTop = this._pageScroll[pageName] || 0;
        this.restorePageScroll(pageName, savedTop);

        // After the switch: the watch page is its own fullscreen player, so a movie
        // /episode must never play under a still-floating live mini. Run this LAST —
        // the page being left has already had hide() (which may have just docked the
        // mini), so stopping here undocks + kills it before the movie starts.
        if (pageName === 'watch') {
            try { this.exitLiveMini({ stop: true }); } catch (_) { /* noop */ }
        }
    }

    async refreshProviderAccessRollout() {
        window.NORVA_PROVIDER_ACCESS_UI_V1 = false;
        if (!window.API?.providerAccess?.available?.()) return false;
        try {
            const status = await window.API.providerAccess.rolloutStatus();
            const eligible = status?.eligible === true;
            window.NORVA_PROVIDER_ACCESS_UI_V1 = eligible;
            window.dispatchEvent(new CustomEvent('norva:provider-access-rollout', {
                detail: { eligible, stage: String(status?.stage || 'off'), revision: Number(status?.revision || 0) }
            }));
            return eligible;
        } catch (_) {
            window.NORVA_PROVIDER_ACCESS_UI_V1 = false;
            return false;
        }
    }

    async refreshProviderAccessNotifications() {
        this._providerAccessNotificationCheckedAt = Date.now();
        if (!this.currentUser?.cloud || !window.API?.providerAccess?.available?.()) return;
        try {
            const payload = await window.API.providerAccess.listNotifications(20);
            const notifications = Array.isArray(payload?.notifications) ? payload.notifications : [];
            if (!notifications.length) {
                this.clearProviderAccessNotice();
                return;
            }
            let connectedSourceCount = null;
            if (notifications.some((item) => item?.kind === 'access_hidden')) {
                try {
                    const sources = await window.API.sources.getAll();
                    connectedSourceCount = Array.isArray(sources)
                        ? sources.filter((source) => ['xtream', 'm3u'].includes(String(source?.type || '').toLowerCase())).length
                        : null;
                } catch (_) { /* keep the non-blocking presentation */ }
            }
            this.renderProviderAccessNotice(notifications[0], {
                count: notifications.length,
                fullAttention: notifications[0]?.kind === 'access_hidden' && connectedSourceCount === 1,
            });
        } catch (_) {
            // Temporary fetch/auth/flag failures must never produce an access
            // warning. The durable row remains available for the next refresh.
        }
    }

    providerAccessNoticeCopy(kind) {
        return ({
            expiry_7d: ['Catalog access reminder', 'Your external provider access expires in 7 days. Your Norva plan is not affected.'],
            expiry_1d: ['Catalog access reminder', 'Your external provider access expires tomorrow. Your Norva plan is not affected.'],
            expiry_today: ['Catalog access reminder', 'Your external provider access expires today. Your Norva plan is not affected.'],
            access_hidden: ['Your catalog needs attention', 'Norva confirmed that your external provider access is unavailable. Your Norva plan is not affected.'],
            access_restored: ['Catalog access restored', 'Your external provider access is available again.'],
        })[kind] || null;
    }

    renderProviderAccessNotice(notification, { count = 1, fullAttention = false } = {}) {
        const copy = this.providerAccessNoticeCopy(notification?.kind);
        if (!copy || !notification?.notificationId) return;
        this.clearProviderAccessNotice();
        const host = document.createElement('section');
        host.id = 'provider-access-in-app-notice';
        host.className = `provider-access-in-app-notice${fullAttention ? ' is-full-attention' : ''}`;
        host.setAttribute('role', notification.kind === 'access_hidden' ? 'alert' : 'status');
        host.setAttribute('aria-live', notification.kind === 'access_hidden' ? 'assertive' : 'polite');
        host.setAttribute('aria-label', 'External provider access');
        host.innerHTML = `<div class="provider-access-in-app-card">
            <div class="provider-access-in-app-mark" aria-hidden="true"></div>
            <div class="provider-access-in-app-copy"><span>External provider access</span><strong></strong><p></p><small></small></div>
            <div class="provider-access-in-app-actions">
              <button type="button" class="btn btn-primary" data-provider-access-review>Review access</button>
              <button type="button" class="provider-access-in-app-dismiss" data-provider-access-dismiss aria-label="Dismiss this reminder">Dismiss</button>
            </div>
          </div>`;
        host.querySelector('strong').textContent = copy[0];
        host.querySelector('p').textContent = copy[1];
        const source = String(notification.sourceName || '').trim();
        host.querySelector('small').textContent = count > 1
            ? `${count} provider access notices need review.`
            : (source ? `Service: ${source}` : 'Open Settings to review this access.');
        const dismiss = async () => {
            host.querySelectorAll('button').forEach((button) => { button.disabled = true; });
            try { await window.API.providerAccess.dismissNotification(notification.notificationId); } catch (_) { /* durable row remains */ }
            host.remove();
            if (count > 1) this.refreshProviderAccessNotifications();
        };
        host.querySelector('[data-provider-access-dismiss]')?.addEventListener('click', dismiss);
        host.querySelector('[data-provider-access-review]')?.addEventListener('click', () => {
            this._settingsSubRoute = 'sources';
            this.navigateTo('settings');
            requestAnimationFrame(() => this.pages.settings?.switchTab?.('sources'));
            dismiss();
        });
        document.body.appendChild(host);
    }

    clearProviderAccessNotice() {
        document.getElementById('provider-access-in-app-notice')?.remove();
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
                // AdminPage.js is lazy-loaded (not an HTML <script>), so hash:assets cannot
                // rewrite it. Keep this value equal to the first 10 characters of the
                // file's canonical-LF SHA-256; the contract test fails if they drift apart.
                // Using the content hash here also gives the immutable CDN cache a new URL.
                s.src = '/js/pages/AdminPage.js?v=3b2373d41e';
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
            if (this.pages.home) {
                this.pages.home.cancelPendingLoad?.();
                this.pages.home.lastLoadedAt = 0; // force a refetch
            }
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

// Admin dialogs are created lazily and intentionally do not use the generic
// `.modal-overlay.active` contract handled by standalone.js. Consume native
// Android Back through their own Cancel control so the modal keeps ownership
// of inert cleanup, Promise resolution and exact focus restoration.
function closeAdminClientSheetForNativeBack() {
    const sheet = document.querySelector('#page-admin .client-sheet-layer.is-open');
    if (!sheet) return false;
    const closeButton = sheet.querySelector('[data-client-close]');
    if (!closeButton || typeof closeButton.click !== 'function') return true;
    closeButton.click();
    return true;
}

function closeAdminModalForNativeBack() {
    const modal = document.querySelector('#page-admin .crm-modal-back');
    if (!modal) return false;
    const cancelButton = modal.querySelector('button.cancel');
    if (!cancelButton || typeof cancelButton.click !== 'function') return true;
    cancelButton.click();
    return true;
}

const norvaHandleBackFallback = window.__norvaHandleBack;
window.__norvaHandleBack = function () {
    try {
        if (closeAdminClientSheetForNativeBack()) return 'handled';
        if (closeAdminModalForNativeBack()) return 'handled';
    } catch (_) { /* delegate to the established overlay / route contract */ }
    return typeof norvaHandleBackFallback === 'function'
        ? norvaHandleBackFallback()
        : 'exit';
};

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
