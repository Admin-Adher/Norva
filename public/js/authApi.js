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

    async function refreshSession() {
        const current = getSession();
        if (!current?.refresh_token) return null;
        const payload = await request('/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            body: { refresh_token: current.refresh_token }
        });
        return setSession(payload);
    }

    async function getAccessToken() {
        let session = getSession();
        if (!session) return '';
        if (session.expires_at && session.expires_at - 60 <= Math.floor(Date.now() / 1000)) {
            session = await refreshSession().catch(() => null);
        }
        if (session?.access_token && window.NorvaCloud) window.NorvaCloud.setToken(session.access_token);
        return session?.access_token || '';
    }

    async function getUser() {
        const token = await getAccessToken();
        if (!token) return null;
        const user = await request('/auth/v1/user', { token }).catch(async (error) => {
            if (error.status === 401) {
                const refreshed = await refreshSession().catch(() => null);
                if (refreshed?.access_token) return request('/auth/v1/user', { token: refreshed.access_token });
            }
            throw error;
        });

        const session = getSession();
        if (session) setSession({ ...session, user });
        return user;
    }

    async function signOut() {
        const token = await getAccessToken();
        if (token) {
            await request('/auth/v1/logout', { method: 'POST', token }).catch(() => {});
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
        refreshSession,
        getAccessToken,
        getUser,
        captureSessionFromUrl
    };
})();
