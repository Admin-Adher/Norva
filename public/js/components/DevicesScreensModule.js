/**
 * DevicesScreensModule — the app-owned Devices & Screens surface.
 *
 * SettingsPage is only the host. This module owns data loading, rendering,
 * device actions and the two local sheets while reusing PairTvSheet for the
 * security-sensitive TV approval flow.
 */
(function () {
    'use strict';

    const TV_STORE_URL = 'https://play.google.com/store/apps/details?id=tv.norva.tv';
    const WEB_URL = 'https://norva.tv';
    const READY_WINDOW_MS = 5 * 60 * 1000;

    const ICONS = Object.freeze({
        back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
        plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
        more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>',
        tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="19" height="14" rx="2.5"/><path d="M8 22h8M12 18v4"/></svg>',
        phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.7"/><path d="M10.5 18h3"/></svg>',
        tablet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2.5"/><path d="M11 18h2"/></svg>',
        web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.7 2.7 2.7 15.3 0 18M12 3c-2.7 2.7-2.7 15.3 0 18"/></svg>',
        screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="19" height="15" rx="2.5"/><path d="M8 22h8M12 18v4"/></svg>',
        cast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18a3 3 0 0 1 3 3M3 13a8 8 0 0 1 8 8M3 8a13 13 0 0 1 13 13"/><path d="M5 4h14a2 2 0 0 1 2 2v10"/></svg>',
        external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>',
        chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
        edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
        trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/></svg>',
        alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.7 2.5 17.2A2 2 0 0 0 4.2 20h15.6a2 2 0 0 0 1.7-2.8L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 8v5M12 17h.01"/></svg>',
        retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6v5h-5"/><path d="M18.5 15a7 7 0 1 1-1.8-8.2L20 10"/></svg>',
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'
    });

    class DevicesScreensAdapter {
        cloud() {
            return window.NorvaCloud || null;
        }

        getProfile() {
            const method = this.cloud()?.profile?.get;
            return typeof method === 'function'
                ? method()
                : Promise.reject(new Error('profile-unavailable'));
        }

        saveProfile(profile) {
            const method = this.cloud()?.profile?.save;
            return typeof method === 'function'
                ? method(profile)
                : Promise.reject(new Error('profile-save-unavailable'));
        }

        listDevices() {
            const method = this.cloud()?.devices?.list;
            return typeof method === 'function'
                ? method()
                : Promise.reject(new Error('devices-unavailable'));
        }

        revokeDevice(deviceId) {
            const method = this.cloud()?.devices?.revoke;
            return typeof method === 'function'
                ? method(deviceId)
                : Promise.reject(new Error('device-revoke-unavailable'));
        }

        sendCommand(payload) {
            const method = this.cloud()?.commands?.queue;
            return typeof method === 'function'
                ? method(payload)
                : Promise.reject(new Error('commands-unavailable'));
        }
    }

    class DevicesScreensModule {
        constructor(app, root, adapter = new DevicesScreensAdapter()) {
            this.app = app;
            this.root = root || null;
            this.adapter = adapter;
            this.devices = [];
            this.profileName = '';
            this.profileLoaded = false;
            this.profileError = false;
            this.loadError = '';
            this.hasLoaded = false;
            this.loading = false;
            this.active = false;
            this.bound = false;
            this.requestEpoch = 0;
            this.sheet = null;
            this.activeMenuTrigger = null;
            this.pendingRevoke = new Set();
            this.menuSerial = 0;

            this.onRootClick = this.onRootClick.bind(this);
            this.onDocumentClick = this.onDocumentClick.bind(this);
            this.onDocumentKeydown = this.onDocumentKeydown.bind(this);
            this.onOnline = this.onOnline.bind(this);
            this.onOffline = this.onOffline.bind(this);
            this.onDevicesChanged = this.onDevicesChanged.bind(this);
        }

        resolveRoot() {
            if (!this.root?.isConnected) this.root = document.getElementById('devices-screens-root');
            return this.root;
        }

        activate() {
            if (!this.resolveRoot()) return false;
            this.active = true;
            this.bind();
            if (!this.hasLoaded) this.renderLoading();
            void this.refresh();
            return true;
        }

        deactivate() {
            this.active = false;
            this.closeMenu(false);
            this.closeSheet();
        }

        dispose() {
            this.deactivate();
            this.requestEpoch += 1;
            if (!this.bound) return;
            this.root?.removeEventListener('click', this.onRootClick);
            document.removeEventListener('click', this.onDocumentClick);
            document.removeEventListener('keydown', this.onDocumentKeydown, true);
            window.removeEventListener('online', this.onOnline);
            window.removeEventListener('offline', this.onOffline);
            window.removeEventListener('norva:devices-changed', this.onDevicesChanged);
            this.bound = false;
        }

        bind() {
            if (this.bound || !this.root) return;
            this.root.addEventListener('click', this.onRootClick);
            document.addEventListener('click', this.onDocumentClick);
            document.addEventListener('keydown', this.onDocumentKeydown, true);
            window.addEventListener('online', this.onOnline);
            window.addEventListener('offline', this.onOffline);
            window.addEventListener('norva:devices-changed', this.onDevicesChanged);
            this.bound = true;
        }

        async refresh(options = {}) {
            if (!this.resolveRoot()) return false;
            const epoch = ++this.requestEpoch;
            this.loading = true;
            this.root.setAttribute('aria-busy', 'true');
            if (!this.hasLoaded) this.renderLoading();
            else this.announce((globalThis.NorvaI18n?.t("ui_web_29609edffee6", { defaultValue: "Refreshing your screens." }) ?? 'Refreshing your screens.'));

            const [profileResult, devicesResult] = await Promise.allSettled([
                this.adapter.getProfile(),
                this.adapter.listDevices()
            ]);
            if (epoch !== this.requestEpoch) return false;

            this.loading = false;
            this.hasLoaded = true;

            if (profileResult.status === 'fulfilled') {
                const profile = profileResult.value || {};
                this.profileName = String(profile.display_name || profile.displayName || '').trim();
                this.profileLoaded = true;
                this.profileError = false;
            } else {
                this.profileError = true;
            }

            if (devicesResult.status === 'fulfilled') {
                const payload = devicesResult.value || {};
                const listed = Array.isArray(payload.devices) ? payload.devices : [];
                this.devices = this.sortDevices(listed.filter((device) => device && !device.revoked));
                this.loadError = '';
            } else {
                this.loadError = this.offlineMessage();
            }

            this.render();
            if (options.announce) {
                this.announce(
                    this.loadError || (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_591fac029ef3", {defaultValue: "{{p0}} linked {{p1}} loaded.", p0:(this.devices.length),p1:(this.devices.length === 1 ? 'screen' : 'screens')}) : `${this.devices.length} linked ${this.devices.length === 1 ? 'screen' : 'screens'} loaded.`),
                    Boolean(this.loadError)
                );
            }
            return !this.loadError;
        }

        onOnline() {
            if (this.active) void this.refresh({ announce: true });
        }

        onOffline() {
            if (!this.active || !this.hasLoaded) return;
            this.loadError = this.offlineMessage();
            this.render();
            this.announce(this.loadError, true);
        }

        onDevicesChanged() {
            if (this.active) void this.refresh({ announce: true });
        }

        offlineMessage() {
            return typeof navigator !== 'undefined' && navigator.onLine === false
                ? (globalThis.NorvaI18n?.t("ui_web_3c3188a5bc85", { defaultValue: "You’re offline. Reconnect, then try again." }) ?? 'You’re offline. Reconnect, then try again.')
                : (globalThis.NorvaI18n?.t("ui_web_22b46e2382ac", { defaultValue: "Couldn’t load your screens. Check your connection and try again." }) ?? 'Couldn’t load your screens. Check your connection and try again.');
        }

        renderLoading() {
            if (!this.root) return;
            this.root.setAttribute('aria-busy', 'true');
            this.root.innerHTML = `
                ${this.mobileHeader()}
                <div class="devices-surface devices-loading" role="status" aria-label="Loading your screens" data-i18n-aria-label="ui_web_fac20460ac15">
                    <div class="devices-hero devices-skeleton-hero" aria-hidden="true">
                        <span class="devices-skeleton-line is-short"></span>
                        <span class="devices-skeleton-line is-title"></span>
                        <span class="devices-skeleton-line"></span>
                    </div>
                    <section class="devices-section" aria-hidden="true">
                        <span class="devices-skeleton-line is-heading"></span>
                        <div class="devices-skeleton-rows">
                            <span></span><span></span><span></span>
                        </div>
                    </section>
                    <span class="devices-loading-label" data-i18n="ui_web_69ee511ff450">Loading your screens…</span>
                </div>`;
        }

        render() {
            if (!this.root) return;
            const connected = this.devices.length > 0;
            const readyCount = this.devices.filter((device) => this.deviceStatus(device).ready).length;
            this.root.setAttribute('aria-busy', this.loading ? 'true' : 'false');
            this.root.innerHTML = `
                ${this.mobileHeader()}
                <div class="devices-surface">
                    ${this.hero(connected, readyCount)}
                    ${this.loadError ? this.errorBanner() : ''}
                    ${connected ? this.devicesSection() + this.watchElsewhere() : this.setupSection()}
                    ${this.accountSection()}
                </div>
                <p class="devices-announcement" role="status" aria-live="polite" aria-atomic="true"></p>`;
        }

        mobileHeader() {
            return `
                <header class="devices-mobile-header">
                    <button type="button" class="devices-back" data-devices-back aria-label="Back to Settings" data-i18n-aria-label="ui_web_ea37ec29c386">
                        ${ICONS.back}
                    </button>
                    <div><strong data-i18n="ui_web_4ba5121d4d1b">Devices</strong><span data-i18n="ui_web_9fc411249e5c">Your screens</span></div>
                </header>`;
        }

        hero(connected, readyCount) {
            const total = this.devices.length;
            let title = (globalThis.NorvaI18n?.t("ui_web_1270f5fcc87e", { defaultValue: "Start here. Watch everywhere." }) ?? 'Start here. Watch everywhere.');
            let copy = (globalThis.NorvaI18n?.t("ui_web_79ee712211a8", { defaultValue: "Install or open Norva on the TV, then pair it from this phone." }) ?? 'Install or open Norva on the TV, then pair it from this phone.');
            let summary = 'TV · web · mobile';
            let stateClass = '';

            if (connected) {
                const unavailable = total - readyCount;
                if (readyCount === total) title = (globalThis.NorvaI18n?.t("ui_web_9a5a4544b80a", { defaultValue: "Every screen, one Norva." }) ?? 'Every screen, one Norva.');
                else if (readyCount === 2 && unavailable === 1) title = (globalThis.NorvaI18n?.t("ui_web_b991b56403fe", { defaultValue: "Two ready. One needs you." }) ?? 'Two ready. One needs you.');
                else if (readyCount === 0) title = (globalThis.NorvaI18n?.t("ui_web_c3ef7a20be73", { defaultValue: "Your screens are waiting." }) ?? 'Your screens are waiting.');
                else title = `${readyCount} ready. ${unavailable === 1 ? (globalThis.NorvaI18n?.t("ui_web_a60a8ce9eea2", { defaultValue: "One needs you." }) ?? 'One needs you.') : (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_c3966db7bed1", {defaultValue: "{{p0}} need you.", p0:(unavailable)}) : `${unavailable} need you.`)}`;
                copy = (globalThis.NorvaI18n?.t("ui_web_f4bbd843f42a", { defaultValue: "Review your screens, pair another TV or send playback from one calm home." }) ?? 'Review your screens, pair another TV or send playback from one calm home.');
                summary = (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_89808c542cdf", {defaultValue: "{{p0}} of {{p1}} ready", p0:(readyCount),p1:(total)}) : `${readyCount} of ${total} ready`);
                stateClass = unavailable ? ' is-warning' : ' is-ready';
            } else if (this.loadError) {
                summary = (globalThis.NorvaI18n?.t("ui_web_6a416021e829", { defaultValue: "Screens unavailable" }) ?? 'Screens unavailable');
                stateClass = ' is-warning';
            }

            return `
                <section class="devices-hero" aria-labelledby="devices-hero-title">
                    <div class="devices-hero-kicker" data-i18n="ui_web_d7f7faab8a31">Norva everywhere</div>
                    <h1 id="devices-hero-title">${title}</h1>
                    <p>${copy}</p>
                    <div class="devices-hero-summary${stateClass}">
                        ${connected || this.loadError ? '<span class="devices-status-dot" aria-hidden="true"></span>' : ''}
                        <span>${summary}</span>
                    </div>
                </section>`;
        }

        errorBanner() {
            const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
            return `
                <div class="devices-error" role="alert">
                    <span class="devices-error-icon">${ICONS.alert}</span>
                    <span><strong>${offline ? (globalThis.NorvaI18n?.t("ui_web_58420f1c06d0", { defaultValue: "You’re offline" }) ?? 'You’re offline') : (globalThis.NorvaI18n?.t("ui_web_f6cf20b27de5", { defaultValue: "Couldn’t refresh your screens" }) ?? 'Couldn’t refresh your screens')}</strong><span>${this.escapeHtml(this.loadError)}</span></span>
                    <button type="button" data-devices-retry>${ICONS.retry}<span data-i18n="ui_web_942087cc2d41">Retry</span></button>
                </div>`;
        }

        devicesSection() {
            const featuredId = this.devices.find((device) => this.deviceKind(device) === 'tv')?.id
                || this.devices[0]?.id;
            return `
                <section class="devices-section" aria-labelledby="devices-list-title">
                    <div class="devices-section-header">
                        <h2 id="devices-list-title" data-i18n="ui_web_9fc411249e5c">Your screens</h2>
                        <button type="button" class="devices-section-link" data-devices-pair data-i18n="ui_web_e3a7e27d408a">Add TV</button>
                    </div>
                    <div class="devices-list">
                        ${this.devices.map((device) => this.deviceRow(device, device.id === featuredId)).join('')}
                    </div>
                </section>`;
        }

        deviceRow(device, featured) {
            const kind = this.deviceKind(device);
            const current = this.isCurrentDevice(device);
            const state = this.deviceStatus(device);
            const name = String(device.device_name || this.deviceTypeLabel(device));
            const id = String(device.id || '');
            return `
                <article class="devices-row${featured ? ' is-featured' : ''}${state.ready ? '' : ' is-offline'}"
                    data-device-row data-device-id="${this.escapeAttr(id)}">
                    <span class="devices-row-icon">${ICONS[kind] || ICONS.screen}</span>
                    <span class="devices-row-copy">
                        <span class="devices-row-name-line">
                            <span class="devices-status-dot" aria-hidden="true"></span>
                            <strong class="devices-row-name" title="${this.escapeAttr(name)}">${this.escapeHtml(name)}</strong>
                            ${current ? '<span class="devices-current-label" data-i18n="ui_web_d052579c6a31">This device</span>' : ''}
                        </span>
                        <span class="devices-row-meta">${this.escapeHtml(this.deviceTypeLabel(device))} · ${this.escapeHtml(state.label)}</span>
                    </span>
                    ${current ? '<span class="devices-row-action-spacer" aria-hidden="true"></span>' : `
                        <button type="button" class="devices-more" data-devices-menu="${this.escapeAttr(id)}"
                            aria-label="More actions for ${this.escapeAttr(name)}" aria-expanded="false" data-i18n-aria-label="ui_web_5c35909eae80" data-i18n-aria-label-args="${(globalThis.NorvaI18n?.args?.({"p1":(this.escapeAttr(name))}) || "{}")}">
                            ${ICONS.more}
                        </button>`}
                </article>`;
        }

        watchElsewhere() {
            return `
                <section class="devices-section" aria-labelledby="devices-watch-title">
                    <div class="devices-section-header"><h2 id="devices-watch-title" data-i18n="ui_web_e1898095d348">Watch elsewhere</h2></div>
                    <div class="devices-actions-list">
                        <button type="button" class="devices-action" data-devices-cast>
                            <span class="devices-action-icon">${ICONS.cast}</span>
                            <span class="devices-action-copy"><strong data-i18n="ui_web_69ae9601d442">Send a video link</strong><span data-i18n="ui_web_2915f2f2cb44">Play or open it on a trusted screen.</span></span>
                            <span class="devices-action-end">${ICONS.chevron}</span>
                        </button>
                        <a class="devices-action" href="${TV_STORE_URL}" target="_blank" rel="noopener noreferrer"
                            aria-label="Open Norva for Android TV on Google Play" data-i18n-aria-label="ui_web_22e7d6584d09">
                            <span class="devices-action-icon"><img src="/img/icons/google-play-mark.svg?v=1" alt=""></span>
                            <span class="devices-action-copy"><strong data-i18n="ui_web_ff7995057c90">Get the Android TV app</strong><span data-i18n="ui_web_7c7d0c03beea">Choose a compatible TV signed in to the same Google account.</span></span>
                            <span class="devices-action-end">${ICONS.external}</span>
                        </a>
                        <a class="devices-action" href="${WEB_URL}" target="_blank" rel="noopener noreferrer"
                            aria-label="Open norva.tv" data-i18n-aria-label="ui_web_5ce98c8ce766">
                            <span class="devices-action-icon">${ICONS.web}</span>
                            <span class="devices-action-copy"><strong data-i18n="ui_web_03f7e4d45ea9">Watch at norva.tv</strong><span data-i18n="ui_web_52a43f368ae2">Open a browser and sign in. No install.</span></span>
                            <span class="devices-action-end">${ICONS.external}</span>
                        </a>
                    </div>
                </section>`;
        }

        setupSection() {
            return `
                <section class="devices-setup" aria-labelledby="devices-setup-title">
                    <header class="devices-setup-header">
                        <h2 id="devices-setup-title" data-i18n="ui_web_ae6a5b475c28">Start on your TV</h2>
                        <p data-i18n="ui_web_40b4c25883b5">Two short steps. No password typing on the big screen.</p>
                    </header>
                    <div class="devices-steps">
                        <div class="devices-step">
                            <span class="devices-step-number" aria-hidden="true">1</span>
                            <span><strong data-i18n="ui_web_0eb74dd4e8a0">Open or install Norva</strong><span data-i18n="ui_web_c949707b5698">The TV shows a QR code and a short pairing code.</span></span>
                        </div>
                        <div class="devices-step">
                            <span class="devices-step-number" aria-hidden="true">2</span>
                            <span><strong data-i18n="ui_web_af6c31dc79cc">Approve this TV from your phone</strong><span data-i18n="ui_web_476febe7cb6c">Scan the QR or enter all six characters.</span></span>
                        </div>
                    </div>
                    <div class="devices-setup-actions">
                        <button type="button" class="btn btn-primary devices-setup-action" data-devices-pair>
                            ${ICONS.plus}<span data-i18n="ui_web_786037f7d592">Pair a TV</span>
                        </button>
                        <a class="btn btn-secondary devices-setup-action" href="${TV_STORE_URL}" target="_blank" rel="noopener noreferrer">
                            <img src="/img/icons/google-play-mark.svg?v=1" alt=""><span data-i18n="ui_web_54256245e4d1">Get TV app</span>
                        </a>
                    </div>
                    <p class="devices-play-note" data-i18n="ui_web_ed79dfdea5f3">Google Play can install Norva on a compatible TV signed in to the same Google account.</p>
                    <a class="devices-web-shortcut" href="${WEB_URL}" target="_blank" rel="noopener noreferrer">
                        <span class="devices-action-icon">${ICONS.web}</span>
                        <span class="devices-action-copy"><strong data-i18n="ui_web_1df5bad952ae">Prefer a browser?</strong><span data-i18n="ui_web_6fe468fdc6ca">Open norva.tv — nothing to install.</span></span>
                        <span class="devices-action-end">${ICONS.external}</span>
                    </a>
                </section>`;
        }

        accountSection() {
            const displayName = this.profileLoaded
                ? (this.profileName || (globalThis.NorvaI18n?.t("ui_web_f5b0ab819cc1", { defaultValue: "Norva account" }) ?? 'Norva account'))
                : (this.profileError ? (globalThis.NorvaI18n?.t("ui_web_c76c65bbcf32", { defaultValue: "Name unavailable" }) ?? 'Name unavailable') : (globalThis.NorvaI18n?.t("ui_web_ba3bbbe10d8b", { defaultValue: "Loading…" }) ?? 'Loading…'));
            return `
                <section class="devices-section" aria-labelledby="devices-account-title">
                    <div class="devices-section-header"><h2 id="devices-account-title" data-i18n="ui_web_dbb5f6371b6a">Your account</h2></div>
                    <div class="devices-account-row">
                        <span><span data-i18n="ui_web_a704d8d4a818">Account name</span><strong title="${this.escapeAttr(displayName)}">${this.escapeHtml(displayName)}</strong></span>
                        <button type="button" data-devices-edit-name data-i18n="ui_web_464c4ffd019e">Edit</button>
                    </div>
                    ${this.profileError ? '<p class="devices-account-hint" data-i18n="ui_web_84b4104ae36e">Couldn’t load the current name. You can still set a new one.</p>' : ''}
                </section>`;
        }

        onRootClick(event) {
            const target = event.target.closest('button, a');
            if (!target || !this.root?.contains(target)) return;

            if (target.matches('[data-devices-back]')) {
                this.app?.pages?.settings?.switchTab?.('account');
                document.getElementById('settings-tab-account')?.focus?.({ preventScroll: true });
                return;
            }
            if (target.matches('[data-devices-pair]')) {
                this.closeMenu(false);
                this.app?.openPairTvSheet?.(target, { force: true });
                return;
            }
            if (target.matches('[data-devices-retry]')) {
                void this.refresh({ announce: true });
                return;
            }
            if (target.matches('[data-devices-cast]')) {
                this.openCastSheet('', target);
                return;
            }
            if (target.matches('[data-devices-edit-name]')) {
                this.openNameSheet(target);
                return;
            }
            if (target.matches('[data-devices-menu]')) {
                this.openMenu(target, target.dataset.devicesMenu);
                return;
            }
            if (target.matches('[data-devices-cast-device]')) {
                const deviceId = target.dataset.devicesCastDevice;
                const opener = this.activeMenuTrigger;
                this.closeMenu(false);
                this.openCastSheet(deviceId, opener);
                return;
            }
            if (target.matches('[data-devices-remove]')) {
                const deviceId = target.dataset.devicesRemove;
                this.closeMenu(true);
                void this.removeDevice(deviceId);
            }
        }

        onDocumentClick(event) {
            if (!this.activeMenuTrigger) return;
            if (event.target.closest('.devices-menu') || event.target.closest('[data-devices-menu]')) return;
            this.closeMenu(false);
        }

        onDocumentKeydown(event) {
            if (event.key === 'Escape' && this.activeMenuTrigger) {
                event.preventDefault();
                event.stopPropagation();
                this.closeMenu(true);
            }
        }

        openMenu(trigger, deviceId) {
            if (!trigger || !deviceId) return;
            if (this.activeMenuTrigger === trigger) {
                this.closeMenu(true);
                return;
            }
            this.closeMenu(false);
            const row = trigger.closest('[data-device-row]');
            const device = this.deviceById(deviceId);
            if (!row || !device || this.isCurrentDevice(device)) return;

            const menuId = `devices-menu-${++this.menuSerial}`;
            trigger.setAttribute('aria-expanded', 'true');
            trigger.setAttribute('aria-controls', menuId);
            row.insertAdjacentHTML('beforeend', `
                <div class="devices-menu" id="${menuId}" role="menu" aria-label="Actions for ${this.escapeAttr(this.deviceName(device))}" data-i18n-aria-label="ui_web_69c393e5d3bf" data-i18n-aria-label-args="${(globalThis.NorvaI18n?.args?.({"p1":(this.escapeAttr(this.deviceName(device)))}) || "{}")}">
                    <button type="button" role="menuitem" data-devices-cast-device="${this.escapeAttr(deviceId)}">
                        ${ICONS.cast}<span data-i18n="ui_web_468da683a875">Send a link</span>
                    </button>
                    <button type="button" role="menuitem" class="is-danger" data-devices-remove="${this.escapeAttr(deviceId)}">
                        ${ICONS.trash}<span data-i18n="ui_web_9aca2712a92f">Remove screen</span>
                    </button>
                </div>`);
            this.activeMenuTrigger = trigger;
            row.querySelector('.devices-menu button')?.focus?.({ preventScroll: true });
        }

        closeMenu(restoreFocus) {
            const trigger = this.activeMenuTrigger;
            if (!trigger) return;
            trigger.setAttribute('aria-expanded', 'false');
            trigger.removeAttribute('aria-controls');
            trigger.closest('[data-device-row]')?.querySelector('.devices-menu')?.remove();
            this.activeMenuTrigger = null;
            if (restoreFocus) trigger.focus?.({ preventScroll: true });
        }

        async removeDevice(deviceId) {
            const device = this.deviceById(deviceId);
            if (!device || this.pendingRevoke.has(deviceId)) return false;
            const name = this.deviceName(device);
            const confirmed = await window.NorvaModal?.confirm?.(
                (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_78dab4366179", {defaultValue: "{{p0}} will lose access to this Norva account. It must be paired again to reconnect.", p0:(name)}) : `${name} will lose access to this Norva account. It must be paired again to reconnect.`),
                { title: (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_5da74e0f0265", {defaultValue: "Remove {{p0}}?", p0:(name)}) : `Remove ${name}?`), confirmLabel: (globalThis.NorvaI18n?.t("ui_web_9aca2712a92f", { defaultValue: "Remove screen" }) ?? 'Remove screen'), cancelLabel: (globalThis.NorvaI18n?.t("ui_web_3a527a238a7c", { defaultValue: "Keep screen" }) ?? 'Keep screen'), danger: true }
            );
            if (!confirmed) return false;

            this.pendingRevoke.add(deviceId);
            const row = this.root?.querySelector(`[data-device-id="${this.escapeSelector(deviceId)}"]`);
            row?.setAttribute('aria-busy', 'true');
            try {
                await this.adapter.revokeDevice(deviceId);
                if (this.isCurrentDevice(device)) this.clearCurrentDeviceToken();
                this.devices = this.devices.filter((item) => String(item.id) !== String(deviceId));
                this.render();
                this.announce((globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_b2fc951e2f57", {defaultValue: "{{p0}} removed.", p0:(name)}) : `${name} removed.`));
                this.toast((globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_b2fc951e2f57", {defaultValue: "{{p0}} removed.", p0:(name)}) : `${name} removed.`), 'success');
                return true;
            } catch (_) {
                row?.removeAttribute('aria-busy');
                this.announce((globalThis.NorvaI18n?.t("ui_web_a67f76f09a9d", { defaultValue: "Could not remove this screen. Try again." }) ?? 'Could not remove this screen. Try again.'), true);
                this.toast((globalThis.NorvaI18n?.t("ui_web_a67f76f09a9d", { defaultValue: "Could not remove this screen. Try again." }) ?? 'Could not remove this screen. Try again.'), 'error');
                return false;
            } finally {
                this.pendingRevoke.delete(deviceId);
            }
        }

        openNameSheet(opener) {
            const overlay = this.createSheet({
                title: (globalThis.NorvaI18n?.t("ui_web_a704d8d4a818", { defaultValue: "Account name" }) ?? 'Account name'),
                description: (globalThis.NorvaI18n?.t("ui_web_a685a5cf661a", { defaultValue: "This label helps identify your Norva home." }) ?? 'This label helps identify your Norva home.'),
                icon: ICONS.edit,
                body: `
                    <form class="devices-sheet-form" data-devices-name-form novalidate>
                        <label for="devices-account-name" data-i18n="ui_web_dcd1d5223f73">Name</label>
                        <input id="devices-account-name" type="text" maxlength="80" autocomplete="name"
                            value="${this.escapeAttr(this.profileName)}" placeholder="Norva home" data-i18n-placeholder="ui_web_1a123bf0fced">
                        <p class="devices-sheet-status" role="status" aria-live="polite" aria-atomic="true"></p>
                        <button type="submit" class="btn btn-primary devices-sheet-primary" data-i18n="ui_web_b7297226fd1f">Save name</button>
                    </form>`,
                initialFocus: '#devices-account-name',
                opener
            });
            const form = overlay?.querySelector('[data-devices-name-form]');
            form?.addEventListener('submit', (event) => {
                event.preventDefault();
                void this.saveName(form);
            });
        }

        async saveName(form) {
            if (!form || form.dataset.busy === '1') return false;
            const input = form.querySelector('#devices-account-name');
            const button = form.querySelector('button[type="submit"]');
            const status = form.querySelector('.devices-sheet-status');
            const name = String(input?.value || '').trim().slice(0, 80);
            form.dataset.busy = '1';
            if (button) {
                button.disabled = true;
                button.setAttribute('aria-busy', 'true');
                button.textContent = (globalThis.NorvaI18n?.t("ui_web_23e39291d613", { defaultValue: "Saving…" }) ?? 'Saving…');
            }
            this.setSheetStatus(status, (globalThis.NorvaI18n?.t("ui_web_975335b4e66c", { defaultValue: "Saving your account name." }) ?? 'Saving your account name.'));
            try {
                await this.adapter.saveProfile({ displayName: name, locale: navigator.language || 'en-US' });
                this.profileName = name;
                this.profileLoaded = true;
                this.profileError = false;
                this.closeSheet();
                this.render();
                this.announce((globalThis.NorvaI18n?.t("ui_web_08e204d0ad54", { defaultValue: "Account name saved." }) ?? 'Account name saved.'));
                this.toast((globalThis.NorvaI18n?.t("ui_web_08e204d0ad54", { defaultValue: "Account name saved." }) ?? 'Account name saved.'), 'success');
                return true;
            } catch (_) {
                form.dataset.busy = '0';
                if (button) {
                    button.disabled = false;
                    button.removeAttribute('aria-busy');
                    button.textContent = (globalThis.NorvaI18n?.t("ui_web_b7297226fd1f", { defaultValue: "Save name" }) ?? 'Save name');
                }
                this.setSheetStatus(status, (globalThis.NorvaI18n?.t("ui_web_787bc661ebf6", { defaultValue: "Could not save the account name. Try again." }) ?? 'Could not save the account name. Try again.'), true);
                input?.focus?.({ preventScroll: true });
                return false;
            }
        }

        openCastSheet(preselectedDeviceId, opener) {
            if (!this.devices.length) {
                this.toast((globalThis.NorvaI18n?.t("ui_web_8bb3683b50bc", { defaultValue: "Pair a screen before sending a link." }) ?? 'Pair a screen before sending a link.'), 'info');
                return false;
            }
            const preferred = this.deviceById(preselectedDeviceId)
                || this.devices.find((device) => this.deviceStatus(device).ready)
                || this.devices[0];
            const options = this.devices.map((device) => {
                const selected = String(device.id) === String(preferred?.id) ? ' selected' : '';
                const label = `${this.deviceName(device)} · ${this.deviceStatus(device).label}`;
                return `<option value="${this.escapeAttr(device.id)}"${selected}>${this.escapeHtml(label)}</option>`;
            }).join('');
            const overlay = this.createSheet({
                title: (globalThis.NorvaI18n?.t("ui_web_69ae9601d442", { defaultValue: "Send a video link" }) ?? 'Send a video link'),
                description: (globalThis.NorvaI18n?.t("ui_web_b8e8732d3249", { defaultValue: "Open or start playback on a trusted screen." }) ?? 'Open or start playback on a trusted screen.'),
                icon: ICONS.cast,
                body: `
                    <form class="devices-sheet-form" data-devices-cast-form novalidate>
                        <label for="devices-cast-target" data-i18n="ui_web_6e56137e21d3">Screen</label>
                        <select id="devices-cast-target">${options}</select>
                        <label for="devices-cast-title"><norva-i18n data-i18n="ui_web_7e8cd2056da7">Title </norva-i18n><span data-i18n="ui_web_ec91fdd9256c">optional</span></label>
                        <input id="devices-cast-title" type="text" maxlength="120" autocomplete="off" placeholder="Norva">
                        <label for="devices-cast-url" data-i18n="ui_web_1569cde90525">Video link</label>
                        <input id="devices-cast-url" type="url" inputmode="url" autocomplete="url" placeholder="https://…">
                        <p class="devices-sheet-helper" data-i18n="ui_web_f67fe1942c21">A link is required for playback. Leave it empty and choose Open Norva to open the app home.</p>
                        <p class="devices-sheet-status" role="status" aria-live="polite" aria-atomic="true"></p>
                        <div class="devices-sheet-actions">
                            <button type="submit" class="btn btn-primary" data-i18n="ui_web_f53036e59e50">Play on screen</button>
                            <button type="button" class="btn btn-secondary" data-devices-command-open data-i18n="ui_web_58b4fd1126eb">Open Norva</button>
                        </div>
                    </form>`,
                initialFocus: '#devices-cast-url',
                opener
            });
            const form = overlay?.querySelector('[data-devices-cast-form]');
            form?.addEventListener('submit', (event) => {
                event.preventDefault();
                void this.sendCommand(form, 'play');
            });
            overlay?.querySelector('[data-devices-command-open]')?.addEventListener('click', () => {
                void this.sendCommand(form, 'open');
            });
            return true;
        }

        async sendCommand(form, command) {
            if (!form || form.dataset.busy === '1') return false;
            const targetDeviceId = String(form.querySelector('#devices-cast-target')?.value || '');
            const url = String(form.querySelector('#devices-cast-url')?.value || '').trim();
            const title = String(form.querySelector('#devices-cast-title')?.value || '').trim() || 'Norva';
            const status = form.querySelector('.devices-sheet-status');
            const target = this.deviceById(targetDeviceId);
            if (!target) {
                this.setSheetStatus(status, (globalThis.NorvaI18n?.t("ui_web_277008009bbb", { defaultValue: "Choose a trusted screen." }) ?? 'Choose a trusted screen.'), true);
                return false;
            }
            if (command === 'play' && !url) {
                this.setSheetStatus(status, (globalThis.NorvaI18n?.t("ui_web_bea4d83b0915", { defaultValue: "Enter the video link you want to play." }) ?? 'Enter the video link you want to play.'), true);
                form.querySelector('#devices-cast-url')?.focus?.({ preventScroll: true });
                return false;
            }
            if (url && !this.isSafeWebUrl(url)) {
                this.setSheetStatus(status, (globalThis.NorvaI18n?.t("ui_web_a45158d129ba", { defaultValue: "Enter a complete http or https link." }) ?? 'Enter a complete http or https link.'), true);
                form.querySelector('#devices-cast-url')?.focus?.({ preventScroll: true });
                return false;
            }

            form.dataset.busy = '1';
            const buttons = [...form.querySelectorAll('button')];
            buttons.forEach((button) => { button.disabled = true; });
            const activeButton = command === 'play'
                ? form.querySelector('button[type="submit"]')
                : form.querySelector('[data-devices-command-open]');
            activeButton?.setAttribute('aria-busy', 'true');
            this.setSheetStatus(status, command === 'play' ? (globalThis.NorvaI18n?.t("ui_web_47a3aad45fb5", { defaultValue: "Sending the link." }) ?? 'Sending the link.') : (globalThis.NorvaI18n?.t("ui_web_aae6231152c4", { defaultValue: "Opening Norva on the screen." }) ?? 'Opening Norva on the screen.'));

            try {
                await this.adapter.sendCommand({
                    targetDeviceId,
                    command,
                    payload: command === 'play'
                        ? { url, playbackUrl: url, title }
                        : { url: url || '/' },
                    ttlSeconds: 120
                });
                const name = this.deviceName(target);
                this.closeSheet();
                this.announce(command === 'play' ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_f3389246ff32", {defaultValue: "Link sent to {{p0}}.", p0:(name)}) : `Link sent to ${name}.`) : (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_b1f488c0a10d", {defaultValue: "Norva opened on {{p0}}.", p0:(name)}) : `Norva opened on ${name}.`));
                this.toast(command === 'play' ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_f3389246ff32", {defaultValue: "Link sent to {{p0}}.", p0:(name)}) : `Link sent to ${name}.`) : (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_b1f488c0a10d", {defaultValue: "Norva opened on {{p0}}.", p0:(name)}) : `Norva opened on ${name}.`), 'success');
                return true;
            } catch (_) {
                form.dataset.busy = '0';
                buttons.forEach((button) => { button.disabled = false; });
                activeButton?.removeAttribute('aria-busy');
                this.setSheetStatus(status, (globalThis.NorvaI18n?.t("ui_web_6c74e32bf841", { defaultValue: "Could not reach this screen. Check that it is online and try again." }) ?? 'Could not reach this screen. Check that it is online and try again.'), true);
                return false;
            }
        }

        createSheet({ title, description, icon, body, initialFocus, opener }) {
            this.closeSheet();
            const overlay = document.createElement('div');
            overlay.className = 'devices-sheet-overlay active';
            overlay.innerHTML = `
                <section class="devices-sheet" role="dialog" aria-modal="true"
                    aria-labelledby="devices-sheet-title" aria-describedby="devices-sheet-description" tabindex="-1">
                    <div class="devices-sheet-handle" aria-hidden="true"></div>
                    <header class="devices-sheet-header">
                        <span class="devices-sheet-icon">${icon}</span>
                        <span><h2 id="devices-sheet-title">${this.escapeHtml(title)}</h2><p id="devices-sheet-description">${this.escapeHtml(description)}</p></span>
                        <button type="button" class="devices-sheet-close" data-devices-close-sheet aria-label="Close ${this.escapeAttr(title)}" data-i18n-aria-label="ui_web_66d27b78bb70" data-i18n-aria-label-args="${(globalThis.NorvaI18n?.args?.({"p3":(this.escapeAttr(title))}) || "{}")}">${ICONS.close}</button>
                    </header>
                    ${body}
                </section>`;
            document.body.appendChild(overlay);
            this.sheet = overlay;
            const closeButton = overlay.querySelector('[data-devices-close-sheet]');
            closeButton?.addEventListener('click', () => this.closeSheet());
            try { opener?.focus?.({ preventScroll: true }); } catch (_) { /* best effort */ }
            const focusTarget = overlay.querySelector(initialFocus) || overlay.querySelector('.devices-sheet');
            window.NorvaModal?.installHygiene?.(overlay, {
                onClose: () => this.closeSheet(),
                initialFocus: focusTarget
            });
            if (!window.NorvaModal?.installHygiene) focusTarget?.focus?.({ preventScroll: true });
            return overlay;
        }

        closeSheet() {
            const overlay = this.sheet;
            if (!overlay) return false;
            this.sheet = null;
            overlay.classList.remove('active');
            overlay.setAttribute('aria-hidden', 'true');
            overlay.setAttribute('inert', '');
            overlay.inert = true;
            window.setTimeout(() => overlay.remove(), 300);
            return true;
        }

        setSheetStatus(element, message, error = false) {
            if (!element) return;
            element.textContent = message || '';
            element.classList.toggle('is-error', error);
            element.setAttribute('role', error ? 'alert' : 'status');
            element.setAttribute('aria-live', error ? 'assertive' : 'polite');
        }

        announce(message, error = false) {
            const element = this.root?.querySelector('.devices-announcement');
            if (!element) return;
            element.textContent = message || '';
            element.setAttribute('role', error ? 'alert' : 'status');
            element.setAttribute('aria-live', error ? 'assertive' : 'polite');
        }

        toast(message, type) {
            window.NorvaModal?.toast?.(message, type);
        }

        sortDevices(devices) {
            const currentId = this.currentDeviceId();
            return [...devices].sort((left, right) => {
                const leftKind = this.deviceKind(left);
                const rightKind = this.deviceKind(right);
                const leftRank = leftKind === 'tv' ? 0 : String(left.id) === currentId ? 1 : 2;
                const rightRank = rightKind === 'tv' ? 0 : String(right.id) === currentId ? 1 : 2;
                if (leftRank !== rightRank) return leftRank - rightRank;
                return this.deviceTimestamp(right) - this.deviceTimestamp(left);
            });
        }

        deviceById(deviceId) {
            return this.devices.find((device) => String(device.id) === String(deviceId)) || null;
        }

        deviceName(device) {
            return String(device?.device_name || this.deviceTypeLabel(device || {}));
        }

        deviceKind(device) {
            const hint = `${device?.device_type || ''} ${device?.platform || ''} ${device?.device_name || ''}`.toLowerCase();
            if (/\btv\b|androidtv|android tv|firetv|fire tv|tvos|appletv|apple tv|chromecast|cast|roku|webos|tizen|bravia/.test(hint)) return 'tv';
            if (/tablet|ipad/.test(hint)) return 'tablet';
            if (/phone|android|iphone|ios|mobile/.test(hint)) return 'phone';
            if (/web|browser|chrome|firefox|safari|edge|desktop|windows|mac|linux/.test(hint)) return 'web';
            return 'screen';
        }

        deviceTypeLabel(device) {
            switch (this.deviceKind(device)) {
                case 'tv': return (globalThis.NorvaI18n?.t("ui_web_f73ea1e23239", { defaultValue: "Android TV" }) ?? 'Android TV');
                case 'phone': return (globalThis.NorvaI18n?.t("ui_web_fae4ea529229", { defaultValue: "Android phone" }) ?? 'Android phone');
                case 'tablet': return (globalThis.NorvaI18n?.t("ui_web_e34a879c8b8b", { defaultValue: "Tablet" }) ?? 'Tablet');
                case 'web': return (globalThis.NorvaI18n?.t("ui_web_21d699ed42e3", { defaultValue: "Web browser" }) ?? 'Web browser');
                default: return (globalThis.NorvaI18n?.t("ui_web_6e56137e21d3", { defaultValue: "Screen" }) ?? 'Screen');
            }
        }

        deviceTimestamp(device) {
            const value = new Date(device?.last_seen_at || '').getTime();
            return Number.isFinite(value) ? value : 0;
        }

        deviceStatus(device, now = Date.now()) {
            if (this.isCurrentDevice(device)) return { ready: true, label: (globalThis.NorvaI18n?.t("ui_web_5324f0efd808", { defaultValue: "Active on this device" }) ?? 'Active on this device') };
            const timestamp = this.deviceTimestamp(device);
            if (!timestamp) return { ready: false, label: (globalThis.NorvaI18n?.t("ui_web_898569356612", { defaultValue: "Not connected yet" }) ?? 'Not connected yet') };
            const age = Math.max(0, now - timestamp);
            if (age <= READY_WINDOW_MS) return { ready: true, label: (globalThis.NorvaI18n?.t("ui_web_b9537ec73a25", { defaultValue: "Online now" }) ?? 'Online now') };
            return { ready: false, label: (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_418fadd13500", {defaultValue: "Last seen {{p0}}", p0:(this.relativeTime(timestamp, now))}) : `Last seen ${this.relativeTime(timestamp, now)}`) };
        }

        relativeTime(timestamp, now = Date.now()) {
            const age = Math.max(0, now - Number(timestamp || 0));
            const minutes = Math.floor(age / 60000);
            if (minutes < 1) return (globalThis.NorvaI18n?.t("ui_web_7ddb44d8a533", { defaultValue: "just now" }) ?? 'just now');
            if (minutes < 60) return (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_23c5964926a1", {defaultValue: "{{p0}} min ago", p0:(minutes)}) : `${minutes} min ago`);
            const hours = Math.floor(minutes / 60);
            if (hours < 24) return (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_f1f497484232", {defaultValue: "{{p0}} h ago", p0:(hours)}) : `${hours} h ago`);
            const days = Math.floor(hours / 24);
            if (days < 7) return (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_d8562d2341f6", {defaultValue: "{{p0}} d ago", p0:(days)}) : `${days} d ago`);
            const weeks = Math.floor(days / 7);
            if (weeks < 5) return (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_c17f522832fc", {defaultValue: "{{p0}} wk ago", p0:(weeks)}) : `${weeks} wk ago`);
            return new Date(timestamp).toLocaleDateString((globalThis.NorvaI18n?.language || 'en-US'));
        }

        currentDeviceId() {
            try { return String(localStorage.getItem('norva-cloud-device-id') || ''); }
            catch (_) { return ''; }
        }

        isCurrentDevice(device) {
            const currentId = this.currentDeviceId();
            return Boolean(currentId && String(device?.id || '') === currentId);
        }

        clearCurrentDeviceToken() {
            try {
                window.NorvaCloud?.setDeviceToken?.('');
                localStorage.removeItem('norva-cloud-device-id');
            } catch (_) { /* best effort */ }
        }

        isSafeWebUrl(value) {
            try {
                const parsed = new URL(value);
                return parsed.protocol === 'https:' || parsed.protocol === 'http:';
            } catch (_) {
                return false;
            }
        }

        escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, (character) => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[character]));
        }

        escapeAttr(value) {
            return this.escapeHtml(value);
        }

        escapeSelector(value) {
            if (window.CSS?.escape) return window.CSS.escape(String(value));
            return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        }
    }

    window.DevicesScreensAdapter = DevicesScreensAdapter;
    window.DevicesScreensModule = DevicesScreensModule;
})();
