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

// TRUE only inside the Android TV APK (UA tag `NorvaTV-AndroidTV`). Must NOT
// match the phone (`NorvaTV-AndroidPhone`) or the standalone APK — the TV is the
// one shell that authenticates by device pairing (QR), never by email/password,
// so logging out on TV returns to the pairing screen, not the login form.
function isTvShell() {
    return /NorvaTV-AndroidTV/i.test(navigator.userAgent || '');
}

// The pairing entry the TV APK boots into (mirrors CLOUD_PAIR_URL in the TV
// MainActivity): re-pair via QR, then land back on the app once approved.
const TV_PAIR_URL = '/cloud-pair.html?device=tv&returnTo=%2Fapp.html%3Fpaired%3D1%23home';

// True once the native APK exposes the Play Billing purchase bridge. In-app
// purchase is allowed by stores (only external web payment links are not), so
// when this bridge is present we can surface an in-app "Subscribe" action.
function nativeBillingReady() {
    const bridge = window.NorvaTVCloud || window.NodeCastNative;
    return !!(bridge && typeof bridge.purchase === 'function');
}

class SettingsPage {
    constructor(app) {
        this.app = app;
        this.tabs = document.querySelectorAll('.tabs .tab');
        this.tabContents = document.querySelectorAll('.tab-content');

        this.init();
    }

    init() {
        // Tab switching
        this.tabs.forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
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

    initAccountSettings() {
        document.getElementById('settings-open-account')?.addEventListener('click', () => {
            this.openSignInSettings();
        });

        document.getElementById('settings-switch-profile')?.addEventListener('click', () => {
            window.NorvaProfiles?.openSwitcher?.();
        });

        document.getElementById('settings-signout-btn')?.addEventListener('click', () => this.signOut());

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

        title.textContent = 'Sign-in settings';
        if (footer) footer.innerHTML = '';
        body.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:14px">
              <div>
                <div class="setting-label">Signed in as</div>
                <strong id="ss-email" style="color:#f8fafc"></strong>
              </div>
              <div>
                <div class="setting-label" style="margin-bottom:6px">Sign-in methods</div>
                <div id="ss-methods" style="display:flex;flex-direction:column;gap:8px">
                  <p class="setting-hint" style="margin:0">Loading…</p>
                </div>
              </div>
              <div id="ss-current-row" style="display:none">
                <label class="setting-label" for="ss-current" style="display:block;margin-bottom:6px">Current password</label>
                <input id="ss-current" type="password" autocomplete="current-password" placeholder="Your current password" style="${inputStyle}">
              </div>
              <div>
                <label class="setting-label" for="ss-new" id="ss-pwd-heading" style="display:block;margin-bottom:6px">New password</label>
                <input id="ss-new" type="password" autocomplete="new-password" minlength="6" placeholder="At least 6 characters" style="${inputStyle}">
              </div>
              <div>
                <label class="setting-label" for="ss-confirm" style="display:block;margin-bottom:6px">Confirm new password</label>
                <input id="ss-confirm" type="password" autocomplete="new-password" minlength="6" style="${inputStyle}">
              </div>
              <p id="ss-status" class="setting-hint" style="min-height:18px;margin:0"></p>
              <p class="setting-hint" style="margin:0"><a id="ss-reset" href="#" style="color:#5b7cfa">Send a password reset email instead</a></p>
              <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px">
                <button class="btn btn-secondary" id="ss-cancel" type="button">Close</button>
                <button class="btn btn-primary" id="ss-update" type="button">Update password</button>
              </div>
            </div>`;

        const emailEl = document.getElementById('ss-email');
        if (emailEl) emailEl.textContent = email || 'your account';

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
            status.style.color = isError ? '#fb7185' : '#34d399';
        };

        document.getElementById('ss-cancel')?.addEventListener('click', close);
        document.getElementById('ss-update')?.addEventListener('click', async () => {
            const pwd = newInput?.value || '';
            const confirmPwd = confirmInput?.value || '';
            if (pwd.length < 6) { setStatus('Password must be at least 6 characters.', true); newInput?.focus(); return; }
            if (pwd !== confirmPwd) { setStatus('The passwords do not match.', true); confirmInput?.focus(); return; }
            const currentRow = document.getElementById('ss-current-row');
            const currentInput = document.getElementById('ss-current');
            const needsReauth = !!currentRow && currentRow.style.display !== 'none';
            const currentPwd = currentInput?.value || '';
            if (needsReauth && !currentPwd) { setStatus('Enter your current password.', true); currentInput?.focus(); return; }
            const btn = document.getElementById('ss-update');
            if (btn) btn.disabled = true;
            setStatus('Updating…', false);
            try {
                // Premium/Netflix-grade: verify the CURRENT password (re-authenticate) before
                // changing it, so a momentarily-unlocked session can't silently take over the
                // account. Skipped for the passwordless "Add a password" case.
                if (needsReauth) {
                    try {
                        await window.NorvaAuth.signIn({ email, password: currentPwd });
                    } catch (_) {
                        setStatus('Current password is incorrect.', true);
                        if (btn) btn.disabled = false;
                        currentInput?.focus();
                        return;
                    }
                }
                await window.NorvaAuth.updatePassword(pwd);
                setStatus('Password updated.', false);
                if (newInput) newInput.value = '';
                if (confirmInput) confirmInput.value = '';
                if (currentInput) currentInput.value = '';
                this.populateSignInMethods(); // reflect that email+password is now a method
                setTimeout(close, 900);
            } catch (e) {
                setStatus((e && e.message) || 'Could not update the password.', true);
                if (btn) btn.disabled = false;
            }
        });
        document.getElementById('ss-reset')?.addEventListener('click', async (e) => {
            e.preventDefault();
            if (!email) { setStatus('No email on file for a reset link.', true); return; }
            try {
                await window.NorvaAuth.recover(email);
                setStatus('Reset email sent — check your inbox.', false);
            } catch (err) {
                setStatus((err && err.message) || 'Could not send the reset email.', true);
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
            row('Email &amp; password', hasPassword, hasPassword ? 'Connected' : 'Not set — add one below') +
            row('Magic link (email)', emailConfirmed, emailConfirmed ? 'Enabled' : 'Confirm your email to enable') +
            row('Google', hasGoogle, hasGoogle ? (meta.google_email || 'Connected')
                : 'Sign in with Google (same email) to connect');

        // Adapt the password section in BOTH directions so re-calling after an
        // add/change flips it live: no password yet → "Add a password"; has one →
        // "Change password".
        const heading = document.getElementById('ss-pwd-heading');
        const updateBtn = document.getElementById('ss-update');
        if (heading) heading.textContent = hasPassword ? 'Change password' : 'Add a password';
        if (updateBtn) updateBtn.textContent = hasPassword ? 'Update password' : 'Add password';
        // Changing an EXISTING password requires re-auth (premium/security): reveal the
        // current-password field. Adding a first password (passwordless account) does not.
        const currentRow = document.getElementById('ss-current-row');
        if (currentRow) currentRow.style.display = hasPassword ? '' : 'none';
    }

    async signOut() {
        // TV = a device-paired screen. A plain session sign-out leaves the device
        // token in place, so the pairing screen silently resumes the SAME account
        // (the "QR flashes then reconnects" bug). Unpair server-side (the account
        // drops this screen) AND clear the local device token/id, then return to a
        // fresh QR pairing. Order matters: unpair while the token still exists.
        if (isTvShell()) {
            try { await window.NorvaCloud?.device?.unpairSelf?.(); } catch (_) { /* best-effort; still clear locally */ }
            try { window.NorvaCloud?.setDeviceToken?.(''); } catch (_) { /* noop */ }
            try { localStorage.removeItem('norva-cloud-device-id'); } catch (_) { /* noop */ }
            try { if (window.NorvaAuth) await window.NorvaAuth.signOut(); } catch (_) { /* noop */ }
            window.location.replace(TV_PAIR_URL);
            return;
        }

        const token = localStorage.getItem('authToken');

        if (this.app.currentUser?.cloud && window.NorvaAuth) {
            await window.NorvaAuth.signOut();
            window.location.replace('/account.html');
            return;
        }

        if (token) {
            try {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            } catch (_) { }
        }

        localStorage.removeItem('authToken');
        window.location.replace('/login.html');
    }

    async refreshAccountSettings() {
        const user = this.app.currentUser || {};
        const email = document.getElementById('settings-account-email');
        const mode = document.getElementById('settings-account-mode');

        if (email) email.textContent = user.email || user.username || 'Paired Norva screen';
        if (mode) {
            mode.textContent = user.cloud
                ? (user.device ? 'Paired cloud screen' : 'Norva Cloud account')
                : (user.role ? `Local ${user.role}` : 'Local account');
        }

        const accountOnly = document.getElementById('settings-open-account');
        const switchProfile = document.getElementById('settings-switch-profile');
        // Sign-in settings need a real Supabase user session; a device-paired screen has
        // only a device token, so the whole panel throws "Not signed in". Same guard as
        // the delete-account row below.
        if (accountOnly) accountOnly.style.display = (user.cloud && !user.device) ? '' : 'none';
        if (switchProfile) switchProfile.style.display = user.cloud ? '' : 'none';

        // Account deletion is for real cloud accounts only (a device-paired
        // screen authenticates with a device token, not a user session).
        const deleteRow = document.getElementById('settings-delete-account-row');
        if (deleteRow) deleteRow.style.display = (user.cloud && !user.device) ? '' : 'none';

        await this.refreshAccessCard();
        await this.refreshSourceHealthCard();
    }

    async refreshAccessCard() {
        const plan = document.getElementById('settings-access-plan');
        const hint = document.getElementById('settings-access-hint');
        const button = document.getElementById('settings-manage-plan-btn');
        if (!plan || !hint) return;

        if (!this.app.currentUser?.cloud || !window.NorvaCloud?.entitlements) {
            plan.textContent = 'Local access';
            hint.textContent = 'This device is using the local hub. Norva Cloud billing is not active here.';
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
            if (isNativeShell()) {
                const ready = nativeBillingReady();
                button.style.display = ready ? '' : 'none';
                if (ready) button.textContent = 'Subscribe';
            } else {
                button.style.display = '';
                button.textContent = 'Manage plan';
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

            plan.textContent = this.accessLabel(decision);
            hint.textContent = this.accessHint(decision);

            if (observing && !hasRealSub) {
                // No subscription yet → access is open in observe mode.
                plan.textContent = 'Full access';
                hint.textContent = 'You have full access to Norva.';
                if (button && !isNativeShell()) button.style.display = 'none';
            } else if (button && !isNativeShell()) {
                // A real membership exists (even while observed) → let the user open
                // the plan-management surface so the state is inspectable/actionable.
                button.style.display = '';
                button.textContent = 'Manage plan';
            }

            if (decision.failOpen && !observing) {
                hint.textContent = `${hint.textContent} Last known access is being honored while billing is checked.`;
            }
        } catch (err) {
            console.warn('[Settings] Unable to load Norva access:', err);
            plan.textContent = 'Access temporarily unavailable';
            hint.textContent = 'Norva will keep access open briefly while billing status is checked.';
        }
    }

    // Human plan name from a plan_code ('plus' is marketed as plain "Norva").
    planName(decision = {}) {
        const plan = String(decision.planCode || decision.plan_code || decision.projection?.plan_code || '').toLowerCase();
        if (plan === 'family') return 'Norva Family';
        if (plan === 'premium') return 'Norva Premium';
        if (plan === 'plus') return 'Norva';
        return null;
    }

    // Big label = the real membership state. Falls back to "Full access" only when
    // there is genuinely no subscription (handled by the caller in observe mode).
    accessLabel(decision = {}) {
        const status = String(decision.status || '').toLowerCase();
        const name = this.planName(decision);
        const withPlan = (suffix) => name ? `${name} · ${suffix}` : suffix;
        switch (status) {
            case 'trialing': return withPlan('Free trial');
            case 'active': return withPlan('Active');
            case 'cancelled_at_period_end': return withPlan('Ending soon');
            case 'past_due': return withPlan('Payment due');
            case 'grace': return withPlan('Payment retrying');
            case 'expired': return 'Plan expired';
            default: return 'Full access';
        }
    }

    // Sub-text = what the state means + the relevant date, in plain language.
    accessHint(decision = {}) {
        const status = String(decision.status || '').toLowerCase();
        const p = decision.projection || {};
        const fmt = (iso) => { try { return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_) { return null; } };
        const daysLeft = (iso) => { const t = new Date(iso).getTime(); return Number.isFinite(t) ? Math.max(0, Math.ceil((t - Date.now()) / 86400000)) : null; };
        switch (status) {
            case 'trialing': {
                const endIso = p.trial_ends_at || p.current_period_end;
                const d = endIso ? daysLeft(endIso) : null;
                const when = endIso ? fmt(endIso) : null;
                if (d != null && when) {
                    return d > 0
                        ? `Free trial — ${d} day${d === 1 ? '' : 's'} left. Renews ${when} unless cancelled.`
                        : `Trial ends today (${when}). You’ll be charged unless you cancel.`;
                }
                return 'Your free trial is active.';
            }
            case 'active': {
                const when = p.current_period_end ? fmt(p.current_period_end) : null;
                return when ? `Your plan renews on ${when}. Cancel anytime.` : 'Your plan is active.';
            }
            case 'cancelled_at_period_end': {
                const when = p.current_period_end ? fmt(p.current_period_end) : null;
                return when ? `Access continues until ${when}, then your plan ends.` : 'Your plan ends at the end of the current period.';
            }
            case 'past_due':
                return 'Your last payment didn’t go through. Update your payment method to keep access.';
            case 'grace':
                return 'We’re retrying your payment — access continues in the meantime.';
            case 'expired':
                return 'Your plan has expired. Choose a plan to keep watching.';
            default:
                return 'You have full access to Norva.';
        }
    }

    async refreshSourceHealthCard() {
        const container = document.getElementById('settings-service-health');
        if (!container || !window.NorvaSourceHealth) return;

        try {
            const summary = await window.NorvaSourceHealth.loadSummary();
            this.lastSourceHealthSummary = summary;
            container.innerHTML = window.NorvaSourceHealth.cardHtml(summary, { hideWhenReady: false });
        } catch (err) {
            console.warn('[Settings] Unable to load TV service health:', err);
            container.innerHTML = '';
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
                // The "even when closed" cadence is the Premium tier (cloud cron,
                // not built yet). Selecting it logs the conversion signal, shows
                // the upsell and reverts — nothing is enforced.
                if (autoRefreshInterval.value === 'premium') {
                    try { window.NorvaCloud?.entitlements?.recordSignal?.('auto_refresh_background', { source: 'frequency_select' }); } catch (_) { /* best-effort */ }
                    try { this.app.sourceManager?.toast?.('Background updates even when Norva is closed are coming with Premium ✦'); } catch (_) { /* noop */ }
                    autoRefreshInterval.value = lastFreeInterval;
                    return;
                }
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
            window.NorvaModal?.toast?.('Could not load your preferences — reopen Settings to retry.', 'error');
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
            const baseHint = hint?.textContent || 'Catalog region changes only the presentation order, not access.';
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
                if (hint) hint.textContent = `Syncing catalog for ${regionApi?.label?.(value) || value}...`;
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
                    window.NorvaModal?.toast?.('Could not finish switching region — please retry.', 'error');
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
            if (st.running) {
                return `Enriching… ${st.processed}/${st.total} titles (${st.matched} matched)`;
            }
            if (st.finishedAt) {
                const errors = st.failed ? `, ${st.failed} errors` : '';
                return `Last run: ${st.matched}/${st.total || 0} matched${errors}.`;
            }
            return 'Runs automatically after each sync when a TMDB key is set.';
        };

        let pollTimer = null;
        const pollStatus = () => {
            clearInterval(pollTimer);
            pollTimer = setInterval(async () => {
                try {
                    const st = await API.tmdb.status();
                    if (statusHint) statusHint.textContent = formatStatus(st);
                    if (enrichBtn) enrichBtn.textContent = st.running ? 'Running…' : 'Enrich Now';
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
                if (enrichBtn) enrichBtn.textContent = 'Running…';
                pollStatus();
            }
        }).catch(() => { });

        resetBrokenBtn?.addEventListener('click', async () => {
            try {
                resetBrokenBtn.disabled = true;
                resetBrokenBtn.textContent = 'Restoring…';
                const res = await fetch('/api/playback-status/reset-connection-errors', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    const n = data.reset;
                    if (resetBrokenHint) resetBrokenHint.textContent = n > 0
                        ? `${n} title${n > 1 ? 's' : ''} restored. Reload Movies/Series to see them again.`
                        : 'No incorrectly hidden titles found — nothing to restore.';
                    resetBrokenBtn.textContent = 'Done';
                } else {
                    if (resetBrokenHint) resetBrokenHint.textContent = 'Error: ' + (data.error || 'unknown');
                    resetBrokenBtn.textContent = 'Restore titles';
                    resetBrokenBtn.disabled = false;
                }
            } catch (err) {
                if (resetBrokenHint) resetBrokenHint.textContent = 'Error: ' + err.message;
                resetBrokenBtn.textContent = 'Restore titles';
                resetBrokenBtn.disabled = false;
            }
        });

        enrichBtn?.addEventListener('click', async () => {
            try {
                // Make sure the latest key is saved before starting
                if (tmdbKeyInput) {
                    await API.settings.update({ tmdbApiKey: tmdbKeyInput.value.trim() });
                }
                const result = await API.tmdb.enrich();
                if (result.started) {
                    enrichBtn.textContent = 'Running…';
                    if (statusHint) statusHint.textContent = 'Starting enrichment…';
                    pollStatus();
                } else if (result.reason === 'no-api-key') {
                    if (statusHint) statusHint.textContent = 'Add a TMDB API key first.';
                } else if (result.reason === 'already-running') {
                    pollStatus();
                }
            } catch (err) {
                if (statusHint) statusHint.textContent = `Error: ${err.message}`;
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
            sound:   { toggle: 'setting-force-transcode-tc', msg: 'Turned on the audio fix (Dolby/AC3 → browser-friendly sound). Play the channel again.' },
            black:   { toggle: 'setting-force-proxy-tc', msg: "Now fetching the stream through Norva's servers to get past what stopped it loading. Try again." },
            blocked: { toggle: 'setting-force-proxy-tc', msg: "Now streaming through Norva's servers to bypass provider blocks. Try again." },
            buffer:  { selects: [['setting-quality', 'low'], ['setting-max-resolution', '720p']], msg: 'Lowered quality to reduce buffering. Raise it again once it plays smoothly.' }
        };

        const flash = (el) => el?.closest('.setting-item')?.classList.add('tc-flash');
        const setToggle = (id) => {
            const el = document.getElementById(id);
            if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
            flash(el);
        };
        const setSelect = (id, val) => {
            const el = document.getElementById(id);
            if (el && el.value !== val) { el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }
            flash(el);
        };

        wiz.addEventListener('click', (e) => {
            const btn = e.target.closest('.tc-wizard-opt');
            if (!btn) return;
            const fix = FIXES[btn.dataset.fix];
            if (!fix) return;
            if (fix.toggle) setToggle(fix.toggle);
            (fix.selects || []).forEach(([id, val]) => setSelect(id, val));
            wiz.querySelectorAll('.tc-wizard-opt').forEach(o => o.classList.toggle('is-active', o === btn));
            if (resultEl) { resultEl.textContent = '✓ ' + fix.msg; resultEl.classList.remove('hidden'); }
            window.NorvaModal?.toast('Applied a fix — try the channel again.', 'success');
            setTimeout(() => {
                document.getElementById('tab-transcode')?.querySelectorAll('.tc-flash')
                    .forEach(el => el.classList.remove('tc-flash'));
            }, 2400);
        });

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
                    <span class="hw-badge">✓ NVIDIA</span>
                    <span class="hw-name">${hwInfo.nvidia.name}</span>
                </div>`);
            }

            if (hwInfo.amf?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ AMD</span>
                    <span class="hw-name">${hwInfo.amf.name || 'Available'}</span>
                </div>`);
            }

            if (hwInfo.qsv?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ Intel QSV</span>
                    <span class="hw-name">Available</span>
                </div>`);
            }

            if (hwInfo.vaapi?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ VAAPI</span>
                    <span class="hw-name">${hwInfo.vaapi.device || 'Available'}</span>
                </div>`);
            }

            let html;
            if (detected.length > 0) {
                html = `<div class="hw-info-grid">${detected.join('')}</div>`;
                html += `<p class="hint" style="margin-top: var(--space-sm);">Recommended encoder: <strong>${hwInfo.recommended}</strong></p>`;
            } else {
                html = `<p class="hint">No GPU acceleration detected. Using software encoding.</p>`;
            }

            container.innerHTML = html;
        } catch (err) {
            console.error('Error loading hardware info:', err);
            container.innerHTML = '<p class="hint">Couldn\'t check your hardware right now — Norva will use software encoding, which works everywhere.</p>';
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
                    NorvaModal.toast('User created successfully!', 'success');
                    addUserForm.reset();
                    this.loadUsers();
                } catch (err) {
                    NorvaModal.toast('Error creating user: ' + err.message, 'error');
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
                userList.innerHTML = '<tr><td colspan="5" class="hint">No users found</td></tr>';
                return;
            }

            userList.innerHTML = users.map(user => {
                const isSSO = !!user.oidcId;
                const typeBadge = isSSO
                    ? '<span class="user-badge user-badge-sso">SSO</span>'
                    : '<span class="user-badge user-badge-local">Local</span>';

                const roleBadge = user.role === 'admin'
                    ? '<span class="user-badge user-badge-admin">Admin</span>'
                    : '<span class="user-badge user-badge-viewer">Viewer</span>';

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
                    <td>${user.createdAt ? new Date(user.createdAt).toLocaleDateString('en-US') : 'N/A'}</td>
                    <td>
                        <button class="btn btn-sm btn-secondary" onclick="window.app.pages.settings.openEditUserModal(${user.id})">Edit</button>
                        <button class="btn btn-sm btn-error" onclick="window.app.pages.settings.deleteUser(${user.id}, '${user.username}')">Delete</button>
                    </td>
                </tr>
            `}).join('');
        } catch (err) {
            console.error('Error loading users:', err);
            userList.innerHTML = '<tr><td colspan="5" class="hint">Error loading users</td></tr>';
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
            NorvaModal.toast('Error: could not open the editor. Please refresh the page.', 'error');
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
                    editPassword.placeholder = "Managed by SSO Provider";
                }
                if (passwordHint) passwordHint.textContent = "Password cannot be changed for SSO users.";
                if (oidcGroup) oidcGroup.classList.remove('hidden');
                if (oidcIdDisplay) oidcIdDisplay.textContent = user.oidcId;
            } else {
                if (editPassword) {
                    editPassword.disabled = false;
                    editPassword.placeholder = "Leave blank to keep current";
                }
                if (passwordHint) passwordHint.textContent = "Optional. Leave blank to keep unchanged.";
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
            NorvaModal.toast('Error opening edit modal: ' + err.message, 'error');
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
                NorvaModal.toast('Username cannot be empty.', 'error');
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
                NorvaModal.toast('User updated.', 'success');
                closeModal();
                this.loadUsers();
            } catch (err) {
                NorvaModal.toast('Error updating user: ' + err.message, 'error');
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
            `"${username}" will lose access to this Norva server. This cannot be undone.`,
            { title: 'Delete user?', confirmLabel: 'Delete', danger: true }
        );
        if (!ok) return;

        try {
            await API.users.delete(userId);
            this.loadUsers();
        } catch (err) {
            NorvaModal.toast('Error deleting user: ' + err.message, 'error');
        }
    }

    // --- Screens & pairing tab (display name / pairing / devices / command) ---
    initScreensTab() {
        if (!this.screensBound) {
            this.screensBound = true;
            document.getElementById('screens-save-profile')?.addEventListener('click', () => this.saveScreensProfile());
            const pair = document.getElementById('screens-pair-code');
            pair?.addEventListener('input', () => { pair.value = pair.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); });
            pair?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.approvePairCode(); });
            document.getElementById('screens-approve')?.addEventListener('click', () => this.approvePairCode());
            document.getElementById('screens-send-play')?.addEventListener('click', () => this.sendScreenCommand('play'));
            document.getElementById('screens-send-open')?.addEventListener('click', () => this.sendScreenCommand('open'));
        }
        this.loadScreensProfile();
        this.loadTrustedDevices();
    }

    setScreensStatus(el, type, message) {
        if (!el) return;
        el.textContent = message || '';
        el.style.color = type === 'success' ? '#34d399' : type === 'error' ? '#fb7185' : '#a8b3c7';
    }

    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    escapeAttr(value) { return this.escapeHtml(value); }

    async loadScreensProfile() {
        try {
            const profile = await window.NorvaCloud.profile.get();
            const el = document.getElementById('screens-display-name');
            if (el) el.value = profile?.display_name || profile?.displayName || '';
        } catch (_) { /* ignore */ }
    }

    async saveScreensProfile() {
        const status = document.getElementById('screens-profile-status');
        const name = (document.getElementById('screens-display-name')?.value || '').trim();
        try {
            this.setScreensStatus(status, 'info', 'Saving…');
            await window.NorvaCloud.profile.save({ displayName: name, locale: navigator.language || 'en-US' });
            this.setScreensStatus(status, 'success', 'Saved.');
        } catch (e) {
            this.setScreensStatus(status, 'error', e?.message || 'Unable to save.');
        }
    }

    async approvePairCode() {
        const input = document.getElementById('screens-pair-code');
        const status = document.getElementById('screens-pair-status');
        const code = (input?.value || '').trim().toUpperCase();
        if (!code) { this.setScreensStatus(status, 'error', 'Enter the pairing code shown on the screen.'); return; }
        try {
            this.setScreensStatus(status, 'info', 'Approving…');
            await window.NorvaCloud.pairing.approve(code);
            this.setScreensStatus(status, 'success', 'Device approved.');
            if (input) input.value = '';
            this.loadTrustedDevices();
        } catch (e) {
            this.setScreensStatus(status, 'error', e?.message || 'Unable to approve this code.');
        }
    }

    async loadTrustedDevices() {
        const listEl = document.getElementById('screens-devices-list');
        const status = document.getElementById('screens-devices-status');
        const select = document.getElementById('screens-command-device');
        if (!listEl) return;
        try {
            const payload = await window.NorvaCloud.devices.list();
            const devices = (payload.devices || []).filter((d) => !d.revoked);
            if (select) {
                select.innerHTML = devices.length
                    ? devices.map((d) => `<option value="${this.escapeAttr(d.id)}">${this.escapeHtml(d.device_name || this.deviceTypeLabel(d))}</option>`).join('')
                    : '<option value="">No screen linked yet</option>';
            }
            listEl.innerHTML = devices.length
                ? devices.map((d) => this.renderTrustedDevice(d)).join('')
                : '<div class="screens-empty">No screens linked yet.<br>Pair a TV, phone or browser above to see it here.</div>';
            listEl.querySelectorAll('[data-revoke-device]').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const ok = await NorvaModal.confirm(
                        'This screen will need to be paired again to reconnect to your account.',
                        { title: 'Remove screen?', confirmLabel: 'Remove screen', danger: true }
                    );
                    if (!ok) return;
                    const id = btn.dataset.revokeDevice;
                    btn.disabled = true;
                    try {
                        await window.NorvaCloud.devices.revoke(id);
                        // If we just revoked THIS browser/screen, drop the now-dead device
                        // token so subsequent device-scoped calls don't keep using it until
                        // a late 401 (matches cloud.html's revoke cleanup).
                        try {
                            if (localStorage.getItem('norva-cloud-device-id') === id) {
                                window.NorvaCloud?.setDeviceToken?.('');
                                localStorage.removeItem('norva-cloud-device-id');
                            }
                        } catch (_) { /* noop */ }
                        this.loadTrustedDevices();
                        this.setScreensStatus(status, 'success', 'Screen revoked.');
                    } catch (e) {
                        btn.disabled = false;
                        this.setScreensStatus(status, 'error', e?.message || 'Unable to revoke.');
                    }
                });
            });
        } catch (e) {
            this.setScreensStatus(status, 'error', e?.message || 'Unable to load devices.');
        }
    }

    renderTrustedDevice(device) {
        const seen = device.last_seen_at ? this.relativeTime(device.last_seen_at) : 'Never connected';
        return `<div class="device-card">
            <div class="dc-icon">${this.deviceIcon(device)}</div>
            <div class="dc-info">
                <div class="dc-name">${this.escapeHtml(device.device_name || this.deviceTypeLabel(device))}</div>
                <div class="dc-meta">${this.escapeHtml(this.deviceTypeLabel(device))} · ${this.escapeHtml(seen)}</div>
            </div>
            <button class="dc-remove" type="button" data-revoke-device="${this.escapeAttr(device.id)}">Remove</button>
        </div>`;
    }

    // Normalise a device into one of: tv | phone | tablet | web | screen
    deviceKind(device) {
        const hint = `${device.device_type || ''} ${device.platform || ''} ${device.device_name || ''}`.toLowerCase();
        if (/\btv\b|androidtv|android tv|firetv|fire tv|tvos|appletv|apple tv|chromecast|cast|roku|webos|tizen|bravia/.test(hint)) return 'tv';
        if (/tablet|ipad/.test(hint)) return 'tablet';
        if (/phone|android|iphone|ios|mobile/.test(hint)) return 'phone';
        if (/web|browser|chrome|firefox|safari|edge|desktop|windows|mac|linux/.test(hint)) return 'web';
        return 'screen';
    }

    deviceTypeLabel(device) {
        switch (this.deviceKind(device)) {
            case 'tv': return 'TV';
            case 'phone': return 'Phone';
            case 'tablet': return 'Tablet';
            case 'web': return 'Web browser';
            default: return 'Screen';
        }
    }

    deviceIcon(device) {
        const icons = {
            tv: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
            phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
            tablet: '<rect x="4" y="2" width="16" height="20" rx="2.5"/><path d="M11 18h2"/>',
            web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18"/>',
            screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/>'
        };
        const kind = this.deviceKind(device);
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[kind] || icons.screen}</svg>`;
    }

    relativeTime(iso) {
        const then = new Date(iso).getTime();
        if (!Number.isFinite(then)) return 'Recently';
        const diff = Date.now() - then;
        if (diff < 0) return 'Just now';
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'Just now';
        if (mins < 60) return `${mins} min ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs} h ago`;
        const days = Math.floor(hrs / 24);
        if (days < 7) return `${days} d ago`;
        if (days < 30) return `${Math.floor(days / 7)} wk ago`;
        return new Date(iso).toLocaleDateString('en-US');
    }

    async sendScreenCommand(command) {
        const status = document.getElementById('screens-command-status');
        const targetDeviceId = document.getElementById('screens-command-device')?.value;
        const url = (document.getElementById('screens-command-url')?.value || '').trim();
        const title = (document.getElementById('screens-command-title')?.value || '').trim() || 'Norva';
        if (!targetDeviceId) { this.setScreensStatus(status, 'error', 'Choose a trusted screen.'); return; }
        if (command === 'play' && !url) { this.setScreensStatus(status, 'error', 'Enter a playback URL.'); return; }
        try {
            this.setScreensStatus(status, 'info', 'Sending…');
            await window.NorvaCloud.commands.queue({
                targetDeviceId,
                command,
                payload: command === 'play' ? { url, playbackUrl: url, title } : { url: url || '/' },
                ttlSeconds: 120
            });
            this.setScreensStatus(status, 'success', 'Command sent.');
        } catch (e) {
            this.setScreensStatus(status, 'error', e?.message || 'Unable to send command.');
        }
    }

    switchTab(tabName) {
        this.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
        this.tabContents.forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));

        // If an "advanced" tab is activated (e.g. programmatically) while collapsed
        // on phone, reveal the advanced group so the active tab is visible.
        const activeTab = [...this.tabs].find(t => t.dataset.tab === tabName);
        if (activeTab?.classList.contains('tab-advanced')) {
            document.querySelector('.settings-container .tabs')?.classList.add('show-advanced');
        }

        // Load content browser when switching to that tab
        if (tabName === 'content') {
            this.app.sourceManager.loadContentSources();
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
        }
    }

    async show() {
        // Local hub user management stays available to local admins only.
        const usersTab = document.getElementById('users-tab');
        const canManageLocalUsers = this.app.currentUser?.role === 'admin' && !this.app.currentUser?.cloud;
        if (usersTab) {
            usersTab.style.display = canManageLocalUsers ? 'block' : 'none';
            if (!canManageLocalUsers && usersTab.classList.contains('active')) {
                this.switchTab('account');
            }
        }

        // "Screens & pairing" (devices) is a cloud-account-only feature.
        const screensTab = document.getElementById('screens-tab');
        if (screensTab) {
            const cloudUser = !!this.app.currentUser?.cloud;
            screensTab.style.display = cloudUser ? 'block' : 'none';
            if (!cloudUser && screensTab.classList.contains('active')) {
                this.switchTab('account');
            }
        }

        // Load sources when page is shown
        await this.app.sourceManager.loadSources();
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
                    text = 'Just now';
                } else if (diffMins < 60) {
                    text = `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
                } else if (diffHours < 24) {
                    text = `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
                } else {
                    // Use absolute time for older refreshes
                    text = lastRefreshTime.toLocaleString('en-US');
                }

                display.textContent = text;
                display.title = lastRefreshTime.toLocaleString('en-US'); // Full timestamp on hover
            } else {
                display.textContent = 'Never';
                display.title = 'Sync has not run yet since server started';
            }
        } catch (err) {
            console.debug('Sync status unavailable:', err);
            display.textContent = 'Unknown';
            display.title = 'Could not fetch sync status';
        }
    }

    hide() {
        // Page is hidden
    }
}

window.SettingsPage = SettingsPage;
