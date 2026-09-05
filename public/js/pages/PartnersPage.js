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
    static KYC_RETURN_TRACKING_TTL_MS = 15 * 60 * 1000;
    static KYC_PENDING_REFRESH_MS = 10 * 1000;
    static DASHBOARD_REFRESH_MS = 60 * 1000;

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
        this._referralAbort = null;
        this._referralRequestGeneration = 0;
        this._referralCursor = null;
        this._referralItems = [];
        this._referralTotal = 0;
        this._referralsAvailable = true;
        this._referralLoadState = 'idle';
        this._referralError = '';
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
        this._kycReturnPendingUntil = 0;
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
            this.resetReferralState();
        }
        this._sessionIdentityKey = sessionKey;
        return sessionKey;
    }

    resetReferralState() {
        this._referralAbort?.abort();
        this._referralAbort = null;
        this._referralRequestGeneration += 1;
        this._referralCursor = null;
        this._referralItems = [];
        this._referralTotal = 0;
        this._referralsAvailable = true;
        this._referralLoadState = 'idle';
        this._referralError = '';
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
        if (returnedFromKyc) {
            this._kycReturnPendingUntil = Date.now()
                + PartnersPage.KYC_RETURN_TRACKING_TTL_MS;
        } else if (this._kycReturnPendingUntil <= Date.now()) {
            this._kycReturnPendingUntil = 0;
        }
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
                title: (globalThis.NorvaI18n?.t("ui_web_7e68794ff9ec", { defaultValue: "Norva Partners is not available here" }) ?? 'Norva Partners is not available here'),
                copy: (globalThis.NorvaI18n?.t("ui_web_3165cfe3682a", { defaultValue: "Open Norva with your signed-in cloud account on the Web or Android mobile app." }) ?? 'Open Norva with your signed-in cloud account on the Web or Android mobile app.'),
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
                    (globalThis.NorvaI18n?.t("ui_web_aa1aa2a6904e", { defaultValue: "Back in Norva. Checking for the signed identity result; this page will update automatically." }) ?? 'Back in Norva. Checking for the signed identity result; this page will update automatically.'),
                    'info'
                );
            }
        } catch (error) {
            if (!this._visible || token !== this._showToken) return;
            if (error?.name === 'AbortError' && !timedOut) return;
            this.setEntryVisibility(false);
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                this.renderUnavailable({
                    title: (globalThis.NorvaI18n?.t("ui_web_4d5c943931a4", { defaultValue: "You are offline" }) ?? 'You are offline'),
                    copy: (globalThis.NorvaI18n?.t("ui_web_2653c3801a91", { defaultValue: "Reconnect to securely check whether Norva Partners is available for your account." }) ?? 'Reconnect to securely check whether Norva Partners is available for your account.'),
                    tone: 'offline',
                    retry: true
                });
                return;
            }
            this.renderUnavailable({
                title: (globalThis.NorvaI18n?.t("ui_web_70fd56e9db3a", { defaultValue: "Partners is temporarily unavailable" }) ?? 'Partners is temporarily unavailable'),
                copy: (globalThis.NorvaI18n?.t("ui_web_dde8553e97bc", { defaultValue: "Norva could not verify the programme state. No action was taken. Try again in a moment." }) ?? 'Norva could not verify the programme state. No action was taken. Try again in a moment.'),
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
        this._referralAbort?.abort();
        this._referralAbort = null;
        this._referralRequestGeneration += 1;
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
                    title: (globalThis.NorvaI18n?.t("ui_web_b3935c569a1b", { defaultValue: "Partners hand-off is not available" }) ?? 'Partners hand-off is not available'),
                    copy: forceAvailability
                        ? (globalThis.NorvaI18n?.t("ui_web_6f84aead8341", { defaultValue: "The secure TV hand-off is still disabled by the authoritative programme configuration." }) ?? 'The secure TV hand-off is still disabled by the authoritative programme configuration.')
                        : (globalThis.NorvaI18n?.t("ui_web_625eed071de2", { defaultValue: "Open Norva Partners on Web or Android mobile. This TV will show a QR only when the secure hand-off is enabled." }) ?? 'Open Norva Partners on Web or Android mobile. This TV will show a QR only when the secure hand-off is enabled.'),
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
                title: (globalThis.NorvaI18n?.t("ui_web_1fa227564d10", { defaultValue: "TV hand-off temporarily unavailable" }) ?? 'TV hand-off temporarily unavailable'),
                copy: typeof navigator !== 'undefined' && navigator.onLine === false
                    ? (globalThis.NorvaI18n?.t("ui_web_339d6ef98e79", { defaultValue: "Reconnect this TV, then retry. No partner or financial data was loaded." }) ?? 'Reconnect this TV, then retry. No partner or financial data was loaded.')
                    : (globalThis.NorvaI18n?.t("ui_web_40265a55fe6e", { defaultValue: "Norva could not create the temporary QR securely. No partner or financial data was exposed." }) ?? 'Norva could not create the temporary QR securely. No partner or financial data was exposed.'),
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
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-tv-relay-card" aria-busy="true">
                    <div class="partners-skeleton partners-skeleton-hero" aria-hidden="true"></div>
                    <h1 id="partners-title" tabindex="-1" data-i18n="ui_web_0ad1f83b79e0">Preparing a secure hand-off</h1>
                    <p data-i18n="ui_web_fc81e12accc7">Norva is creating a short-lived QR for your phone. Your partner account and financial details never appear on TV.</p>
                </section>
                ${this.liveRegion((globalThis.NorvaI18n?.t("ui_web_9bda0891e822", { defaultValue: "Preparing a secure Norva Partners TV hand-off." }) ?? 'Preparing a secure Norva Partners TV hand-off.'))}
            </main>`;
        this.bindCommonActions();
    }

    renderTvRelayPending(relay) {
        if (!this.container) return;
        this.container.innerHTML = `
            <main class="partners-shell partners-tv-shell" aria-labelledby="partners-title">
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-tv-relay-card">
                    <div class="partners-tv-relay-copy">
                        <span class="partners-status-pill" data-i18n="ui_web_dd5799cc22c2">Secure hand-off</span>
                        <h1 id="partners-title" tabindex="-1" data-i18n="ui_web_19840b22f99c">Continue on your phone</h1>
                        <p data-i18n="ui_web_d1b57bec9e04">Scan this temporary QR with your phone, sign in if asked, then manage Partners privately on Web or Android.</p>
                        <ol class="partners-tv-steps">
                            <li><span>1</span><norva-i18n data-i18n="ui_web_1a9d0404e694">Scan the QR with your phone camera.</norva-i18n></li>
                            <li><span>2</span><norva-i18n data-i18n="ui_web_2bcc7759e9be">Open the official </norva-i18n><strong data-i18n="ui_web_d28cc747fdd3">norva.tv</strong><norva-i18n data-i18n="ui_web_7248bca9e9ec"> link.</norva-i18n></li>
                            <li><span>3</span><norva-i18n data-i18n="ui_web_a567db087651">This TV confirms the hand-off automatically.</norva-i18n></li>
                        </ol>
                        <div class="partners-actions partners-actions-row">
                            <button class="btn btn-secondary" type="button"
                                data-partners-tv-refresh data-i18n="ui_web_be5dff52eeb0">Check connection</button>
                            <button class="btn btn-ghost" type="button"
                                data-partners-back data-i18n="ui_web_76900f1bfd16">Back</button>
                        </div>
                    </div>
                    <div class="partners-tv-qr-panel">
                        <div class="partners-qr-code partners-tv-qr-code"
                            data-partners-tv-qr role="img"
                            aria-label="Temporary QR code to continue Norva Partners on your phone" data-i18n-aria-label="ui_web_86daa88c2bb6"></div>
                        <strong data-i18n="ui_web_d28cc747fdd3">norva.tv</strong>
                        <span data-partners-tv-relay-status role="status"
                            aria-live="polite">${this.escape(this.tvRelayExpiryCopy(relay.expires_at))}</span>
                    </div>
                </section>
                ${this.liveRegion((globalThis.NorvaI18n?.t("ui_web_3af87e12839b", { defaultValue: "Temporary QR ready. Continue Norva Partners on your phone." }) ?? 'Temporary QR ready. Continue Norva Partners on your phone.'))}
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
            target.innerHTML = '<span data-i18n="ui_web_4d0fb2833c25">QR rendering unavailable. Retry this secure hand-off.</span>';
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
        if (!Number.isFinite(seconds) || seconds <= 0) return (globalThis.NorvaI18n?.t("ui_web_6d9d0acb03a6", { defaultValue: "QR expired" }) ?? 'QR expired');
        const minutes = Math.floor(seconds / 60);
        const rest = seconds % 60;
        return (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_0f7a9aa2e771", {defaultValue: "Waiting for your phone · expires in {{p0}}:{{p1}}", p0:(minutes),p1:(String(rest).padStart(2, '0'))}) : `Waiting for your phone · expires in ${minutes}:${String(rest).padStart(2, '0')}`);
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
            button.textContent = (globalThis.NorvaI18n?.t("ui_web_ec963ffc911b", { defaultValue: "Checking…" }) ?? 'Checking…');
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
                if (live) live.textContent = (globalThis.NorvaI18n?.t("ui_web_cdaed9623a76", { defaultValue: "Connection check delayed · retrying securely" }) ?? 'Connection check delayed · retrying securely');
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
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-state-card partners-tv-result">
                    <span class="partners-status-pill partners-status-success" data-i18n="ui_web_22965568d22a">Connected</span>
                    <h1 id="partners-title" tabindex="-1" data-i18n="ui_web_851bf9d5e133">Continue privately on your phone</h1>
                    <p data-i18n="ui_web_361793afe5b5">The secure hand-off is complete. Your TV received only this confirmation—never your identity, balance, tax profile or payout details.</p>
                    <div class="partners-actions partners-actions-row">
                        <button class="btn btn-primary" type="button"
                            data-partners-tv-new data-i18n="ui_web_be67d0e347b4">Start another hand-off</button>
                        <button class="btn btn-secondary" type="button"
                            data-partners-back data-i18n="ui_web_ea37ec29c386">Back to Settings</button>
                    </div>
                </section>
                ${this.liveRegion((globalThis.NorvaI18n?.t("ui_web_0a50ce734fe6", { defaultValue: "TV hand-off complete. Continue Norva Partners on your phone." }) ?? 'TV hand-off complete. Continue Norva Partners on your phone.'), 'assertive')}
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
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-state-card partners-tv-result">
                    <span class="partners-status-pill partners-status-warning" data-i18n="ui_web_6d9d0acb03a6">QR expired</span>
                    <h1 id="partners-title" tabindex="-1" data-i18n="ui_web_726ebf970a04">Create a fresh secure QR</h1>
                    <p data-i18n="ui_web_d55f2a670d21">Temporary hand-offs expire quickly by design. Generate a new QR when your phone is ready.</p>
                    <div class="partners-actions partners-actions-row">
                        <button class="btn btn-primary" type="button"
                            data-partners-tv-new data-i18n="ui_web_d2c95ea8dec2">Generate new QR</button>
                        <button class="btn btn-secondary" type="button"
                            data-partners-back data-i18n="ui_web_76900f1bfd16">Back</button>
                    </div>
                </section>
                ${this.liveRegion((globalThis.NorvaI18n?.t("ui_web_0a3fab5dbfe3", { defaultValue: "The temporary Partners QR expired." }) ?? 'The temporary Partners QR expired.'), 'assertive')}
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
                ${this.header((globalThis.NorvaI18n?.t("ui_web_93faa3c57234", { defaultValue: "Checking availability" }) ?? 'Checking availability'), 'partners-title')}
                <div class="partners-stage" aria-busy="true">
                    <div class="partners-skeleton partners-skeleton-hero"></div>
                    <div class="partners-skeleton-grid" aria-hidden="true">
                        <div class="partners-skeleton"></div>
                        <div class="partners-skeleton"></div>
                        <div class="partners-skeleton"></div>
                    </div>
                </div>
                ${this.liveRegion((globalThis.NorvaI18n?.t("ui_web_c78fcac0cf8c", { defaultValue: "Checking Norva Partners availability." }) ?? 'Checking Norva Partners availability.'))}
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
                title: (globalThis.NorvaI18n?.t("ui_web_966d943ebaea", { defaultValue: "Not available in your jurisdiction yet" }) ?? 'Not available in your jurisdiction yet'),
                copy: policyRegion
                    ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_0cab9fd2f9b3", {defaultValue: "The individual programme is not currently available in {{p0}}. Coverage is controlled by Norva's server policies.", p0:(policyRegion)}) : `The individual programme is not currently available in ${policyRegion}. Coverage is controlled by Norva's server policies.`)
                    : (globalThis.NorvaI18n?.t("ui_web_585bda441a2e", { defaultValue: "Norva needs an eligible country and, where required, subdivision before the programme can open." }) ?? 'Norva needs an eligible country and, where required, subdivision before the programme can open.'),
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
            title: (globalThis.NorvaI18n?.t("ui_web_ebf1f03c7c1f", { defaultValue: "Norva Partners is currently unavailable" }) ?? 'Norva Partners is currently unavailable'),
            copy: (globalThis.NorvaI18n?.t("ui_web_bc9b999a5ac1", { defaultValue: "The programme is disabled for this account. No referral link or earning action is active." }) ?? 'The programme is disabled for this account. No referral link or earning action is active.'),
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
                    title: (globalThis.NorvaI18n?.t("ui_web_793bbb255ba3", { defaultValue: "Programme rules are temporarily unavailable" }) ?? 'Programme rules are temporarily unavailable'),
                    copy: (globalThis.NorvaI18n?.t("ui_web_0e93ba720dce", { defaultValue: "Norva cannot safely display sharing or balance actions without the authoritative programme. Your membership and balance are unchanged." }) ?? 'Norva cannot safely display sharing or balance actions without the authoritative programme. Your membership and balance are unchanged.'),
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
                title: (globalThis.NorvaI18n?.t("ui_web_60b6565445ce", { defaultValue: "Norva Partners is currently invitation-only" }) ?? 'Norva Partners is currently invitation-only'),
                copy: (globalThis.NorvaI18n?.t("ui_web_4510068efc96", { defaultValue: "This account is not in the current pilot cohort. No identity check or payout setup is needed now. Your ordinary Norva access is unchanged, and you can return when the programme opens more broadly." }) ?? 'This account is not in the current pilot cohort. No identity check or payout setup is needed now. Your ordinary Norva access is unchanged, and you can return when the programme opens more broadly.'),
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
                title: (globalThis.NorvaI18n?.t("ui_web_f4c6c7190b74", { defaultValue: "Confirm your Norva email to join Partners" }) ?? 'Confirm your Norva email to join Partners'),
                copy: (globalThis.NorvaI18n?.t("ui_web_ef28d82d7182", { defaultValue: "Open the confirmation message sent by Norva, then return here. Identity verification is not required to join, share or earn." }) ?? 'Open the confirmation message sent by Norva, then return here. Identity verification is not required to join, share or earn.')
            },
            disabled: {
                title: (globalThis.NorvaI18n?.t("ui_web_92797cbe2491", { defaultValue: "Norva Partners is temporarily paused" }) ?? 'Norva Partners is temporarily paused'),
                copy: (globalThis.NorvaI18n?.t("ui_web_7a42f37a0847", { defaultValue: "Joining and earning are paused by the authoritative programme switch. No account or referral link was created." }) ?? 'Joining and earning are paused by the authoritative programme switch. No account or referral link was created.')
            },
            program_unavailable: {
                title: (globalThis.NorvaI18n?.t("ui_web_793bbb255ba3", { defaultValue: "Programme rules are temporarily unavailable" }) ?? 'Programme rules are temporarily unavailable'),
                copy: (globalThis.NorvaI18n?.t("ui_web_4ce4e98f86c7", { defaultValue: "Norva cannot accept terms until the authoritative programme is restored. No local defaults were used." }) ?? 'Norva cannot accept terms until the authoritative programme is restored. No local defaults were used.')
            }
        })[data.eligibility.reason] || {
            title: (globalThis.NorvaI18n?.t("ui_web_5527a16c60a4", { defaultValue: "Norva Partners is temporarily unavailable" }) ?? 'Norva Partners is temporarily unavailable'),
            copy: (globalThis.NorvaI18n?.t("ui_web_479d4b659daf", { defaultValue: "Norva could not confirm the authoritative programme state. No account or referral link was created." }) ?? 'Norva could not confirm the authoritative programme state. No account or referral link was created.')
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
            ? (globalThis.NorvaI18n?.t("ui_web_d7dd7f50fe30", { defaultValue: "Request a place in the Norva Partners pilot." }) ?? 'Request a place in the Norva Partners pilot.')
            : (preview
                ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_855270c858fc", {defaultValue: "Earn {{p0}} on eligible referrals.", p0:(this.percent(preview.commission_rate_bps))}) : `Earn ${this.percent(preview.commission_rate_bps)} on eligible referrals.`)
                : (globalThis.NorvaI18n?.t("ui_web_01ee7ca6a583", { defaultValue: "Be among the first to discover Norva Partners." }) ?? 'Be among the first to discover Norva Partners.'));
        const copy = invitationOnly
            ? (globalThis.NorvaI18n?.t("ui_web_7eaa9f9bfcd3", { defaultValue: "The supervised pilot is opening gradually. Tell us where you will participate from and Norva will review your request." }) ?? 'The supervised pilot is opening gradually. Tell us where you will participate from and Norva will review your request.')
            : (preview
                ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_2691a6871498", {defaultValue: "The current server-published preview includes a {{p0}}-day attribution window and {{p1}}-day validation period. Access is still reviewed.", p0:(preview.attribution_window_days),p1:(preview.maturation_days)}) : `The current server-published preview includes a ${preview.attribution_window_days}-day attribution window and ${preview.maturation_days}-day validation period. Access is still reviewed.`)
                : (globalThis.NorvaI18n?.t("ui_web_3040a4075e40", { defaultValue: "Norva Partners is being opened in controlled stages. You can request early access now without starting KYC or creating a referral link." }) ?? 'Norva Partners is being opened in controlled stages. You can request early access now without starting KYC or creating a referral link.'));
        const statusLabel = invitationOnly ? (globalThis.NorvaI18n?.t("ui_web_9882c6472073", { defaultValue: "Invitation-only pilot" }) ?? 'Invitation-only pilot') : (globalThis.NorvaI18n?.t("ui_web_321217e9e556", { defaultValue: "Early access" }) ?? 'Early access');
        const requestMarkup = this.earlyAccessRequestMarkup(phase, request, message);
        const pickerMarkup = phase === 'ready' && !request?.exists
            ? this.earlyAccessCountryPickerMarkup()
            : '';
        const liveMessages = {
            pending: (globalThis.NorvaI18n?.t("ui_web_ddf15efd97a2", { defaultValue: "Checking your Norva Partners early-access request." }) ?? 'Checking your Norva Partners early-access request.'),
            ready: (globalThis.NorvaI18n?.t("ui_web_c34cf2f2c9c9", { defaultValue: "Early-access requests are open. Choose your country to continue." }) ?? 'Early-access requests are open. Choose your country to continue.'),
            requested: request?.status === 'approved'
                ? (globalThis.NorvaI18n?.t("ui_web_44cc5464d78e", { defaultValue: "Your Norva Partners early-access request is approved." }) ?? 'Your Norva Partners early-access request is approved.')
                : (request?.status === 'declined'
                    ? (globalThis.NorvaI18n?.t("ui_web_1cb00410ab4d", { defaultValue: "Your early-access request was reviewed and is not open for resubmission." }) ?? 'Your early-access request was reviewed and is not open for resubmission.')
                    : (globalThis.NorvaI18n?.t("ui_web_f978d2ee2be6", { defaultValue: "Your Norva Partners early-access request is awaiting review." }) ?? 'Your Norva Partners early-access request is awaiting review.')),
            success: (globalThis.NorvaI18n?.t("ui_web_76e94edd98a3", { defaultValue: "Your Norva Partners early-access request was submitted successfully." }) ?? 'Your Norva Partners early-access request was submitted successfully.'),
            error: (globalThis.NorvaI18n?.t("ui_web_d7f1b52f7a2a", { defaultValue: "Norva could not load your early-access request." }) ?? 'Norva could not load your early-access request.'),
            disabled: (globalThis.NorvaI18n?.t("ui_web_dcdce7d6aeff", { defaultValue: "Norva Partners early-access requests are temporarily unavailable." }) ?? 'Norva Partners early-access requests are temporarily unavailable.')
        };
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-discovery-grid partners-early-access-grid">
                    <div class="partners-discovery-copy">
                        <span class="partners-eyebrow" data-i18n="ui_web_1d7a267066a0">Norva Partners · Individuals</span>
                        <h1 id="partners-title" class="partners-display" tabindex="-1">${this.escape(title)}</h1>
                        <p class="partners-lead">${this.escape(copy)}</p>
                        <span class="partners-status-pill partners-status-warning">${this.escape(statusLabel)}</span>
                        ${this.earlyAccessPreviewMarkup(preview)}
                        <p class="partners-disclosure" data-i18n="ui_web_1bdf527307a4">An access request does not create a partner account, start identity verification, generate a referral link or guarantee earnings. Join, KYC, sharing and payouts remain locked until Norva's server policies explicitly authorize them.</p>
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
        return `<section class="partners-steps" aria-label="Early-access process" data-i18n-aria-label="ui_web_71f53fbc82d5">
            <article><span>1</span><div><strong data-i18n="ui_web_b06f1662da4a">Request access</strong><p data-i18n="ui_web_ed28cac0ad75">Share the country where you would personally participate.</p></div></article>
            <article><span>2</span><div><strong data-i18n="ui_web_0b00cca1530a">Norva reviews</strong><p data-i18n="ui_web_f3e3b13469da">The team checks jurisdiction coverage and supervised-pilot capacity.</p></div></article>
            <article><span>3</span><div><strong data-i18n="ui_web_24a59e3e9b44">Unlock after release</strong><p data-i18n="ui_web_7c1816ad9bcc">If approved, joining and identity verification appear only after the server opens access.</p></div></article>
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
        return `<dl class="partners-program-facts partners-preview-facts" aria-label="Current programme preview" data-i18n-aria-label="ui_web_9fe56c1336fa">
            <div><dt data-i18n="ui_web_cc278c379457">Recurring commission</dt><dd>${this.escape(this.percent(preview.commission_rate_bps))}</dd></div>
            <div><dt data-i18n="ui_web_e4dc23da045b">Attribution window</dt><dd data-i18n="ui_web_c8f3b581c7c6" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p1":(preview.attribution_window_days)}) || "{}")}">${preview.attribution_window_days} days</dd></div>
            <div><dt data-i18n="ui_web_0073795be654">Validation period</dt><dd data-i18n="ui_web_1856b79536b8" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p2":(preview.maturation_days)}) || "{}")}">${preview.maturation_days} days</dd></div>
            <div><dt data-i18n="ui_web_060315a5ed98">Reference threshold</dt><dd>${this.escape(threshold)}</dd></div>
        </dl><p class="partners-program-note" data-i18n="ui_web_18cc7826a47e">Preview only. It does not prove eligibility, approval or future earnings.</p>`;
    }

    earlyAccessRequestMarkup(phase, request, message) {
        if (phase === 'pending') {
            return `<aside class="partners-program-card partners-access-card" aria-busy="true" aria-labelledby="partners-access-title">
                <span class="partners-eyebrow" data-i18n="ui_web_73023a399137">Your request</span>
                <h2 id="partners-access-title" data-i18n="ui_web_3c7557b4186e">Checking securely</h2>
                <div class="partners-skeleton" aria-hidden="true"></div>
                <div class="partners-skeleton" aria-hidden="true"></div>
                <p data-i18n="ui_web_f36f017b34b9">Norva is loading only the current request status for this account.</p>
            </aside>`;
        }
        if (phase === 'disabled') {
            return `<aside class="partners-program-card partners-access-card" aria-labelledby="partners-access-title">
                <span class="partners-status-pill" data-i18n="ui_web_ff350fbc6f62">Requests paused</span>
                <h2 id="partners-access-title" tabindex="-1" data-i18n="ui_web_e501ddadd41e">Early-access requests are temporarily closed</h2>
                <p data-i18n="ui_web_293f9fff6c92">No application, identity check or partner account has been created. Return here later when the supervised intake reopens.</p>
                <div class="partners-actions partners-actions-row">
                    <button class="btn btn-secondary" type="button" data-partners-back data-i18n="ui_web_76900f1bfd16">Back</button>
                </div>
            </aside>`;
        }
        if (phase === 'error') {
            return `<aside class="partners-program-card partners-access-card" aria-labelledby="partners-access-title">
                <span class="partners-status-pill partners-status-warning" data-i18n="ui_web_7eb5af92e49c">Status unavailable</span>
                <h2 id="partners-access-title" tabindex="-1" data-i18n="ui_web_3ceb28b99577">We could not check your request</h2>
                <p role="alert">${this.escape(message || (globalThis.NorvaI18n?.t("ui_web_05f443168778", { defaultValue: "Norva could not load the request securely. No action was taken." }) ?? 'Norva could not load the request securely. No action was taken.'))}</p>
                <div class="partners-actions partners-actions-row">
                    <button class="btn btn-primary" type="button" data-partners-access-retry data-i18n="ui_web_d8b8392e2c54">Try again</button>
                    <button class="btn btn-secondary" type="button" data-partners-back data-i18n="ui_web_76900f1bfd16">Back</button>
                </div>
            </aside>`;
        }
        if (request?.exists && ['requested', 'approved'].includes(request.status)) {
            const approved = request.status === 'approved';
            const successful = phase === 'success';
            const heading = approved
                ? (globalThis.NorvaI18n?.t("ui_web_380ef0bb854b", { defaultValue: "Your early access is approved" }) ?? 'Your early access is approved')
                : (successful ? (globalThis.NorvaI18n?.t("ui_web_a235ef4ad598", { defaultValue: "Request sent successfully" }) ?? 'Request sent successfully') : (globalThis.NorvaI18n?.t("ui_web_06c002cceb58", { defaultValue: "Your request is in review" }) ?? 'Your request is in review'));
            const copy = approved
                ? (globalThis.NorvaI18n?.t("ui_web_282e63ef607d", { defaultValue: "Norva has approved this request. Operational access will appear here only when the programme and your jurisdiction are opened by the server." }) ?? 'Norva has approved this request. Operational access will appear here only when the programme and your jurisdiction are opened by the server.')
                : (globalThis.NorvaI18n?.t("ui_web_e373a5640a07", { defaultValue: "The Norva team will review pilot capacity and jurisdiction coverage. You do not need to submit another request." }) ?? 'The Norva team will review pilot capacity and jurisdiction coverage. You do not need to submit another request.');
            const country = this.regionLabel({
                country_code: request.country_code,
                subdivision_code: request.subdivision_code
            }) || request.country_code;
            return `<aside class="partners-program-card partners-access-card" aria-labelledby="partners-access-title">
                <span class="partners-status-pill ${approved || successful ? 'partners-status-success' : 'partners-status-warning'}">${approved ? (globalThis.NorvaI18n?.t("ui_web_87b42e40c2a2", { defaultValue: "Approved" }) ?? 'Approved') : (globalThis.NorvaI18n?.t("ui_web_2d9e28289fac", { defaultValue: "Requested" }) ?? 'Requested')}</span>
                <h2 id="partners-access-title" tabindex="-1">${this.escape(heading)}</h2>
                <p>${this.escape(copy)}</p>
                <dl class="partners-checklist">
                    <div><dt data-i18n="ui_web_701d021d08c5">Country</dt><dd>${this.escape(country)}</dd></div>
                    <div><dt data-i18n="ui_web_920e413c7d41">Status</dt><dd>${approved ? (globalThis.NorvaI18n?.t("ui_web_75e8964a2fd6", { defaultValue: "Approved · awaiting release" }) ?? 'Approved · awaiting release') : (globalThis.NorvaI18n?.t("ui_web_4848885e3fc4", { defaultValue: "Awaiting review" }) ?? 'Awaiting review')}</dd></div>
                    <div><dt data-i18n="ui_web_2d9e28289fac">Requested</dt><dd>${this.escape(this.formatDateTime(request.requested_at))}</dd></div>
                </dl>
                <div class="partners-actions partners-actions-row">
                    <button class="btn btn-secondary" type="button" data-partners-back data-i18n="ui_web_76900f1bfd16">Back</button>
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
                <span class="partners-status-pill" data-i18n="ui_web_fad6057bb540">Reviewed</span>
                <h2 id="partners-access-title" tabindex="-1" data-i18n="ui_web_a9a5f87bf315">This early-access request was not approved</h2>
                <p data-i18n="ui_web_b8b4c3c0d9a1">The review is complete and this request cannot be submitted again. No partner account, identity check, referral link or earnings were created.</p>
                <dl class="partners-checklist">
                    <div><dt data-i18n="ui_web_701d021d08c5">Country</dt><dd>${this.escape(country)}</dd></div>
                    <div><dt data-i18n="ui_web_920e413c7d41">Status</dt><dd data-i18n="ui_web_ad2815011b06">Not approved</dd></div>
                    <div><dt data-i18n="ui_web_fad6057bb540">Reviewed</dt><dd>${this.escape(this.formatDateTime(request.reviewed_at || request.requested_at))}</dd></div>
                </dl>
                <div class="partners-actions partners-actions-row">
                    <a class="btn btn-secondary" href="/support.html?returnTo=%2Fapp%23partners" data-i18n="ui_web_814f4ed2d5bd">Contact support</a>
                    <button class="btn btn-ghost" type="button" data-partners-back data-i18n="ui_web_76900f1bfd16">Back</button>
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
            : (globalThis.NorvaI18n?.t("ui_web_19323e2d92e7", { defaultValue: "Choose a country" }) ?? 'Choose a country');
        return `<aside class="partners-program-card partners-access-card" aria-labelledby="partners-access-title">
            <span class="partners-eyebrow" data-i18n="ui_web_e492ce44272a">Request early access</span>
            <h2 id="partners-access-title" data-i18n="ui_web_4132f635118f">Join the supervised intake</h2>
            <form class="partners-jurisdiction-form partners-access-form"
                data-partners-jurisdiction data-partners-access-request-form novalidate>
                <div class="partners-field">
                    <span class="partners-field-label" id="partners-country-label" data-i18n="ui_web_701d021d08c5">Country</span>
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
                            aria-describedby="partners-country-hint" data-i18n-placeholder="ui_web_9b202ecbc6d4">
                        <button class="btn btn-ghost partners-inline-action" type="button"
                            data-partners-country-list data-i18n="ui_web_4505bc52b9c0">Choose from country list</button>
                    </div>
                    <span id="partners-country-hint" data-i18n="ui_web_dfac0536714a">Choose the country where you personally reside and would participate in the programme.</span>
                </div>
                <div class="partners-field">
                    <label for="partners-subdivision-code"><norva-i18n data-i18n="ui_web_4d1eef81a874">State or region code </norva-i18n><span data-i18n="ui_web_0059798b7f70">(optional)</span></label>
                    <input id="partners-subdivision-code" name="subdivisionCode" value="${subdivision}"
                        maxlength="12" inputmode="text" autocapitalize="characters"
                        autocomplete="off" spellcheck="false" placeholder="US-CA"
                        aria-describedby="partners-subdivision-hint" data-i18n-placeholder="ui_web_776cec61a9f3">
                    <span id="partners-subdivision-hint" data-i18n="ui_web_7f1d457e8187">Use an ISO subdivision code only when your jurisdiction requires it.</span>
                </div>
                <div class="partners-form-status" data-partners-jurisdiction-status
                    data-partners-access-request-status role="status" aria-live="polite"
                    aria-atomic="true" tabindex="-1"></div>
                <div class="partners-actions partners-actions-row">
                    <button class="btn btn-primary partners-primary-action" type="submit"
                        data-partners-access-submit data-i18n="ui_web_e492ce44272a">Request early access</button>
                    <button class="btn btn-secondary" type="button" data-partners-back data-i18n="ui_web_76900f1bfd16">Back</button>
                </div>
            </form>
            <p data-i18n="ui_web_6ef7805b6a0a">Your request records only this account, jurisdiction and review timestamps. It does not start KYC or expose another user's information.</p>
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
                        <span class="partners-eyebrow" data-i18n="ui_web_eaff23c82663">Norva Partners</span>
                        <h2 id="partners-country-picker-title" data-i18n="ui_web_90095a585379">Choose your country</h2>
                    </div>
                    <button class="partners-country-close" type="button"
                        data-partners-country-close aria-label="Close country selector" data-i18n-aria-label="ui_web_22df99431eaf">×</button>
                </header>
                <label class="partners-country-search-label" for="partners-country-search" data-i18n="ui_web_320113ee29d0">Search countries</label>
                <input id="partners-country-search" class="region-picker-search"
                    data-partners-country-search type="search" role="combobox"
                    aria-autocomplete="list" aria-controls="partners-country-listbox"
                    aria-expanded="true" autocomplete="off"
                    placeholder="Search by country or ISO code" data-i18n-placeholder="ui_web_589dab472c1f">
                <ul id="partners-country-listbox"
                    class="region-picker-list partners-country-list"
                    data-partners-country-listbox role="listbox"
                    aria-label="Countries" data-i18n-aria-label="ui_web_8faf7ec7ab20">${this.countryOptionMarkup(countries, this._jurisdiction.countryCode)}</ul>
                <footer class="partners-country-dialog-footer">
                    <button class="btn btn-secondary partners-country-code-action"
                        type="button" data-partners-country-manual-open data-i18n="ui_web_b1761cdbf509">Country not listed? Enter code</button>
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
                    status.textContent = (globalThis.NorvaI18n?.t("ui_web_435656820066", { defaultValue: "Choose a two-letter country code and, if needed, a matching state or region code." }) ?? 'Choose a two-letter country code and, if needed, a matching state or region code.');
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
            button.textContent = (globalThis.NorvaI18n?.t("ui_web_3154bff74ec2", { defaultValue: "Requesting access…" }) ?? 'Requesting access…');
            if (status) {
                status.setAttribute('role', 'status');
                status.setAttribute('aria-live', 'polite');
                status.textContent = (globalThis.NorvaI18n?.t("ui_web_d714621383e1", { defaultValue: "Submitting your early-access request securely." }) ?? 'Submitting your early-access request securely.');
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
            ? (globalThis.NorvaI18n?.t("ui_web_148305c6cdfe", { defaultValue: "Check programme availability for your jurisdiction." }) ?? 'Check programme availability for your jurisdiction.')
            : (globalThis.NorvaI18n?.t("ui_web_7af2d9dbd006", { defaultValue: "Choose another jurisdiction to check." }) ?? 'Choose another jurisdiction to check.');
        const copy = reason === 'country_not_supported'
            ? (globalThis.NorvaI18n?.t("ui_web_6362cc53dfdf", { defaultValue: "The last country checked is not currently supported by Norva Partners." }) ?? 'The last country checked is not currently supported by Norva Partners.')
            : (reason === 'subdivision_not_supported'
                ? (globalThis.NorvaI18n?.t("ui_web_39c04f5c2700", { defaultValue: "The last state or region checked is not currently supported." }) ?? 'The last state or region checked is not currently supported.')
                : (reason === 'not_allowlisted'
                    ? (globalThis.NorvaI18n?.t("ui_web_d50f7f09013c", { defaultValue: "This invitation is not valid for the last jurisdiction checked. Choose the jurisdiction of this individual account to check the authoritative policy." }) ?? 'This invitation is not valid for the last jurisdiction checked. Choose the jurisdiction of this individual account to check the authoritative policy.')
                    : (globalThis.NorvaI18n?.t("ui_web_69c9765cf5ac", { defaultValue: "Enter the jurisdiction of this individual account. Norva will ask the server for the applicable policy." }) ?? 'Enter the jurisdiction of this individual account. Norva will ask the server for the applicable policy.')));
        const country = this.escape(this._jurisdiction.countryCode);
        const subdivision = this.escape(this._jurisdiction.subdivisionCode);
        const countries = this.availableCountries();
        const selectedCountry = countries.find((entry) => entry.code === this._jurisdiction.countryCode) || null;
        const manualCountry = Boolean(this._jurisdiction.countryCode && !selectedCountry);
        const countryLabel = selectedCountry
            ? `${selectedCountry.flag || ''} ${selectedCountry.name} · ${selectedCountry.code}`.trim()
            : (globalThis.NorvaI18n?.t("ui_web_19323e2d92e7", { defaultValue: "Choose a country" }) ?? 'Choose a country');
        this.container.innerHTML = `
            <main class="partners-shell" data-partners-jurisdiction-surface aria-labelledby="partners-title">
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-state-card partners-state-wide partners-jurisdiction-card">
                    <span class="partners-status-pill" data-i18n="ui_web_978b939411ad">Availability check</span>
                    <h1 id="partners-title" tabindex="-1">${this.escape(title)}</h1>
                    <p>${this.escape(copy)}</p>
                    <form class="partners-jurisdiction-form" data-partners-jurisdiction novalidate>
                        <div class="partners-field">
                            <span class="partners-field-label" id="partners-country-label" data-i18n="ui_web_701d021d08c5">Country</span>
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
                                    aria-describedby="partners-country-hint" data-i18n-placeholder="ui_web_501c26b2571a">
                                <button class="btn btn-ghost partners-inline-action" type="button"
                                    data-partners-country-list data-i18n="ui_web_4505bc52b9c0">Choose from country list</button>
                            </div>
                            <span id="partners-country-hint" data-i18n="ui_web_bde9db094dfb">Nothing is selected or inferred automatically. Choose a listed country, or use its two-letter ISO code.</span>
                        </div>
                        <div class="partners-field">
                            <label for="partners-subdivision-code"><norva-i18n data-i18n="ui_web_4d1eef81a874">State or region code </norva-i18n><span data-i18n="ui_web_0059798b7f70">(optional)</span></label>
                            <input id="partners-subdivision-code" name="subdivisionCode" value="${subdivision}"
                                maxlength="12" inputmode="text" autocapitalize="characters"
                                autocomplete="off" spellcheck="false" placeholder="FR-IDF"
                                aria-describedby="partners-subdivision-hint" data-i18n-placeholder="ui_web_a41c8a6265bc">
                            <span id="partners-subdivision-hint" data-i18n="ui_web_9b1547c40118">Use the applicable ISO subdivision code only when needed.</span>
                        </div>
                        <div class="partners-form-status" data-partners-jurisdiction-status
                            role="status" aria-live="polite" aria-atomic="true"></div>
                        <div class="partners-actions partners-actions-row">
                            <button class="btn btn-primary" type="submit" data-i18n="ui_web_2071664a583f">Check availability</button>
                            <button class="btn btn-secondary" type="button" data-partners-back data-i18n="ui_web_76900f1bfd16">Back</button>
                        </div>
                    </form>
                    <p class="partners-program-note" data-i18n="ui_web_139721950b72">This check does not promise eligibility, earnings or programme access. The authoritative result comes from Norva's server policy.</p>
                    ${this.programWindowNote(data.program)}
                </section>
                ${this.liveRegion((globalThis.NorvaI18n?.t("ui_web_c81418a75359", { defaultValue: "Enter a country code to check Norva Partners availability." }) ?? 'Enter a country code to check Norva Partners availability.'))}
            </main>
            <div class="partners-country-picker-overlay" data-region-picker
                data-partners-country-overlay hidden>
                <section id="partners-country-dialog"
                    class="partners-country-dialog region-picker-pop"
                    data-region-pop role="dialog" aria-modal="true"
                    aria-labelledby="partners-country-picker-title" hidden>
                    <header class="partners-country-dialog-header">
                        <div>
                            <span class="partners-eyebrow" data-i18n="ui_web_eaff23c82663">Norva Partners</span>
                            <h2 id="partners-country-picker-title" data-i18n="ui_web_90095a585379">Choose your country</h2>
                        </div>
                        <button class="partners-country-close" type="button"
                            data-partners-country-close aria-label="Close country selector" data-i18n-aria-label="ui_web_22df99431eaf">×</button>
                    </header>
                    <label class="partners-country-search-label" for="partners-country-search" data-i18n="ui_web_320113ee29d0">Search countries</label>
                    <input id="partners-country-search" class="region-picker-search"
                        data-partners-country-search type="search" role="combobox"
                        aria-autocomplete="list" aria-controls="partners-country-listbox"
                        aria-expanded="true" autocomplete="off"
                        placeholder="Search by country or ISO code" data-i18n-placeholder="ui_web_589dab472c1f">
                    <ul id="partners-country-listbox"
                        class="region-picker-list partners-country-list"
                        data-partners-country-listbox role="listbox"
                        aria-label="Countries" data-i18n-aria-label="ui_web_8faf7ec7ab20">${this.countryOptionMarkup(countries, this._jurisdiction.countryCode)}</ul>
                    <footer class="partners-country-dialog-footer">
                        <button class="btn btn-secondary partners-country-code-action"
                            type="button" data-partners-country-manual-open data-i18n="ui_web_b1761cdbf509">Country not listed? Enter code</button>
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
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-discovery-grid">
                    <div class="partners-discovery-copy">
                        <span class="partners-eyebrow" data-i18n="ui_web_8ad76db0ec70">Join now · Verify only for cash</span>
                        <h1 id="partners-title" class="partners-display" tabindex="-1" data-i18n="ui_web_40aa6a302c67" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p1":(rate)}) || "{}")}">Share Norva. Earn ${rate} on eligible renewals.</h1>
                        <p class="partners-lead" data-i18n="ui_web_5e8034d00982">Your confirmed Norva account can join and receive a personal referral link immediately. Identity verification is never required to share, earn or convert an available balance into Norva access.</p>
                        <span class="partners-status-pill partners-status-success" data-i18n="ui_web_7e6af7fed4c2">Ready to join</span>
                        <form class="partners-join-form" data-partners-membership-form novalidate>
                            <label class="partners-consent-check">
                                <input type="checkbox" data-partners-terms-confirm>
                                <span><norva-i18n data-i18n="ui_web_b84e86ef620c">I accept the </norva-i18n><a href="/partners-terms.html" target="_blank" rel="noopener noreferrer" data-i18n="ui_web_075e477acf6e">Norva Partners Terms</a>.</span>
                            </label>
                            <label class="partners-consent-check">
                                <input type="checkbox" data-partners-disclosure-confirm>
                                <span data-i18n="ui_web_bbb7acef6328" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p2":(program.maturation_days)}) || "{}")}">I understand that commission normally stays pending for at least ${program.maturation_days} days and may be reversed after a refund or chargeback.</span>
                            </label>
                            <div class="partners-actions">
                                <button class="btn btn-primary partners-primary-action" type="submit"
                                    data-partners-membership-join disabled data-i18n="ui_web_31c184d14ad3">Join and get my link</button>
                                <span class="partners-action-note" data-i18n="ui_web_105375de61ad">No identity documents, tax details or payout destination are requested when you join.</span>
                            </div>
                            <div class="partners-form-status" data-partners-action-status role="status" aria-live="polite" aria-atomic="true"></div>
                        </form>
                        <p class="partners-disclosure"><strong data-i18n="ui_web_496d6960431c">Important:</strong><norva-i18n data-i18n="ui_web_c2e7a26a8d52" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p3":(rate)}) || "{}")}"> earnings are not guaranteed. Commission is ${rate} of eligible payments after discounts and before tax. Refunds and chargebacks reverse the related commission. Available balance can fund Norva access without identity verification; cash transfers require identity, tax and payout checks.</norva-i18n></p>
                    </div>
                    <aside class="partners-program-card" aria-labelledby="partners-program-title">
                        <h2 id="partners-program-title" data-i18n="ui_web_bc22d0782a5e">How Norva Partners works</h2>
                        <p class="partners-program-intro" data-i18n="ui_web_10c08e68056e">Open any info button for a plain-language example.</p>
                        ${this.membershipProgramFacts(program, rate)}
                    </aside>
                </section>
                ${this.membershipSteps(program)}
                ${this.liveRegion((globalThis.NorvaI18n?.t("ui_web_0d3491db33bb", { defaultValue: "Norva Partners is ready. Accept the current terms and disclosure to join without identity verification." }) ?? 'Norva Partners is ready. Accept the current terms and disclosure to join without identity verification.'))}
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
                this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_ada9f09df842", { defaultValue: "Accept the current terms and programme disclosure first." }) ?? 'Accept the current terms and programme disclosure first.'), 'error');
                (!terms.checked ? terms : disclosure).focus();
                return;
            }
            await this.runPartnerAction(button, (globalThis.NorvaI18n?.t("ui_web_a065b837ca5d", { defaultValue: "Creating your link…" }) ?? 'Creating your link…'), async () => {
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
                this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_5295eff32f95", { defaultValue: "You joined Norva Partners. Loading your personal link." }) ?? 'You joined Norva Partners. Loading your personal link.'));
                this.bootstrapEnvelope = null;
                await this.show();
            });
        });
        sync();
    }

    renderMembershipAttention(data) {
        const status = this.statusLabel(data.membership.status, (globalThis.NorvaI18n?.t("ui_web_f85937ff7855", { defaultValue: "Partner membership" }) ?? 'Partner membership'));
        const terminal = ['suspended', 'closed'].includes(data.membership.status);
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-state-card partners-state-wide">
                    <span class="partners-status-pill partners-status-warning">${terminal ? (globalThis.NorvaI18n?.t("ui_web_beb61749e79f", { defaultValue: "Membership unavailable" }) ?? 'Membership unavailable') : (globalThis.NorvaI18n?.t("ui_web_f9ced2036d9b", { defaultValue: "Review in progress" }) ?? 'Review in progress')}</span>
                    <h1 id="partners-title" tabindex="-1">${terminal ? (globalThis.NorvaI18n?.t("ui_web_6544d0ad5774", { defaultValue: "Your Partners membership is not active." }) ?? 'Your Partners membership is not active.') : (globalThis.NorvaI18n?.t("ui_web_260d1646c116", { defaultValue: "Your Partners membership is temporarily on hold." }) ?? 'Your Partners membership is temporarily on hold.')}</h1>
                    <p data-i18n="ui_web_c18c1a9726f2">Sharing, earning and balance conversion follow the authoritative membership state. No local action can bypass this protection.</p>
                    <dl class="partners-checklist">
                        <div><dt data-i18n="ui_web_9feceb9333b5">Membership</dt><dd>${this.escape(status)}</dd></div>
                        <div><dt data-i18n="ui_web_2b196a027f1b">Identity check</dt><dd>${this.escape(this.statusLabel(data.membership.verification_status, (globalThis.NorvaI18n?.t("ui_web_6ef42881fe80", { defaultValue: "Not required for membership" }) ?? 'Not required for membership')))}</dd></div>
                    </dl>
                    <div class="partners-actions partners-actions-row">
                        <a class="btn btn-secondary" href="/support.html?returnTo=%2Fapp%23partners" data-i18n="ui_web_814f4ed2d5bd">Contact support</a>
                        <button class="btn btn-ghost" type="button" data-partners-back data-i18n="ui_web_76900f1bfd16">Back</button>
                    </div>
                </section>
                ${this.liveRegion((globalThis.NorvaI18n?.t("ui_web_a489fcc2734a", { defaultValue: "Your Norva Partners membership needs a secure review." }) ?? 'Your Norva Partners membership needs a secure review.'), 'assertive')}
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
            ? (globalThis.NorvaI18n?.t("ui_web_14ec345909a6", { defaultValue: "Cash transfer pilot" }) ?? 'Cash transfer pilot')
            : (globalThis.NorvaI18n?.t("ui_web_70227f8af3e4", { defaultValue: "Receive a cash transfer" }) ?? 'Receive a cash transfer');
        const availableBalanceNote = cashPilotLimited
            ? (globalThis.NorvaI18n?.t("ui_web_f32cf6a3778e", { defaultValue: "Convert to Norva · cash pilot limited" }) ?? 'Convert to Norva · cash pilot limited')
            : (globalThis.NorvaI18n?.t("ui_web_0f9b7494c0e1", { defaultValue: "Convert or request cash" }) ?? 'Convert or request cash');
        const earningsEnabled = data.flags?.partners_earnings_enabled === true;
        const membershipBadge = earningsEnabled
            ? (globalThis.NorvaI18n?.t("ui_web_2effb4b01333", { defaultValue: "Ready to share" }) ?? 'Ready to share')
            : (globalThis.NorvaI18n?.t("ui_web_519da35911ea", { defaultValue: "Link active · Earnings paused" }) ?? 'Link active · Earnings paused');
        const membershipBadgeClass = earningsEnabled
            ? 'partners-status-success'
            : 'partners-status-warning';
        const membershipSummary = earningsEnabled
            ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_0e050df0427c", {defaultValue: "Share immediately, follow the {{p0}}-day validation period and choose how to use your available balance.", p0:(data.program.maturation_days)}) : `Share immediately, follow the ${data.program.maturation_days}-day validation period and choose how to use your available balance.`)
            : (globalThis.NorvaI18n?.t("ui_web_88057b2415d4", { defaultValue: "Your referral link remains active, but new commissions are temporarily paused. Existing balances and history remain protected." }) ?? 'Your referral link remains active, but new commissions are temporarily paused. Existing balances and history remain protected.');
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-dashboard-heading">
                    <div>
                        <span class="partners-status-pill ${membershipBadgeClass}">${membershipBadge}</span>
                        <h1 id="partners-title" tabindex="-1" data-i18n="ui_web_85115bf0b073">Your Partners balance</h1>
                        <p>${membershipSummary}</p>
                    </div>
                    <div class="partners-dashboard-actions">
                        <button class="btn btn-secondary" type="button" data-partners-cash-button>${cashActionLabel}</button>
                        <button class="btn btn-secondary" type="button" data-partners-dashboard-retry data-i18n="ui_web_0e9161011702">Refresh</button>
                    </div>
                </section>
                <div class="partners-kyc-progress-host" data-partners-kyc-progress-host>
                    ${this.cashKycProgressMarkup(data.membership, data.cash_readiness)}
                </div>
                <section class="partners-metrics" aria-label="Partner balance" data-partners-dashboard-metrics aria-busy="true" data-i18n-aria-label="ui_web_02ba91913522">
                    ${this.metric((globalThis.NorvaI18n?.t("ui_web_f859a9cae3f5", { defaultValue: "Available to use" }) ?? 'Available to use'), (globalThis.NorvaI18n?.t("ui_web_dc380888c4e2", { defaultValue: "Loading" }) ?? 'Loading'), availableBalanceNote)}
                    ${this.metric((globalThis.NorvaI18n?.t("ui_web_6d2d474ca6dc", { defaultValue: "In validation" }) ?? 'In validation'), (globalThis.NorvaI18n?.t("ui_web_dc380888c4e2", { defaultValue: "Loading" }) ?? 'Loading'), (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_e433dc398c1c", {defaultValue: "{{p0}}-day validation window", p0:(data.program.maturation_days)}) : `${data.program.maturation_days}-day validation window`))}
                    ${this.metric((globalThis.NorvaI18n?.t("ui_web_132cb8ad0df6", { defaultValue: "Converted to Norva" }) ?? 'Converted to Norva'), (globalThis.NorvaI18n?.t("ui_web_dc380888c4e2", { defaultValue: "Loading" }) ?? 'Loading'), (globalThis.NorvaI18n?.t("ui_web_b30d29f1d8cf", { defaultValue: "Access credits used" }) ?? 'Access credits used'))}
                    ${this.metric((globalThis.NorvaI18n?.t("ui_web_aa6a620d6348", { defaultValue: "Next balance update" }) ?? 'Next balance update'), (globalThis.NorvaI18n?.t("ui_web_dc380888c4e2", { defaultValue: "Loading" }) ?? 'Loading'), (globalThis.NorvaI18n?.t("ui_web_1f865873e57e", { defaultValue: "Authoritative schedule" }) ?? 'Authoritative schedule'))}
                </section>
                <section data-partners-dashboard-content aria-busy="true">
                    <div class="partners-skeleton partners-skeleton-hero" aria-hidden="true"></div>
                </section>
                <div class="partners-form-status" data-partners-action-status role="status" aria-live="polite" aria-atomic="true"></div>
                ${this.liveRegion((globalThis.NorvaI18n?.t("ui_web_92c722c8b6c2", { defaultValue: "Norva Partners is active. Loading your personal link and balance." }) ?? 'Norva Partners is active. Loading your personal link and balance.'))}
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

    hasRecentKycReturn() {
        return Number.isSafeInteger(this._kycReturnPendingUntil)
            && this._kycReturnPendingUntil > Date.now();
    }

    cashKycProgressModel(membership, cashReadiness) {
        const status = String(membership?.verification_status || 'not_started');
        const recentlyReturned = this.hasRecentKycReturn();
        if (status === 'not_started' && !recentlyReturned) return null;
        if (status === 'verified') {
            return {
                tone: 'success',
                badgeClass: 'partners-status-success',
                badge: (globalThis.NorvaI18n?.t("ui_web_99b52fb41be2", { defaultValue: "Identity verified" }) ?? 'Identity verified'),
                title: (globalThis.NorvaI18n?.t("ui_web_62d3ed465af0", { defaultValue: "Your cash-transfer identity check is complete." }) ?? 'Your cash-transfer identity check is complete.'),
                copy: cashReadiness?.ready
                    ? (globalThis.NorvaI18n?.t("ui_web_0e5894bd6f0b", { defaultValue: "Cash setup is ready. Continue only when you choose to request a transfer." }) ?? 'Cash setup is ready. Continue only when you choose to request a transfer.')
                    : (globalThis.NorvaI18n?.t("ui_web_4a5a95ce5699", { defaultValue: "You can continue with the remaining tax and payout checks when you choose. Sharing, earnings and Norva-access conversions stay available." }) ?? 'You can continue with the remaining tax and payout checks when you choose. Sharing, earnings and Norva-access conversions stay available.')
            };
        }
        if (status === 'failed') {
            return {
                tone: 'attention',
                badgeClass: 'partners-status-warning',
                badge: (globalThis.NorvaI18n?.t("ui_web_adf69e75cc7d", { defaultValue: "Action required" }) ?? 'Action required'),
                title: (globalThis.NorvaI18n?.t("ui_web_827a3aec1db6", { defaultValue: "The identity check could not be confirmed." }) ?? 'The identity check could not be confirmed.'),
                copy: (globalThis.NorvaI18n?.t("ui_web_f6c984cdc257", { defaultValue: "Your balance is unchanged. Open “Receive a cash transfer” to review the safe retry path; never send identity documents to Support." }) ?? 'Your balance is unchanged. Open “Receive a cash transfer” to review the safe retry path; never send identity documents to Support.')
            };
        }
        if (status === 'expired') {
            return {
                tone: 'attention',
                badgeClass: 'partners-status-warning',
                badge: (globalThis.NorvaI18n?.t("ui_web_e5ee1e7e84aa", { defaultValue: "Session expired" }) ?? 'Session expired'),
                title: (globalThis.NorvaI18n?.t("ui_web_b1734a239d09", { defaultValue: "A fresh identity check is required for cash." }) ?? 'A fresh identity check is required for cash.'),
                copy: (globalThis.NorvaI18n?.t("ui_web_6cd125f2b6b5", { defaultValue: "Your membership and balance remain active. Start a new hosted session only when you are ready to request a cash transfer." }) ?? 'Your membership and balance remain active. Start a new hosted session only when you are ready to request a cash transfer.')
            };
        }
        return {
            tone: 'pending',
            badgeClass: 'partners-status-warning',
            badge: status === 'pending' ? (globalThis.NorvaI18n?.t("ui_web_9e8a3b648cf7", { defaultValue: "Under review" }) ?? 'Under review') : (globalThis.NorvaI18n?.t("ui_web_194c2ad4b165", { defaultValue: "Confirmation pending" }) ?? 'Confirmation pending'),
            title: status === 'pending'
                ? (globalThis.NorvaI18n?.t("ui_web_511eae157578", { defaultValue: "Didit is reviewing your submission." }) ?? 'Didit is reviewing your submission.')
                : (globalThis.NorvaI18n?.t("ui_web_5711ed9f2d8e", { defaultValue: "Norva is checking for a signed identity result." }) ?? 'Norva is checking for a signed identity result.'),
            copy: status === 'pending'
                ? (globalThis.NorvaI18n?.t("ui_web_fe64de79d2b1", { defaultValue: "Norva received the signed in-review state and refreshes it automatically. You can leave this page, keep sharing and use balance for Norva access in the meantime." }) ?? 'Norva received the signed in-review state and refreshes it automatically. You can leave this page, keep sharing and use balance for Norva access in the meantime.')
                : (globalThis.NorvaI18n?.t("ui_web_9b36cfc35b47", { defaultValue: "No provider result has been recorded yet. Norva refreshes this status automatically without trusting the return link. You can leave this page, keep sharing and use balance for Norva access in the meantime." }) ?? 'No provider result has been recorded yet. Norva refreshes this status automatically without trusting the return link. You can leave this page, keep sharing and use balance for Norva access in the meantime.')
        };
    }

    cashKycProgressMarkup(membership, cashReadiness) {
        const model = this.cashKycProgressModel(membership, cashReadiness);
        if (!model) return '';
        return `<section class="partners-kyc-progress is-${this.escape(model.tone)}"
                data-partners-kyc-progress role="status" aria-live="polite" aria-atomic="true">
            <div>
                <span class="partners-eyebrow" data-i18n="ui_web_af18aba7fbca">Optional cash transfer</span>
                <h2>${this.escape(model.title)}</h2>
                <p>${this.escape(model.copy)}</p>
            </div>
            <span class="partners-status-pill ${this.escape(model.badgeClass)}">${this.escape(model.badge)}</span>
        </section>`;
    }

    updateCashKycProgress(membership, cashReadiness) {
        const host = this.container?.querySelector('[data-partners-kyc-progress-host]');
        if (!host) return;
        const status = String(membership?.verification_status || 'not_started');
        if (['verified', 'failed', 'expired'].includes(status)) {
            this._kycReturnPendingUntil = 0;
        }
        host.innerHTML = this.cashKycProgressMarkup(membership, cashReadiness);
    }

    renderDiscovery(data) {
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-consent-card" aria-labelledby="partners-title">
                    <div>
                        <span class="partners-eyebrow" data-i18n="ui_web_493191039e13">Secure programme update</span>
                        <h1 id="partners-title" tabindex="-1" data-i18n="ui_web_23446f0e6291">Refresh to load the current Partners contract.</h1>
                        <p data-i18n="ui_web_db060da01498">This compatibility response is from an older server contract. Norva will not start identity verification or create a membership from stale rules. The current journey lets individuals join, share, earn and convert to Norva access without KYC; Didit is reserved for optional cash transfers.</p>
                    </div>
                    <button class="btn btn-primary partners-primary-action" type="button" data-partners-retry data-i18n="ui_web_fd14491edf16">Refresh securely</button>
                </section>
                ${this.liveRegion((globalThis.NorvaI18n?.t("ui_web_98fc55d65a89", { defaultValue: "A current Norva Partners contract is required. Refresh the page to continue." }) ?? 'A current Norva Partners contract is required. Refresh the page to continue.'))}
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
                label: (globalThis.NorvaI18n?.t("ui_web_040cd216cc1f", { defaultValue: "Commission on eligible payments" }) ?? 'Commission on eligible payments'),
                value: rate,
                title: (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_855d10767490", {defaultValue: "How {{p0}} is calculated", p0:(rate)}) : `How ${rate} is calculated`),
                copy: (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_853105499ca4", {defaultValue: "Example: if the eligible amount after discounts and before tax is US$5, your commission is US$1. Refunds or chargebacks reverse the related amount."}) : `Example: if the eligible amount after discounts and before tax is US$5, your commission is US$1. Refunds or chargebacks reverse the related amount.`)
            },
            {
                id: 'attribution',
                label: (globalThis.NorvaI18n?.t("ui_web_2845a29d225a", { defaultValue: "Referral tracking window" }) ?? 'Referral tracking window'),
                value: `${attributionDays} days`,
                title: (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_40ff83b7d4ab", {defaultValue: "What the {{p0}}-day window means", p0:(attributionDays)}) : `What the ${attributionDays}-day window means`),
                copy: (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_c0cb70d34cb9", {defaultValue: "A person normally needs to start their eligible subscription within {{p0}} days of using your link. Attribution still depends on eligibility and anti-fraud checks.", p0:(attributionDays)}) : `A person normally needs to start their eligible subscription within ${attributionDays} days of using your link. Attribution still depends on eligibility and anti-fraud checks.`)
            },
            {
                id: 'validation',
                label: (globalThis.NorvaI18n?.t("ui_web_70b52b46ac8e", { defaultValue: "Balance validation" }) ?? 'Balance validation'),
                value: `${maturationDays} days`,
                title: (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_c2dd334eea0f", {defaultValue: "Why commission waits at least {{p0}} days", p0:(maturationDays)}) : `Why commission waits at least ${maturationDays} days`),
                copy: (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_55d7761a102d", {defaultValue: "Commission first appears as pending. It normally becomes available after at least {{p0}} days, once refund, chargeback and eligibility checks are complete.", p0:(maturationDays)}) : `Commission first appears as pending. It normally becomes available after at least ${maturationDays} days, once refund, chargeback and eligibility checks are complete.`)
            },
            {
                id: 'sharing',
                label: (globalThis.NorvaI18n?.t("ui_web_c6cfcaba979d", { defaultValue: "Start sharing" }) ?? 'Start sharing'),
                value: (globalThis.NorvaI18n?.t("ui_web_0fe556b25edd", { defaultValue: "Immediately" }) ?? 'Immediately'),
                title: (globalThis.NorvaI18n?.t("ui_web_7469fe6119c3", { defaultValue: "What you need to start" }) ?? 'What you need to start'),
                copy: (globalThis.NorvaI18n?.t("ui_web_b0ba1dc41d37", { defaultValue: "A confirmed Norva account and acceptance of the current terms are enough to create your personal link. No identity documents are requested." }) ?? 'A confirmed Norva account and acceptance of the current terms are enough to create your personal link. No identity documents are requested.')
            },
            {
                id: 'access',
                label: (globalThis.NorvaI18n?.t("ui_web_1fdd00764e00", { defaultValue: "Use balance for Norva" }) ?? 'Use balance for Norva'),
                value: (globalThis.NorvaI18n?.t("ui_web_b7136a728b71", { defaultValue: "No identity check" }) ?? 'No identity check'),
                title: (globalThis.NorvaI18n?.t("ui_web_cfb7652170fa", { defaultValue: "Using balance for your Norva access" }) ?? 'Using balance for your Norva access'),
                copy: (globalThis.NorvaI18n?.t("ui_web_9dc864fec460", { defaultValue: "Available commission can be converted through an exact server quote into one or more months of Norva access. You review the amount before confirming; the conversion is final and cannot be paid out as cash." }) ?? 'Available commission can be converted through an exact server quote into one or more months of Norva access. You review the amount before confirming; the conversion is final and cannot be paid out as cash.')
            },
            {
                id: 'cash',
                label: (globalThis.NorvaI18n?.t("ui_web_9337191a2103", { defaultValue: "Transfer balance to cash" }) ?? 'Transfer balance to cash'),
                value: (globalThis.NorvaI18n?.t("ui_web_4585bf8efa13", { defaultValue: "Verification required" }) ?? 'Verification required'),
                title: (globalThis.NorvaI18n?.t("ui_web_7316078f9e06", { defaultValue: "Why cash requires verification" }) ?? 'Why cash requires verification'),
                copy: (globalThis.NorvaI18n?.t("ui_web_b4f1fab1e044", { defaultValue: "Before a cash transfer, Norva must verify your identity, country, tax details and payout destination. You can still share and use balance for Norva access without completing this step." }) ?? 'Before a cash transfer, Norva must verify your identity, country, tax details and payout destination. You can still share and use balance for Norva access without completing this step.')
            }
        ];
        return `<dl class="partners-program-facts partners-program-facts--guided" aria-label="Norva Partners programme explained" data-i18n-aria-label="ui_web_4046ad12f0e2">
            ${facts.map((fact) => `<div class="partners-program-fact">
                <dt>${this.escape(fact.label)}</dt>
                <dd class="partners-program-value">${this.escape(fact.value)}</dd>
                <dd class="partners-program-help">
                    <details name="partners-program-help">
                        <summary aria-label="More information about ${this.escape(fact.label)}"
                            aria-controls="partners-program-help-${this.escape(fact.id)}" data-i18n-aria-label="ui_web_bd6c58a0484d" data-i18n-aria-label-args="${(globalThis.NorvaI18n?.args?.({"p2":(this.escape(fact.label))}) || "{}")}">${infoIcon}</summary>
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
        const verification = this.statusLabel(data.account.verification_status, (globalThis.NorvaI18n?.t("ui_web_b207ae38ab70", { defaultValue: "Identity verification" }) ?? 'Identity verification'));
        const contract = this.statusLabel(data.account.contract_status, (globalThis.NorvaI18n?.t("ui_web_9ca46294bc03", { defaultValue: "Programme terms" }) ?? 'Programme terms'));
        const link = this.statusLabel(data.account.link_status, (globalThis.NorvaI18n?.t("ui_web_441c6d0e08c3", { defaultValue: "Referral link" }) ?? 'Referral link'));
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
                badge: (globalThis.NorvaI18n?.t("ui_web_c24896c755bd", { defaultValue: "Application received" }) ?? 'Application received'),
                title: (globalThis.NorvaI18n?.t("ui_web_361013f452e3", { defaultValue: "Review the current programme terms to continue." }) ?? 'Review the current programme terms to continue.'),
                copy: (globalThis.NorvaI18n?.t("ui_web_733090d4668d", { defaultValue: "Your application is saved. Identity verification stays locked until the current terms and disclosure are accepted." }) ?? 'Your application is saved. Identity verification stays locked until the current terms and disclosure are accepted.'),
                announcement: (globalThis.NorvaI18n?.t("ui_web_e7549c4d71c9", { defaultValue: "Your Norva Partners application is ready for the current programme terms." }) ?? 'Your Norva Partners application is ready for the current programme terms.')
            }
            : (supportRequired
                ? {
                    badge: (globalThis.NorvaI18n?.t("ui_web_1a25550fa075", { defaultValue: "Support required" }) ?? 'Support required'),
                    title: (globalThis.NorvaI18n?.t("ui_web_12ba0495a7bb", { defaultValue: "Your verified partner profile needs a secure review." }) ?? 'Your verified partner profile needs a secure review.'),
                    copy: (globalThis.NorvaI18n?.t("ui_web_2ec65140f3d3", { defaultValue: "Norva cannot complete activation automatically from this state. Contact Support; no referral or financial action has been enabled locally." }) ?? 'Norva cannot complete activation automatically from this state. Contact Support; no referral or financial action has been enabled locally.'),
                    announcement: (globalThis.NorvaI18n?.t("ui_web_c0beabff4dbe", { defaultValue: "Norva Partners requires a secure Support review." }) ?? 'Norva Partners requires a secure Support review.')
                }
                : (verificationRetry
                ? {
                    badge: data.account.verification_status === 'expired'
                        ? (globalThis.NorvaI18n?.t("ui_web_a58d601d3a77", { defaultValue: "Verification expired" }) ?? 'Verification expired')
                        : (globalThis.NorvaI18n?.t("ui_web_e1d03c3056d4", { defaultValue: "Verification incomplete" }) ?? 'Verification incomplete'),
                    title: (globalThis.NorvaI18n?.t("ui_web_b13848714a38", { defaultValue: "Start a fresh secure identity check." }) ?? 'Start a fresh secure identity check.'),
                    copy: (globalThis.NorvaI18n?.t("ui_web_0bd798a2c0c8", { defaultValue: "The previous hosted check did not complete. Review the confirmations below to start a fresh Didit session; no identity document is uploaded to this page." }) ?? 'The previous hosted check did not complete. Review the confirmations below to start a fresh Didit session; no identity document is uploaded to this page.'),
                    announcement: (globalThis.NorvaI18n?.t("ui_web_82e18048a58e", { defaultValue: "A fresh Norva Partners identity check is available." }) ?? 'A fresh Norva Partners identity check is available.')
                }
                : (data.account.verification_status === 'not_started'
                    ? {
                        badge: (globalThis.NorvaI18n?.t("ui_web_4585bf8efa13", { defaultValue: "Verification required" }) ?? 'Verification required'),
                        title: (globalThis.NorvaI18n?.t("ui_web_15343758c4b5", { defaultValue: "Verify your identity to activate your partner link." }) ?? 'Verify your identity to activate your partner link.'),
                        copy: (globalThis.NorvaI18n?.t("ui_web_3c6b0b7d903b", { defaultValue: "Complete the secure hosted identity check. Norva unlocks the referral link only after the signed provider result is confirmed." }) ?? 'Complete the secure hosted identity check. Norva unlocks the referral link only after the signed provider result is confirmed.'),
                        announcement: (globalThis.NorvaI18n?.t("ui_web_c3e53d08c9c6", { defaultValue: "Norva Partners identity verification is ready to start." }) ?? 'Norva Partners identity verification is ready to start.')
                    }
                    : (activationPending
                        ? {
                            badge: (globalThis.NorvaI18n?.t("ui_web_61000a1f0162", { defaultValue: "Activation in progress" }) ?? 'Activation in progress'),
                            title: (globalThis.NorvaI18n?.t("ui_web_964e3bddc9b8", { defaultValue: "Your identity is verified. Activation is finishing." }) ?? 'Your identity is verified. Activation is finishing.'),
                            copy: (globalThis.NorvaI18n?.t("ui_web_00d7ccdc7e36", { defaultValue: "Norva is confirming the final programme checks and preparing your referral link. No extra identity action is required." }) ?? 'Norva is confirming the final programme checks and preparing your referral link. No extra identity action is required.'),
                            announcement: (globalThis.NorvaI18n?.t("ui_web_66f8e167b921", { defaultValue: "Norva Partners activation is in progress." }) ?? 'Norva Partners activation is in progress.')
                        }
                        : {
                            badge: (globalThis.NorvaI18n?.t("ui_web_a856e05ee816", { defaultValue: "Verification pending" }) ?? 'Verification pending'),
                            title: (globalThis.NorvaI18n?.t("ui_web_29451a3bb517", { defaultValue: "Your individual partner profile is being checked." }) ?? 'Your individual partner profile is being checked.'),
                            copy: (globalThis.NorvaI18n?.t("ui_web_c691559142f5", { defaultValue: "Norva waits for authoritative server confirmation before enabling a referral link. Refreshing this page cannot bypass verification." }) ?? 'Norva waits for authoritative server confirmation before enabling a referral link. Refreshing this page cannot bypass verification.'),
                            announcement: (globalThis.NorvaI18n?.t("ui_web_7e8f95ccda91", { defaultValue: "Norva Partners identity verification is pending." }) ?? 'Norva Partners identity verification is pending.')
                        }))));
        const pendingAction = canAcceptTerms
            ? `<button class="btn btn-primary partners-primary-action" type="button"
                    data-partners-accept-terms data-i18n="ui_web_69b2b1f5629d">Accept current programme terms</button>`
            : (canStartKyc
                ? `<form class="partners-join-form partners-kyc-form" data-partners-kyc-form novalidate>
                    <aside class="partners-provider-disclosure" aria-labelledby="partners-didit-disclosure-title">
                        <strong id="partners-didit-disclosure-title" data-i18n="ui_web_e7fad1d33eef">Before you verify with Didit</strong>
                        <span><norva-i18n data-i18n="ui_web_a42dab9f5506">Norva requests this eligibility check and Didit provides the secure hosted identity-verification flow. Review the </norva-i18n><a href="/privacy.html#partners" target="_blank" rel="noopener" data-i18n="ui_web_47477d255da8">Norva Privacy Notice</a>, <a href="https://didit.me/terms/verification-privacy-notice/" target="_blank" rel="noopener noreferrer" data-i18n="ui_web_03edc68d9904">Didit Verification Privacy Notice</a><norva-i18n data-i18n="ui_web_6201111b83a0"> and </norva-i18n><a href="https://didit.me/terms/identity-verification/" target="_blank" rel="noopener noreferrer" data-i18n="ui_web_86b6859f428d">Didit End User Terms</a><norva-i18n data-i18n="ui_web_e86be3a8fc32"> before continuing.</norva-i18n></span>
                    </aside>
                    <label class="partners-consent-check">
                        <input type="checkbox" data-partners-kyc-consent>
                        <span data-i18n="ui_web_56ee90eec406">I have read these notices and explicitly consent to document, selfie, liveness and face-match capture in Didit's hosted flow for this individual Partners eligibility check. Identity documents are handled by Didit, not uploaded to this page.</span>
                    </label>
                    <label class="partners-consent-check">
                        <input type="checkbox" data-partners-capacity-confirm>
                        <span data-i18n="ui_web_1a5d733d8cd1" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(Number(data.policy.minimum_age))}) || "{}")}">I confirm that I meet the ${Number(data.policy.minimum_age)}+ policy and have legal capacity to join as an individual.</span>
                    </label>
                    <button class="btn btn-primary partners-primary-action" type="submit"
                        data-partners-start-kyc disabled aria-describedby="partners-verification-note">${verificationRetry ? (globalThis.NorvaI18n?.t("ui_web_9265786a6706", { defaultValue: "Retry identity verification" }) ?? 'Retry identity verification') : (globalThis.NorvaI18n?.t("ui_web_ab314b9bf095", { defaultValue: "Verify my identity securely" }) ?? 'Verify my identity securely')}</button>
                  </form>`
                : (supportRequired
                    ? `<a class="btn btn-secondary partners-primary-action"
                        href="/support.html?returnTo=%2Fapp%23partners" data-i18n="ui_web_814f4ed2d5bd">Contact support</a>`
                    : (verificationPending || activationPending
                    ? `<button class="btn btn-secondary partners-primary-action" type="button"
                        data-partners-refresh-verification aria-describedby="partners-verification-note">${activationPending ? (globalThis.NorvaI18n?.t("ui_web_98d7176afc01", { defaultValue: "Check activation status" }) ?? 'Check activation status') : (globalThis.NorvaI18n?.t("ui_web_aa41e178bef0", { defaultValue: "Check verification status" }) ?? 'Check verification status')}</button>`
                    : `<button class="btn btn-secondary partners-primary-action" type="button" disabled
                        aria-describedby="partners-verification-note" data-i18n="ui_web_6cb4ccab4d42">Identity verification unavailable</button>`)));
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-state-card partners-state-wide">
                    <span class="partners-status-pill partners-status-warning">${this.escape(stateCopy.badge)}</span>
                    <h1 id="partners-title" tabindex="-1">${this.escape(stateCopy.title)}</h1>
                    <p>${this.escape(stateCopy.copy)}</p>
                    <dl class="partners-checklist">
                        <div><dt data-i18n="ui_web_999f23fcd7be">Identity</dt><dd>${this.escape(verification)}</dd></div>
                        <div><dt data-i18n="ui_web_ede548996483">Terms</dt><dd>${this.escape(contract)}</dd></div>
                        <div><dt data-i18n="ui_web_441c6d0e08c3">Referral link</dt><dd>${this.escape(link)}</dd></div>
                    </dl>
                    ${needsTerms ? this.payoutThresholdDisclosure(data.program, data.policy, 'pending') : ''}
                    ${pendingAction}
                    <p id="partners-verification-note" class="partners-action-note">${canAcceptTerms
                            ? `<norva-i18n data-i18n="ui_web_bd1c1912b6d8">Open and review the </norva-i18n><a href="/partners-terms.html?version=${encodeURIComponent(data.policy.terms_version)}" target="_blank" rel="noopener" data-i18n="ui_web_a0a8f360ebe2">current Norva Partners terms</a><norva-i18n data-i18n="ui_web_6f0c8a77c973"> before accepting.</norva-i18n>`
                            : (needsTerms
                                ? (globalThis.NorvaI18n?.t("ui_web_a506781ad8ad", { defaultValue: "The authoritative programme policy is unavailable. Terms cannot be accepted until the server restores it." }) ?? 'The authoritative programme policy is unavailable. Terms cannot be accepted until the server restores it.')
                                : (canStartKyc
                                    ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_9a6fe9931ecc", {defaultValue: "You will continue on Didit's secure hosted verification. Norva records the dedicated biometric consent {{p0}} separately from programme disclosure {{p1}}, and receives only the verification result needed for programme eligibility.", p0:(this.escape(PartnersPage.BIOMETRIC_CONSENT_VERSION)),p1:(this.escape(data.policy.disclosure_version))}) : `You will continue on Didit's secure hosted verification. Norva records the dedicated biometric consent ${this.escape(PartnersPage.BIOMETRIC_CONSENT_VERSION)} separately from programme disclosure ${this.escape(data.policy.disclosure_version)}, and receives only the verification result needed for programme eligibility.`)
                                    : (supportRequired
                                        ? (globalThis.NorvaI18n?.t("ui_web_a04bd5918ba1", { defaultValue: "Support will review the authoritative account state. Do not send identity documents, bank details or tax identifiers in a support message." }) ?? 'Support will review the authoritative account state. Do not send identity documents, bank details or tax identifiers in a support message.')
                                        : (verificationPending
                                        ? (globalThis.NorvaI18n?.t("ui_web_b406ded364b0", { defaultValue: "Your hosted verification was started. Norva will unlock the next step only after the signed provider result is received." }) ?? 'Your hosted verification was started. Norva will unlock the next step only after the signed provider result is received.')
                                        : (activationPending
                                            ? (globalThis.NorvaI18n?.t("ui_web_85ddf9c7ebc7", { defaultValue: "Your verified result is recorded. Refreshing checks only the authoritative activation state; it cannot create a link locally." }) ?? 'Your verified result is recorded. Refreshing checks only the authoritative activation state; it cannot create a link locally.')
                                            : (globalThis.NorvaI18n?.t("ui_web_bf1ab64623ef", { defaultValue: "The authoritative server has not enabled a new identity-verification action for this account." }) ?? 'The authoritative server has not enabled a new identity-verification action for this account.'))))))}</p>
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
        const verification = this.statusLabel(data.account.verification_status, (globalThis.NorvaI18n?.t("ui_web_b207ae38ab70", { defaultValue: "Identity verification" }) ?? 'Identity verification'));
        const contract = this.statusLabel(data.account.contract_status, (globalThis.NorvaI18n?.t("ui_web_9ca46294bc03", { defaultValue: "Programme terms" }) ?? 'Programme terms'));
        const account = this.statusLabel(data.account.status, (globalThis.NorvaI18n?.t("ui_web_4eca0498bdf0", { defaultValue: "Partner account" }) ?? 'Partner account'));
        const policyUnavailable = [
            'country_required',
            'country_not_supported',
            'subdivision_not_supported'
        ].includes(data.eligibility.reason) || data.policy?.individual_available === false;
        const status = policyUnavailable ? (globalThis.NorvaI18n?.t("ui_web_1c8939bb428b", { defaultValue: "Policy unavailable" }) ?? 'Policy unavailable') : (globalThis.NorvaI18n?.t("ui_web_030439767d89", { defaultValue: "Attention required" }) ?? 'Attention required');
        const title = policyUnavailable
            ? (globalThis.NorvaI18n?.t("ui_web_8409d5628280", { defaultValue: "The programme policy for this partner account is unavailable." }) ?? 'The programme policy for this partner account is unavailable.')
            : (globalThis.NorvaI18n?.t("ui_web_3bb4b84c251f", { defaultValue: "Your partner setup needs attention." }) ?? 'Your partner setup needs attention.');
        const copy = policyUnavailable
            ? (globalThis.NorvaI18n?.t("ui_web_a854be0d97f8", { defaultValue: "Norva is using the jurisdiction already stored on this partner account. Partner actions remain unavailable until the authoritative server policy is restored; this page will not ask you to replace that jurisdiction." }) ?? 'Norva is using the jurisdiction already stored on this partner account. Partner actions remain unavailable until the authoritative server policy is restored; this page will not ask you to replace that jurisdiction.')
            : (globalThis.NorvaI18n?.t("ui_web_577097d15a63", { defaultValue: "Norva cannot enable or restore partner actions until the authoritative account checks are complete. No referral or payout action is available from this read-only page." }) ?? 'Norva cannot enable or restore partner actions until the authoritative account checks are complete. No referral or payout action is available from this read-only page.');
        const announcement = policyUnavailable
            ? (globalThis.NorvaI18n?.t("ui_web_968948bcdfc5", { defaultValue: "The Norva Partners policy for this account is unavailable." }) ?? 'The Norva Partners policy for this account is unavailable.')
            : (globalThis.NorvaI18n?.t("ui_web_25b0b7218a49", { defaultValue: "Norva Partners setup needs attention." }) ?? 'Norva Partners setup needs attention.');
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-state-card partners-state-wide">
                    <span class="partners-status-pill partners-status-warning">${this.escape(status)}</span>
                    <h1 id="partners-title" tabindex="-1">${this.escape(title)}</h1>
                    <p>${this.escape(copy)}</p>
                    <dl class="partners-checklist">
                        <div><dt data-i18n="ui_web_4eca0498bdf0">Partner account</dt><dd>${this.escape(account)}</dd></div>
                        <div><dt data-i18n="ui_web_999f23fcd7be">Identity</dt><dd>${this.escape(verification)}</dd></div>
                        <div><dt data-i18n="ui_web_ede548996483">Terms</dt><dd>${this.escape(contract)}</dd></div>
                    </dl>
                    <button class="btn btn-secondary partners-primary-action" type="button" disabled data-i18n="ui_web_7aa6caa00d2e">Secure next step unavailable</button>
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
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-dashboard-heading">
                    <div>
                        <span class="partners-status-pill partners-status-success" data-i18n="ui_web_cdbd5e52feff">Partner active</span>
                        <h1 id="partners-title" tabindex="-1" data-i18n="ui_web_93bfcdbf61f8">Your partner dashboard</h1>
                        <p data-i18n="ui_web_40376d1ae36a">Your link, referrals and commission history come from Norva's authoritative append-only partner ledger.</p>
                    </div>
                    <div class="partners-dashboard-actions">
                        <button class="btn btn-secondary" type="button" disabled
                            data-partners-payout-button data-i18n="ui_web_c335485b472d">Checking payout setup…</button>
                        <button class="btn btn-secondary" type="button" data-partners-dashboard-retry data-i18n="ui_web_0e9161011702">Refresh</button>
                    </div>
                </section>
                <section class="partners-metrics" aria-label="Partner metrics" data-partners-dashboard-metrics aria-busy="true" data-i18n-aria-label="ui_web_4c95755fc03d">
                    ${this.metric((globalThis.NorvaI18n?.t("ui_web_3743e7e1974e", { defaultValue: "Available payout" }) ?? 'Available payout'), (globalThis.NorvaI18n?.t("ui_web_dc380888c4e2", { defaultValue: "Loading" }) ?? 'Loading'), (globalThis.NorvaI18n?.t("ui_web_aa4b0b75a40a", { defaultValue: "Secure reporting" }) ?? 'Secure reporting'))}
                    ${this.metric((globalThis.NorvaI18n?.t("ui_web_6d2d474ca6dc", { defaultValue: "In validation" }) ?? 'In validation'), (globalThis.NorvaI18n?.t("ui_web_dc380888c4e2", { defaultValue: "Loading" }) ?? 'Loading'), (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_e433dc398c1c", {defaultValue: "{{p0}}-day validation window", p0:(data.program.maturation_days)}) : `${data.program.maturation_days}-day validation window`))}
                    ${this.metric((globalThis.NorvaI18n?.t("ui_web_888a5408941e", { defaultValue: "Paid to date" }) ?? 'Paid to date'), (globalThis.NorvaI18n?.t("ui_web_dc380888c4e2", { defaultValue: "Loading" }) ?? 'Loading'), (globalThis.NorvaI18n?.t("ui_web_aa4b0b75a40a", { defaultValue: "Secure reporting" }) ?? 'Secure reporting'))}
                    ${this.metric((globalThis.NorvaI18n?.t("ui_web_a28517e6da96", { defaultValue: "Attributed referrals" }) ?? 'Attributed referrals'), (globalThis.NorvaI18n?.t("ui_web_dc380888c4e2", { defaultValue: "Loading" }) ?? 'Loading'), (globalThis.NorvaI18n?.t("ui_web_782ab3fd1523", { defaultValue: "Pseudonymised total" }) ?? 'Pseudonymised total'))}
                </section>
                <section data-partners-dashboard-content aria-busy="true">
                    <div class="partners-skeleton partners-skeleton-hero" aria-hidden="true"></div>
                </section>
                <div class="partners-form-status" data-partners-action-status role="status" aria-live="polite" aria-atomic="true"></div>
                ${this.liveRegion((globalThis.NorvaI18n?.t("ui_web_97f8fb72c9ae", { defaultValue: "Norva Partners account is active. Loading the secure dashboard." }) ?? 'Norva Partners account is active. Loading the secure dashboard.'))}
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
                this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_8cf7be0db856", { defaultValue: "Confirm both individual programme statements first." }) ?? 'Confirm both individual programme statements first.'), 'error');
                (!individual.checked ? individual : terms).focus();
                return;
            }
            await this.runPartnerAction(button, (globalThis.NorvaI18n?.t("ui_web_72193730c797", { defaultValue: "Applying securely…" }) ?? 'Applying securely…'), async () => {
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
                this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_5e6f9e5594d4", { defaultValue: "Application submitted. Loading the authoritative account state." }) ?? 'Application submitted. Loading the authoritative account state.'));
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
                (globalThis.NorvaI18n?.t("ui_web_37cc5a0e3a92", { defaultValue: "Accepting securely…" }) ?? 'Accepting securely…'),
                async () => {
                    await window.NorvaCloud.partners.acceptTerms({
                        termsVersion: data.policy.terms_version,
                        disclosureVersion: data.policy.disclosure_version,
                        idempotencyKey: this.actionKey('terms')
                    });
                    this.clearActionKey('terms');
                    this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_8189e988de88", { defaultValue: "Terms accepted. Loading the authoritative verification state." }) ?? 'Terms accepted. Loading the authoritative verification state.'));
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
                    this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_d5e7eb201b16", { defaultValue: "Confirm both verification statements before continuing." }) ?? 'Confirm both verification statements before continuing.'), 'error');
                    (!consent.checked ? consent : capacity).focus();
                    return;
                }
                await this.runPartnerAction(kycButton, (globalThis.NorvaI18n?.t("ui_web_395cb39e5e2b", { defaultValue: "Opening secure verification…" }) ?? 'Opening secure verification…'), async () => {
                    const envelope = await window.NorvaCloud.partners.startKyc({
                        language: this.partnerLanguage(),
                        consentVersion: data.policy.disclosure_version,
                        biometricConsentVersion: PartnersPage.BIOMETRIC_CONSENT_VERSION,
                        capacityConfirmed: true,
                        idempotencyKey: this.actionKey('kyc-session')
                    });
                    this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_e7a6fdb302fa", { defaultValue: "Secure verification ready. Opening Didit." }) ?? 'Secure verification ready. Opening Didit.'));
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
                (globalThis.NorvaI18n?.t("ui_web_206c06bb8d2a", { defaultValue: "Checking securely…" }) ?? 'Checking securely…'),
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
            target.innerHTML = `<span class="partners-eyebrow" data-i18n="ui_web_a7c08d6c1a75">Privacy and verification</span>
                <h2 id="partners-kyc-rights-title" data-i18n="ui_web_84e2cd1e73ad">Checking your verification rights...</h2>
                <p data-i18n="ui_web_ce943ed0af0b">No identity document or provider payload is loaded on this page.</p>`;
            return;
        }
        target.removeAttribute('aria-busy');
        if (!data) {
            target.innerHTML = `<span class="partners-eyebrow" data-i18n="ui_web_a7c08d6c1a75">Privacy and verification</span>
                <h2 id="partners-kyc-rights-title" data-i18n="ui_web_6a4a5d1fbaff">Verification controls unavailable</h2>
                <p role="${state === 'error' ? 'alert' : 'status'}">${this.escape(timedOut
                    ? (globalThis.NorvaI18n?.t("ui_web_7ae39caa1afd", { defaultValue: "The secure rights check took too long. No privacy action was inferred or submitted." }) ?? 'The secure rights check took too long. No privacy action was inferred or submitted.')
                    : (globalThis.NorvaI18n?.t("ui_web_b12bc4cb47fd", { defaultValue: "Norva could not load the authoritative privacy controls. No action was taken." }) ?? 'Norva could not load the authoritative privacy controls. No action was taken.'))}</p>
                <button class="btn btn-secondary" type="button" data-partners-kyc-rights-retry data-i18n="ui_web_fdb4d8047416">Retry securely</button>`;
            target.querySelector('[data-partners-kyc-rights-retry]')
                ?.addEventListener('click', () => this.loadKycRights({ focus: '#partners-kyc-rights-title' }));
            return;
        }

        const consentLabels = {
            not_available: (globalThis.NorvaI18n?.t("ui_web_67a926f7008e", { defaultValue: "Not available" }) ?? 'Not available'),
            not_granted: (globalThis.NorvaI18n?.t("ui_web_352a5b4c1246", { defaultValue: "Not granted" }) ?? 'Not granted'),
            granted: (globalThis.NorvaI18n?.t("ui_web_0356d514c29c", { defaultValue: "Granted for the recorded check" }) ?? 'Granted for the recorded check'),
            withdrawn: (globalThis.NorvaI18n?.t("ui_web_316e62f08ac3", { defaultValue: "Withdrawn for any new check" }) ?? 'Withdrawn for any new check')
        };
        const reviewLabels = {
            requested: (globalThis.NorvaI18n?.t("ui_web_744f70280816", { defaultValue: "Review requested" }) ?? 'Review requested'),
            in_review: (globalThis.NorvaI18n?.t("ui_web_7abbd09ffc3d", { defaultValue: "Human review in progress" }) ?? 'Human review in progress'),
            resolved: (globalThis.NorvaI18n?.t("ui_web_95145234f8f7", { defaultValue: "Human review completed" }) ?? 'Human review completed')
        };
        const resolutionLabels = {
            original_decision_upheld: (globalThis.NorvaI18n?.t("ui_web_922a0f39688a", { defaultValue: "The original decision was upheld" }) ?? 'The original decision was upheld'),
            reverification_available: (globalThis.NorvaI18n?.t("ui_web_c11bbab23682", { defaultValue: "A fresh verification is available" }) ?? 'A fresh verification is available')
        };
        const reasonOptions = [
            ['identity_result_contested', (globalThis.NorvaI18n?.t("ui_web_394f2d470ba9", { defaultValue: "My identity result is incorrect" }) ?? 'My identity result is incorrect')],
            ['age_result_contested', (globalThis.NorvaI18n?.t("ui_web_d0ee91207c91", { defaultValue: "My age result is incorrect" }) ?? 'My age result is incorrect')],
            ['country_result_contested', (globalThis.NorvaI18n?.t("ui_web_262d7b452671", { defaultValue: "My country result is incorrect" }) ?? 'My country result is incorrect')],
            ['verification_unavailable', (globalThis.NorvaI18n?.t("ui_web_d7947206556c", { defaultValue: "I could not complete verification" }) ?? 'I could not complete verification')],
            ['other_result_contested', (globalThis.NorvaI18n?.t("ui_web_aeadb37482a9", { defaultValue: "Another verification result is incorrect" }) ?? 'Another verification result is incorrect')]
        ];
        const review = data.review;
        const reviewSummary = review.exists
            ? `<div class="partners-setup-value">
                <span>${this.escape(reviewLabels[review.status] || (globalThis.NorvaI18n?.t("ui_web_c1f43b8fad75", { defaultValue: "Human review" }) ?? 'Human review'))}</span>
                <strong>${this.escape(resolutionLabels[review.resolution] || this.formatDateTime(review.requested_at))}</strong>
               </div>`
            : '<p data-i18n="ui_web_f3e63e20ec47">No human-review request is currently open.</p>';
        const reviewForm = data.actions.can_request_human_review
            ? `<form class="partners-join-form" data-partners-kyc-review-form novalidate>
                <label for="partners-kyc-review-reason" data-i18n="ui_web_54d532553e53">What should a person review?</label>
                <select id="partners-kyc-review-reason" data-partners-kyc-review-reason>
                    ${reasonOptions.map(([value, label]) => `<option value="${this.escape(value)}">${this.escape(label)}</option>`).join('')}
                </select>
                <button class="btn btn-secondary" type="submit" data-partners-kyc-review-submit data-i18n="ui_web_0c53f511c8d3">Request human review</button>
               </form>`
            : '';
        const withdrawAction = data.actions.can_withdraw
            ? `<button class="btn btn-secondary" type="button" data-partners-kyc-withdraw data-i18n="ui_web_27682bf3d0dd">Withdraw consent for any new biometric check</button>`
            : '';
        target.innerHTML = `<span class="partners-eyebrow" data-i18n="ui_web_a7c08d6c1a75">Privacy and verification</span>
            <h2 id="partners-kyc-rights-title" tabindex="-1" data-i18n="ui_web_f74fe9299c10">Your identity-verification controls</h2>
            <div class="partners-setup-value">
                <span data-i18n="ui_web_c1ce51f9b555">Biometric consent</span>
                <strong>${this.escape(consentLabels[data.consent.status] || data.consent.status)}</strong>
            </div>
            ${reviewSummary}
            <p data-i18n="ui_web_b8acc4c0dde2">Norva uses Didit's hosted check and receives the result needed to apply the programme rules. You can contest an unsuccessful result and request a person to review it. Do not send identity documents through Support.</p>
            ${reviewForm}
            ${withdrawAction}
            <p class="partners-action-note"><norva-i18n data-i18n="ui_web_60dbc98a4a1b">Withdrawal prevents a new biometric check. It does not erase an already completed verification or override legal retention duties. See the </norva-i18n><a href="/privacy.html#partners" target="_blank" rel="noopener" data-i18n="ui_web_840b0e9da5da">Privacy Notice</a>.</p>
            <div class="partners-form-status" data-partners-kyc-rights-status role="status" aria-live="polite" aria-atomic="true"></div>`;

        target.querySelector('[data-partners-kyc-withdraw]')
            ?.addEventListener('click', async (event) => {
                const confirmed = typeof window.NorvaModal?.confirm === 'function'
                    ? await window.NorvaModal.confirm(
                        (globalThis.NorvaI18n?.t("ui_web_f30262e89b35", { defaultValue: "This blocks every new biometric verification. Existing verification records remain subject to the Privacy Notice and applicable retention duties." }) ?? 'This blocks every new biometric verification. Existing verification records remain subject to the Privacy Notice and applicable retention duties.'),
                        {
                            title: (globalThis.NorvaI18n?.t("ui_web_829731c82213", { defaultValue: "Withdraw biometric consent?" }) ?? 'Withdraw biometric consent?'),
                            confirmLabel: (globalThis.NorvaI18n?.t("ui_web_5a1872c1184f", { defaultValue: "Withdraw consent" }) ?? 'Withdraw consent'),
                            cancelLabel: (globalThis.NorvaI18n?.t("ui_web_ce492352a1ee", { defaultValue: "Keep consent" }) ?? 'Keep consent'),
                            danger: true
                        }
                    )
                    : false;
                if (!confirmed) return;
                await this.runKycRightsAction(
                    event.currentTarget,
                    (globalThis.NorvaI18n?.t("ui_web_90c15b65229f", { defaultValue: "Withdrawing securely..." }) ?? 'Withdrawing securely...'),
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
                    (globalThis.NorvaI18n?.t("ui_web_09e3fad17544", { defaultValue: "Submitting securely..." }) ?? 'Submitting securely...'),
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
            if (note) note.textContent = (globalThis.NorvaI18n?.t("ui_web_5400653c3bf1", { defaultValue: "Biometric consent was withdrawn. A new hosted verification cannot be started." }) ?? 'Biometric consent was withdrawn. A new hosted verification cannot be started.');
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
            window.NorvaModal?.toast?.((globalThis.NorvaI18n?.t("ui_web_ba96620a6f46", { defaultValue: "Your verification controls were updated." }) ?? 'Your verification controls were updated.'), 'success');
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
            request_in_progress: (globalThis.NorvaI18n?.t("ui_web_f56c269b0f74", { defaultValue: "This secure action is still processing. Wait a moment, then retry." }) ?? 'This secure action is still processing. Wait a moment, then retry.'),
            idempotency_key_reused: (globalThis.NorvaI18n?.t("ui_web_7bfcee01ae54", { defaultValue: "This action could not be replayed safely. Refresh the page before trying again." }) ?? 'This action could not be replayed safely. Refresh the page before trying again.'),
            business_accounts_not_supported: (globalThis.NorvaI18n?.t("ui_web_a124dfc0ab7c", { defaultValue: "Norva Partners currently supports individual accounts only." }) ?? 'Norva Partners currently supports individual accounts only.'),
            kyc_billing_unavailable: (globalThis.NorvaI18n?.t("ui_web_74594628d6d9", { defaultValue: "Identity verification is temporarily unavailable. No charge or account change was made." }) ?? 'Identity verification is temporarily unavailable. No charge or account change was made.'),
            provider_not_configured: (globalThis.NorvaI18n?.t("ui_web_9e9c26ce89ee", { defaultValue: "Identity verification is not configured yet. No account change was made." }) ?? 'Identity verification is not configured yet. No account change was made.'),
            provider_temporarily_unavailable: (globalThis.NorvaI18n?.t("ui_web_1423f9c65c8a", { defaultValue: "The identity provider is temporarily unavailable. Retry without creating another account." }) ?? 'The identity provider is temporarily unavailable. Retry without creating another account.'),
            biometric_consent_withdrawn: (globalThis.NorvaI18n?.t("ui_web_ca869e35b893", { defaultValue: "Verification was cancelled because biometric consent was withdrawn. No Didit link was opened." }) ?? 'Verification was cancelled because biometric consent was withdrawn. No Didit link was opened.'),
            rate_limited: (globalThis.NorvaI18n?.t("ui_web_f337c608c9f8", { defaultValue: "Too many secure attempts were received. Wait a moment before retrying." }) ?? 'Too many secure attempts were received. Wait a moment before retrying.'),
            partners_access_request_contract_invalid: (globalThis.NorvaI18n?.t("ui_web_4bdc6925ad84", { defaultValue: "Norva could not verify the request status securely. No action was accepted." }) ?? 'Norva could not verify the request status securely. No action was accepted.'),
            partners_access_request_disabled: (globalThis.NorvaI18n?.t("ui_web_1765a8ca485a", { defaultValue: "Early-access requests are temporarily closed. No request was created." }) ?? 'Early-access requests are temporarily closed. No request was created.'),
            partners_access_requests_disabled: (globalThis.NorvaI18n?.t("ui_web_1765a8ca485a", { defaultValue: "Early-access requests are temporarily closed. No request was created." }) ?? 'Early-access requests are temporarily closed. No request was created.'),
            partners_action_not_allowed: (globalThis.NorvaI18n?.t("ui_web_b0b43cda275e", { defaultValue: "This action is not available for the current verified account state." }) ?? 'This action is not available for the current verified account state.'),
            partners_membership_join_unavailable: (globalThis.NorvaI18n?.t("ui_web_8a870edad63c", { defaultValue: "Joining is temporarily unavailable. No membership or link was created." }) ?? 'Joining is temporarily unavailable. No membership or link was created.'),
            partners_credit_unavailable: (globalThis.NorvaI18n?.t("ui_web_bb77e8b865b3", { defaultValue: "Norva access conversion is temporarily unavailable. Your balance is unchanged." }) ?? 'Norva access conversion is temporarily unavailable. Your balance is unchanged.'),
            partners_credit_months_invalid: (globalThis.NorvaI18n?.t("ui_web_d9da4002c03e", { defaultValue: "Choose a valid Norva access duration." }) ?? 'Choose a valid Norva access duration.'),
            partners_credit_quote_invalid: (globalThis.NorvaI18n?.t("ui_web_41acf44a6b98", { defaultValue: "This conversion quote is no longer valid. Create a new quote." }) ?? 'This conversion quote is no longer valid. Create a new quote.'),
            membership_required: (globalThis.NorvaI18n?.t("ui_web_c6e8df6d4713", { defaultValue: "Join Norva Partners before converting an available balance." }) ?? 'Join Norva Partners before converting an available balance.'),
            credits_disabled: (globalThis.NorvaI18n?.t("ui_web_98a55690ad44", { defaultValue: "Norva access conversion is temporarily paused. Your balance is unchanged." }) ?? 'Norva access conversion is temporarily paused. Your balance is unchanged.'),
            quote_expired: (globalThis.NorvaI18n?.t("ui_web_db06759e1b0e", { defaultValue: "This quote expired. Close this review and create a fresh quote." }) ?? 'This quote expired. Close this review and create a fresh quote.'),
            insufficient_balance: (globalThis.NorvaI18n?.t("ui_web_4168c29d2e4a", { defaultValue: "Your available balance changed and is now too low. Close this review and refresh your balance." }) ?? 'Your available balance changed and is now too low. Close this review and refresh your balance.'),
            catalog_unavailable: (globalThis.NorvaI18n?.t("ui_web_c999bc728f07", { defaultValue: "The authoritative Norva access catalogue is temporarily unavailable." }) ?? 'The authoritative Norva access catalogue is temporarily unavailable.'),
            fx_rate_unavailable: (globalThis.NorvaI18n?.t("ui_web_70d397efbd42", { defaultValue: "A current verified exchange rate is unavailable for this balance. Your money remains unchanged; refresh after Finance publishes a new rate." }) ?? 'A current verified exchange rate is unavailable for this balance. Your money remains unchanged; refresh after Finance publishes a new rate.'),
            quote_conflict: (globalThis.NorvaI18n?.t("ui_web_dc46ef1b038a", { defaultValue: "This quote has already been used or replaced. Close this review and refresh your balance." }) ?? 'This quote has already been used or replaced. Close this review and refresh your balance.'),
            partners_kyc_consent_invalid: (globalThis.NorvaI18n?.t("ui_web_7ceabcd08136", { defaultValue: "Review and confirm the current verification statements before continuing." }) ?? 'Review and confirm the current verification statements before continuing.'),
            partners_kyc_review_reason_invalid: (globalThis.NorvaI18n?.t("ui_web_8215ffded069", { defaultValue: "Choose what the human reviewer should check before submitting." }) ?? 'Choose what the human reviewer should check before submitting.'),
            partners_payout_country_invalid: (globalThis.NorvaI18n?.t("ui_web_c4dad278560f", { defaultValue: "Choose a valid payout country before continuing." }) ?? 'Choose a valid payout country before continuing.'),
            payout_country_required: (globalThis.NorvaI18n?.t("ui_web_ca548d77ed3e", { defaultValue: "Choose your payout country before configuring a cash transfer." }) ?? 'Choose your payout country before configuring a cash transfer.'),
            cash_pilot_not_allowed: (globalThis.NorvaI18n?.t("ui_web_75920b2d5cde", { defaultValue: "The supervised cash-transfer pilot is not open for this account yet. Membership, sharing, earnings and Norva-access conversion remain available." }) ?? 'The supervised cash-transfer pilot is not open for this account yet. Membership, sharing, earnings and Norva-access conversion remain available.'),
            payout_country_unavailable: (globalThis.NorvaI18n?.t("ui_web_c0363d14be49", { defaultValue: "Cash transfers are not available for this country yet. Your referral link, balance and Norva-access conversions continue to work." }) ?? 'Cash transfers are not available for this country yet. Your referral link, balance and Norva-access conversions continue to work.'),
            partners_fiscal_declaration_invalid: (globalThis.NorvaI18n?.t("ui_web_e12b2ee578af", { defaultValue: "Review and confirm the current tax-residence statement before continuing." }) ?? 'Review and confirm the current tax-residence statement before continuing.'),
            partners_fiscal_country_mismatch: (globalThis.NorvaI18n?.t("ui_web_25ed1f69a501", { defaultValue: "Your tax-residence country must match the authoritative country on your Norva account." }) ?? 'Your tax-residence country must match the authoritative country on your Norva account.'),
            partners_payout_onboarding_invalid: (globalThis.NorvaI18n?.t("ui_web_a86c23ab6511", { defaultValue: "Choose an available payout currency and confirm secure account contact." }) ?? 'Choose an available payout currency and confirm secure account contact.'),
            partners_payout_currency_unavailable: (globalThis.NorvaI18n?.t("ui_web_bcf0775bac46", { defaultValue: "This payout currency is not available for your current account policy." }) ?? 'This payout currency is not available for your current account policy.'),
            partners_request_timeout: (globalThis.NorvaI18n?.t("ui_web_485d5aa6fbfe", { defaultValue: "Norva did not confirm this secure action in time. Its state is unknown, so retrying will resume the same idempotent request." }) ?? 'Norva did not confirm this secure action in time. Its state is unknown, so retrying will resume the same idempotent request.'),
            partners_copy_unavailable: (globalThis.NorvaI18n?.t("ui_web_be15251e87da", { defaultValue: "Copying is unavailable in this browser. No referral message was copied." }) ?? 'Copying is unavailable in this browser. No referral message was copied.'),
            fiscal_profile_required: (globalThis.NorvaI18n?.t("ui_web_f0079e5b521a", { defaultValue: "The tax-residence review must be completed before payout setup can begin." }) ?? 'The tax-residence review must be completed before payout setup can begin.'),
            authentication_required: (globalThis.NorvaI18n?.t("ui_web_0789faab92bb", { defaultValue: "Sign in again to continue securely." }) ?? 'Sign in again to continue securely.'),
            invalid_access_token: (globalThis.NorvaI18n?.t("ui_web_e8381bda10b6", { defaultValue: "Your session expired. Sign in again to continue." }) ?? 'Your session expired. Sign in again to continue.'),
            partners_user_session_required: (globalThis.NorvaI18n?.t("ui_web_8850cc9752bb", { defaultValue: "Open Norva Partners from a signed-in cloud account." }) ?? 'Open Norva Partners from a signed-in cloud account.')
        };
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            return (globalThis.NorvaI18n?.t("ui_web_95d0aea7668f", { defaultValue: "You are offline. Reconnect and retry; the same secure action will be resumed." }) ?? 'You are offline. Reconnect and retry; the same secure action will be resumed.');
        }
        return messages[error?.code]
            || (globalThis.NorvaI18n?.t("ui_web_fdf529baba96", { defaultValue: "Norva could not complete this action securely. No unverified state was accepted." }) ?? 'Norva could not complete this action securely. No unverified state was accepted.');
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
            account_not_active: (globalThis.NorvaI18n?.t("ui_web_ca98f88266dc", { defaultValue: "Partner account activation is required." }) ?? 'Partner account activation is required.'),
            kyc_not_verified: (globalThis.NorvaI18n?.t("ui_web_5286d93099cf", { defaultValue: "Identity verification is required." }) ?? 'Identity verification is required.'),
            payout_country_required: (globalThis.NorvaI18n?.t("ui_web_102502b63906", { defaultValue: "Choose your payout country before cash-transfer setup." }) ?? 'Choose your payout country before cash-transfer setup.'),
            fiscal_profile_required: (globalThis.NorvaI18n?.t("ui_web_8e273c21b7bc", { defaultValue: "A verified individual fiscal profile is required." }) ?? 'A verified individual fiscal profile is required.'),
            provider_not_configured: (globalThis.NorvaI18n?.t("ui_web_73a6afe4bd75", { defaultValue: "No individual payout provider is configured for this policy." }) ?? 'No individual payout provider is configured for this policy.'),
            payouts_not_live: (globalThis.NorvaI18n?.t("ui_web_4b3ae3e73b36", { defaultValue: "The payout release gate is not live." }) ?? 'The payout release gate is not live.')
        };
        if (state === 'loading') {
            if (button) {
                button.disabled = true;
                button.textContent = (globalThis.NorvaI18n?.t("ui_web_c335485b472d", { defaultValue: "Checking payout setup…" }) ?? 'Checking payout setup…');
                button.removeAttribute('title');
            }
            if (target) target.innerHTML = `<strong data-i18n="ui_web_dd7265845dc6">Checking payout readiness…</strong>
                <span data-i18n="ui_web_2da528b10ca4">No financial identifier is loaded while the authoritative status is checked.</span>`;
            return;
        }
        if (!data) {
            if (button) {
                button.disabled = state === 'unavailable';
                button.textContent = state === 'error' ? (globalThis.NorvaI18n?.t("ui_web_3d790d752c00", { defaultValue: "Retry payout status" }) ?? 'Retry payout status') : (globalThis.NorvaI18n?.t("ui_web_611f593503b5", { defaultValue: "Payout status unavailable" }) ?? 'Payout status unavailable');
                button.title = state === 'error'
                    ? (globalThis.NorvaI18n?.t("ui_web_e08c5b3113ce", { defaultValue: "Retry the secure payout-profile request" }) ?? 'Retry the secure payout-profile request')
                    : (globalThis.NorvaI18n?.t("ui_web_c5ea834e8049", { defaultValue: "The secure payout-profile service is unavailable" }) ?? 'The secure payout-profile service is unavailable');
            }
            if (target) target.innerHTML = `<strong data-i18n="ui_web_4cd50555ea0b">Payout readiness unavailable</strong>
                <span>${timedOut
                    ? (globalThis.NorvaI18n?.t("ui_web_6eaf2fcb1e0c", { defaultValue: "The secure status check took too long. Retry without entering any financial identifier." }) ?? 'The secure status check took too long. Retry without entering any financial identifier.')
                    : (globalThis.NorvaI18n?.t("ui_web_178eba56f0bc", { defaultValue: "No payout state or zero balance is inferred while the authoritative service is unavailable." }) ?? 'No payout state or zero balance is inferred while the authoritative service is unavailable.')}</span>`;
            return;
        }
        const profile = data.profile;
        const profiles = Array.isArray(data.profiles) ? data.profiles : [];
        const fiscal = data.fiscal;
        const reason = data.readiness.reason;
        const title = data.readiness.ready
            ? (globalThis.NorvaI18n?.t("ui_web_18d360243119", { defaultValue: "Ready for the next supervised payout cycle" }) ?? 'Ready for the next supervised payout cycle')
            : (reasonCopy[reason] || (globalThis.NorvaI18n?.t("ui_web_efeb1d456ecb", { defaultValue: "Payout setup is not ready." }) ?? 'Payout setup is not ready.'));
        if (button) {
            button.disabled = false;
            button.textContent = profiles.length > 1
                ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_bf987c4dafe5", {defaultValue: "{{p0}} payout destinations", p0:(profiles.length)}) : `${profiles.length} payout destinations`)
                : profile
                    ? `${this.payoutProviderLabel(profile.provider)} · ${profile.display_masked}`
                    : (globalThis.NorvaI18n?.t("ui_web_4769e56d01f7", { defaultValue: "Review payout setup" }) ?? 'Review payout setup');
            button.title = title;
        }
        if (!target) return;
        const destinations = profiles.length
            ? profiles.map((destination) => `
                <span>${this.escape(destination.currency)} · ${this.escape(this.payoutProviderLabel(destination.provider))} · ${this.escape(destination.display_masked)} · ${this.escape(destination.status)}</span>`
            ).join('')
            : '<span data-i18n="ui_web_1c3d89b473e3">No payout destination has been tokenised.</span>';
        target.innerHTML = `
            <strong>${this.escape(title)}</strong>
            ${destinations}
            <span data-i18n="ui_web_a3e1b8af6a11" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p2":(this.escape(fiscal?.status || 'missing')),"p3":(fiscal?.country_code ? ` · ${this.escape(fiscal.country_code)}` : '')}) || "{}")}">Fiscal profile: ${this.escape(fiscal?.status || 'missing')}${fiscal?.country_code ? ` · ${this.escape(fiscal.country_code)}` : ''}</span>
            <span data-i18n="ui_web_8eab115e0a69">Norva covers transfer fees on supported payout routes; they are not deducted from your commission.</span>
            <span>${data.readiness.payouts_live
                ? (globalThis.NorvaI18n?.t("ui_web_e13a5a2235e7", { defaultValue: "Live payout gate enabled." }) ?? 'Live payout gate enabled.')
                : (globalThis.NorvaI18n?.t("ui_web_a07296e6d653", { defaultValue: "Live payouts remain disabled. No bank, card or tax identifier is collected on this page." }) ?? 'Live payouts remain disabled. No bank, card or tax identifier is collected on this page.')}</span>`;
    }

    payoutProviderLabel(provider) {
        return ({
            wise: (globalThis.NorvaI18n?.t("ui_web_e3fcf621116d", { defaultValue: "Wise" }) ?? 'Wise'),
            revolut: (globalThis.NorvaI18n?.t("ui_web_dd53271a2e06", { defaultValue: "Revolut" }) ?? 'Revolut'),
            stripe_connect: (globalThis.NorvaI18n?.t("ui_web_70030017dac8", { defaultValue: "Stripe Connect" }) ?? 'Stripe Connect')
        })[provider] || (globalThis.NorvaI18n?.t("ui_web_de0629b9e35a", { defaultValue: "Payout provider" }) ?? 'Payout provider');
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
        successMessage = (globalThis.NorvaI18n?.t("ui_web_baa8609f1cb4", { defaultValue: "Partner dashboard updated." }) ?? 'Partner dashboard updated.')
    } = {}) {
        if (!this._visible) return;
        clearTimeout(this._dashboardRefreshTimer);
        this._dashboardRefreshTimer = 0;
        if (typeof window.NorvaCloud?.partners?.dashboard !== 'function') {
            this.renderDashboardFailure(bootstrap, { unavailable: true });
            this.setActionStatus(
                (globalThis.NorvaI18n?.t("ui_web_cebf91839444", { defaultValue: "The secure partner dashboard is unavailable. No financial or referral value was inferred." }) ?? 'The secure partner dashboard is unavailable. No financial or referral value was inferred.'),
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
        this.setActionStatus(append ? (globalThis.NorvaI18n?.t("ui_web_6295f71f7df4", { defaultValue: "Loading more partner history…" }) ?? 'Loading more partner history…') : (globalThis.NorvaI18n?.t("ui_web_7c6407a1ffb8", { defaultValue: "Refreshing the secure partner dashboard…" }) ?? 'Refreshing the secure partner dashboard…'));
        try {
            const envelope = await window.NorvaCloud.partners.dashboard({
                limit: 25,
                status: this._dashboardFilter,
                cursor: append ? this._dashboardCursor : undefined,
                signal: controller.signal
            });
            if (!this._visible || controller.signal.aborted || this._dashboardAbort !== controller) return;
            const page = envelope.data;
            if (!append && page.schema_version === 2) {
                this.syncReferralState(page.referrals);
            }
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
                    this.metric((globalThis.NorvaI18n?.t("ui_web_f859a9cae3f5", { defaultValue: "Available to use" }) ?? 'Available to use'), (globalThis.NorvaI18n?.t("ui_web_ca1844969742", { defaultValue: "Unavailable" }) ?? 'Unavailable'), (globalThis.NorvaI18n?.t("ui_web_b6b4d52d507a", { defaultValue: "Secure reporting unavailable" }) ?? 'Secure reporting unavailable')),
                    this.metric((globalThis.NorvaI18n?.t("ui_web_6d2d474ca6dc", { defaultValue: "In validation" }) ?? 'In validation'), (globalThis.NorvaI18n?.t("ui_web_ca1844969742", { defaultValue: "Unavailable" }) ?? 'Unavailable'), (globalThis.NorvaI18n?.t("ui_web_b6b4d52d507a", { defaultValue: "Secure reporting unavailable" }) ?? 'Secure reporting unavailable')),
                    this.metric((globalThis.NorvaI18n?.t("ui_web_132cb8ad0df6", { defaultValue: "Converted to Norva" }) ?? 'Converted to Norva'), (globalThis.NorvaI18n?.t("ui_web_ca1844969742", { defaultValue: "Unavailable" }) ?? 'Unavailable'), (globalThis.NorvaI18n?.t("ui_web_b6b4d52d507a", { defaultValue: "Secure reporting unavailable" }) ?? 'Secure reporting unavailable')),
                    this.metric((globalThis.NorvaI18n?.t("ui_web_aa6a620d6348", { defaultValue: "Next balance update" }) ?? 'Next balance update'), (globalThis.NorvaI18n?.t("ui_web_ca1844969742", { defaultValue: "Unavailable" }) ?? 'Unavailable'), (globalThis.NorvaI18n?.t("ui_web_b6b4d52d507a", { defaultValue: "Secure reporting unavailable" }) ?? 'Secure reporting unavailable'))
                ]
                : [
                    this.metric((globalThis.NorvaI18n?.t("ui_web_3743e7e1974e", { defaultValue: "Available payout" }) ?? 'Available payout'), (globalThis.NorvaI18n?.t("ui_web_ca1844969742", { defaultValue: "Unavailable" }) ?? 'Unavailable'), (globalThis.NorvaI18n?.t("ui_web_b6b4d52d507a", { defaultValue: "Secure reporting unavailable" }) ?? 'Secure reporting unavailable')),
                    this.metric((globalThis.NorvaI18n?.t("ui_web_6d2d474ca6dc", { defaultValue: "In validation" }) ?? 'In validation'), (globalThis.NorvaI18n?.t("ui_web_ca1844969742", { defaultValue: "Unavailable" }) ?? 'Unavailable'), (globalThis.NorvaI18n?.t("ui_web_b6b4d52d507a", { defaultValue: "Secure reporting unavailable" }) ?? 'Secure reporting unavailable')),
                    this.metric((globalThis.NorvaI18n?.t("ui_web_888a5408941e", { defaultValue: "Paid to date" }) ?? 'Paid to date'), (globalThis.NorvaI18n?.t("ui_web_ca1844969742", { defaultValue: "Unavailable" }) ?? 'Unavailable'), (globalThis.NorvaI18n?.t("ui_web_b6b4d52d507a", { defaultValue: "Secure reporting unavailable" }) ?? 'Secure reporting unavailable')),
                    this.metric((globalThis.NorvaI18n?.t("ui_web_a28517e6da96", { defaultValue: "Attributed referrals" }) ?? 'Attributed referrals'), (globalThis.NorvaI18n?.t("ui_web_ca1844969742", { defaultValue: "Unavailable" }) ?? 'Unavailable'), (globalThis.NorvaI18n?.t("ui_web_b6b4d52d507a", { defaultValue: "Secure reporting unavailable" }) ?? 'Secure reporting unavailable'))
                ]).join('');
            metrics.removeAttribute?.('aria-busy');
        }
        if (!content) return;
        content.innerHTML = `<section class="partners-history-card">
            <div class="partners-empty-state" role="alert">
                <strong data-i18n="ui_web_87def595b640">Dashboard temporarily unavailable</strong>
                <span>${timedOut
                    ? (globalThis.NorvaI18n?.t("ui_web_2ef895a00346", { defaultValue: "The secure request took too long. Previously displayed values were cleared; no financial or referral value was guessed." }) ?? 'The secure request took too long. Previously displayed values were cleared; no financial or referral value was guessed.')
                    : (unavailable
                        ? (globalThis.NorvaI18n?.t("ui_web_37ed07bff5a5", { defaultValue: "This app version cannot reach the secure dashboard service. No financial or referral value was inferred." }) ?? 'This app version cannot reach the secure dashboard service. No financial or referral value was inferred.')
                        : (globalThis.NorvaI18n?.t("ui_web_5e4da07f09da", { defaultValue: "Previously displayed values were cleared. Retry the authoritative server request." }) ?? 'Previously displayed values were cleared. Retry the authoritative server request.'))}</span>
                ${unavailable
                    ? ''
                    : '<button class="btn btn-primary" type="button" data-partners-dashboard-inline-retry data-i18n="ui_web_d8b8392e2c54">Try again</button>'}
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
                this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_77ec849ef179", { defaultValue: "The authoritative programme rules are unavailable. Your balance was not inferred." }) ?? 'The authoritative programme rules are unavailable. Your balance was not inferred.'), 'error');
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
            ? (globalThis.NorvaI18n?.t("ui_web_8baf4e24ef5e", { defaultValue: "Authoritative commission ledger" }) ?? 'Authoritative commission ledger')
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
                (globalThis.NorvaI18n?.t("ui_web_3743e7e1974e", { defaultValue: "Available payout" }) ?? 'Available payout'),
                reportingValue('available_minor'),
                reportingHint
            ),
            this.metric(
                (globalThis.NorvaI18n?.t("ui_web_6d2d474ca6dc", { defaultValue: "In validation" }) ?? 'In validation'),
                reportingValue('pending_minor'),
                (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_e433dc398c1c", {defaultValue: "{{p0}}-day validation window", p0:(bootstrap.program.maturation_days)}) : `${bootstrap.program.maturation_days}-day validation window`)
            ),
            this.metric(
                (globalThis.NorvaI18n?.t("ui_web_888a5408941e", { defaultValue: "Paid to date" }) ?? 'Paid to date'),
                reportingValue('paid_minor'),
                reportingHint
            ),
            this.metric(
                (globalThis.NorvaI18n?.t("ui_web_a28517e6da96", { defaultValue: "Attributed referrals" }) ?? 'Attributed referrals'),
                String(reporting.referrals),
                (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_71dfcfc38fd1", {defaultValue: "{{p0}} eligible link visit{{p1}}", p0:(reporting.clicks),p1:(reporting.clicks === 1 ? '' : 's')}) : `${reporting.clicks} eligible link visit${reporting.clicks === 1 ? '' : 's'}`)
            )
        ].join('');

        const link = dashboard.link;
        const rate = this.percent(bootstrap.program.commission_rate_bps);
        const linkCard = link
            ? `<div class="partners-referral-card">
                <div class="partners-referral-main">
                    <span class="partners-eyebrow" data-i18n="ui_web_cb2e0faf91c8">Your personal referral link</span>
                    <h2 data-i18n="ui_web_ead9d3a48c42">Share Norva. Keep the disclosure attached.</h2>
                    <div class="partners-link-control">
                        <input type="text" readonly value="${this.escape(link.share_url)}"
                            aria-label="Your personal Norva referral link" data-partners-link data-i18n-aria-label="ui_web_35fa4075ed93">
                        <button class="btn btn-secondary" type="button" data-partners-copy data-i18n="ui_web_6ac9bf23f4ea">Copy share text</button>
                    </div>
                    <div class="partners-link-actions">
                        <button class="btn btn-primary" type="button" data-partners-share data-i18n="ui_web_712a4823ccb9">Share link</button>
                        <button class="btn btn-secondary" type="button" data-partners-qr data-i18n="ui_web_b694a5029e4f">Show QR</button>
                        <button class="btn btn-ghost" type="button" data-partners-rotate data-i18n="ui_web_09ea49586972">Rotate link</button>
                    </div>
                    <p class="partners-disclosure" data-partners-share-disclosure>${this.escape(this.shareDisclosure(bootstrap))}</p>
                </div>
                <div class="partners-rate-badge"><strong>${rate}</strong><span data-i18n="ui_web_c0c06e547b1b">Recurring</span></div>
              </div>`
            : `<div class="partners-referral-card">
                <div>
                    <span class="partners-eyebrow" data-i18n="ui_web_441c6d0e08c3">Referral link</span>
                    <h2 data-i18n="ui_web_efbb9084beeb">No active link was returned.</h2>
                    <p data-i18n="ui_web_0f0b3301b48a">Create a fresh opaque link from the authoritative server. No code is generated in this browser.</p>
                    <button class="btn btn-primary" type="button" data-partners-create-link data-i18n="ui_web_ab11737bb824">Create referral link</button>
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
                <strong data-i18n="ui_web_174bc8943760">No events in this view</strong>
                <span data-i18n="ui_web_648d67b9221f">No person, e-mail or account identifier is exposed in partner history.</span>
              </div>`;

        content.innerHTML = `
            <section class="partners-dashboard-grid">
                ${linkCard}
                <aside class="partners-program-card">
                    <h2 data-i18n="ui_web_fec836c49eef">Profile status</h2>
                    <dl class="partners-program-facts">
                        <div><dt data-i18n="ui_web_7e1b0d5641f2">Account</dt><dd>${this.escape(this.statusLabel(dashboard.account.status, (globalThis.NorvaI18n?.t("ui_web_4eca0498bdf0", { defaultValue: "Partner account" }) ?? 'Partner account')))}</dd></div>
                        <div><dt data-i18n="ui_web_999f23fcd7be">Identity</dt><dd>${this.escape(this.statusLabel(dashboard.account.verification_status, (globalThis.NorvaI18n?.t("ui_web_b207ae38ab70", { defaultValue: "Identity verification" }) ?? 'Identity verification')))}</dd></div>
                        <div><dt data-i18n="ui_web_ede548996483">Terms</dt><dd>${this.escape(this.statusLabel(dashboard.account.contract_status, (globalThis.NorvaI18n?.t("ui_web_9ca46294bc03", { defaultValue: "Programme terms" }) ?? 'Programme terms')))}</dd></div>
                        <div><dt data-i18n="ui_web_d69b9ac78e0f">Jurisdiction</dt><dd>${this.escape([dashboard.account.country_code, dashboard.account.subdivision_code].filter(Boolean).join(' · '))}</dd></div>
                        <div><dt data-i18n="ui_web_30f0702dd555">Reference payout threshold</dt><dd>${this.escape(this.referencePayoutThreshold(bootstrap.program))}</dd></div>
                        <div><dt data-i18n="ui_web_15a49a3afca5">Payouts</dt><dd>${bootstrap.flags.partners_payouts_live ? (globalThis.NorvaI18n?.t("ui_web_08cac8ba922c", { defaultValue: "Release gate enabled" }) ?? 'Release gate enabled') : (globalThis.NorvaI18n?.t("ui_web_2d2b572a55ff", { defaultValue: "Not live" }) ?? 'Not live')}</dd></div>
                    </dl>
                    ${this.payoutThresholdDisclosure(bootstrap.program, bootstrap.policy, 'dashboard')}
                    <div class="partners-payout-summary" data-partners-payout-summary role="status" aria-live="polite">
                        <strong data-i18n="ui_web_dd7265845dc6">Checking payout readiness…</strong>
                        <span data-i18n="ui_web_48f6e8a044c6">No financial identifier is loaded into this page.</span>
                    </div>
                    ${this.programWindowNote(bootstrap.program)}
                </aside>
            </section>
            <section class="partners-history-card" aria-labelledby="partners-history-title">
                <div class="partners-history-heading">
                    <div><h2 id="partners-history-title" tabindex="-1" data-i18n="ui_web_abcfb4966e26">Partner history</h2>
                    <p data-i18n="ui_web_83300a1db53e">Commission state changes are shown without customer identity, payment references or private amounts.</p></div>
                    <div class="partners-history-filters" role="group" aria-label="Filter partner history" data-i18n-aria-label="ui_web_9ee17db973d9">${filters}</div>
                </div>
                ${history}
                ${dashboard.history.next_cursor
                    ? '<button class="btn btn-secondary partners-load-more" type="button" data-partners-history-more data-i18n="ui_web_ac8991ef0101">Load more</button>'
                    : ''}
            </section>`;
        this.renderPayoutProfile(this._payoutProfile, { state: this._payoutLoadState });
        this.bindDashboardActions(bootstrap, dashboard);
    }

    syncReferralState(page) {
        this._referralsAvailable = page !== null;
        if (!this._referralsAvailable) {
            this._referralItems = [];
            this._referralTotal = 0;
            this._referralCursor = null;
            this._referralLoadState = 'unavailable';
            this._referralError = '';
            return;
        }
        const incoming = page && typeof page === 'object'
            ? page
            : { total: 0, items: [], next_cursor: null };
        const nextItems = Array.isArray(incoming.items) ? incoming.items : [];
        const nextTotal = Number.isSafeInteger(incoming.total) ? incoming.total : 0;
        if (nextTotal === 0) {
            this._referralItems = [];
            this._referralTotal = 0;
            this._referralCursor = null;
            this._referralLoadState = 'idle';
            this._referralError = '';
            return;
        }

        const hadExpandedList = this._referralItems.length > nextItems.length;
        const previousCursor = this._referralCursor;
        const incomingKeys = new Set(nextItems.map((item) => item.key));
        const retained = hadExpandedList
            ? this._referralItems.filter((item) => !incomingKeys.has(item.key))
            : [];
        this._referralItems = [...nextItems, ...retained]
            .sort((left, right) => right.label_number - left.label_number)
            .slice(0, nextTotal);
        this._referralTotal = nextTotal;
        this._referralCursor = this._referralItems.length >= nextTotal
            ? null
            : (hadExpandedList ? previousCursor : incoming.next_cursor);
        this._referralLoadState = 'idle';
        this._referralError = '';
    }

    referralRowsMarkup(program) {
        if (!this._referralsAvailable) {
            return `<div class="partners-empty-state partners-referrals-empty" role="status">
                <strong data-i18n="ui_web_da2c0ef37012">Referral tracking is temporarily unavailable</strong>
                <span data-i18n="ui_web_1d91af084dcd">Your personal link and verified balance remain available. The referral list will appear automatically after the secure server update.</span>
              </div>`;
        }
        if (!this._referralItems.length) {
            return `<div class="partners-empty-state partners-referrals-empty">
                <strong data-i18n="ui_web_dc634dfbcce2">No referrals yet</strong>
                <span data-i18n="ui_web_35dde2c97b81">Accounts created through your link will appear here after attribution is securely confirmed.</span>
              </div>`;
        }
        return `<ol class="partners-referrals-list">${this._referralItems.map((referral) => {
            const status = this.referralStatusMeta(
                referral,
                program.maturation_days
            );
            const recognitionHint = referral.masked_email
                ? `<span class="partners-referral-email">
                    <span class="partners-referral-email-label" data-i18n="ui_web_5387aafd44bf">Masked e-mail</span>
                    <span class="partners-referral-email-value">${this.escape(referral.masked_email)}</span>
                  </span>`
                : `<span class="partners-referral-email partners-referral-email-unavailable" data-i18n="ui_web_e661b3e4364d">
                    Recognition hint unavailable
                  </span>`;
            return `<li>
                <div class="partners-referral-identity">
                    <span class="partners-referral-number" aria-hidden="true">#${this.escape(String(referral.label_number))}</span>
                    <div>
                        <strong data-i18n="ui_web_460b39d96070" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p1":(this.escape(String(referral.label_number)))}) || "{}")}">Referral #${this.escape(String(referral.label_number))}</strong>
                        ${recognitionHint}
                        <span data-i18n="ui_web_535aade857af" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p3":(this.escape(this.formatDateTime(referral.attributed_at)))}) || "{}")}">Joined ${this.escape(this.formatDateTime(referral.attributed_at))}</span>
                    </div>
                </div>
                <div class="partners-referral-progress">
                    <span class="partners-status-pill ${this.escape(status.tone)}">${this.escape(status.label)}</span>
                    <span>${this.escape(status.detail)}</span>
                </div>
            </li>`;
        }).join('')}</ol>`;
    }

    referralControlsMarkup() {
        if (!this._referralsAvailable) {
            return '<p class="partners-referrals-footnote" data-i18n="ui_web_28b27d670bb2">No referral count or identity hint was inferred from an incomplete server response.</p>';
        }
        if (!this._referralTotal) {
            return '<p class="partners-referrals-footnote" data-i18n="ui_web_39e806d52887">A recognition hint appears only when Norva can safely mask the address. Full contact details and payment references are never shown.</p>';
        }
        const shown = this._referralItems.length;
        const remaining = Math.max(0, this._referralTotal - shown);
        const progress = `${shown} of ${this._referralTotal} referral${this._referralTotal === 1 ? '' : 's'} shown.`;
        if (this._referralLoadState === 'error') {
            return `<div class="partners-referrals-load-error" role="alert">
                <span>${this.escape(this._referralError || (globalThis.NorvaI18n?.t("ui_web_8478014ead98", { defaultValue: "The next referrals could not be loaded." }) ?? 'The next referrals could not be loaded.'))}</span>
                <button class="btn btn-secondary" type="button" data-partners-referrals-more data-i18n="ui_web_d8b8392e2c54">Try again</button>
              </div>
              <p class="partners-referrals-footnote" data-i18n="ui_web_69cedd67bfe2" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p1":(this.escape(progress))}) || "{}")}">${this.escape(progress)} Already displayed referrals remain available.</p>`;
        }
        if (this._referralCursor) {
            const nextCount = Math.min(20, remaining);
            const loading = this._referralLoadState === 'loading';
            return `<div class="partners-referrals-load-row">
                <p class="partners-referrals-footnote" data-partners-referrals-status
                    role="status" aria-live="polite">${this.escape(loading
                        ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_6064089e4783", {defaultValue: "Loading more referrals. {{p0}}", p0:(progress)}) : `Loading more referrals. ${progress}`)
                        : (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_d5502f1d7c55", {defaultValue: "{{p0}} Load the rest when you need it.", p0:(progress)}) : `${progress} Load the rest when you need it.`))}</p>
                <button class="btn btn-secondary partners-referrals-more" type="button"
                    data-partners-referrals-more ${loading ? 'disabled aria-busy="true"' : ''}>${loading
                        ? (globalThis.NorvaI18n?.t("ui_web_13494a4cc3ee", { defaultValue: "Loading referrals…" }) ?? 'Loading referrals…')
                        : (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_666a71800bb1", {defaultValue: "Show {{p0}} more", p0:(nextCount)}) : `Show ${nextCount} more`)}</button>
              </div>`;
        }
        return `<p class="partners-referrals-footnote" data-partners-referrals-status
            role="status" aria-live="polite" data-i18n="ui_web_2b9564386f7e" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(this.escape(String(this._referralTotal))),"p1":(this._referralTotal === 1 ? ' is' : 's are')}) || "{}")}">All ${this.escape(String(this._referralTotal))} referral${this._referralTotal === 1 ? ' is' : 's are'} shown. Masked e-mails are recognition hints only; Norva does not provide full addresses or a contact directory.</p>`;
    }

    referralsCardMarkup(program) {
        const countLabel = this._referralsAvailable
            ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_e1bd1b4760d5", {defaultValue: "{{p0}} referred account{{p1}}", p0:(this._referralTotal),p1:(this._referralTotal === 1 ? '' : 's')}) : `${this._referralTotal} referred account${this._referralTotal === 1 ? '' : 's'}`)
            : (globalThis.NorvaI18n?.t("ui_web_205c712f0342", { defaultValue: "Referral total temporarily unavailable" }) ?? 'Referral total temporarily unavailable');
        const countValue = this._referralsAvailable
            ? this.escape(String(this._referralTotal))
            : '&mdash;';
        const countCaption = this._referralsAvailable
            ? (this._referralTotal === 1 ? 'referral' : 'referrals')
            : 'updating';
        return `<section class="partners-history-card partners-referrals-card"
            aria-labelledby="partners-referrals-title" data-partners-referrals>
            <div class="partners-referrals-heading">
                <div>
                    <span class="partners-eyebrow" data-i18n="ui_web_087b1df2dea3">People who joined through your link</span>
                    <h2 id="partners-referrals-title" tabindex="-1" data-i18n="ui_web_da2ac4372977">Your referrals</h2>
                    <p data-i18n="ui_web_026bee2d196f">Follow every attributed account from sign-up to an eligible commission. A partially hidden e-mail helps you recognise someone you already know; the full address and account identifiers stay private.</p>
                </div>
                <strong class="partners-referrals-count" data-partners-referrals-count
                    aria-label="${this.escape(countLabel)}">
                    ${countValue}
                    <span>${countCaption}</span>
                </strong>
            </div>
            <div data-partners-referrals-body
                ${this._referralLoadState === 'loading' ? 'aria-busy="true"' : ''}>
                ${this.referralRowsMarkup(program)}
                ${this.referralControlsMarkup()}
            </div>
        </section>`;
    }

    updateReferralModule(program) {
        const body = this.container?.querySelector('[data-partners-referrals-body]');
        if (!body) return;
        body.innerHTML = `${this.referralRowsMarkup(program)}${this.referralControlsMarkup()}`;
        if (this._referralLoadState === 'loading') body.setAttribute('aria-busy', 'true');
        else body.removeAttribute('aria-busy');
        const count = this.container?.querySelector('[data-partners-referrals-count]');
        if (count) {
            count.setAttribute(
                'aria-label',
                (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_e1bd1b4760d5", {defaultValue: "{{p0}} referred account{{p1}}", p0:(this._referralTotal),p1:(this._referralTotal === 1 ? '' : 's')}) : `${this._referralTotal} referred account${this._referralTotal === 1 ? '' : 's'}`)
            );
            count.innerHTML = `${this.escape(String(this._referralTotal))}<span>${this._referralTotal === 1 ? 'referral' : 'referrals'}</span>`;
        }
        this.bindReferralActions(program);
    }

    bindReferralActions(program) {
        this.container?.querySelector('[data-partners-referrals-more]')
            ?.addEventListener('click', () => this.loadMoreReferrals(program));
    }

    async loadMoreReferrals(program) {
        if (!this._visible || !this._referralsAvailable || !this._referralCursor
            || this._referralLoadState === 'loading') return;
        const api = window.NorvaCloud?.partners?.referrals;
        if (typeof api !== 'function') {
            this._referralLoadState = 'error';
            this._referralError = (globalThis.NorvaI18n?.t("ui_web_a885426744c4", { defaultValue: "More referrals are temporarily unavailable. Try again." }) ?? 'More referrals are temporarily unavailable. Try again.');
            this.updateReferralModule(program);
            return;
        }
        const scroller = this.getScrollElement();
        const scrollTop = scroller?.scrollTop || 0;
        const cursor = this._referralCursor;
        const requestGeneration = ++this._referralRequestGeneration;
        this._referralAbort?.abort();
        const controller = new AbortController();
        this._referralAbort = controller;
        this._referralLoadState = 'loading';
        this._referralError = '';
        this.updateReferralModule(program);
        let timedOut = false;
        const timeout = setTimeout(() => {
            if (this._visible && this._referralAbort === controller) {
                timedOut = true;
                controller.abort();
            }
        }, this._dashboardTimeoutMs);
        try {
            const envelope = await api({ limit: 20, cursor, signal: controller.signal });
            if (!this._visible || controller.signal.aborted
                || requestGeneration !== this._referralRequestGeneration
                || this._referralAbort !== controller) return;
            const page = envelope.data;
            const keys = new Set(this._referralItems.map((item) => item.key));
            const numbers = new Set(this._referralItems.map((item) => item.label_number));
            const lastItem = this._referralItems[this._referralItems.length - 1];
            const lastNumber = lastItem?.label_number ?? Number.MAX_SAFE_INTEGER;
            if (page.total < this._referralItems.length
                || page.items.some((item, index) => (
                    keys.has(item.key)
                    || numbers.has(item.label_number)
                    || item.label_number >= (index === 0
                        ? lastNumber
                        : page.items[index - 1].label_number)
                ))) throw new Error('partners_referrals_page_conflict');
            this._referralItems = [...this._referralItems, ...page.items];
            this._referralTotal = page.total;
            this._referralCursor = page.next_cursor;
            this._referralLoadState = 'idle';
            this._referralError = '';
            this.updateReferralModule(program);
            requestAnimationFrame(() => {
                const focus = this.container?.querySelector('[data-partners-referrals-more]')
                    || this.container?.querySelector('[data-partners-referrals-status]');
                if (!focus?.hasAttribute?.('tabindex') && !focus?.matches?.('button')) {
                    focus?.setAttribute?.('tabindex', '-1');
                }
                try { focus?.focus({ preventScroll: true }); } catch (_) { focus?.focus?.(); }
                if (scroller) scroller.scrollTop = scrollTop;
            });
        } catch (error) {
            if (!this._visible || requestGeneration !== this._referralRequestGeneration
                || this._referralAbort !== controller) return;
            if ((error?.name === 'AbortError' || controller.signal.aborted) && !timedOut) return;
            this._referralLoadState = 'error';
            this._referralError = timedOut
                ? (globalThis.NorvaI18n?.t("ui_web_94aad7556e2f", { defaultValue: "Loading the next referrals took too long. Try again." }) ?? 'Loading the next referrals took too long. Try again.')
                : (globalThis.NorvaI18n?.t("ui_web_20fa71a847cd", { defaultValue: "The next referrals could not be loaded. Try again." }) ?? 'The next referrals could not be loaded. Try again.');
            this.updateReferralModule(program);
        } finally {
            clearTimeout(timeout);
            if (this._referralAbort === controller) this._referralAbort = null;
        }
    }

    renderMembershipDashboardData(bootstrap, dashboard) {
        const metrics = this.container?.querySelector('[data-partners-dashboard-metrics]');
        const content = this.container?.querySelector('[data-partners-dashboard-content]');
        if (!metrics || !content) return;
        this._membershipDashboard = dashboard;
        this.syncReferralState(dashboard.referrals);
        this.updateCashKycProgress(
            dashboard.membership,
            dashboard.cash_readiness
        );
        const balances = Array.isArray(dashboard.balances) ? dashboard.balances : [];
        const hasBalanceRows = balances.length > 0;
        const available = this.formatCurrencyBalances(balances, 'available_minor');
        const pending = this.formatCurrencyBalances(balances, 'pending_minor');
        const redeemed = this.formatCurrencyBalances(balances, 'redeemed_minor');
        const nextMaturation = dashboard.next_maturation_at
            ? this.formatDateTime(dashboard.next_maturation_at)
            : (globalThis.NorvaI18n?.t("ui_web_61c8091bab4a", { defaultValue: "Nothing scheduled" }) ?? 'Nothing scheduled');
        const cashPilotLimited = dashboard.cash_readiness?.reason === 'cash_pilot_not_allowed';
        metrics.innerHTML = [
            this.metric(
                (globalThis.NorvaI18n?.t("ui_web_f859a9cae3f5", { defaultValue: "Available to use" }) ?? 'Available to use'),
                available,
                !hasBalanceRows
                    ? (globalThis.NorvaI18n?.t("ui_web_e24876e91e85", { defaultValue: "Your balance will appear after the first eligible payment." }) ?? 'Your balance will appear after the first eligible payment.')
                    : cashPilotLimited
                    ? (globalThis.NorvaI18n?.t("ui_web_f32cf6a3778e", { defaultValue: "Convert to Norva · cash pilot limited" }) ?? 'Convert to Norva · cash pilot limited')
                    : (globalThis.NorvaI18n?.t("ui_web_2dc2de32cf75", { defaultValue: "Convert to Norva or request cash" }) ?? 'Convert to Norva or request cash')
            ),
            this.metric((globalThis.NorvaI18n?.t("ui_web_6d2d474ca6dc", { defaultValue: "In validation" }) ?? 'In validation'), pending, (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_e433dc398c1c", {defaultValue: "{{p0}}-day validation window", p0:(dashboard.program.maturation_days)}) : `${dashboard.program.maturation_days}-day validation window`)),
            this.metric((globalThis.NorvaI18n?.t("ui_web_132cb8ad0df6", { defaultValue: "Converted to Norva" }) ?? 'Converted to Norva'), redeemed, (globalThis.NorvaI18n?.t("ui_web_8d9d7977eaaa", { defaultValue: "Access credits already used" }) ?? 'Access credits already used')),
            this.metric((globalThis.NorvaI18n?.t("ui_web_aa6a620d6348", { defaultValue: "Next balance update" }) ?? 'Next balance update'), nextMaturation, (globalThis.NorvaI18n?.t("ui_web_3c4c32df4b29", { defaultValue: "Updates automatically" }) ?? 'Updates automatically'))
        ].join('');

        const link = dashboard.link;
        const rate = this.percent(dashboard.program.commission_rate_bps);
        const linkCard = link
            ? `<div class="partners-referral-card">
                <div class="partners-referral-main">
                    <span class="partners-eyebrow" data-i18n="ui_web_cb2e0faf91c8">Your personal referral link</span>
                    <h2 data-i18n="ui_web_b7e0730189db">Share now. Your referrals start here.</h2>
                    <div class="partners-link-control">
                        <input type="text" readonly value="${this.escape(link.share_url)}"
                            aria-label="Your personal Norva referral link" data-partners-link data-i18n-aria-label="ui_web_35fa4075ed93">
                        <button class="btn btn-secondary" type="button" data-partners-copy data-i18n="ui_web_6ac9bf23f4ea">Copy share text</button>
                    </div>
                    <div class="partners-link-actions">
                        <button class="btn btn-primary" type="button" data-partners-share data-i18n="ui_web_712a4823ccb9">Share link</button>
                        <button class="btn btn-secondary" type="button" data-partners-qr data-i18n="ui_web_b694a5029e4f">Show QR</button>
                        <button class="btn btn-ghost" type="button" data-partners-rotate data-i18n="ui_web_09ea49586972">Rotate link</button>
                    </div>
                    <p class="partners-disclosure" data-partners-share-disclosure>${this.escape(this.shareDisclosure(bootstrap))}</p>
                </div>
                <div class="partners-rate-badge"><strong>${rate}</strong><span data-i18n="ui_web_c0c06e547b1b">Recurring</span></div>
              </div>`
            : `<div class="partners-referral-card">
                <div>
                    <span class="partners-eyebrow" data-i18n="ui_web_441c6d0e08c3">Referral link</span>
                    <h2 data-i18n="ui_web_b11ac5961a33">Your link is being prepared.</h2>
                    <p data-i18n="ui_web_241c5117c23e">Request a fresh opaque link from Norva. No code is generated in this browser.</p>
                    <button class="btn btn-primary" type="button" data-partners-create-link data-i18n="ui_web_ab11737bb824">Create referral link</button>
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
                ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_c33fdaea9b25", {defaultValue: "Choose 1 to {{p0}} month{{p1}}. The exact server quote is shown before confirmation.", p0:(maximumAffordable),p1:(maximumAffordable === 1 ? '' : 's')}) : `Choose 1 to ${maximumAffordable} month${maximumAffordable === 1 ? '' : 's'}. The exact server quote is shown before confirmation.`)
                : (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_aa29a8e237a0", {defaultValue: "Your available balance needs to reach {{p0}} for one month.", p0:(this.formatMinor(catalog.unit_amount_minor, catalog.currency))}) : `Your available balance needs to reach ${this.formatMinor(catalog.unit_amount_minor, catalog.currency)} for one month.`))
            : ({
                credits_disabled: (globalThis.NorvaI18n?.t("ui_web_9c7d3503b258", { defaultValue: "Balance conversion is temporarily paused. Your balance remains unchanged." }) ?? 'Balance conversion is temporarily paused. Your balance remains unchanged.'),
                catalog_unavailable: (globalThis.NorvaI18n?.t("ui_web_c999bc728f07", { defaultValue: "The authoritative Norva access catalogue is temporarily unavailable." }) ?? 'The authoritative Norva access catalogue is temporarily unavailable.'),
                fx_rate_unavailable: (globalThis.NorvaI18n?.t("ui_web_84e016333d9f", { defaultValue: "A current verified exchange rate is unavailable for this balance. Nothing is converted automatically and your balance remains unchanged." }) ?? 'A current verified exchange rate is unavailable for this balance. Nothing is converted automatically and your balance remains unchanged.'),
                membership_required: (globalThis.NorvaI18n?.t("ui_web_a0726ab1fac9", { defaultValue: "An active Partners membership is required." }) ?? 'An active Partners membership is required.')
            })[credit.reason] || (globalThis.NorvaI18n?.t("ui_web_a2383f70df32", { defaultValue: "Balance conversion is temporarily unavailable." }) ?? 'Balance conversion is temporarily unavailable.');
        const monthOptions = catalog && maximumAffordable > 0
            ? Array.from({ length: maximumAffordable }, (_, index) => index + 1)
                .map((months) => `<option value="${months}" data-i18n="ui_web_d562930bca99" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p1":(months),"p2":(months === 1 ? '' : 's'),"p3":(this.escape(this.formatMinor(catalog.unit_amount_minor * months, catalog.currency)))}) || "{}")}">${months} month${months === 1 ? '' : 's'} · up to ${this.escape(this.formatMinor(catalog.unit_amount_minor * months, catalog.currency))}</option>`)
                .join('')
            : '<option value="1" data-i18n="ui_web_cd8c117e6dd5">1 month</option>';
        const conversionCard = `<aside class="partners-program-card partners-credit-card" aria-labelledby="partners-credit-title">
            <span class="partners-eyebrow" data-i18n="ui_web_960ef11c3281">Use your available balance</span>
            <h2 id="partners-credit-title" tabindex="-1" data-i18n="ui_web_6df01a3a9cba" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(this.escape(planLabel))}) || "{}")}">Convert to ${this.escape(planLabel)}</h2>
            <p>${this.escape(conversionCopy)}</p>
            <form class="partners-credit-form" data-partners-credit-form>
                <label for="partners-credit-months" data-i18n="ui_web_239c6683ef56">Access duration</label>
                <select id="partners-credit-months" data-partners-credit-months
                    ${canConvert ? '' : 'disabled'}>${monthOptions}</select>
                <button class="btn btn-primary partners-primary-action" type="submit"
                    data-partners-credit-quote ${canConvert ? '' : 'disabled'} data-i18n="ui_web_63331c37d6a4">Review conversion</button>
            </form>
            <p class="partners-action-note" data-i18n="ui_web_09c43d6dd6de" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p5":(catalog ? `Each credited ${this.escape(planLabel)} month is ${catalog.unit_duration_days} days and references ${this.escape(this.formatMinor(catalog.reference_unit_amount_minor, catalog.reference_currency))}. ` : '')}) || "{}")}">No KYC is required. ${catalog ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_5cfa8f4ffbd3", {defaultValue: "Each credited {{p0}} month is {{p1}} days and references {{p2}}.", p0:(this.escape(planLabel)),p1:(catalog.unit_duration_days),p2:(this.escape(this.formatMinor(catalog.reference_unit_amount_minor, catalog.reference_currency)))}) : `Each credited ${this.escape(planLabel)} month is ${catalog.unit_duration_days} days and references ${this.escape(this.formatMinor(catalog.reference_unit_amount_minor, catalog.reference_currency))}. `) : ''}A non-USD balance is debited only through the dated, immutable rate shown in the server quote. An active paid subscription stays in control; converted access waits safely and resumes afterward.</p>
        </aside>`;

        const referralsCard = this.referralsCardMarkup(dashboard.program);

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
                <strong data-i18n="ui_web_8018194d44c8">No balance events in this view</strong>
                <span data-i18n="ui_web_8fcf08447b50">New eligible payments appear in validation without exposing the referred person.</span>
              </div>`;

        content.innerHTML = `
            <section class="partners-dashboard-grid partners-membership-grid">
                ${linkCard}
                ${conversionCard}
            </section>
            ${balances.some((entry) => entry.recovery_due_minor > 0) ? `<aside class="partners-balance-notice" role="status">
                <strong data-i18n="ui_web_7c4cc7da8323">Balance recovery in progress</strong>
                <span data-i18n="ui_web_38b44b0d2ae6" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(this.escape(this.formatCurrencyBalances(
                    balances.filter((entry) => entry.recovery_due_minor > 0),
                    'recovery_due_minor'
                 )))}) || "{}")}">${this.escape(this.formatCurrencyBalances(
                    balances.filter((entry) => entry.recovery_due_minor > 0),
                    'recovery_due_minor'
                 ))} will be offset by future eligible commission after a refund or chargeback.</span>
            </aside>` : ''}
            ${referralsCard}
            <section class="partners-history-card" aria-labelledby="partners-history-title">
                <div class="partners-history-heading">
                    <div><h2 id="partners-history-title" tabindex="-1" data-i18n="ui_web_b7e0abe9ddb5">Balance history</h2>
                    <p data-i18n="ui_web_a3d8bf02f7aa">Pending, available, converted and paid events are shown without customer identity or payment references.</p></div>
                    <div class="partners-history-filters" role="group" aria-label="Filter balance history" data-i18n-aria-label="ui_web_07cbc2d94fde">${filters}</div>
                </div>
                ${history}
                ${dashboard.history.next_cursor
                    ? '<button class="btn btn-secondary partners-load-more" type="button" data-partners-history-more data-i18n="ui_web_ac8991ef0101">Load more</button>'
                    : ''}
            </section>`;
        metrics.removeAttribute('aria-busy');
        content.removeAttribute('aria-busy');
        this.bindDashboardActions(bootstrap, dashboard);
        this.bindReferralActions(dashboard.program);
        this.bindCreditActions(bootstrap, dashboard);
        this.scheduleDashboardRefresh(bootstrap, dashboard);
    }

    bindDashboardActions(bootstrap, dashboard) {
        const link = dashboard.link;
        if (link) {
            this.container?.querySelector('[data-partners-copy]')
                ?.addEventListener('click', (event) => this.runPartnerAction(
                    event.currentTarget,
                    (globalThis.NorvaI18n?.t("ui_web_d250fad8b1a2", { defaultValue: "Copying…" }) ?? 'Copying…'),
                    async () => {
                        await this.copyText(this.shareContent(link.share_url, bootstrap).text);
                        this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_fc65f4ae2002", { defaultValue: "Referral message and required disclosure copied." }) ?? 'Referral message and required disclosure copied.'));
                    }
                ));
            this.container?.querySelector('[data-partners-share]')
                ?.addEventListener('click', (event) => this.runPartnerAction(
                    event.currentTarget,
                    (globalThis.NorvaI18n?.t("ui_web_2649d27971e2", { defaultValue: "Opening share…" }) ?? 'Opening share…'),
                    async () => {
                        const outcome = await this.shareReferral(link.share_url, bootstrap);
                        this.setActionStatus(({
                            cancelled: (globalThis.NorvaI18n?.t("ui_web_70430e1ed264", { defaultValue: "Sharing cancelled. Your referral link was not changed." }) ?? 'Sharing cancelled. Your referral link was not changed.'),
                            copied: (globalThis.NorvaI18n?.t("ui_web_5a5e4dfb06e7", { defaultValue: "Sharing is unavailable here, so the link and required disclosure were copied." }) ?? 'Sharing is unavailable here, so the link and required disclosure were copied.'),
                            shared: (globalThis.NorvaI18n?.t("ui_web_14f791224300", { defaultValue: "Share sheet opened with the required disclosure." }) ?? 'Share sheet opened with the required disclosure.')
                        })[outcome] || (globalThis.NorvaI18n?.t("ui_web_0849aeb51a38", { defaultValue: "Referral link is ready to share." }) ?? 'Referral link is ready to share.'));
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
                        rotate.textContent = (globalThis.NorvaI18n?.t("ui_web_96b69bcfb1ba", { defaultValue: "Confirm link rotation" }) ?? 'Confirm link rotation');
                        this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_4f3411259cce", { defaultValue: "Confirm rotation. The previous link will stop working." }) ?? 'Confirm rotation. The previous link will stop working.'));
                        setTimeout(() => {
                            if (rotate.isConnected && Date.now() >= armedUntil) rotate.textContent = (globalThis.NorvaI18n?.t("ui_web_09ea49586972", { defaultValue: "Rotate link" }) ?? 'Rotate link');
                        }, 8100);
                        return;
                    }
                    this.runPartnerAction(rotate, (globalThis.NorvaI18n?.t("ui_web_542bcb24b891", { defaultValue: "Rotating…" }) ?? 'Rotating…'), async () => {
                        await window.NorvaCloud.partners.rotateLink({
                            idempotencyKey: this.actionKey('link-rotation')
                        });
                        this.clearActionKey('link-rotation');
                        this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_3b9e7b634356", { defaultValue: "Referral link rotated. Loading the new server-issued link." }) ?? 'Referral link rotated. Loading the new server-issued link.'));
                        await this.loadDashboard(bootstrap, {
                            reset: true,
                            successMessage: (globalThis.NorvaI18n?.t("ui_web_4810a9c11332", { defaultValue: "Referral link rotated. The new server-issued link is ready." }) ?? 'Referral link rotated. The new server-issued link is ready.')
                        });
                    });
                });
            }
        } else {
            this.container?.querySelector('[data-partners-create-link]')
                ?.addEventListener('click', (event) => this.runPartnerAction(
                    event.currentTarget,
                    (globalThis.NorvaI18n?.t("ui_web_679a7c55e961", { defaultValue: "Creating securely…" }) ?? 'Creating securely…'),
                    async () => {
                        await window.NorvaCloud.partners.rotateLink({
                            idempotencyKey: this.actionKey('link-rotation')
                        });
                        this.clearActionKey('link-rotation');
                        this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_e9f4ee023b33", { defaultValue: "Referral link created. Loading the server-issued link." }) ?? 'Referral link created. Loading the server-issued link.'));
                        await this.loadDashboard(bootstrap, {
                            reset: true,
                            successMessage: (globalThis.NorvaI18n?.t("ui_web_f5597f03b951", { defaultValue: "Referral link created. The server-issued link is ready." }) ?? 'Referral link created. The server-issued link is ready.')
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
                this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_d9da4002c03e", { defaultValue: "Choose a valid Norva access duration." }) ?? 'Choose a valid Norva access duration.'), 'error');
                months.focus();
                return;
            }
            const token = ++this._creditToken;
            await this.runPartnerAction(button, (globalThis.NorvaI18n?.t("ui_web_258fb05f4d23", { defaultValue: "Creating secure quote…" }) ?? 'Creating secure quote…'), async () => {
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
        const verificationStatus = String(
            dashboard.membership?.verification_status || 'not_started'
        );
        const trackingKyc = this.hasRecentKycReturn()
            && ['pending', 'not_started'].includes(verificationStatus);
        const refreshDelay = trackingKyc
            ? PartnersPage.KYC_PENDING_REFRESH_MS
            : PartnersPage.DASHBOARD_REFRESH_MS;
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
                successMessage: (globalThis.NorvaI18n?.t("ui_web_28d1bdf798d2", { defaultValue: "Balance refreshed automatically." }) ?? 'Balance refreshed automatically.')
            });
        }, refreshDelay);
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
                    <div><span class="partners-eyebrow" data-i18n="ui_web_6c588d03b4c1">Server-confirmed quote</span>
                    <h2 id="partners-credit-confirm-title" data-i18n="ui_web_7acbf4dc9615" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(this.escape(monthsLabel)),"p1":(this.escape(planLabel))}) || "{}")}">Convert to ${this.escape(monthsLabel)} of ${this.escape(planLabel)}?</h2></div>
                    <button class="partners-country-close" type="button"
                        data-partners-credit-close aria-label="Close conversion review" data-i18n-aria-label="ui_web_9ed2b074ab96">×</button>
                </header>
                <dl class="partners-program-facts partners-credit-summary">
                    <div><dt data-i18n="ui_web_f5ac05aaa7e9">Available balance used</dt><dd>${this.escape(this.formatMinor(quote.total_amount_minor, quote.currency))}</dd></div>
                    <div><dt data-i18n="ui_web_76267c5365eb">Norva reference value</dt><dd>${this.escape(this.formatMinor(quote.reference_total_amount_minor, quote.reference_currency))}</dd></div>
                    ${quote.fx_rate_snapshot_key ? `<div><dt data-i18n="ui_web_efde0f330ed8">Verified exchange rate</dt><dd data-i18n="ui_web_a48c3ea615e7" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(this.escape(this.formatDateTime(quote.fx_observed_at)))}) || "{}")}">${this.escape(this.formatDateTime(quote.fx_observed_at))} · valid for this quote</dd></div>` : ''}
                    <div><dt data-i18n="ui_web_de0d86adf6a7">Norva access</dt><dd>${this.escape(planLabel)} · ${this.escape(monthsLabel)}</dd></div>
                    <div><dt data-i18n="ui_web_b207ae38ab70">Identity verification</dt><dd data-i18n="ui_web_5fe2851c6d17">Not required</dd></div>
                </dl>
                <p id="partners-credit-confirm-copy" data-i18n="ui_web_f21ad0712eda">This uses only your available Partners balance. Pending commission is untouched. If paid access is active, this credit waits and resumes automatically afterward.</p>
                <div class="partners-actions partners-actions-row">
                    <button class="btn btn-secondary" type="button" data-partners-credit-close data-i18n="ui_web_19766ed6ccb2">Cancel</button>
                    <button class="btn btn-primary" type="button" data-partners-credit-confirm data-i18n="ui_web_901b57bbbab0">Confirm conversion</button>
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
                    successMessage: (globalThis.NorvaI18n?.t("ui_web_472008cd7910", { defaultValue: "Norva access conversion recorded." }) ?? 'Norva access conversion recorded.')
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
            confirm.textContent = (globalThis.NorvaI18n?.t("ui_web_5303071d4e9c", { defaultValue: "Converting securely…" }) ?? 'Converting securely…');
            if (status) status.textContent = (globalThis.NorvaI18n?.t("ui_web_f61b1b9a786e", { defaultValue: "Confirming the exact server quote." }) ?? 'Confirming the exact server quote.');
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
                    <span class="partners-status-pill partners-status-success" data-i18n="ui_web_76529479bc04">Conversion complete</span>
                    <h2 id="partners-credit-confirm-title" tabindex="-1" data-i18n="ui_web_20229f66e04b" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(this.escape(redemption.months)),"p1":(redemption.months === 1 ? '' : 's'),"p2":(this.escape(planLabel))}) || "{}")}">${this.escape(redemption.months)} month${redemption.months === 1 ? '' : 's'} of ${this.escape(planLabel)} secured</h2>
                    <p id="partners-credit-confirm-copy" data-i18n="ui_web_ca6f0ac70745" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p3":(this.escape(this.formatMinor(redemption.amount_minor, redemption.currency))),"p4":(this.escape(this.creditGrantCopy(grant.status)))}) || "{}")}">Your available balance was reduced by ${this.escape(this.formatMinor(redemption.amount_minor, redemption.currency))}. ${this.escape(this.creditGrantCopy(grant.status))}</p>
                    <button class="btn btn-primary partners-primary-action" type="button" data-partners-credit-close data-i18n="ui_web_11a6767d5674">Done</button>`;
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
                confirm.textContent = terminalQuote ? (globalThis.NorvaI18n?.t("ui_web_faf907b5714a", { defaultValue: "Quote cannot be confirmed" }) ?? 'Quote cannot be confirmed') : previous;
            }
        });
    }

    creditGrantCopy(status) {
        return ({
            active: (globalThis.NorvaI18n?.t("ui_web_dff7084225b1", { defaultValue: "Your Norva access is active now." }) ?? 'Your Norva access is active now.'),
            queued: (globalThis.NorvaI18n?.t("ui_web_7cbfba5824c6", { defaultValue: "Your access is queued safely and will activate when it becomes eligible." }) ?? 'Your access is queued safely and will activate when it becomes eligible.'),
            paused_provider: (globalThis.NorvaI18n?.t("ui_web_b5ae47d94c6f", { defaultValue: "Your paid subscription remains active first; this credit will resume afterward." }) ?? 'Your paid subscription remains active first; this credit will resume afterward.')
        })[status] || (globalThis.NorvaI18n?.t("ui_web_4a1a7d06fab0", { defaultValue: "Your Norva access state is being reconciled securely." }) ?? 'Your Norva access state is being reconciled securely.');
    }

    creditPlanLabel(planCode) {
        return ({
            plus: (globalThis.NorvaI18n?.t("ui_web_acc74895bf2b", { defaultValue: "Norva Plus" }) ?? 'Norva Plus'),
            family: (globalThis.NorvaI18n?.t("ui_web_fada8f5631ee", { defaultValue: "Norva Family" }) ?? 'Norva Family')
        })[planCode] || 'Norva';
    }

    async openCashJourney(data, opener) {
        const readiness = data.cash_readiness;
        if (!readiness) {
            this.openCashStatusDialog(
                (globalThis.NorvaI18n?.t("ui_web_43df0227c3a6", { defaultValue: "Cash-transfer status is unavailable" }) ?? 'Cash-transfer status is unavailable'),
                (globalThis.NorvaI18n?.t("ui_web_3dc2d7db3a5e", { defaultValue: "Norva could not verify the authoritative cash-transfer state. Your referral link, balance and Norva-access conversions are unchanged." }) ?? 'Norva could not verify the authoritative cash-transfer state. Your referral link, balance and Norva-access conversions are unchanged.'),
                opener
            );
            return;
        }
        if (readiness.reason === 'cash_pilot_not_allowed') {
            this.openCashStatusDialog(
                (globalThis.NorvaI18n?.t("ui_web_2e900646ce0b", { defaultValue: "Cash transfers are in a supervised pilot" }) ?? 'Cash transfers are in a supervised pilot'),
                (globalThis.NorvaI18n?.t("ui_web_8de22ce1715c", { defaultValue: "This account is not in the current cash-transfer cohort. Your membership, referral link, earnings and Norva-access conversions remain fully available. No payout country, identity check, tax profile or banking detail is requested." }) ?? 'This account is not in the current cash-transfer cohort. Your membership, referral link, earnings and Norva-access conversions remain fully available. No payout country, identity check, tax profile or banking detail is requested.'),
                opener
            );
            return;
        }
        if (readiness.reason === 'payout_country_required') {
            const profile = await this.loadPayoutProfile();
            if (!opener?.isConnected) return;
            if (profile?.account?.country_code) {
                this.openCashStatusDialog(
                    (globalThis.NorvaI18n?.t("ui_web_f004a03f147d", { defaultValue: "Cash-transfer status needs a refresh" }) ?? 'Cash-transfer status needs a refresh'),
                    (globalThis.NorvaI18n?.t("ui_web_a636a5fb61c1", { defaultValue: "Your payout country is already recorded, but the cash-transfer readiness state has not caught up yet. Refresh Partners before continuing." }) ?? 'Your payout country is already recorded, but the cash-transfer readiness state has not caught up yet. Refresh Partners before continuing.'),
                    opener
                );
                return;
            }
            if (profile) {
                this.openCashCountryDialog(data, profile, opener);
                return;
            }
            this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_eb1d91af18d5", { defaultValue: "Cash-transfer country setup is temporarily unavailable. Your balance is unchanged." }) ?? 'Cash-transfer country setup is temporarily unavailable. Your balance is unchanged.'), 'error');
            try { opener.focus({ preventScroll: true }); } catch (_) { opener.focus?.(); }
            return;
        }
        if (readiness.reason === 'kyc_required') {
            this.openCashKycDialog(data, opener);
            return;
        }
        if (readiness.reason === 'account_blocked') {
            this.openCashStatusDialog(
                (globalThis.NorvaI18n?.t("ui_web_64c9af461c58", { defaultValue: "Cash transfers need a secure review" }) ?? 'Cash transfers need a secure review'),
                (globalThis.NorvaI18n?.t("ui_web_d48c2a6c36c0", { defaultValue: "Your referral link and balance stay separate from this cash-transfer review. Contact Support without sending identity, banking or tax documents." }) ?? 'Your referral link and balance stay separate from this cash-transfer review. Contact Support without sending identity, banking or tax documents.'),
                opener
            );
            return;
        }
        if (readiness.reason === 'membership_required') {
            this.openCashStatusDialog(
                (globalThis.NorvaI18n?.t("ui_web_9ad80eaf0ee5", { defaultValue: "Partners membership is required" }) ?? 'Partners membership is required'),
                (globalThis.NorvaI18n?.t("ui_web_85027ea40f43", { defaultValue: "Join Norva Partners and obtain your referral link before configuring an optional cash transfer." }) ?? 'Join Norva Partners and obtain your referral link before configuring an optional cash transfer.'),
                opener
            );
            return;
        }
        const profile = await this.loadPayoutProfile();
        if (profile && opener?.isConnected) this.openPayoutDialog(profile, opener);
        else if (opener?.isConnected) {
            this.setActionStatus((globalThis.NorvaI18n?.t("ui_web_af6ba987cb8a", { defaultValue: "Cash-transfer setup is temporarily unavailable. Your balance is unchanged." }) ?? 'Cash-transfer setup is temporarily unavailable. Your balance is unchanged.'), 'error');
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
                    <div><span class="partners-eyebrow" data-i18n="ui_web_af18aba7fbca">Optional cash transfer</span>
                    <h2 id="partners-cash-country-title" data-i18n="ui_web_3a83b368d5d7">Choose your payout country</h2></div>
                    <button class="partners-country-close" type="button"
                        data-partners-cash-country-close aria-label="Close payout-country setup" data-i18n-aria-label="ui_web_f7a0848f6287">×</button>
                </header>
                <p id="partners-cash-country-copy" data-i18n="ui_web_b52619c583be">Choose the country where you personally reside for the cash-transfer programme. Norva never infers this from your IP address, device or locale. This does not affect sharing, earnings or conversion to Norva access.</p>
                <form class="partners-credit-form partners-cash-country-form" data-partners-cash-country-form novalidate>
                    <label for="partners-cash-country" data-i18n="ui_web_3d6939adb604">Country of residence for cash transfers</label>
                    <select id="partners-cash-country" data-partners-cash-country required>
                        <option value="" data-i18n="ui_web_19323e2d92e7">Choose a country</option>
                        ${countryOptions}
                    </select>
                    <p class="partners-action-note" data-i18n="ui_web_1045c4388dc9">The server will check whether an individual payout route is available. Your country is saved only after you confirm it; no alternative country is guessed or retried.</p>
                    <button class="btn btn-primary partners-primary-action" type="submit"
                        data-partners-cash-country-submit disabled data-i18n="ui_web_a1bbe02269df">Confirm payout country</button>
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
                status.textContent = (globalThis.NorvaI18n?.t("ui_web_d3c4b219d26b", { defaultValue: "Choose your country before continuing." }) ?? 'Choose your country before continuing.');
                select.focus();
                return;
            }
            const api = window.NorvaCloud?.partners?.bindPayoutCountry;
            if (typeof api !== 'function') {
                status.setAttribute('role', 'alert');
                status.textContent = (globalThis.NorvaI18n?.t("ui_web_6e3890516e10", { defaultValue: "Secure payout-country setup is unavailable in this app version." }) ?? 'Secure payout-country setup is unavailable in this app version.');
                return;
            }
            const previous = submit.textContent;
            submit.disabled = true;
            select.disabled = true;
            submit.setAttribute('aria-busy', 'true');
            submit.textContent = (globalThis.NorvaI18n?.t("ui_web_206c06bb8d2a", { defaultValue: "Checking securely…" }) ?? 'Checking securely…');
            status.setAttribute('role', 'status');
            status.textContent = (globalThis.NorvaI18n?.t("ui_web_0e1324882091", { defaultValue: "Checking the authoritative individual payout policy." }) ?? 'Checking the authoritative individual payout policy.');
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
                    <div><span class="partners-eyebrow" data-i18n="ui_web_af18aba7fbca">Optional cash transfer</span>
                    <h2 id="partners-cash-title" data-i18n="ui_web_2bd7611e9fb2">Verify only when you want cash</h2></div>
                    <button class="partners-country-close" type="button"
                        data-partners-cash-close aria-label="Close cash-transfer setup" data-i18n-aria-label="ui_web_e1694fefb8ef">×</button>
                </header>
                <p id="partners-cash-copy" data-i18n="ui_web_2c564c0a877e">Your membership, referral link, earnings and Norva-access conversions already work without KYC. A cash transfer requires identity verification, then fiscal and payout-route checks.</p>
                <aside class="partners-provider-disclosure">
                    <strong data-i18n="ui_web_301c8979d283">Secure verification with Didit</strong>
                    <span><norva-i18n data-i18n="ui_web_bb258cc0b561">Review the </norva-i18n><a href="/privacy.html#partners" target="_blank" rel="noopener" data-i18n="ui_web_47477d255da8">Norva Privacy Notice</a>, <a href="https://didit.me/terms/verification-privacy-notice/" target="_blank" rel="noopener noreferrer" data-i18n="ui_web_0f2b059c9129">Didit Privacy Notice</a><norva-i18n data-i18n="ui_web_6201111b83a0"> and </norva-i18n><a href="https://didit.me/terms/identity-verification/" target="_blank" rel="noopener noreferrer" data-i18n="ui_web_29e5d18cc5dc">Didit Terms</a>.</span>
                </aside>
                <form class="partners-join-form" data-partners-cash-kyc-form novalidate>
                    <label class="partners-consent-check">
                        <input type="checkbox" data-partners-cash-kyc-consent>
                        <span data-i18n="ui_web_8ef013a95771">I explicitly consent to document, selfie, liveness and face-match capture in Didit's hosted flow for cash-transfer eligibility.</span>
                    </label>
                    <label class="partners-consent-check">
                        <input type="checkbox" data-partners-cash-capacity>
                        <span data-i18n="ui_web_07c660a86d15">I confirm that I have legal capacity to request an individual cash transfer.</span>
                    </label>
                    <button class="btn btn-primary partners-primary-action" type="submit"
                        data-partners-cash-kyc-submit disabled data-i18n="ui_web_1622a4889d7e">Continue securely to Didit</button>
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
                status.textContent = (globalThis.NorvaI18n?.t("ui_web_580a05ec7543", { defaultValue: "Confirm both identity-verification statements first." }) ?? 'Confirm both identity-verification statements first.');
                (!consent.checked ? consent : capacity).focus();
                return;
            }
            const previous = submit.textContent;
            submit.disabled = true;
            submit.setAttribute('aria-busy', 'true');
            submit.textContent = (globalThis.NorvaI18n?.t("ui_web_3226f2eeb8a4", { defaultValue: "Opening Didit securely…" }) ?? 'Opening Didit securely…');
            status.textContent = (globalThis.NorvaI18n?.t("ui_web_bbccebabd153", { defaultValue: "Creating a single-use hosted verification session." }) ?? 'Creating a single-use hosted verification session.');
            try {
                const envelope = await window.NorvaCloud.partners.startKyc({
                    language: this.partnerLanguage(),
                    consentVersion: data.program.disclosure_version,
                    biometricConsentVersion: PartnersPage.BIOMETRIC_CONSENT_VERSION,
                    capacityConfirmed: true,
                    idempotencyKey: this.actionKey('cash-kyc-session')
                });
                if (!overlay.isConnected) return;
                status.textContent = (globalThis.NorvaI18n?.t("ui_web_e7a6fdb302fa", { defaultValue: "Secure verification ready. Opening Didit." }) ?? 'Secure verification ready. Opening Didit.');
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
            <span class="partners-status-pill partners-status-warning" data-i18n="ui_web_849f206741dd">Secure review</span>
            <h2 id="partners-cash-title">${this.escape(title)}</h2>
            <p>${this.escape(copy)}</p>
            <div class="partners-actions partners-actions-row">
                <a class="btn btn-secondary" href="/support.html?returnTo=%2Fapp%23partners" data-i18n="ui_web_814f4ed2d5bd">Contact support</a>
                <button class="btn btn-primary" type="button" data-partners-cash-close data-i18n="ui_web_7d9eb7acb13e">Close</button>
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
            available: (globalThis.NorvaI18n?.t("ui_web_8baf4e24ef5e", { defaultValue: "Authoritative commission ledger" }) ?? 'Authoritative commission ledger'),
            no_financial_activity: (globalThis.NorvaI18n?.t("ui_web_fc34210544a6", { defaultValue: "No commission activity yet" }) ?? 'No commission activity yet'),
            multiple_currencies: (globalThis.NorvaI18n?.t("ui_web_13f7505d8e3e", { defaultValue: "Amounts are kept separate by authoritative currency" }) ?? 'Amounts are kept separate by authoritative currency')
        })[reason] || (globalThis.NorvaI18n?.t("ui_web_37a0e8d16aeb", { defaultValue: "Financial reporting unavailable" }) ?? 'Financial reporting unavailable');
    }

    formatMinor(value, currency) {
        if (!Number.isSafeInteger(value) || !/^[A-Z]{3}$/.test(String(currency || ''))) return (globalThis.NorvaI18n?.t("ui_web_ca1844969742", { defaultValue: "Unavailable" }) ?? 'Unavailable');
        try {
            const formatter = new Intl.NumberFormat(globalThis.NorvaI18n?.language, {
                style: 'currency',
                currency,
                currencyDisplay: 'narrowSymbol'
            });
            const digits = formatter.resolvedOptions().maximumFractionDigits;
            return formatter.format(value / (10 ** digits));
        } catch (_) {
            return (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_6bd36de7f392", {defaultValue: "{{p0}} {{p1}} minor units", p0:(value),p1:(currency)}) : `${value} ${currency} minor units`);
        }
    }

    formatCurrencyBalances(currencies, field) {
        if (!Array.isArray(currencies) || currencies.length === 0) {
            return ({
                available_minor: (globalThis.NorvaI18n?.t("ui_web_474d6003f580", { defaultValue: "No balance yet" }) ?? 'No balance yet'),
                pending_minor: (globalThis.NorvaI18n?.t("ui_web_dd0073ddec6d", { defaultValue: "Nothing in validation" }) ?? 'Nothing in validation'),
                redeemed_minor: (globalThis.NorvaI18n?.t("ui_web_c61a00b35c57", { defaultValue: "No conversions yet" }) ?? 'No conversions yet')
            })[field] || (globalThis.NorvaI18n?.t("ui_web_474d6003f580", { defaultValue: "No balance yet" }) ?? 'No balance yet');
        }
        return currencies
            .map((balance) => this.formatMinor(balance?.[field], balance?.currency))
            .join(' · ');
    }

    referencePayoutThreshold(program) {
        const value = program?.payout_thresholds?.USD;
        if (!Number.isSafeInteger(value) || value <= 0) return (globalThis.NorvaI18n?.t("ui_web_dd1841d29502", { defaultValue: "Not configured" }) ?? 'Not configured');
        return (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_09ac2dd12de8", {defaultValue: "{{p0}} · USD reference", p0:(this.formatMinor(value, 'USD'))}) : `${this.formatMinor(value, 'USD')} · USD reference`);
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
                <h2 id="${this.escape(headingId)}" data-i18n="ui_web_ff175dedc904">Payout thresholds before you accept</h2>
                <p><strong data-i18n="ui_web_6729ffb23857">Programme reference:</strong> ${this.escape(this.referencePayoutThreshold(program))}.</p>
                ${entries.length
                    ? `<dl class="partners-program-facts" aria-label="Exact settlement payout thresholds for your policy" data-i18n-aria-label="ui_web_d9b0e9dfd6e6">
                        ${entries.map(([currency, amount]) => `
                            <div><dt data-i18n="ui_web_99ed2045af9e" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(this.escape(currency))}) || "{}")}">${this.escape(currency)} settlement</dt><dd>${this.escape(this.formatMinor(amount, currency))}</dd></div>`).join('')}
                      </dl>`
                    : '<p data-i18n="ui_web_8e1beeda5523">No settlement currency is enabled for this policy.</p>'}
                <p data-i18n="ui_web_6f66f8226d2d">Each threshold is exact in its named settlement currency; Norva does not calculate a hidden FX equivalent. Norva absorbs payout-transfer fees on supported routes.</p>
            </section>`;
    }

    historyLabel(type) {
        return ({
            application_submitted: (globalThis.NorvaI18n?.t("ui_web_7e924acdff3e", { defaultValue: "Application submitted" }) ?? 'Application submitted'),
            terms_accepted: (globalThis.NorvaI18n?.t("ui_web_487a4209587d", { defaultValue: "Programme terms accepted" }) ?? 'Programme terms accepted'),
            account_activated: (globalThis.NorvaI18n?.t("ui_web_efd038686f39", { defaultValue: "Partner account activated" }) ?? 'Partner account activated'),
            account_held: (globalThis.NorvaI18n?.t("ui_web_1ccaae0b2f38", { defaultValue: "Account placed on hold" }) ?? 'Account placed on hold'),
            account_suspended: (globalThis.NorvaI18n?.t("ui_web_cb35a570b6e4", { defaultValue: "Account suspended" }) ?? 'Account suspended'),
            link_created: (globalThis.NorvaI18n?.t("ui_web_9e895ca7775a", { defaultValue: "Referral link created" }) ?? 'Referral link created'),
            link_rotated: (globalThis.NorvaI18n?.t("ui_web_eff79653a595", { defaultValue: "Referral link rotated" }) ?? 'Referral link rotated'),
            link_revoked: (globalThis.NorvaI18n?.t("ui_web_5430fc6205d9", { defaultValue: "Referral link revoked" }) ?? 'Referral link revoked'),
            commission_pending: (globalThis.NorvaI18n?.t("ui_web_88b9224eb1bc", { defaultValue: "Commission in validation" }) ?? 'Commission in validation'),
            commission_available: (globalThis.NorvaI18n?.t("ui_web_03b506884552", { defaultValue: "Commission available" }) ?? 'Commission available'),
            commission_held: (globalThis.NorvaI18n?.t("ui_web_72d079efafec", { defaultValue: "Commission held for review" }) ?? 'Commission held for review'),
            commission_paid: (globalThis.NorvaI18n?.t("ui_web_009fc9ca5757", { defaultValue: "Commission paid" }) ?? 'Commission paid'),
            commission_restored: (globalThis.NorvaI18n?.t("ui_web_a398addc6330", { defaultValue: "Commission restored" }) ?? 'Commission restored'),
            commission_reversed: (globalThis.NorvaI18n?.t("ui_web_18dcb1675f94", { defaultValue: "Commission reversed" }) ?? 'Commission reversed'),
            accrual: (globalThis.NorvaI18n?.t("ui_web_59121cb39e74", { defaultValue: "Commission recorded" }) ?? 'Commission recorded'),
            release: (globalThis.NorvaI18n?.t("ui_web_03b506884552", { defaultValue: "Commission available" }) ?? 'Commission available'),
            access_credit_redemption: (globalThis.NorvaI18n?.t("ui_web_603fbc89e934", { defaultValue: "Converted to Norva access" }) ?? 'Converted to Norva access'),
            payout_settlement: (globalThis.NorvaI18n?.t("ui_web_63643f046c91", { defaultValue: "Cash transfer settled" }) ?? 'Cash transfer settled'),
            payout_late_settlement: (globalThis.NorvaI18n?.t("ui_web_1f9311389bd7", { defaultValue: "Cash transfer reconciled" }) ?? 'Cash transfer reconciled'),
            reversal: (globalThis.NorvaI18n?.t("ui_web_18dcb1675f94", { defaultValue: "Commission reversed" }) ?? 'Commission reversed'),
            manual_reversal: (globalThis.NorvaI18n?.t("ui_web_6978915fc559", { defaultValue: "Balance correction" }) ?? 'Balance correction'),
            payout_return: (globalThis.NorvaI18n?.t("ui_web_090d6c2fb5ba", { defaultValue: "Cash transfer returned" }) ?? 'Cash transfer returned')
        })[type] || (globalThis.NorvaI18n?.t("ui_web_7e6b629d1c17", { defaultValue: "Partner event" }) ?? 'Partner event');
    }

    referralStatusMeta(referral, maturationDays) {
        const status = referral?.status;
        if (status === 'payment_recorded') {
            return {
                label: (globalThis.NorvaI18n?.t("ui_web_a763f85a4c38", { defaultValue: "Eligible payment recorded" }) ?? 'Eligible payment recorded'),
                detail: referral.first_eligible_payment_at
                    ? `Recorded ${this.formatDateTime(referral.first_eligible_payment_at)}. Commission processing updates automatically.`
                    : (globalThis.NorvaI18n?.t("ui_web_8f363ca1ec5c", { defaultValue: "Commission processing updates automatically." }) ?? 'Commission processing updates automatically.'),
                tone: 'partners-status-info'
            };
        }
        if (status === 'commission_pending') {
            return {
                label: (globalThis.NorvaI18n?.t("ui_web_6d2d474ca6dc", { defaultValue: "In validation" }) ?? 'In validation'),
                detail: referral.next_maturation_at
                    ? `Expected review date: ${this.formatDateTime(referral.next_maturation_at)}.`
                    : `The ${Number(maturationDays) || 45}-day validation period is in progress.`,
                tone: 'partners-status-warning'
            };
        }
        if (status === 'commission_validated') {
            return {
                label: (globalThis.NorvaI18n?.t("ui_web_b53633ee93d0", { defaultValue: "Commission validated" }) ?? 'Commission validated'),
                detail: (globalThis.NorvaI18n?.t("ui_web_52525ceaaade", { defaultValue: "At least one eligible commission completed validation." }) ?? 'At least one eligible commission completed validation.'),
                tone: 'partners-status-success'
            };
        }
        if (status === 'held') {
            return {
                label: (globalThis.NorvaI18n?.t("ui_web_9e8a3b648cf7", { defaultValue: "Under review" }) ?? 'Under review'),
                detail: (globalThis.NorvaI18n?.t("ui_web_efd356c0c9bb", { defaultValue: "This referral is temporarily held while Norva completes its checks." }) ?? 'This referral is temporarily held while Norva completes its checks.'),
                tone: 'partners-status-warning'
            };
        }
        if (status === 'reversed') {
            return {
                label: (globalThis.NorvaI18n?.t("ui_web_2154c60d4481", { defaultValue: "Reversed" }) ?? 'Reversed'),
                detail: (globalThis.NorvaI18n?.t("ui_web_137f87ebc1bc", { defaultValue: "The related eligible payment or commission was reversed." }) ?? 'The related eligible payment or commission was reversed.'),
                tone: 'partners-status-danger'
            };
        }
        return {
            label: (globalThis.NorvaI18n?.t("ui_web_f63879fd691e", { defaultValue: "Account created" }) ?? 'Account created'),
            detail: (globalThis.NorvaI18n?.t("ui_web_a9b1f24ca970", { defaultValue: "Waiting for the first eligible Norva payment." }) ?? 'Waiting for the first eligible Norva payment.'),
            tone: 'partners-status-info'
        };
    }

    formatDateTime(value) {
        try {
            return new Intl.DateTimeFormat(globalThis.NorvaI18n?.language, {
                dateStyle: 'medium',
                timeStyle: 'short'
            }).format(new Date(value));
        } catch (_) {
            return (globalThis.NorvaI18n?.t("ui_web_f41419fb08be", { defaultValue: "Date unavailable" }) ?? 'Date unavailable');
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
        const message = (globalThis.NorvaI18n?.t("ui_web_a7f6d1cee3c5", { defaultValue: "Discover Norva — one media ecosystem across Web, Android and TV." }) ?? 'Discover Norva — one media ecosystem across Web, Android and TV.');
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
                chooserTitle: (globalThis.NorvaI18n?.t("ui_web_29eec9556a7f", { defaultValue: "Share Norva" }) ?? 'Share Norva')
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
                return new Intl.DateTimeFormat(globalThis.NorvaI18n?.language, {
                    dateStyle: 'medium',
                    timeStyle: 'short'
                }).format(new Date(value));
            } catch (_) { return ''; }
        };
        const reasonMessage = (reason) => ({
            route_unavailable: (globalThis.NorvaI18n?.t("ui_web_a850db601647", { defaultValue: "The manual payout route is not available for this account country." }) ?? 'The manual payout route is not available for this account country.'),
            beneficiary_setup_required: (globalThis.NorvaI18n?.t("ui_web_f21639d6f425", { defaultValue: "Finance still needs to configure the secure beneficiary destination." }) ?? 'Finance still needs to configure the secure beneficiary destination.'),
            identity_mismatch: (globalThis.NorvaI18n?.t("ui_web_10b0fe0862fc", { defaultValue: "The verified identity does not match the payout setup information." }) ?? 'The verified identity does not match the payout setup information.'),
            unsupported_destination: (globalThis.NorvaI18n?.t("ui_web_f5875f08664a", { defaultValue: "This payout destination is not supported by the current manual route." }) ?? 'This payout destination is not supported by the current manual route.'),
            compliance_review: (globalThis.NorvaI18n?.t("ui_web_1a75b6ad2574", { defaultValue: "A compliance review is required before Finance can continue." }) ?? 'A compliance review is required before Finance can continue.'),
            duplicate_request: (globalThis.NorvaI18n?.t("ui_web_7c2a7e0215e2", { defaultValue: "Another payout setup request already covers this destination." }) ?? 'Another payout setup request already covers this destination.')
        })[reason] || (globalThis.NorvaI18n?.t("ui_web_ceea1362f508", { defaultValue: "Finance could not complete this request. Contact support before trying again." }) ?? 'Finance could not complete this request. Contact support before trying again.');
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
                    <h3 data-i18n="ui_web_f5e581fd89bb">Tax residence</h3><p data-i18n="ui_web_f3d6e629487b">Checking your secure self-certification status…</p>
                </div></div><div class="partners-setup-skeleton" aria-hidden="true"></div>`;
                return;
            }
            if (setup.fiscal.phase === 'error' || setup.fiscal.phase === 'unavailable') {
                fiscalTarget.innerHTML = `<div class="partners-setup-heading"><span>1</span><div>
                    <h3 tabindex="-1" data-partners-fiscal-heading data-i18n="ui_web_f5e581fd89bb">Tax residence</h3>
                    <p data-i18n="ui_web_6662b32caae6">No status was inferred and no attestation was submitted.</p></div></div>
                    <div class="partners-setup-notice is-error" role="alert">
                        <strong data-i18n="ui_web_ec3236f724c4">Secure status unavailable</strong>
                        <span>${setup.fiscal.timedOut
                            ? (globalThis.NorvaI18n?.t("ui_web_49653990a5d1", { defaultValue: "The request took too long. You can retry safely." }) ?? 'The request took too long. You can retry safely.')
                            : (globalThis.NorvaI18n?.t("ui_web_64ed574cd12b", { defaultValue: "This app cannot load the authoritative tax-residence status right now." }) ?? 'This app cannot load the authoritative tax-residence status right now.')}</span>
                    </div>
                    <button class="btn btn-secondary partners-setup-action" type="button" data-partners-fiscal-retry data-i18n="ui_web_1d126cf92915">Retry tax status</button>`;
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
                    <h3 tabindex="-1" data-partners-fiscal-heading data-i18n="ui_web_782ae6254ade">Tax residence attestation received</h3>
                    <p data-i18n="ui_web_7ab03c096e26" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(this.escape(formatDate(fiscal.submitted_at) || 'securely'))}) || "{}")}">Submitted ${this.escape(formatDate(fiscal.submitted_at) || 'securely')}.</p></div></div>
                    <div class="partners-setup-notice is-pending" role="status">
                        <strong data-i18n="ui_web_cfdc6cd64117">Finance review pending</strong>
                        <span data-i18n="ui_web_214f35206922">This is a self-attestation, not a tax validation. No tax identifier or document was collected.</span>
                    </div>`;
                focusSetup(focus);
                renderPayout();
                return;
            }
            if (fiscal.status === 'verified') {
                fiscalTarget.innerHTML = `<div class="partners-setup-heading"><span class="is-complete">1</span><div>
                    <h3 tabindex="-1" data-partners-fiscal-heading data-i18n="ui_web_304b78142ef2">Tax residence review complete</h3>
                    <p data-i18n="ui_web_91eafe830d5f" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(this.escape(this.regionLabel({ country_code: fiscal.country_code }))),"p1":(this.escape(formatDate(fiscal.reviewed_at) || 'securely'))}) || "{}")}">${this.escape(this.regionLabel({ country_code: fiscal.country_code }))} · reviewed ${this.escape(formatDate(fiscal.reviewed_at) || 'securely')}</p></div></div>
                    <div class="partners-setup-notice is-success" role="status">
                        <strong data-i18n="ui_web_552099fd30bc">Ready for payout setup</strong>
                        <span data-i18n="ui_web_b3f5afd49a79">Only the reviewed country and status are shown here. No tax identifier is stored in this browser.</span>
                    </div>`;
                focusSetup(focus);
                renderPayout();
                return;
            }
            const canAttest = /^[A-Z]{2}$/.test(accountCountry);
            const renewal = fiscal.status === 'rejected' || fiscal.status === 'expired';
            fiscalTarget.innerHTML = `<div class="partners-setup-heading"><span>1</span><div>
                <h3 tabindex="-1" data-partners-fiscal-heading>${renewal ? (globalThis.NorvaI18n?.t("ui_web_a39002887491", { defaultValue: "Renew your tax residence attestation" }) ?? 'Renew your tax residence attestation') : (globalThis.NorvaI18n?.t("ui_web_80db3dbe21d7", { defaultValue: "Confirm your tax residence" }) ?? 'Confirm your tax residence')}</h3>
                <p data-i18n="ui_web_9d5d1c1b6b84">This statement is reviewed before payout setup can begin.</p></div></div>
                ${canAttest ? `<form class="partners-setup-form" data-partners-fiscal-form>
                    <div class="partners-setup-value"><span data-i18n="ui_web_f45163c29853">Country on your Norva account</span><strong>${this.escape(countryLabel)} · ${this.escape(accountCountry)}</strong></div>
                    <label class="partners-consent-row">
                        <input type="checkbox" data-partners-fiscal-confirm>
                        <span data-i18n="ui_web_a5f5bafa727c">I certify that this is my current country of tax residence and that this statement is accurate.</span>
                    </label>
                    <p class="partners-setup-privacy" data-i18n="ui_web_8eb339279c51">Do not enter a tax ID or upload a document. Norva does not request either in this flow. If the country is wrong, update your account before continuing.</p>
                    <button class="btn btn-primary partners-setup-action" type="submit" data-partners-fiscal-submit disabled>${renewal ? (globalThis.NorvaI18n?.t("ui_web_ad9bb451baea", { defaultValue: "Submit a new attestation" }) ?? 'Submit a new attestation') : (globalThis.NorvaI18n?.t("ui_web_d9a8f7ea25b2", { defaultValue: "Submit self-certification" }) ?? 'Submit self-certification')}</button>
                </form>` : `<div class="partners-setup-notice is-error" role="alert">
                    <strong data-i18n="ui_web_cd4e69a2cc0b">Account country unavailable</strong><span data-i18n="ui_web_13c562c936bc">Norva cannot safely create an attestation until the account country is authoritative.</span>
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
                    setStatus((globalThis.NorvaI18n?.t("ui_web_f0f9dd90ad63", { defaultValue: "Confirm the tax-residence statement before submitting." }) ?? 'Confirm the tax-residence statement before submitting.'), 'error');
                    return;
                }
                await runAction(submit, (globalThis.NorvaI18n?.t("ui_web_3e29866c88b2", { defaultValue: "Submitting securely…" }) ?? 'Submitting securely…'), async () => {
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
                        ? (globalThis.NorvaI18n?.t("ui_web_9e6716bbe2ba", { defaultValue: "Tax residence submission confirmed by Norva." }) ?? 'Tax residence submission confirmed by Norva.')
                        : (globalThis.NorvaI18n?.t("ui_web_b85e24cd96d2", { defaultValue: "Tax residence self-certification submitted for review." }) ?? 'Tax residence self-certification submitted for review.'));
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
                    <h3 data-i18n="ui_web_ad8d69d2770e">Payout destination</h3><p data-i18n="ui_web_0df54ebd2a3b">Checking the supervised Revolut setup queue…</p>
                </div></div><div class="partners-setup-skeleton" aria-hidden="true"></div>`;
                return;
            }
            if (setup.payout.phase === 'error' || setup.payout.phase === 'unavailable') {
                payoutTarget.innerHTML = `<div class="partners-setup-heading"><span>2</span><div>
                    <h3 tabindex="-1" data-partners-onboarding-heading data-i18n="ui_web_ad8d69d2770e">Payout destination</h3>
                    <p data-i18n="ui_web_a29b0dc35c67">No setup state was inferred and no request was created.</p></div></div>
                    <div class="partners-setup-notice is-error" role="alert"><strong data-i18n="ui_web_59bf264497b8">Secure queue unavailable</strong>
                    <span>${setup.payout.timedOut ? (globalThis.NorvaI18n?.t("ui_web_49653990a5d1", { defaultValue: "The request took too long. You can retry safely." }) ?? 'The request took too long. You can retry safely.') : (globalThis.NorvaI18n?.t("ui_web_e0c155e10070", { defaultValue: "Norva cannot load the Finance queue status right now." }) ?? 'Norva cannot load the Finance queue status right now.')}</span></div>
                    <button class="btn btn-secondary partners-setup-action" type="button" data-partners-onboarding-retry data-i18n="ui_web_3d790d752c00">Retry payout status</button>`;
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
                    <h3 tabindex="-1" data-partners-onboarding-heading>${inProgress ? (globalThis.NorvaI18n?.t("ui_web_d458dc0a1045", { defaultValue: "Finance is configuring your payout" }) ?? 'Finance is configuring your payout') : (globalThis.NorvaI18n?.t("ui_web_484c56d2c95a", { defaultValue: "Configuration request received" }) ?? 'Configuration request received')}</h3>
                    <p data-i18n="ui_web_c0aadb02a6a6" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p1":(this.escape(onboarding.currency))}) || "{}")}">${this.escape(onboarding.currency)} · Revolut Business manual</p></div></div>
                    <div class="partners-setup-notice is-pending" role="status">
                        <strong>${inProgress ? (globalThis.NorvaI18n?.t("ui_web_b254bf444468", { defaultValue: "Secure setup in progress" }) ?? 'Secure setup in progress') : (globalThis.NorvaI18n?.t("ui_web_4cef47f6c9e2", { defaultValue: "Waiting for Finance review" }) ?? 'Waiting for Finance review')}</strong>
                        <span data-i18n="ui_web_ae3a100f9562">Expected review window: 1–3 business days. This is a service target, not a guaranteed transfer date.</span>
                    </div>
                    <p class="partners-setup-privacy" data-i18n="ui_web_c8a5e569d500">Finance completes the destination in Revolut. No IBAN, beneficiary token or bank detail is collected here.</p>`;
                focusSetup(focus);
                return;
            }
            const needsReconfiguration = onboarding.status === 'completed'
                && onboarding.reconfiguration_required === true;
            if (onboarding.status === 'completed' && !needsReconfiguration) {
                payoutTarget.innerHTML = `<div class="partners-setup-heading"><span class="is-complete">2</span><div>
                    <h3 tabindex="-1" data-partners-onboarding-heading data-i18n="ui_web_659e4dc75998">Payout destination configured</h3>
                    <p data-i18n="ui_web_757e15b4ab2a" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(this.escape(onboarding.currency))}) || "{}")}">${this.escape(onboarding.currency)} · Revolut Business manual</p></div></div>
                    <div class="partners-setup-notice is-success" role="status"><strong data-i18n="ui_web_aadaf3595080">Setup complete</strong>
                    <span data-i18n="ui_web_f4aa3c7609e0">Your destination was finalized by Finance. Transfers still follow balance, maturation and release controls.</span></div>`;
                focusSetup(focus);
                return;
            }
            const fiscalVerified = setup.fiscal.data?.status === 'verified';
            if (!fiscalVerified) {
                payoutTarget.innerHTML = `<div class="partners-setup-heading"><span>2</span><div>
                    <h3 tabindex="-1" data-partners-onboarding-heading data-i18n="ui_web_ad8d69d2770e">Payout destination</h3><p data-i18n="ui_web_4c433b698755">Supervised Revolut configuration</p></div></div>
                    <div class="partners-setup-notice" role="status"><strong data-i18n="ui_web_3b1ca557c9fd">Waiting for tax-residence review</strong>
                    <span data-i18n="ui_web_2ba78e42c0ea">Once step 1 is reviewed, you can request secure setup without entering any bank details.</span></div>`;
                focusSetup(focus);
                return;
            }
            const currencies = setup.payout.allowedCurrencies;
            const rejected = onboarding.status === 'rejected';
            payoutTarget.innerHTML = `<div class="partners-setup-heading"><span>2</span><div>
                <h3 tabindex="-1" data-partners-onboarding-heading>${needsReconfiguration
                    ? (globalThis.NorvaI18n?.t("ui_web_5bf87ebda04b", { defaultValue: "Reconfigure your payout destination" }) ?? 'Reconfigure your payout destination')
                    : (rejected ? (globalThis.NorvaI18n?.t("ui_web_803281992d40", { defaultValue: "Request needs attention" }) ?? 'Request needs attention') : (globalThis.NorvaI18n?.t("ui_web_a88576338afc", { defaultValue: "Request payout configuration" }) ?? 'Request payout configuration'))}</h3>
                <p data-i18n="ui_web_02ffa1fe1e34">Finance completes the destination manually in Revolut Business.</p></div></div>
                ${needsReconfiguration ? `<div class="partners-setup-notice is-pending" role="status"><strong data-i18n="ui_web_c591c1d4f9c0">Previous destination is no longer active</strong>
                    <span data-i18n="ui_web_ab8fddeb777a">Request a new supervised configuration. No old bank or beneficiary detail is exposed in Norva.</span></div>` : ''}
                ${rejected ? `<div class="partners-setup-notice is-error" role="alert"><strong data-i18n="ui_web_20c590511d1e">Previous request not completed</strong>
                    <span>${this.escape(reasonMessage(onboarding.reason_code))}</span></div>` : ''}
                ${currencies.length ? `<form class="partners-setup-form" data-partners-onboarding-form>
                    <label class="partners-setup-field"><span data-i18n="ui_web_cc2e822f5bc8">Payout currency</span>
                        <select data-partners-onboarding-currency>${currencies.map((currency) => `<option value="${this.escape(currency)}">${this.escape(currency)}</option>`).join('')}</select>
                    </label>
                    <label class="partners-consent-row"><input type="checkbox" data-partners-onboarding-consent>
                        <span data-i18n="ui_web_6fb29508672d">I agree that Norva Finance may contact me through my verified Norva account channel to complete this manual setup.</span>
                    </label>
                    <p class="partners-setup-privacy" data-i18n="ui_web_d439ae1a7d0e">This request contains only your selected currency and consent. Never enter an IBAN, tax ID, card number or beneficiary token in Norva.</p>
                    <button class="btn btn-primary partners-setup-action" type="submit" data-partners-onboarding-submit disabled>${needsReconfiguration ? (globalThis.NorvaI18n?.t("ui_web_50afaf505841", { defaultValue: "Request secure reconfiguration" }) ?? 'Request secure reconfiguration') : (globalThis.NorvaI18n?.t("ui_web_a67cbc897fc6", { defaultValue: "Request secure configuration" }) ?? 'Request secure configuration')}</button>
                </form>` : `<div class="partners-setup-notice is-error" role="alert"><strong data-i18n="ui_web_24184dd21b26">No supported currency</strong>
                    <span data-i18n="ui_web_63d025b4a383">Finance has not opened a payout currency for this account policy. No request can be created.</span></div>`}`;
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
                    setStatus((globalThis.NorvaI18n?.t("ui_web_dcd7c428c124", { defaultValue: "Choose a currency and confirm secure account contact first." }) ?? 'Choose a currency and confirm secure account contact first.'), 'error');
                    return;
                }
                await runAction(submit, (globalThis.NorvaI18n?.t("ui_web_94b1ce97199d", { defaultValue: "Sending request…" }) ?? 'Sending request…'), async () => {
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
                        ? (globalThis.NorvaI18n?.t("ui_web_77163bf33f61", { defaultValue: "Payout configuration request confirmed by Norva." }) ?? 'Payout configuration request confirmed by Norva.')
                        : (globalThis.NorvaI18n?.t("ui_web_a2d11b77a79b", { defaultValue: "Secure payout configuration request sent to Finance." }) ?? 'Secure payout configuration request sent to Finance.'));
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
            account_not_active: (globalThis.NorvaI18n?.t("ui_web_ca98f88266dc", { defaultValue: "Partner account activation is required." }) ?? 'Partner account activation is required.'),
            kyc_not_verified: (globalThis.NorvaI18n?.t("ui_web_5286d93099cf", { defaultValue: "Identity verification is required." }) ?? 'Identity verification is required.'),
            fiscal_profile_required: (globalThis.NorvaI18n?.t("ui_web_8e273c21b7bc", { defaultValue: "A verified individual fiscal profile is required." }) ?? 'A verified individual fiscal profile is required.'),
            provider_not_configured: (globalThis.NorvaI18n?.t("ui_web_73a6afe4bd75", { defaultValue: "No individual payout provider is configured for this policy." }) ?? 'No individual payout provider is configured for this policy.'),
            payouts_not_live: (globalThis.NorvaI18n?.t("ui_web_4b3ae3e73b36", { defaultValue: "The payout release gate is not live." }) ?? 'The payout release gate is not live.')
        };
        const readiness = data.readiness.ready
            ? (globalThis.NorvaI18n?.t("ui_web_18d360243119", { defaultValue: "Ready for the next supervised payout cycle" }) ?? 'Ready for the next supervised payout cycle')
            : (reasonCopy[data.readiness.reason] || (globalThis.NorvaI18n?.t("ui_web_efeb1d456ecb", { defaultValue: "Payout setup is not ready." }) ?? 'Payout setup is not ready.'));
        const destinationRows = destinations.length
            ? destinations.map((destination) => `
                <div><dt data-i18n="ui_web_2f04f8812543" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(this.escape(destination.currency))}) || "{}")}">${this.escape(destination.currency)} destination</dt>
                <dd>${this.escape(this.payoutProviderLabel(destination.provider))} · ${this.escape(destination.display_masked)} · ${this.escape(destination.status)}</dd></div>`).join('')
            : '<div><dt data-i18n="ui_web_293d404a500f">Destination</dt><dd data-i18n="ui_web_77ad18677042">Not provisioned</dd></div>';
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
                    <div><span class="partners-eyebrow" data-i18n="ui_web_f4223b67967a">Secure payout profile</span>
                    <h2 id="partners-payout-title" data-i18n="ui_web_25d5b5796484">Payout readiness</h2></div>
                    <button class="partners-country-close" type="button"
                        data-partners-payout-close aria-label="Close payout profile" data-i18n-aria-label="ui_web_eff56fc8e08f">×</button>
                </header>
                <div class="partners-payout-summary">
                    <strong>${this.escape(readiness)}</strong>
                    <span>${data.readiness.payouts_live
                        ? (globalThis.NorvaI18n?.t("ui_web_ebd02866ec1e", { defaultValue: "The live release gate is enabled." }) ?? 'The live release gate is enabled.')
                        : (globalThis.NorvaI18n?.t("ui_web_43acf0568158", { defaultValue: "The live release gate remains disabled; no transfer is triggered from this page." }) ?? 'The live release gate remains disabled; no transfer is triggered from this page.')}</span>
                </div>
                <dl class="partners-program-facts" aria-label="Masked payout destinations" data-i18n-aria-label="ui_web_bb2def64fdd9">
                    ${destinationRows}
                    <div><dt data-i18n="ui_web_1989ea9fe843">Fiscal profile</dt><dd>${this.escape(data.fiscal?.status || 'missing')}${data.fiscal?.country_code ? ` · ${this.escape(data.fiscal.country_code)}` : ''}</dd></div>
                </dl>
                <p id="partners-payout-copy" data-i18n="ui_web_28b59b5138a4">Manual Revolut destinations are provisioned by Norva Finance after your request. Revolut Business Basic remains a supervised manual process. This page never accepts an IBAN, card number, tax identifier or beneficiary token.</p>
                <div class="partners-payout-setup" aria-label="Payout setup steps" data-i18n-aria-label="ui_web_08a9c43b2511">
                    <section class="partners-setup-step" data-partners-fiscal-step aria-busy="true"></section>
                    <section class="partners-setup-step" data-partners-onboarding-step aria-busy="true"></section>
                </div>
                <div class="partners-actions partners-actions-row">
                    <button class="btn btn-secondary" type="button" data-partners-payout-refresh data-i18n="ui_web_41af9469c0b3">Refresh secure status</button>
                    <button class="btn btn-primary" type="button" data-partners-payout-close data-i18n="ui_web_7d9eb7acb13e">Close</button>
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
            refreshButton.textContent = (globalThis.NorvaI18n?.t("ui_web_1c0def7be060", { defaultValue: "Refreshing…" }) ?? 'Refreshing…');
            if (dialogStatus) dialogStatus.textContent = (globalThis.NorvaI18n?.t("ui_web_ce78c33b3646", { defaultValue: "Refreshing the authoritative payout profile." }) ?? 'Refreshing the authoritative payout profile.');
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
            refreshButton.textContent = (globalThis.NorvaI18n?.t("ui_web_dad78c2c4582", { defaultValue: "Retry secure status" }) ?? 'Retry secure status');
            if (dialogStatus) {
                dialogStatus.setAttribute('role', 'alert');
                dialogStatus.setAttribute('aria-live', 'assertive');
                dialogStatus.textContent = (globalThis.NorvaI18n?.t("ui_web_6b09527e86eb", { defaultValue: "Payout status is still unavailable. No financial value was inferred." }) ?? 'Payout status is still unavailable. No financial value was inferred.');
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
                    <div><span class="partners-eyebrow" data-i18n="ui_web_71df640628ff">Personal referral link</span>
                    <h2 id="partners-qr-title" data-i18n="ui_web_3af8e3d7d5af">Scan to open Norva</h2></div>
                    <button class="partners-country-close" type="button"
                        data-partners-qr-close aria-label="Close QR code" data-i18n-aria-label="ui_web_c1733a0a4012">×</button>
                </header>
                <div class="partners-qr-code" data-partners-qr-code role="img"
                    aria-label="QR code for your personal Norva referral link" data-i18n-aria-label="ui_web_d5f54c07237f"></div>
                <p class="partners-disclosure" id="partners-qr-disclosure"
                    data-partners-qr-disclosure><strong data-i18n="ui_web_cc8726ed021a">Required partner disclosure:</strong>
                    ${this.escape(disclosure)}</p>
                <p id="partners-qr-copy"><norva-i18n data-i18n="ui_web_a7bb8b4d2a29">The QR encodes only your active server-issued </norva-i18n><strong data-i18n="ui_web_d28cc747fdd3">norva.tv</strong><norva-i18n data-i18n="ui_web_4e09ec10cdf0"> referral URL. It contains no balance, e-mail or KYC data.</norva-i18n></p>
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
            target.innerHTML = '<span data-i18n="ui_web_1dafb5c0578b">QR rendering unavailable. Copy or share the secure link instead.</span>';
        }
    }

    renderUnavailable({ title, copy, tone, retry = false, program = null }) {
        if (!this.container) return;
        const stateLabel = tone === 'offline' ? (globalThis.NorvaI18n?.t("ui_web_a1794783aab7", { defaultValue: "Offline" }) ?? 'Offline') : (tone === 'error' ? (globalThis.NorvaI18n?.t("ui_web_ca1844969742", { defaultValue: "Unavailable" }) ?? 'Unavailable') : (globalThis.NorvaI18n?.t("ui_web_0bb4154dae5a", { defaultValue: "Programme status" }) ?? 'Programme status'));
        this.container.innerHTML = `
            <main class="partners-shell" aria-labelledby="partners-title">
                ${this.header((globalThis.NorvaI18n?.t("ui_web_eaff23c82663", { defaultValue: "Norva Partners" }) ?? 'Norva Partners'))}
                <section class="partners-state-card">
                    <span class="partners-status-pill">${this.escape(stateLabel)}</span>
                    <h1 id="partners-title" tabindex="-1">${this.escape(title)}</h1>
                    <p>${this.escape(copy)}</p>
                    ${this.programWindowNote(program)}
                    <div class="partners-actions partners-actions-row">
                        ${retry ? '<button class="btn btn-primary" type="button" data-partners-retry data-i18n="ui_web_d8b8392e2c54">Try again</button>' : ''}
                        <button class="btn btn-secondary" type="button" data-partners-back data-i18n="ui_web_76900f1bfd16">Back</button>
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
                <button class="partners-back" type="button" data-partners-back aria-label="Back from Norva Partners" data-i18n-aria-label="ui_web_7ac66b66d60b">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
                    <span data-i18n="ui_web_76900f1bfd16">Back</span>
                </button>
                <div>
                    <span class="partners-header-context" data-i18n="ui_web_74a883a037bc">Settings</span>
                    <strong${titleId ? ` id="${this.escape(titleId)}" tabindex="-1"` : ''}>${this.escape(title)}</strong>
                </div>
            </header>`;
    }

    steps(program = null) {
        const maturation = Number.isSafeInteger(program?.maturation_days)
            && program.maturation_days >= 0
            ? `${program.maturation_days} days`
            : (globalThis.NorvaI18n?.t("ui_web_c35a61e8e1a2", { defaultValue: "the server-published validation period" }) ?? 'the server-published validation period');
        return `
            <section class="partners-steps" aria-label="How Norva Partners works" data-i18n-aria-label="ui_web_bc22d0782a5e">
                <article><span>1</span><div><h2 data-i18n="ui_web_62eecbe40e4a">Share your personal link</h2><p data-i18n="ui_web_ce130c6ecc8b">A unique opaque link is generated only after server verification.</p></div></article>
                <article><span>2</span><div><h2 data-i18n="ui_web_c5c2afed0d49">They subscribe to Norva</h2><p data-i18n="ui_web_6f5770b085d8">Direct referrals are attributed without revealing their identity to you.</p></div></article>
                <article><span>3</span><div><h2 data-i18n="ui_web_b4051f175728">You earn on eligible renewals</h2><p data-i18n="ui_web_29eee4cf6c1d" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(this.escape(maturation))}) || "{}")}">Commission matures after ${this.escape(maturation)} and follows refunds or chargebacks.</p></div></article>
            </section>`;
    }

    membershipSteps(program) {
        const maturation = Number.isSafeInteger(program?.maturation_days)
            ? `${program.maturation_days} days`
            : (globalThis.NorvaI18n?.t("ui_web_d00a9af21c4c", { defaultValue: "the published validation period" }) ?? 'the published validation period');
        return `
            <section class="partners-steps" aria-label="How the flexible Norva Partners balance works" data-i18n-aria-label="ui_web_d891d1c9b1b1">
                <article><span>1</span><div><h2 data-i18n="ui_web_cd085a7518f0">Join and share now</h2><p data-i18n="ui_web_a558451372da">Your confirmed Norva account gets a personal link immediately. No identity documents are needed.</p></div></article>
                <article><span>2</span><div><h2 data-i18n="ui_web_c7cc1500bddf">Watch balance mature</h2><p data-i18n="ui_web_bd8ace99fcf3" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(this.escape(maturation))}) || "{}")}">Eligible commission normally stays pending for at least ${this.escape(maturation)}, then becomes available after checks.</p></div></article>
                <article><span>3</span><div><h2 data-i18n="ui_web_2b8c509416af">Choose access or cash</h2><p data-i18n="ui_web_66b86594f371">Use available balance for Norva access without identity verification, or complete verification only when requesting cash.</p></div></article>
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
        return `<p class="partners-program-note"><strong data-i18n="ui_web_40f3bbd8c249">Attribution window:</strong><norva-i18n data-i18n="ui_web_f1d0c7781c0e" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(days)}) || "{}")}"> ${days} days from the eligible referral visit. This tracking window does not guarantee eligibility or earnings.</norva-i18n></p>`;
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
                    status.textContent = (globalThis.NorvaI18n?.t("ui_web_e553f9b8a679", { defaultValue: "Enter a two-letter country code and, if needed, a matching state or region code." }) ?? 'Enter a two-letter country code and, if needed, a matching state or region code.');
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
                status.textContent = (globalThis.NorvaI18n?.t("ui_web_8244d327e5fd", { defaultValue: "Checking the server policy for this jurisdiction." }) ?? 'Checking the server policy for this jurisdiction.');
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
                : (countryCode || (globalThis.NorvaI18n?.t("ui_web_19323e2d92e7", { defaultValue: "Choose a country" }) ?? 'Choose a country'));
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
                list.innerHTML = '<li class="region-picker-empty" role="presentation" data-i18n="ui_web_b8341fde7056">No matching country. Use the ISO code option below.</li>';
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
                status.textContent = (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_a81cf42492e6", {defaultValue: "{{p0}} selected.", p0:(country.name)}) : `${country.name} selected.`);
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
        return `${new Intl.NumberFormat(globalThis.NorvaI18n?.language, { maximumFractionDigits: 2 }).format(value)}%`;
    }

    statusLabel(value, fallback) {
        const labels = {
            invited: (globalThis.NorvaI18n?.t("ui_web_63b17becd812", { defaultValue: "Invited" }) ?? 'Invited'),
            pending_verification: (globalThis.NorvaI18n?.t("ui_web_417a6b7e1904", { defaultValue: "Pending verification" }) ?? 'Pending verification'),
            active: (globalThis.NorvaI18n?.t("ui_web_92340695899b", { defaultValue: "Active" }) ?? 'Active'),
            held: (globalThis.NorvaI18n?.t("ui_web_ebe7db36e495", { defaultValue: "On hold" }) ?? 'On hold'),
            suspended: (globalThis.NorvaI18n?.t("ui_web_e392a3891c07", { defaultValue: "Suspended" }) ?? 'Suspended'),
            closed: (globalThis.NorvaI18n?.t("ui_web_c21ead0614e7", { defaultValue: "Closed" }) ?? 'Closed'),
            not_started: (globalThis.NorvaI18n?.t("ui_web_ba35f0c47d86", { defaultValue: "Not started" }) ?? 'Not started'),
            pending: (globalThis.NorvaI18n?.t("ui_web_331551b0de41", { defaultValue: "Pending" }) ?? 'Pending'),
            verified: (globalThis.NorvaI18n?.t("ui_web_4f7838402f37", { defaultValue: "Verified" }) ?? 'Verified'),
            failed: (globalThis.NorvaI18n?.t("ui_web_031a8f0f659d", { defaultValue: "Failed" }) ?? 'Failed'),
            expired: (globalThis.NorvaI18n?.t("ui_web_424a2551d356", { defaultValue: "Expired" }) ?? 'Expired'),
            not_accepted: (globalThis.NorvaI18n?.t("ui_web_8ba391628be0", { defaultValue: "Not accepted" }) ?? 'Not accepted'),
            accepted: (globalThis.NorvaI18n?.t("ui_web_a00fb0c50741", { defaultValue: "Accepted" }) ?? 'Accepted'),
            none: (globalThis.NorvaI18n?.t("ui_web_1d1827745b69", { defaultValue: "Not created" }) ?? 'Not created'),
            revoked: (globalThis.NorvaI18n?.t("ui_web_f6f738d04392", { defaultValue: "Revoked" }) ?? 'Revoked')
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
