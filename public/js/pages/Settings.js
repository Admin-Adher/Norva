/**
 * Settings Page Controller
 * (asset-rev: settings-def-2 — content-hash bump to bypass a poisoned edge cache)
 */

// Native shell = Android phone/TV APK WebView. Mirrors the detection used in
// app.html / account.html (UA tag, injected native bridges, or the ?mobile=1
// param). Billing management and the web household dashboard are hidden inside
// native shells: app stores forbid steering to web/Stripe payment for digital
// goods, and cloud.html is a web account surface, not an in-app screen.
function isNativeShell() {
    const ua = navigator.userAgent || '';
    return /NorvaTV-/i.test(ua) || !!window.NorvaTVCloud || !!window.NodeCastNative
        || /[?&]mobile=1\b/.test(window.location.search || '');
}

function isTvSettingsShell() {
    return document.documentElement?.classList?.contains('tv-mode')
        || /NorvaTV-AndroidTV/i.test(navigator.userAgent || '')
        || /[?&]tv=1\b/.test(window.location?.search || '');
}

// Settings navigation is intentionally persisted at two complementary levels:
// the hash makes refresh/deep-links explicit, while sessionStorage restores the
// last section when another app surface navigates to the generic #settings route.
// Only public section identifiers are stored; no account or provider data enters
// browser storage.
const SETTINGS_TAB_STORAGE_KEY = 'norva-settings-tab-v1';
const SETTINGS_TAB_NAMES = new Set([
    'account',
    'screens',
    'player',
    'sources',
    'content',
    'transcode',
    'users',
]);

function normalizeSettingsTab(value) {
    const tabName = String(value || '').trim().toLowerCase();
    return SETTINGS_TAB_NAMES.has(tabName) ? tabName : '';
}

function settingsTabFromHash(hashValue) {
    const route = String(hashValue || '').replace(/^#/, '');
    const separator = route.indexOf('/');
    if (separator < 0 || route.slice(0, separator) !== 'settings') return '';
    try {
        // Lifecycle help may append a bounded context suffix after the tab
        // (`settings/sources/help/<family>/<type>`). Only the first segment is a
        // Settings destination; the App router validates the remaining segments.
        return normalizeSettingsTab(decodeURIComponent(route.slice(separator + 1).split('/')[0]));
    } catch (_) {
        return '';
    }
}

function readPersistedSettingsTab() {
    try {
        return normalizeSettingsTab(sessionStorage.getItem(SETTINGS_TAB_STORAGE_KEY));
    } catch (_) {
        return '';
    }
}

function writePersistedSettingsTab(tabName) {
    try {
        sessionStorage.setItem(SETTINGS_TAB_STORAGE_KEY, tabName);
    } catch (_) { /* storage can be unavailable in hardened WebViews */ }
}

window.NorvaSettingsNavigation = Object.freeze({
    normalizeTab: normalizeSettingsTab,
    tabFromHash: settingsTabFromHash,
    readPersistedTab: readPersistedSettingsTab,
    storageKey: SETTINGS_TAB_STORAGE_KEY,
});

// True once the native APK exposes the Play Billing purchase bridge. In-app
// purchase is allowed by stores (only external web payment links are not), so
// when this bridge is present we can surface an in-app "Subscribe" action.
const PLAY_BILLING_TEST_EMAILS = ['customersuccess.kang@gmail.com'];

function isPlayBillingTestAccount(app) {
    const email = String(app?.currentUser?.email || window.NorvaAuth?.getSession?.()?.user?.email || '')
        .trim()
        .toLowerCase();
    return PLAY_BILLING_TEST_EMAILS.indexOf(email) !== -1;
}

function nativePlayBillingChannelReady() {
    if (isTvSettingsShell()) return false;
    if (window.NorvaBilling && typeof window.NorvaBilling.hasNativeBilling === 'function') {
        return window.NorvaBilling.hasNativeBilling() === true;
    }
    const channel = window.NorvaBillingNative;
    return !!(channel && typeof channel.postMessage === 'function');
}

function nativeBillingReady(app) {
    const bridge = window.NorvaTVCloud || window.NodeCastNative;
    if (bridge && typeof bridge.purchase === 'function') return true;
    return isPlayBillingTestAccount(app) && nativePlayBillingChannelReady();
}

class SettingsPage {
    constructor(app) {
        this.app = app;
        this.devicesScreensModule = null;
        const settingsRoot = document.getElementById('page-settings');
        this.tabs = settingsRoot?.querySelectorAll('.tabs .tab') || [];
        this.tabContents = settingsRoot?.querySelectorAll('.tab-content') || [];

        this.init();
    }

    init() {
        this.applyCapabilityPolicy();
        this.initTabSemantics();
        // Tab switching
        this.tabs.forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
            tab.addEventListener('keydown', (event) => this.handleSettingsTabKeydown(event, tab));
        });

        // Phone-only "Advanced" toggle: reveals the collapsed IPTV-technical tabs.
        const advToggle = document.getElementById('settings-advanced-toggle');
        advToggle?.addEventListener('click', () => {
            const tabsEl = document.querySelector('.settings-container .tabs');
            const open = tabsEl?.classList.toggle('show-advanced');
            advToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        // Account and TV service overview
        this.initAccountSettings();

        // Player settings
        this.initPlayerSettings();

        // Content & discovery settings (dedup grouping, TMDB)
        this.initContentSettings();

        // Transcoding settings
        this.initTranscodingSettings();

        // User management (admin only)
        this.initUserManagement();
    }

    applyCapabilityPolicy() {
        if (!isTvSettingsShell()) return;
        const allowed = new Set(['account', 'player', 'sources']);
        this.tabs.forEach((tab) => {
            const available = allowed.has(tab.dataset.tab);
            tab.hidden = !available;
            tab.setAttribute('aria-hidden', available ? 'false' : 'true');
            if (!available) tab.tabIndex = -1;
            if (tab.dataset.tab === 'player') {
                const label = tab.querySelector('span');
                if (label) {
                    label.setAttribute('data-i18n', 'ui_playback');
                    label.textContent = window.NorvaI18n?.t('ui_playback') || 'Playback';
                }
            }
        });
        const advanced = document.getElementById('settings-advanced-toggle');
        if (advanced) {
            advanced.hidden = true;
            advanced.setAttribute('aria-hidden', 'true');
        }
    }

    initTabSemantics() {
        const tabList = document.querySelector('#page-settings .settings-container > .tabs');
        if (tabList) {
            tabList.setAttribute('role', 'tablist');
            tabList.setAttribute('aria-label', window.NorvaI18n?.t('ui_settings_sections') || 'Settings sections');
            tabList.setAttribute('aria-orientation', isTvSettingsShell() || window.matchMedia('(min-width: 769px)').matches
                ? 'vertical'
                : 'horizontal');
        }
        this.tabs.forEach((tab) => {
            const name = tab.dataset.tab;
            const panel = document.getElementById(`tab-${name}`);
            if (!name || !panel) return;
            if (!tab.id) tab.id = `settings-tab-${name}`;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-controls', panel.id);
            const selected = tab.classList.contains('active');
            tab.setAttribute('aria-selected', selected ? 'true' : 'false');
            tab.tabIndex = selected ? 0 : -1;
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', tab.id);
            panel.setAttribute('aria-hidden', selected ? 'false' : 'true');
            panel.tabIndex = 0;
            panel.hidden = !selected;
        });
    }

    handleSettingsTabKeydown(event, currentTab) {
        // Logical tab traversal remains Left/Right on touch/web. The TV D-pad
        // uses the vertical rail graph in tvNavigation.js.
        const tabKeys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
        const vertical = currentTab.closest('[role="tablist"]')?.getAttribute('aria-orientation') === 'vertical';
        const rtl = document.documentElement?.dir === 'rtl';
        const previousKey = vertical ? 'ArrowUp' : (rtl ? 'ArrowRight' : 'ArrowLeft');
        const nextKey = vertical ? 'ArrowDown' : (rtl ? 'ArrowLeft' : 'ArrowRight');
        if (!(vertical ? [previousKey, nextKey, 'Home', 'End'] : tabKeys).includes(event.key)) return;
        const available = [...this.tabs].filter((tab) => !tab.disabled
            && !tab.hidden
            && tab.style.display !== 'none'
            && tab.getAttribute('aria-hidden') !== 'true');
        if (!available.length) return;
        const currentIndex = Math.max(0, available.indexOf(currentTab));
        let nextIndex = currentIndex;
        if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = available.length - 1;
        else if (event.key === nextKey) nextIndex = (currentIndex + 1) % available.length;
        else nextIndex = (currentIndex - 1 + available.length) % available.length;
        event.preventDefault();
        const next = available[nextIndex];
        this.switchTab(next.dataset.tab);
        next.focus();
    }

    initAccountSettings() {
        document.getElementById('settings-open-account')?.addEventListener('click', () => {
            this.openSignInSettings();
        });

        document.getElementById('settings-switch-profile')?.addEventListener('click', () => {
            window.NorvaProfiles?.openSwitcher?.();
        });

        document.getElementById('settings-tv-switch-profile')?.addEventListener('click', () => {
            window.NorvaProfiles?.openSwitcher?.();
        });

        document.getElementById('settings-signout-btn')?.addEventListener('click', () => this.signOut());
        document.getElementById('settings-tv-signout-btn')?.addEventListener('click', () => this.signOut());

        document.getElementById('settings-tv-handoff-btn')?.addEventListener('click', () => this.showTvHandoffInstructions());
        document.getElementById('settings-tv-service-instructions-btn')?.addEventListener('click', () => this.showTvHandoffInstructions(true));
        document.getElementById('settings-tv-legal-btn')?.addEventListener('click', () => this.showTvLegalInstructions());

        document.getElementById('settings-open-partners')?.addEventListener('click', (event) => {
            this.app?.openPartners?.(event.currentTarget);
        });

        document.getElementById('settings-manage-plan-btn')?.addEventListener('click', () => {
            const returnTo = window.location.pathname + window.location.search + '#settings';
            // A real membership → the management screen (status, cancel, update
            // payment); otherwise → the plan picker. Routed on the REAL status —
            // the membership exists in the decision even while billing is only
            // observed, so gating this on `enforced` would wrongly send a trialing
            // user to the plan picker. Both web and native are store-allowed for
            // in-app management/purchase (only external payment links are not).
            const ent = this.app?.entitlement || window.NorvaEntitlement;
            const st = String(ent?.status || '').toLowerCase();
            const hasSub =
                ['active', 'trialing', 'cancelled_at_period_end', 'past_due', 'grace'].indexOf(st) !== -1;
            const dest = hasSub ? '/subscription.html' : '/subscribe.html';
            window.location.href = dest + '?returnTo=' + encodeURIComponent(returnTo);
        });

        // Support tickets: dedicated page (open a ticket, see replies) — replies
        // also arrive by email, and the CRM tracks the whole thread.
        document.getElementById('settings-support-btn')?.addEventListener('click', () => {
            const returnTo = window.location.pathname + window.location.search + '#settings';
            window.location.href = '/support.html?returnTo=' + encodeURIComponent(returnTo);
        });

        // Cookie consent: a low-key link that reopens the consent banner so a
        // user can change or withdraw their choice (GDPR right to withdraw).
        document.getElementById('settings-cookie-prefs-btn')?.addEventListener('click', (event) => {
            event.preventDefault();
            window.NorvaConsent?.open();
        });

        // Account deletion uses the dedicated page (session-aware, typed
        // confirmation), which also works inside the APK WebView and is the same
        // public URL Play requires for web-based deletion.
        document.getElementById('settings-delete-account-btn')?.addEventListener('click', () => {
            window.location.href = '/delete-account.html';
        });

        document.getElementById('settings-service-health')?.addEventListener('click', (event) => {
            const actionButton = event.target.closest('[data-source-health-action]');
            if (!actionButton) return;

            const action = actionButton.dataset.sourceHealthAction;
            if (action === 'show-instructions') {
                this.showTvHandoffInstructions(true);
                return;
            }
            if (action === 'view-progress' && this.lastSourceHealthSummary && window.NorvaSourceHealth?.openProgress) {
                window.NorvaSourceHealth.openProgress(this.lastSourceHealthSummary, this.app);
                return;
            }

            if (action === 'open-sources') {
                if (this.lastSourceHealthSummary && window.NorvaSourceHealth?.openAction) {
                    window.NorvaSourceHealth.openAction(this.lastSourceHealthSummary, this.app);
                } else {
                    this.switchTab('sources');
                }
            }
        });

        document.getElementById('settings-tv-service-health')?.addEventListener('click', (event) => {
            const actionButton = event.target.closest('[data-source-health-action]');
            if (!actionButton) return;
            if (actionButton.dataset.sourceHealthAction === 'show-instructions') {
                this.showTvHandoffInstructions(true);
                return;
            }
            if (actionButton.dataset.sourceHealthAction === 'open-sources') {
                this.showTvHandoffInstructions(true);
            }
        });
    }

    showTvHandoffInstructions(serviceSpecific = false) {
        const title = serviceSpecific ? (globalThis.NorvaI18n?.t("ui_web_6667254de8e3", { defaultValue: "Review your TV service" }) ?? 'Review your TV service') : (globalThis.NorvaI18n?.t("ui_web_cd4a1e00601e", { defaultValue: "Manage your Norva account" }) ?? 'Manage your Norva account');
        const message = serviceSpecific
            ? (globalThis.NorvaI18n?.t("ui_web_c318d019a54f", { defaultValue: "Open norva.tv/account on a phone, tablet or computer to review your TV service. This TV never asks for provider credentials." }) ?? 'Open norva.tv/account on a phone, tablet or computer to review your TV service. This TV never asks for provider credentials.')
            : (globalThis.NorvaI18n?.t("ui_web_78ea60582e38", { defaultValue: "Open norva.tv/account on a phone, tablet or computer to manage your plan, payment method and library sources." }) ?? 'Open norva.tv/account on a phone, tablet or computer to manage your plan, payment method and library sources.');
        if (window.NorvaModal?.alert) {
            window.NorvaModal.alert(message, { title, confirmLabel: (globalThis.NorvaI18n?.t("ui_web_11a6767d5674", { defaultValue: "Done" }) ?? 'Done') });
            return;
        }
        window.alert?.(message);
    }

    showTvLegalInstructions() {
        if (window.NorvaModal?.alert) {
            window.NorvaModal.alert(
                (globalThis.NorvaI18n?.t("ui_web_420359a59790", { defaultValue: "Privacy Policy: norva.tv/privacy.html\nTerms: norva.tv/terms.html\nLegal notice: norva.tv/mentions-legales.html" }) ?? 'Privacy Policy: norva.tv/privacy.html\nTerms: norva.tv/terms.html\nLegal notice: norva.tv/mentions-legales.html'),
                { title: (globalThis.NorvaI18n?.t("ui_web_4afba636b446", { defaultValue: "Privacy & legal" }) ?? 'Privacy & legal'), confirmLabel: (globalThis.NorvaI18n?.t("ui_web_11a6767d5674", { defaultValue: "Done" }) ?? 'Done') }
            );
            return;
        }
        window.alert?.((globalThis.NorvaI18n?.t("ui_web_420359a59790", { defaultValue: "Privacy Policy: norva.tv/privacy.html\nTerms: norva.tv/terms.html\nLegal notice: norva.tv/mentions-legales.html" }) ?? 'Privacy Policy: norva.tv/privacy.html\nTerms: norva.tv/terms.html\nLegal notice: norva.tv/mentions-legales.html'));
    }

    // "Sign-in settings" as a lightweight in-context modal rather than a full-page
    // bounce: account email + change password + a reset-email fallback.
    openSignInSettings() {
        const modal = document.getElementById('modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        const footer = document.getElementById('modal-footer');
        // Fall back to the standalone page if the in-app modal/auth isn't available.
        if (!modal || !title || !body || !window.NorvaAuth?.updatePassword) {
            const returnTo = window.location.pathname + window.location.search + '#settings';
            window.location.href = '/account.html?manage=1&returnTo=' + encodeURIComponent(returnTo);
            return;
        }

        const email = this.app?.currentUser?.email
            || window.NorvaAuth?.getSession?.()?.user?.email || '';
        const inputStyle = 'width:100%;min-height:44px;padding:0 12px;border-radius:8px;border:1px solid #344158;background:#0b0f16;color:#f8fafc;font:inherit';

        title.textContent = (globalThis.NorvaI18n?.t("ui_web_e2271e438428", { defaultValue: "Sign-in settings" }) ?? 'Sign-in settings');
        if (footer) footer.innerHTML = '';
        body.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:14px">
              <div>
                <div class="setting-label" data-i18n="ui_web_abc50e334be4">Signed in as</div>
                <strong id="ss-email" style="color:#f8fafc"></strong>
              </div>
              <div>
                <div class="setting-label" style="margin-bottom:6px" data-i18n="ui_web_477be8678405">Sign-in methods</div>
                <div id="ss-methods" style="display:flex;flex-direction:column;gap:8px">
                  <p class="setting-hint" style="margin:0" data-i18n="ui_web_ba3bbbe10d8b">Loading…</p>
                </div>
              </div>
              <div id="ss-current-row" style="display:none">
                <label class="setting-label" for="ss-current" style="display:block;margin-bottom:6px" data-i18n="ui_web_72ed2bd767ce">Current password</label>
                <input id="ss-current" type="password" autocomplete="current-password" placeholder="Your current password" style="${inputStyle}" data-i18n-placeholder="ui_web_4e2baa8d5f44">
              </div>
              <div>
                <label class="setting-label" for="ss-new" id="ss-pwd-heading" style="display:block;margin-bottom:6px" data-i18n="ui_web_3dd9df4441fb">New password</label>
                <input id="ss-new" type="password" autocomplete="new-password" minlength="6" placeholder="At least 6 characters" style="${inputStyle}" data-i18n-placeholder="ui_web_85347d171d7d">
              </div>
              <div>
                <label class="setting-label" for="ss-confirm" style="display:block;margin-bottom:6px" data-i18n="ui_web_bf000421aeb3">Confirm new password</label>
                <input id="ss-confirm" type="password" autocomplete="new-password" minlength="6" style="${inputStyle}">
              </div>
              <p id="ss-status" class="setting-hint" role="status" aria-live="polite" aria-atomic="true" style="min-height:18px;margin:0"></p>
              <p class="setting-hint" style="margin:0"><a id="ss-reset" href="#" style="color:#5b7cfa" data-i18n="ui_web_17cceb2f9a1c">Send a password reset email instead</a></p>
              <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px">
                <button class="btn btn-secondary" id="ss-cancel" type="button" data-i18n="ui_web_7d9eb7acb13e">Close</button>
                <button class="btn btn-primary" id="ss-update" type="button" data-i18n="ui_web_fe45b4014135">Update password</button>
              </div>
            </div>`;

        const emailEl = document.getElementById('ss-email');
        if (emailEl) emailEl.textContent = email || (globalThis.NorvaI18n?.t("ui_web_17a7e5cfee17", { defaultValue: "your account" }) ?? 'your account');

        const close = () => modal.classList.remove('active');
        const closeX = modal.querySelector('.modal-close');
        if (closeX) closeX.onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };

        const status = document.getElementById('ss-status');
        const newInput = document.getElementById('ss-new');
        const confirmInput = document.getElementById('ss-confirm');
        const setStatus = (msg, isError) => {
            if (!status) return;
            status.textContent = msg;
            status.setAttribute('role', isError ? 'alert' : 'status');
            status.setAttribute('aria-live', isError ? 'assertive' : 'polite');
            status.style.color = isError ? '#fb7185' : '#34d399';
        };

        document.getElementById('ss-cancel')?.addEventListener('click', close);
        document.getElementById('ss-update')?.addEventListener('click', async () => {
            const pwd = newInput?.value || '';
            const confirmPwd = confirmInput?.value || '';
            if (pwd.length < 6) { setStatus((globalThis.NorvaI18n?.t("ui_web_1da023356624", { defaultValue: "Password must be at least 6 characters." }) ?? 'Password must be at least 6 characters.'), true); newInput?.focus(); return; }
            if (pwd !== confirmPwd) { setStatus((globalThis.NorvaI18n?.t("ui_web_f694aaa8da2c", { defaultValue: "The passwords do not match." }) ?? 'The passwords do not match.'), true); confirmInput?.focus(); return; }
            const currentRow = document.getElementById('ss-current-row');
            const currentInput = document.getElementById('ss-current');
            const needsReauth = !!currentRow && currentRow.style.display !== 'none';
            const currentPwd = currentInput?.value || '';
            if (needsReauth && !currentPwd) { setStatus((globalThis.NorvaI18n?.t("ui_web_cf4d205e451d", { defaultValue: "Enter your current password." }) ?? 'Enter your current password.'), true); currentInput?.focus(); return; }
            const btn = document.getElementById('ss-update');
            if (btn) btn.disabled = true;
            setStatus((globalThis.NorvaI18n?.t("ui_web_dfe40efe921f", { defaultValue: "Updating…" }) ?? 'Updating…'), false);
            try {
                // Premium/Netflix-grade: verify the CURRENT password (re-authenticate) before
                // changing it, so a momentarily-unlocked session can't silently take over the
                // account. Skipped for the passwordless "Add a password" case.
                if (needsReauth) {
                    try {
                        await window.NorvaAuth.signIn({ email, password: currentPwd });
                    } catch (_) {
                        setStatus((globalThis.NorvaI18n?.t("ui_web_7bd90cab5f6d", { defaultValue: "Current password is incorrect." }) ?? 'Current password is incorrect.'), true);
                        if (btn) btn.disabled = false;
                        currentInput?.focus();
                        return;
                    }
                }
                await window.NorvaAuth.updatePassword(pwd);
                setStatus((globalThis.NorvaI18n?.t("ui_web_df01ff0dd6ed", { defaultValue: "Password updated." }) ?? 'Password updated.'), false);
                if (newInput) newInput.value = '';
                if (confirmInput) confirmInput.value = '';
                if (currentInput) currentInput.value = '';
                this.populateSignInMethods(); // reflect that email+password is now a method
                setTimeout(close, 900);
            } catch (e) {
                console.warn('[Settings] Password update failed.', e);
                setStatus((globalThis.NorvaI18n?.t("ui_web_a0d6f43c574a", { defaultValue: "Could not update the password. Check your connection and try again." }) ?? 'Could not update the password. Check your connection and try again.'), true);
                if (btn) btn.disabled = false;
            }
        });
        document.getElementById('ss-reset')?.addEventListener('click', async (e) => {
            e.preventDefault();
            if (!email) { setStatus((globalThis.NorvaI18n?.t("ui_web_0d6f32edd2f4", { defaultValue: "No email on file for a reset link." }) ?? 'No email on file for a reset link.'), true); return; }
            try {
                await window.NorvaAuth.recover(email);
                setStatus((globalThis.NorvaI18n?.t("ui_web_7f35bafafb23", { defaultValue: "Reset email sent — check your inbox." }) ?? 'Reset email sent — check your inbox.'), false);
            } catch (err) {
                console.warn('[Settings] Password reset email failed.', err);
                setStatus((globalThis.NorvaI18n?.t("ui_web_1054d48f2a02", { defaultValue: "Could not send the reset email. Try again in a moment." }) ?? 'Could not send the reset email. Try again in a moment.'), true);
            }
        });

        modal.classList.add('active');
        this.populateSignInMethods();
        // Escape/Back close, Tab focus-trap, focus restore — unified with NorvaModal (also
        // tears its own listeners down when tvNavigation closes the modal on TV).
        if (window.NorvaModal?.installHygiene) NorvaModal.installHygiene(modal, { onClose: close, initialFocus: newInput });
        setTimeout(() => { try { newInput?.focus(); } catch (_) { } }, 50);
    }

    // Populate the "Sign-in methods" list from the account's linked identities and
    // adapt the password section: a Google-only account (no email/password identity)
    // sees "Add a password" so it can gain email+password sign-in on the SAME account.
    async populateSignInMethods() {
        const methodsEl = document.getElementById('ss-methods');
        if (!methodsEl) return;

        // Authoritative auth state. Whether a USABLE password exists lives only in
        // auth.users.encrypted_password — not in the client user object and not on
        // auth.identities (a magic-link/OTP user has an 'email' identity but no
        // password). The auth_methods_self RPC reads it server-side so the panel
        // adapts correctly to google-only / magic-link / password / linked.
        let meta = null;
        try { meta = await window.NorvaAuth?.rpc?.('auth_methods_self'); } catch (_) { /* fall through */ }
        if (!meta) {
            // RPC unavailable → best-effort from identities (may mislabel passwordless).
            try {
                const user = await window.NorvaAuth?.getUser?.();
                const ids = (user && Array.isArray(user.identities)) ? user.identities : [];
                meta = {
                    has_password: ids.some((i) => i.provider === 'email'),
                    providers: ids.map((i) => i.provider),
                    google_email: (ids.find((i) => i.provider === 'google')?.identity_data?.email) || null,
                    email_confirmed: true
                };
            } catch (_) { meta = { has_password: false, providers: [], google_email: null, email_confirmed: false }; }
        }

        const providers = Array.isArray(meta.providers) ? meta.providers : [];
        const hasPassword = !!meta.has_password;
        const hasGoogle = providers.includes('google');
        const emailConfirmed = !!meta.email_confirmed;
        const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const row = (label, connected, detail) => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid #273142;border-radius:10px;background:#0b0f16">
              <span style="color:#f8fafc;font-weight:600">${label}</span>
              <span style="font-size:12px;color:${connected ? '#34d399' : '#8a94a7'}">${connected ? '✓ ' : ''}${esc(detail)}</span>
            </div>`;

        methodsEl.innerHTML =
            row((globalThis.NorvaI18n?.t("ui_web_d4026adee761", { defaultValue: "Email &amp; password" }) ?? 'Email &amp; password'), hasPassword, hasPassword ? (globalThis.NorvaI18n?.t("ui_web_22965568d22a", { defaultValue: "Connected" }) ?? 'Connected') : (globalThis.NorvaI18n?.t("ui_web_98b1938a6be4", { defaultValue: "Not set — add one below" }) ?? 'Not set — add one below')) +
            row((globalThis.NorvaI18n?.t("ui_web_741ca6a01193", { defaultValue: "Magic link (email)" }) ?? 'Magic link (email)'), emailConfirmed, emailConfirmed ? (globalThis.NorvaI18n?.t("ui_web_92c1cdfdf4cb", { defaultValue: "Enabled" }) ?? 'Enabled') : (globalThis.NorvaI18n?.t("ui_web_7256a5cde7a8", { defaultValue: "Confirm your email to enable" }) ?? 'Confirm your email to enable')) +
            row('Google', hasGoogle, hasGoogle ? (meta.google_email || (globalThis.NorvaI18n?.t("ui_web_22965568d22a", { defaultValue: "Connected" }) ?? 'Connected'))
                : (globalThis.NorvaI18n?.t("ui_web_124e6e396235", { defaultValue: "Sign in with Google (same email) to connect" }) ?? 'Sign in with Google (same email) to connect'));

        // Adapt the password section in BOTH directions so re-calling after an
        // add/change flips it live: no password yet → "Add a password"; has one →
        // "Change password".
        const heading = document.getElementById('ss-pwd-heading');
        const updateBtn = document.getElementById('ss-update');
        if (heading) heading.textContent = hasPassword ? (globalThis.NorvaI18n?.t("ui_web_3f9c991f63a9", { defaultValue: "Change password" }) ?? 'Change password') : (globalThis.NorvaI18n?.t("ui_web_a4e0337667fc", { defaultValue: "Add a password" }) ?? 'Add a password');
        if (updateBtn) updateBtn.textContent = hasPassword ? (globalThis.NorvaI18n?.t("ui_web_fe45b4014135", { defaultValue: "Update password" }) ?? 'Update password') : (globalThis.NorvaI18n?.t("ui_web_dcec8ee65c57", { defaultValue: "Add password" }) ?? 'Add password');
        // Changing an EXISTING password requires re-auth (premium/security): reveal the
        // current-password field. Adding a first password (passwordless account) does not.
        const currentRow = document.getElementById('ss-current-row');
        if (currentRow) currentRow.style.display = hasPassword ? '' : 'none';
    }

    async signOut() {
        if (this.app && typeof this.app.signOut === 'function') {
            return this.app.signOut();
        }
        console.warn('[Settings] Sign-out controller is unavailable; keeping the session active.');
        return false;
    }

    async refreshAccountSettings() {
        const user = this.app.currentUser || {};
        const email = document.getElementById('settings-account-email');
        const mode = document.getElementById('settings-account-mode');
        const kicker = document.getElementById('settings-account-kicker');
        const profileName = document.getElementById('settings-profile-name');
        const tv = isTvSettingsShell();

        if (email) email.textContent = user.email || user.username || (globalThis.NorvaI18n?.t("ui_web_40168a4a3ee9", { defaultValue: "Paired Norva screen" }) ?? 'Paired Norva screen');
        if (kicker) kicker.textContent = tv && user.device ? (globalThis.NorvaI18n?.t("ui_web_999f23fcd7be", { defaultValue: "Identity" }) ?? 'Identity') : (globalThis.NorvaI18n?.t("ui_web_abc50e334be4", { defaultValue: "Signed in as" }) ?? 'Signed in as');
        if (mode) {
            mode.textContent = user.cloud
                ? (user.device ? (globalThis.NorvaI18n?.t("ui_web_94c5a14124e7", { defaultValue: "Paired cloud screen" }) ?? 'Paired cloud screen') : (globalThis.NorvaI18n?.t("ui_web_9a646f09c1e6", { defaultValue: "Norva Cloud account" }) ?? 'Norva Cloud account'))
                : (user.role ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_938bdf2ad535", {defaultValue: "Local {{p0}}", p0:(user.role)}) : `Local ${user.role}`) : (globalThis.NorvaI18n?.t("ui_web_871e019bee76", { defaultValue: "Local account" }) ?? 'Local account'));
        }
        if (tv && user.device && email && mode) {
            const identity = email.textContent;
            email.textContent = (globalThis.NorvaI18n?.t("ui_web_94c5a14124e7", { defaultValue: "Paired cloud screen" }) ?? 'Paired cloud screen');
            mode.textContent = identity;
        }
        if (profileName) {
            profileName.textContent = window.NorvaProfiles?.current?.()?.name || (globalThis.NorvaI18n?.t("ui_web_bec3c9b8e5e8", { defaultValue: "Main Profile" }) ?? 'Main Profile');
        }

        const accountOnly = document.getElementById('settings-open-account');
        const switchProfile = document.getElementById('settings-switch-profile');
        // Sign-in settings need a real Supabase user session; a device-paired screen has
        // only a device token, so the whole panel throws "Not signed in". Same guard as
        // the delete-account row below.
        if (accountOnly) accountOnly.style.display = (user.cloud && !user.device) ? '' : 'none';
        if (switchProfile) switchProfile.style.display = user.cloud && !tv ? '' : 'none';
        const tvSwitchProfile = document.getElementById('settings-tv-switch-profile');
        if (tvSwitchProfile) tvSwitchProfile.hidden = !(tv && user.cloud);

        // Account deletion is for real cloud accounts only (a device-paired
        // screen authenticates with a device token, not a user session).
        const deleteRow = document.getElementById('settings-delete-account-row');
        if (deleteRow) deleteRow.style.display = (user.cloud && !user.device) ? '' : 'none';

        // Discovery is immediate for authenticated Cloud users. The background
        // probe only warms authoritative eligibility and must never delay or
        // remove the entry when the programme is closed.
        void this.refreshPartnersEntry().catch(() => {});
        await this.refreshAccessCard();
        await this.refreshSourceHealthCard();
    }

    async refreshPartnersEntry() {
        const partnersPage = this.app?.pages?.partners;
        const user = this.app?.currentUser || {};
        if (!user.cloud || user.device) {
            partnersPage?.setEntryVisibility?.(false);
            return false;
        }
        const visible = partnersPage?.setEntryVisibility?.(false) === true;
        try {
            await partnersPage?.primeVisibility?.();
        } catch (_) {
            // Discovery remains available; the page presents a safe retry state
            // when authoritative programme data cannot be loaded.
        }
        return visible;
    }

    async refreshAccessCard() {
        const plan = document.getElementById('settings-access-plan');
        const hint = document.getElementById('settings-access-hint');
        const button = document.getElementById('settings-manage-plan-btn');
        if (!plan || !hint) return;

        if (!this.app.currentUser?.cloud || !window.NorvaCloud?.entitlements) {
            plan.textContent = (globalThis.NorvaI18n?.t("ui_web_52956997f7b3", { defaultValue: "Local access" }) ?? 'Local access');
            hint.textContent = (globalThis.NorvaI18n?.t("ui_web_a74ff92b4961", { defaultValue: "This device is using the local hub. Norva Cloud billing is not active here." }) ?? 'This device is using the local hub. Norva Cloud billing is not active here.');
            if (button) button.style.display = 'none';
            return;
        }

        // The access STATUS stays visible (read-only membership state, like
        // Netflix). The action differs by shell:
        //   - Web: "Manage plan" (web account/billing surface).
        //   - Native: "Subscribe" via the in-app Play Billing flow, but ONLY
        //     once the APK ships the purchase bridge. Until then it stays hidden
        //     (external web payment links remain forbidden inside native).
        if (button) {
            if (isTvSettingsShell()) {
                button.style.display = 'none';
            } else if (isNativeShell()) {
                const ready = nativeBillingReady(this.app);
                button.style.display = ready ? '' : 'none';
                if (ready) button.textContent = (globalThis.NorvaI18n?.t("ui_web_cc0e38da9c41", { defaultValue: "Subscribe" }) ?? 'Subscribe');
            } else {
                button.style.display = '';
                button.textContent = (globalThis.NorvaI18n?.t("ui_web_2d5ab37c33fc", { defaultValue: "Manage plan" }) ?? 'Manage plan');
            }
        }

        try {
            const decision = this.app.currentUser.device
                ? await window.NorvaCloud.entitlements.device()
                : await window.NorvaCloud.entitlements.get();
            this.app.entitlement = decision;
            window.NorvaEntitlement = decision;

            // Show the REAL membership state (trial / active / past due / grace /
            // ending / expired) — it is present in the decision even while billing
            // is only OBSERVED, not enforced. Only the genuine "no plan yet" case
            // falls back to the open-access wording.
            const REAL_STATUSES = ['trialing', 'active', 'cancelled_at_period_end', 'past_due', 'grace', 'expired'];
            const hasRealSub = REAL_STATUSES.indexOf(String(decision.status || '').toLowerCase()) !== -1;
            const observing = decision.enforced === false || decision.mode === 'observe';
            const provider = String(decision.projection?.provider || '').toLowerCase();
            const hardBlocked = ['revoked', 'refunded', 'fraud']
                .includes(String(decision.status || '').toLowerCase());
            const includedAccess = String(decision.status || '').toLowerCase() === 'active'
                && (provider === 'system' || provider === 'manual');

            plan.textContent = this.accessLabel(decision);
            hint.textContent = isTvSettingsShell()
                ? (this.app.currentUser?.device ? (globalThis.NorvaI18n?.t("ui_web_94797ff5c4da", { defaultValue: "Valid via cloud synchronization" }) ?? 'Valid via cloud synchronization') : (globalThis.NorvaI18n?.t("ui_web_3633545db1ca", { defaultValue: "Access available on this TV" }) ?? 'Access available on this TV'))
                : this.accessHint(decision);

            if (includedAccess || hardBlocked) {
                // Pilot/VIP/manual grants have no billing relationship. Hiding the
                // control also prevents stale saved-card data from exposing a
                // misleading manage-payment route.
                if (button) button.style.display = 'none';
            } else if (observing && !hasRealSub) {
                // No subscription yet → access is open in observe mode.
                plan.textContent = (globalThis.NorvaI18n?.t("ui_web_f19611c61ca5", { defaultValue: "Full access" }) ?? 'Full access');
                hint.textContent = (globalThis.NorvaI18n?.t("ui_web_568be01a5dbc", { defaultValue: "You have full access to Norva." }) ?? 'You have full access to Norva.');
                if (button && !isNativeShell()) button.style.display = 'none';
            } else if (button && !isNativeShell()) {
                // A real membership exists (even while observed) → let the user open
                // the plan-management surface so the state is inspectable/actionable.
                button.style.display = '';
                button.textContent = (globalThis.NorvaI18n?.t("ui_web_2d5ab37c33fc", { defaultValue: "Manage plan" }) ?? 'Manage plan');
            }

            if (decision.failOpen && !observing) {
                hint.textContent = (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_b016cf047253", {defaultValue: "{{p0}} Last known access is being honored while billing is checked.", p0:(hint.textContent)}) : `${hint.textContent} Last known access is being honored while billing is checked.`);
            }
        } catch (err) {
            console.warn('[Settings] Unable to load Norva access:', err);
            plan.textContent = (globalThis.NorvaI18n?.t("ui_web_3768abe13c0f", { defaultValue: "Access temporarily unavailable" }) ?? 'Access temporarily unavailable');
            hint.textContent = (globalThis.NorvaI18n?.t("ui_web_05d963368ca4", { defaultValue: "Norva will keep access open briefly while billing status is checked." }) ?? 'Norva will keep access open briefly while billing status is checked.');
        }
    }

    // Human plan name from a plan_code ('plus' is marketed as plain "Norva").
    planName(decision = {}) {
        const plan = String(decision.planCode || decision.plan_code || decision.projection?.plan_code || '').toLowerCase();
        if (plan === 'family') return (globalThis.NorvaI18n?.t("ui_web_fada8f5631ee", { defaultValue: "Norva Family" }) ?? 'Norva Family');
        if (plan === 'premium' || plan === 'plus') return 'Norva';
        return null;
    }

    // Big label = the real membership state. Falls back to "Full access" only when
    // there is genuinely no subscription (handled by the caller in observe mode).
    accessLabel(decision = {}) {
        const status = String(decision.status || '').toLowerCase();
        const name = this.planName(decision);
        const provider = String(decision.projection?.provider || '').toLowerCase();
        if (status === 'revoked') return (globalThis.NorvaI18n?.t("ui_web_42849e0bea59", { defaultValue: "Access revoked" }) ?? 'Access revoked');
        if (status === 'refunded') return (globalThis.NorvaI18n?.t("ui_web_dc142ba53499", { defaultValue: "Payment refunded" }) ?? 'Payment refunded');
        if (status === 'fraud') return (globalThis.NorvaI18n?.t("ui_web_3fcf72db54fd", { defaultValue: "Access under review" }) ?? 'Access under review');
        if (status === 'active' && (provider === 'system' || provider === 'manual')) {
            return name ? `${name} · Included` : (globalThis.NorvaI18n?.t("ui_web_25e587cfd863", { defaultValue: "Included access" }) ?? 'Included access');
        }
        const withPlan = (suffix) => name ? `${name} · ${suffix}` : suffix;
        switch (status) {
            case 'trialing': return withPlan((globalThis.NorvaI18n?.t("ui_web_17f6390c3192", { defaultValue: "Free trial" }) ?? 'Free trial'));
            case 'active': return withPlan((globalThis.NorvaI18n?.t("ui_web_92340695899b", { defaultValue: "Active" }) ?? 'Active'));
            case 'cancelled_at_period_end': return withPlan((globalThis.NorvaI18n?.t("ui_web_584cf74c33fb", { defaultValue: "Ending soon" }) ?? 'Ending soon'));
            case 'past_due': return withPlan((globalThis.NorvaI18n?.t("ui_web_a648708bed4a", { defaultValue: "Payment due" }) ?? 'Payment due'));
            case 'grace': return withPlan((globalThis.NorvaI18n?.t("ui_web_610cc1dd9921", { defaultValue: "Payment retrying" }) ?? 'Payment retrying'));
            case 'expired': return (globalThis.NorvaI18n?.t("ui_web_c07147b4c107", { defaultValue: "Plan expired" }) ?? 'Plan expired');
            default: return (globalThis.NorvaI18n?.t("ui_web_f19611c61ca5", { defaultValue: "Full access" }) ?? 'Full access');
        }
    }

    // Sub-text = what the state means + the relevant date, in plain language.
    accessHint(decision = {}) {
        const status = String(decision.status || '').toLowerCase();
        const p = decision.projection || {};
        const fmt = (iso) => { try { return new Date(iso).toLocaleDateString((globalThis.NorvaI18n?.language || 'en-US'), { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_) { return null; } };
        const daysLeft = (iso) => { const t = new Date(iso).getTime(); return Number.isFinite(t) ? Math.max(0, Math.ceil((t - Date.now()) / 86400000)) : null; };
        switch (status) {
            case 'revoked':
            case 'refunded':
            case 'fraud':
                return (globalThis.NorvaI18n?.t("ui_web_368e98ee3170", { defaultValue: "This account cannot start or manage a payment. Contact Norva support for help." }) ?? 'This account cannot start or manage a payment. Contact Norva support for help.');
            case 'trialing': {
                const endIso = p.trial_ends_at || p.current_period_end;
                const d = endIso ? daysLeft(endIso) : null;
                const when = endIso ? fmt(endIso) : null;
                if (d != null && when) {
                    return d > 0
                        ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_31f1e01bef41", {defaultValue: "Free trial — {{p0}} day{{p1}} left. Renews {{p2}} unless cancelled.", p0:(d),p1:(d === 1 ? '' : 's'),p2:(when)}) : `Free trial — ${d} day${d === 1 ? '' : 's'} left. Renews ${when} unless cancelled.`)
                        : (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_05134afefa0c", {defaultValue: "Trial ends today ({{p0}}). You’ll be charged unless you cancel.", p0:(when)}) : `Trial ends today (${when}). You’ll be charged unless you cancel.`);
                }
                return (globalThis.NorvaI18n?.t("ui_web_792e06044a23", { defaultValue: "Your free trial is active." }) ?? 'Your free trial is active.');
            }
            case 'active': {
                // A manually granted plan (VIP/system) never renews and has nothing
                // to cancel — say what it is instead of implying a billing cycle.
                const prov = String(p.provider || '').toLowerCase();
                if (prov === 'manual' || prov === 'system') {
                    return (globalThis.NorvaI18n?.t("ui_web_03324546447a", { defaultValue: "Your access is included with your account — nothing renews, nothing to pay." }) ?? 'Your access is included with your account — nothing renews, nothing to pay.');
                }
                const when = p.current_period_end ? fmt(p.current_period_end) : null;
                return when ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_5eb617bad990", {defaultValue: "Your plan renews on {{p0}}. Cancel anytime.", p0:(when)}) : `Your plan renews on ${when}. Cancel anytime.`) : (globalThis.NorvaI18n?.t("ui_web_08ce28b6c1e1", { defaultValue: "Your plan is active." }) ?? 'Your plan is active.');
            }
            case 'cancelled_at_period_end': {
                const when = p.current_period_end ? fmt(p.current_period_end) : null;
                return when ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_479a5017e836", {defaultValue: "Access continues until {{p0}}, then your plan ends.", p0:(when)}) : `Access continues until ${when}, then your plan ends.`) : (globalThis.NorvaI18n?.t("ui_web_bcc8412d4860", { defaultValue: "Your plan ends at the end of the current period." }) ?? 'Your plan ends at the end of the current period.');
            }
            case 'past_due':
                return (globalThis.NorvaI18n?.t("ui_web_0a3027ec898f", { defaultValue: "Your last payment didn’t go through. Update your payment method to keep access." }) ?? 'Your last payment didn’t go through. Update your payment method to keep access.');
            case 'grace':
                return (globalThis.NorvaI18n?.t("ui_web_68386973eaed", { defaultValue: "We’re retrying your payment — access continues in the meantime." }) ?? 'We’re retrying your payment — access continues in the meantime.');
            case 'expired':
                return (globalThis.NorvaI18n?.t("ui_web_778bbb67ff61", { defaultValue: "Your plan has expired. Choose a plan to keep watching." }) ?? 'Your plan has expired. Choose a plan to keep watching.');
            default:
                return (globalThis.NorvaI18n?.t("ui_web_568be01a5dbc", { defaultValue: "You have full access to Norva." }) ?? 'You have full access to Norva.');
        }
    }

    async refreshSourceHealthCard() {
        const container = document.getElementById('settings-service-health');
        if (!container || !window.NorvaSourceHealth) return;

        try {
            // App owns the canonical source-health refresh: it stores the summary,
            // applies catalogue availability and notifies every navigation adapter.
            // Render that exact object here instead of issuing a second independent
            // /sources request. Keep the direct loader only for standalone harnesses
            // or older shells that do not expose the App seam yet.
            const summary = typeof this.app?.refreshSourceHealth === 'function'
                ? await this.app.refreshSourceHealth()
                : await window.NorvaSourceHealth.loadSummary();
            this.lastSourceHealthSummary = summary;
            const tv = isTvSettingsShell();
            container.innerHTML = window.NorvaSourceHealth.cardHtml(summary, {
                hideWhenReady: false,
                tvHandoff: tv,
                accountSummary: true
            });
            const serviceContainer = document.getElementById('settings-tv-service-health');
            if (serviceContainer) {
                serviceContainer.innerHTML = tv
                    ? window.NorvaSourceHealth.cardHtml(summary, { hideWhenReady: false, tvHandoff: true })
                    : '';
            }
            this.updateTvHandoffCopy(summary);
        } catch (err) {
            console.warn('[Settings] Unable to load TV service health:', err);
            container.innerHTML = '';
            const serviceContainer = document.getElementById('settings-tv-service-health');
            if (serviceContainer) serviceContainer.innerHTML = '';
        }
    }

    updateTvHandoffCopy(summary = {}) {
        if (!isTvSettingsShell()) return;
        const needsAttention = !['ready'].includes(String(summary.state || '').toLowerCase());
        const title = document.getElementById('settings-tv-handoff-title');
        const copy = document.getElementById('settings-tv-handoff-copy');
        if (title) title.textContent = (globalThis.NorvaI18n?.t("ui_web_2319df2a8802", { defaultValue: "Continue on phone or web" }) ?? 'Continue on phone or web');
        if (copy) {
            copy.innerHTML = needsAttention
                ? '<norva-i18n data-i18n="ui_web_ed077f3d8125">Open </norva-i18n><strong data-i18n="ui_web_5050ce953bfd">norva.tv/account</strong><norva-i18n data-i18n="ui_web_2c74cdd57a48"> on a personal device to review your TV service. This TV never asks for provider credentials.</norva-i18n>'
                : '<norva-i18n data-i18n="ui_web_ed077f3d8125">Open </norva-i18n><strong data-i18n="ui_web_5050ce953bfd">norva.tv/account</strong><norva-i18n data-i18n="ui_web_f1622265d123"> on a personal device to manage your account and TV service. This TV never asks for provider credentials.</norva-i18n>';
        }
    }

    initPlayerSettings() {
        const arrowKeysToggle = document.getElementById('setting-arrow-keys');
        const defaultVolumeSlider = document.getElementById('setting-default-volume');
        const volumeValueDisplay = document.getElementById('volume-value');
        const rememberVolumeToggle = document.getElementById('setting-remember-volume');
        const autoPlayNextToggle = document.getElementById('setting-autoplay-next');

        // Load current settings
        if (this.app.player?.settings) {
            arrowKeysToggle.checked = this.app.player.settings.arrowKeysChangeChannel;
            defaultVolumeSlider.value = this.app.player.settings.defaultVolume;
            volumeValueDisplay.textContent = this.app.player.settings.defaultVolume + '%';
            rememberVolumeToggle.checked = this.app.player.settings.rememberVolume;
            autoPlayNextToggle.checked = this.app.player.settings.autoPlayNextEpisode;
        }

        // Arrow keys toggle
        arrowKeysToggle.addEventListener('change', () => {
            this.app.player.settings.arrowKeysChangeChannel = arrowKeysToggle.checked;
            this.app.player.saveSettings();
        });

        // Default volume slider
        defaultVolumeSlider.addEventListener('input', () => {
            const value = defaultVolumeSlider.value;
            volumeValueDisplay.textContent = value + '%';
            this.app.player.settings.defaultVolume = parseInt(value);
            this.app.player.saveSettings();
        });

        // Remember volume toggle
        rememberVolumeToggle.addEventListener('change', () => {
            this.app.player.settings.rememberVolume = rememberVolumeToggle.checked;
            this.app.player.saveSettings();
        });

        // Auto-play next episode toggle
        autoPlayNextToggle.addEventListener('change', () => {
            this.app.player.settings.autoPlayNextEpisode = autoPlayNextToggle.checked;
            this.app.player.saveSettings();
        });

        // EPG refresh interval
        const epgRefreshSelect = document.getElementById('epg-refresh-interval');
        if (epgRefreshSelect && this.app.player?.settings) {
            // Load saved value from player settings
            epgRefreshSelect.value = this.app.player.settings.epgRefreshInterval || '24';

            // Save on change - server will restart its sync timer via PUT /api/settings
            epgRefreshSelect.addEventListener('change', () => {
                this.app.player.settings.epgRefreshInterval = epgRefreshSelect.value;
                this.app.player.saveSettings();
            });
        }

        // Keep my catalogue up to date (cloud refresh-on-open) — works on the web.
        const autoRefreshToggle = document.getElementById('setting-auto-refresh');
        const autoRefreshInterval = document.getElementById('setting-auto-refresh-interval');
        const autoRefreshRow = document.getElementById('auto-refresh-interval-row');
        if (autoRefreshToggle && this.app.player?.settings) {
            const enabled = this.app.player.settings.autoRefreshEnabled !== false;
            autoRefreshToggle.checked = enabled;
            let lastFreeInterval = String(this.app.player.settings.autoRefreshIntervalHours || 24);
            if (autoRefreshInterval) autoRefreshInterval.value = lastFreeInterval;
            if (autoRefreshRow) autoRefreshRow.style.display = enabled ? '' : 'none';
            autoRefreshToggle.addEventListener('change', () => {
                this.app.player.settings.autoRefreshEnabled = autoRefreshToggle.checked;
                this.app.player.saveSettings();
                if (autoRefreshRow) autoRefreshRow.style.display = autoRefreshToggle.checked ? '' : 'none';
            });
            autoRefreshInterval?.addEventListener('change', () => {
                lastFreeInterval = autoRefreshInterval.value;
                this.app.player.settings.autoRefreshIntervalHours = parseInt(autoRefreshInterval.value, 10) || 24;
                this.app.player.saveSettings();
            });
        }

        // EPG auto-refresh runs on a local-server timer (syncService); on the
        // plain web the cloud refreshes on its own schedule and ignores this
        // value, so hide that control there. "Last updated" stays (cloud-backed).
        if (!(this.app.player?._hasLocalTranscoder?.() ?? false)) {
            document.querySelectorAll('#tab-sources .needs-local-server')
                .forEach(el => { el.style.display = 'none'; });
        }

        // Update last refreshed display
        this.updateEpgLastRefreshed();
    }

    async initContentSettings() {
        // TMDB key / enrichment / "restore titles" only work where a local server
        // runs (desktop / Android TV / self-hosted); on the plain web those /api
        // endpoints don't exist (the cloud handles TMDB automatically). Hide them
        // there so we never show a control that does nothing.
        const hasLocalServer = this.app.player?._hasLocalTranscoder?.() ?? false;
        if (!hasLocalServer) {
            document.querySelectorAll('#tab-player .pd-needs-server')
                .forEach(el => { el.style.display = 'none'; });
        }

        const audioLangSelect = document.getElementById('setting-preferred-audio-language');
        const subtitleLangSelect = document.getElementById('setting-preferred-subtitle-language');
        const strictLangToggle = document.getElementById('setting-strict-language');
        const preferredGenresSelect = document.getElementById('setting-preferred-genres');
        const qualitySelect = document.getElementById('setting-preferred-quality');
        const tmdbKeyInput = document.getElementById('setting-tmdb-key');
        const enrichBtn = document.getElementById('tmdb-enrich-btn');
        const statusHint = document.getElementById('tmdb-status-hint');
        const resetBrokenBtn = document.getElementById('reset-broken-btn');
        const resetBrokenHint = document.getElementById('reset-broken-hint');
        [statusHint, resetBrokenHint].forEach((hint) => {
            if (!hint) return;
            hint.setAttribute('role', 'status');
            hint.setAttribute('aria-live', 'polite');
            hint.setAttribute('aria-atomic', 'true');
        });

        let s = {};
        let loadOk = true;
        try {
            s = await API.settings.get();
        } catch (err) {
            // Don't silently default the controls and then let the first interaction
            // overwrite the user's real (unloaded) genres/language/quality. Flag it,
            // surface it, and skip wiring the save handlers below.
            console.warn('Could not load settings for content section', err);
            loadOk = false;
            window.NorvaModal?.toast?.((globalThis.NorvaI18n?.t("ui_web_a3a7670c446d", { defaultValue: "Could not load your preferences — reopen Settings to retry." }) ?? 'Could not load your preferences — reopen Settings to retry.'), 'error');
        }

        const languagePrefs = window.MediaUtils?.normalizeContentPreferences
            ? window.MediaUtils.normalizeContentPreferences(s)
            : {
                preferredAudioLanguage: s.preferredAudioLanguage || '',
                preferredSubtitleLanguage: s.preferredSubtitleLanguage || '',
                strictLanguageMatching: Boolean(s.strictLanguageMatching)
            };
        if (audioLangSelect) audioLangSelect.value = languagePrefs.preferredAudioLanguage || '';
        if (subtitleLangSelect) subtitleLangSelect.value = languagePrefs.preferredSubtitleLanguage || '';
        if (strictLangToggle) strictLangToggle.checked = Boolean(languagePrefs.strictLanguageMatching);
        if (preferredGenresSelect) {
            const selectedGenres = Array.isArray(s.preferredGenres)
                ? s.preferredGenres
                : String(s.preferredGenres || '').split(',').map(value => value.trim()).filter(Boolean);
            [...preferredGenresSelect.options].forEach(option => {
                option.selected = selectedGenres.includes(option.value);
            });
            // Layer touch/TV-friendly chips over the (now hidden) native multi-select,
            // which stays the model so the existing load + save paths are untouched.
            this.renderGenreChips(preferredGenresSelect, document.getElementById('setting-genre-chips'));
        }
        if (qualitySelect) qualitySelect.value = s.preferredQuality || 'highest';
        if (tmdbKeyInput) tmdbKeyInput.value = s.tmdbApiKey || '';

        if (s.preferredLanguage && !s.preferredAudioLanguage && !s.preferredSubtitleLanguage) {
            API.settings.update({
                preferredAudioLanguage: languagePrefs.preferredAudioLanguage || '',
                preferredSubtitleLanguage: languagePrefs.preferredSubtitleLanguage || '',
                preferredLanguage: ''
            }).catch(console.error);
        }

        // Only wire the save-on-change handlers when the load SUCCEEDED — otherwise the
        // first change would persist the blank defaults over the user's real preferences.
        if (loadOk) {
        audioLangSelect?.addEventListener('change', () => {
            // Language preferences drive the resolved synopsis language, so drop the catalog
            // caches to refetch localized overviews on the next browse view.
            API.media?.clearCatalogCaches?.();
            API.settings.update({
                preferredAudioLanguage: audioLangSelect.value,
                preferredLanguage: ''
            }).catch(console.error);
        });
        subtitleLangSelect?.addEventListener('change', () => {
            API.media?.clearCatalogCaches?.();
            API.settings.update({
                preferredSubtitleLanguage: subtitleLangSelect.value,
                preferredLanguage: ''
            }).catch(console.error);
        });
        strictLangToggle?.addEventListener('change', () => {
            API.settings.update({ strictLanguageMatching: strictLangToggle.checked }).catch(console.error);
        });
        preferredGenresSelect?.addEventListener('change', () => {
            API.settings.update({
                preferredGenres: [...preferredGenresSelect.selectedOptions].map(option => option.value)
            }).catch(console.error);
        });
        qualitySelect?.addEventListener('change', () => {
            API.settings.update({ preferredQuality: qualitySelect.value }).catch(console.error);
        });
        }
        tmdbKeyInput?.addEventListener('change', () => {
            API.settings.update({ tmdbApiKey: tmdbKeyInput.value.trim() }).catch(console.error);
        });

        // Catalog region: confirmed user preference. Locale/IP suggestions never write it.
        const countrySelect = document.getElementById('setting-country');
        if (countrySelect) {
            const regionApi = window.NorvaCloud?.regions;
            const hint = countrySelect.parentElement?.querySelector('.setting-hint');
            const baseHint = hint?.textContent || (globalThis.NorvaI18n?.t("ui_web_d3418f669ef0", { defaultValue: "Catalog region changes only the presentation order, not access." }) ?? 'Catalog region changes only the presentation order, not access.');
            const applyResolution = () => {
                const resolution = regionApi?.resolve?.() || { region: 'FR', status: 'inferred', source: 'fallback' };
                const value = String(resolution.region || 'FR').toUpperCase();
                if (![...countrySelect.options].some(o => o.value === value)) {
                    countrySelect.add(new Option(regionApi?.label?.(value) || value, value));
                }
                countrySelect.value = value;
                window.RegionPicker?.syncButton?.(countrySelect);
                if (hint) {
                    const englishState = resolution.status === 'confirmed'
                        ? `Confirmed preference (${regionApi?.label?.(value) || value}).`
                        : `Suggested region (${regionApi?.label?.(value) || value}) until you confirm a choice.`;
                    hint.textContent = `${baseHint} ${englishState}`;
                }
            };
            window.RegionPicker?.initAll?.(); // populate the <select> + wire the combobox first
            applyResolution();

            countrySelect.addEventListener('change', async () => {
                const value = countrySelect.value;
                // The visible control is the picker button (the native <select> is hidden),
                // so disable it too to keep the in-flight resync from being re-entered.
                const pickerBtn = countrySelect.closest('[data-region-picker]')?.querySelector('[data-region-btn]');
                countrySelect.disabled = true;
                if (pickerBtn) pickerBtn.disabled = true;
                const originalHint = hint?.textContent;
                if (hint) hint.textContent = (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_bcf59b6a0de3", {defaultValue: "Syncing catalog for {{p0}}...", p0:(regionApi?.label?.(value) || value)}) : `Syncing catalog for ${regionApi?.label?.(value) || value}...`);
                try {
                    if (regionApi?.setPreferred) {
                        await regionApi.setPreferred(value);
                    } else {
                        localStorage.setItem('norva-preferred-content-region', value);
                        localStorage.setItem('norva-country', value);
                        localStorage.removeItem('norva-content-region-prompt-dismissed');
                        localStorage.setItem('norva-content-region-state', JSON.stringify({
                            region: value,
                            status: 'confirmed',
                            source: 'settings-fallback',
                            suggestedRegion: '',
                            updatedAt: new Date().toISOString()
                        }));
                    }
                    const sources = await API.sources.getAll();
                    for (const src of (sources || [])) {
                        try { await API.sources.sync(src.id); } catch (e) { console.warn('[country] resync failed for', src.id, e); }
                    }
                    try { await window.app?.channelList?.loadChannels?.(); } catch (e) { }
                } catch (e) {
                    // Previously there was no catch: a rejecting getAll() escaped as an
                    // unhandled rejection while `finally` repainted the button as if the
                    // switch had succeeded. Surface it instead of faking success.
                    console.warn('[country] region switch failed', e);
                    window.NorvaModal?.toast?.((globalThis.NorvaI18n?.t("ui_web_daa6854e70fb", { defaultValue: "Could not finish switching region — please retry." }) ?? 'Could not finish switching region — please retry.'), 'error');
                } finally {
                    countrySelect.disabled = false;
                    // Restore focus to the region button: RegionPicker.choose() called
                    // btn.focus() while the button was still disabled (no-op → focus fell to
                    // <body>), stranding the D-pad on TV.
                    if (pickerBtn) { pickerBtn.disabled = false; pickerBtn.focus(); }
                    if (hint && originalHint) hint.textContent = originalHint;
                    applyResolution();
                }
            });
        }

        const formatStatus = (st) => {
            st = st && typeof st === 'object' ? st : {};
            const metric = (value) => {
                const number = Number(value);
                return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
            };
            if (st.running) {
                return (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_965be0b60ca9", {defaultValue: "Enriching… {{p0}}/{{p1}} titles ({{p2}} matched)", p0:(metric(st.processed)),p1:(metric(st.total)),p2:(metric(st.matched))}) : `Enriching… ${metric(st.processed)}/${metric(st.total)} titles (${metric(st.matched)} matched)`);
            }
            if (st.finishedAt) {
                const failed = metric(st.failed);
                const errors = failed ? `, ${failed} errors` : '';
                return (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_78d9c08371da", {defaultValue: "Last run: {{p0}}/{{p1}} matched{{p2}}.", p0:(metric(st.matched)),p1:(metric(st.total)),p2:(errors)}) : `Last run: ${metric(st.matched)}/${metric(st.total)} matched${errors}.`);
            }
            return (globalThis.NorvaI18n?.t("ui_web_4fa0dd2bf200", { defaultValue: "Runs automatically after each sync when a TMDB key is set." }) ?? 'Runs automatically after each sync when a TMDB key is set.');
        };

        let pollTimer = null;
        const pollStatus = () => {
            clearInterval(pollTimer);
            pollTimer = setInterval(async () => {
                try {
                    const st = await API.tmdb.status();
                    if (statusHint) statusHint.textContent = formatStatus(st);
                    if (enrichBtn) enrichBtn.textContent = st.running ? (globalThis.NorvaI18n?.t("ui_web_46c541363b02", { defaultValue: "Running…" }) ?? 'Running…') : (globalThis.NorvaI18n?.t("ui_web_2006c8113ba4", { defaultValue: "Enrich Now" }) ?? 'Enrich Now');
                    if (!st.running) clearInterval(pollTimer);
                } catch (e) {
                    clearInterval(pollTimer);
                }
            }, 2000);
        };

        // Show current status on load
        API.tmdb.status().then(st => {
            if (statusHint) statusHint.textContent = formatStatus(st);
            if (st.running) {
                if (enrichBtn) enrichBtn.textContent = (globalThis.NorvaI18n?.t("ui_web_46c541363b02", { defaultValue: "Running…" }) ?? 'Running…');
                pollStatus();
            }
        }).catch(() => { });

        resetBrokenBtn?.addEventListener('click', async () => {
            try {
                resetBrokenHint?.setAttribute('role', 'status');
                resetBrokenHint?.setAttribute('aria-live', 'polite');
                resetBrokenBtn.disabled = true;
                resetBrokenBtn.textContent = (globalThis.NorvaI18n?.t("ui_web_5a4918e0201c", { defaultValue: "Restoring…" }) ?? 'Restoring…');
                const res = await fetch('/api/playback-status/reset-connection-errors', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    const n = data.reset;
                    if (resetBrokenHint) resetBrokenHint.textContent = n > 0
                        ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_511f176fb77f", {defaultValue: "{{p0}} title{{p1}} restored. Reload Movies/Series to see them again.", p0:(n),p1:(n > 1 ? 's' : '')}) : `${n} title${n > 1 ? 's' : ''} restored. Reload Movies/Series to see them again.`)
                        : (globalThis.NorvaI18n?.t("ui_web_771242068096", { defaultValue: "No incorrectly hidden titles found — nothing to restore." }) ?? 'No incorrectly hidden titles found — nothing to restore.');
                    resetBrokenBtn.textContent = (globalThis.NorvaI18n?.t("ui_web_11a6767d5674", { defaultValue: "Done" }) ?? 'Done');
                } else {
                    console.warn('[Settings] Restore hidden titles was rejected.', data?.error);
                    if (resetBrokenHint) {
                        resetBrokenHint.setAttribute('role', 'alert');
                        resetBrokenHint.setAttribute('aria-live', 'assertive');
                        resetBrokenHint.textContent = (globalThis.NorvaI18n?.t("ui_web_67760f1e89ac", { defaultValue: "Could not restore hidden titles. Try again." }) ?? 'Could not restore hidden titles. Try again.');
                    }
                    resetBrokenBtn.textContent = (globalThis.NorvaI18n?.t("ui_web_02f467ba0c3d", { defaultValue: "Restore titles" }) ?? 'Restore titles');
                    resetBrokenBtn.disabled = false;
                }
            } catch (err) {
                console.warn('[Settings] Restore hidden titles failed.', err);
                if (resetBrokenHint) {
                    resetBrokenHint.setAttribute('role', 'alert');
                    resetBrokenHint.setAttribute('aria-live', 'assertive');
                    resetBrokenHint.textContent = (globalThis.NorvaI18n?.t("ui_web_e51cd5a678f0", { defaultValue: "Could not restore hidden titles. Check your connection and try again." }) ?? 'Could not restore hidden titles. Check your connection and try again.');
                }
                resetBrokenBtn.textContent = (globalThis.NorvaI18n?.t("ui_web_02f467ba0c3d", { defaultValue: "Restore titles" }) ?? 'Restore titles');
                resetBrokenBtn.disabled = false;
            }
        });

        enrichBtn?.addEventListener('click', async () => {
            try {
                statusHint?.setAttribute('role', 'status');
                statusHint?.setAttribute('aria-live', 'polite');
                // Make sure the latest key is saved before starting
                if (tmdbKeyInput) {
                    await API.settings.update({ tmdbApiKey: tmdbKeyInput.value.trim() });
                }
                const result = await API.tmdb.enrich();
                if (result.started) {
                    enrichBtn.textContent = (globalThis.NorvaI18n?.t("ui_web_46c541363b02", { defaultValue: "Running…" }) ?? 'Running…');
                    if (statusHint) statusHint.textContent = (globalThis.NorvaI18n?.t("ui_web_721503d2e78f", { defaultValue: "Starting enrichment…" }) ?? 'Starting enrichment…');
                    pollStatus();
                } else if (result.reason === 'no-api-key') {
                    if (statusHint) statusHint.textContent = (globalThis.NorvaI18n?.t("ui_web_39ca0b3b6ffd", { defaultValue: "Add a TMDB API key first." }) ?? 'Add a TMDB API key first.');
                } else if (result.reason === 'already-running') {
                    pollStatus();
                }
            } catch (err) {
                console.warn('[Settings] TMDB enrichment failed.', err);
                if (statusHint) {
                    statusHint.setAttribute('role', 'alert');
                    statusHint.setAttribute('aria-live', 'assertive');
                    statusHint.textContent = (globalThis.NorvaI18n?.t("ui_web_eba9b94ca2bb", { defaultValue: "Could not start enrichment. Check the API key and try again." }) ?? 'Could not start enrichment. Check the API key and try again.');
                }
            }
        });
    }

    async initTranscodingSettings() {
        // On the plain web there is no local FFmpeg transcoder, so the encoding /
        // quality / upscaling controls do nothing. Hide everything that needs a
        // transcoder and keep only the settings that actually work in-browser
        // (proxy + connection identity). Desktop / Android TV keep the full set.
        const hasLocalTranscoder = this.app.player?._hasLocalTranscoder?.() ?? false;
        if (!hasLocalTranscoder) {
            document.querySelectorAll('#tab-transcode .tc-needs-transcoder')
                .forEach(el => { el.style.display = 'none'; });
        }

        // Encoder settings
        const hwEncoderSelect = document.getElementById('setting-hw-encoder');
        const maxResolutionSelect = document.getElementById('setting-max-resolution');
        const qualitySelect = document.getElementById('setting-quality');

        // Stream processing (use -tc suffix IDs from Transcoding tab)
        const forceProxyToggle = document.getElementById('setting-force-proxy-tc');
        const autoTranscodeToggle = document.getElementById('setting-auto-transcode-tc');
        const forceTranscodeToggle = document.getElementById('setting-force-transcode-tc');
        const forceVideoTranscodeToggle = document.getElementById('setting-force-video-transcode-tc');
        const forceRemuxToggle = document.getElementById('setting-force-remux-tc');

        // User-Agent (Transcoding tab versions)
        const userAgentSelect = document.getElementById('setting-user-agent-tc');
        const userAgentCustomInput = document.getElementById('setting-user-agent-custom-tc');
        const customUaContainer = document.getElementById('custom-user-agent-container-tc');

        // Fetch settings directly from API to avoid race condition with VideoPlayer
        let s;
        try {
            s = await API.settings.get();
        } catch (err) {
            console.warn('[Settings] Failed to load settings from API, using player defaults:', err);
            s = this.app.player?.settings || {};
        }

        // Sync the freshly-fetched values into player.settings BEFORE wiring the change
        // handlers: each one mutates player.settings.X and calls player.saveSettings(),
        // which serializes the WHOLE object. Without this, opening the transcode tab before
        // loadSettingsFromServer resolves and changing one control would persist default
        // values over the server's real settings (forceProxy/maxResolution/…) the user never
        // touched. The read path was already fixed to bypass player.settings; this fixes write.
        if (s && this.app.player?.settings) Object.assign(this.app.player.settings, s);

        if (hwEncoderSelect) hwEncoderSelect.value = s.hwEncoder || 'auto';
        if (maxResolutionSelect) maxResolutionSelect.value = s.maxResolution || '1080p';
        if (qualitySelect) qualitySelect.value = s.quality || 'medium';
        if (forceProxyToggle) forceProxyToggle.checked = s.forceProxy === true;
        if (autoTranscodeToggle) autoTranscodeToggle.checked = s.autoTranscode !== false;
        if (forceTranscodeToggle) forceTranscodeToggle.checked = s.forceTranscode === true;
        if (forceVideoTranscodeToggle) forceVideoTranscodeToggle.checked = s.forceVideoTranscode === true;
        if (forceRemuxToggle) forceRemuxToggle.checked = s.forceRemux || false;
        if (userAgentSelect) userAgentSelect.value = s.userAgentPreset || 'chrome';
        if (userAgentCustomInput) userAgentCustomInput.value = s.userAgentCustom || '';
        if (customUaContainer) {
            customUaContainer.style.display = userAgentSelect?.value === 'custom' ? 'flex' : 'none';
        }

        // Event listeners for encoder settings
        hwEncoderSelect?.addEventListener('change', () => {
            this.app.player.settings.hwEncoder = hwEncoderSelect.value;
            this.app.player.saveSettings();
        });

        maxResolutionSelect?.addEventListener('change', () => {
            this.app.player.settings.maxResolution = maxResolutionSelect.value;
            this.app.player.saveSettings();
        });

        qualitySelect?.addEventListener('change', () => {
            this.app.player.settings.quality = qualitySelect.value;
            this.app.player.saveSettings();
        });

        // Audio Mix Preset
        const audioMixSelect = document.getElementById('setting-audio-mix');
        if (audioMixSelect) {
            audioMixSelect.value = s.audioMixPreset || 'auto';
            audioMixSelect.addEventListener('change', () => {
                this.app.player.settings.audioMixPreset = audioMixSelect.value;
                this.app.player.saveSettings();
            });
        }

        // Upscaling Settings
        const upscaleEnabledToggle = document.getElementById('setting-upscale-enabled');
        const upscaleMethodSelect = document.getElementById('setting-upscale-method');
        const upscaleTargetSelect = document.getElementById('setting-upscale-target');
        const upscaleMethodContainer = document.getElementById('upscale-method-container');
        const upscaleTargetContainer = document.getElementById('upscale-target-container');

        // Helper to toggle upscale options visibility
        const toggleUpscaleOptions = (enabled) => {
            if (upscaleMethodContainer) upscaleMethodContainer.style.display = enabled ? 'flex' : 'none';
            if (upscaleTargetContainer) upscaleTargetContainer.style.display = enabled ? 'flex' : 'none';
        };

        // Load upscaling settings
        if (upscaleEnabledToggle) {
            upscaleEnabledToggle.checked = s.upscaleEnabled || false;
            toggleUpscaleOptions(upscaleEnabledToggle.checked);
        }
        if (upscaleMethodSelect) upscaleMethodSelect.value = s.upscaleMethod || 'hardware';
        if (upscaleTargetSelect) upscaleTargetSelect.value = s.upscaleTarget || '1080p';

        // Upscaling event handlers
        upscaleEnabledToggle?.addEventListener('change', () => {
            this.app.player.settings.upscaleEnabled = upscaleEnabledToggle.checked;
            this.app.player.saveSettings();
            toggleUpscaleOptions(upscaleEnabledToggle.checked);
        });

        upscaleMethodSelect?.addEventListener('change', () => {
            this.app.player.settings.upscaleMethod = upscaleMethodSelect.value;
            this.app.player.saveSettings();
        });

        upscaleTargetSelect?.addEventListener('change', () => {
            this.app.player.settings.upscaleTarget = upscaleTargetSelect.value;
            this.app.player.saveSettings();
        });

        // Stream processing toggles
        forceProxyToggle?.addEventListener('change', () => {
            this.app.player.settings.forceProxy = forceProxyToggle.checked;
            this.app.player.saveSettings();
        });

        autoTranscodeToggle?.addEventListener('change', () => {
            this.app.player.settings.autoTranscode = autoTranscodeToggle.checked;
            this.app.player.saveSettings();
        });

        forceTranscodeToggle?.addEventListener('change', () => {
            this.app.player.settings.forceTranscode = forceTranscodeToggle.checked;
            this.app.player.saveSettings();
        });

        forceVideoTranscodeToggle?.addEventListener('change', () => {
            this.app.player.settings.forceVideoTranscode = forceVideoTranscodeToggle.checked;
            this.app.player.saveSettings();
        });

        forceRemuxToggle?.addEventListener('change', () => {
            this.app.player.settings.forceRemux = forceRemuxToggle.checked;
            this.app.player.saveSettings();
        });

        // User-Agent handlers
        const toggleCustomInput = () => {
            if (customUaContainer) {
                customUaContainer.style.display = userAgentSelect?.value === 'custom' ? 'flex' : 'none';
            }
        };

        userAgentSelect?.addEventListener('change', () => {
            this.app.player.settings.userAgentPreset = userAgentSelect.value;
            this.app.player.saveSettings();
            toggleCustomInput();
        });

        userAgentCustomInput?.addEventListener('change', () => {
            this.app.player.settings.userAgentCustom = userAgentCustomInput.value;
            this.app.player.saveSettings();
        });

        this.initTranscodeWizard();
    }

    /**
     * Troubleshooting wizard: the viewer picks the symptom they're seeing and Norva
     * flips on the matching fix (which are the same toggles/selects below, so the
     * existing change→saveSettings listeners persist it). Friendlier than asking a
     * non-technical user to know that "no sound" means "force audio transcode".
     */
    initTranscodeWizard() {
        const wiz = document.getElementById('tc-wizard');
        if (!wiz || wiz.dataset.wired) return;
        wiz.dataset.wired = '1';
        const resultEl = document.getElementById('tc-wizard-result');

        const FIXES = {
            sound:   { toggle: 'setting-force-transcode-tc', msg: (globalThis.NorvaI18n?.t("ui_web_10f70d1667ee", { defaultValue: "Turned on the audio fix (Dolby/AC3 → browser-friendly sound). Play the channel again." }) ?? 'Turned on the audio fix (Dolby/AC3 → browser-friendly sound). Play the channel again.'), off: (globalThis.NorvaI18n?.t("ui_web_3b0eaa9d7fa4", { defaultValue: "Audio fix turned off." }) ?? 'Audio fix turned off.') },
            black:   { toggle: 'setting-force-proxy-tc', msg: (globalThis.NorvaI18n?.t("ui_web_8750ef6ea197", { defaultValue: "Now fetching the stream through Norva's servers to get past what stopped it loading. Try again." }) ?? "Now fetching the stream through Norva's servers to get past what stopped it loading. Try again."), off: (globalThis.NorvaI18n?.t("ui_web_9d3d36225c68", { defaultValue: "Turned off — streams play directly from your provider again." }) ?? "Turned off — streams play directly from your provider again.") },
            blocked: { toggle: 'setting-force-proxy-tc', msg: (globalThis.NorvaI18n?.t("ui_web_99c84200ddbf", { defaultValue: "Now streaming through Norva's servers to bypass provider blocks. Try again." }) ?? "Now streaming through Norva's servers to bypass provider blocks. Try again."), off: (globalThis.NorvaI18n?.t("ui_web_9d3d36225c68", { defaultValue: "Turned off — streams play directly from your provider again." }) ?? "Turned off — streams play directly from your provider again.") },
            buffer:  { selects: [['setting-quality', 'low'], ['setting-max-resolution', '720p']], msg: (globalThis.NorvaI18n?.t("ui_web_4fff445ca3bb", { defaultValue: "Lowered quality to reduce buffering. Raise it again once it plays smoothly." }) ?? 'Lowered quality to reduce buffering. Raise it again once it plays smoothly.'), off: (globalThis.NorvaI18n?.t("ui_web_c7375a0cf9ff", { defaultValue: "Quality settings restored." }) ?? 'Quality settings restored.') }
        };

        const flash = (el) => el?.closest('.setting-item')?.classList.add('tc-flash');
        const setToggle = (id, on) => {
            const el = document.getElementById(id);
            if (el && el.checked !== on) { el.checked = on; el.dispatchEvent(new Event('change', { bubbles: true })); }
            if (on) flash(el);
        };
        const setSelect = (id, val) => {
            const el = document.getElementById(id);
            if (el && el.value !== val) { el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }
            flash(el);
        };
        const showResult = (txt) => { if (resultEl) { resultEl.textContent = txt; resultEl.classList.remove('hidden'); } };
        const forgetPrev = (fix) => (fix.selects || []).forEach(([id]) => { const el = document.getElementById(id); if (el) delete el.dataset.tcPrev; });

        wiz.addEventListener('click', (e) => {
            const btn = e.target.closest('.tc-wizard-opt');
            if (!btn) return;
            const fix = FIXES[btn.dataset.fix];
            if (!fix) return;
            // Re-tapping the applied symptom = UNDO. The options read as selectable
            // choices, so a second tap must deselect (turn the fix back off) — without
            // this, users think the choice is stuck (it only ever switched things ON).
            if (btn.classList.contains('is-active')) {
                // Deselect FIRST: the restore below fires change events, and
                // syncFromControls must not re-enter and forget tcPrev mid-restore.
                btn.classList.remove('is-active');
                if (fix.toggle) setToggle(fix.toggle, false);
                (fix.selects || []).forEach(([id]) => {
                    const el = document.getElementById(id);
                    const prev = el?.dataset.tcPrev;
                    if (el && prev != null && el.value !== prev) { el.value = prev; el.dispatchEvent(new Event('change', { bubbles: true })); }
                });
                forgetPrev(fix);
                showResult('✓ ' + fix.off);
                window.NorvaModal?.toast((globalThis.NorvaI18n?.t("ui_web_82664455ace7", { defaultValue: "Fix turned off." }) ?? 'Fix turned off.'), 'info');
                return;
            }
            if (fix.toggle) setToggle(fix.toggle, true);
            (fix.selects || []).forEach(([id, val]) => {
                const el = document.getElementById(id);
                // Remember the pre-wizard value once, so undo can restore it.
                if (el && el.dataset.tcPrev == null) el.dataset.tcPrev = el.value;
                setSelect(id, val);
            });
            wiz.querySelectorAll('.tc-wizard-opt').forEach(o => o.classList.toggle('is-active', o === btn));
            showResult('✓ ' + fix.msg);
            window.NorvaModal?.toast((globalThis.NorvaI18n?.t("ui_web_129e346ee50f", { defaultValue: "Applied a fix — try the channel again." }) ?? 'Applied a fix — try the channel again.'), 'success');
            setTimeout(() => {
                document.getElementById('tab-transcode')?.querySelectorAll('.tc-flash')
                    .forEach(el => el.classList.remove('tc-flash'));
            }, 2400);
        });

        // Mirror manual changes back into the wizard: turning the driven toggle off
        // (or moving the selects away) clears the symptom highlight — otherwise the
        // wizard keeps claiming a fix is applied when it no longer is.
        const stillApplied = (fix) => {
            if (fix.toggle) return !!document.getElementById(fix.toggle)?.checked;
            return (fix.selects || []).every(([id, val]) => document.getElementById(id)?.value === val);
        };
        const syncFromControls = () => {
            const active = wiz.querySelector('.tc-wizard-opt.is-active');
            if (!active) return;
            const fix = FIXES[active.dataset.fix];
            if (fix && !stillApplied(fix)) {
                active.classList.remove('is-active');
                forgetPrev(fix);
                resultEl?.classList.add('hidden');
            }
        };
        ['setting-force-transcode-tc', 'setting-force-proxy-tc', 'setting-quality', 'setting-max-resolution']
            .forEach((id) => document.getElementById(id)?.addEventListener('change', syncFromControls));

        // On plain web (no local transcoder) the audio-fix (force-transcode) and the
        // buffering-fix (quality/max-resolution) are inert — the controls they drive are
        // hidden as non-functional there — yet the wizard would still flash a green "✓ fixed"
        // and a success toast. Hide those two options so we never claim a no-op fix. The
        // black-screen / provider-blocked options use force-proxy, which works on web, so
        // they stay.
        if (!(this.app.player?._hasLocalTranscoder?.() ?? false)) {
            wiz.querySelectorAll('.tc-wizard-opt[data-fix="sound"], .tc-wizard-opt[data-fix="buffer"]')
                .forEach(o => { o.style.display = 'none'; });
        }
    }

    /**
     * Load and display hardware info in Transcoding tab
     */
    async loadHardwareInfo() {
        const container = document.getElementById('hw-info-container');
        if (!container) return;

        try {
            const response = await fetch('/api/settings/hw-info');
            if (!response.ok) throw new Error('Failed to fetch hardware info');
            const hwInfo = await response.json();

            const detected = [];

            // Only show detected hardware
            if (hwInfo.nvidia?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge" data-i18n="ui_web_7e64b788f17e">✓ NVIDIA</span>
                    <span class="hw-name">${hwInfo.nvidia.name}</span>
                </div>`);
            }

            if (hwInfo.amf?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge" data-i18n="ui_web_7717042cb7d9">✓ AMD</span>
                    <span class="hw-name">${hwInfo.amf.name || (globalThis.NorvaI18n?.t("ui_web_e674447337e8", { defaultValue: "Available" }) ?? 'Available')}</span>
                </div>`);
            }

            if (hwInfo.qsv?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge" data-i18n="ui_web_2a6a6a91f452">✓ Intel QSV</span>
                    <span class="hw-name" data-i18n="ui_web_e674447337e8">Available</span>
                </div>`);
            }

            if (hwInfo.vaapi?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge" data-i18n="ui_web_8859e93ed520">✓ VAAPI</span>
                    <span class="hw-name">${hwInfo.vaapi.device || (globalThis.NorvaI18n?.t("ui_web_e674447337e8", { defaultValue: "Available" }) ?? 'Available')}</span>
                </div>`);
            }

            let html;
            if (detected.length > 0) {
                html = `<div class="hw-info-grid">${detected.join('')}</div>`;
                html += `<p class="hint" style="margin-top: var(--space-sm);"><norva-i18n data-i18n="ui_web_c78849f584ee">Recommended encoder: </norva-i18n><strong>${hwInfo.recommended}</strong></p>`;
            } else {
                html = `<p class="hint" data-i18n="ui_web_5cdf54a6b59f">No GPU acceleration detected. Using software encoding.</p>`;
            }

            container.innerHTML = html;
        } catch (err) {
            console.error('Error loading hardware info:', err);
            container.innerHTML = '<p class="hint" data-i18n="ui_web_14a865e282c0">Couldn\'t check your hardware right now — Norva will use software encoding, which works everywhere.</p>';
        }
    }

    initUserManagement() {
        // User tab visibility is handled in show() method
        // when currentUser is available

        // Handle add user form
        const addUserForm = document.getElementById('add-user-form');
        if (addUserForm) {
            addUserForm.addEventListener('submit', async (e) => {
                e.preventDefault();

                const btn = e.submitter || addUserForm.querySelector('button[type="submit"], button:not([type])');
                if (btn?.disabled) return;          // guard against a double-submit creating duplicate users
                if (btn) btn.disabled = true;

                const username = document.getElementById('new-username').value;
                const password = document.getElementById('new-password').value;
                const role = document.getElementById('new-role').value;

                try {
                    await API.users.create({ username, password, role });
                    NorvaModal.toast((globalThis.NorvaI18n?.t("ui_web_09d887a7061a", { defaultValue: "User created successfully!" }) ?? 'User created successfully!'), 'success');
                    addUserForm.reset();
                    this.loadUsers();
                } catch (err) {
                    console.warn('[Settings] Local user creation failed.', err);
                    NorvaModal.toast((globalThis.NorvaI18n?.t("ui_web_2f3f78f2a9ca", { defaultValue: "Could not create the user. Review the fields and try again." }) ?? 'Could not create the user. Review the fields and try again.'), 'error');
                } finally {
                    if (btn) btn.disabled = false;
                }
            });
        }
    }

    async loadUsers() {
        const userList = document.getElementById('user-list');
        if (!userList) return;

        try {
            const users = await API.users.getAll();
            // Store users in memory for easy access during edit
            this.users = users;

            if (users.length === 0) {
                userList.innerHTML = '<tr><td colspan="5" class="hint" data-i18n="ui_web_bf1e104fb3c8">No users found</td></tr>';
                return;
            }

            userList.innerHTML = users.map(user => {
                const isSSO = !!user.oidcId;
                const typeBadge = isSSO
                    ? '<span class="user-badge user-badge-sso">SSO</span>'
                    : '<span class="user-badge user-badge-local" data-i18n="ui_web_8c31e6e72230">Local</span>';

                const roleBadge = user.role === 'admin'
                    ? '<span class="user-badge user-badge-admin" data-i18n="ui_web_c1c224b03cd9">Admin</span>'
                    : '<span class="user-badge user-badge-viewer" data-i18n="ui_web_678bfa6af48b">Viewer</span>';

                return `
                <tr>
                    <td>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <strong>${user.username}</strong>
                            ${typeBadge}
                        </div>
                    </td>
                    <td>${user.email || '<span class="hint">-</span>'}</td>
                    <td>${roleBadge}</td>
                    <td>${user.createdAt ? new Date(user.createdAt).toLocaleDateString((globalThis.NorvaI18n?.language || 'en-US')) : 'N/A'}</td>
                    <td>
                        <button class="btn btn-sm btn-secondary" onclick="window.app.pages.settings.openEditUserModal(${user.id})" data-i18n="ui_web_464c4ffd019e">Edit</button>
                        <button class="btn btn-sm btn-error" onclick="window.app.pages.settings.deleteUser(${user.id}, '${user.username}')" data-i18n="ui_web_e2d0a54968ea">Delete</button>
                    </td>
                </tr>
            `}).join('');
        } catch (err) {
            console.error('Error loading users:', err);
            userList.innerHTML = '<tr><td colspan="5" class="hint" data-i18n="ui_web_dd02ae1a4a2f">Error loading users</td></tr>';
        }
    }

    openEditUserModal(userId) {
        console.log('openEditUserModal called with ID:', userId, 'Type:', typeof userId);
        console.log('Current users list:', this.users);

        const user = this.users.find(u => u.id === userId);
        if (!user) {
            console.error('User not found in this.users cache!');
            console.log('Available IDs:', this.users.map(u => u.id));
            return;
        }
        console.log('User found:', user);

        const modal = document.getElementById('edit-user-modal');
        console.log('Modal element:', modal);
        if (!modal) {
            console.error('CRITICAL: Modal element #edit-user-modal not found in DOM!');
            NorvaModal.toast((globalThis.NorvaI18n?.t("ui_web_da059d5e024f", { defaultValue: "Error: could not open the editor. Please refresh the page." }) ?? 'Error: could not open the editor. Please refresh the page.'), 'error');
            return;
        }

        const isSSO = !!user.oidcId;
        console.log('Is SSO user:', isSSO);

        // Populate form with null checks
        try {
            const editId = document.getElementById('edit-user-id');
            const editUsername = document.getElementById('edit-username');
            const editEmail = document.getElementById('edit-email');
            const editRole = document.getElementById('edit-role');
            const editPassword = document.getElementById('edit-password');

            console.log('Form elements found:', { editId, editUsername, editEmail, editRole, editPassword });

            if (editId) editId.value = user.id;
            if (editUsername) editUsername.value = user.username;
            if (editEmail) editEmail.value = user.email || '';
            if (editRole) editRole.value = user.role;
            if (editPassword) editPassword.value = '';

            // Handle SSO specific UI
            const passwordHint = document.getElementById('edit-password-hint');
            const oidcGroup = document.getElementById('oidc-info-group');
            const oidcIdDisplay = document.getElementById('edit-oidc-id');

            if (isSSO) {
                if (editPassword) {
                    editPassword.disabled = true;
                    editPassword.placeholder = (globalThis.NorvaI18n?.t("ui_web_d1237668ba2a", { defaultValue: "Managed by SSO Provider" }) ?? "Managed by SSO Provider");
                }
                if (passwordHint) passwordHint.textContent = (globalThis.NorvaI18n?.t("ui_web_d0adfbd8e884", { defaultValue: "Password cannot be changed for SSO users." }) ?? "Password cannot be changed for SSO users.");
                if (oidcGroup) oidcGroup.classList.remove('hidden');
                if (oidcIdDisplay) oidcIdDisplay.textContent = user.oidcId;
            } else {
                if (editPassword) {
                    editPassword.disabled = false;
                    editPassword.placeholder = (globalThis.NorvaI18n?.t("ui_web_25a1ae17f01b", { defaultValue: "Leave blank to keep current" }) ?? "Leave blank to keep current");
                }
                if (passwordHint) passwordHint.textContent = (globalThis.NorvaI18n?.t("ui_web_8c3d48ae69ca", { defaultValue: "Optional. Leave blank to keep unchanged." }) ?? "Optional. Leave blank to keep unchanged.");
                if (oidcGroup) oidcGroup.classList.add('hidden');
            }

            // Show modal
            console.log('Adding active class to modal...');
            modal.classList.add('active');
            if (window.NorvaModal?.installHygiene) NorvaModal.installHygiene(modal, { initialFocus: document.getElementById('edit-username') });
            console.log('Modal classes after add:', modal.classList.toString());

            // Setup Close/Cancel handlers (once)
            this.setupModalHandlers(modal);
            console.log('Modal should now be visible!');
        } catch (err) {
            console.error('Error populating modal:', err);
            NorvaModal.toast((globalThis.NorvaI18n?.t("ui_web_9a3a013ae23e", { defaultValue: "Could not open the user editor. Refresh the page and try again." }) ?? 'Could not open the user editor. Refresh the page and try again.'), 'error');
        }
    }

    setupModalHandlers(modal) {
        if (this.modalHandlersSetup) return;

        const closeBtn = document.getElementById('edit-user-close');
        const cancelBtn = document.getElementById('edit-user-cancel');
        const saveBtn = document.getElementById('edit-user-save');

        const closeModal = () => modal.classList.remove('active');

        closeBtn.onclick = closeModal;
        cancelBtn.onclick = closeModal;

        // Click outside to close
        modal.onclick = (e) => {
            if (e.target === modal) closeModal();
        };

        // Save Handler
        saveBtn.onclick = async () => {
            if (saveBtn.disabled) return;           // guard against a double-press
            const userId = document.getElementById('edit-user-id').value;
            // #edit-user-save lives outside the <form>, so the input's `required` never
            // fires — validate the name explicitly rather than PUT an empty username.
            const username = document.getElementById('edit-username').value.trim();
            if (!username) {
                NorvaModal.toast((globalThis.NorvaI18n?.t("ui_web_430404bb87ed", { defaultValue: "Username cannot be empty." }) ?? 'Username cannot be empty.'), 'error');
                return;
            }
            const updates = {
                username,
                role: document.getElementById('edit-role').value
            };

            const newPassword = document.getElementById('edit-password').value;
            if (newPassword && !document.getElementById('edit-password').disabled) {
                updates.password = newPassword;
            }

            saveBtn.disabled = true;
            try {
                await API.users.update(userId, updates);
                NorvaModal.toast((globalThis.NorvaI18n?.t("ui_web_9addefc02b88", { defaultValue: "User updated." }) ?? 'User updated.'), 'success');
                closeModal();
                this.loadUsers();
            } catch (err) {
                console.warn('[Settings] Local user update failed.', err);
                NorvaModal.toast((globalThis.NorvaI18n?.t("ui_web_a863d18a9043", { defaultValue: "Could not update the user. Try again." }) ?? 'Could not update the user. Try again.'), 'error');
            } finally {
                saveBtn.disabled = false;
            }
        };

        this.modalHandlersSetup = true;
    }


    /**
     * Render selectable genre chips backed by the hidden native <select multiple>.
     * The select stays the model (load + save read/write it); a chip click toggles
     * the matching option and fires the select's existing change → save listener.
     */
    renderGenreChips(selectEl, host) {
        if (!selectEl || !host) return;
        host.innerHTML = [...selectEl.options].map(o =>
            `<button type="button" class="genre-chip ${o.selected ? 'is-active' : ''}" data-value="${this.escapeAttr(o.value)}" aria-pressed="${o.selected ? 'true' : 'false'}">${this.escapeHtml(o.textContent)}</button>`
        ).join('');
        selectEl.classList.add('is-chip-backed');
        if (host.dataset.wired) return;
        host.dataset.wired = '1';
        host.addEventListener('click', (e) => {
            const chip = e.target.closest('.genre-chip');
            if (!chip) return;
            const opt = [...selectEl.options].find(o => o.value === chip.dataset.value);
            if (!opt) return;
            opt.selected = !opt.selected;
            chip.classList.toggle('is-active', opt.selected);
            chip.setAttribute('aria-pressed', opt.selected ? 'true' : 'false');
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }

    async deleteUser(userId, username) {
        const ok = await NorvaModal.confirm(
            (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_449b2d1558c2", {defaultValue: "\"{{p0}}\" will lose access to this Norva server. This cannot be undone.", p0:(username)}) : `"${username}" will lose access to this Norva server. This cannot be undone.`),
            { title: (globalThis.NorvaI18n?.t("ui_web_a974bdbf8f4b", { defaultValue: "Delete user?" }) ?? 'Delete user?'), confirmLabel: (globalThis.NorvaI18n?.t("ui_web_e2d0a54968ea", { defaultValue: "Delete" }) ?? 'Delete'), danger: true }
        );
        if (!ok) return;

        try {
            await API.users.delete(userId);
            this.loadUsers();
        } catch (err) {
            console.warn('[Settings] Local user deletion failed.', err);
            NorvaModal.toast((globalThis.NorvaI18n?.t("ui_web_ce87fda3b51f", { defaultValue: "Could not delete the user. Try again." }) ?? 'Could not delete the user. Try again.'), 'error');
        }
    }

    // Devices & Screens is a deep page module; Settings only hosts its lifecycle.
    initScreensTab() {
        if (!this.devicesScreensModule) {
            const root = document.getElementById('devices-screens-root');
            const Module = window.DevicesScreensModule;
            if (!root || typeof Module !== 'function') return false;
            this.devicesScreensModule = new Module(this.app, root);
        }
        return this.devicesScreensModule.activate();
    }

    isTabAvailable(tabName) {
        const normalizedTab = normalizeSettingsTab(tabName);
        if (!normalizedTab) return false;
        const tab = [...this.tabs].find((item) => item.dataset.tab === normalizedTab);
        const panel = [...this.tabContents].find((item) => item.id === `tab-${normalizedTab}`);
        return !!(tab && panel
            && !tab.disabled
            && !tab.hidden
            && tab.style.display !== 'none'
            && tab.getAttribute('aria-hidden') !== 'true');
    }

    syncTabRoute(tabName) {
        if (this.app?.currentPage !== 'settings') return;
        try {
            const currentState = history.state && typeof history.state === 'object'
                ? history.state
                : {};
            history.replaceState({
                ...currentState,
                page: 'settings',
                idx: typeof currentState.idx === 'number' ? currentState.idx : (this.app?._histIdx || 0),
                settingsTab: tabName,
            }, '', `#settings/${encodeURIComponent(tabName)}`);
        } catch (_) { /* route persistence remains best-effort in restricted shells */ }
    }

    switchTab(tabName) {
        tabName = normalizeSettingsTab(tabName) || 'account';
        if (isTvSettingsShell() && !['account', 'player', 'sources'].includes(tabName)) {
            tabName = 'account';
        }
        if (!this.isTabAvailable(tabName)) tabName = 'account';
        this.tabs.forEach(t => {
            const selected = t.dataset.tab === tabName;
            t.classList.toggle('active', selected);
            t.setAttribute('aria-selected', selected ? 'true' : 'false');
            t.tabIndex = selected ? 0 : -1;
        });
        this.tabContents.forEach(c => {
            const selected = c.id === `tab-${tabName}`;
            c.classList.toggle('active', selected);
            c.setAttribute('aria-hidden', selected ? 'false' : 'true');
            c.hidden = !selected;
            if (selected) c.scrollTop = 0;
        });

        // Each tab owns its own reading position. Entering a different tab must
        // never inherit the previous panel's scroll (on either mobile or TV),
        // otherwise its heading and primary controls can open off-screen.
        const settingsPage = document.getElementById('page-settings');
        settingsPage?.classList.toggle('settings-screens-active', tabName === 'screens');
        const settingsContainer = settingsPage?.querySelector('.settings-container');
        const activePanel = settingsContainer?.querySelector('.tab-content.active');
        const resetTabScroll = () => {
            if (settingsPage) settingsPage.scrollTop = 0;
            if (settingsContainer) settingsContainer.scrollTop = 0;
            if (activePanel) activePanel.scrollTop = 0;
        };
        resetTabScroll();
        requestAnimationFrame(resetTabScroll);

        // If an "advanced" tab is activated (e.g. programmatically) while collapsed
        // on phone, reveal the advanced group so the active tab is visible.
        const activeTab = [...this.tabs].find(t => t.dataset.tab === tabName);
        if (activeTab?.classList.contains('tab-advanced')) {
            document.querySelector('.settings-container .tabs')?.classList.add('show-advanced');
        }

        writePersistedSettingsTab(tabName);
        this.syncTabRoute(tabName);

        // Load content browser when switching to that tab
        if (tabName === 'content') {
            this.app.sourceManager.loadContentSources();
        }

        if (tabName === 'sources' && !this._sourceFormOpenedReported && this.app?.currentUser?.cloud) {
            this._sourceFormOpenedReported = true;
            window.NorvaCloud?.lifecycleEvents?.recordProduct?.('source_form_opened');
        }

        if (tabName === 'account') {
            this.refreshAccountSettings();
        }

        // Load users when switching to users tab
        if (tabName === 'users') {
            this.loadUsers();
        }

        // Load hardware info when switching to transcode tab
        if (tabName === 'transcode') {
            this.loadHardwareInfo();
        }

        if (tabName === 'screens') {
            this.initScreensTab();
        } else {
            this.devicesScreensModule?.deactivate?.();
        }

        return tabName;
    }

    async show() {
        const requestedSubRoute = normalizeSettingsTab(this.app?._settingsSubRoute);
        const requestedTab = requestedSubRoute || readPersistedSettingsTab() || 'account';
        const lifecycleImportContext = requestedTab === 'sources'
            ? (this.app?._lifecycleImportContext || null)
            : null;
        if (this.app) {
            this.app._settingsSubRoute = '';
            this.app._lifecycleImportContext = null;
        }
        // TV Settings uses a fixed header/tab shell with only the active panel
        // scrolling. Reset synchronously before any network request so entry can
        // never reveal a clipped title or a stale lower section.
        if (isTvSettingsShell()) {
            document.documentElement.classList.add('tv-settings-active');
            const page = document.getElementById('page-settings');
            const container = page?.querySelector('.settings-container');
            if (page) page.scrollTop = 0;
            if (container) container.scrollTop = 0;
            const activePanel = container?.querySelector('.tab-content.active');
            if (activePanel) activePanel.scrollTop = 0;
        }

        // Local hub user management stays available to local admins only.
        const usersTab = document.getElementById('users-tab');
        const canManageLocalUsers = !isTvSettingsShell()
            && this.app.currentUser?.role === 'admin'
            && !this.app.currentUser?.cloud;
        if (usersTab) {
            usersTab.style.display = canManageLocalUsers ? 'block' : 'none';
        }

        // "Screens & pairing" (devices) is a cloud-account-only feature.
        const screensTab = document.getElementById('screens-tab');
        if (screensTab) {
            const cloudUser = !!this.app.currentUser?.cloud && !isTvSettingsShell();
            screensTab.style.display = cloudUser ? 'block' : 'none';
        }

        // Apply the requested/persisted section only after role/device visibility
        // is known. A stale or unavailable section safely falls back to Account
        // and rewrites both the hash and session value to that valid destination.
        const activeTab = this.switchTab(requestedTab);

        // Load sources when page is shown
        await this.app.sourceManager.loadSources();
        if (activeTab === 'sources' && lifecycleImportContext) {
            this.app.sourceManager.presentLifecycleImportHelp?.(lifecycleImportContext);
        } else {
            this.app.sourceManager.clearLifecycleImportHelp?.();
        }
        await this.refreshAccountSettings();

        // Refresh ALL player settings from server
        if (this.app.player?.settings) {
            const s = this.app.player.settings;

            // Player settings
            const arrowKeysToggle = document.getElementById('setting-arrow-keys');
            const overlayDurationInput = document.getElementById('setting-overlay-duration');
            const defaultVolumeSlider = document.getElementById('setting-default-volume');
            const volumeValueDisplay = document.getElementById('volume-value');
            const rememberVolumeToggle = document.getElementById('setting-remember-volume');
            const autoPlayNextToggle = document.getElementById('setting-autoplay-next');
            const forceProxyToggle = document.getElementById('setting-force-proxy');
            const forceTranscodeToggle = document.getElementById('setting-force-transcode');
            const forceRemuxToggle = document.getElementById('setting-force-remux');
            const autoTranscodeToggle = document.getElementById('setting-auto-transcode');
            const epgRefreshSelect = document.getElementById('epg-refresh-interval');
            const streamFormatSelect = document.getElementById('setting-stream-format');

            if (arrowKeysToggle) arrowKeysToggle.checked = s.arrowKeysChangeChannel;
            if (overlayDurationInput) overlayDurationInput.value = s.overlayDuration;
            if (defaultVolumeSlider) defaultVolumeSlider.value = s.defaultVolume;
            if (volumeValueDisplay) volumeValueDisplay.textContent = s.defaultVolume + '%';
            if (rememberVolumeToggle) rememberVolumeToggle.checked = s.rememberVolume;
            if (autoPlayNextToggle) autoPlayNextToggle.checked = s.autoPlayNextEpisode;
            if (forceProxyToggle) forceProxyToggle.checked = s.forceProxy || false;
            if (forceTranscodeToggle) forceTranscodeToggle.checked = s.forceTranscode || false;
            if (forceRemuxToggle) forceRemuxToggle.checked = s.forceRemux || false;
            if (autoTranscodeToggle) autoTranscodeToggle.checked = s.autoTranscode || false;
            if (epgRefreshSelect) epgRefreshSelect.value = s.epgRefreshInterval || '24';
            if (streamFormatSelect) streamFormatSelect.value = s.streamFormat || 'm3u8';

            // Auto-refresh toggle + interval were omitted from this re-sync, so they kept
            // showing the boot-time defaults (ON / 24h) even after the user saved another
            // value — initPlayerSettings() populates them once, before loadSettingsFromServer
            // resolves. Re-sync them here like every other player control.
            const autoRefreshToggleSync = document.getElementById('setting-auto-refresh');
            const autoRefreshIntervalSync = document.getElementById('setting-auto-refresh-interval');
            const autoRefreshRowSync = document.getElementById('auto-refresh-interval-row');
            if (autoRefreshToggleSync) {
                const arEnabled = s.autoRefreshEnabled !== false;
                autoRefreshToggleSync.checked = arEnabled;
                if (autoRefreshIntervalSync) autoRefreshIntervalSync.value = String(s.autoRefreshIntervalHours || 24);
                if (autoRefreshRowSync) autoRefreshRowSync.style.display = arEnabled ? '' : 'none';
            }

            // User-Agent settings
            const userAgentSelect = document.getElementById('setting-user-agent');
            const userAgentCustomInput = document.getElementById('setting-user-agent-custom');
            const customUaContainer = document.getElementById('custom-user-agent-container');
            if (userAgentSelect) {
                userAgentSelect.value = s.userAgentPreset || 'chrome';
                if (customUaContainer) {
                    customUaContainer.style.display = userAgentSelect.value === 'custom' ? 'flex' : 'none';
                }
            }
            if (userAgentCustomInput) userAgentCustomInput.value = s.userAgentCustom || '';
        }

        // Update EPG last refreshed display
        this.updateEpgLastRefreshed();
    }

    /**
     * Update the EPG last refreshed display
     */
    async updateEpgLastRefreshed() {
        const display = document.getElementById('epg-last-refreshed');
        if (!display) return;

        try {
            const data = await API.settings.getSyncStatus();

            if (data.lastSyncTime) {
                const lastRefreshTime = new Date(data.lastSyncTime);

                // Format as relative time or absolute
                const now = new Date();
                const diffMs = now - lastRefreshTime;
                const diffMins = Math.floor(diffMs / 60000);
                const diffHours = Math.floor(diffMins / 60);

                let text;
                if (diffMins < 1) {
                    text = (globalThis.NorvaI18n?.t("ui_web_66f53417d3b7", { defaultValue: "Just now" }) ?? 'Just now');
                } else if (diffMins < 60) {                    text = new Intl.RelativeTimeFormat(globalThis.NorvaI18n?.language || 'en', { numeric: 'auto' }).format(-diffMins, 'minute');
                } else if (diffHours < 24) {                    text = new Intl.RelativeTimeFormat(globalThis.NorvaI18n?.language || 'en', { numeric: 'auto' }).format(-diffHours, 'hour');
                } else {
                    // Use absolute time for older refreshes
                    text = lastRefreshTime.toLocaleString((globalThis.NorvaI18n?.language || 'en-US'));
                }

                display.textContent = text;
                display.title = lastRefreshTime.toLocaleString(((globalThis.NorvaI18n?.language || 'en-US'))); // Full timestamp on hover
            } else {
                display.textContent = (globalThis.NorvaI18n?.t("ui_web_6300ef800bb8", { defaultValue: "Never" }) ?? 'Never');
                display.title = (globalThis.NorvaI18n?.t("ui_web_1faa5300ff48", { defaultValue: "Sync has not run yet since server started" }) ?? 'Sync has not run yet since server started');
            }
        } catch (err) {
            console.debug('Sync status unavailable:', err);
            display.textContent = (globalThis.NorvaI18n?.t("ui_web_b764cdc0eab7", { defaultValue: "Unknown" }) ?? 'Unknown');
            display.title = (globalThis.NorvaI18n?.t("ui_web_e939d614a2a2", { defaultValue: "Could not fetch sync status" }) ?? 'Could not fetch sync status');
        }
    }

    async openLifecycleImportHelp(context) {
        if (this.app) this.app._lifecycleImportContext = null;
        const activeTab = this.switchTab('sources');
        if (activeTab !== 'sources') return false;
        await this.app.sourceManager.loadSources();
        return this.app.sourceManager.presentLifecycleImportHelp(context);
    }

    hide() {
        this.devicesScreensModule?.deactivate?.();
        document.getElementById('page-settings')?.classList.remove('settings-screens-active');
        document.documentElement.classList.remove('tv-settings-active');
    }
}

window.SettingsPage = SettingsPage;
