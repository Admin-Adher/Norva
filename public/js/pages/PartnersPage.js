/**
 * Norva Partners — authenticated individual partner journey.
 *
 * Visibility and every displayed policy fact come from the strictly validated
 * norva-partners contracts. KYC, programme eligibility, link activation and all
 * financial reporting remain authoritative on the server.
 */
class PartnersPage {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('page-partners');
        this.bootstrapEnvelope = null;
        this._bootstrapPromise = null;
        this._visibilityPromise = null;
        this._showAbort = null;
        this._showToken = 0;
        this._visible = false;
        this._opener = null;
        this._visibilityTimeoutMs = 4500;
        this._showTimeoutMs = 10000;
        this._bootstrapTtlMs = 30000;
        this._sessionIdentityKey = '';
        this._jurisdiction = { countryCode: '', subdivisionCode: '' };
        this._actionKeys = new Map();
        this._dashboardAbort = null;
        this._payoutAbort = null;
        this._payoutProfile = null;
        this._dashboardFilter = 'all';
        this._dashboardCursor = null;
        this._dashboardPages = [];
        this._nativeShareRequests = new Map();
        this._nativeShareListenerBound = false;
        this._tvRelayAbort = null;
        this._tvRelayPollTimer = 0;
        this._tvRelay = null;
        this._tvRelayCreateKey = '';
    }

    canUseUserPartners() {
        const user = this.app?.currentUser || {};
        return Boolean(
            user.cloud
            && !user.device
            && window.NorvaCloud?.partners
            && typeof window.NorvaCloud.partners.bootstrap === 'function'
        );
    }

    canUseTvPartners() {
        const user = this.app?.currentUser || {};
        const device = window.NorvaCloud?.partners?.device;
        return Boolean(
            user.cloud
            && user.device
            && (this.app?.isTvMode?.()
                || /NorvaTV-AndroidTV/i.test(navigator.userAgent || ''))
            && device
            && typeof device.availability === 'function'
            && typeof device.createRelay === 'function'
            && typeof device.relayStatus === 'function'
        );
    }

    canUsePartners() {
        return this.canUseUserPartners() || this.canUseTvPartners();
    }

    rememberOpener(opener) {
        const accountSheet = opener?.closest?.('#account-sheet');
        this._opener = accountSheet
            ? document.getElementById('nav-account')
            : (opener?.isConnected ? opener : null);
    }

    getScrollElement() {
        return this.container?.querySelector('.partners-shell') || this.container || null;
    }

    setEntryVisibility(visible) {
        const allowed = Boolean(visible) && this.canUsePartners();
        const settingsRow = document.getElementById('settings-partners-row');
        if (settingsRow) {
            settingsRow.hidden = !allowed;
            settingsRow.setAttribute('aria-hidden', allowed ? 'false' : 'true');
        }
        const accountRow = document.querySelector('#account-sheet [data-act="partners"]');
        if (accountRow) {
            accountRow.hidden = !allowed;
            accountRow.setAttribute('aria-hidden', allowed ? 'false' : 'true');
        }
        return allowed;
    }

    sessionIdentityKey() {
        const token = String(window.NorvaCloud?.token || '');
        if (!token) return 'no-session';
        let material = token;
        try {
            const payloadPart = token.split('.')[1] || '';
            const padded = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
                .padEnd(Math.ceil(payloadPart.length / 4) * 4, '=');
            const payload = JSON.parse(atob(padded));
            if (payload?.sub) material = `${payload.sub}|${payload.session_id || token}`;
        } catch (_) { /* opaque non-JWT tokens are fingerprinted as-is */ }
        let hash = 2166136261;
        for (let index = 0; index < material.length; index += 1) {
            hash ^= material.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `${material.length}:${(hash >>> 0).toString(16)}`;
    }

    ensureSessionContext() {
        const sessionKey = this.sessionIdentityKey();
        if (this._sessionIdentityKey && this._sessionIdentityKey !== sessionKey) {
            this.bootstrapEnvelope = null;
            this._bootstrapPromise = null;
            this._visibilityPromise = null;
            this._jurisdiction = { countryCode: '', subdivisionCode: '' };
        }
        this._sessionIdentityKey = sessionKey;
        return sessionKey;
    }

    normalizeJurisdiction(countryCode, subdivisionCode) {
        return {
            countryCode: String(countryCode || '').trim().toUpperCase(),
            subdivisionCode: String(subdivisionCode || '').trim().toUpperCase()
        };
    }

    jurisdictionIsValid({ countryCode, subdivisionCode }, { countryRequired = false } = {}) {
        if (countryRequired && !/^[A-Z]{2}$/.test(countryCode)) return false;
        if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) return false;
        if (subdivisionCode && !countryCode) return false;
        if (subdivisionCode && (
            subdivisionCode.length > 12
            || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(subdivisionCode)
            || (countryCode
                && subdivisionCode.includes('-')
                && subdivisionCode.split('-')[0] !== countryCode)
        )) return false;
        return true;
    }

    bootstrapCacheKey(sessionKey, jurisdiction) {
        return `${sessionKey}|${jurisdiction.countryCode}|${jurisdiction.subdivisionCode}`;
    }

    async loadBootstrap({
        force = false,
        signal,
        countryCode,
        subdivisionCode
    } = {}) {
        if (!this.canUseUserPartners()) {
            const error = new Error('Norva Partners requires a signed-in cloud account.');
            error.code = 'partners_user_session_required';
            throw error;
        }
        const sessionKey = this.ensureSessionContext();
        const jurisdiction = this.normalizeJurisdiction(
            countryCode ?? this._jurisdiction.countryCode,
            subdivisionCode ?? this._jurisdiction.subdivisionCode
        );
        if (!this.jurisdictionIsValid(jurisdiction)) {
            const error = new Error('The jurisdiction code is invalid.');
            error.code = 'partners_jurisdiction_invalid';
            throw error;
        }
        const cacheKey = this.bootstrapCacheKey(sessionKey, jurisdiction);
        const cached = this.bootstrapEnvelope;
        if (!force
            && cached?.key === cacheKey
            && Date.now() - cached.cachedAt <= this._bootstrapTtlMs) {
            return cached.envelope;
        }
        if (!force
            && !signal
            && this._bootstrapPromise?.key === cacheKey) {
            return this._bootstrapPromise.promise;
        }

        const request = window.NorvaCloud.partners.bootstrap({
            countryCode: jurisdiction.countryCode || undefined,
            subdivisionCode: jurisdiction.subdivisionCode || undefined,
            signal
        })
            .then((envelope) => {
                if (this.sessionIdentityKey() === sessionKey) {
                    this.bootstrapEnvelope = {
                        key: cacheKey,
                        cachedAt: Date.now(),
                        envelope
                    };
                }
                return envelope;
            })
            .finally(() => {
                if (this._bootstrapPromise?.promise === request) this._bootstrapPromise = null;
            });
        // Requests with a caller-owned AbortSignal must not be shared: a short
        // visibility timeout must never cancel the longer foreground page load.
        if (!signal) this._bootstrapPromise = { key: cacheKey, promise: request };
        return request;
    }

    async primeVisibility() {
        if (this._visibilityPromise) return this._visibilityPromise;
        const request = this._primeVisibilityOnce()
            .finally(() => {
                if (this._visibilityPromise === request) this._visibilityPromise = null;
            });
        this._visibilityPromise = request;
        return request;
    }

    async _primeVisibilityOnce() {
        if (this.canUseTvPartners()) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this._visibilityTimeoutMs);
            try {
                const envelope = await window.NorvaCloud.partners.device.availability({
                    signal: controller.signal
                });
                return this.setEntryVisibility(
                    envelope.data.availability.enabled === true
                );
            } catch (_) {
                this.setEntryVisibility(false);
                return false;
            } finally {
                clearTimeout(timeout);
            }
        }
        if (!this.canUseUserPartners()) {
            this.setEntryVisibility(false);
            return false;
        }
        this.ensureSessionContext();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this._visibilityTimeoutMs);
        try {
            const envelope = await this.loadBootstrap({
                signal: controller.signal,
                ...this._jurisdiction
            });
            return this.setEntryVisibility(envelope.data.visibility.visible === true);
        } catch (_) {
            // Fail closed: a missing, invalid or unavailable bootstrap never
            // reveals a dormant programme entry.
            this.setEntryVisibility(false);
            return false;
        } finally {
            clearTimeout(timeout);
        }
    }

    async show(options = {}) {
        if (this.canUseTvPartners()) {
            await this.showTvRelay();
            return;
        }
        const returnedFromKyc = this.app?.consumePartnersKycReturnNotice?.() === true;
        this.ensureSessionContext();
        const jurisdiction = this.normalizeJurisdiction(
            options.countryCode ?? this._jurisdiction.countryCode,
            options.subdivisionCode ?? this._jurisdiction.subdivisionCode
        );
        this._visible = true;
        const token = ++this._showToken;
        this._showAbort?.abort();
        this._showAbort = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
            if (this._visible && token === this._showToken) {
                timedOut = true;
                this._showAbort?.abort();
            }
        }, this._showTimeoutMs);
        this.renderLoading();

        if (!this.canUseUserPartners()) {
            clearTimeout(timeout);
            this.setEntryVisibility(false);
            this.renderUnavailable({
                title: 'Norva Partners is not available here',
                copy: 'Open Norva with your signed-in cloud account on the Web or Android mobile app.',
                tone: 'neutral'
            });
            return;
        }

        try {
            const envelope = await this.loadBootstrap({
                // Every foreground entry revalidates server flags, eligibility
                // and account state. The short cache exists only to keep
                // background visibility probes inexpensive.
                force: true,
                signal: this._showAbort.signal,
                ...jurisdiction
            });
            if (!this._visible || token !== this._showToken) return;
            this._jurisdiction = jurisdiction;
            this.setEntryVisibility(envelope.data.visibility.visible === true);
            this.renderBootstrap(envelope.data);
            if (returnedFromKyc) {
                window.NorvaModal?.toast?.(
                    'Identity check submitted. Norva is confirming the signed provider result.',
                    'success'
                );
            }
        } catch (error) {
            if (!this._visible || token !== this._showToken) return;
            if (error?.name === 'AbortError' && !timedOut) return;
            this.setEntryVisibility(false);
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                this.renderUnavailable({
                    title: 'You are offline',
                    copy: 'Reconnect to securely check whether Norva Partners is available for your account.',
                    tone: 'offline',
                    retry: true
                });
                return;
            }
            this.renderUnavailable({
                title: 'Partners is temporarily unavailable',
                copy: 'Norva could not verify the programme state. No action was taken. Try again in a moment.',
                tone: 'error',
                retry: true
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    hide() {
        this._closeCountryPicker?.({ restoreFocus: false });
        this._closeCountryPicker = null;
        this._dashboardAbort?.abort();
        this._dashboardAbort = null;
        this._payoutAbort?.abort();
        this._payoutAbort = null;
        this.stopTvRelayPolling();
        this._nativeShareRequests.forEach(({ reject, timer }) => {
            clearTimeout(timer);
            reject?.(new Error('partners_share_cancelled'));
        });
        this._nativeShareRequests.clear();
        this._visible = false;
        this._showToken += 1;
        this._showAbort?.abort();
        this._showAbort = null;
        const opener = this._opener;
        this._opener = null;
        if (opener?.isConnected) {
            requestAnimationFrame(() => {
                try { opener.focus({ preventScroll: true }); } catch (_) { opener.focus?.(); }
            });
        }
    }

    goBack() {
        if ((this.app?._histIdx || 0) > 0) {
            history.back();
            return;
        }
        this.app?.navigateTo?.('settings', true);
    }

    reload() {
        this.bootstrapEnvelope = null;
        if (this.canUseTvPartners()) {
            this.showTvRelay({ forceAvailability: true });
            return;
        }
        this.show();
    }

    stopTvRelayPolling() {
        if (this._tvRelayPollTimer) clearTimeout(this._tvRelayPollTimer);
        this._tvRelayPollTimer = 0;
        this._tvRelayAbort?.abort();
        this._tvRelayAbort = null;
    }

    async showTvRelay({ forceAvailability = false } = {}) {
        this._visible = true;
        const token = ++this._showToken;
        this.stopTvRelayPolling();
        this._tvRelayAbort = new AbortController();
        const controller = this._tvRelayAbort;
        this.renderTvRelayLoading();
        try {
            const availability = await window.NorvaCloud.partners.device.availability({
                signal: controller.signal
            });
            if (!this._visible || token !== this._showToken || controller.signal.aborted) return;
            const enabled = availability.data.availability.enabled === true;
            this.setEntryVisibility(enabled);
            if (!enabled) {
                this.renderUnavailable({
                    title: 'Partners hand-off is not available',
                    copy: forceAvailability
                        ? 'The secure TV hand-off is still disabled by the authoritative programme configuration.'
                        : 'Open Norva Partners on Web or Android mobile. This TV will show a QR only when the secure hand-off is enabled.',
                    tone: 'neutral',
                    retry: true
                });
                return;
            }

            const relay = this._tvRelay;
            if (relay
                && Number.isFinite(Date.parse(relay.expires_at))
                && Date.parse(relay.expires_at) > Date.now()
                && ['pending', 'consumed'].includes(relay.status)) {
                if (relay.status === 'consumed') this.renderTvRelayConnected();
                else {
                    this.renderTvRelayPending(relay);
                    this.scheduleTvRelayPoll(relay, token);
                }
                return;
            }
            await this.createTvRelay(token);
        } catch (error) {
            if (!this._visible || token !== this._showToken
                || error?.name === 'AbortError' || controller.signal.aborted) return;
            this.renderUnavailable({
                title: 'TV hand-off temporarily unavailable',
                copy: typeof navigator !== 'undefined' && navigator.onLine === false
                    ? 'Reconnect this TV, then retry. No partner or financial data was loaded.'
                    : 'Norva could not create the temporary QR securely. No partner or financial data was exposed.',
                tone: typeof navigator !== 'undefined' && navigator.onLine === false
                    ? 'offline'
                    : 'error',
                retry: true
            });
        }
    }

    async createTvRelay(token) {
        if (!this._tvRelayCreateKey) {
            this._tvRelayCreateKey = this.actionKey('tv-relay');
        }
        const envelope = await window.NorvaCloud.partners.device.createRelay({
            idempotencyKey: this._tvRelayCreateKey,
            signal: this._tvRelayAbort?.signal
        });
        if (!this._visible || token !== this._showToken
            || this._tvRelayAbort?.signal.aborted) return;
        this._tvRelay = envelope.data.relay;
        this.renderTvRelayPending(this._tvRelay);
        this.scheduleTvRelayPoll(this._tvRelay, token);
    }

    renewTvRelay() {
        this.stopTvRelayPolling();
        this._tvRelay = null;
        this._tvRelayCreateKey = '';
        this.clearActionKey('tv-relay');
        this.showTvRelay({ forceAvailability: true });
    }

    renderTvRelayLoading() {
        if (!this.container) return;
        this.container.innerHTML = `
            <main class="partners-shell partners-tv-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-tv-relay-card" aria-busy="true">
                    <div class="partners-skeleton partners-skeleton-hero" aria-hidden="true"></div>
                    <h1 id="partners-title" tabindex="-1">Preparing a secure hand-off</h1>
                    <p>Norva is creating a short-lived QR for your phone. Your partner account and financial details never appear on TV.</p>
                </section>
                ${this.liveRegion('Preparing a secure Norva Partners TV hand-off.')}
            </main>`;
        this.bindCommonActions();
    }

    renderTvRelayPending(relay) {
        if (!this.container) return;
        this.container.innerHTML = `
            <main class="partners-shell partners-tv-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-tv-relay-card">
                    <div class="partners-tv-relay-copy">
                        <span class="partners-status-pill">Secure hand-off</span>
                        <h1 id="partners-title" tabindex="-1">Continue on your phone</h1>
                        <p>Scan this temporary QR with your phone, sign in if asked, then manage Partners privately on Web or Android.</p>
                        <ol class="partners-tv-steps">
                            <li><span>1</span>Scan the QR with your phone camera.</li>
                            <li><span>2</span>Open the official <strong>norva.tv</strong> link.</li>
                            <li><span>3</span>This TV confirms the hand-off automatically.</li>
                        </ol>
                        <div class="partners-actions partners-actions-row">
                            <button class="btn btn-secondary" type="button"
                                data-partners-tv-refresh>Check connection</button>
                            <button class="btn btn-ghost" type="button"
                                data-partners-back>Back</button>
                        </div>
                    </div>
                    <div class="partners-tv-qr-panel">
                        <div class="partners-qr-code partners-tv-qr-code"
                            data-partners-tv-qr role="img"
                            aria-label="Temporary QR code to continue Norva Partners on your phone"></div>
                        <strong>norva.tv</strong>
                        <span data-partners-tv-relay-status role="status"
                            aria-live="polite">${this.escape(this.tvRelayExpiryCopy(relay.expires_at))}</span>
                    </div>
                </section>
                ${this.liveRegion('Temporary QR ready. Continue Norva Partners on your phone.')}
            </main>`;
        this.bindCommonActions();
        this.container.querySelector('[data-partners-tv-refresh]')
            ?.addEventListener('click', (event) => this.checkTvRelayNow(
                relay,
                this._showToken,
                event.currentTarget
            ));
        const target = this.container.querySelector('[data-partners-tv-qr]');
        try {
            if (typeof window.qrcode !== 'function') throw new Error('qrcode_unavailable');
            const qr = window.qrcode(0, 'M');
            qr.addData(relay.handoff_url);
            qr.make();
            target.innerHTML = qr.createSvgTag({
                cellSize: 8,
                margin: 3,
                scalable: true
            });
        } catch (_) {
            target.innerHTML = '<span>QR rendering unavailable. Retry this secure hand-off.</span>';
        }
        requestAnimationFrame(() => {
            try {
                this.container?.querySelector('[data-partners-tv-refresh]')
                    ?.focus({ preventScroll: true });
            } catch (_) { /* noop */ }
        });
    }

    tvRelayExpiryCopy(expiresAt) {
        const remaining = Math.max(0, Date.parse(expiresAt) - Date.now());
        const seconds = Math.ceil(remaining / 1000);
        if (!Number.isFinite(seconds) || seconds <= 0) return 'QR expired';
        const minutes = Math.floor(seconds / 60);
        const rest = seconds % 60;
        return `Waiting for your phone · expires in ${minutes}:${String(rest).padStart(2, '0')}`;
    }

    scheduleTvRelayPoll(relay, token) {
        if (!this._visible || token !== this._showToken || relay.status !== 'pending') return;
        if (this._tvRelayPollTimer) clearTimeout(this._tvRelayPollTimer);
        const delay = Math.max(2, Math.min(10, Number(relay.poll_after_seconds) || 3));
        this._tvRelayPollTimer = setTimeout(() => {
            this._tvRelayPollTimer = 0;
            this.checkTvRelayNow(relay, token);
        }, delay * 1000);
    }

    async checkTvRelayNow(relay, token, button = null) {
        if (!this._visible || token !== this._showToken
            || this._tvRelayAbort?.signal.aborted) return;
        if (Date.parse(relay.expires_at) <= Date.now()) {
            this._tvRelay = { ...relay, status: 'expired' };
            this.renderTvRelayExpired();
            return;
        }
        const previous = button?.textContent;
        if (button) {
            button.disabled = true;
            button.textContent = 'Checking…';
        }
        try {
            const envelope = await window.NorvaCloud.partners.device.relayStatus({
                relayToken: relay.relay_token,
                signal: this._tvRelayAbort?.signal
            });
            if (!this._visible || token !== this._showToken
                || this._tvRelayAbort?.signal.aborted) return;
            const status = envelope.data.relay;
            this._tvRelay = { ...relay, ...status };
            if (status.status === 'consumed') {
                this.renderTvRelayConnected();
                return;
            }
            if (status.status === 'expired') {
                this.renderTvRelayExpired();
                return;
            }
            const live = this.container?.querySelector('[data-partners-tv-relay-status]');
            if (live) live.textContent = this.tvRelayExpiryCopy(relay.expires_at);
            this.scheduleTvRelayPoll(this._tvRelay, token);
        } catch (error) {
            if (error?.name !== 'AbortError' && this._visible && token === this._showToken) {
                const live = this.container?.querySelector('[data-partners-tv-relay-status]');
                if (live) live.textContent = 'Connection check delayed · retrying securely';
                this.scheduleTvRelayPoll(relay, token);
            }
        } finally {
            if (button?.isConnected) {
                button.disabled = false;
                button.textContent = previous;
            }
        }
    }

    renderTvRelayConnected() {
        if (this._tvRelayPollTimer) clearTimeout(this._tvRelayPollTimer);
        this._tvRelayPollTimer = 0;
        this.container.innerHTML = `
            <main class="partners-shell partners-tv-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-state-card partners-tv-result">
                    <span class="partners-status-pill partners-status-success">Connected</span>
                    <h1 id="partners-title" tabindex="-1">Continue privately on your phone</h1>
                    <p>The secure hand-off is complete. Your TV received only this confirmation—never your identity, balance, tax profile or payout details.</p>
                    <div class="partners-actions partners-actions-row">
                        <button class="btn btn-primary" type="button"
                            data-partners-tv-new>Start another hand-off</button>
                        <button class="btn btn-secondary" type="button"
                            data-partners-back>Back to Settings</button>
                    </div>
                </section>
                ${this.liveRegion('TV hand-off complete. Continue Norva Partners on your phone.', 'assertive')}
            </main>`;
        this.bindCommonActions();
        this.container.querySelector('[data-partners-tv-new]')
            ?.addEventListener('click', () => this.renewTvRelay());
        requestAnimationFrame(() => this.container
            ?.querySelector('[data-partners-back]')?.focus?.({ preventScroll: true }));
    }

    renderTvRelayExpired() {
        if (this._tvRelayPollTimer) clearTimeout(this._tvRelayPollTimer);
        this._tvRelayPollTimer = 0;
        this.container.innerHTML = `
            <main class="partners-shell partners-tv-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-state-card partners-tv-result">
                    <span class="partners-status-pill partners-status-warning">QR expired</span>
                    <h1 id="partners-title" tabindex="-1">Create a fresh secure QR</h1>
                    <p>Temporary hand-offs expire quickly by design. Generate a new QR when your phone is ready.</p>
                    <div class="partners-actions partners-actions-row">
                        <button class="btn btn-primary" type="button"
                            data-partners-tv-new>Generate new QR</button>
                        <button class="btn btn-secondary" type="button"
                            data-partners-back>Back</button>
                    </div>
                </section>
                ${this.liveRegion('The temporary Partners QR expired.', 'assertive')}
            </main>`;
        this.bindCommonActions();
        this.container.querySelector('[data-partners-tv-new]')
            ?.addEventListener('click', () => this.renewTvRelay());
        requestAnimationFrame(() => this.container
            ?.querySelector('[data-partners-tv-new]')?.focus?.({ preventScroll: true }));
    }

    renderLoading() {
        if (!this.container) return;
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header('Checking availability', 'partners-title')}
                <div class="partners-stage" aria-busy="true">
                    <div class="partners-skeleton partners-skeleton-hero"></div>
                    <div class="partners-skeleton-grid" aria-hidden="true">
                        <div class="partners-skeleton"></div>
                        <div class="partners-skeleton"></div>
                        <div class="partners-skeleton"></div>
                    </div>
                </div>
                ${this.liveRegion('Checking Norva Partners availability.')}
            </main>`;
        this.bindCommonActions();
    }

    renderBootstrap(data) {
        const view = this.resolveView(data);
        if (view === 'discovery') {
            this.renderDiscovery(data);
            return;
        }
        if (view === 'pending') {
            this.renderPending(data);
            return;
        }
        if (view === 'attention') {
            this.renderAttention(data);
            return;
        }
        if (view === 'active') {
            this.renderActive(data);
            return;
        }
        if (view === 'jurisdiction') {
            this.renderJurisdiction(data);
            return;
        }
        if (view === 'invite') {
            this.renderUnavailable({
                title: 'Norva Partners is invitation-only',
                copy: 'The pilot is opening gradually in supported jurisdictions. This account is not currently included.',
                tone: 'neutral',
                program: data.program
            });
            return;
        }
        if (view === 'unsupported') {
            const policyRegion = this.regionLabel(data.policy);
            this.renderUnavailable({
                title: 'Not available in your jurisdiction yet',
                copy: policyRegion
                    ? `The individual programme is not currently available in ${policyRegion}. Coverage is controlled by Norva's server policies.`
                    : 'Norva needs an eligible country and, where required, subdivision before the programme can open.',
                tone: 'neutral',
                program: data.program
            });
            return;
        }
        this.renderUnavailable({
            title: 'Norva Partners is currently unavailable',
            copy: 'The programme is disabled for this account. No referral link or earning action is active.',
            tone: 'neutral',
            program: data.program
        });
    }

    resolveView(data) {
        const account = data.account;
        if (account.exists) {
            // Existing accounts use their stored jurisdiction. Resolve their
            // terminal/account-review states before global eligibility reasons:
            // the RPC deliberately reports held as account_blocked.
            if (account.status === 'suspended'
                || account.status === 'closed'
                || account.link_status === 'revoked') return 'disabled';
            if (account.status === 'held') return 'attention';
            if (data.eligibility.reason === 'account_attention_required') return 'attention';
            if (['country_required', 'country_not_supported', 'subdivision_not_supported']
                .includes(data.eligibility.reason)
                || data.policy?.individual_available === false) return 'attention';
            if (!data.flags.partners_enabled
                || data.visibility.reason === 'disabled'
                || data.eligibility.reason === 'disabled'
                || data.eligibility.reason === 'account_blocked') return 'disabled';
            if (account.verification_status === 'failed'
                || account.verification_status === 'expired'
                || account.contract_status === 'expired') return 'attention';
            if (account.status === 'active'
                && account.verification_status === 'verified'
                && account.contract_status === 'accepted') return 'active';
            return 'pending';
        }

        if (!data.flags.partners_enabled
            || data.visibility.reason === 'disabled'
            || data.eligibility.reason === 'disabled'
            || data.eligibility.reason === 'account_blocked') return 'disabled';
        if (data.eligibility.reason === 'not_allowlisted'
            && data.allowlist.included) return 'jurisdiction';
        if (data.visibility.reason === 'invite_only'
            || data.eligibility.reason === 'not_allowlisted'
            || (data.flags.partners_invite_only && !data.allowlist.included)) return 'invite';
        if (['country_required', 'country_not_supported', 'subdivision_not_supported']
            .includes(data.eligibility.reason)) return 'jurisdiction';
        if (data.policy?.individual_available === false) return 'unsupported';
        if (!data.visibility.visible) return 'disabled';

        return data.eligibility.eligible ? 'discovery' : 'unsupported';
    }

    renderJurisdiction(data) {
        this._closeCountryPicker?.({ restoreFocus: false });
        this._closeCountryPicker = null;
        const reason = data.eligibility.reason;
        const countryMissing = reason === 'country_required';
        const title = countryMissing
            ? 'Check programme availability for your jurisdiction.'
            : 'Choose another jurisdiction to check.';
        const copy = reason === 'country_not_supported'
            ? 'The last country checked is not currently supported by Norva Partners.'
            : (reason === 'subdivision_not_supported'
                ? 'The last state or region checked is not currently supported.'
                : (reason === 'not_allowlisted'
                    ? 'This invitation is not valid for the last jurisdiction checked. Choose the jurisdiction of this individual account to check the authoritative policy.'
                    : 'Enter the jurisdiction of this individual account. Norva will ask the server for the applicable policy.'));
        const country = this.escape(this._jurisdiction.countryCode);
        const subdivision = this.escape(this._jurisdiction.subdivisionCode);
        const countries = this.availableCountries();
        const selectedCountry = countries.find((entry) => entry.code === this._jurisdiction.countryCode) || null;
        const manualCountry = Boolean(this._jurisdiction.countryCode && !selectedCountry);
        const countryLabel = selectedCountry
            ? `${selectedCountry.flag || ''} ${selectedCountry.name} · ${selectedCountry.code}`.trim()
            : 'Choose a country';
        this.container.innerHTML = `
            <main class="partners-shell" data-partners-jurisdiction-surface aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-state-card partners-state-wide partners-jurisdiction-card">
                    <span class="partners-status-pill">Availability check</span>
                    <h1 id="partners-title" tabindex="-1">${this.escape(title)}</h1>
                    <p>${this.escape(copy)}</p>
                    <form class="partners-jurisdiction-form" data-partners-jurisdiction novalidate>
                        <div class="partners-field">
                            <span class="partners-field-label" id="partners-country-label">Country</span>
                            <input id="partners-country-code" name="countryCode" type="hidden"
                                value="${country}" data-partners-country-code>
                            <div data-partners-country-standard${manualCountry ? ' hidden' : ''}>
                                <button class="region-picker-btn source-select partners-country-trigger"
                                    type="button" data-partners-country-open
                                    aria-haspopup="dialog" aria-expanded="false"
                                    aria-controls="partners-country-dialog"
                                    aria-labelledby="partners-country-label partners-country-selection"
                                    aria-describedby="partners-country-hint">
                                    <span id="partners-country-selection" class="region-picker-value"
                                        data-partners-country-value>${this.escape(countryLabel)}</span>
                                    <span class="region-picker-caret" aria-hidden="true">▾</span>
                                </button>
                            </div>
                            <div class="partners-country-manual" data-partners-country-manual${manualCountry ? '' : ' hidden'}>
                                <input id="partners-country-code-manual" value="${country}"
                                    data-partners-country-manual-input maxlength="2" inputmode="text"
                                    autocapitalize="characters" autocomplete="off" spellcheck="false"
                                    placeholder="FR" aria-labelledby="partners-country-label"
                                    aria-describedby="partners-country-hint">
                                <button class="btn btn-ghost partners-inline-action" type="button"
                                    data-partners-country-list>Choose from country list</button>
                            </div>
                            <span id="partners-country-hint">Nothing is selected or inferred automatically. Choose a listed country, or use its two-letter ISO code.</span>
                        </div>
                        <div class="partners-field">
                            <label for="partners-subdivision-code">State or region code <span>(optional)</span></label>
                            <input id="partners-subdivision-code" name="subdivisionCode" value="${subdivision}"
                                maxlength="12" inputmode="text" autocapitalize="characters"
                                autocomplete="off" spellcheck="false" placeholder="FR-IDF"
                                aria-describedby="partners-subdivision-hint">
                            <span id="partners-subdivision-hint">Use the applicable ISO subdivision code only when needed.</span>
                        </div>
                        <div class="partners-form-status" data-partners-jurisdiction-status
                            role="status" aria-live="polite" aria-atomic="true"></div>
                        <div class="partners-actions partners-actions-row">
                            <button class="btn btn-primary" type="submit">Check availability</button>
                            <button class="btn btn-secondary" type="button" data-partners-back>Back</button>
                        </div>
                    </form>
                    <p class="partners-program-note">This check does not promise eligibility, earnings or programme access. The authoritative result comes from Norva's server policy.</p>
                    ${this.programWindowNote(data.program)}
                </section>
                ${this.liveRegion('Enter a country code to check Norva Partners availability.')}
            </main>
            <div class="partners-country-picker-overlay" data-region-picker
                data-partners-country-overlay hidden>
                <section id="partners-country-dialog"
                    class="partners-country-dialog region-picker-pop"
                    data-region-pop role="dialog" aria-modal="true"
                    aria-labelledby="partners-country-picker-title" hidden>
                    <header class="partners-country-dialog-header">
                        <div>
                            <span class="partners-eyebrow">Norva Partners</span>
                            <h2 id="partners-country-picker-title">Choose your country</h2>
                        </div>
                        <button class="partners-country-close" type="button"
                            data-partners-country-close aria-label="Close country selector">×</button>
                    </header>
                    <label class="partners-country-search-label" for="partners-country-search">Search countries</label>
                    <input id="partners-country-search" class="region-picker-search"
                        data-partners-country-search type="search" role="combobox"
                        aria-autocomplete="list" aria-controls="partners-country-listbox"
                        aria-expanded="true" autocomplete="off"
                        placeholder="Search by country or ISO code">
                    <ul id="partners-country-listbox"
                        class="region-picker-list partners-country-list"
                        data-partners-country-listbox role="listbox"
                        aria-label="Countries">${this.countryOptionMarkup(countries, this._jurisdiction.countryCode)}</ul>
                    <footer class="partners-country-dialog-footer">
                        <button class="btn btn-secondary partners-country-code-action"
                            type="button" data-partners-country-manual-open>Country not listed? Enter code</button>
                    </footer>
                </section>
            </div>`;
        this.bindCommonActions();
        this.bindJurisdictionForm();
        this.bindCountryPicker();
        this.focusTitle();
    }

    renderDiscovery(data) {
        const program = data.program;
        const policy = data.policy;
        const rate = this.percent(program?.commission_rate_bps);
        const maturity = program.maturation_days;
        const region = this.regionLabel(policy);
        const age = policy.minimum_age;
        const eligibility = region ? `Eligible policy · ${region}` : 'Eligible individual account';

        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-discovery-grid">
                    <div class="partners-discovery-copy">
                        <span class="partners-eyebrow">Norva Partners · Individuals only</span>
                        <h1 id="partners-title" class="partners-display" tabindex="-1">Earn ${rate} while they stay subscribed.</h1>
                        <p class="partners-lead">Receive ${rate} of each eligible payment from people who join through your link, for as long as their subscription remains active.</p>
                        <span class="partners-status-pill partners-status-success">${this.escape(eligibility)}</span>
                        <form class="partners-join-form" data-partners-join-form novalidate>
                            <label class="partners-consent-check">
                                <input type="checkbox" data-partners-individual-confirm>
                                <span>I apply as an individual and confirm that I meet the ${age}+ age and legal-capacity policy shown for ${this.escape(region)}.</span>
                            </label>
                            <label class="partners-consent-check">
                                <input type="checkbox" data-partners-terms-confirm>
                                <span>I accept the <a href="/partners-terms.html?version=${encodeURIComponent(policy.terms_version)}" target="_blank" rel="noopener">Norva Partners terms</a> (${this.escape(policy.terms_version)}) and the programme disclosure (${this.escape(policy.disclosure_version)}).</span>
                            </label>
                            <div class="partners-actions">
                                <button class="btn btn-primary partners-primary-action" type="submit"
                                    data-partners-join disabled aria-describedby="partners-activation-note">Join Norva Partners</button>
                                <span id="partners-activation-note" class="partners-action-note">Your link stays locked until identity verification is confirmed by the hosted KYC provider.</span>
                            </div>
                            <div class="partners-form-status" data-partners-action-status role="status" aria-live="polite" aria-atomic="true"></div>
                        </form>
                        <p class="partners-disclosure">Earnings vary and are not guaranteed. Commission is ${rate} of the amount excluding tax actually paid after discounts. Refunds and chargebacks are reversed. Payment-processing fees do not reduce the commission base.</p>
                    </div>
                    <aside class="partners-program-card" aria-labelledby="partners-program-title">
                        <h2 id="partners-program-title">Programme rules</h2>
                        <dl class="partners-program-facts">
                            <div><dt>Recurring commission</dt><dd>${rate}</dd></div>
                            <div><dt>Attribution window</dt><dd>${program.attribution_window_days} days</dd></div>
                            <div><dt>Validation period</dt><dd>${maturity} days</dd></div>
                            <div><dt>Referral model</dt><dd>Direct only</dd></div>
                            <div><dt>Verification</dt><dd>Individual KYC</dd></div>
                        </dl>
                        <p>No business account, KYB flow or guaranteed income is included in P0.</p>
                        ${this.programWindowNote(program)}
                    </aside>
                </section>
                ${this.steps()}
                <section class="partners-consent-card" aria-labelledby="partners-readiness-title">
                    <div>
                        <span class="partners-eyebrow">Secure activation</span>
                        <h2 id="partners-readiness-title">Identity, age and applicable jurisdiction policy are checked securely.</h2>
                        <p>The hosted KYC journey verifies individual identity. Norva applies the minimum-age and jurisdiction policy returned by its authoritative server. Norva never asks you to upload an identity document into this page.</p>
                    </div>
                    <ul>
                        <li>Minimum age under the active policy: ${age}+</li>
                        <li>Local capacity and programme terms must be confirmed.</li>
                        <li>Tax and payout details are required before the first payment, not before discovery.</li>
                    </ul>
                </section>
                ${this.liveRegion('Norva Partners is available. Review the individual programme confirmations to apply.')}
            </main>`;
        this.bindCommonActions();
        this.bindDiscoveryActions(data);
        this.focusTitle();
    }

    renderPending(data) {
        const verification = this.statusLabel(data.account.verification_status, 'Identity verification');
        const contract = this.statusLabel(data.account.contract_status, 'Programme terms');
        const link = this.statusLabel(data.account.link_status, 'Referral link');
        const needsTerms = data.account.contract_status !== 'accepted';
        const canAcceptTerms = needsTerms
            && Boolean(data.policy?.terms_version)
            && Boolean(data.policy?.disclosure_version);
        const canStartKyc = !needsTerms
            && data.account.verification_status === 'not_started'
            && Boolean(data.policy?.disclosure_version);
        const verificationPending = data.account.verification_status === 'pending';
        const pendingAction = canAcceptTerms
            ? `<button class="btn btn-primary partners-primary-action" type="button"
                    data-partners-accept-terms>Accept current programme terms</button>`
            : (canStartKyc
                ? `<form class="partners-join-form partners-kyc-form" data-partners-kyc-form novalidate>
                    <label class="partners-consent-check">
                        <input type="checkbox" data-partners-kyc-consent>
                        <span>I consent to the hosted identity, liveness and face-match checks described in the <a href="/privacy.html#partners" target="_blank" rel="noopener">Privacy Notice</a>. Identity documents are handled by Didit, not uploaded to this page.</span>
                    </label>
                    <label class="partners-consent-check">
                        <input type="checkbox" data-partners-capacity-confirm>
                        <span>I confirm that I meet the ${Number(data.policy.minimum_age)}+ policy and have legal capacity to join as an individual.</span>
                    </label>
                    <button class="btn btn-primary partners-primary-action" type="submit"
                        data-partners-start-kyc disabled aria-describedby="partners-verification-note">Verify my identity securely</button>
                  </form>`
                : (verificationPending
                    ? `<button class="btn btn-secondary partners-primary-action" type="button"
                        data-partners-refresh-verification aria-describedby="partners-verification-note">Check verification status</button>`
                    : `<button class="btn btn-secondary partners-primary-action" type="button" disabled
                        aria-describedby="partners-verification-note">Identity verification unavailable</button>`));
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-state-card partners-state-wide">
                    <span class="partners-status-pill partners-status-warning">Verification pending</span>
                    <h1 id="partners-title" tabindex="-1">Your individual partner profile is being checked.</h1>
                    <p>Norva waits for authoritative server confirmation before enabling a referral link. Refreshing this page cannot bypass verification.</p>
                    <dl class="partners-checklist">
                        <div><dt>Identity</dt><dd>${this.escape(verification)}</dd></div>
                        <div><dt>Terms</dt><dd>${this.escape(contract)}</dd></div>
                        <div><dt>Referral link</dt><dd>${this.escape(link)}</dd></div>
                    </dl>
                    ${pendingAction}
                    <p id="partners-verification-note" class="partners-action-note">${
                        canAcceptTerms
                            ? `Open and review the <a href="/partners-terms.html?version=${encodeURIComponent(data.policy.terms_version)}" target="_blank" rel="noopener">current Norva Partners terms</a> before accepting.`
                            : (needsTerms
                                ? 'The authoritative programme policy is unavailable. Terms cannot be accepted until the server restores it.'
                                : (canStartKyc
                                    ? `You will continue on Didit's secure hosted verification. Norva records consent version ${this.escape(data.policy.disclosure_version)} and receives only the verification result needed for programme eligibility.`
                                    : (verificationPending
                                        ? 'Your hosted verification was started. Norva will unlock the next step only after the signed provider result is received.'
                                        : 'The authoritative server has not enabled a new identity-verification action for this account.')))
                    }</p>
                    <div class="partners-form-status" data-partners-action-status role="status" aria-live="polite" aria-atomic="true"></div>
                    ${this.programWindowNote(data.program)}
                </section>
                ${this.liveRegion('Norva Partners identity verification is pending.')}
            </main>`;
        this.bindCommonActions();
        this.bindPendingActions(data);
        this.focusTitle();
    }

    renderAttention(data) {
        const verification = this.statusLabel(data.account.verification_status, 'Identity verification');
        const contract = this.statusLabel(data.account.contract_status, 'Programme terms');
        const account = this.statusLabel(data.account.status, 'Partner account');
        const policyUnavailable = [
            'country_required',
            'country_not_supported',
            'subdivision_not_supported'
        ].includes(data.eligibility.reason) || data.policy?.individual_available === false;
        const status = policyUnavailable ? 'Policy unavailable' : 'Attention required';
        const title = policyUnavailable
            ? 'The programme policy for this partner account is unavailable.'
            : 'Your partner setup needs attention.';
        const copy = policyUnavailable
            ? 'Norva is using the jurisdiction already stored on this partner account. Partner actions remain unavailable until the authoritative server policy is restored; this page will not ask you to replace that jurisdiction.'
            : 'Norva cannot enable or restore partner actions until the authoritative account checks are complete. No referral or payout action is available from this read-only page.';
        const announcement = policyUnavailable
            ? 'The Norva Partners policy for this account is unavailable.'
            : 'Norva Partners setup needs attention.';
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-state-card partners-state-wide">
                    <span class="partners-status-pill partners-status-warning">${this.escape(status)}</span>
                    <h1 id="partners-title" tabindex="-1">${this.escape(title)}</h1>
                    <p>${this.escape(copy)}</p>
                    <dl class="partners-checklist">
                        <div><dt>Partner account</dt><dd>${this.escape(account)}</dd></div>
                        <div><dt>Identity</dt><dd>${this.escape(verification)}</dd></div>
                        <div><dt>Terms</dt><dd>${this.escape(contract)}</dd></div>
                    </dl>
                    <button class="btn btn-secondary partners-primary-action" type="button" disabled>Secure next step unavailable</button>
                    ${this.programWindowNote(data.program)}
                </section>
                ${this.liveRegion(announcement, 'assertive')}
            </main>`;
        this.bindCommonActions();
        this.focusTitle();
    }

    renderActive(data) {
        this._dashboardAbort?.abort();
        this._dashboardAbort = null;
        this._payoutAbort?.abort();
        this._payoutAbort = null;
        this._payoutProfile = null;
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-dashboard-heading">
                    <div>
                        <span class="partners-status-pill partners-status-success">Partner active</span>
                        <h1 id="partners-title" tabindex="-1">Your partner dashboard</h1>
                        <p>Your link, referrals and commission history come from Norva's authoritative append-only partner ledger.</p>
                    </div>
                    <div class="partners-dashboard-actions">
                        <button class="btn btn-secondary" type="button" disabled
                            data-partners-payout-button>Checking payout setup…</button>
                        <button class="btn btn-secondary" type="button" data-partners-dashboard-retry>Refresh</button>
                    </div>
                </section>
                <section class="partners-metrics" aria-label="Partner metrics" data-partners-dashboard-metrics aria-busy="true">
                    ${this.metric('Available payout', 'Loading', 'Secure reporting')}
                    ${this.metric('In validation', 'Loading', `${data.program.maturation_days}-day validation window`)}
                    ${this.metric('Paid to date', 'Loading', 'Secure reporting')}
                    ${this.metric('Attributed referrals', 'Loading', 'Pseudonymised total')}
                </section>
                <section data-partners-dashboard-content aria-busy="true">
                    <div class="partners-skeleton partners-skeleton-hero" aria-hidden="true"></div>
                </section>
                <div class="partners-form-status" data-partners-action-status role="status" aria-live="polite" aria-atomic="true"></div>
                ${this.liveRegion('Norva Partners account is active. Loading the secure dashboard.')}
            </main>`;
        this.bindCommonActions();
        this.container.querySelector('[data-partners-dashboard-retry]')
            ?.addEventListener('click', () => this.loadDashboard(data, { reset: true }));
        this.focusTitle();
        this.loadDashboard(data, { reset: true });
        this.loadPayoutProfile();
    }

    bindDiscoveryActions(data) {
        const form = this.container?.querySelector('[data-partners-join-form]');
        const individual = form?.querySelector('[data-partners-individual-confirm]');
        const terms = form?.querySelector('[data-partners-terms-confirm]');
        const button = form?.querySelector('[data-partners-join]');
        if (!form || !individual || !terms || !button) return;
        const sync = () => {
            button.disabled = !(individual.checked && terms.checked);
        };
        individual.addEventListener('change', sync);
        terms.addEventListener('change', sync);
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!individual.checked || !terms.checked) {
                this.setActionStatus('Confirm both individual programme statements first.', 'error');
                (!individual.checked ? individual : terms).focus();
                return;
            }
            await this.runPartnerAction(button, 'Applying securely…', async () => {
                await window.NorvaCloud.partners.apply({
                    accountType: 'individual',
                    countryCode: data.policy.country_code,
                    subdivisionCode: data.policy.subdivision_code || undefined,
                    idempotencyKey: this.actionKey('application')
                });
                this.clearActionKey('application');
                await window.NorvaCloud.partners.acceptTerms({
                    termsVersion: data.policy.terms_version,
                    disclosureVersion: data.policy.disclosure_version,
                    idempotencyKey: this.actionKey('terms')
                });
                this.clearActionKey('terms');
                this.setActionStatus('Application submitted. Loading the authoritative account state.');
                this.bootstrapEnvelope = null;
                await this.show();
            });
        });
        sync();
    }

    bindPendingActions(data) {
        const termsButton = this.container?.querySelector('[data-partners-accept-terms]');
        if (termsButton && data.policy?.terms_version && data.policy?.disclosure_version) {
            termsButton.addEventListener('click', () => this.runPartnerAction(
                termsButton,
                'Accepting securely…',
                async () => {
                    await window.NorvaCloud.partners.acceptTerms({
                        termsVersion: data.policy.terms_version,
                        disclosureVersion: data.policy.disclosure_version,
                        idempotencyKey: this.actionKey('terms')
                    });
                    this.clearActionKey('terms');
                    this.setActionStatus('Terms accepted. Loading the authoritative verification state.');
                    this.bootstrapEnvelope = null;
                    await this.show();
                }
            ));
        }

        const form = this.container?.querySelector('[data-partners-kyc-form]');
        const consent = form?.querySelector('[data-partners-kyc-consent]');
        const capacity = form?.querySelector('[data-partners-capacity-confirm]');
        const kycButton = form?.querySelector('[data-partners-start-kyc]');
        if (form && consent && capacity && kycButton && data.policy?.disclosure_version) {
            const sync = () => {
                kycButton.disabled = !(consent.checked && capacity.checked);
            };
            consent.addEventListener('change', sync);
            capacity.addEventListener('change', sync);
            form.addEventListener('submit', async (event) => {
                event.preventDefault();
                if (!consent.checked || !capacity.checked) {
                    this.setActionStatus('Confirm both verification statements before continuing.', 'error');
                    (!consent.checked ? consent : capacity).focus();
                    return;
                }
                await this.runPartnerAction(kycButton, 'Opening secure verification…', async () => {
                    const envelope = await window.NorvaCloud.partners.startKyc({
                        language: this.partnerLanguage(),
                        consentVersion: data.policy.disclosure_version,
                        capacityConfirmed: true,
                        idempotencyKey: this.actionKey('kyc-session')
                    });
                    this.clearActionKey('kyc-session');
                    this.setActionStatus('Secure verification ready. Opening Didit.');
                    window.location.assign(envelope.data.verification.url);
                });
            });
            sync();
        }

        this.container?.querySelector('[data-partners-refresh-verification]')
            ?.addEventListener('click', (event) => this.runPartnerAction(
                event.currentTarget,
                'Checking securely…',
                async () => {
                    this.bootstrapEnvelope = null;
                    await this.show();
                }
            ));
    }

    partnerLanguage() {
        const language = String(
            document.documentElement?.lang
            || navigator.language
            || 'en'
        ).trim().toLowerCase().split(/[-_]/)[0];
        return /^[a-z]{2}$/.test(language) ? language : 'en';
    }

    actionKey(action) {
        if (this._actionKeys.has(action)) return this._actionKeys.get(action);
        let key = '';
        try {
            key = `norva.${action}.${crypto.randomUUID()}`;
        } catch (_) {
            const bytes = new Uint8Array(18);
            crypto.getRandomValues(bytes);
            key = `norva.${action}.${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
        }
        this._actionKeys.set(action, key);
        return key;
    }

    clearActionKey(action) {
        this._actionKeys.delete(action);
    }

    async runPartnerAction(button, loadingLabel, action) {
        if (!button || button.disabled || typeof action !== 'function') return;
        const previous = button.textContent;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.textContent = loadingLabel;
        this.container?.querySelector('.partners-shell')?.setAttribute('aria-busy', 'true');
        this.setActionStatus(loadingLabel);
        try {
            await action();
        } catch (error) {
            if (!this._visible) return;
            this.setActionStatus(this.partnerErrorMessage(error), 'error');
        } finally {
            if (button.isConnected) {
                button.disabled = false;
                button.removeAttribute('aria-busy');
                button.textContent = previous;
            }
            this.container?.querySelector('.partners-shell')?.removeAttribute('aria-busy');
        }
    }

    partnerErrorMessage(error) {
        const messages = {
            request_in_progress: 'This secure action is still processing. Wait a moment, then retry.',
            idempotency_key_reused: 'This action could not be replayed safely. Refresh the page before trying again.',
            business_accounts_not_supported: 'Norva Partners currently supports individual accounts only.',
            kyc_billing_unavailable: 'Identity verification is temporarily unavailable. No charge or account change was made.',
            provider_not_configured: 'Identity verification is not configured yet. No account change was made.',
            provider_temporarily_unavailable: 'The identity provider is temporarily unavailable. Retry without creating another account.',
            rate_limited: 'Too many secure attempts were received. Wait a moment before retrying.',
            partners_action_not_allowed: 'This action is not available for the current verified account state.',
            partners_kyc_consent_invalid: 'Review and confirm the current verification statements before continuing.',
            authentication_required: 'Sign in again to continue securely.',
            invalid_access_token: 'Your session expired. Sign in again to continue.',
            partners_user_session_required: 'Open Norva Partners from a signed-in cloud account.'
        };
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            return 'You are offline. Reconnect and retry; the same secure action will be resumed.';
        }
        return messages[error?.code]
            || 'Norva could not complete this action securely. No unverified state was accepted.';
    }

    setActionStatus(message, tone = 'status') {
        const status = this.container?.querySelector('[data-partners-action-status]');
        if (!status) return;
        status.setAttribute('role', tone === 'error' ? 'alert' : 'status');
        status.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
        status.textContent = message;
    }

    async loadPayoutProfile() {
        if (!this._visible || typeof window.NorvaCloud?.partners?.payoutProfile !== 'function') {
            this.renderPayoutProfile(null);
            return;
        }
        this._payoutAbort?.abort();
        this._payoutAbort = new AbortController();
        const controller = this._payoutAbort;
        try {
            const envelope = await window.NorvaCloud.partners.payoutProfile({
                signal: controller.signal
            });
            if (!this._visible || controller.signal.aborted) return;
            this._payoutProfile = envelope.data;
            this.renderPayoutProfile(envelope.data);
        } catch (error) {
            if (error?.name === 'AbortError' || controller.signal.aborted || !this._visible) return;
            this._payoutProfile = null;
            this.renderPayoutProfile(null);
        } finally {
            if (this._payoutAbort === controller) this._payoutAbort = null;
        }
    }

    renderPayoutProfile(data) {
        const target = this.container?.querySelector('[data-partners-payout-summary]');
        const button = this.container?.querySelector('[data-partners-payout-button]');
        const reasonCopy = {
            account_not_active: 'Partner account activation is required.',
            kyc_not_verified: 'Identity verification is required.',
            fiscal_profile_required: 'A verified individual fiscal profile is required.',
            provider_not_configured: 'No individual payout provider is configured for this policy.',
            payouts_not_live: 'The payout release gate is not live.'
        };
        if (!data) {
            if (button) button.textContent = 'Payout status unavailable';
            if (target) target.innerHTML = `<strong>Payout readiness unavailable</strong>
                <span>No payout state or zero balance is inferred while the authoritative service is unavailable.</span>`;
            return;
        }
        const profile = data.profile;
        const profiles = Array.isArray(data.profiles) ? data.profiles : [];
        const fiscal = data.fiscal;
        const reason = data.readiness.reason;
        const title = data.readiness.ready
            ? 'Ready for the next supervised payout cycle'
            : (reasonCopy[reason] || 'Payout setup is not ready.');
        if (button) {
            button.textContent = profiles.length > 1
                ? `${profiles.length} payout destinations`
                : profile
                    ? `${this.payoutProviderLabel(profile.provider)} · ${profile.display_masked}`
                    : 'Payout setup unavailable';
            button.title = title;
        }
        if (!target) return;
        const destinations = profiles.length
            ? profiles.map((destination) => `
                <span>${this.escape(destination.currency)} · ${this.escape(this.payoutProviderLabel(destination.provider))} · ${this.escape(destination.display_masked)} · ${this.escape(destination.status)}</span>`
            ).join('')
            : '<span>No payout destination has been tokenised.</span>';
        target.innerHTML = `
            <strong>${this.escape(title)}</strong>
            ${destinations}
            <span>Fiscal profile: ${this.escape(fiscal?.status || 'missing')}${fiscal?.country_code ? ` · ${this.escape(fiscal.country_code)}` : ''}</span>
            <span>${data.readiness.payouts_live
                ? 'Live payout gate enabled.'
                : 'Live payouts remain disabled. No bank, card or tax identifier is collected on this page.'}</span>`;
    }

    payoutProviderLabel(provider) {
        return ({
            wise: 'Wise',
            revolut: 'Revolut',
            stripe_connect: 'Stripe Connect'
        })[provider] || 'Payout provider';
    }

    async loadDashboard(bootstrap, { reset = false, append = false } = {}) {
        if (!this._visible || !window.NorvaCloud?.partners?.dashboard) return;
        this._dashboardAbort?.abort();
        this._dashboardAbort = new AbortController();
        const controller = this._dashboardAbort;
        const content = this.container?.querySelector('[data-partners-dashboard-content]');
        const metrics = this.container?.querySelector('[data-partners-dashboard-metrics]');
        if (reset) {
            this._dashboardCursor = null;
            this._dashboardPages = [];
        }
        if (content) content.setAttribute('aria-busy', 'true');
        if (metrics) metrics.setAttribute('aria-busy', 'true');
        this.setActionStatus(append ? 'Loading more partner history…' : 'Refreshing the secure partner dashboard…');
        try {
            const envelope = await window.NorvaCloud.partners.dashboard({
                limit: 25,
                status: this._dashboardFilter,
                cursor: append ? this._dashboardCursor : undefined,
                signal: controller.signal
            });
            if (!this._visible || controller.signal.aborted) return;
            const page = envelope.data;
            if (append && this._dashboardPages.length) {
                this._dashboardPages.push(page);
            } else {
                this._dashboardPages = [page];
            }
            const first = this._dashboardPages[0];
            const combined = {
                ...first,
                history: {
                    status: page.history.status,
                    items: this._dashboardPages.flatMap((item) => item.history.items),
                    next_cursor: page.history.next_cursor
                }
            };
            this._dashboardCursor = page.history.next_cursor;
            this.renderDashboardData(bootstrap, combined);
            this.setActionStatus('Partner dashboard updated.');
        } catch (error) {
            if (error?.name === 'AbortError' || controller.signal.aborted || !this._visible) return;
            if (content) {
                content.innerHTML = `<section class="partners-history-card">
                    <div class="partners-empty-state" role="alert">
                        <strong>Dashboard temporarily unavailable</strong>
                        <span>No financial or referral value was guessed. Retry the authoritative server request.</span>
                        <button class="btn btn-primary" type="button" data-partners-dashboard-inline-retry>Try again</button>
                    </div>
                </section>`;
                content.querySelector('[data-partners-dashboard-inline-retry]')
                    ?.addEventListener('click', () => this.loadDashboard(bootstrap, { reset: true }));
            }
            this.setActionStatus(this.partnerErrorMessage(error), 'error');
        } finally {
            if (this._dashboardAbort === controller) this._dashboardAbort = null;
            content?.removeAttribute('aria-busy');
            metrics?.removeAttribute('aria-busy');
        }
    }

    renderDashboardData(bootstrap, dashboard) {
        const metrics = this.container?.querySelector('[data-partners-dashboard-metrics]');
        const content = this.container?.querySelector('[data-partners-dashboard-content]');
        if (!metrics || !content) return;
        const reporting = dashboard.reporting;
        const reportingHint = reporting.available
            ? 'Authoritative commission ledger'
            : this.reportingReason(reporting.reason);
        const reportingValue = (field) => {
            if (!reporting.available) return '—';
            if (reporting.currency) {
                return this.formatMinor(reporting[field], reporting.currency);
            }
            return this.formatCurrencyBalances(reporting.currencies, field);
        };
        metrics.innerHTML = [
            this.metric(
                'Available payout',
                reportingValue('available_minor'),
                reportingHint
            ),
            this.metric(
                'In validation',
                reportingValue('pending_minor'),
                `${bootstrap.program.maturation_days}-day validation window`
            ),
            this.metric(
                'Paid to date',
                reportingValue('paid_minor'),
                reportingHint
            ),
            this.metric(
                'Attributed referrals',
                String(reporting.referrals),
                `${reporting.clicks} eligible link visit${reporting.clicks === 1 ? '' : 's'}`
            )
        ].join('');

        const link = dashboard.link;
        const rate = this.percent(bootstrap.program.commission_rate_bps);
        const linkCard = link
            ? `<div class="partners-referral-card">
                <div class="partners-referral-main">
                    <span class="partners-eyebrow">Your personal referral link</span>
                    <h2>Share Norva. Keep the disclosure attached.</h2>
                    <div class="partners-link-control">
                        <input type="text" readonly value="${this.escape(link.share_url)}"
                            aria-label="Your personal Norva referral link" data-partners-link>
                        <button class="btn btn-secondary" type="button" data-partners-copy>Copy</button>
                    </div>
                    <div class="partners-link-actions">
                        <button class="btn btn-primary" type="button" data-partners-share>Share link</button>
                        <button class="btn btn-secondary" type="button" data-partners-qr>Show QR</button>
                        <button class="btn btn-ghost" type="button" data-partners-rotate>Rotate link</button>
                    </div>
                    <p class="partners-disclosure" data-partners-share-disclosure>${this.escape(this.shareDisclosure(bootstrap))}</p>
                </div>
                <div class="partners-rate-badge"><strong>${rate}</strong><span>Recurring</span></div>
              </div>`
            : `<div class="partners-referral-card">
                <div>
                    <span class="partners-eyebrow">Referral link</span>
                    <h2>No active link was returned.</h2>
                    <p>The dashboard did not invent a local code. Refresh the secure account state.</p>
                </div>
              </div>`;

        const filters = [
            ['all', 'All'],
            ['pending', 'Pending'],
            ['available', 'Available'],
            ['held', 'Held'],
            ['paid', 'Paid'],
            ['reversed', 'Reversed']
        ].map(([value, label]) => `<button class="partners-filter-chip${dashboard.history.status === value ? ' is-active' : ''}"
            type="button" data-partners-history-filter="${value}"
            aria-pressed="${dashboard.history.status === value ? 'true' : 'false'}">${label}</button>`).join('');
        const history = dashboard.history.items.length
            ? `<ol class="partners-history-list">${dashboard.history.items.map((item) => `
                <li>
                    <span class="partners-history-signal" aria-hidden="true"></span>
                    <div><strong>${this.escape(this.historyLabel(item.type))}</strong>
                    <span>${this.escape(this.formatDateTime(item.occurred_at))}</span></div>
                </li>`).join('')}</ol>`
            : `<div class="partners-empty-state">
                <strong>No events in this view</strong>
                <span>No person, e-mail or account identifier is exposed in partner history.</span>
              </div>`;

        content.innerHTML = `
            <section class="partners-dashboard-grid">
                ${linkCard}
                <aside class="partners-program-card">
                    <h2>Profile status</h2>
                    <dl class="partners-program-facts">
                        <div><dt>Account</dt><dd>${this.escape(this.statusLabel(dashboard.account.status, 'Partner account'))}</dd></div>
                        <div><dt>Identity</dt><dd>${this.escape(this.statusLabel(dashboard.account.verification_status, 'Identity verification'))}</dd></div>
                        <div><dt>Terms</dt><dd>${this.escape(this.statusLabel(dashboard.account.contract_status, 'Programme terms'))}</dd></div>
                        <div><dt>Jurisdiction</dt><dd>${this.escape([dashboard.account.country_code, dashboard.account.subdivision_code].filter(Boolean).join(' · '))}</dd></div>
                        <div><dt>Payouts</dt><dd>${bootstrap.flags.partners_payouts_live ? 'Release gate enabled' : 'Not live'}</dd></div>
                    </dl>
                    <div class="partners-payout-summary" data-partners-payout-summary role="status" aria-live="polite">
                        <strong>Checking payout readiness…</strong>
                        <span>No financial identifier is loaded into this page.</span>
                    </div>
                    ${this.programWindowNote(bootstrap.program)}
                </aside>
            </section>
            <section class="partners-history-card" aria-labelledby="partners-history-title">
                <div class="partners-history-heading">
                    <div><h2 id="partners-history-title">Partner history</h2>
                    <p>Commission state changes are shown without customer identity, payment references or private amounts.</p></div>
                    <div class="partners-history-filters" role="group" aria-label="Filter partner history">${filters}</div>
                </div>
                ${history}
                ${dashboard.history.next_cursor
                    ? '<button class="btn btn-secondary partners-load-more" type="button" data-partners-history-more>Load more</button>'
                    : ''}
            </section>`;
        this.renderPayoutProfile(this._payoutProfile);
        this.bindDashboardActions(bootstrap, dashboard);
    }

    bindDashboardActions(bootstrap, dashboard) {
        const link = dashboard.link;
        if (link) {
            this.container?.querySelector('[data-partners-copy]')
                ?.addEventListener('click', (event) => this.runPartnerAction(
                    event.currentTarget,
                    'Copying…',
                    async () => {
                        await this.copyText(link.share_url);
                        this.setActionStatus('Referral link copied.');
                    }
                ));
            this.container?.querySelector('[data-partners-share]')
                ?.addEventListener('click', (event) => this.runPartnerAction(
                    event.currentTarget,
                    'Opening share…',
                    async () => {
                        await this.shareReferral(link.share_url, bootstrap);
                        this.setActionStatus('Share sheet opened with the required disclosure.');
                    }
                ));
            this.container?.querySelector('[data-partners-qr]')
                ?.addEventListener('click', (event) => this.openQrDialog(
                    link.share_url,
                    event.currentTarget
                ));
            const rotate = this.container?.querySelector('[data-partners-rotate]');
            if (rotate) {
                let armedUntil = 0;
                rotate.addEventListener('click', () => {
                    if (Date.now() > armedUntil) {
                        armedUntil = Date.now() + 8000;
                        rotate.textContent = 'Confirm link rotation';
                        this.setActionStatus('Confirm rotation. The previous link will stop working.');
                        setTimeout(() => {
                            if (rotate.isConnected && Date.now() >= armedUntil) rotate.textContent = 'Rotate link';
                        }, 8100);
                        return;
                    }
                    this.runPartnerAction(rotate, 'Rotating…', async () => {
                        await window.NorvaCloud.partners.rotateLink({
                            idempotencyKey: this.actionKey('link-rotation')
                        });
                        this.clearActionKey('link-rotation');
                        this.setActionStatus('Referral link rotated. Loading the new server-issued link.');
                        await this.loadDashboard(bootstrap, { reset: true });
                    });
                });
            }
        }
        this.container?.querySelectorAll('[data-partners-history-filter]')
            .forEach((button) => button.addEventListener('click', () => {
                const next = button.dataset.partnersHistoryFilter;
                if (!next || next === this._dashboardFilter) return;
                this._dashboardFilter = next;
                this.loadDashboard(bootstrap, { reset: true });
            }));
        this.container?.querySelector('[data-partners-history-more]')
            ?.addEventListener('click', () => this.loadDashboard(bootstrap, { append: true }));
    }

    reportingReason(reason) {
        return ({
            available: 'Authoritative commission ledger',
            no_financial_activity: 'No commission activity yet',
            multiple_currencies: 'Amounts are kept separate by currency'
        })[reason] || 'Financial reporting unavailable';
    }

    formatMinor(value, currency) {
        if (!Number.isSafeInteger(value) || !/^[A-Z]{3}$/.test(String(currency || ''))) return 'Unavailable';
        try {
            const formatter = new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency,
                currencyDisplay: 'narrowSymbol'
            });
            const digits = formatter.resolvedOptions().maximumFractionDigits;
            return formatter.format(value / (10 ** digits));
        } catch (_) {
            return `${value} ${currency} minor units`;
        }
    }

    formatCurrencyBalances(currencies, field) {
        if (!Array.isArray(currencies) || currencies.length === 0) return 'Unavailable';
        return currencies
            .map((balance) => this.formatMinor(balance?.[field], balance?.currency))
            .join(' · ');
    }

    historyLabel(type) {
        return ({
            application_submitted: 'Application submitted',
            terms_accepted: 'Programme terms accepted',
            account_activated: 'Partner account activated',
            account_held: 'Account placed on hold',
            account_suspended: 'Account suspended',
            link_created: 'Referral link created',
            link_rotated: 'Referral link rotated',
            link_revoked: 'Referral link revoked',
            commission_pending: 'Commission in validation',
            commission_available: 'Commission available',
            commission_held: 'Commission held for review',
            commission_paid: 'Commission paid',
            commission_reversed: 'Commission reversed'
        })[type] || 'Partner event';
    }

    formatDateTime(value) {
        try {
            return new Intl.DateTimeFormat(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short'
            }).format(new Date(value));
        } catch (_) {
            return 'Date unavailable';
        }
    }

    shareDisclosure(bootstrap) {
        const rate = this.percent(bootstrap.program.commission_rate_bps);
        return `Partner link · I may receive ${rate} of eligible Norva payments excluding tax. Earnings are not guaranteed. Norva is a media player; no content or TV subscription is included.`;
    }

    async copyText(value) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return;
        }
        const input = this.container?.querySelector('[data-partners-link]');
        if (!input) throw new Error('partners_copy_unavailable');
        input.focus();
        input.select();
        if (!document.execCommand?.('copy')) throw new Error('partners_copy_unavailable');
    }

    async shareReferral(url, bootstrap) {
        const message = 'Discover Norva — one media ecosystem across Web, Android and TV.';
        const disclosure = this.shareDisclosure(bootstrap);
        const native = window.NorvaShareNative;
        if (native && typeof native.postMessage === 'function') {
            await this.postNativeShare('shareReferral', {
                url,
                message,
                disclosure,
                chooserTitle: 'Share Norva'
            });
            return;
        }
        if (navigator.share) {
            try {
                await navigator.share({
                    title: 'Norva',
                    text: `${message}\n\n${disclosure}`,
                    url
                });
            } catch (error) {
                if (error?.name !== 'AbortError') throw error;
            }
            return;
        }
        await this.copyText(`${message}\n\n${disclosure}\n${url}`);
    }

    postNativeShare(method, payload) {
        const channel = window.NorvaShareNative;
        if (!channel || typeof channel.postMessage !== 'function') {
            return Promise.reject(new Error('partners_native_share_unavailable'));
        }
        this.bindNativeShareReplies();
        const requestBytes = new Uint8Array(16);
        crypto.getRandomValues(requestBytes);
        const requestId = `share_${Array.from(requestBytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._nativeShareRequests.delete(requestId);
                reject(new Error('partners_native_share_timeout'));
            }, 20000);
            this._nativeShareRequests.set(requestId, { resolve, reject, timer });
            try {
                channel.postMessage(JSON.stringify({
                    version: 1,
                    requestId,
                    method,
                    payload
                }));
            } catch (_) {
                clearTimeout(timer);
                this._nativeShareRequests.delete(requestId);
                reject(new Error('partners_native_share_unavailable'));
            }
        });
    }

    bindNativeShareReplies() {
        if (this._nativeShareListenerBound) return;
        const channel = window.NorvaShareNative;
        if (!channel) return;
        const handle = (event) => {
            let data = event?.data;
            try { if (typeof data === 'string') data = JSON.parse(data); } catch (_) { return; }
            if (!data || data.version !== 1 || typeof data.requestId !== 'string') return;
            const pending = this._nativeShareRequests.get(data.requestId);
            if (!pending) return;
            clearTimeout(pending.timer);
            this._nativeShareRequests.delete(data.requestId);
            if (data.status === 'ok'
                || data.status === 'success'
                || data.status === 'presented'
                || data.status === 'cancelled') {
                pending.resolve(data);
            } else {
                pending.reject(new Error('partners_native_share_failed'));
            }
        };
        if (typeof channel.addEventListener === 'function') channel.addEventListener('message', handle);
        else channel.onmessage = handle;
        this._nativeShareListenerBound = true;
    }

    openQrDialog(url, opener) {
        this.container?.querySelector('[data-partners-qr-overlay]')?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'partners-country-picker-overlay partners-qr-overlay';
        overlay.setAttribute('data-region-picker', '');
        overlay.setAttribute('data-partners-qr-overlay', '');
        overlay.innerHTML = `
            <section class="partners-qr-dialog" role="dialog" aria-modal="true"
                aria-labelledby="partners-qr-title" aria-describedby="partners-qr-copy">
                <header class="partners-country-dialog-header">
                    <div><span class="partners-eyebrow">Personal referral link</span>
                    <h2 id="partners-qr-title">Scan to open Norva</h2></div>
                    <button class="partners-country-close" type="button"
                        data-partners-qr-close aria-label="Close QR code">×</button>
                </header>
                <div class="partners-qr-code" data-partners-qr-code role="img"
                    aria-label="QR code for your personal Norva referral link"></div>
                <p id="partners-qr-copy">The QR encodes only your active server-issued <strong>norva.tv</strong> referral URL. It contains no balance, e-mail or KYC data.</p>
                <code>${this.escape(url)}</code>
            </section>`;
        this.container.appendChild(overlay);
        const shell = this.container.querySelector('.partners-shell');
        const closeButton = overlay.querySelector('[data-partners-qr-close]');
        const previousInert = shell?.hasAttribute('inert') || false;
        if (shell) shell.setAttribute('inert', '');
        this.container.classList.add('partners-picker-open');
        const close = () => {
            overlay.remove();
            this.container?.classList.remove('partners-picker-open');
            if (shell && !previousInert) shell.removeAttribute('inert');
            try { opener?.focus({ preventScroll: true }); } catch (_) { opener?.focus?.(); }
        };
        overlay.__regionClose = close;
        closeButton?.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' || event.key === 'GoBack' || event.key === 'BrowserBack') {
                event.preventDefault();
                close();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = Array.from(overlay.querySelectorAll('button:not([disabled]), [href]'));
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });
        const target = overlay.querySelector('[data-partners-qr-code]');
        try {
            if (typeof window.qrcode !== 'function') throw new Error('qrcode_unavailable');
            const qr = window.qrcode(0, 'M');
            qr.addData(url);
            qr.make();
            target.innerHTML = qr.createSvgTag({ cellSize: 7, margin: 2, scalable: true });
        } catch (_) {
            target.innerHTML = '<span>QR rendering unavailable. Copy or share the secure link instead.</span>';
        }
        requestAnimationFrame(() => closeButton?.focus());
    }

    renderUnavailable({ title, copy, tone, retry = false, program = null }) {
        if (!this.container) return;
        const stateLabel = tone === 'offline' ? 'Offline' : (tone === 'error' ? 'Unavailable' : 'Programme status');
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-state-card">
                    <span class="partners-status-pill">${this.escape(stateLabel)}</span>
                    <h1 id="partners-title" tabindex="-1">${this.escape(title)}</h1>
                    <p>${this.escape(copy)}</p>
                    ${this.programWindowNote(program)}
                    <div class="partners-actions partners-actions-row">
                        ${retry ? '<button class="btn btn-primary" type="button" data-partners-retry>Try again</button>' : ''}
                        <button class="btn btn-secondary" type="button" data-partners-back>Back</button>
                    </div>
                </section>
                ${this.liveRegion(title, tone === 'error' ? 'assertive' : 'polite')}
            </main>`;
        this.bindCommonActions();
        this.focusTitle();
    }

    header(title, titleId = '') {
        return `
            <header class="partners-header">
                <button class="partners-back" type="button" data-partners-back aria-label="Back from Norva Partners">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
                    <span>Back</span>
                </button>
                <div>
                    <span class="partners-header-context">Settings</span>
                    <strong${titleId ? ` id="${this.escape(titleId)}" tabindex="-1"` : ''}>${this.escape(title)}</strong>
                </div>
            </header>`;
    }

    steps() {
        return `
            <section class="partners-steps" aria-label="How Norva Partners works">
                <article><span>1</span><div><h2>Share your personal link</h2><p>A unique opaque link is generated only after server verification.</p></div></article>
                <article><span>2</span><div><h2>They subscribe to Norva</h2><p>Direct referrals are attributed without revealing their identity to you.</p></div></article>
                <article><span>3</span><div><h2>You earn on eligible renewals</h2><p>Commission matures after 45 days and follows refunds or chargebacks.</p></div></article>
            </section>`;
    }

    metric(label, value, hint) {
        return `
            <article class="partners-metric">
                <span>${this.escape(label)}</span>
                <strong>${this.escape(value)}</strong>
                <small>${this.escape(hint)}</small>
            </article>`;
    }

    programWindowNote(program) {
        if (!program || !Number.isSafeInteger(program.attribution_window_days)) return '';
        const days = program.attribution_window_days;
        return `<p class="partners-program-note"><strong>Attribution window:</strong> ${days} days from the eligible referral visit. This tracking window does not guarantee eligibility or earnings.</p>`;
    }

    availableCountries() {
        const countries = Array.isArray(window.NorvaRegions?.COUNTRIES)
            ? window.NorvaRegions.COUNTRIES
            : [];
        return countries
            .filter((country) => (
                country?.kind === 'country'
                && /^[A-Z]{2}$/.test(country.code)
                && typeof country.name === 'string'
            ))
            .slice()
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    countryOptionMarkup(countries, selectedCode = '') {
        return countries
            .map((country) => {
                const current = country.code === selectedCode;
                return `
                    <li id="partners-country-option-${this.escape(country.code)}"
                        class="region-picker-option partners-country-option${current ? ' is-current' : ''}"
                        role="option" aria-selected="${current ? 'true' : 'false'}"
                        data-partners-country-option="${this.escape(country.code)}">
                        <span class="region-picker-opt-flag" aria-hidden="true">${this.escape(country.flag || '')}</span>
                        <span class="region-picker-opt-name">${this.escape(country.name)}</span>
                        <span class="partners-country-option-code" aria-hidden="true">${this.escape(country.code)}</span>
                    </li>`;
            })
            .join('');
    }

    liveRegion(message, politeness = 'polite') {
        return `<div class="partners-sr-status" role="${politeness === 'assertive' ? 'alert' : 'status'}" aria-live="${politeness}" aria-atomic="true">${this.escape(message)}</div>`;
    }

    bindCommonActions() {
        this.container?.querySelectorAll('[data-partners-back]')
            .forEach((button) => button.addEventListener('click', () => this.goBack()));
        this.container?.querySelector('[data-partners-retry]')
            ?.addEventListener('click', () => this.reload());
        const scroller = this.getScrollElement();
        if (typeof scroller?.addEventListener !== 'function') return;
        scroller.addEventListener('scroll', () => {
            if (this._scrollPersistFrame) return;
            this._scrollPersistFrame = requestAnimationFrame(() => {
                this._scrollPersistFrame = 0;
                this.app?.persistNativeContinuity?.();
            });
        }, { passive: true });
    }

    bindJurisdictionForm() {
        const form = this.container?.querySelector('[data-partners-jurisdiction]');
        if (!form) return;
        const countryInput = form.elements.countryCode;
        const countryManualInput = form.querySelector('[data-partners-country-manual-input]');
        const countryManual = form.querySelector('[data-partners-country-manual]');
        const countryTrigger = form.querySelector('[data-partners-country-open]');
        const subdivisionInput = form.elements.subdivisionCode;
        const status = form.querySelector('[data-partners-jurisdiction-status]');
        const normalizeInput = (input) => {
            input.value = String(input.value || '').toUpperCase().replace(/\s+/g, '');
        };
        countryManualInput?.addEventListener('input', () => {
            countryManualInput.value = String(countryManualInput.value || '')
                .toUpperCase()
                .replace(/[^A-Z]/g, '')
                .slice(0, 2);
            if (countryInput) countryInput.value = countryManualInput.value;
        });
        subdivisionInput?.addEventListener('input', () => normalizeInput(subdivisionInput));
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const jurisdiction = this.normalizeJurisdiction(
                countryInput?.value,
                subdivisionInput?.value
            );
            if (!this.jurisdictionIsValid(jurisdiction, { countryRequired: true })) {
                if (status) {
                    status.setAttribute('role', 'alert');
                    status.setAttribute('aria-live', 'assertive');
                    status.textContent = 'Enter a two-letter country code and, if needed, a matching state or region code.';
                }
                const invalidInput = !/^[A-Z]{2}$/.test(jurisdiction.countryCode)
                    ? (countryManual?.hidden ? countryTrigger : countryManualInput)
                    : subdivisionInput;
                invalidInput?.focus();
                return;
            }
            if (status) {
                status.setAttribute('role', 'status');
                status.setAttribute('aria-live', 'polite');
                status.textContent = 'Checking the server policy for this jurisdiction.';
            }
            form.setAttribute('aria-busy', 'true');
            form.querySelector('button[type="submit"]')?.setAttribute('disabled', '');
            this._jurisdiction = jurisdiction;
            this.show(jurisdiction);
        });
    }

    bindCountryPicker() {
        const overlay = this.container?.querySelector('[data-partners-country-overlay]');
        const dialog = overlay?.querySelector('[data-region-pop]');
        const form = this.container?.querySelector('[data-partners-jurisdiction]');
        const trigger = form?.querySelector('[data-partners-country-open]');
        const value = form?.querySelector('[data-partners-country-value]');
        const countryInput = form?.querySelector('[data-partners-country-code]');
        const manual = form?.querySelector('[data-partners-country-manual]');
        const manualInput = form?.querySelector('[data-partners-country-manual-input]');
        const standard = form?.querySelector('[data-partners-country-standard]');
        const listButton = form?.querySelector('[data-partners-country-list]');
        const search = overlay?.querySelector('[data-partners-country-search]');
        const list = overlay?.querySelector('[data-partners-country-listbox]');
        const closeButton = overlay?.querySelector('[data-partners-country-close]');
        const manualButton = overlay?.querySelector('[data-partners-country-manual-open]');
        const status = form?.querySelector('[data-partners-jurisdiction-status]');
        if (!overlay || !dialog || !form || !trigger || !value
            || !countryInput || !manual || !manualInput || !standard
            || !search || !list || !closeButton || !manualButton) return;

        const countries = this.availableCountries();
        const countryByCode = new Map(countries.map((country) => [country.code, country]));
        let rendered = [];
        let activeIndex = -1;
        let restoreTarget = trigger;
        let backgroundSnapshot = [];

        const isolateBackground = () => {
            const candidates = new Set();
            let node = overlay;
            while (node?.parentElement) {
                const parent = node.parentElement;
                Array.from(parent.children).forEach((sibling) => {
                    if (sibling !== node && !sibling.matches?.('script, style, link')) {
                        candidates.add(sibling);
                    }
                });
                if (parent === document.body) break;
                node = parent;
            }
            backgroundSnapshot = Array.from(candidates).map((element) => ({
                element,
                inert: element.inert,
                ariaHidden: element.getAttribute('aria-hidden')
            }));
            backgroundSnapshot.forEach(({ element }) => {
                element.inert = true;
                element.setAttribute('aria-hidden', 'true');
            });
        };

        const restoreBackground = () => {
            backgroundSnapshot.forEach(({ element, inert, ariaHidden }) => {
                if (!element?.isConnected) return;
                element.inert = inert;
                if (ariaHidden == null) element.removeAttribute('aria-hidden');
                else element.setAttribute('aria-hidden', ariaHidden);
            });
            backgroundSnapshot = [];
        };

        const normalizedSearch = (input) => String(input || '')
            .trim()
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');

        const updateSelection = (countryCode) => {
            const country = countryByCode.get(countryCode) || null;
            countryInput.value = countryCode;
            manualInput.value = countryCode;
            value.textContent = country
                ? `${country.flag || ''} ${country.name} · ${country.code}`.trim()
                : (countryCode || 'Choose a country');
            list.querySelectorAll('[data-partners-country-option]').forEach((option) => {
                const selected = option.dataset.partnersCountryOption === countryCode;
                option.setAttribute('aria-selected', String(selected));
                option.classList.toggle('is-current', selected);
            });
        };

        const highlight = () => {
            rendered.forEach((entry, index) => {
                entry.element.classList.toggle('is-active', index === activeIndex);
            });
            const active = rendered[activeIndex];
            if (!active) {
                search.removeAttribute('aria-activedescendant');
                return;
            }
            search.setAttribute('aria-activedescendant', active.element.id);
            active.element.scrollIntoView({ block: 'nearest' });
        };

        const renderOptions = (query) => {
            const needle = normalizedSearch(query);
            const matches = countries.filter((country) => (
                !needle
                || normalizedSearch(country.name).includes(needle)
                || country.code.toLowerCase().includes(needle)
            ));
            if (!matches.length) {
                list.innerHTML = '<li class="region-picker-empty" role="presentation">No matching country. Use the ISO code option below.</li>';
                rendered = [];
                activeIndex = -1;
                search.removeAttribute('aria-activedescendant');
                return;
            }
            list.innerHTML = this.countryOptionMarkup(matches, countryInput.value);
            rendered = Array.from(list.querySelectorAll('[data-partners-country-option]'))
                .map((element) => ({
                    code: element.dataset.partnersCountryOption,
                    element
                }));
            activeIndex = rendered.findIndex((entry) => entry.code === countryInput.value);
            if (activeIndex < 0) activeIndex = 0;
            highlight();
        };

        const close = ({ restoreFocus = true } = {}) => {
            if (dialog.hidden) return false;
            dialog.hidden = true;
            overlay.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            search.setAttribute('aria-expanded', 'false');
            search.removeAttribute('aria-activedescendant');
            this.container?.classList.remove('partners-picker-open');
            restoreBackground();
            if (restoreFocus) {
                const target = restoreTarget?.isConnected ? restoreTarget : trigger;
                try { target.focus({ preventScroll: true }); } catch (_) { target.focus?.(); }
            }
            return true;
        };

        const open = () => {
            if (!dialog.hidden) return;
            restoreTarget = document.activeElement?.isConnected ? document.activeElement : trigger;
            overlay.hidden = false;
            dialog.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
            search.setAttribute('aria-expanded', 'true');
            this.container?.classList.add('partners-picker-open');
            search.value = '';
            renderOptions('');
            // Move focus into the dialog before hiding the trigger's ancestry
            // from TalkBack; this avoids even one rendered frame with focus
            // parked under aria-hidden.
            try { search.focus({ preventScroll: true }); } catch (_) { search.focus?.(); }
            isolateBackground();
        };

        const choose = (countryCode) => {
            const country = countryByCode.get(countryCode);
            if (!country) return;
            updateSelection(country.code);
            standard.hidden = false;
            manual.hidden = true;
            if (status) {
                status.setAttribute('role', 'status');
                status.setAttribute('aria-live', 'polite');
                status.textContent = `${country.name} selected.`;
            }
            close();
        };

        const enterManualCode = () => {
            close({ restoreFocus: false });
            standard.hidden = true;
            manual.hidden = false;
            requestAnimationFrame(() => {
                try { manualInput.focus({ preventScroll: true }); } catch (_) { manualInput.focus?.(); }
                manualInput.select?.();
            });
        };

        trigger.addEventListener('click', open);
        closeButton.addEventListener('click', () => close());
        manualButton.addEventListener('click', enterManualCode);
        listButton?.addEventListener('click', () => {
            manual.hidden = true;
            standard.hidden = false;
            trigger.focus();
        });
        search.addEventListener('input', () => renderOptions(search.value));
        search.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                event.stopPropagation();
                if (rendered.length) activeIndex = Math.min(activeIndex + 1, rendered.length - 1);
                highlight();
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                event.stopPropagation();
                if (rendered.length) activeIndex = Math.max(activeIndex - 1, 0);
                highlight();
            } else if (event.key === 'Home') {
                event.preventDefault();
                activeIndex = rendered.length ? 0 : -1;
                highlight();
            } else if (event.key === 'End') {
                event.preventDefault();
                activeIndex = rendered.length - 1;
                highlight();
            } else if (event.key === 'Enter') {
                event.preventDefault();
                if (rendered[activeIndex]) choose(rendered[activeIndex].code);
            }
        });
        list.addEventListener('click', (event) => {
            const option = event.target.closest('[data-partners-country-option]');
            if (option) choose(option.dataset.partnersCountryOption);
        });
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        dialog.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' || event.key === 'GoBack' || event.key === 'BrowserBack') {
                event.preventDefault();
                event.stopPropagation();
                close();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = Array.from(dialog.querySelectorAll(
                'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )).filter((element) => !element.hidden && element.getClientRects().length > 0);
            if (!focusable.length) {
                event.preventDefault();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });

        overlay.__regionClose = () => close();
        this._closeCountryPicker = close;
        updateSelection(countryInput.value);
    }

    focusTitle() {
        requestAnimationFrame(() => {
            if (!this._visible) return;
            const title = this.container?.querySelector('#partners-title');
            try { title?.focus({ preventScroll: true }); } catch (_) { title?.focus?.(); }
        });
    }

    regionLabel(policy) {
        const code = policy?.country_code;
        if (!code) return '';
        let country = code;
        try {
            country = new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' }).of(code) || code;
        } catch (_) { /* keep the validated ISO code */ }
        return policy.subdivision_code ? `${country} · ${policy.subdivision_code}` : country;
    }

    percent(basisPoints) {
        const value = Number.isFinite(basisPoints) ? basisPoints / 100 : 20;
        return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)}%`;
    }

    statusLabel(value, fallback) {
        const labels = {
            invited: 'Invited',
            pending_verification: 'Pending verification',
            active: 'Active',
            held: 'On hold',
            suspended: 'Suspended',
            closed: 'Closed',
            not_started: 'Not started',
            pending: 'Pending',
            verified: 'Verified',
            failed: 'Failed',
            expired: 'Expired',
            not_accepted: 'Not accepted',
            accepted: 'Accepted',
            none: 'Not created',
            revoked: 'Revoked'
        };
        return labels[value] || fallback;
    }

    escape(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

window.PartnersPage = PartnersPage;
