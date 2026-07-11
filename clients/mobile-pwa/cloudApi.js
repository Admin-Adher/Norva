/**
 * Norva Cloud client.
 *
 * This client is intentionally thin: authentication remains owned by Supabase
 * Auth / product UI, while this wrapper gives every Norva surface the same
 * Cloud Core and Playback Session contract.
 */
(function () {
    'use strict';

    const DEFAULT_API_URL = 'https://api.norva.tv/functions/v1/norva-cloud';
    const DEFAULT_SOURCE_SYNC_URL = 'https://api.norva.tv/functions/v1/norva-source-sync';
    const DEFAULT_CATALOG_URL = 'https://api.norva.tv/functions/v1/norva-catalog';
    const DEFAULT_SERIES_INFO_URL = 'https://api.norva.tv/functions/v1/norva-series-info';
    const DEFAULT_PLAYBACK_URL = 'https://api.norva.tv/functions/v1/norva-playback';
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
        if (/\/(login|cloud|account|cloud-pair|hub-connect)\.html$/i.test(pathname)) return;

        const suggestion = resolveContentRegion();
        const prompt = document.createElement('div');
        prompt.id = 'norva-region-prompt';
        prompt.style.cssText = [
            'position:fixed',
            'left:24px',
            'bottom:24px',
            'z-index:9999',
            'max-width:420px',
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
            <strong style="display:block;font-size:16px;margin:0 26px 8px 0">Organiser Norva pour ${escapeHtml(contentRegionLabel(suggestion.region))} ?</strong>
            <span style="display:block;color:#aeb8cc;margin-bottom:14px">Norva utilise cette région pour ordonner les chaînes, logos et catégories. Tu peux la changer à tout moment.</span>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
                <button type="button" data-region-confirm style="border:0;border-radius:10px;background:#5b7cfa;color:white;padding:10px 14px;font-weight:800;cursor:pointer">Oui</button>
                <button type="button" data-region-settings style="border:1px solid #334155;border-radius:10px;background:#1b2230;color:#dbe7ff;padding:10px 14px;font-weight:800;cursor:pointer">Choisir une autre région</button>
            </div>
        `;

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
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };
        const token = options.token === undefined ? getToken() : options.token;
        if (token) headers.Authorization = `Bearer ${token}`;

        const response = await fetch(`${apiBase()}${path}`, {
            method,
            headers,
            body: body === undefined || body === null ? undefined : JSON.stringify(body)
        });

        const contentType = response.headers.get('content-type') || '';
        const payload = contentType.includes('application/json')
            ? await response.json().catch(() => ({}))
            : { error: await response.text().catch(() => '') };

        if (!response.ok) {
            const message = payload.error || payload.message || `Norva responded with ${response.status}`;
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

    async function requestToBase(baseUrl, method, path, body, options = {}) {
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };
        const token = options.token === undefined ? getToken() : options.token;
        if (token) headers.Authorization = `Bearer ${token}`;

        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined || body === null ? undefined : JSON.stringify(body)
        });

        const contentType = response.headers.get('content-type') || '';
        const payload = contentType.includes('application/json')
            ? await response.json().catch(() => ({}))
            : { error: await response.text().catch(() => '') };

        if (!response.ok) {
            const message = payload.error || payload.message || `Norva responded with ${response.status}`;
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
            list: () => request('GET', '/sources'),
            create: (source) => request('POST', '/sources', source),
            update: (id, patch) => request('PATCH', `/sources/${encodeURIComponent(id)}`, patch),
            seriesInfo: (id, seriesId) => seriesInfoRequest(id, seriesId),
            shortEpg: (id, streamId, limit = 8) => request(
                'GET',
                `/sources/${encodeURIComponent(id)}/short-epg?stream_id=${encodeURIComponent(streamId)}&limit=${encodeURIComponent(limit)}`
            ),
            epg: (id, params = {}) => request(
                'GET',
                `/sources/${encodeURIComponent(id)}/epg${query(params)}`
            ),
            sync: (id) => sourceSyncRequest(id),
            remove: (id) => request('DELETE', `/sources/${encodeURIComponent(id)}`)
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
            list: (params = {}) => request('GET', `/favorites${query(params)}`),
            add: (favorite) => request('POST', '/favorites', favorite),
            remove: (id) => request('DELETE', `/favorites/${encodeURIComponent(id)}`)
        },

        history: {
            list: (params = {}) => request('GET', `/history${query(params)}`),
            save: (item) => request('POST', '/history', item),
            remove: (id) => request('DELETE', `/history/${encodeURIComponent(id)}`)
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
