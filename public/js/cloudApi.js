/**
 * Norva Cloud client.
 *
 * This client is intentionally thin: authentication remains owned by Supabase
 * Auth / product UI, while this wrapper gives every Norva surface the same
 * Cloud Core and Playback Session contract.
 */
(function () {
    'use strict';

    const DEFAULT_API_URL = 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-cloud';
    const DEFAULT_SOURCE_SYNC_URL = 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync';
    const DEFAULT_CATALOG_URL = 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-catalog';
    const DEFAULT_SERIES_INFO_URL = 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-series-info';
    const DEFAULT_PLAYBACK_URL = 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-playback';
    const DEFAULT_EDGE_URL = 'https://edge.norva.tv';
    const KEY_API_URL = 'norva-cloud-api-url';
    const KEY_SOURCE_SYNC_URL = 'norva-source-sync-url';
    const KEY_CATALOG_URL = 'norva-catalog-url';
    const KEY_SERIES_INFO_URL = 'norva-series-info-url';
    const KEY_PLAYBACK_URL = 'norva-playback-url';
    const KEY_EDGE_URL = 'norva-edge-url';
    const KEY_TOKEN = 'norva-cloud-token';
    const KEY_DEVICE_TOKEN = 'norva-cloud-device-token';
    const KEY_PREFERRED_CONTENT_REGION = 'norva-preferred-content-region';
    const KEY_PROFILE_CONTENT_REGION = 'norva-profile-preferred-content-region';
    const KEY_REGION_STATE = 'norva-content-region-state';
    const KEY_REGION_PROMPT_DISMISSED = 'norva-content-region-prompt-dismissed';
    const KEY_LEGACY_COUNTRY = 'norva-country';
    const CONTENT_REGION_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;
    const CONTENT_REGIONS = [
        { key: 'FR', label: 'France' },
        { key: 'US', label: 'United States' },
        { key: 'IN', label: 'India' },
        { key: 'MAGHREB', label: 'Maghreb' },
        { key: 'LUSOPHONE', label: 'Lusophone' },
        { key: 'INTERNATIONAL', label: 'International' }
    ];
    const CONTENT_REGION_LABELS = CONTENT_REGIONS.reduce((labels, region) => {
        labels[region.key] = region.label;
        return labels;
    }, {});

    function apiBase() {
        const configured = localStorage.getItem(KEY_API_URL) || window.NORVA_CLOUD_API_URL || DEFAULT_API_URL;
        return configured.replace(/\/+$/, '');
    }

    function sourceSyncBase() {
        const configured = localStorage.getItem(KEY_SOURCE_SYNC_URL) || window.NORVA_SOURCE_SYNC_URL || DEFAULT_SOURCE_SYNC_URL;
        return configured.replace(/\/+$/, '');
    }

    function catalogBase() {
        const configured = localStorage.getItem(KEY_CATALOG_URL) || window.NORVA_CATALOG_URL || DEFAULT_CATALOG_URL;
        return configured.replace(/\/+$/, '');
    }

    function seriesInfoBase() {
        const configured = localStorage.getItem(KEY_SERIES_INFO_URL) || window.NORVA_SERIES_INFO_URL || DEFAULT_SERIES_INFO_URL;
        return configured.replace(/\/+$/, '');
    }

    function playbackBase() {
        const configured = localStorage.getItem(KEY_PLAYBACK_URL) || window.NORVA_PLAYBACK_URL || DEFAULT_PLAYBACK_URL;
        return configured.replace(/\/+$/, '');
    }

    function edgeBase() {
        const configured = localStorage.getItem(KEY_EDGE_URL) || window.NORVA_EDGE_URL || window.NORVA_RELAY_BASE_URL || DEFAULT_EDGE_URL;
        return configured ? configured.replace(/\/+$/, '') : '';
    }

    function getToken() {
        return localStorage.getItem(KEY_TOKEN) || window.NORVA_CLOUD_TOKEN || '';
    }

    function setToken(token) {
        if (token) localStorage.setItem(KEY_TOKEN, token);
        else {
            localStorage.removeItem(KEY_TOKEN);
            storageRemove(KEY_PROFILE_CONTENT_REGION);
        }
    }

    function getDeviceToken() {
        return localStorage.getItem(KEY_DEVICE_TOKEN) || window.NORVA_CLOUD_DEVICE_TOKEN || '';
    }

    function setDeviceToken(token) {
        if (token) localStorage.setItem(KEY_DEVICE_TOKEN, token);
        else localStorage.removeItem(KEY_DEVICE_TOKEN);
    }

    function isInvalidDeviceTokenResponse(status, payload, message) {
        if (status !== 401) return false;
        const text = `${payload?.error || ''} ${payload?.message || ''} ${payload?.code || ''} ${message || ''}`;
        return /invalid\s+(bearer\s+)?(device\s+)?token|device\s+token|expired\s+(device\s+)?token/i.test(text);
    }

    function markInvalidDeviceToken(error, tokenUsed) {
        if (!tokenUsed || tokenUsed !== getDeviceToken()) return;
        setDeviceToken('');
        error.deviceTokenInvalid = true;
    }

    function proxyImageUrl(url) {
        const raw = String(url || '').trim();
        if (!raw) return '';
        if (/\/image\?url=/i.test(raw)) return raw;
        const edge = edgeBase();
        if (edge) return `${edge}/image?url=${encodeURIComponent(raw)}`;
        return `${apiBase()}/image?url=${encodeURIComponent(raw)}`;
    }

    function setApiUrl(url) {
        if (url) localStorage.setItem(KEY_API_URL, url.replace(/\/+$/, ''));
        else localStorage.removeItem(KEY_API_URL);
    }

    function setEdgeUrl(url) {
        if (url) localStorage.setItem(KEY_EDGE_URL, url.replace(/\/+$/, ''));
        else localStorage.removeItem(KEY_EDGE_URL);
    }

    function storageGet(key) {
        try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
    }

    function storageSet(key, value) {
        try {
            if (value === undefined || value === null || value === '') localStorage.removeItem(key);
            else localStorage.setItem(key, String(value));
        } catch (e) { }
    }

    function storageRemove(key) {
        try { localStorage.removeItem(key); } catch (e) { }
    }

    function normalizeContentRegion(value) {
        const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
        return CONTENT_REGION_PATTERN.test(normalized) ? normalized : '';
    }

    function contentRegionLabel(region) {
        const normalized = normalizeContentRegion(region);
        return CONTENT_REGION_LABELS[normalized] || normalized || 'International';
    }

    function inferContentRegionFromLocale() {
        const locales = Array.isArray(navigator.languages) && navigator.languages.length
            ? navigator.languages
            : [navigator.language || ''];
        for (const locale of locales) {
            const parts = String(locale || '').split(/[-_]/).filter(Boolean);
            const region = normalizeContentRegion(parts.length > 1 ? parts[parts.length - 1] : '');
            if (region === 'FR' || region === 'US' || region === 'IN') return region;
        }
        const language = String(locales[0] || '').split(/[-_]/)[0].toLowerCase();
        if (language === 'fr') return 'FR';
        if (['hi', 'ta', 'te', 'bn', 'mr', 'pa', 'gu', 'kn', 'ml'].includes(language)) return 'IN';
        if (language === 'en') return 'US';
        return 'INTERNATIONAL';
    }

    function rememberRegionState(state) {
        storageSet(KEY_REGION_STATE, JSON.stringify({
            region: state.region,
            status: state.status,
            source: state.source,
            suggestedRegion: state.suggestedRegion || '',
            updatedAt: new Date().toISOString()
        }));
    }

    function getStoredPreferredContentRegion() {
        const profile = normalizeContentRegion(storageGet(KEY_PROFILE_CONTENT_REGION));
        if (profile) return { region: profile, source: 'profile' };

        const local = normalizeContentRegion(storageGet(KEY_PREFERRED_CONTENT_REGION));
        if (local) return { region: local, source: 'local' };

        return null;
    }

    function getLegacyContentRegion() {
        return normalizeContentRegion(storageGet(KEY_LEGACY_COUNTRY));
    }

    function resolveContentRegion() {
        const preferred = getStoredPreferredContentRegion();
        if (preferred) {
            const resolved = {
                region: preferred.region,
                status: 'confirmed',
                source: preferred.source,
                suggestedRegion: '',
                label: contentRegionLabel(preferred.region)
            };
            rememberRegionState(resolved);
            return resolved;
        }

        const legacy = getLegacyContentRegion();
        if (legacy) {
            const resolved = {
                region: legacy,
                status: 'inferred',
                source: 'legacy',
                suggestedRegion: legacy,
                label: contentRegionLabel(legacy)
            };
            rememberRegionState(resolved);
            return resolved;
        }

        const suggestedRegion = inferContentRegionFromLocale();
        const resolved = {
            region: suggestedRegion,
            status: 'inferred',
            source: 'locale',
            suggestedRegion,
            label: contentRegionLabel(suggestedRegion)
        };
        rememberRegionState(resolved);
        return resolved;
    }

    function resolveCountry() {
        return resolveContentRegion().region;
    }

    function rememberProfileRegion(profile) {
        const region = normalizeContentRegion(profile?.preferred_content_region ?? profile?.preferredContentRegion);
        if (region) {
            storageSet(KEY_PROFILE_CONTENT_REGION, region);
            rememberRegionState({ region, status: 'confirmed', source: 'profile' });
        } else {
            storageRemove(KEY_PROFILE_CONTENT_REGION);
        }
        return profile;
    }

    async function setPreferredContentRegion(region, options = {}) {
        const normalized = normalizeContentRegion(region);
        if (!normalized) throw new Error('Invalid content region');

        storageSet(KEY_PREFERRED_CONTENT_REGION, normalized);
        storageSet(KEY_LEGACY_COUNTRY, normalized);
        storageRemove(KEY_REGION_PROMPT_DISMISSED);
        rememberRegionState({ region: normalized, status: 'confirmed', source: 'local' });

        if (options.saveProfile !== false && getToken()) {
            try {
                const profile = await request('PUT', '/profile', {
                    preferredContentRegion: normalized,
                    confirmPreferredContentRegion: true,
                    locale: navigator.language || 'fr-FR'
                });
                rememberProfileRegion(profile);
            } catch (error) {
                console.warn('[NorvaCloud] Could not save preferred content region:', error);
                if (options.throwOnProfileError) throw error;
            }
        }

        return resolveContentRegion();
    }

    function clearPreferredContentRegion() {
        storageRemove(KEY_PREFERRED_CONTENT_REGION);
        storageRemove(KEY_PROFILE_CONTENT_REGION);
        storageRemove(KEY_LEGACY_COUNTRY);
        return resolveContentRegion();
    }

    function dismissRegionPrompt() {
        storageSet(KEY_REGION_PROMPT_DISMISSED, '1');
    }

    function shouldShowRegionPrompt() {
        if (getStoredPreferredContentRegion()) return false;
        if (storageGet(KEY_REGION_PROMPT_DISMISSED)) return false;
        const suggested = getLegacyContentRegion() || inferContentRegionFromLocale();
        return suggested && suggested !== 'INTERNATIONAL';
    }

    function maybeShowRegionPrompt() {
        if (!shouldShowRegionPrompt()) return;
        if (!document.body || document.getElementById('norva-region-prompt')) return;
        const pathname = window.location.pathname || '';
        // Suppress on auth/pairing surfaces — match both the .html paths and the
        // clean URLs Cloudflare Pages serves (e.g. "/account", "/login").
        if (/\/(login|cloud|account|cloud-pair|hub-connect)(\.html)?\/?$/i.test(pathname)) return;

        const suggestion = resolveContentRegion();
        const prompt = document.createElement('div');
        prompt.id = 'norva-region-prompt';
        prompt.style.cssText = [
            'position:fixed',
            // Offset by the device safe-area so the card is never cropped behind
            // the Android/iOS system navigation bar in the native APK WebView.
            'left:calc(16px + env(safe-area-inset-left, 0px))',
            'right:calc(16px + env(safe-area-inset-right, 0px))',
            'bottom:calc(16px + env(safe-area-inset-bottom, 0px))',
            // Never taller than the viewport (scroll if it somehow is).
            'max-height:calc(100vh - 32px - env(safe-area-inset-bottom, 0px) - env(safe-area-inset-top, 0px))',
            'overflow:auto',
            'z-index:9999',
            'max-width:420px',
            'width:auto',
            'box-sizing:border-box',
            'background:#121722',
            'border:1px solid #2b3448',
            'border-radius:16px',
            'box-shadow:0 18px 55px rgba(0,0,0,.45)',
            'color:#f8fafc',
            'padding:18px',
            'font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif'
        ].join(';');
        prompt.innerHTML = `
            <button type="button" aria-label="Close" data-region-close style="float:right;background:transparent;border:0;color:#94a3b8;font-size:22px;line-height:1;cursor:pointer">&times;</button>
            <strong style="display:block;font-size:16px;margin:0 26px 8px 0">Organize Norva for ${escapeHtml(contentRegionLabel(suggestion.region))}?</strong>
            <span style="display:block;color:#aeb8cc;margin-bottom:14px">Norva uses this region to organize channels, logos and categories. You can change it at any time.</span>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
                <button type="button" data-region-confirm style="flex:1 1 82px;border:0;border-radius:10px;background:#5b7cfa;color:white;padding:10px 14px;font-weight:800;cursor:pointer">Yes</button>
                <button type="button" data-region-settings style="flex:2 1 180px;min-width:0;border:1px solid #334155;border-radius:10px;background:#1b2230;color:#dbe7ff;padding:10px 14px;font-weight:800;cursor:pointer">Choose another region</button>
            </div>
        `;
        const regionTitle = prompt.querySelector('strong');
        const regionMessage = prompt.querySelector('span[style*="margin-bottom"]');
        const confirmButton = prompt.querySelector('[data-region-confirm]');
        const settingsButton = prompt.querySelector('[data-region-settings]');
        if (regionTitle) regionTitle.textContent = `Organize Norva for ${contentRegionLabel(suggestion.region)}?`;
        if (regionMessage) regionMessage.textContent = 'Norva uses this region to order channels, logos and categories. You can change it at any time.';
        if (confirmButton) confirmButton.textContent = 'Yes';
        if (settingsButton) settingsButton.textContent = 'Choose another region';

        const close = () => {
            dismissRegionPrompt();
            prompt.remove();
        };
        prompt.querySelector('[data-region-close]')?.addEventListener('click', close);
        prompt.querySelector('[data-region-confirm]')?.addEventListener('click', async () => {
            await setPreferredContentRegion(suggestion.region);
            prompt.remove();
        });
        prompt.querySelector('[data-region-settings]')?.addEventListener('click', () => {
            dismissRegionPrompt();
            prompt.remove();
            const settingsNav = document.querySelector('[data-page="settings"], [data-view="settings"], a[href="#settings"]');
            if (settingsNav instanceof HTMLElement) settingsNav.click();
            else window.location.hash = '#settings';
        });
        document.body.appendChild(prompt);
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    async function request(method, path, body, options = {}) {
        // Delegates to requestToBase so the session refresh-and-retry on 401
        // (see below) applies uniformly to every cloud call.
        return requestToBase(apiBase(), method, path, body, options);
    }

    // The source LIST rarely changes within a session, yet several pages re-fetch
    // it on every view (movies, series, live, home, source health) — fanning a
    // single navigation out into ~5 identical /sources round-trips, each paying
    // the edge function's cold-start. Cache it briefly and share one in-flight
    // request. (Live sync STATUS is read from the separate /sources/status
    // endpoint, which stays uncached, so this never staleness progress.)
    function cloneJson(d) { try { return d == null ? d : JSON.parse(JSON.stringify(d)); } catch (_) { return d; } }
    // Short-lived cache + in-flight dedup for idempotent GETs that several
    // surfaces request on the same navigation (sources, favorites, watch
    // history) — collapsing the duplicate round-trips that each pay the edge
    // function's cold-start. No staleness risk: short TTL + every entry is
    // invalidated the moment its data is mutated.
    const _getCache = new Map();      // key -> { at, data }
    const _getInFlight = new Map();   // key -> promise
    function cachedGet(cacheKey, ttlMs, fetchFn) {
        const hit = _getCache.get(cacheKey);
        if (hit && (Date.now() - hit.at) < ttlMs) return Promise.resolve(cloneJson(hit.data));
        if (_getInFlight.has(cacheKey)) return _getInFlight.get(cacheKey).then(cloneJson);
        const p = Promise.resolve(fetchFn())
            .then((data) => { _getCache.set(cacheKey, { at: Date.now(), data }); return data; })
            .finally(() => { _getInFlight.delete(cacheKey); });
        _getInFlight.set(cacheKey, p);
        return p.then(cloneJson);
    }
    function invalidateCache(prefix) {
        for (const k of Array.from(_getCache.keys())) {
            if (k === prefix || k.indexOf(prefix + ':') === 0) _getCache.delete(k);
        }
    }
    const SOURCES_TTL_MS = 30 * 1000;
    const FAVORITES_TTL_MS = 30 * 1000;
    const HISTORY_TTL_MS = 20 * 1000;
    function invalidateSourcesCache() { invalidateCache('sources'); }
    function listSourcesCached() { return cachedGet('sources', SOURCES_TTL_MS, () => request('GET', '/sources')); }

    // Active profile (Netflix-style "who's watching"). Stored per device and sent
    // on every cloud call as x-norva-profile-id so favorites / history / continue
    // watching are scoped to the chosen profile.
    const ACTIVE_PROFILE_KEY = 'norva-active-profile-id';
    function getActiveProfileId() {
        try { return localStorage.getItem(ACTIVE_PROFILE_KEY) || ''; } catch (_) { return ''; }
    }
    function setActiveProfileId(id) {
        const prev = getActiveProfileId();
        try {
            if (id) localStorage.setItem(ACTIVE_PROFILE_KEY, String(id));
            else localStorage.removeItem(ACTIVE_PROFILE_KEY);
        } catch (_) { /* ignore */ }
        // Switching profile invalidates the per-profile caches.
        if (String(id || '') !== String(prev || '')) {
            invalidateCache('favorites');
            invalidateCache('history');
        }
    }

    async function sourceSyncRequest(id) {
        const path = `/sources/${encodeURIComponent(id)}/sync?country=${encodeURIComponent(resolveCountry())}`;
        try {
            return await requestToBase(sourceSyncBase(), 'POST', path, {});
        } catch (error) {
            if ([404, 405, 502, 503, 504, 546].includes(error.status)) {
                return request('POST', path, {});
            }
            throw error;
        }
    }

    async function sourceFinalizeRequest(id, params = {}) {
        const path = `/sources/${encodeURIComponent(id)}/finalize${query({ country: resolveCountry(), ...params })}`;
        try {
            return await requestToBase(sourceSyncBase(), 'POST', path, {});
        } catch (error) {
            if ([404, 405, 502, 503, 504, 546].includes(error.status)) {
                return request('POST', path, {});
            }
            throw error;
        }
    }

    async function catalogRequest(path, params = {}, options = {}) {
        const route = `${path}${query({ country: resolveCountry(), ...params })}`;
        try {
            return await requestToBase(catalogBase(), 'GET', route, null, options);
        } catch (error) {
            if (error.status === 404 || error.status === 405) {
                return request('GET', route, null, options);
            }
            throw error;
        }
    }

    async function seriesInfoRequest(id, seriesId, options = {}) {
        const route = `/sources/${encodeURIComponent(id)}/series-info?series_id=${encodeURIComponent(seriesId)}`;
        try {
            return await requestToBase(seriesInfoBase(), 'GET', route, null, options);
        } catch (error) {
            if (error.status === 404 || error.status === 405) {
                return request('GET', route, null, options);
            }
            throw error;
        }
    }

    async function playbackRequest(session, options = {}) {
        try {
            return await requestToBase(playbackBase(), 'POST', '/playback/session', session, options);
        } catch (error) {
            if (error.status === 404 || error.status === 405) {
                return request('POST', '/playback/sessions', session, options);
            }
            throw error;
        }
    }

    async function playbackSessionRequest(method, path, body, options = {}) {
        try {
            return await requestToBase(playbackBase(), method, path, body, options);
        } catch (error) {
            if (error.status === 404 || error.status === 405) {
                return request(method, path, body, options);
            }
            throw error;
        }
    }

    // Pull the deepest upstream detail out of an error payload so callers see
    // the real cause (e.g. the provider "401 Unauthorized" the cloud gateway
    // reports) instead of only the generic top-level "Media gateway refused the
    // session". The UI keys its friendly messages off this text.
    function extractUpstreamDetail(value, depth = 0) {
        if (!value || depth > 4) return '';
        if (typeof value === 'string') return value.trim();
        if (typeof value !== 'object') return '';
        const parts = [];
        for (const key of ['details', 'error', 'message', 'reason']) {
            const nested = extractUpstreamDetail(value[key], depth + 1);
            if (nested) parts.push(nested);
        }
        return parts.join(' ').trim();
    }

    // Supabase access tokens expire (~1h). When the tab has sat idle past that,
    // the cached token 401s mid-session and the app wrongly looks logged out —
    // the onboarding "enter your service details" screen (sources 401) or a
    // redirect to the landing page (entitlements 401). Transparently refresh the
    // session via NorvaAuth and retry. Deduped via a single in-flight promise so
    // the burst of calls that fire when the user returns can't race Supabase's
    // single-use refresh-token rotation (which would invalidate the session and
    // defeat the refresh).
    let _tokenRefreshInFlight = null;
    function refreshAccessToken() {
        if (_tokenRefreshInFlight) return _tokenRefreshInFlight;
        const auth = (typeof window !== 'undefined') ? window.NorvaAuth : null;
        if (!auth || typeof auth.refreshSession !== 'function') return Promise.resolve(null);
        _tokenRefreshInFlight = Promise.resolve()
            .then(() => auth.refreshSession())
            .then((session) => (session && session.access_token) ? session.access_token : null)
            .catch(() => null)
            .finally(() => { _tokenRefreshInFlight = null; });
        return _tokenRefreshInFlight;
    }

    async function requestToBase(baseUrl, method, path, body, options = {}) {
        // Only user-session calls (no explicit token) get the refresh-and-retry.
        // Device tokens ('' / device token) keep their own invalidation path.
        const usingUserToken = options.token === undefined;
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };
        let token = usingUserToken ? getToken() : options.token;
        if (token) headers.Authorization = `Bearer ${token}`;
        const activeProfileId = getActiveProfileId();
        if (activeProfileId) headers['x-norva-profile-id'] = activeProfileId;

        const send = () => fetch(`${baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined || body === null ? undefined : JSON.stringify(body)
        });

        let response = await send();

        if (response.status === 401 && usingUserToken && token) {
            const fresh = await refreshAccessToken();
            if (fresh && fresh !== token) {
                token = fresh;
                headers.Authorization = `Bearer ${token}`;
                response = await send();
            }
        }

        const contentType = response.headers.get('content-type') || '';
        const payload = contentType.includes('application/json')
            ? await response.json().catch(() => ({}))
            : { error: await response.text().catch(() => '') };

        if (!response.ok) {
            const baseMessage = payload.error || payload.message || `Norva responded with ${response.status}`;
            const detail = extractUpstreamDetail(payload.details);
            const message = detail && !baseMessage.includes(detail)
                ? `${baseMessage} — ${detail}`.slice(0, 400)
                : baseMessage;
            const error = new Error(message);
            error.status = response.status;
            error.payload = payload;
            if (isInvalidDeviceTokenResponse(response.status, payload, message)) {
                markInvalidDeviceToken(error, token);
            }
            throw error;
        }

        return payload;
    }

    const NorvaCloud = {
        get apiUrl() { return apiBase(); },
        get edgeUrl() { return edgeBase(); },
        get token() { return getToken(); },
        get deviceToken() { return getDeviceToken(); },
        setToken,
        setDeviceToken,
        setApiUrl,
        setEdgeUrl,
        isConfigured: () => Boolean(apiBase()),
        imageUrl: proxyImageUrl,

        health: () => request('GET', '/health', null, { token: '' }),

        // Keep the edge functions warm so the next real call after a lull doesn't
        // pay a cold start (the main cause of the slow first catalog load after
        // inactivity). Cheapest touch on each function we use; best-effort.
        warmUp: () => {
            try { request('GET', '/health', null, { token: '' }).catch(() => {}); } catch (_) { /* noop */ }
            try { catalogRequest('/media-items', { type: 'movie', limit: 1 }).catch(() => {}); } catch (_) { /* noop */ }
        },

        profile: {
            get: async () => rememberProfileRegion(await request('GET', '/profile')),
            save: async (profile) => rememberProfileRegion(await request('PUT', '/profile', profile))
        },

        entitlements: {
            get: () => request('GET', '/entitlements'),
            device: () => request('GET', '/device/entitlements', null, { token: getDeviceToken() }),
            isSubscriptionError: (error) => {
                const payload = error?.payload || {};
                const details = payload.details || {};
                return error?.status === 402 && (
                    details.code === 'subscription_required' ||
                    payload.code === 'subscription_required'
                );
            }
        },

        billing: {
            // Account-level trial eligibility (one trial per account across every
            // rail — keyed to trial_consumed_at). Lets the paywall show "Start
            // free trial" vs "Subscribe".
            trialEligibility: () => request('GET', '/billing/trial-eligibility')
        },

        profiles: {
            list: () => request('GET', '/profiles'),
            create: (profile) => request('POST', '/profiles', profile),
            update: (id, patch) => request('PATCH', `/profiles/${encodeURIComponent(id)}`, patch),
            remove: (id) => request('DELETE', `/profiles/${encodeURIComponent(id)}`),
            getActiveId: getActiveProfileId,
            setActiveId: setActiveProfileId,
            avatarUrl: (avatarId) => '/img/avatars/' + encodeURIComponent(String(avatarId || 'avatar-01')) + '.png',
        },

        regions: {
            list: () => CONTENT_REGIONS.slice(),
            label: contentRegionLabel,
            resolve: resolveContentRegion,
            active: () => resolveContentRegion().region,
            setPreferred: setPreferredContentRegion,
            clearPreferred: clearPreferredContentRegion,
            rememberProfile: rememberProfileRegion,
            dismissPrompt: dismissRegionPrompt,
            maybeShowPrompt: maybeShowRegionPrompt
        },

        devices: {
            list: () => request('GET', '/devices'),
            create: (device) => request('POST', '/devices', device),
            heartbeat: (id) => request('PATCH', `/devices/${encodeURIComponent(id)}/heartbeat`),
            revoke: (id) => request('DELETE', `/devices/${encodeURIComponent(id)}`)
        },

        sources: {
            list: () => listSourcesCached(),
            create: (source) => request('POST', '/sources', source).then((r) => { invalidateSourcesCache(); return r; }),
            update: (id, patch) => request('PATCH', `/sources/${encodeURIComponent(id)}`, patch).then((r) => { invalidateSourcesCache(); return r; }),
            seriesInfo: (id, seriesId) => seriesInfoRequest(id, seriesId),
            shortEpg: (id, streamId, limit = 8) => request(
                'GET',
                `/sources/${encodeURIComponent(id)}/short-epg?stream_id=${encodeURIComponent(streamId)}&limit=${encodeURIComponent(limit)}`
            ),
            epg: (id, params = {}) => request(
                'GET',
                `/sources/${encodeURIComponent(id)}/epg${query(params)}`
            ),
            sync: (id) => sourceSyncRequest(id).then((r) => { invalidateSourcesCache(); return r; }),
            finalize: (id, params = {}) => sourceFinalizeRequest(id, params).then((r) => { invalidateSourcesCache(); return r; }),
            remove: (id) => request('DELETE', `/sources/${encodeURIComponent(id)}`).then((r) => { invalidateSourcesCache(); return r; })
        },

        mediaItems: {
            list: (params = {}) => catalogRequest('/media-items', params),
            categories: (params = {}) => catalogRequest('/media-categories', params),
            upsert: (sourceId, items) => request('POST', '/media-items', { sourceId, items })
        },

        live: {
            logicalChannels: (params = {}) => catalogRequest('/live/logical-channels', params),
            variants: (channelId, params = {}) => catalogRequest(`/live/channel/${encodeURIComponent(channelId)}/variants`, params)
        },

        home: {
            rails: (params = {}) => catalogRequest('/home/rails', params)
        },

        favorites: {
            list: (params = {}) => cachedGet('fav:' + JSON.stringify(params || {}), FAVORITES_TTL_MS,
                () => request('GET', `/favorites${query(params)}`)),
            add: (favorite) => request('POST', '/favorites', favorite).then((r) => { invalidateCache('fav'); return r; }),
            remove: (id) => request('DELETE', `/favorites/${encodeURIComponent(id)}`).then((r) => { invalidateCache('fav'); return r; })
        },

        history: {
            list: (params = {}) => cachedGet('hist:' + JSON.stringify(params || {}), HISTORY_TTL_MS,
                () => request('GET', `/history${query(params)}`)),
            save: (item) => request('POST', '/history', item).then((r) => { invalidateCache('hist'); return r; }),
            remove: (id) => request('DELETE', `/history/${encodeURIComponent(id)}`).then((r) => { invalidateCache('hist'); return r; })
        },

        pairing: {
            start: (device) => request('POST', '/pairing/start', device, { token: '' }),
            poll: (code, pairingSecret = '') => request(
                'GET',
                `/pairing/${encodeURIComponent(String(code).toUpperCase())}${pairingSecret ? `?secret=${encodeURIComponent(pairingSecret)}` : ''}`,
                null,
                { token: '' }
            ),
            approve: (code) => request('POST', '/pairing/approve', { code })
        },

        commands: {
            list: (params = {}) => request('GET', `/commands${query(params)}`),
            queue: (command) => request('POST', '/commands', command),
            update: (id, patch) => request('PATCH', `/commands/${encodeURIComponent(id)}`, patch)
        },

        playback: {
            createSession: (session) => playbackRequest(session),
            getSession: (id) => playbackSessionRequest('GET', `/playback/sessions/${encodeURIComponent(id)}`),
            expireSession: (id) => playbackSessionRequest('POST', `/playback/sessions/${encodeURIComponent(id)}/expire`),
            event: (event) => playbackSessionRequest('POST', '/playback/events', event),
            summary: (params = {}) => playbackSessionRequest('GET', `/telemetry/summary${query(params)}`)
        },

        device: {
            me: () => request('GET', '/device/me', null, { token: getDeviceToken() }),
            heartbeat: () => request('POST', '/device/heartbeat', {}, { token: getDeviceToken() }),
            commands: () => request('GET', '/device/commands', null, { token: getDeviceToken() }),
            acknowledgeCommand: (id) => request('PATCH', `/device/commands/${encodeURIComponent(id)}`, { status: 'acknowledged' }, { token: getDeviceToken() }),
            failCommand: (id, error) => request('PATCH', `/device/commands/${encodeURIComponent(id)}`, { status: 'failed', error }, { token: getDeviceToken() }),
            sources: {
                list: () => request('GET', '/device/sources', null, { token: getDeviceToken() }),
                seriesInfo: (id, seriesId) => seriesInfoRequest(id, seriesId, { token: getDeviceToken() }),
                shortEpg: (id, streamId, limit = 8) => request(
                    'GET',
                    `/device/sources/${encodeURIComponent(id)}/short-epg?stream_id=${encodeURIComponent(streamId)}&limit=${encodeURIComponent(limit)}`,
                    null,
                    { token: getDeviceToken() }
                ),
                epg: (id, params = {}) => request(
                    'GET',
                    `/device/sources/${encodeURIComponent(id)}/epg${query(params)}`,
                    null,
                    { token: getDeviceToken() }
                )
            },
            mediaItems: {
                list: (params = {}) => catalogRequest('/device/media-items', params, { token: getDeviceToken() }),
                categories: (params = {}) => catalogRequest('/device/media-categories', params, { token: getDeviceToken() })
            },
            live: {
                logicalChannels: (params = {}) => catalogRequest('/device/live/logical-channels', params, { token: getDeviceToken() }),
                variants: (channelId, params = {}) => catalogRequest(`/device/live/channel/${encodeURIComponent(channelId)}/variants`, params, { token: getDeviceToken() })
            },
            home: {
                rails: (params = {}) => catalogRequest('/device/home/rails', params, { token: getDeviceToken() })
            },
            playback: {
                createSession: (session) => playbackRequest(session, { token: getDeviceToken() }),
                event: (event) => playbackSessionRequest('POST', '/playback/events', event, { token: getDeviceToken() }),
                summary: (params = {}) => playbackSessionRequest('GET', `/telemetry/summary${query(params)}`, null, { token: getDeviceToken() })
            }
        }
    };

    function query(params) {
        const search = new URLSearchParams();
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') search.set(key, value);
        });
        const stringified = search.toString();
        return stringified ? `?${stringified}` : '';
    }

    window.NorvaCloud = NorvaCloud;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => NorvaCloud.regions.maybeShowPrompt());
    } else {
        setTimeout(() => NorvaCloud.regions.maybeShowPrompt(), 0);
    }
})();
