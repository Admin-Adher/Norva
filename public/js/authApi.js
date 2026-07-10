/**
 * Norva Account auth client.
 *
 * Uses Supabase Auth REST endpoints directly so static Norva surfaces can
 * authenticate without a build step. Only the publishable key is embedded.
 */
(function () {
    'use strict';

    const DEFAULT_SUPABASE_URL = 'https://oupsceccxsonaalhueff.supabase.co';
    const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_LJwYVgPGHYNYTDk7s3eOew_6TU73Fcw';
    const KEY_SESSION = 'norva-cloud-session';

    function supabaseUrl() {
        return (localStorage.getItem('norva-supabase-url') || window.NORVA_SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
    }

    function publishableKey() {
        return localStorage.getItem('norva-supabase-key') || window.NORVA_SUPABASE_PUBLISHABLE_KEY || DEFAULT_PUBLISHABLE_KEY;
    }

    function getSession() {
        try {
            return JSON.parse(localStorage.getItem(KEY_SESSION) || 'null');
        } catch (_) {
            return null;
        }
    }

    function setSession(session) {
        if (!session || !session.access_token) {
            localStorage.removeItem(KEY_SESSION);
            if (window.NorvaCloud) window.NorvaCloud.setToken(null);
            return null;
        }

        const expiresIn = Number(session.expires_in || 3600);
        const normalized = {
            access_token: session.access_token,
            refresh_token: session.refresh_token || getSession()?.refresh_token || '',
            token_type: session.token_type || 'bearer',
            expires_at: session.expires_at || Math.floor(Date.now() / 1000) + expiresIn,
            user: session.user || getSession()?.user || null
        };
        localStorage.setItem(KEY_SESSION, JSON.stringify(normalized));
        if (window.NorvaCloud) window.NorvaCloud.setToken(normalized.access_token);
        return normalized;
    }

    function clearSession() {
        localStorage.removeItem(KEY_SESSION);
        if (window.NorvaCloud) window.NorvaCloud.setToken(null);
    }

    async function request(path, options = {}) {
        const headers = {
            apikey: publishableKey(),
            Authorization: `Bearer ${publishableKey()}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };
        if (options.token) headers.Authorization = `Bearer ${options.token}`;

        const response = await fetch(`${supabaseUrl()}${path}`, {
            method: options.method || 'GET',
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body)
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const message = payload.msg || payload.message || payload.error_description || payload.error || `Supabase Auth ${response.status}`;
            const error = new Error(message);
            error.status = response.status;
            error.payload = payload;
            throw error;
        }
        return payload;
    }

    async function signUp({ email, password, displayName }) {
        const redirectTo = `${location.origin}/account.html`;
        const payload = await request(`/auth/v1/signup?redirect_to=${encodeURIComponent(redirectTo)}`, {
            method: 'POST',
            body: {
                email,
                password,
                data: {
                    display_name: displayName || ''
                }
            }
        });

        if (payload.session) setSession(payload.session);
        else if (payload.access_token) setSession(payload);
        return payload;
    }

    async function signIn({ email, password }) {
        const payload = await request('/auth/v1/token?grant_type=password', {
            method: 'POST',
            body: { email, password }
        });
        return setSession(payload);
    }

    // Social sign-in (Google/Apple/etc.) via Supabase GoTrue. Full-page redirect to
    // the provider; on return, GoTrue appends the session to the URL fragment of
    // `redirectTo`, which captureSessionFromUrl() picks up. Requires the provider to
    // be enabled in the Supabase dashboard (Auth → Providers) and `redirectTo` to be
    // allow-listed in Auth → URL Configuration. No-ops for an empty provider.
    function signInWithOAuth(provider, redirectTo) {
        if (!provider) return;
        const url = new URL(`${supabaseUrl()}/auth/v1/authorize`);
        url.searchParams.set('provider', provider);
        url.searchParams.set('redirect_to', redirectTo || `${location.origin}/account.html`);
        location.assign(url.toString());
    }

    // Native social sign-in: exchange a provider ID token (obtained by a native
    // SDK — e.g. Android Credential Manager / Google Sign-In) for a Norva
    // session, without any browser redirect. The native shell fetches the ID
    // token, then hands it to the web layer, which calls this. Requires the
    // provider to be enabled in Supabase and the native OAuth client ID(s) to be
    // allow-listed under Auth → Providers → (provider) → Authorized Client IDs.
    async function signInWithIdToken({ provider, token, accessToken, nonce } = {}) {
        if (!provider || !token) throw new Error('signInWithIdToken requires { provider, token }');
        const payload = await request('/auth/v1/token?grant_type=id_token', {
            method: 'POST',
            body: {
                provider,
                id_token: token,
                access_token: accessToken || undefined,
                nonce: nonce || undefined
            }
        });
        return setSession(payload);
    }

    // Passwordless sign-in: emails a one-time magic link (branded "Sign in to
    // Norva" via the norva-auth-email hook). The link returns to account.html with
    // a token_hash that boot()/verifyOtp() exchanges for a session — so a
    // Google-first user (who has no password) can still "sign in with email".
    // create_user:false so the login form never silently provisions a new account;
    // GoTrue stays quiet for unknown emails (anti-enumeration), so callers should
    // show a neutral "if that email exists, we sent a link" message.
    async function signInWithOtp(email, redirectTo, options = {}) {
        const rt = redirectTo || `${location.origin}/account.html`;
        // create_user:true for passwordless SIGN-UP (provision the account from the
        // link); false for LOGIN (never silently create an account from the form).
        return request(`/auth/v1/otp?redirect_to=${encodeURIComponent(rt)}`, {
            method: 'POST',
            body: { email, create_user: options.createUser === true, data: options.data || undefined }
        });
    }

    // Call a Postgres RPC (PostgREST /rest/v1/rpc/<fn>) as the signed-in user, so
    // SECURITY DEFINER functions can read the caller's own auth state (e.g.
    // auth_methods_self → has_password/providers). apikey stays the publishable
    // key; Authorization is swapped to the user's access token by request().
    async function rpc(fn, args) {
        const token = await getAccessToken();
        if (!token) throw new Error('Not signed in');
        return request(`/rest/v1/rpc/${fn}`, { method: 'POST', token, body: args || {} });
    }

    // ── Session refresh: single-flight, cross-tab-locked, rotation-safe ────────
    // Supabase refresh tokens are SINGLE-USE: two concurrent refreshes with the
    // same token (e.g. two tabs waking after an idle hour) trip GoTrue's reuse
    // detection, which revokes the WHOLE session family — a very real "logged out
    // for no reason". And a swallowed transient failure (network not up yet at
    // laptop wake, Supabase 5xx) must NOT read as "signed out": the refresh_token
    // in storage is still valid. So:
    //  • one in-flight refresh per tab (shared promise),
    //  • one refresher across tabs (navigator.locks; localStorage-lease fallback),
    //  • under the lock, re-read the session — if another tab already rotated it,
    //    adopt that result instead of POSTing the now-burned token,
    //  • classify failures: ONLY a 400/401 from POST /token — for the token that
    //    is STILL the stored one — is definitive (err.definitive=true; the session
    //    is cleared). Everything else (network TypeError, 5xx, 429) is transient
    //    (err.transient=true): the session is KEPT and one quick retry runs inside
    //    GoTrue's ~10s reuse interval, which also recovers a "burned" token whose
    //    rotation response was lost mid-flight.
    let refreshInFlight = null;
    const KEY_REFRESH_LOCK = 'norva-session-refresh-lock';

    function classifyRefreshError(error, failedToken) {
        const status = Number(error?.status || 0);
        if (status === 400 || status === 401) {
            const stored = getSession()?.refresh_token || '';
            if (stored && failedToken && stored !== failedToken) {
                // Another tab rotated while our POST was failing — our token was just
                // stale, the session itself is fine.
                error.transient = true;
            } else {
                error.definitive = true;
            }
        } else {
            error.transient = true;
        }
        return error;
    }

    async function refreshSessionOnce() {
        const current = getSession();
        if (!current?.refresh_token) return null;
        const attemptedToken = current.refresh_token;
        try {
            const payload = await request('/auth/v1/token?grant_type=refresh_token', {
                method: 'POST',
                body: { refresh_token: attemptedToken }
            });
            return setSession(payload);
        } catch (error) {
            throw classifyRefreshError(error, attemptedToken);
        }
    }

    async function lockedRefresh() {
        // Re-read under the lock: another tab may have refreshed while we waited.
        const now = Math.floor(Date.now() / 1000);
        const fresh = getSession();
        if (!fresh?.refresh_token) return null;
        if (fresh.expires_at && Number(fresh.expires_at) > now + 60) return fresh;
        try {
            return await refreshSessionOnce();
        } catch (error) {
            if (error.definitive) { clearSession(); throw error; }
            // Transient: one quick retry (still inside GoTrue's reuse interval).
            await new Promise((r) => setTimeout(r, 1500));
            try {
                return await refreshSessionOnce();
            } catch (again) {
                if (again.definitive) clearSession();
                throw again;
            }
        }
    }

    function withCrossTabLock(fn) {
        try {
            if (navigator.locks?.request) {
                return navigator.locks.request('norva-session-refresh', fn);
            }
        } catch (_) { /* fall through to the lease fallback */ }
        // Fallback (old WebViews): best-effort localStorage lease. If another tab
        // holds it, wait a beat and adopt whatever it wrote instead of racing.
        try {
            const now = Date.now();
            const held = Number(localStorage.getItem(KEY_REFRESH_LOCK) || 0);
            if (held && now - held < 10_000) {
                return new Promise((r) => setTimeout(r, 1500)).then(() => getSession());
            }
            localStorage.setItem(KEY_REFRESH_LOCK, String(now));
            return Promise.resolve().then(fn).finally(() => {
                try { localStorage.removeItem(KEY_REFRESH_LOCK); } catch (_) { /* noop */ }
            });
        } catch (_) {
            return Promise.resolve().then(fn);
        }
    }

    function refreshSession() {
        if (refreshInFlight) return refreshInFlight;
        refreshInFlight = Promise.resolve(withCrossTabLock(lockedRefresh))
            .finally(() => { refreshInFlight = null; });
        return refreshInFlight;
    }

    async function getAccessToken() {
        let session = getSession();
        if (!session) return '';
        if (session.expires_at && session.expires_at - 60 <= Math.floor(Date.now() / 1000)) {
            window.NorvaTrace?.log?.('auth token near expiry → refreshSession (network POST /token)');
            try {
                session = await refreshSession();
            } catch (error) {
                if (error?.definitive) return '';   // session cleared — really signed out
                // TRANSIENT failure: keep the stored session and hand back the stale
                // token. A downstream 401 re-enters the (single-flighted) refresh, so
                // the session heals instead of the app looking logged out.
                session = getSession();
            }
        }
        if (session?.access_token && window.NorvaCloud) window.NorvaCloud.setToken(session.access_token);
        return session?.access_token || '';
    }

    async function getUser() {
        const _done = window.NorvaTrace?.time?.('auth getUser — token check + GoTrue /auth/v1/user');
        const token = await getAccessToken();
        if (!token) { if (_done) _done('no session token'); return null; }
        const user = await request('/auth/v1/user', { token }).catch(async (error) => {
            if (error.status === 401) {
                // refreshSession throws with .definitive/.transient set — let that
                // propagate so callers can tell "really signed out" from "network blip".
                const refreshed = await refreshSession();
                if (refreshed?.access_token) return request('/auth/v1/user', { token: refreshed.access_token });
            }
            // /user itself failed with a non-auth error (network TypeError has no
            // status; 5xx/429 are server-side trouble): mark transient so callers
            // keep the session instead of treating it as a logout.
            if (!error.definitive && (!error.status || error.status >= 500 || error.status === 429)) {
                error.transient = true;
            }
            throw error;
        });

        const session = getSession();
        if (session) setSession({ ...session, user });
        if (_done) _done('ok');
        return user;
    }

    async function signOut() {
        const token = await getAccessToken();
        if (token) {
            // scope=local: sign out THIS device only. GoTrue's default scope is
            // "global", which revokes every session of the account — i.e. pressing
            // Log out on one household device silently logged out all the OTHER
            // devices too, which then looked like "logged out after inactivity" at
            // their next wake. Only the logout button, only this device.
            await request('/auth/v1/logout?scope=local', { method: 'POST', token }).catch(() => {});
        }
        clearSession();
    }

    async function recover(email) {
        const redirectTo = `${location.origin}/account.html?mode=recovery`;
        return request(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
            method: 'POST',
            body: { email }
        });
    }

    async function updatePassword(password) {
        const token = await getAccessToken();
        if (!token) throw new Error('Not signed in');
        const user = await request('/auth/v1/user', {
            method: 'PUT',
            token,
            body: { password }
        });
        const session = getSession();
        if (session) setSession({ ...session, user });
        return user;
    }

    async function deleteAccount(confirm) {
        const token = await getAccessToken();
        if (!token) throw new Error('Not signed in');
        // Calls the norva-account-delete edge function, which re-verifies this
        // JWT server-side and deletes the auth user. Every user-owned table
        // references auth.users(id) ON DELETE CASCADE, so all data goes with it.
        const result = await request('/functions/v1/norva-account-delete', {
            method: 'POST',
            token,
            body: { confirm: confirm || 'DELETE' }
        });
        clearSession();
        return result;
    }

    function captureSessionFromUrl() {
        const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
        const accessToken = hash.get('access_token');
        if (!accessToken) return null;

        const session = setSession({
            access_token: accessToken,
            refresh_token: hash.get('refresh_token') || '',
            token_type: hash.get('token_type') || 'bearer',
            expires_in: Number(hash.get('expires_in') || 3600)
        });
        history.replaceState({}, document.title, location.pathname + location.search);
        return session;
    }

    // Verify a one-time email token (recovery / signup / magic link / email change /
    // invite) from a norva.tv page, so the email's action link can point at norva.tv
    // instead of the raw supabase.co/auth/v1/verify URL. POST returns the session.
    async function verifyOtp(tokenHash, type) {
        const payload = await request('/auth/v1/verify', {
            method: 'POST',
            body: { type: type || 'recovery', token_hash: tokenHash }
        });
        if (payload && payload.access_token) return setSession(payload);
        if (payload && payload.session) return setSession(payload.session);
        return null;
    }

    window.NorvaAuth = {
        get supabaseUrl() { return supabaseUrl(); },
        get publishableKey() { return publishableKey(); },
        getSession,
        setSession,
        clearSession,
        signUp,
        signIn,
        signOut,
        recover,
        updatePassword,
        deleteAccount,
        refreshSession,
        getAccessToken,
        getUser,
        captureSessionFromUrl,
        verifyOtp,
        signInWithOAuth,
        signInWithIdToken,
        signInWithOtp,
        rpc
    };
})();
