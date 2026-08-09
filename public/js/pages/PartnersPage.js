/**
 * Norva Partners — authenticated individual partner journey.
 *
 * Visibility and every displayed policy fact come from the strictly validated
 * norva-partners contracts. Membership and sharing stay independent from the
 * optional cash pilot; KYC and every financial decision remain authoritative
 * on the server.
 */
class PartnersPage {
    static BIOMETRIC_CONSENT_VERSION = 'partners-biometric-consent-v1';

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
        this._dashboardTimeoutMs = 10000;
        this._payoutTimeoutMs = 8000;
        this._payoutSetupTimeoutMs = 8000;
        this._accessRequestTimeoutMs = 8000;
        this._kycRightsTimeoutMs = 8000;
        this._bootstrapTtlMs = 30000;
        this._sessionIdentityKey = '';
        this._jurisdiction = { countryCode: '', subdivisionCode: '' };
        this._actionKeys = new Map();
        this._dashboardAbort = null;
        this._dashboardRefreshTimer = 0;
        this._payoutAbort = null;
        this._payoutProfile = null;
        this._payoutLoadState = 'idle';
        this._closeQrDialog = null;
        this._closePayoutDialog = null;
        this._closeCreditDialog = null;
        this._closeCashDialog = null;
        this._creditAbort = null;
        this._cashCountryAbort = null;
        this._creditToken = 0;
        this._dashboardFilter = 'all';
        this._dashboardCursor = null;
        this._dashboardPages = [];
        this._membershipDashboard = null;
        this._nativeShareRequests = new Map();
        this._nativeShareListenerBound = false;
        this._tvRelayAbort = null;
        this._tvRelayPollTimer = 0;
        this._tvRelay = null;
        this._tvRelayCreateKey = '';
        this._accessRequestAbort = null;
        this._accessRequestToken = 0;
        this._earlyAccessContext = null;
        this._kycRightsAbort = null;
        this._kycRightsToken = 0;
        this._kycRightsData = null;
    }

    canUseUserPartners() {
        const user = this.app?.currentUser || {};
        return Boolean(
            this.canDiscoverUserPartners()
            && window.NorvaCloud?.partners
            && typeof window.NorvaCloud.partners.bootstrap === 'function'
        );
    }

    canDiscoverUserPartners() {
        const user = this.app?.currentUser || {};
        return Boolean(user.cloud && !user.device);
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
        // User discovery remains navigable even if the operational API is
        // temporarily unavailable; show() then presents the sanitized retry
        // state. TV still requires the complete relay capability surface.
        return this.canDiscoverUserPartners() || this.canUseTvPartners();
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
        // The authenticated Web/mobile discovery entry is always available.
        // Server visibility continues to gate Android TV relay and every
        // operational Partners action.
        const allowed = this.canDiscoverUserPartners()
            || (Boolean(visible) && this.canUseTvPartners());
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
        // Discovery is immediate for a real Cloud user. Bootstrap only warms
        // authoritative eligibility; disabled flags or a transient outage must
        // not make the secondary entry disappear again.
        this.setEntryVisibility(false);
        this.ensureSessionContext();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this._visibilityTimeoutMs);
        try {
            const envelope = await this.loadBootstrap({
                signal: controller.signal,
                ...this._jurisdiction
            });
            this.setEntryVisibility(envelope.data.schema_version === 2
                ? envelope.data.eligibility.visible === true
                : envelope.data.visibility.visible === true);
            return true;
        } catch (_) {
            this.setEntryVisibility(false);
            return true;
        } finally {
            clearTimeout(timeout);
        }
    }

    async show(options = {}) {
        if (this.canUseTvPartners()) {
            await this.showTvRelay();
            return;
        }
        this._closeQrDialog?.({ restoreFocus: false });
        this._closeQrDialog = null;
        this._closePayoutDialog?.({ restoreFocus: false });
        this._closePayoutDialog = null;
        this._closeCreditDialog?.({ restoreFocus: false });
        this._closeCreditDialog = null;
        this._closeCashDialog?.({ restoreFocus: false });
        this._closeCashDialog = null;
        this._cashCountryAbort?.abort();
        this._cashCountryAbort = null;
        this._creditAbort?.abort();
        this._creditAbort = null;
        this._creditToken += 1;
        clearTimeout(this._dashboardRefreshTimer);
        this._dashboardRefreshTimer = 0;
        this._accessRequestAbort?.abort();
        this._accessRequestAbort = null;
        this._accessRequestToken += 1;
        this._earlyAccessContext = null;
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
            let renderData = envelope.data;
            let activationNextAction = null;
            const account = renderData.schema_version === 1 ? renderData.account : null;
            if (account?.exists && account.status === 'pending_verification') {
                const reconcile = window.NorvaCloud?.partners?.activation?.reconcile;
                if (typeof reconcile !== 'function') {
                    throw new Error('partners_activation_reconcile_unavailable');
                }
                const reconciled = await reconcile({ signal: this._showAbort.signal });
                if (!this._visible || token !== this._showToken) return;
                activationNextAction = reconciled.data.next_action;
                renderData = {
                    ...renderData,
                    account: {
                        ...renderData.account,
                        ...reconciled.data.account
                    }
                };
                // Reconciliation can activate the account. Never retain the
                // pre-reconcile bootstrap snapshot for a later visibility read.
                this.bootstrapEnvelope = null;
            }
            this._jurisdiction = jurisdiction;
            this.setEntryVisibility(renderData.schema_version === 2
                ? renderData.eligibility.visible === true
                : renderData.visibility.visible === true);
            this.renderBootstrap(renderData, { nextAction: activationNextAction });
            if (renderData.schema_version === 1 && renderData.account.exists) {
                this.loadKycRights();
            }
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
        this._closeQrDialog?.({ restoreFocus: false });
        this._closeQrDialog = null;
        this._closePayoutDialog?.({ restoreFocus: false });
        this._closePayoutDialog = null;
        this._closeCreditDialog?.({ restoreFocus: false });
        this._closeCreditDialog = null;
        this._closeCashDialog?.({ restoreFocus: false });
        this._closeCashDialog = null;
        this._cashCountryAbort?.abort();
        this._cashCountryAbort = null;
        this._creditAbort?.abort();
        this._creditAbort = null;
        this._creditToken += 1;
        clearTimeout(this._dashboardRefreshTimer);
        this._dashboardRefreshTimer = 0;
        this._dashboardAbort?.abort();
        this._dashboardAbort = null;
        this._payoutAbort?.abort();
        this._payoutAbort = null;
        this._accessRequestAbort?.abort();
        this._accessRequestAbort = null;
        this._accessRequestToken += 1;
        this._kycRightsAbort?.abort();
        this._kycRightsAbort = null;
        this._kycRightsToken += 1;
        this._kycRightsData = null;
        this._earlyAccessContext = null;
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
        this._closeQrDialog?.({ restoreFocus: false });
        this._closeQrDialog = null;
        this._closePayoutDialog?.({ restoreFocus: false });
        this._closePayoutDialog = null;
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

    renderBootstrap(data, { nextAction = null } = {}) {
        if (data.schema_version === 2) {
            this.renderMembershipBootstrap(data);
            return;
        }
        const view = this.resolveView(data);
        if (view === 'discovery') {
            this.renderDiscovery(data);
            return;
        }
        if (view === 'pending') {
            this.renderPending(data, { nextAction });
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
            this.openEarlyAccess(data, 'invite');
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
        if (!data.account.exists) {
            this.openEarlyAccess(data, 'disabled');
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
                || account.status === 'closed') return 'disabled';
            if (account.status === 'held') return 'attention';
            if (data.eligibility.reason === 'account_attention_required') return 'attention';
            if (['country_required', 'country_not_supported', 'subdivision_not_supported']
                .includes(data.eligibility.reason)
                || data.policy?.individual_available === false) return 'attention';
            if (!data.flags.partners_enabled
                || data.visibility.reason === 'disabled'
                || data.eligibility.reason === 'disabled'
                || data.eligibility.reason === 'account_blocked') return 'disabled';
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

    renderMembershipBootstrap(data) {
        const status = data.membership.status;
        if (status === 'active') {
            if (!data.program) {
                this.renderUnavailable({
                    title: 'Programme rules are temporarily unavailable',
                    copy: 'Norva cannot safely display sharing or balance actions without the authoritative programme. Your membership and balance are unchanged.',
                    tone: 'error',
                    retry: true
                });
                return;
            }
            this.renderMembershipActive(data);
            return;
        }
        if (['held', 'suspended', 'closed'].includes(status)
            || data.eligibility.reason === 'account_blocked') {
            this.renderMembershipAttention(data);
            return;
        }
        if (!data.membership.exists
            && (data.eligibility.reason === 'pilot_not_allowed'
                || (data.flags?.partners_invite_only && !data.eligibility.eligible))) {
            this.renderUnavailable({
                title: 'Norva Partners is currently invitation-only',
                copy: 'This account is not in the current pilot cohort. No identity check or payout setup is needed now. Your ordinary Norva access is unchanged, and you can return when the programme opens more broadly.',
                tone: 'neutral',
                retry: true
            });
            return;
        }
        if (!data.membership.exists
            && data.eligibility.eligible
            && data.program) {
            this.renderMembershipDiscovery(data);
            return;
        }
        const state = ({
            email_unconfirmed: {
                title: 'Confirm your Norva email to join Partners',
                copy: 'Open the confirmation message sent by Norva, then return here. Identity verification is not required to join, share or earn.'
            },
            disabled: {
                title: 'Norva Partners is temporarily paused',
                copy: 'Joining and earning are paused by the authoritative programme switch. No account or referral link was created.'
            },
            program_unavailable: {
                title: 'Programme rules are temporarily unavailable',
                copy: 'Norva cannot accept terms until the authoritative programme is restored. No local defaults were used.'
            }
        })[data.eligibility.reason] || {
            title: 'Norva Partners is temporarily unavailable',
            copy: 'Norva could not confirm the authoritative programme state. No account or referral link was created.'
        };
        this.renderUnavailable({
            ...state,
            tone: data.eligibility.reason === 'email_unconfirmed' ? 'neutral' : 'error',
            retry: true
        });
    }

    openEarlyAccess(data, reason) {
        this._earlyAccessContext = { data, reason };
        this.renderEarlyAccess(data, {
            reason,
            phase: 'pending'
        });
        void this.loadEarlyAccessRequest(data, reason);
    }

    async loadEarlyAccessRequest(data, reason, { paintPending = false } = {}) {
        const api = window.NorvaCloud?.partners?.accessRequest;
        this._earlyAccessContext = { data, reason, programPreview: null };
        if (!api || typeof api.get !== 'function' || typeof api.request !== 'function') {
            this._accessRequestAbort?.abort();
            this._accessRequestAbort = null;
            this._accessRequestToken += 1;
            if (this._visible) {
                this.renderEarlyAccess(data, { reason, phase: 'disabled' });
            }
            return false;
        }
        const token = ++this._accessRequestToken;
        this._accessRequestAbort?.abort();
        const controller = new AbortController();
        this._accessRequestAbort = controller;
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this._accessRequestTimeoutMs);
        if (paintPending) {
            this.renderEarlyAccess(data, { reason, phase: 'pending' });
        }
        try {
            const envelope = await api.get({ signal: controller.signal });
            if (!this._visible || token !== this._accessRequestToken) return false;
            const request = envelope?.data?.request || null;
            const programPreview = this.normalizeProgramPreview(
                envelope?.data?.program_preview
            );
            if (!this.isAccessRequestRecord(request)) {
                throw new Error('partners_access_request_contract_invalid');
            }
            if (request.exists) {
                this._jurisdiction = this.normalizeJurisdiction(
                    request.country_code,
                    request.subdivision_code
                );
            }
            this.renderEarlyAccess(data, {
                reason,
                phase: request.exists ? 'requested' : 'ready',
                request,
                programPreview
            });
            return true;
        } catch (error) {
            if ((error?.name === 'AbortError' && !timedOut) || !this._visible
                || token !== this._accessRequestToken) return false;
            const disabled = [
                'partners_access_request_disabled',
                'partners_access_requests_disabled'
            ].includes(error?.code);
            this.renderEarlyAccess(data, {
                reason,
                phase: disabled ? 'disabled' : 'error',
                message: disabled ? '' : this.partnerErrorMessage(error)
            });
            return false;
        } finally {
            clearTimeout(timeout);
            if (token === this._accessRequestToken
                && this._accessRequestAbort === controller) this._accessRequestAbort = null;
        }
    }

    isAccessRequestRecord(request) {
        if (!request || typeof request !== 'object' || Array.isArray(request)
            || typeof request.exists !== 'boolean') return false;
        const nullableCountry = request.country_code == null
            || /^[A-Z]{2}$/.test(request.country_code);
        const nullableSubdivision = request.subdivision_code == null
            || (request.subdivision_code.length <= 12
                && /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(request.subdivision_code));
        const nullableDate = (value) => value == null
            || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
        if (!nullableCountry || !nullableSubdivision
            || !nullableDate(request.requested_at)
            || !nullableDate(request.reviewed_at)) return false;
        if (!request.exists) {
            return request.status == null
                && request.country_code == null
                && request.subdivision_code == null
                && request.requested_at == null
                && request.reviewed_at == null;
        }
        return ['requested', 'approved', 'declined'].includes(request.status)
            && /^[A-Z]{2}$/.test(request.country_code)
            && typeof request.requested_at === 'string';
    }

    renderEarlyAccess(data, {
        reason,
        phase,
        request = null,
        message = '',
        programPreview = null
    }) {
        if (!this.container) return;
        const previousScrollTop = this.getScrollElement()?.scrollTop || 0;
        const previousFocus = document.activeElement;
        const restoreBackFocus = Boolean(previousFocus?.closest?.('[data-partners-back]'));
        const restoreHeading = previousFocus?.id === 'partners-access-title'
            ? 'partners-access-title'
            : (previousFocus?.id === 'partners-title' ? 'partners-title' : '');
        this._closeCountryPicker?.({ restoreFocus: false });
        this._closeCountryPicker = null;
        const preview = this.normalizeProgramPreview(programPreview);
        this._earlyAccessContext = { data, reason, programPreview: preview };
        const invitationOnly = reason === 'invite';
        const title = invitationOnly
            ? 'Request a place in the Norva Partners pilot.'
            : (preview
                ? `Earn ${this.percent(preview.commission_rate_bps)} on eligible referrals.`
                : 'Be among the first to discover Norva Partners.');
        const copy = invitationOnly
            ? 'The supervised pilot is opening gradually. Tell us where you will participate from and Norva will review your request.'
            : (preview
                ? `The current server-published preview includes a ${preview.attribution_window_days}-day attribution window and ${preview.maturation_days}-day validation period. Access is still reviewed.`
                : 'Norva Partners is being opened in controlled stages. You can request early access now without starting KYC or creating a referral link.');
        const statusLabel = invitationOnly ? 'Invitation-only pilot' : 'Early access';
        const requestMarkup = this.earlyAccessRequestMarkup(phase, request, message);
        const pickerMarkup = phase === 'ready' && !request?.exists
            ? this.earlyAccessCountryPickerMarkup()
            : '';
        const liveMessages = {
            pending: 'Checking your Norva Partners early-access request.',
            ready: 'Early-access requests are open. Choose your country to continue.',
            requested: request?.status === 'approved'
                ? 'Your Norva Partners early-access request is approved.'
                : (request?.status === 'declined'
                    ? 'Your early-access request was reviewed and is not open for resubmission.'
                    : 'Your Norva Partners early-access request is awaiting review.'),
            success: 'Your Norva Partners early-access request was submitted successfully.',
            error: 'Norva could not load your early-access request.',
            disabled: 'Norva Partners early-access requests are temporarily unavailable.'
        };
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-discovery-grid partners-early-access-grid">
                    <div class="partners-discovery-copy">
                        <span class="partners-eyebrow">Norva Partners · Individuals</span>
                        <h1 id="partners-title" class="partners-display" tabindex="-1">${this.escape(title)}</h1>
                        <p class="partners-lead">${this.escape(copy)}</p>
                        <span class="partners-status-pill partners-status-warning">${this.escape(statusLabel)}</span>
                        ${this.earlyAccessPreviewMarkup(preview)}
                        <p class="partners-disclosure">An access request does not create a partner account, start identity verification, generate a referral link or guarantee earnings. Join, KYC, sharing and payouts remain locked until Norva's server policies explicitly authorize them.</p>
                    </div>
                    ${requestMarkup}
                </section>
                ${this.earlyAccessSteps()}
                ${this.liveRegion(liveMessages[phase] || liveMessages.ready, phase === 'error' ? 'assertive' : 'polite')}
            </main>
            ${pickerMarkup}`;
        this.bindCommonActions();
        this.bindEarlyAccessActions();
        if (this.container.querySelector('[data-partners-access-request-form]')) {
            this.bindCountryPicker();
        }
        requestAnimationFrame(() => {
            const scroller = this.getScrollElement();
            if (scroller) scroller.scrollTop = previousScrollTop;
            const target = phase === 'success'
                ? this.container?.querySelector('#partners-access-title')
                : (restoreBackFocus
                    ? this.container?.querySelector('[data-partners-back]')
                    : (restoreHeading
                        ? this.container?.querySelector(`#${restoreHeading}`)
                        : this.container?.querySelector('#partners-title')));
            try { target?.focus?.({ preventScroll: true }); } catch (_) { target?.focus?.(); }
        });
    }

    earlyAccessSteps() {
        return `<section class="partners-steps" aria-label="Early-access process">
            <article><span>1</span><div><strong>Request access</strong><p>Share the country where you would personally participate.</p></div></article>
            <article><span>2</span><div><strong>Norva reviews</strong><p>The team checks jurisdiction coverage and supervised-pilot capacity.</p></div></article>
            <article><span>3</span><div><strong>Unlock after release</strong><p>If approved, joining and identity verification appear only after the server opens access.</p></div></article>
        </section>`;
    }

    normalizeProgramPreview(preview) {
        if (preview == null) return null;
        if (!preview || typeof preview !== 'object' || Array.isArray(preview)
            || !Number.isSafeInteger(preview.commission_rate_bps)
            || preview.commission_rate_bps <= 0
            || preview.commission_rate_bps > 10000
            || !Number.isSafeInteger(preview.attribution_window_days)
            || preview.attribution_window_days <= 0
            || !Number.isSafeInteger(preview.maturation_days)
            || preview.maturation_days < 0
            || !preview.payout_thresholds
            || typeof preview.payout_thresholds !== 'object'
            || Array.isArray(preview.payout_thresholds)) return null;
        const thresholds = Object.fromEntries(Object.entries(preview.payout_thresholds)
            .filter(([currency, amount]) => (
                /^[A-Z]{3}$/.test(currency)
                && Number.isSafeInteger(amount)
                && amount > 0
            )));
        return {
            commission_rate_bps: preview.commission_rate_bps,
            attribution_window_days: preview.attribution_window_days,
            maturation_days: preview.maturation_days,
            payout_thresholds: thresholds
        };
    }

    earlyAccessPreviewMarkup(preview) {
        if (!preview) return '';
        const threshold = this.referencePayoutThreshold(preview);
        return `<dl class="partners-program-facts partners-preview-facts" aria-label="Current programme preview">
            <div><dt>Recurring commission</dt><dd>${this.escape(this.percent(preview.commission_rate_bps))}</dd></div>
            <div><dt>Attribution window</dt><dd>${preview.attribution_window_days} days</dd></div>
            <div><dt>Validation period</dt><dd>${preview.maturation_days} days</dd></div>
            <div><dt>Reference threshold</dt><dd>${this.escape(threshold)}</dd></div>
        </dl><p class="partners-program-note">Preview only. It does not prove eligibility, approval or future earnings.</p>`;
    }

    earlyAccessRequestMarkup(phase, request, message) {
        if (phase === 'pending') {
            return `<aside class="partners-program-card partners-access-card" aria-busy="true" aria-labelledby="partners-access-title">
                <span class="partners-eyebrow">Your request</span>
                <h2 id="partners-access-title">Checking securely</h2>
                <div class="partners-skeleton" aria-hidden="true"></div>
                <div class="partners-skeleton" aria-hidden="true"></div>
                <p>Norva is loading only the current request status for this account.</p>
            </aside>`;
        }
        if (phase === 'disabled') {
            return `<aside class="partners-program-card partners-access-card" aria-labelledby="partners-access-title">
                <span class="partners-status-pill">Requests paused</span>
                <h2 id="partners-access-title" tabindex="-1">Early-access requests are temporarily closed</h2>
                <p>No application, identity check or partner account has been created. Return here later when the supervised intake reopens.</p>
                <div class="partners-actions partners-actions-row">
                    <button class="btn btn-secondary" type="button" data-partners-back>Back</button>
                </div>
            </aside>`;
        }
        if (phase === 'error') {
            return `<aside class="partners-program-card partners-access-card" aria-labelledby="partners-access-title">
                <span class="partners-status-pill partners-status-warning">Status unavailable</span>
                <h2 id="partners-access-title" tabindex="-1">We could not check your request</h2>
                <p role="alert">${this.escape(message || 'Norva could not load the request securely. No action was taken.')}</p>
                <div class="partners-actions partners-actions-row">
                    <button class="btn btn-primary" type="button" data-partners-access-retry>Try again</button>
                    <button class="btn btn-secondary" type="button" data-partners-back>Back</button>
                </div>
            </aside>`;
        }
        if (request?.exists && ['requested', 'approved'].includes(request.status)) {
            const approved = request.status === 'approved';
            const successful = phase === 'success';
            const heading = approved
                ? 'Your early access is approved'
                : (successful ? 'Request sent successfully' : 'Your request is in review');
            const copy = approved
                ? 'Norva has approved this request. Operational access will appear here only when the programme and your jurisdiction are opened by the server.'
                : 'The Norva team will review pilot capacity and jurisdiction coverage. You do not need to submit another request.';
            const country = this.regionLabel({
                country_code: request.country_code,
                subdivision_code: request.subdivision_code
            }) || request.country_code;
            return `<aside class="partners-program-card partners-access-card" aria-labelledby="partners-access-title">
                <span class="partners-status-pill ${approved || successful ? 'partners-status-success' : 'partners-status-warning'}">${approved ? 'Approved' : 'Requested'}</span>
                <h2 id="partners-access-title" tabindex="-1">${this.escape(heading)}</h2>
                <p>${this.escape(copy)}</p>
                <dl class="partners-checklist">
                    <div><dt>Country</dt><dd>${this.escape(country)}</dd></div>
                    <div><dt>Status</dt><dd>${approved ? 'Approved · awaiting release' : 'Awaiting review'}</dd></div>
                    <div><dt>Requested</dt><dd>${this.escape(this.formatDateTime(request.requested_at))}</dd></div>
                </dl>
                <div class="partners-actions partners-actions-row">
                    <button class="btn btn-secondary" type="button" data-partners-back>Back</button>
                </div>
            </aside>`;
        }
        const declined = request?.exists && request.status === 'declined';
        if (declined) {
            const country = this.regionLabel({
                country_code: request.country_code,
                subdivision_code: request.subdivision_code
            }) || request.country_code;
            return `<aside class="partners-program-card partners-access-card" aria-labelledby="partners-access-title">
                <span class="partners-status-pill">Reviewed</span>
                <h2 id="partners-access-title" tabindex="-1">This early-access request was not approved</h2>
                <p>The review is complete and this request cannot be submitted again. No partner account, identity check, referral link or earnings were created.</p>
                <dl class="partners-checklist">
                    <div><dt>Country</dt><dd>${this.escape(country)}</dd></div>
                    <div><dt>Status</dt><dd>Not approved</dd></div>
                    <div><dt>Reviewed</dt><dd>${this.escape(this.formatDateTime(request.reviewed_at || request.requested_at))}</dd></div>
                </dl>
                <div class="partners-actions partners-actions-row">
                    <a class="btn btn-secondary" href="/support.html?returnTo=%2Fapp%23partners">Contact support</a>
                    <button class="btn btn-ghost" type="button" data-partners-back>Back</button>
                </div>
            </aside>`;
        }
        const country = this.escape(this._jurisdiction.countryCode);
        const subdivision = this.escape(this._jurisdiction.subdivisionCode);
        const countries = this.availableCountries();
        const selectedCountry = countries.find((entry) => entry.code === this._jurisdiction.countryCode) || null;
        const manualCountry = Boolean(this._jurisdiction.countryCode && !selectedCountry);
        const countryLabel = selectedCountry
            ? `${selectedCountry.flag || ''} ${selectedCountry.name} · ${selectedCountry.code}`.trim()
            : 'Choose a country';
        return `<aside class="partners-program-card partners-access-card" aria-labelledby="partners-access-title">
            <span class="partners-eyebrow">Request early access</span>
            <h2 id="partners-access-title">Join the supervised intake</h2>
            <form class="partners-jurisdiction-form partners-access-form"
                data-partners-jurisdiction data-partners-access-request-form novalidate>
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
                            placeholder="US" aria-labelledby="partners-country-label"
                            aria-describedby="partners-country-hint">
                        <button class="btn btn-ghost partners-inline-action" type="button"
                            data-partners-country-list>Choose from country list</button>
                    </div>
                    <span id="partners-country-hint">Choose the country where you personally reside and would participate in the programme.</span>
                </div>
                <div class="partners-field">
                    <label for="partners-subdivision-code">State or region code <span>(optional)</span></label>
                    <input id="partners-subdivision-code" name="subdivisionCode" value="${subdivision}"
                        maxlength="12" inputmode="text" autocapitalize="characters"
                        autocomplete="off" spellcheck="false" placeholder="US-CA"
                        aria-describedby="partners-subdivision-hint">
                    <span id="partners-subdivision-hint">Use an ISO subdivision code only when your jurisdiction requires it.</span>
                </div>
                <div class="partners-form-status" data-partners-jurisdiction-status
                    data-partners-access-request-status role="status" aria-live="polite"
                    aria-atomic="true" tabindex="-1"></div>
                <div class="partners-actions partners-actions-row">
                    <button class="btn btn-primary partners-primary-action" type="submit"
                        data-partners-access-submit>Request early access</button>
                    <button class="btn btn-secondary" type="button" data-partners-back>Back</button>
                </div>
            </form>
            <p>Your request records only this account, jurisdiction and review timestamps. It does not start KYC or expose another user's information.</p>
        </aside>`;
    }

    earlyAccessCountryPickerMarkup() {
        const countries = this.availableCountries();
        return `<div class="partners-country-picker-overlay" data-region-picker
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
    }

    bindEarlyAccessActions() {
        this.container?.querySelector('[data-partners-access-retry]')
            ?.addEventListener('click', () => {
                const context = this._earlyAccessContext;
                if (context) void this.loadEarlyAccessRequest(
                    context.data,
                    context.reason,
                    { paintPending: true }
                );
            });
        const form = this.container?.querySelector('[data-partners-access-request-form]');
        if (!form) return;
        const countryInput = form.elements.countryCode;
        const countryManualInput = form.querySelector('[data-partners-country-manual-input]');
        const countryManual = form.querySelector('[data-partners-country-manual]');
        const countryTrigger = form.querySelector('[data-partners-country-open]');
        const subdivisionInput = form.elements.subdivisionCode;
        const status = form.querySelector('[data-partners-access-request-status]');
        const button = form.querySelector('[data-partners-access-submit]');
        countryManualInput?.addEventListener('input', () => {
            countryManualInput.value = String(countryManualInput.value || '')
                .toUpperCase()
                .replace(/[^A-Z]/g, '')
                .slice(0, 2);
            if (countryInput) countryInput.value = countryManualInput.value;
        });
        subdivisionInput?.addEventListener('input', () => {
            subdivisionInput.value = String(subdivisionInput.value || '')
                .toUpperCase()
                .replace(/\s+/g, '');
        });
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const jurisdiction = this.normalizeJurisdiction(
                countryInput?.value,
                subdivisionInput?.value
            );
            if (!this.jurisdictionIsValid(jurisdiction, { countryRequired: true })) {
                if (status) {
                    status.setAttribute('role', 'alert');
                    status.setAttribute('aria-live', 'assertive');
                    status.textContent = 'Choose a two-letter country code and, if needed, a matching state or region code.';
                }
                const invalidInput = !/^[A-Z]{2}$/.test(jurisdiction.countryCode)
                    ? (countryManual?.hidden ? countryTrigger : countryManualInput)
                    : subdivisionInput;
                invalidInput?.focus();
                return;
            }
            const api = window.NorvaCloud?.partners?.accessRequest;
            if (!api || typeof api.request !== 'function' || !button) {
                this.renderEarlyAccess(this._earlyAccessContext.data, {
                    reason: this._earlyAccessContext.reason,
                    phase: 'disabled'
                });
                return;
            }
            const showToken = this._showToken;
            const previousLabel = button.textContent;
            this._jurisdiction = jurisdiction;
            form.setAttribute('aria-busy', 'true');
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            button.textContent = 'Requesting access…';
            if (status) {
                status.setAttribute('role', 'status');
                status.setAttribute('aria-live', 'polite');
                status.textContent = 'Submitting your early-access request securely.';
            }
            try {
                const envelope = await api.request({
                    countryCode: jurisdiction.countryCode,
                    subdivisionCode: jurisdiction.subdivisionCode || undefined,
                    idempotencyKey: this.actionKey('access-request')
                });
                if (!this._visible || showToken !== this._showToken) return;
                const request = envelope?.data?.request || null;
                const programPreview = this.normalizeProgramPreview(
                    envelope?.data?.program_preview
                ) || this._earlyAccessContext.programPreview;
                if (envelope?.data?.action !== 'access_requested'
                    || !this.isAccessRequestRecord(request)) {
                    throw new Error('partners_access_request_contract_invalid');
                }
                this.clearActionKey('access-request');
                this.renderEarlyAccess(this._earlyAccessContext.data, {
                    reason: this._earlyAccessContext.reason,
                    phase: 'success',
                    request,
                    programPreview
                });
                requestAnimationFrame(() => this.container
                    ?.querySelector('#partners-access-title')?.focus?.({ preventScroll: true }));
            } catch (error) {
                if (!this._visible || showToken !== this._showToken) return;
                if (['partners_access_request_disabled', 'partners_access_requests_disabled']
                    .includes(error?.code)) {
                    this.renderEarlyAccess(this._earlyAccessContext.data, {
                        reason: this._earlyAccessContext.reason,
                        phase: 'disabled',
                        programPreview: this._earlyAccessContext.programPreview
                    });
                    return;
                }
                if (status) {
                    status.setAttribute('role', 'alert');
                    status.setAttribute('aria-live', 'assertive');
                    status.textContent = this.partnerErrorMessage(error);
                    status.focus?.({ preventScroll: true });
                }
            } finally {
                if (button.isConnected) {
                    button.disabled = false;
                    button.removeAttribute('aria-busy');
                    button.textContent = previousLabel;
                    form.removeAttribute('aria-busy');
                }
            }
        });
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

    renderMembershipDiscovery(data) {
        const program = data.program;
        const rate = this.percent(program.commission_rate_bps);
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-discovery-grid">
                    <div class="partners-discovery-copy">
                        <span class="partners-eyebrow">Join now · Verify only for cash</span>
                        <h1 id="partners-title" class="partners-display" tabindex="-1">Share Norva. Earn ${rate} on eligible renewals.</h1>
                        <p class="partners-lead">Your confirmed Norva account can join and receive a personal referral link immediately. Identity verification is never required to share, earn or convert an available balance into Norva access.</p>
                        <span class="partners-status-pill partners-status-success">Ready to join</span>
                        <form class="partners-join-form" data-partners-membership-form novalidate>
                            <label class="partners-consent-check">
                                <input type="checkbox" data-partners-terms-confirm>
                                <span>I accept the <a href="/partners-terms.html" target="_blank" rel="noopener noreferrer">Norva Partners Terms</a>.</span>
                            </label>
                            <label class="partners-consent-check">
                                <input type="checkbox" data-partners-disclosure-confirm>
                                <span>I understand that commission normally stays pending for at least ${program.maturation_days} days and may be reversed after a refund or chargeback.</span>
                            </label>
                            <div class="partners-actions">
                                <button class="btn btn-primary partners-primary-action" type="submit"
                                    data-partners-membership-join disabled>Join and get my link</button>
                                <span class="partners-action-note">No identity documents, tax details or payout destination are requested when you join.</span>
                            </div>
                            <div class="partners-form-status" data-partners-action-status role="status" aria-live="polite" aria-atomic="true"></div>
                        </form>
                        <p class="partners-disclosure"><strong>Important:</strong> earnings are not guaranteed. Commission is ${rate} of eligible payments after discounts and before tax. Refunds and chargebacks reverse the related commission. Available balance can fund Norva access without identity verification; cash transfers require identity, tax and payout checks.</p>
                    </div>
                    <aside class="partners-program-card" aria-labelledby="partners-program-title">
                        <h2 id="partners-program-title">How Norva Partners works</h2>
                        <p class="partners-program-intro">Open any info button for a plain-language example.</p>
                        ${this.membershipProgramFacts(program, rate)}
                    </aside>
                </section>
                ${this.membershipSteps(program)}
                ${this.liveRegion('Norva Partners is ready. Accept the current terms and disclosure to join without identity verification.')}
            </main>`;
        this.bindCommonActions();
        this.bindMembershipDiscoveryActions(data);
        this.focusTitle();
    }

    bindMembershipDiscoveryActions(data) {
        const form = this.container?.querySelector('[data-partners-membership-form]');
        const terms = form?.querySelector('[data-partners-terms-confirm]');
        const disclosure = form?.querySelector('[data-partners-disclosure-confirm]');
        const button = form?.querySelector('[data-partners-membership-join]');
        if (!form || !terms || !disclosure || !button) return;
        const sync = () => {
            button.disabled = !(terms.checked && disclosure.checked);
        };
        terms.addEventListener('change', sync);
        disclosure.addEventListener('change', sync);
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!terms.checked || !disclosure.checked) {
                this.setActionStatus('Accept the current terms and programme disclosure first.', 'error');
                (!terms.checked ? terms : disclosure).focus();
                return;
            }
            await this.runPartnerAction(button, 'Creating your link…', async () => {
                const api = window.NorvaCloud?.partners?.join;
                if (typeof api !== 'function') throw new Error('partners_membership_join_unavailable');
                const routeToken = this._showToken;
                await api({
                    termsAccepted: true,
                    disclosureAccepted: true,
                    idempotencyKey: this.actionKey('membership-join')
                });
                this.clearActionKey('membership-join');
                if (!this._visible || routeToken !== this._showToken || !button.isConnected) return;
                this.setActionStatus('You joined Norva Partners. Loading your personal link.');
                this.bootstrapEnvelope = null;
                await this.show();
            });
        });
        sync();
    }

    renderMembershipAttention(data) {
        const status = this.statusLabel(data.membership.status, 'Partner membership');
        const terminal = ['suspended', 'closed'].includes(data.membership.status);
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-state-card partners-state-wide">
                    <span class="partners-status-pill partners-status-warning">${terminal ? 'Membership unavailable' : 'Review in progress'}</span>
                    <h1 id="partners-title" tabindex="-1">${terminal ? 'Your Partners membership is not active.' : 'Your Partners membership is temporarily on hold.'}</h1>
                    <p>Sharing, earning and balance conversion follow the authoritative membership state. No local action can bypass this protection.</p>
                    <dl class="partners-checklist">
                        <div><dt>Membership</dt><dd>${this.escape(status)}</dd></div>
                        <div><dt>Identity check</dt><dd>${this.escape(this.statusLabel(data.membership.verification_status, 'Not required for membership'))}</dd></div>
                    </dl>
                    <div class="partners-actions partners-actions-row">
                        <a class="btn btn-secondary" href="/support.html?returnTo=%2Fapp%23partners">Contact support</a>
                        <button class="btn btn-ghost" type="button" data-partners-back>Back</button>
                    </div>
                </section>
                ${this.liveRegion('Your Norva Partners membership needs a secure review.', 'assertive')}
            </main>`;
        this.bindCommonActions();
        this.focusTitle();
    }

    renderMembershipActive(data) {
        if (!['all', 'pending', 'available', 'redeemed', 'paid', 'reversed']
            .includes(this._dashboardFilter)) {
            this._dashboardFilter = 'all';
        }
        this._dashboardAbort?.abort();
        this._dashboardAbort = null;
        clearTimeout(this._dashboardRefreshTimer);
        this._dashboardRefreshTimer = 0;
        const cashPilotLimited = data.cash_readiness?.reason === 'cash_pilot_not_allowed';
        const cashActionLabel = cashPilotLimited
            ? 'Cash transfer pilot'
            : 'Receive a cash transfer';
        const availableBalanceNote = cashPilotLimited
            ? 'Convert to Norva · cash pilot limited'
            : 'Convert or request cash';
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-dashboard-heading">
                    <div>
                        <span class="partners-status-pill partners-status-success">Ready to share</span>
                        <h1 id="partners-title" tabindex="-1">Your Partners balance</h1>
                        <p>Share immediately, follow the ${data.program.maturation_days}-day validation period and choose how to use your available balance.</p>
                    </div>
                    <div class="partners-dashboard-actions">
                        <button class="btn btn-secondary" type="button" data-partners-cash-button>${cashActionLabel}</button>
                        <button class="btn btn-secondary" type="button" data-partners-dashboard-retry>Refresh</button>
                    </div>
                </section>
                <section class="partners-metrics" aria-label="Partner balance" data-partners-dashboard-metrics aria-busy="true">
                    ${this.metric('Available to use', 'Loading', availableBalanceNote)}
                    ${this.metric('In validation', 'Loading', `${data.program.maturation_days}-day validation window`)}
                    ${this.metric('Converted to Norva', 'Loading', 'Access credits used')}
                    ${this.metric('Next balance update', 'Loading', 'Authoritative schedule')}
                </section>
                <section data-partners-dashboard-content aria-busy="true">
                    <div class="partners-skeleton partners-skeleton-hero" aria-hidden="true"></div>
                </section>
                <div class="partners-form-status" data-partners-action-status role="status" aria-live="polite" aria-atomic="true"></div>
                ${this.liveRegion('Norva Partners is active. Loading your personal link and balance.')}
            </main>`;
        this.bindCommonActions();
        this.container.querySelector('[data-partners-dashboard-retry]')
            ?.addEventListener('click', () => this.loadDashboard(data, { reset: true }));
        this.container.querySelector('[data-partners-cash-button]')
            ?.addEventListener('click', (event) => this.openCashJourney({
                ...data,
                cash_readiness: this._membershipDashboard?.cash_readiness || data.cash_readiness
            }, event.currentTarget));
        this.focusTitle();
        this.loadDashboard(data, { reset: true });
    }

    renderDiscovery(data) {
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-consent-card" aria-labelledby="partners-title">
                    <div>
                        <span class="partners-eyebrow">Secure programme update</span>
                        <h1 id="partners-title" tabindex="-1">Refresh to load the current Partners contract.</h1>
                        <p>This compatibility response is from an older server contract. Norva will not start identity verification or create a membership from stale rules. The current journey lets individuals join, share, earn and convert to Norva access without KYC; Didit is reserved for optional cash transfers.</p>
                    </div>
                    <button class="btn btn-primary partners-primary-action" type="button" data-partners-retry>Refresh securely</button>
                </section>
                ${this.liveRegion('A current Norva Partners contract is required. Refresh the page to continue.')}
            </main>`;
        this.bindCommonActions();
        this.container.querySelector('[data-partners-retry]')
            ?.addEventListener('click', () => this.reload());
        this.focusTitle();
    }

    membershipProgramFacts(program, rate) {
        const attributionDays = Number.isSafeInteger(program?.attribution_window_days)
            ? program.attribution_window_days
            : 30;
        const maturationDays = Number.isSafeInteger(program?.maturation_days)
            ? program.maturation_days
            : 45;
        const infoIcon = window.Icons?.info || '';
        const facts = [
            {
                id: 'commission',
                label: 'Commission on eligible payments',
                value: rate,
                title: `How ${rate} is calculated`,
                copy: `Example: if the eligible amount after discounts and before tax is US$5, your commission is US$1. Refunds or chargebacks reverse the related amount.`
            },
            {
                id: 'attribution',
                label: 'Referral tracking window',
                value: `${attributionDays} days`,
                title: `What the ${attributionDays}-day window means`,
                copy: `A person normally needs to start their eligible subscription within ${attributionDays} days of using your link. Attribution still depends on eligibility and anti-fraud checks.`
            },
            {
                id: 'validation',
                label: 'Balance validation',
                value: `${maturationDays} days`,
                title: `Why commission waits at least ${maturationDays} days`,
                copy: `Commission first appears as pending. It normally becomes available after at least ${maturationDays} days, once refund, chargeback and eligibility checks are complete.`
            },
            {
                id: 'sharing',
                label: 'Start sharing',
                value: 'Immediately',
                title: 'What you need to start',
                copy: 'A confirmed Norva account and acceptance of the current terms are enough to create your personal link. No identity documents are requested.'
            },
            {
                id: 'access',
                label: 'Use balance for Norva',
                value: 'No identity check',
                title: 'Using balance for your Norva access',
                copy: 'Available commission can be converted through an exact server quote into one or more months of Norva access. You review the amount before confirming; the conversion is final and cannot be paid out as cash.'
            },
            {
                id: 'cash',
                label: 'Transfer balance to cash',
                value: 'Verification required',
                title: 'Why cash requires verification',
                copy: 'Before a cash transfer, Norva must verify your identity, country, tax details and payout destination. You can still share and use balance for Norva access without completing this step.'
            }
        ];
        return `<dl class="partners-program-facts partners-program-facts--guided" aria-label="Norva Partners programme explained">
            ${facts.map((fact) => `<div class="partners-program-fact">
                <dt>${this.escape(fact.label)}</dt>
                <dd class="partners-program-value">${this.escape(fact.value)}</dd>
                <dd class="partners-program-help">
                    <details name="partners-program-help">
                        <summary aria-label="More information about ${this.escape(fact.label)}"
                            aria-controls="partners-program-help-${this.escape(fact.id)}">${infoIcon}</summary>
                        <div class="partners-program-help-popover" id="partners-program-help-${this.escape(fact.id)}" role="note">
                            <strong>${this.escape(fact.title)}</strong>
                            <p>${this.escape(fact.copy)}</p>
                        </div>
                    </details>
                </dd>
            </div>`).join('')}
        </dl>`;
    }

    renderPending(data, { nextAction = null } = {}) {
        const verification = this.statusLabel(data.account.verification_status, 'Identity verification');
        const contract = this.statusLabel(data.account.contract_status, 'Programme terms');
        const link = this.statusLabel(data.account.link_status, 'Referral link');
        const needsTerms = nextAction
            ? nextAction === 'accept_terms'
            : data.account.contract_status !== 'accepted';
        const canAcceptTerms = needsTerms
            && Boolean(data.policy?.terms_version)
            && Boolean(data.policy?.disclosure_version);
        const verificationRetry = ['failed', 'expired'].includes(
            data.account.verification_status
        );
        const canStartKyc = !needsTerms
            && (nextAction
                ? nextAction === 'start_verification'
                : ['not_started', 'failed', 'expired'].includes(
                    data.account.verification_status
                ))
            && Boolean(data.policy?.disclosure_version);
        const verificationPending = nextAction
            ? nextAction === 'await_verification'
            : data.account.verification_status === 'pending';
        const activationPending = !needsTerms
            && data.account.verification_status === 'verified'
            && data.account.status !== 'active'
            && (!nextAction || nextAction === 'activate_account');
        const supportRequired = nextAction === 'contact_support';
        const stateCopy = needsTerms
            ? {
                badge: 'Application received',
                title: 'Review the current programme terms to continue.',
                copy: 'Your application is saved. Identity verification stays locked until the current terms and disclosure are accepted.',
                announcement: 'Your Norva Partners application is ready for the current programme terms.'
            }
            : (supportRequired
                ? {
                    badge: 'Support required',
                    title: 'Your verified partner profile needs a secure review.',
                    copy: 'Norva cannot complete activation automatically from this state. Contact Support; no referral or financial action has been enabled locally.',
                    announcement: 'Norva Partners requires a secure Support review.'
                }
                : (verificationRetry
                ? {
                    badge: data.account.verification_status === 'expired'
                        ? 'Verification expired'
                        : 'Verification incomplete',
                    title: 'Start a fresh secure identity check.',
                    copy: 'The previous hosted check did not complete. Review the confirmations below to start a fresh Didit session; no identity document is uploaded to this page.',
                    announcement: 'A fresh Norva Partners identity check is available.'
                }
                : (data.account.verification_status === 'not_started'
                    ? {
                        badge: 'Verification required',
                        title: 'Verify your identity to activate your partner link.',
                        copy: 'Complete the secure hosted identity check. Norva unlocks the referral link only after the signed provider result is confirmed.',
                        announcement: 'Norva Partners identity verification is ready to start.'
                    }
                    : (activationPending
                        ? {
                            badge: 'Activation in progress',
                            title: 'Your identity is verified. Activation is finishing.',
                            copy: 'Norva is confirming the final programme checks and preparing your referral link. No extra identity action is required.',
                            announcement: 'Norva Partners activation is in progress.'
                        }
                        : {
                            badge: 'Verification pending',
                            title: 'Your individual partner profile is being checked.',
                            copy: 'Norva waits for authoritative server confirmation before enabling a referral link. Refreshing this page cannot bypass verification.',
                            announcement: 'Norva Partners identity verification is pending.'
                        }))));
        const pendingAction = canAcceptTerms
            ? `<button class="btn btn-primary partners-primary-action" type="button"
                    data-partners-accept-terms>Accept current programme terms</button>`
            : (canStartKyc
                ? `<form class="partners-join-form partners-kyc-form" data-partners-kyc-form novalidate>
                    <aside class="partners-provider-disclosure" aria-labelledby="partners-didit-disclosure-title">
                        <strong id="partners-didit-disclosure-title">Before you verify with Didit</strong>
                        <span>Norva requests this eligibility check and Didit provides the secure hosted identity-verification flow. Review the <a href="/privacy.html#partners" target="_blank" rel="noopener">Norva Privacy Notice</a>, <a href="https://didit.me/terms/verification-privacy-notice/" target="_blank" rel="noopener noreferrer">Didit Verification Privacy Notice</a> and <a href="https://didit.me/terms/identity-verification/" target="_blank" rel="noopener noreferrer">Didit End User Terms</a> before continuing.</span>
                    </aside>
                    <label class="partners-consent-check">
                        <input type="checkbox" data-partners-kyc-consent>
                        <span>I have read these notices and explicitly consent to document, selfie, liveness and face-match capture in Didit's hosted flow for this individual Partners eligibility check. Identity documents are handled by Didit, not uploaded to this page.</span>
                    </label>
                    <label class="partners-consent-check">
                        <input type="checkbox" data-partners-capacity-confirm>
                        <span>I confirm that I meet the ${Number(data.policy.minimum_age)}+ policy and have legal capacity to join as an individual.</span>
                    </label>
                    <button class="btn btn-primary partners-primary-action" type="submit"
                        data-partners-start-kyc disabled aria-describedby="partners-verification-note">${verificationRetry ? 'Retry identity verification' : 'Verify my identity securely'}</button>
                  </form>`
                : (supportRequired
                    ? `<a class="btn btn-secondary partners-primary-action"
                        href="/support.html?returnTo=%2Fapp%23partners">Contact support</a>`
                    : (verificationPending || activationPending
                    ? `<button class="btn btn-secondary partners-primary-action" type="button"
                        data-partners-refresh-verification aria-describedby="partners-verification-note">${activationPending ? 'Check activation status' : 'Check verification status'}</button>`
                    : `<button class="btn btn-secondary partners-primary-action" type="button" disabled
                        aria-describedby="partners-verification-note">Identity verification unavailable</button>`)));
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header('Norva Partners')}
                <section class="partners-state-card partners-state-wide">
                    <span class="partners-status-pill partners-status-warning">${this.escape(stateCopy.badge)}</span>
                    <h1 id="partners-title" tabindex="-1">${this.escape(stateCopy.title)}</h1>
                    <p>${this.escape(stateCopy.copy)}</p>
                    <dl class="partners-checklist">
                        <div><dt>Identity</dt><dd>${this.escape(verification)}</dd></div>
                        <div><dt>Terms</dt><dd>${this.escape(contract)}</dd></div>
                        <div><dt>Referral link</dt><dd>${this.escape(link)}</dd></div>
                    </dl>
                    ${needsTerms ? this.payoutThresholdDisclosure(data.program, data.policy, 'pending') : ''}
                    ${pendingAction}
                    <p id="partners-verification-note" class="partners-action-note">${
                        canAcceptTerms
                            ? `Open and review the <a href="/partners-terms.html?version=${encodeURIComponent(data.policy.terms_version)}" target="_blank" rel="noopener">current Norva Partners terms</a> before accepting.`
                            : (needsTerms
                                ? 'The authoritative programme policy is unavailable. Terms cannot be accepted until the server restores it.'
                                : (canStartKyc
                                    ? `You will continue on Didit's secure hosted verification. Norva records the dedicated biometric consent ${this.escape(PartnersPage.BIOMETRIC_CONSENT_VERSION)} separately from programme disclosure ${this.escape(data.policy.disclosure_version)}, and receives only the verification result needed for programme eligibility.`
                                    : (supportRequired
                                        ? 'Support will review the authoritative account state. Do not send identity documents, bank details or tax identifiers in a support message.'
                                        : (verificationPending
                                        ? 'Your hosted verification was started. Norva will unlock the next step only after the signed provider result is received.'
                                        : (activationPending
                                            ? 'Your verified result is recorded. Refreshing checks only the authoritative activation state; it cannot create a link locally.'
                                            : 'The authoritative server has not enabled a new identity-verification action for this account.')))))
                    }</p>
                    <div class="partners-form-status" data-partners-action-status role="status" aria-live="polite" aria-atomic="true"></div>
                    ${this.programWindowNote(data.program)}
                </section>
                ${this.liveRegion(stateCopy.announcement)}
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
        this._payoutLoadState = 'idle';
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
        this.container.querySelector('[data-partners-payout-button]')
            ?.addEventListener('click', async (event) => {
                const button = event.currentTarget;
                if (this._payoutLoadState === 'ready' && this._payoutProfile) {
                    this.openPayoutDialog(this._payoutProfile, button);
                    return;
                }
                const profile = await this.loadPayoutProfile();
                if (profile && button.isConnected) this.openPayoutDialog(profile, button);
                else if (button.isConnected) {
                    try { button.focus({ preventScroll: true }); } catch (_) { button.focus?.(); }
                }
            });
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
                try {
                    await window.NorvaCloud.partners.acceptTerms({
                        termsVersion: data.policy.terms_version,
                        disclosureVersion: data.policy.disclosure_version,
                        idempotencyKey: this.actionKey('terms')
                    });
                } catch (error) {
                    // Applying and accepting terms are two authoritative writes.
                    // If the second write fails, reload before another action so
                    // the application is never posted with a fresh key twice.
                    this.bootstrapEnvelope = null;
                    await this.show();
                    throw error;
                }
                this.clearActionKey('application');
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
                        biometricConsentVersion: PartnersPage.BIOMETRIC_CONSENT_VERSION,
                        capacityConfirmed: true,
                        idempotencyKey: this.actionKey('kyc-session')
                    });
                    this.setActionStatus('Secure verification ready. Opening Didit.');
                    // Keep the key until this document unloads. If Android or
                    // the browser blocks the hosted hand-off, retrying must
                    // reopen the same reserved KYC session.
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

    ensureKycRightsTarget() {
        const main = this.container?.querySelector('.partners-shell');
        if (!main) return null;
        let target = main.querySelector('[data-partners-kyc-rights]');
        if (target) return target;
        target = document.createElement('section');
        target.className = 'partners-state-card partners-state-wide partners-kyc-rights';
        target.setAttribute('data-partners-kyc-rights', '');
        target.setAttribute('aria-labelledby', 'partners-kyc-rights-title');
        main.append(target);
        return target;
    }

    async loadKycRights({ focus = '' } = {}) {
        const api = window.NorvaCloud?.partners?.kycRights;
        const target = this.ensureKycRightsTarget();
        if (!target || typeof api?.get !== 'function') {
            this.renderKycRights(null, { state: 'unavailable' });
            return null;
        }
        this._kycRightsAbort?.abort();
        const controller = new AbortController();
        const token = ++this._kycRightsToken;
        this._kycRightsAbort = controller;
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this._kycRightsTimeoutMs);
        this.renderKycRights(this._kycRightsData, { state: 'loading' });
        try {
            const envelope = await api.get({ signal: controller.signal });
            if (!this._visible || controller.signal.aborted || token !== this._kycRightsToken) return null;
            this._kycRightsData = envelope.data;
            this.renderKycRights(envelope.data, { state: 'ready', focus });
            return envelope.data;
        } catch (error) {
            if (!this._visible || token !== this._kycRightsToken) return null;
            if ((error?.name === 'AbortError' || controller.signal.aborted) && !timedOut) return null;
            this._kycRightsData = null;
            this.renderKycRights(null, { state: 'error', timedOut });
            return null;
        } finally {
            clearTimeout(timeout);
            if (this._kycRightsAbort === controller) this._kycRightsAbort = null;
        }
    }

    renderKycRights(data, { state = 'ready', timedOut = false, focus = '' } = {}) {
        const target = this.ensureKycRightsTarget();
        if (!target) return;
        if (state === 'loading') {
            target.setAttribute('aria-busy', 'true');
            target.innerHTML = `<span class="partners-eyebrow">Privacy and verification</span>
                <h2 id="partners-kyc-rights-title">Checking your verification rights...</h2>
                <p>No identity document or provider payload is loaded on this page.</p>`;
            return;
        }
        target.removeAttribute('aria-busy');
        if (!data) {
            target.innerHTML = `<span class="partners-eyebrow">Privacy and verification</span>
                <h2 id="partners-kyc-rights-title">Verification controls unavailable</h2>
                <p role="${state === 'error' ? 'alert' : 'status'}">${this.escape(timedOut
                    ? 'The secure rights check took too long. No privacy action was inferred or submitted.'
                    : 'Norva could not load the authoritative privacy controls. No action was taken.')}</p>
                <button class="btn btn-secondary" type="button" data-partners-kyc-rights-retry>Retry securely</button>`;
            target.querySelector('[data-partners-kyc-rights-retry]')
                ?.addEventListener('click', () => this.loadKycRights({ focus: '#partners-kyc-rights-title' }));
            return;
        }

        const consentLabels = {
            not_available: 'Not available',
            not_granted: 'Not granted',
            granted: 'Granted for the recorded check',
            withdrawn: 'Withdrawn for any new check'
        };
        const reviewLabels = {
            requested: 'Review requested',
            in_review: 'Human review in progress',
            resolved: 'Human review completed'
        };
        const resolutionLabels = {
            original_decision_upheld: 'The original decision was upheld',
            reverification_available: 'A fresh verification is available'
        };
        const reasonOptions = [
            ['identity_result_contested', 'My identity result is incorrect'],
            ['age_result_contested', 'My age result is incorrect'],
            ['country_result_contested', 'My country result is incorrect'],
            ['verification_unavailable', 'I could not complete verification'],
            ['other_result_contested', 'Another verification result is incorrect']
        ];
        const review = data.review;
        const reviewSummary = review.exists
            ? `<div class="partners-setup-value">
                <span>${this.escape(reviewLabels[review.status] || 'Human review')}</span>
                <strong>${this.escape(resolutionLabels[review.resolution] || this.formatDateTime(review.requested_at))}</strong>
               </div>`
            : '<p>No human-review request is currently open.</p>';
        const reviewForm = data.actions.can_request_human_review
            ? `<form class="partners-join-form" data-partners-kyc-review-form novalidate>
                <label for="partners-kyc-review-reason">What should a person review?</label>
                <select id="partners-kyc-review-reason" data-partners-kyc-review-reason>
                    ${reasonOptions.map(([value, label]) => `<option value="${this.escape(value)}">${this.escape(label)}</option>`).join('')}
                </select>
                <button class="btn btn-secondary" type="submit" data-partners-kyc-review-submit>Request human review</button>
               </form>`
            : '';
        const withdrawAction = data.actions.can_withdraw
            ? `<button class="btn btn-secondary" type="button" data-partners-kyc-withdraw>Withdraw consent for any new biometric check</button>`
            : '';
        target.innerHTML = `<span class="partners-eyebrow">Privacy and verification</span>
            <h2 id="partners-kyc-rights-title" tabindex="-1">Your identity-verification controls</h2>
            <div class="partners-setup-value">
                <span>Biometric consent</span>
                <strong>${this.escape(consentLabels[data.consent.status] || data.consent.status)}</strong>
            </div>
            ${reviewSummary}
            <p>Norva uses Didit's hosted check and receives the result needed to apply the programme rules. You can contest an unsuccessful result and request a person to review it. Do not send identity documents through Support.</p>
            ${reviewForm}
            ${withdrawAction}
            <p class="partners-action-note">Withdrawal prevents a new biometric check. It does not erase an already completed verification or override legal retention duties. See the <a href="/privacy.html#partners" target="_blank" rel="noopener">Privacy Notice</a>.</p>
            <div class="partners-form-status" data-partners-kyc-rights-status role="status" aria-live="polite" aria-atomic="true"></div>`;

        target.querySelector('[data-partners-kyc-withdraw]')
            ?.addEventListener('click', async (event) => {
                const confirmed = typeof window.NorvaModal?.confirm === 'function'
                    ? await window.NorvaModal.confirm(
                        'This blocks every new biometric verification. Existing verification records remain subject to the Privacy Notice and applicable retention duties.',
                        {
                            title: 'Withdraw biometric consent?',
                            confirmLabel: 'Withdraw consent',
                            cancelLabel: 'Keep consent',
                            danger: true
                        }
                    )
                    : false;
                if (!confirmed) return;
                await this.runKycRightsAction(
                    event.currentTarget,
                    'Withdrawing securely...',
                    async () => window.NorvaCloud.partners.kycRights.withdrawConsent({
                        idempotencyKey: this.actionKey('kyc-consent-withdraw')
                    }),
                    'kyc-consent-withdraw'
                );
            });
        target.querySelector('[data-partners-kyc-review-form]')
            ?.addEventListener('submit', async (event) => {
                event.preventDefault();
                const button = event.currentTarget.querySelector('[data-partners-kyc-review-submit]');
                const reason = event.currentTarget.querySelector('[data-partners-kyc-review-reason]')?.value;
                await this.runKycRightsAction(
                    button,
                    'Submitting securely...',
                    async () => window.NorvaCloud.partners.kycRights.requestHumanReview({
                        reason,
                        idempotencyKey: this.actionKey('kyc-human-review')
                    }),
                    'kyc-human-review'
                );
            });
        if (data.consent.status === 'withdrawn') {
            const form = this.container?.querySelector('[data-partners-kyc-form]');
            form?.querySelectorAll('input, button').forEach((control) => { control.disabled = true; });
            const note = this.container?.querySelector('#partners-verification-note');
            if (note) note.textContent = 'Biometric consent was withdrawn. A new hosted verification cannot be started.';
        }
        if (focus) {
            const focusTarget = target.querySelector(focus);
            try { focusTarget?.focus({ preventScroll: true }); } catch (_) { focusTarget?.focus?.(); }
        }
    }

    async runKycRightsAction(button, loadingLabel, action, actionKey) {
        if (!button || button.disabled || typeof action !== 'function') return;
        const previous = button.textContent;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.textContent = loadingLabel;
        const status = this.container?.querySelector('[data-partners-kyc-rights-status]');
        if (status) status.textContent = loadingLabel;
        try {
            const envelope = await action();
            this.clearActionKey(actionKey);
            this._kycRightsData = envelope.data.rights;
            this.renderKycRights(envelope.data.rights, {
                state: 'ready',
                focus: '#partners-kyc-rights-title'
            });
            window.NorvaModal?.toast?.('Your verification controls were updated.', 'success');
        } catch (error) {
            if (status?.isConnected) {
                status.setAttribute('role', 'alert');
                status.textContent = this.partnerErrorMessage(error);
            }
            if (button.isConnected) {
                button.disabled = false;
                button.removeAttribute('aria-busy');
                button.textContent = previous;
            }
        }
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
        const restoreButtonFocus = document.activeElement === button;
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
                const active = document.activeElement;
                if (restoreButtonFocus && (
                    !active
                    || active === document.body
                    || active === document.documentElement
                    || active === button
                )) {
                    try { button.focus({ preventScroll: true }); } catch (_) { button.focus?.(); }
                }
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
            biometric_consent_withdrawn: 'Verification was cancelled because biometric consent was withdrawn. No Didit link was opened.',
            rate_limited: 'Too many secure attempts were received. Wait a moment before retrying.',
            partners_access_request_contract_invalid: 'Norva could not verify the request status securely. No action was accepted.',
            partners_access_request_disabled: 'Early-access requests are temporarily closed. No request was created.',
            partners_access_requests_disabled: 'Early-access requests are temporarily closed. No request was created.',
            partners_action_not_allowed: 'This action is not available for the current verified account state.',
            partners_membership_join_unavailable: 'Joining is temporarily unavailable. No membership or link was created.',
            partners_credit_unavailable: 'Norva access conversion is temporarily unavailable. Your balance is unchanged.',
            partners_credit_months_invalid: 'Choose a valid Norva access duration.',
            partners_credit_quote_invalid: 'This conversion quote is no longer valid. Create a new quote.',
            membership_required: 'Join Norva Partners before converting an available balance.',
            credits_disabled: 'Norva access conversion is temporarily paused. Your balance is unchanged.',
            quote_expired: 'This quote expired. Close this review and create a fresh quote.',
            insufficient_balance: 'Your available balance changed and is now too low. Close this review and refresh your balance.',
            catalog_unavailable: 'The authoritative Norva access catalogue is temporarily unavailable.',
            fx_rate_unavailable: 'A current verified exchange rate is unavailable for this balance. Your money remains unchanged; refresh after Finance publishes a new rate.',
            quote_conflict: 'This quote has already been used or replaced. Close this review and refresh your balance.',
            partners_kyc_consent_invalid: 'Review and confirm the current verification statements before continuing.',
            partners_kyc_review_reason_invalid: 'Choose what the human reviewer should check before submitting.',
            partners_payout_country_invalid: 'Choose a valid payout country before continuing.',
            payout_country_required: 'Choose your payout country before configuring a cash transfer.',
            cash_pilot_not_allowed: 'The supervised cash-transfer pilot is not open for this account yet. Membership, sharing, earnings and Norva-access conversion remain available.',
            payout_country_unavailable: 'Cash transfers are not available for this country yet. Your referral link, balance and Norva-access conversions continue to work.',
            partners_fiscal_declaration_invalid: 'Review and confirm the current tax-residence statement before continuing.',
            partners_fiscal_country_mismatch: 'Your tax-residence country must match the authoritative country on your Norva account.',
            partners_payout_onboarding_invalid: 'Choose an available payout currency and confirm secure account contact.',
            partners_payout_currency_unavailable: 'This payout currency is not available for your current account policy.',
            partners_request_timeout: 'Norva did not confirm this secure action in time. Its state is unknown, so retrying will resume the same idempotent request.',
            partners_copy_unavailable: 'Copying is unavailable in this browser. No referral message was copied.',
            fiscal_profile_required: 'The tax-residence review must be completed before payout setup can begin.',
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
            this._payoutLoadState = 'unavailable';
            this.renderPayoutProfile(null, { state: this._payoutLoadState });
            return null;
        }
        this._payoutAbort?.abort();
        this._payoutAbort = new AbortController();
        const controller = this._payoutAbort;
        let timedOut = false;
        const timeout = setTimeout(() => {
            if (this._visible && this._payoutAbort === controller) {
                timedOut = true;
                controller.abort();
            }
        }, this._payoutTimeoutMs);
        this._payoutLoadState = 'loading';
        this.renderPayoutProfile(this._payoutProfile, { state: this._payoutLoadState });
        try {
            const envelope = await window.NorvaCloud.partners.payoutProfile({
                signal: controller.signal
            });
            if (!this._visible || controller.signal.aborted || this._payoutAbort !== controller) return null;
            this._payoutProfile = envelope.data;
            this._payoutLoadState = 'ready';
            this.renderPayoutProfile(envelope.data, { state: this._payoutLoadState });
            return envelope.data;
        } catch (error) {
            if (!this._visible || this._payoutAbort !== controller) return null;
            if ((error?.name === 'AbortError' || controller.signal.aborted) && !timedOut) return null;
            this._payoutProfile = null;
            this._payoutLoadState = 'error';
            this.renderPayoutProfile(null, {
                state: this._payoutLoadState,
                timedOut
            });
            return null;
        } finally {
            clearTimeout(timeout);
            if (this._payoutAbort === controller) this._payoutAbort = null;
        }
    }

    renderPayoutProfile(data, { state = this._payoutLoadState, timedOut = false } = {}) {
        const target = this.container?.querySelector('[data-partners-payout-summary]');
        const button = this.container?.querySelector('[data-partners-payout-button]');
        const reasonCopy = {
            account_not_active: 'Partner account activation is required.',
            kyc_not_verified: 'Identity verification is required.',
            payout_country_required: 'Choose your payout country before cash-transfer setup.',
            fiscal_profile_required: 'A verified individual fiscal profile is required.',
            provider_not_configured: 'No individual payout provider is configured for this policy.',
            payouts_not_live: 'The payout release gate is not live.'
        };
        if (state === 'loading') {
            if (button) {
                button.disabled = true;
                button.textContent = 'Checking payout setup…';
                button.removeAttribute('title');
            }
            if (target) target.innerHTML = `<strong>Checking payout readiness…</strong>
                <span>No financial identifier is loaded while the authoritative status is checked.</span>`;
            return;
        }
        if (!data) {
            if (button) {
                button.disabled = state === 'unavailable';
                button.textContent = state === 'error' ? 'Retry payout status' : 'Payout status unavailable';
                button.title = state === 'error'
                    ? 'Retry the secure payout-profile request'
                    : 'The secure payout-profile service is unavailable';
            }
            if (target) target.innerHTML = `<strong>Payout readiness unavailable</strong>
                <span>${timedOut
                    ? 'The secure status check took too long. Retry without entering any financial identifier.'
                    : 'No payout state or zero balance is inferred while the authoritative service is unavailable.'}</span>`;
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
            button.disabled = false;
            button.textContent = profiles.length > 1
                ? `${profiles.length} payout destinations`
                : profile
                    ? `${this.payoutProviderLabel(profile.provider)} · ${profile.display_masked}`
                    : 'Review payout setup';
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
            <span>Norva covers transfer fees on supported payout routes; they are not deducted from your commission.</span>
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

    captureDashboardContext() {
        const scroller = this.getScrollElement();
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        let focus = null;
        if (active?.matches?.('[data-partners-history-filter]')) {
            focus = {
                type: 'filter',
                value: active.dataset.partnersHistoryFilter
            };
        } else if (active?.matches?.('[data-partners-history-more]')) {
            focus = { type: 'load-more' };
        }
        return {
            focus,
            scrollTop: Number.isFinite(scroller?.scrollTop) ? scroller.scrollTop : 0
        };
    }

    restoreDashboardContext(context) {
        if (!context) return;
        requestAnimationFrame(() => {
            if (!this._visible) return;
            const scroller = this.getScrollElement();
            let target = null;
            if (context.focus?.type === 'filter') {
                target = Array.from(this.container?.querySelectorAll?.('[data-partners-history-filter]') || [])
                    .find((button) => button.dataset.partnersHistoryFilter === context.focus.value);
            } else if (context.focus?.type === 'load-more') {
                target = this.container?.querySelector('[data-partners-history-more]')
                    || this.container?.querySelector('#partners-history-title');
            }
            try { target?.focus({ preventScroll: true }); } catch (_) { target?.focus?.(); }
            if (scroller) scroller.scrollTop = context.scrollTop;
        });
    }

    async loadDashboard(bootstrap, {
        reset = false,
        append = false,
        successMessage = 'Partner dashboard updated.'
    } = {}) {
        if (!this._visible) return;
        clearTimeout(this._dashboardRefreshTimer);
        this._dashboardRefreshTimer = 0;
        if (typeof window.NorvaCloud?.partners?.dashboard !== 'function') {
            this.renderDashboardFailure(bootstrap, { unavailable: true });
            this.setActionStatus(
                'The secure partner dashboard is unavailable. No financial or referral value was inferred.',
                'error'
            );
            return;
        }
        const interactionContext = this.captureDashboardContext();
        this._dashboardAbort?.abort();
        this._dashboardAbort = new AbortController();
        const controller = this._dashboardAbort;
        let timedOut = false;
        const timeout = setTimeout(() => {
            if (this._visible && this._dashboardAbort === controller) {
                timedOut = true;
                controller.abort();
            }
        }, this._dashboardTimeoutMs);
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
            if (!this._visible || controller.signal.aborted || this._dashboardAbort !== controller) return;
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
            this.restoreDashboardContext(interactionContext);
            this.setActionStatus(successMessage);
        } catch (error) {
            if (!this._visible || this._dashboardAbort !== controller) return;
            if ((error?.name === 'AbortError' || controller.signal.aborted) && !timedOut) return;
            this.renderDashboardFailure(bootstrap, { timedOut });
            this.restoreDashboardContext(interactionContext);
            this.setActionStatus(this.partnerErrorMessage(error), 'error');
        } finally {
            clearTimeout(timeout);
            if (this._dashboardAbort === controller) {
                this._dashboardAbort = null;
                content?.removeAttribute('aria-busy');
                metrics?.removeAttribute('aria-busy');
            }
        }
    }

    renderDashboardFailure(bootstrap, { timedOut = false, unavailable = false } = {}) {
        const metrics = this.container?.querySelector('[data-partners-dashboard-metrics]');
        const content = this.container?.querySelector('[data-partners-dashboard-content]');
        if (metrics) {
            metrics.innerHTML = (bootstrap.schema_version === 2
                ? [
                    this.metric('Available to use', 'Unavailable', 'Secure reporting unavailable'),
                    this.metric('In validation', 'Unavailable', 'Secure reporting unavailable'),
                    this.metric('Converted to Norva', 'Unavailable', 'Secure reporting unavailable'),
                    this.metric('Next balance update', 'Unavailable', 'Secure reporting unavailable')
                ]
                : [
                    this.metric('Available payout', 'Unavailable', 'Secure reporting unavailable'),
                    this.metric('In validation', 'Unavailable', 'Secure reporting unavailable'),
                    this.metric('Paid to date', 'Unavailable', 'Secure reporting unavailable'),
                    this.metric('Attributed referrals', 'Unavailable', 'Secure reporting unavailable')
                ]).join('');
            metrics.removeAttribute?.('aria-busy');
        }
        if (!content) return;
        content.innerHTML = `<section class="partners-history-card">
            <div class="partners-empty-state" role="alert">
                <strong>Dashboard temporarily unavailable</strong>
                <span>${timedOut
                    ? 'The secure request took too long. Previously displayed values were cleared; no financial or referral value was guessed.'
                    : (unavailable
                        ? 'This app version cannot reach the secure dashboard service. No financial or referral value was inferred.'
                        : 'Previously displayed values were cleared. Retry the authoritative server request.')}</span>
                ${unavailable
                    ? ''
                    : '<button class="btn btn-primary" type="button" data-partners-dashboard-inline-retry>Try again</button>'}
            </div>
        </section>`;
        content.removeAttribute?.('aria-busy');
        content.querySelector?.('[data-partners-dashboard-inline-retry]')
            ?.addEventListener('click', () => this.loadDashboard(bootstrap, { reset: true }));
    }

    renderDashboardData(bootstrap, dashboard) {
        if (dashboard.schema_version === 2) {
            if (!dashboard.program) {
                this.renderDashboardFailure(bootstrap, { unavailable: true });
                this.setActionStatus('The authoritative programme rules are unavailable. Your balance was not inferred.', 'error');
                return;
            }
            this.renderMembershipDashboardData(bootstrap, dashboard);
            return;
        }
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
                        <button class="btn btn-secondary" type="button" data-partners-copy>Copy share text</button>
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
                    <p>Create a fresh opaque link from the authoritative server. No code is generated in this browser.</p>
                    <button class="btn btn-primary" type="button" data-partners-create-link>Create referral link</button>
                </div>
              </div>`;

        const filters = [
            ['all', 'All'],
            ['pending', 'Pending'],
            ['available', 'Available'],
            ['held', 'Held'],
            ['paid', 'Paid'],
            ['restored', 'Restored'],
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
                        <div><dt>Reference payout threshold</dt><dd>${this.escape(this.referencePayoutThreshold(bootstrap.program))}</dd></div>
                        <div><dt>Payouts</dt><dd>${bootstrap.flags.partners_payouts_live ? 'Release gate enabled' : 'Not live'}</dd></div>
                    </dl>
                    ${this.payoutThresholdDisclosure(bootstrap.program, bootstrap.policy, 'dashboard')}
                    <div class="partners-payout-summary" data-partners-payout-summary role="status" aria-live="polite">
                        <strong>Checking payout readiness…</strong>
                        <span>No financial identifier is loaded into this page.</span>
                    </div>
                    ${this.programWindowNote(bootstrap.program)}
                </aside>
            </section>
            <section class="partners-history-card" aria-labelledby="partners-history-title">
                <div class="partners-history-heading">
                    <div><h2 id="partners-history-title" tabindex="-1">Partner history</h2>
                    <p>Commission state changes are shown without customer identity, payment references or private amounts.</p></div>
                    <div class="partners-history-filters" role="group" aria-label="Filter partner history">${filters}</div>
                </div>
                ${history}
                ${dashboard.history.next_cursor
                    ? '<button class="btn btn-secondary partners-load-more" type="button" data-partners-history-more>Load more</button>'
                    : ''}
            </section>`;
        this.renderPayoutProfile(this._payoutProfile, { state: this._payoutLoadState });
        this.bindDashboardActions(bootstrap, dashboard);
    }

    renderMembershipDashboardData(bootstrap, dashboard) {
        const metrics = this.container?.querySelector('[data-partners-dashboard-metrics]');
        const content = this.container?.querySelector('[data-partners-dashboard-content]');
        if (!metrics || !content) return;
        this._membershipDashboard = dashboard;
        const balances = Array.isArray(dashboard.balances) ? dashboard.balances : [];
        const available = this.formatCurrencyBalances(balances, 'available_minor');
        const pending = this.formatCurrencyBalances(balances, 'pending_minor');
        const redeemed = this.formatCurrencyBalances(balances, 'redeemed_minor');
        const nextMaturation = dashboard.next_maturation_at
            ? this.formatDateTime(dashboard.next_maturation_at)
            : 'Nothing scheduled';
        const cashPilotLimited = dashboard.cash_readiness?.reason === 'cash_pilot_not_allowed';
        metrics.innerHTML = [
            this.metric(
                'Available to use',
                available,
                cashPilotLimited
                    ? 'Convert to Norva · cash pilot limited'
                    : 'Convert to Norva or request cash'
            ),
            this.metric('In validation', pending, `${dashboard.program.maturation_days}-day validation window`),
            this.metric('Converted to Norva', redeemed, 'Access credits already used'),
            this.metric('Next balance update', nextMaturation, 'Updates automatically')
        ].join('');

        const link = dashboard.link;
        const rate = this.percent(dashboard.program.commission_rate_bps);
        const linkCard = link
            ? `<div class="partners-referral-card">
                <div class="partners-referral-main">
                    <span class="partners-eyebrow">Your personal referral link</span>
                    <h2>Share now. Your referrals start here.</h2>
                    <div class="partners-link-control">
                        <input type="text" readonly value="${this.escape(link.share_url)}"
                            aria-label="Your personal Norva referral link" data-partners-link>
                        <button class="btn btn-secondary" type="button" data-partners-copy>Copy share text</button>
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
                    <h2>Your link is being prepared.</h2>
                    <p>Request a fresh opaque link from Norva. No code is generated in this browser.</p>
                    <button class="btn btn-primary" type="button" data-partners-create-link>Create referral link</button>
                </div>
              </div>`;

        const credit = dashboard.credit_readiness;
        const catalog = credit.catalog;
        const creditBalance = catalog
            ? balances.find((entry) => entry.currency === catalog.currency)
            : balances.find((entry) => entry.currency === 'USD');
        const planLabel = this.creditPlanLabel(catalog?.plan_code);
        const canConvert = credit.ready && catalog
            && creditBalance
            && creditBalance.available_minor >= catalog.unit_amount_minor;
        const maximumAffordable = catalog
            ? Math.min(
                catalog.maximum_months,
                Math.floor((creditBalance?.available_minor || 0) / catalog.unit_amount_minor)
            )
            : 0;
        const conversionCopy = credit.ready
            ? (canConvert
                ? `Choose 1 to ${maximumAffordable} month${maximumAffordable === 1 ? '' : 's'}. The exact server quote is shown before confirmation.`
                : `Your available balance needs to reach ${this.formatMinor(catalog.unit_amount_minor, catalog.currency)} for one month.`)
            : ({
                credits_disabled: 'Balance conversion is temporarily paused. Your balance remains unchanged.',
                catalog_unavailable: 'The authoritative Norva access catalogue is temporarily unavailable.',
                fx_rate_unavailable: 'A current verified exchange rate is unavailable for this balance. Nothing is converted automatically and your balance remains unchanged.',
                membership_required: 'An active Partners membership is required.'
            })[credit.reason] || 'Balance conversion is temporarily unavailable.';
        const monthOptions = catalog && maximumAffordable > 0
            ? Array.from({ length: maximumAffordable }, (_, index) => index + 1)
                .map((months) => `<option value="${months}">${months} month${months === 1 ? '' : 's'} · up to ${this.escape(this.formatMinor(catalog.unit_amount_minor * months, catalog.currency))}</option>`)
                .join('')
            : '<option value="1">1 month</option>';
        const conversionCard = `<aside class="partners-program-card partners-credit-card" aria-labelledby="partners-credit-title">
            <span class="partners-eyebrow">Use your available balance</span>
            <h2 id="partners-credit-title" tabindex="-1">Convert to ${this.escape(planLabel)}</h2>
            <p>${this.escape(conversionCopy)}</p>
            <form class="partners-credit-form" data-partners-credit-form>
                <label for="partners-credit-months">Access duration</label>
                <select id="partners-credit-months" data-partners-credit-months
                    ${canConvert ? '' : 'disabled'}>${monthOptions}</select>
                <button class="btn btn-primary partners-primary-action" type="submit"
                    data-partners-credit-quote ${canConvert ? '' : 'disabled'}>Review conversion</button>
            </form>
            <p class="partners-action-note">No KYC is required. ${catalog ? `Each credited ${this.escape(planLabel)} month is ${catalog.unit_duration_days} days and references ${this.escape(this.formatMinor(catalog.reference_unit_amount_minor, catalog.reference_currency))}. ` : ''}A non-USD balance is debited only through the dated, immutable rate shown in the server quote. An active paid subscription stays in control; converted access waits safely and resumes afterward.</p>
        </aside>`;

        const filters = [
            ['all', 'All'],
            ['pending', 'Pending'],
            ['available', 'Available'],
            ['redeemed', 'Converted'],
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
                    <span>${this.escape(this.formatMinor(item.amount_minor, item.currency))} · ${this.escape(this.formatDateTime(item.occurred_at))}</span></div>
                </li>`).join('')}</ol>`
            : `<div class="partners-empty-state">
                <strong>No balance events in this view</strong>
                <span>New eligible payments appear in validation without exposing the referred person.</span>
              </div>`;

        content.innerHTML = `
            <section class="partners-dashboard-grid partners-membership-grid">
                ${linkCard}
                ${conversionCard}
            </section>
            ${balances.some((entry) => entry.recovery_due_minor > 0) ? `<aside class="partners-balance-notice" role="status">
                <strong>Balance recovery in progress</strong>
                <span>${this.escape(this.formatCurrencyBalances(
                    balances.filter((entry) => entry.recovery_due_minor > 0),
                    'recovery_due_minor'
                ))} will be offset by future eligible commission after a refund or chargeback.</span>
            </aside>` : ''}
            <section class="partners-history-card" aria-labelledby="partners-history-title">
                <div class="partners-history-heading">
                    <div><h2 id="partners-history-title" tabindex="-1">Balance history</h2>
                    <p>Pending, available, converted and paid events are shown without customer identity or payment references.</p></div>
                    <div class="partners-history-filters" role="group" aria-label="Filter balance history">${filters}</div>
                </div>
                ${history}
                ${dashboard.history.next_cursor
                    ? '<button class="btn btn-secondary partners-load-more" type="button" data-partners-history-more>Load more</button>'
                    : ''}
            </section>`;
        metrics.removeAttribute('aria-busy');
        content.removeAttribute('aria-busy');
        this.bindDashboardActions(bootstrap, dashboard);
        this.bindCreditActions(bootstrap, dashboard);
        this.scheduleDashboardRefresh(bootstrap, dashboard);
    }

    bindDashboardActions(bootstrap, dashboard) {
        const link = dashboard.link;
        if (link) {
            this.container?.querySelector('[data-partners-copy]')
                ?.addEventListener('click', (event) => this.runPartnerAction(
                    event.currentTarget,
                    'Copying…',
                    async () => {
                        await this.copyText(this.shareContent(link.share_url, bootstrap).text);
                        this.setActionStatus('Referral message and required disclosure copied.');
                    }
                ));
            this.container?.querySelector('[data-partners-share]')
                ?.addEventListener('click', (event) => this.runPartnerAction(
                    event.currentTarget,
                    'Opening share…',
                    async () => {
                        const outcome = await this.shareReferral(link.share_url, bootstrap);
                        this.setActionStatus(({
                            cancelled: 'Sharing cancelled. Your referral link was not changed.',
                            copied: 'Sharing is unavailable here, so the link and required disclosure were copied.',
                            shared: 'Share sheet opened with the required disclosure.'
                        })[outcome] || 'Referral link is ready to share.');
                    }
                ));
            this.container?.querySelector('[data-partners-qr]')
                ?.addEventListener('click', (event) => this.openQrDialog(
                    link.share_url,
                    bootstrap,
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
                        await this.loadDashboard(bootstrap, {
                            reset: true,
                            successMessage: 'Referral link rotated. The new server-issued link is ready.'
                        });
                    });
                });
            }
        } else {
            this.container?.querySelector('[data-partners-create-link]')
                ?.addEventListener('click', (event) => this.runPartnerAction(
                    event.currentTarget,
                    'Creating securely…',
                    async () => {
                        await window.NorvaCloud.partners.rotateLink({
                            idempotencyKey: this.actionKey('link-rotation')
                        });
                        this.clearActionKey('link-rotation');
                        this.setActionStatus('Referral link created. Loading the server-issued link.');
                        await this.loadDashboard(bootstrap, {
                            reset: true,
                            successMessage: 'Referral link created. The server-issued link is ready.'
                        });
                    }
                ));
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

    bindCreditActions(bootstrap, dashboard) {
        const form = this.container?.querySelector('[data-partners-credit-form]');
        const months = form?.querySelector('[data-partners-credit-months]');
        const button = form?.querySelector('[data-partners-credit-quote]');
        if (!form || !months || !button || button.disabled) return;
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const selectedMonths = Number(months.value);
            if (!Number.isSafeInteger(selectedMonths) || selectedMonths < 1 || selectedMonths > 12) {
                this.setActionStatus('Choose a valid Norva access duration.', 'error');
                months.focus();
                return;
            }
            const token = ++this._creditToken;
            await this.runPartnerAction(button, 'Creating secure quote…', async () => {
                const api = window.NorvaCloud?.partners?.credit?.quote;
                if (typeof api !== 'function') throw new Error('partners_credit_unavailable');
                this._creditAbort?.abort();
                const controller = new AbortController();
                this._creditAbort = controller;
                const action = `credit-quote-${selectedMonths}`;
                try {
                    const envelope = await api({
                        months: selectedMonths,
                        idempotencyKey: this.actionKey(action),
                        signal: controller.signal
                    });
                    this.clearActionKey(action);
                    if (!this._visible || token !== this._creditToken || !button.isConnected) return;
                    this.openCreditQuoteDialog(envelope.data.quote, bootstrap, button);
                } finally {
                    if (this._creditAbort === controller) this._creditAbort = null;
                }
            });
        });
    }

    scheduleDashboardRefresh(bootstrap, dashboard) {
        clearTimeout(this._dashboardRefreshTimer);
        this._dashboardRefreshTimer = 0;
        if (!this._visible
            || bootstrap.schema_version !== 2) return;
        this._dashboardRefreshTimer = setTimeout(() => {
            this._dashboardRefreshTimer = 0;
            if (!this._visible) return;
            if (document.visibilityState === 'hidden'
                || this._closeCreditDialog
                || this._closeCashDialog
                || this._closePayoutDialog
                || this._closeQrDialog) {
                this.scheduleDashboardRefresh(bootstrap, dashboard);
                return;
            }
            this.loadDashboard(bootstrap, {
                reset: true,
                successMessage: 'Balance refreshed automatically.'
            });
        }, 60000);
    }

    openCreditQuoteDialog(quote, bootstrap, opener) {
        this._closeCreditDialog?.({ restoreFocus: false });
        const overlay = document.createElement('div');
        overlay.className = 'partners-country-picker-overlay partners-credit-overlay';
        overlay.setAttribute('data-region-picker', '');
        overlay.setAttribute('data-partners-credit-overlay', '');
        const monthsLabel = `${quote.months} month${quote.months === 1 ? '' : 's'}`;
        const planLabel = this.creditPlanLabel(quote.plan_code);
        overlay.innerHTML = `
            <section class="partners-credit-dialog" data-region-pop role="dialog" aria-modal="true"
                aria-labelledby="partners-credit-confirm-title"
                aria-describedby="partners-credit-confirm-copy">
                <header class="partners-country-dialog-header">
                    <div><span class="partners-eyebrow">Server-confirmed quote</span>
                    <h2 id="partners-credit-confirm-title">Convert to ${this.escape(monthsLabel)} of ${this.escape(planLabel)}?</h2></div>
                    <button class="partners-country-close" type="button"
                        data-partners-credit-close aria-label="Close conversion review">×</button>
                </header>
                <dl class="partners-program-facts partners-credit-summary">
                    <div><dt>Available balance used</dt><dd>${this.escape(this.formatMinor(quote.total_amount_minor, quote.currency))}</dd></div>
                    <div><dt>Norva reference value</dt><dd>${this.escape(this.formatMinor(quote.reference_total_amount_minor, quote.reference_currency))}</dd></div>
                    ${quote.fx_rate_snapshot_key ? `<div><dt>Verified exchange rate</dt><dd>${this.escape(this.formatDateTime(quote.fx_observed_at))} · valid for this quote</dd></div>` : ''}
                    <div><dt>Norva access</dt><dd>${this.escape(planLabel)} · ${this.escape(monthsLabel)}</dd></div>
                    <div><dt>Identity verification</dt><dd>Not required</dd></div>
                </dl>
                <p id="partners-credit-confirm-copy">This uses only your available Partners balance. Pending commission is untouched. If paid access is active, this credit waits and resumes automatically afterward.</p>
                <div class="partners-actions partners-actions-row">
                    <button class="btn btn-secondary" type="button" data-partners-credit-close>Cancel</button>
                    <button class="btn btn-primary" type="button" data-partners-credit-confirm>Confirm conversion</button>
                </div>
                <div class="partners-form-status" data-partners-credit-status role="status" aria-live="polite" aria-atomic="true"></div>
            </section>`;
        this.container.appendChild(overlay);
        const dialog = overlay.querySelector('[role="dialog"]');
        const confirm = overlay.querySelector('[data-partners-credit-confirm]');
        const status = overlay.querySelector('[data-partners-credit-status]');
        let closed = false;
        let refreshAfterClose = false;
        this.container.classList.add('partners-picker-open');
        try { overlay.querySelector('[data-partners-credit-close]')?.focus({ preventScroll: true }); } catch (_) { /* noop */ }
        const restoreBackground = this.isolateOverlayBackground(overlay);
        const close = ({ restoreFocus = true } = {}) => {
            if (closed || !overlay.isConnected) return false;
            if (confirm?.getAttribute('aria-busy') === 'true') {
                refreshAfterClose = true;
                this._creditAbort?.abort();
            }
            closed = true;
            restoreBackground();
            overlay.remove();
            this.container?.classList.remove('partners-picker-open');
            if (this._closeCreditDialog === close) this._closeCreditDialog = null;
            if (restoreFocus) {
                try { opener?.focus({ preventScroll: true }); } catch (_) { opener?.focus?.(); }
            }
            if (refreshAfterClose && restoreFocus && this._visible) {
                this.loadDashboard(bootstrap, {
                    reset: true,
                    successMessage: 'Norva access conversion recorded.'
                }).then(() => {
                    const target = this.container?.querySelector('[data-partners-credit-quote]')
                        || this.container?.querySelector('#partners-credit-title');
                    try { target?.focus({ preventScroll: true }); } catch (_) { target?.focus?.(); }
                });
            }
            return true;
        };
        this._closeCreditDialog = close;
        overlay.__regionClose = () => close();
        overlay.querySelectorAll('[data-partners-credit-close]')
            .forEach((button) => button.addEventListener('click', () => close()));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        dialog?.addEventListener('keydown', (event) => this.trapDialogFocus(dialog, event, close));
        confirm?.addEventListener('click', async () => {
            if (confirm.disabled || confirm.getAttribute('aria-disabled') === 'true') return;
            const previous = confirm.textContent;
            confirm.disabled = true;
            confirm.setAttribute('aria-busy', 'true');
            confirm.textContent = 'Converting securely…';
            if (status) status.textContent = 'Confirming the exact server quote.';
            const token = ++this._creditToken;
            try {
                const api = window.NorvaCloud?.partners?.credit?.redeem;
                if (typeof api !== 'function') throw new Error('partners_credit_unavailable');
                this._creditAbort?.abort();
                const controller = new AbortController();
                this._creditAbort = controller;
                const action = `credit-redeem-${quote.key}`;
                const envelope = await api({
                    quoteKey: quote.key,
                    idempotencyKey: this.actionKey(action),
                    signal: controller.signal
                });
                this.clearActionKey(action);
                if (this._creditAbort === controller) this._creditAbort = null;
                if (!this._visible || token !== this._creditToken || !overlay.isConnected) return;
                const redemption = envelope.data.redemption;
                const grant = envelope.data.grant;
                dialog.innerHTML = `
                    <span class="partners-status-pill partners-status-success">Conversion complete</span>
                    <h2 id="partners-credit-confirm-title" tabindex="-1">${this.escape(redemption.months)} month${redemption.months === 1 ? '' : 's'} of ${this.escape(planLabel)} secured</h2>
                    <p id="partners-credit-confirm-copy">Your available balance was reduced by ${this.escape(this.formatMinor(redemption.amount_minor, redemption.currency))}. ${this.escape(this.creditGrantCopy(grant.status))}</p>
                    <button class="btn btn-primary partners-primary-action" type="button" data-partners-credit-close>Done</button>`;
                dialog.querySelector('[data-partners-credit-close]')
                    ?.addEventListener('click', () => close());
                requestAnimationFrame(() => dialog.querySelector('#partners-credit-confirm-title')?.focus?.({ preventScroll: true }));
                refreshAfterClose = true;
            } catch (error) {
                this._creditAbort = null;
                if (!overlay.isConnected || token !== this._creditToken) return;
                if (status) {
                    status.setAttribute('role', 'alert');
                    status.setAttribute('aria-live', 'assertive');
                    status.textContent = this.partnerErrorMessage(error);
                }
                const terminalQuote = [
                    'quote_expired',
                    'quote_conflict',
                    'insufficient_balance',
                    'membership_required'
                ].includes(error?.code);
                confirm.disabled = terminalQuote;
                confirm.removeAttribute('aria-busy');
                confirm.textContent = terminalQuote ? 'Quote cannot be confirmed' : previous;
            }
        });
    }

    creditGrantCopy(status) {
        return ({
            active: 'Your Norva access is active now.',
            queued: 'Your access is queued safely and will activate when it becomes eligible.',
            paused_provider: 'Your paid subscription remains active first; this credit will resume afterward.'
        })[status] || 'Your Norva access state is being reconciled securely.';
    }

    creditPlanLabel(planCode) {
        return ({
            plus: 'Norva Plus',
            family: 'Norva Family'
        })[planCode] || 'Norva';
    }

    async openCashJourney(data, opener) {
        const readiness = data.cash_readiness;
        if (!readiness) {
            this.openCashStatusDialog(
                'Cash-transfer status is unavailable',
                'Norva could not verify the authoritative cash-transfer state. Your referral link, balance and Norva-access conversions are unchanged.',
                opener
            );
            return;
        }
        if (readiness.reason === 'cash_pilot_not_allowed') {
            this.openCashStatusDialog(
                'Cash transfers are in a supervised pilot',
                'This account is not in the current cash-transfer cohort. Your membership, referral link, earnings and Norva-access conversions remain fully available. No payout country, identity check, tax profile or banking detail is requested.',
                opener
            );
            return;
        }
        if (readiness.reason === 'payout_country_required') {
            const profile = await this.loadPayoutProfile();
            if (!opener?.isConnected) return;
            if (profile?.account?.country_code) {
                this.openCashStatusDialog(
                    'Cash-transfer status needs a refresh',
                    'Your payout country is already recorded, but the cash-transfer readiness state has not caught up yet. Refresh Partners before continuing.',
                    opener
                );
                return;
            }
            if (profile) {
                this.openCashCountryDialog(data, profile, opener);
                return;
            }
            this.setActionStatus('Cash-transfer country setup is temporarily unavailable. Your balance is unchanged.', 'error');
            try { opener.focus({ preventScroll: true }); } catch (_) { opener.focus?.(); }
            return;
        }
        if (readiness.reason === 'kyc_required') {
            this.openCashKycDialog(data, opener);
            return;
        }
        if (readiness.reason === 'account_blocked') {
            this.openCashStatusDialog(
                'Cash transfers need a secure review',
                'Your referral link and balance stay separate from this cash-transfer review. Contact Support without sending identity, banking or tax documents.',
                opener
            );
            return;
        }
        if (readiness.reason === 'membership_required') {
            this.openCashStatusDialog(
                'Partners membership is required',
                'Join Norva Partners and obtain your referral link before configuring an optional cash transfer.',
                opener
            );
            return;
        }
        const profile = await this.loadPayoutProfile();
        if (profile && opener?.isConnected) this.openPayoutDialog(profile, opener);
        else if (opener?.isConnected) {
            this.setActionStatus('Cash-transfer setup is temporarily unavailable. Your balance is unchanged.', 'error');
            try { opener.focus({ preventScroll: true }); } catch (_) { opener.focus?.(); }
        }
    }

    openCashCountryDialog(data, profile, opener) {
        this._closeCashDialog?.({ restoreFocus: false });
        this._cashCountryAbort?.abort();
        this._cashCountryAbort = null;
        const countries = this.availableCountries();
        const countryOptions = countries.map((country) => `
            <option value="${this.escape(country.code)}">${this.escape(country.name)} · ${this.escape(country.code)}</option>`).join('');
        const overlay = document.createElement('div');
        overlay.className = 'partners-country-picker-overlay partners-credit-overlay';
        overlay.setAttribute('data-region-picker', '');
        overlay.setAttribute('data-partners-cash-country-overlay', '');
        overlay.innerHTML = `
            <section class="partners-credit-dialog" data-region-pop role="dialog" aria-modal="true"
                aria-labelledby="partners-cash-country-title" aria-describedby="partners-cash-country-copy">
                <header class="partners-country-dialog-header">
                    <div><span class="partners-eyebrow">Optional cash transfer</span>
                    <h2 id="partners-cash-country-title">Choose your payout country</h2></div>
                    <button class="partners-country-close" type="button"
                        data-partners-cash-country-close aria-label="Close payout-country setup">×</button>
                </header>
                <p id="partners-cash-country-copy">Choose the country where you personally reside for the cash-transfer programme. Norva never infers this from your IP address, device or locale. This does not affect sharing, earnings or conversion to Norva access.</p>
                <form class="partners-credit-form partners-cash-country-form" data-partners-cash-country-form novalidate>
                    <label for="partners-cash-country">Country of residence for cash transfers</label>
                    <select id="partners-cash-country" data-partners-cash-country required>
                        <option value="">Choose a country</option>
                        ${countryOptions}
                    </select>
                    <p class="partners-action-note">The server will check whether an individual payout route is available. Your country is saved only after you confirm it; no alternative country is guessed or retried.</p>
                    <button class="btn btn-primary partners-primary-action" type="submit"
                        data-partners-cash-country-submit disabled>Confirm payout country</button>
                </form>
                <div class="partners-form-status" data-partners-cash-country-status role="status" aria-live="polite" aria-atomic="true"></div>
            </section>`;
        this.container.appendChild(overlay);
        const dialog = overlay.querySelector('[role="dialog"]');
        const form = overlay.querySelector('[data-partners-cash-country-form]');
        const select = overlay.querySelector('[data-partners-cash-country]');
        const submit = overlay.querySelector('[data-partners-cash-country-submit]');
        const status = overlay.querySelector('[data-partners-cash-country-status]');
        let closed = false;
        this.container.classList.add('partners-picker-open');
        try { overlay.querySelector('[data-partners-cash-country-close]')?.focus({ preventScroll: true }); } catch (_) { /* noop */ }
        const restoreBackground = this.isolateOverlayBackground(overlay);
        const close = ({ restoreFocus = true } = {}) => {
            if (closed || !overlay.isConnected) return false;
            closed = true;
            this._cashCountryAbort?.abort();
            this._cashCountryAbort = null;
            restoreBackground();
            overlay.remove();
            this.container?.classList.remove('partners-picker-open');
            if (this._closeCashDialog === close) this._closeCashDialog = null;
            if (restoreFocus) {
                try { opener?.focus({ preventScroll: true }); } catch (_) { opener?.focus?.(); }
            }
            return true;
        };
        this._closeCashDialog = close;
        overlay.__regionClose = () => close();
        overlay.querySelector('[data-partners-cash-country-close]')
            ?.addEventListener('click', () => close());
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        dialog?.addEventListener('keydown', (event) => this.trapDialogFocus(dialog, event, close));
        const sync = () => {
            submit.disabled = !/^[A-Z]{2}$/.test(String(select.value || '').trim().toUpperCase());
        };
        select.addEventListener('change', sync);
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const countryCode = String(select.value || '').trim().toUpperCase();
            if (!/^[A-Z]{2}$/.test(countryCode)) {
                status.setAttribute('role', 'alert');
                status.textContent = 'Choose your country before continuing.';
                select.focus();
                return;
            }
            const api = window.NorvaCloud?.partners?.bindPayoutCountry;
            if (typeof api !== 'function') {
                status.setAttribute('role', 'alert');
                status.textContent = 'Secure payout-country setup is unavailable in this app version.';
                return;
            }
            const previous = submit.textContent;
            submit.disabled = true;
            select.disabled = true;
            submit.setAttribute('aria-busy', 'true');
            submit.textContent = 'Checking securely…';
            status.setAttribute('role', 'status');
            status.textContent = 'Checking the authoritative individual payout policy.';
            const controller = new AbortController();
            this._cashCountryAbort = controller;
            const action = `payout-country-${countryCode}`;
            try {
                const envelope = await api({
                    countryCode,
                    idempotencyKey: this.actionKey(action),
                    signal: controller.signal
                });
                if (this._cashCountryAbort === controller) this._cashCountryAbort = null;
                if (!overlay.isConnected || closed || controller.signal.aborted) return;
                this.clearActionKey(action);
                const nextReadiness = envelope.data.cash_readiness;
                if (this._membershipDashboard) {
                    this._membershipDashboard = {
                        ...this._membershipDashboard,
                        cash_readiness: nextReadiness
                    };
                }
                close({ restoreFocus: false });
                this.openCashJourney({
                    ...data,
                    cash_readiness: nextReadiness
                }, opener);
            } catch (error) {
                if (this._cashCountryAbort === controller) this._cashCountryAbort = null;
                if (!overlay.isConnected || closed || error?.name === 'AbortError') return;
                status.setAttribute('role', 'alert');
                status.setAttribute('aria-live', 'assertive');
                status.textContent = this.partnerErrorMessage(error);
                select.disabled = false;
                submit.removeAttribute('aria-busy');
                submit.textContent = previous;
                sync();
            }
        });
        sync();
    }

    openCashKycDialog(data, opener) {
        this._closeCashDialog?.({ restoreFocus: false });
        const overlay = document.createElement('div');
        overlay.className = 'partners-country-picker-overlay partners-credit-overlay';
        overlay.setAttribute('data-region-picker', '');
        overlay.setAttribute('data-partners-cash-overlay', '');
        overlay.innerHTML = `
            <section class="partners-credit-dialog" data-region-pop role="dialog" aria-modal="true"
                aria-labelledby="partners-cash-title" aria-describedby="partners-cash-copy">
                <header class="partners-country-dialog-header">
                    <div><span class="partners-eyebrow">Optional cash transfer</span>
                    <h2 id="partners-cash-title">Verify only when you want cash</h2></div>
                    <button class="partners-country-close" type="button"
                        data-partners-cash-close aria-label="Close cash-transfer setup">×</button>
                </header>
                <p id="partners-cash-copy">Your membership, referral link, earnings and Norva-access conversions already work without KYC. A cash transfer requires identity verification, then fiscal and payout-route checks.</p>
                <aside class="partners-provider-disclosure">
                    <strong>Secure verification with Didit</strong>
                    <span>Review the <a href="/privacy.html#partners" target="_blank" rel="noopener">Norva Privacy Notice</a>, <a href="https://didit.me/terms/verification-privacy-notice/" target="_blank" rel="noopener noreferrer">Didit Privacy Notice</a> and <a href="https://didit.me/terms/identity-verification/" target="_blank" rel="noopener noreferrer">Didit Terms</a>.</span>
                </aside>
                <form class="partners-join-form" data-partners-cash-kyc-form novalidate>
                    <label class="partners-consent-check">
                        <input type="checkbox" data-partners-cash-kyc-consent>
                        <span>I explicitly consent to document, selfie, liveness and face-match capture in Didit's hosted flow for cash-transfer eligibility.</span>
                    </label>
                    <label class="partners-consent-check">
                        <input type="checkbox" data-partners-cash-capacity>
                        <span>I confirm that I have legal capacity to request an individual cash transfer.</span>
                    </label>
                    <button class="btn btn-primary partners-primary-action" type="submit"
                        data-partners-cash-kyc-submit disabled>Continue securely to Didit</button>
                </form>
                <div class="partners-form-status" data-partners-cash-status role="status" aria-live="polite" aria-atomic="true"></div>
            </section>`;
        this.container.appendChild(overlay);
        const dialog = overlay.querySelector('[role="dialog"]');
        const form = overlay.querySelector('[data-partners-cash-kyc-form]');
        const consent = overlay.querySelector('[data-partners-cash-kyc-consent]');
        const capacity = overlay.querySelector('[data-partners-cash-capacity]');
        const submit = overlay.querySelector('[data-partners-cash-kyc-submit]');
        const status = overlay.querySelector('[data-partners-cash-status]');
        let closed = false;
        this.container.classList.add('partners-picker-open');
        try { overlay.querySelector('[data-partners-cash-close]')?.focus({ preventScroll: true }); } catch (_) { /* noop */ }
        const restoreBackground = this.isolateOverlayBackground(overlay);
        const close = ({ restoreFocus = true } = {}) => {
            if (closed || !overlay.isConnected) return false;
            closed = true;
            restoreBackground();
            overlay.remove();
            this.container?.classList.remove('partners-picker-open');
            if (this._closeCashDialog === close) this._closeCashDialog = null;
            if (restoreFocus) {
                try { opener?.focus({ preventScroll: true }); } catch (_) { opener?.focus?.(); }
            }
            return true;
        };
        this._closeCashDialog = close;
        overlay.__regionClose = () => close();
        overlay.querySelector('[data-partners-cash-close]')?.addEventListener('click', () => close());
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        dialog?.addEventListener('keydown', (event) => this.trapDialogFocus(dialog, event, close));
        const sync = () => { submit.disabled = !(consent.checked && capacity.checked); };
        consent.addEventListener('change', sync);
        capacity.addEventListener('change', sync);
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!consent.checked || !capacity.checked) {
                status.setAttribute('role', 'alert');
                status.textContent = 'Confirm both identity-verification statements first.';
                (!consent.checked ? consent : capacity).focus();
                return;
            }
            const previous = submit.textContent;
            submit.disabled = true;
            submit.setAttribute('aria-busy', 'true');
            submit.textContent = 'Opening Didit securely…';
            status.textContent = 'Creating a single-use hosted verification session.';
            try {
                const envelope = await window.NorvaCloud.partners.startKyc({
                    language: this.partnerLanguage(),
                    consentVersion: data.program.disclosure_version,
                    biometricConsentVersion: PartnersPage.BIOMETRIC_CONSENT_VERSION,
                    capacityConfirmed: true,
                    idempotencyKey: this.actionKey('cash-kyc-session')
                });
                if (!overlay.isConnected) return;
                status.textContent = 'Secure verification ready. Opening Didit.';
                window.location.assign(envelope.data.verification.url);
            } catch (error) {
                if (!overlay.isConnected) return;
                status.setAttribute('role', 'alert');
                status.setAttribute('aria-live', 'assertive');
                status.textContent = this.partnerErrorMessage(error);
                submit.disabled = false;
                submit.removeAttribute('aria-busy');
                submit.textContent = previous;
            }
        });
        sync();
    }

    openCashStatusDialog(title, copy, opener) {
        this._closeCashDialog?.({ restoreFocus: false });
        const overlay = document.createElement('div');
        overlay.className = 'partners-country-picker-overlay partners-credit-overlay';
        overlay.setAttribute('data-region-picker', '');
        overlay.innerHTML = `<section class="partners-credit-dialog" data-region-pop role="dialog" aria-modal="true"
            aria-labelledby="partners-cash-title">
            <span class="partners-status-pill partners-status-warning">Secure review</span>
            <h2 id="partners-cash-title">${this.escape(title)}</h2>
            <p>${this.escape(copy)}</p>
            <div class="partners-actions partners-actions-row">
                <a class="btn btn-secondary" href="/support.html?returnTo=%2Fapp%23partners">Contact support</a>
                <button class="btn btn-primary" type="button" data-partners-cash-close>Close</button>
            </div>
        </section>`;
        this.container.appendChild(overlay);
        const dialog = overlay.querySelector('[role="dialog"]');
        this.container.classList.add('partners-picker-open');
        try { overlay.querySelector('[data-partners-cash-close]')?.focus({ preventScroll: true }); } catch (_) { /* noop */ }
        const restoreBackground = this.isolateOverlayBackground(overlay);
        const close = ({ restoreFocus = true } = {}) => {
            if (!overlay.isConnected) return false;
            restoreBackground();
            overlay.remove();
            this.container?.classList.remove('partners-picker-open');
            if (this._closeCashDialog === close) this._closeCashDialog = null;
            if (restoreFocus) {
                try { opener?.focus({ preventScroll: true }); } catch (_) { opener?.focus?.(); }
            }
            return true;
        };
        this._closeCashDialog = close;
        overlay.__regionClose = () => close();
        overlay.querySelector('[data-partners-cash-close]')?.addEventListener('click', () => close());
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        dialog?.addEventListener('keydown', (event) => this.trapDialogFocus(dialog, event, close));
    }

    reportingReason(reason) {
        return ({
            available: 'Authoritative commission ledger',
            no_financial_activity: 'No commission activity yet',
            multiple_currencies: 'Amounts are kept separate by authoritative currency'
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

    referencePayoutThreshold(program) {
        const value = program?.payout_thresholds?.USD;
        if (!Number.isSafeInteger(value) || value <= 0) return 'Not configured';
        return `${this.formatMinor(value, 'USD')} · USD reference`;
    }

    payoutThresholdDisclosure(program, policy, surface) {
        const thresholds = program?.payout_thresholds;
        if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) return '';
        const currencies = Array.isArray(policy?.payout_currencies)
            ? policy.payout_currencies
            : [];
        const entries = currencies
            .map((currency) => [currency, thresholds[currency]])
            .filter(([currency, amount]) => (
                /^[A-Z]{3}$/.test(String(currency || ''))
                && Number.isSafeInteger(amount)
                && amount > 0
            ))
            .sort(([left], [right]) => left.localeCompare(right));
        const headingId = `partners-payout-thresholds-${surface}`;
        return `
            <section class="partners-program-card" aria-labelledby="${this.escape(headingId)}">
                <h2 id="${this.escape(headingId)}">Payout thresholds before you accept</h2>
                <p><strong>Programme reference:</strong> ${this.escape(this.referencePayoutThreshold(program))}.</p>
                ${entries.length
                    ? `<dl class="partners-program-facts" aria-label="Exact settlement payout thresholds for your policy">
                        ${entries.map(([currency, amount]) => `
                            <div><dt>${this.escape(currency)} settlement</dt><dd>${this.escape(this.formatMinor(amount, currency))}</dd></div>`).join('')}
                      </dl>`
                    : '<p>No settlement currency is enabled for this policy.</p>'}
                <p>Each threshold is exact in its named settlement currency; Norva does not calculate a hidden FX equivalent. Norva absorbs payout-transfer fees on supported routes.</p>
            </section>`;
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
            commission_restored: 'Commission restored',
            commission_reversed: 'Commission reversed',
            accrual: 'Commission recorded',
            release: 'Commission available',
            access_credit_redemption: 'Converted to Norva access',
            payout_settlement: 'Cash transfer settled',
            payout_late_settlement: 'Cash transfer reconciled',
            reversal: 'Commission reversed',
            manual_reversal: 'Balance correction',
            payout_return: 'Cash transfer returned'
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
        const rate = this.percent(bootstrap.program.commission_rate_bps).replace(/%$/, ' %');
        if (this.partnerLanguage() === 'fr') {
            return `Publicité — lien partenaire Norva · Je peux recevoir ${rate} des paiements Norva éligibles hors taxes. Les gains ne sont pas garantis. Norva est un lecteur multimédia ; aucun contenu ni abonnement TV n’est inclus.`;
        }
        const compactRate = rate.replace(' %', '%');
        return `Advertising — Norva partner link · I may receive ${compactRate} of eligible Norva payments excluding tax. Earnings are not guaranteed. Norva is a media player; no content or TV subscription is included.`;
    }

    shareContent(url, bootstrap) {
        const message = 'Discover Norva — one media ecosystem across Web, Android and TV.';
        const disclosure = this.shareDisclosure(bootstrap);
        return {
            message,
            disclosure,
            text: `${message}\n\n${disclosure}\n${url}`
        };
    }

    async copyText(value) {
        const unavailable = () => Object.assign(
            new Error('partners_copy_unavailable'),
            { code: 'partners_copy_unavailable' }
        );
        if (typeof value !== 'string' || !value) throw unavailable();

        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(value);
                return;
            } catch (_) {
                // A Clipboard API can be present while permissions or the
                // embedding context reject it. Continue with the exact-payload
                // selection fallback before reporting a failure.
            }
        }

        // The legacy copy fallback must select the exact payload requested by
        // the caller. Reusing the visible referral-link input would silently
        // drop the mandatory disclosure when Share is unavailable.
        if (!document.body || !document.createElement) throw unavailable();

        const previouslyFocused = document.activeElement;
        const selection = document.getSelection?.();
        const previousRanges = [];
        if (selection) {
            for (let index = 0; index < selection.rangeCount; index += 1) {
                previousRanges.push(selection.getRangeAt(index).cloneRange());
            }
        }

        const fallback = document.createElement('textarea');
        fallback.value = value;
        fallback.readOnly = true;
        fallback.tabIndex = -1;
        fallback.setAttribute('aria-hidden', 'true');
        Object.assign(fallback.style, {
            position: 'fixed',
            inset: '0 auto auto -9999px',
            width: '1px',
            height: '1px',
            opacity: '0',
            pointerEvents: 'none'
        });

        let copied = false;
        try {
            document.body.appendChild(fallback);
            try { fallback.focus({ preventScroll: true }); } catch (_) { fallback.focus(); }
            fallback.select();
            fallback.setSelectionRange?.(0, fallback.value.length);
            try {
                copied = document.execCommand?.('copy') === true;
            } catch (_) {
                copied = false;
            }
        } finally {
            fallback.remove();
            if (selection && previousRanges.length) {
                selection.removeAllRanges();
                previousRanges.forEach((range) => selection.addRange(range));
            }
            try {
                previouslyFocused?.focus?.({ preventScroll: true });
            } catch (_) {
                previouslyFocused?.focus?.();
            }
        }

        if (!copied) throw unavailable();
    }

    async shareReferral(url, bootstrap) {
        const { message, disclosure, text } = this.shareContent(url, bootstrap);
        const native = window.NorvaShareNative;
        if (native && typeof native.postMessage === 'function') {
            const result = await this.postNativeShare('shareReferral', {
                url,
                message,
                disclosure,
                chooserTitle: 'Share Norva'
            });
            return result?.status === 'cancelled' ? 'cancelled' : 'shared';
        }
        if (navigator.share) {
            try {
                await navigator.share({
                    title: 'Norva',
                    text: `${message}\n\n${disclosure}`,
                    url
                });
            } catch (error) {
                if (error?.name === 'AbortError') return 'cancelled';
                throw error;
            }
            return 'shared';
        }
        await this.copyText(text);
        return 'copied';
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

    isolateOverlayBackground(overlay) {
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
        const snapshot = Array.from(candidates).map((element) => ({
            element,
            inert: element.inert,
            ariaHidden: element.getAttribute('aria-hidden')
        }));
        snapshot.forEach(({ element }) => {
            element.inert = true;
            element.setAttribute('aria-hidden', 'true');
        });
        return () => snapshot.forEach(({ element, inert, ariaHidden }) => {
            if (!element?.isConnected) return;
            element.inert = inert;
            if (ariaHidden == null) element.removeAttribute('aria-hidden');
            else element.setAttribute('aria-hidden', ariaHidden);
        });
    }

    trapDialogFocus(dialog, event, close) {
        if (event.key === 'Escape' || event.key === 'GoBack' || event.key === 'BrowserBack') {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(dialog.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        )).filter((element) => !element.hidden && element.getClientRects().length > 0);
        if (!focusable.length) {
            event.preventDefault();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        // Async step rendering can briefly detach the focused control and move
        // focus to <body>. Keep the modal boundary authoritative during that
        // frame instead of allowing Tab to escape into the inert background.
        if (!dialog.contains(document.activeElement)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    mountPayoutSetup(overlay, accountCountry) {
        const fiscalTarget = overlay?.querySelector('[data-partners-fiscal-step]');
        const payoutTarget = overlay?.querySelector('[data-partners-onboarding-step]');
        const dialogStatus = overlay?.querySelector('[data-partners-payout-dialog-status]');
        if (!fiscalTarget || !payoutTarget) return () => {};

        const setup = {
            fiscal: {
                phase: 'loading', data: null, timedOut: false,
                controller: null, token: 0
            },
            payout: {
                phase: 'loading', data: null, allowedCurrencies: [], timedOut: false,
                controller: null, token: 0
            }
        };
        let active = true;

        const focusSetup = (selector) => requestAnimationFrame(() => {
            if (!active || !overlay.isConnected || !selector) return;
            const target = overlay.querySelector(selector);
            try { target?.focus({ preventScroll: true }); } catch (_) { target?.focus?.(); }
        });
        const setStatus = (message, tone = 'status') => {
            if (!dialogStatus) return;
            dialogStatus.setAttribute('role', tone === 'error' ? 'alert' : 'status');
            dialogStatus.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
            dialogStatus.textContent = message;
        };
        const formatDate = (value) => {
            if (!value) return '';
            try {
                return new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short'
                }).format(new Date(value));
            } catch (_) { return ''; }
        };
        const reasonMessage = (reason) => ({
            route_unavailable: 'The manual payout route is not available for this account country.',
            beneficiary_setup_required: 'Finance still needs to configure the secure beneficiary destination.',
            identity_mismatch: 'The verified identity does not match the payout setup information.',
            unsupported_destination: 'This payout destination is not supported by the current manual route.',
            compliance_review: 'A compliance review is required before Finance can continue.',
            duplicate_request: 'Another payout setup request already covers this destination.'
        })[reason] || 'Finance could not complete this request. Contact support before trying again.';
        const runAction = async (button, loadingLabel, action) => {
            if (!button || button.disabled || typeof action !== 'function') return;
            const previous = button.textContent;
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            button.textContent = loadingLabel;
            setStatus(loadingLabel);
            try {
                await action();
            } catch (error) {
                if (!active || !overlay.isConnected) return;
                setStatus(this.partnerErrorMessage(error), 'error');
                if (button.isConnected) {
                    button.disabled = false;
                    button.removeAttribute('aria-busy');
                    button.textContent = previous;
                    try { button.focus({ preventScroll: true }); } catch (_) { button.focus?.(); }
                }
            }
        };

        const renderFiscal = ({ focus = '' } = {}) => {
            fiscalTarget.removeAttribute('aria-busy');
            if (setup.fiscal.phase === 'loading') {
                fiscalTarget.setAttribute('aria-busy', 'true');
                fiscalTarget.innerHTML = `<div class="partners-setup-heading"><span>1</span><div>
                    <h3>Tax residence</h3><p>Checking your secure self-certification status…</p>
                </div></div><div class="partners-setup-skeleton" aria-hidden="true"></div>`;
                return;
            }
            if (setup.fiscal.phase === 'error' || setup.fiscal.phase === 'unavailable') {
                fiscalTarget.innerHTML = `<div class="partners-setup-heading"><span>1</span><div>
                    <h3 tabindex="-1" data-partners-fiscal-heading>Tax residence</h3>
                    <p>No status was inferred and no attestation was submitted.</p></div></div>
                    <div class="partners-setup-notice is-error" role="alert">
                        <strong>Secure status unavailable</strong>
                        <span>${setup.fiscal.timedOut
                            ? 'The request took too long. You can retry safely.'
                            : 'This app cannot load the authoritative tax-residence status right now.'}</span>
                    </div>
                    <button class="btn btn-secondary partners-setup-action" type="button" data-partners-fiscal-retry>Retry tax status</button>`;
                fiscalTarget.querySelector('[data-partners-fiscal-retry]')?.addEventListener(
                    'click', () => loadSetup('fiscal', { focus: '[data-partners-fiscal-heading]' })
                );
                focusSetup(focus);
                return;
            }
            const fiscal = setup.fiscal.data;
            if (!fiscal) return;
            const countryLabel = accountCountry
                ? this.regionLabel({ country_code: accountCountry })
                : '';
            if (fiscal.status === 'pending') {
                fiscalTarget.innerHTML = `<div class="partners-setup-heading"><span class="is-complete">1</span><div>
                    <h3 tabindex="-1" data-partners-fiscal-heading>Tax residence attestation received</h3>
                    <p>Submitted ${this.escape(formatDate(fiscal.submitted_at) || 'securely')}.</p></div></div>
                    <div class="partners-setup-notice is-pending" role="status">
                        <strong>Finance review pending</strong>
                        <span>This is a self-attestation, not a tax validation. No tax identifier or document was collected.</span>
                    </div>`;
                focusSetup(focus);
                renderPayout();
                return;
            }
            if (fiscal.status === 'verified') {
                fiscalTarget.innerHTML = `<div class="partners-setup-heading"><span class="is-complete">1</span><div>
                    <h3 tabindex="-1" data-partners-fiscal-heading>Tax residence review complete</h3>
                    <p>${this.escape(this.regionLabel({ country_code: fiscal.country_code }))} · reviewed ${this.escape(formatDate(fiscal.reviewed_at) || 'securely')}</p></div></div>
                    <div class="partners-setup-notice is-success" role="status">
                        <strong>Ready for payout setup</strong>
                        <span>Only the reviewed country and status are shown here. No tax identifier is stored in this browser.</span>
                    </div>`;
                focusSetup(focus);
                renderPayout();
                return;
            }
            const canAttest = /^[A-Z]{2}$/.test(accountCountry);
            const renewal = fiscal.status === 'rejected' || fiscal.status === 'expired';
            fiscalTarget.innerHTML = `<div class="partners-setup-heading"><span>1</span><div>
                <h3 tabindex="-1" data-partners-fiscal-heading>${renewal ? 'Renew your tax residence attestation' : 'Confirm your tax residence'}</h3>
                <p>This statement is reviewed before payout setup can begin.</p></div></div>
                ${canAttest ? `<form class="partners-setup-form" data-partners-fiscal-form>
                    <div class="partners-setup-value"><span>Country on your Norva account</span><strong>${this.escape(countryLabel)} · ${this.escape(accountCountry)}</strong></div>
                    <label class="partners-consent-row">
                        <input type="checkbox" data-partners-fiscal-confirm>
                        <span>I certify that this is my current country of tax residence and that this statement is accurate.</span>
                    </label>
                    <p class="partners-setup-privacy">Do not enter a tax ID or upload a document. Norva does not request either in this flow. If the country is wrong, update your account before continuing.</p>
                    <button class="btn btn-primary partners-setup-action" type="submit" data-partners-fiscal-submit disabled>${renewal ? 'Submit a new attestation' : 'Submit self-certification'}</button>
                </form>` : `<div class="partners-setup-notice is-error" role="alert">
                    <strong>Account country unavailable</strong><span>Norva cannot safely create an attestation until the account country is authoritative.</span>
                </div>`}`;
            const form = fiscalTarget.querySelector('[data-partners-fiscal-form]');
            const confirmation = form?.querySelector('[data-partners-fiscal-confirm]');
            const submit = form?.querySelector('[data-partners-fiscal-submit]');
            confirmation?.addEventListener('change', () => {
                if (submit) submit.disabled = confirmation.checked !== true;
            });
            form?.addEventListener('submit', async (event) => {
                event.preventDefault();
                if (!confirmation?.checked || !submit) {
                    confirmation?.focus();
                    setStatus('Confirm the tax-residence statement before submitting.', 'error');
                    return;
                }
                await runAction(submit, 'Submitting securely…', async () => {
                    const idempotencyKey = this.actionKey('fiscal-profile');
                    const submitAttestation = () => window.NorvaCloud.partners.submitFiscalProfile({
                        countryCode: accountCountry,
                        declarationAccepted: true,
                        declarationVersion: 'partners-tax-self-certification-v1',
                        idempotencyKey
                    });
                    let envelope;
                    try {
                        envelope = await submitAttestation();
                    } catch (error) {
                        if (error?.code === 'partners_request_timeout') {
                            // The first result is unknown. Re-submit the exact
                            // payload with the same key; a GET could describe an
                            // older rejected/expired attestation.
                            envelope = await submitAttestation();
                        }
                        if (!envelope) throw error;
                    }
                    if (!active || !overlay.isConnected) return;
                    setup.fiscal.data = envelope.data.fiscal_profile;
                    setup.fiscal.phase = 'ready';
                    this.clearActionKey('fiscal-profile');
                    renderFiscal({ focus: '[data-partners-fiscal-heading]' });
                    setStatus(envelope.data.replayed
                        ? 'Tax residence submission confirmed by Norva.'
                        : 'Tax residence self-certification submitted for review.');
                });
            });
            focusSetup(focus);
            renderPayout();
        };

        const renderPayout = ({ focus = '' } = {}) => {
            payoutTarget.removeAttribute('aria-busy');
            if (setup.payout.phase === 'loading') {
                payoutTarget.setAttribute('aria-busy', 'true');
                payoutTarget.innerHTML = `<div class="partners-setup-heading"><span>2</span><div>
                    <h3>Payout destination</h3><p>Checking the supervised Revolut setup queue…</p>
                </div></div><div class="partners-setup-skeleton" aria-hidden="true"></div>`;
                return;
            }
            if (setup.payout.phase === 'error' || setup.payout.phase === 'unavailable') {
                payoutTarget.innerHTML = `<div class="partners-setup-heading"><span>2</span><div>
                    <h3 tabindex="-1" data-partners-onboarding-heading>Payout destination</h3>
                    <p>No setup state was inferred and no request was created.</p></div></div>
                    <div class="partners-setup-notice is-error" role="alert"><strong>Secure queue unavailable</strong>
                    <span>${setup.payout.timedOut ? 'The request took too long. You can retry safely.' : 'Norva cannot load the Finance queue status right now.'}</span></div>
                    <button class="btn btn-secondary partners-setup-action" type="button" data-partners-onboarding-retry>Retry payout status</button>`;
                payoutTarget.querySelector('[data-partners-onboarding-retry]')?.addEventListener(
                    'click', () => loadSetup('payout', { focus: '[data-partners-onboarding-heading]' })
                );
                focusSetup(focus);
                return;
            }
            const onboarding = setup.payout.data;
            if (!onboarding) return;
            if (onboarding.status === 'pending' || onboarding.status === 'in_progress') {
                const inProgress = onboarding.status === 'in_progress';
                payoutTarget.innerHTML = `<div class="partners-setup-heading"><span class="is-complete">2</span><div>
                    <h3 tabindex="-1" data-partners-onboarding-heading>${inProgress ? 'Finance is configuring your payout' : 'Configuration request received'}</h3>
                    <p>${this.escape(onboarding.currency)} · Revolut Business manual</p></div></div>
                    <div class="partners-setup-notice is-pending" role="status">
                        <strong>${inProgress ? 'Secure setup in progress' : 'Waiting for Finance review'}</strong>
                        <span>Expected review window: 1–3 business days. This is a service target, not a guaranteed transfer date.</span>
                    </div>
                    <p class="partners-setup-privacy">Finance completes the destination in Revolut. No IBAN, beneficiary token or bank detail is collected here.</p>`;
                focusSetup(focus);
                return;
            }
            const needsReconfiguration = onboarding.status === 'completed'
                && onboarding.reconfiguration_required === true;
            if (onboarding.status === 'completed' && !needsReconfiguration) {
                payoutTarget.innerHTML = `<div class="partners-setup-heading"><span class="is-complete">2</span><div>
                    <h3 tabindex="-1" data-partners-onboarding-heading>Payout destination configured</h3>
                    <p>${this.escape(onboarding.currency)} · Revolut Business manual</p></div></div>
                    <div class="partners-setup-notice is-success" role="status"><strong>Setup complete</strong>
                    <span>Your destination was finalized by Finance. Transfers still follow balance, maturation and release controls.</span></div>`;
                focusSetup(focus);
                return;
            }
            const fiscalVerified = setup.fiscal.data?.status === 'verified';
            if (!fiscalVerified) {
                payoutTarget.innerHTML = `<div class="partners-setup-heading"><span>2</span><div>
                    <h3 tabindex="-1" data-partners-onboarding-heading>Payout destination</h3><p>Supervised Revolut configuration</p></div></div>
                    <div class="partners-setup-notice" role="status"><strong>Waiting for tax-residence review</strong>
                    <span>Once step 1 is reviewed, you can request secure setup without entering any bank details.</span></div>`;
                focusSetup(focus);
                return;
            }
            const currencies = setup.payout.allowedCurrencies;
            const rejected = onboarding.status === 'rejected';
            payoutTarget.innerHTML = `<div class="partners-setup-heading"><span>2</span><div>
                <h3 tabindex="-1" data-partners-onboarding-heading>${needsReconfiguration
                    ? 'Reconfigure your payout destination'
                    : (rejected ? 'Request needs attention' : 'Request payout configuration')}</h3>
                <p>Finance completes the destination manually in Revolut Business.</p></div></div>
                ${needsReconfiguration ? `<div class="partners-setup-notice is-pending" role="status"><strong>Previous destination is no longer active</strong>
                    <span>Request a new supervised configuration. No old bank or beneficiary detail is exposed in Norva.</span></div>` : ''}
                ${rejected ? `<div class="partners-setup-notice is-error" role="alert"><strong>Previous request not completed</strong>
                    <span>${this.escape(reasonMessage(onboarding.reason_code))}</span></div>` : ''}
                ${currencies.length ? `<form class="partners-setup-form" data-partners-onboarding-form>
                    <label class="partners-setup-field"><span>Payout currency</span>
                        <select data-partners-onboarding-currency>${currencies.map((currency) => `<option value="${this.escape(currency)}">${this.escape(currency)}</option>`).join('')}</select>
                    </label>
                    <label class="partners-consent-row"><input type="checkbox" data-partners-onboarding-consent>
                        <span>I agree that Norva Finance may contact me through my verified Norva account channel to complete this manual setup.</span>
                    </label>
                    <p class="partners-setup-privacy">This request contains only your selected currency and consent. Never enter an IBAN, tax ID, card number or beneficiary token in Norva.</p>
                    <button class="btn btn-primary partners-setup-action" type="submit" data-partners-onboarding-submit disabled>${needsReconfiguration ? 'Request secure reconfiguration' : 'Request secure configuration'}</button>
                </form>` : `<div class="partners-setup-notice is-error" role="alert"><strong>No supported currency</strong>
                    <span>Finance has not opened a payout currency for this account policy. No request can be created.</span></div>`}`;
            const form = payoutTarget.querySelector('[data-partners-onboarding-form]');
            const consent = form?.querySelector('[data-partners-onboarding-consent]');
            const currency = form?.querySelector('[data-partners-onboarding-currency]');
            const submit = form?.querySelector('[data-partners-onboarding-submit]');
            consent?.addEventListener('change', () => {
                if (submit) submit.disabled = consent.checked !== true;
            });
            form?.addEventListener('submit', async (event) => {
                event.preventDefault();
                if (!consent?.checked || !submit || !currency?.value) {
                    (consent?.checked ? currency : consent)?.focus();
                    setStatus('Choose a currency and confirm secure account contact first.', 'error');
                    return;
                }
                await runAction(submit, 'Sending request…', async () => {
                    const selectedCurrency = currency.value;
                    const idempotencyKey = this.actionKey('payout-onboarding');
                    const requestOnboarding = () => window.NorvaCloud.partners.requestPayoutOnboarding({
                        currency: selectedCurrency,
                        contactConsent: true,
                        idempotencyKey
                    });
                    let envelope;
                    try {
                        envelope = await requestOnboarding();
                    } catch (error) {
                        if (error?.code === 'partners_request_timeout') {
                            // Only the replay of this exact mutation can prove
                            // that this request—not an older rejected/completed
                            // row—was accepted by Finance.
                            envelope = await requestOnboarding();
                        }
                        if (!envelope) throw error;
                    }
                    if (!active || !overlay.isConnected) return;
                    setup.payout.data = envelope.data.payout_onboarding;
                    setup.payout.phase = 'ready';
                    this.clearActionKey('payout-onboarding');
                    renderPayout({ focus: '[data-partners-onboarding-heading]' });
                    setStatus(envelope.data.replayed
                        ? 'Payout configuration request confirmed by Norva.'
                        : 'Secure payout configuration request sent to Finance.');
                });
            });
            focusSetup(focus);
        };

        const loadSetup = async (kind, { focus = '' } = {}) => {
            const state = kind === 'fiscal' ? setup.fiscal : setup.payout;
            const api = kind === 'fiscal'
                ? window.NorvaCloud?.partners?.fiscalProfile
                : window.NorvaCloud?.partners?.payoutOnboarding;
            state.controller?.abort();
            state.token += 1;
            const token = state.token;
            state.timedOut = false;
            if (typeof api !== 'function') {
                state.phase = 'unavailable';
                (kind === 'fiscal' ? renderFiscal : renderPayout)({ focus });
                return null;
            }
            state.phase = 'loading';
            (kind === 'fiscal' ? renderFiscal : renderPayout)();
            const controller = new AbortController();
            state.controller = controller;
            const timeout = setTimeout(() => {
                state.timedOut = true;
                controller.abort();
            }, this._payoutSetupTimeoutMs);
            try {
                const envelope = await api({ signal: controller.signal });
                if (!active || !overlay.isConnected || state.token !== token
                    || controller.signal.aborted) return null;
                state.phase = 'ready';
                if (kind === 'fiscal') state.data = envelope.data.fiscal_profile;
                else {
                    state.data = envelope.data.payout_onboarding;
                    state.allowedCurrencies = envelope.data.allowed_currencies;
                }
                (kind === 'fiscal' ? renderFiscal : renderPayout)({ focus });
                return state.data;
            } catch (error) {
                if (!active || !overlay.isConnected || state.token !== token) return null;
                if (error?.name === 'AbortError' && !state.timedOut) return null;
                state.phase = 'error';
                state.data = null;
                if (kind === 'payout') state.allowedCurrencies = [];
                (kind === 'fiscal' ? renderFiscal : renderPayout)({ focus });
                setStatus(this.partnerErrorMessage(error), 'error');
                return null;
            } finally {
                clearTimeout(timeout);
                if (state.token === token) state.controller = null;
            }
        };

        Promise.allSettled([loadSetup('fiscal'), loadSetup('payout')]);
        return () => {
            active = false;
            setup.fiscal.controller?.abort();
            setup.payout.controller?.abort();
        };
    }

    openPayoutDialog(data, opener) {
        if (!data) return;
        this._closePayoutDialog?.({ restoreFocus: false });
        const profiles = Array.isArray(data.profiles) ? data.profiles : [];
        const primary = data.profile;
        const destinations = profiles.length ? profiles : (primary ? [primary] : []);
        const reasonCopy = {
            account_not_active: 'Partner account activation is required.',
            kyc_not_verified: 'Identity verification is required.',
            fiscal_profile_required: 'A verified individual fiscal profile is required.',
            provider_not_configured: 'No individual payout provider is configured for this policy.',
            payouts_not_live: 'The payout release gate is not live.'
        };
        const readiness = data.readiness.ready
            ? 'Ready for the next supervised payout cycle'
            : (reasonCopy[data.readiness.reason] || 'Payout setup is not ready.');
        const destinationRows = destinations.length
            ? destinations.map((destination) => `
                <div><dt>${this.escape(destination.currency)} destination</dt>
                <dd>${this.escape(this.payoutProviderLabel(destination.provider))} · ${this.escape(destination.display_masked)} · ${this.escape(destination.status)}</dd></div>`).join('')
            : '<div><dt>Destination</dt><dd>Not provisioned</dd></div>';
        const accountCountry = String(
            this._dashboardPages?.[0]?.account?.country_code
            || this.bootstrapEnvelope?.envelope?.data?.policy?.country_code
            || ''
        ).trim().toUpperCase();
        const overlay = document.createElement('div');
        overlay.className = 'partners-country-picker-overlay partners-qr-overlay partners-payout-overlay';
        overlay.setAttribute('data-region-picker', '');
        overlay.setAttribute('data-partners-payout-overlay', '');
        overlay.innerHTML = `
            <section class="partners-qr-dialog partners-payout-dialog" role="dialog" aria-modal="true"
                aria-labelledby="partners-payout-title" aria-describedby="partners-payout-copy">
                <header class="partners-country-dialog-header">
                    <div><span class="partners-eyebrow">Secure payout profile</span>
                    <h2 id="partners-payout-title">Payout readiness</h2></div>
                    <button class="partners-country-close" type="button"
                        data-partners-payout-close aria-label="Close payout profile">×</button>
                </header>
                <div class="partners-payout-summary">
                    <strong>${this.escape(readiness)}</strong>
                    <span>${data.readiness.payouts_live
                        ? 'The live release gate is enabled.'
                        : 'The live release gate remains disabled; no transfer is triggered from this page.'}</span>
                </div>
                <dl class="partners-program-facts" aria-label="Masked payout destinations">
                    ${destinationRows}
                    <div><dt>Fiscal profile</dt><dd>${this.escape(data.fiscal?.status || 'missing')}${data.fiscal?.country_code ? ` · ${this.escape(data.fiscal.country_code)}` : ''}</dd></div>
                </dl>
                <p id="partners-payout-copy">Manual Revolut destinations are provisioned by Norva Finance after your request. Revolut Business Basic remains a supervised manual process. This page never accepts an IBAN, card number, tax identifier or beneficiary token.</p>
                <div class="partners-payout-setup" aria-label="Payout setup steps">
                    <section class="partners-setup-step" data-partners-fiscal-step aria-busy="true"></section>
                    <section class="partners-setup-step" data-partners-onboarding-step aria-busy="true"></section>
                </div>
                <div class="partners-actions partners-actions-row">
                    <button class="btn btn-secondary" type="button" data-partners-payout-refresh>Refresh secure status</button>
                    <button class="btn btn-primary" type="button" data-partners-payout-close>Close</button>
                </div>
                <div class="partners-form-status" data-partners-payout-dialog-status role="status" aria-live="polite" aria-atomic="true"></div>
            </section>`;
        this.container.appendChild(overlay);
        const dialog = overlay.querySelector('[role="dialog"]');
        const closeButton = overlay.querySelector('[data-partners-payout-close]');
        const refreshButton = overlay.querySelector('[data-partners-payout-refresh]');
        const dialogStatus = overlay.querySelector('[data-partners-payout-dialog-status]');
        let cleanupSetup = () => {};
        let closed = false;
        this.container.classList.add('partners-picker-open');
        try { closeButton?.focus({ preventScroll: true }); } catch (_) { closeButton?.focus?.(); }
        const restoreBackground = this.isolateOverlayBackground(overlay);
        const handleDialogKeydown = (event) => {
            if (!overlay.isConnected || closed) return;
            this.trapDialogFocus(dialog, event, close);
        };
        const close = ({ restoreFocus = true } = {}) => {
            if (closed || !overlay.isConnected) return false;
            closed = true;
            document.removeEventListener('keydown', handleDialogKeydown, true);
            cleanupSetup();
            restoreBackground();
            overlay.remove();
            this.container?.classList.remove('partners-picker-open');
            if (this._closePayoutDialog === close) this._closePayoutDialog = null;
            if (restoreFocus) {
                try { opener?.focus({ preventScroll: true }); } catch (_) { opener?.focus?.(); }
            }
            return true;
        };
        overlay.__regionClose = () => close();
        this._closePayoutDialog = close;
        overlay.querySelectorAll('[data-partners-payout-close]')
            .forEach((button) => button.addEventListener('click', () => close()));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        // Capture at document level while the overlay is mounted. A fiscal or
        // payout rerender may remove the focused control before the next frame;
        // Escape/Android Back must still close, and Tab must remain trapped.
        document.addEventListener('keydown', handleDialogKeydown, true);
        cleanupSetup = this.mountPayoutSetup(overlay, accountCountry);
        let refreshInFlight = false;
        refreshButton?.addEventListener('click', async () => {
            if (refreshInFlight) return;
            refreshInFlight = true;
            // Keep the active control focusable while the request is pending.
            // Disabling a focused button moves Chromium focus to <body>, which
            // breaks Escape/Back handling and keyboard continuity in the sheet.
            refreshButton.setAttribute('aria-disabled', 'true');
            refreshButton.setAttribute('aria-busy', 'true');
            refreshButton.textContent = 'Refreshing…';
            if (dialogStatus) dialogStatus.textContent = 'Refreshing the authoritative payout profile.';
            const refreshed = await this.loadPayoutProfile();
            if (!overlay.isConnected) return;
            if (refreshed) {
                close({ restoreFocus: false });
                this.openPayoutDialog(refreshed, opener);
                return;
            }
            refreshInFlight = false;
            refreshButton.removeAttribute('aria-disabled');
            refreshButton.removeAttribute('aria-busy');
            refreshButton.textContent = 'Retry secure status';
            if (dialogStatus) {
                dialogStatus.setAttribute('role', 'alert');
                dialogStatus.setAttribute('aria-live', 'assertive');
                dialogStatus.textContent = 'Payout status is still unavailable. No financial value was inferred.';
            }
        });
    }

    openQrDialog(url, bootstrap, opener) {
        this._closeQrDialog?.({ restoreFocus: false });
        const disclosure = this.shareDisclosure(bootstrap);
        const overlay = document.createElement('div');
        overlay.className = 'partners-country-picker-overlay partners-qr-overlay';
        overlay.setAttribute('data-region-picker', '');
        overlay.setAttribute('data-partners-qr-overlay', '');
        overlay.innerHTML = `
            <section class="partners-qr-dialog" role="dialog" aria-modal="true"
                aria-labelledby="partners-qr-title"
                aria-describedby="partners-qr-disclosure partners-qr-copy">
                <header class="partners-country-dialog-header">
                    <div><span class="partners-eyebrow">Personal referral link</span>
                    <h2 id="partners-qr-title">Scan to open Norva</h2></div>
                    <button class="partners-country-close" type="button"
                        data-partners-qr-close aria-label="Close QR code">×</button>
                </header>
                <div class="partners-qr-code" data-partners-qr-code role="img"
                    aria-label="QR code for your personal Norva referral link"></div>
                <p class="partners-disclosure" id="partners-qr-disclosure"
                    data-partners-qr-disclosure><strong>Required partner disclosure:</strong>
                    ${this.escape(disclosure)}</p>
                <p id="partners-qr-copy">The QR encodes only your active server-issued <strong>norva.tv</strong> referral URL. It contains no balance, e-mail or KYC data.</p>
                <code>${this.escape(url)}</code>
            </section>`;
        this.container.appendChild(overlay);
        const dialog = overlay.querySelector('[role="dialog"]');
        const closeButton = overlay.querySelector('[data-partners-qr-close]');
        this.container.classList.add('partners-picker-open');
        try { closeButton?.focus({ preventScroll: true }); } catch (_) { closeButton?.focus?.(); }
        const restoreBackground = this.isolateOverlayBackground(overlay);
        const close = ({ restoreFocus = true } = {}) => {
            if (!overlay.isConnected) return false;
            restoreBackground();
            overlay.remove();
            this.container?.classList.remove('partners-picker-open');
            if (this._closeQrDialog === close) this._closeQrDialog = null;
            if (restoreFocus) {
                try { opener?.focus({ preventScroll: true }); } catch (_) { opener?.focus?.(); }
            }
            return true;
        };
        overlay.__regionClose = () => close();
        this._closeQrDialog = close;
        closeButton?.addEventListener('click', () => close());
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        dialog?.addEventListener('keydown', (event) => this.trapDialogFocus(dialog, event, close));
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

    steps(program = null) {
        const maturation = Number.isSafeInteger(program?.maturation_days)
            && program.maturation_days >= 0
            ? `${program.maturation_days} days`
            : 'the server-published validation period';
        return `
            <section class="partners-steps" aria-label="How Norva Partners works">
                <article><span>1</span><div><h2>Share your personal link</h2><p>A unique opaque link is generated only after server verification.</p></div></article>
                <article><span>2</span><div><h2>They subscribe to Norva</h2><p>Direct referrals are attributed without revealing their identity to you.</p></div></article>
                <article><span>3</span><div><h2>You earn on eligible renewals</h2><p>Commission matures after ${this.escape(maturation)} and follows refunds or chargebacks.</p></div></article>
            </section>`;
    }

    membershipSteps(program) {
        const maturation = Number.isSafeInteger(program?.maturation_days)
            ? `${program.maturation_days} days`
            : 'the published validation period';
        return `
            <section class="partners-steps" aria-label="How the flexible Norva Partners balance works">
                <article><span>1</span><div><h2>Join and share now</h2><p>Your confirmed Norva account gets a personal link immediately. No identity documents are needed.</p></div></article>
                <article><span>2</span><div><h2>Watch balance mature</h2><p>Eligible commission normally stays pending for at least ${this.escape(maturation)}, then becomes available after checks.</p></div></article>
                <article><span>3</span><div><h2>Choose access or cash</h2><p>Use available balance for Norva access without identity verification, or complete verification only when requesting cash.</p></div></article>
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
            updateSelection(countryInput.value);
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
