/**
 * API Client - Frontend API wrapper for Norva
 */

// When running from a remote host (e.g. the hosted web version), all API calls
// are proxied to the configured hub URL stored in localStorage.
function _hubBase() {
    const hub = localStorage.getItem('norva-hub-url');
    return hub ? hub.replace(/\/$/, '') : '';
}

// Base URL of an in-app / same-machine Norva transcoder (residential IP).
// Set by the desktop app (preload exposes window.NorvaDesktop.transcoder), or
// inferred when the page is served by a local Norva server (localhost). Used to
// transcode locally while still syncing catalog/resume through the cloud, so the
// IPTV provider never sees a datacenter IP. Empty in a normal browser on norva.tv.
function _localTranscoderBase() {
    if (typeof window === 'undefined') return '';
    const explicit = window.NorvaDesktop && window.NorvaDesktop.transcoder;
    if (explicit) return String(explicit).replace(/\/$/, '');
    const host = window.location && window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
        return String(window.location.origin).replace(/\/$/, '');
    }
    return '';
}

// Remember when a source's CLOUD playback was refused by the provider (a
// datacenter 401) so a plain browser doesn't keep spinning ~10s on a doomed
// gateway attempt before handing the title off to the native apps. Self-heals
// after a TTL and is cleared on any successful cloud playback. Native/desktop
// (residential) surfaces never set this — they don't use the cloud gateway.
const CLOUD_BLOCK_KEY = 'norva-cloud-blocked-sources-v1';
const CLOUD_BLOCK_TTL_MS = 30 * 60 * 1000;
function _readCloudBlocked() {
    try { return JSON.parse(localStorage.getItem(CLOUD_BLOCK_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function _isSourceCloudBlocked(sourceId) {
    if (!sourceId) return false;
    const at = Number(_readCloudBlocked()[String(sourceId)] || 0);
    return at > 0 && (Date.now() - at) < CLOUD_BLOCK_TTL_MS;
}
function _markSourceCloudBlocked(sourceId) {
    if (!sourceId) return;
    try {
        const map = _readCloudBlocked();
        map[String(sourceId)] = Date.now();
        localStorage.setItem(CLOUD_BLOCK_KEY, JSON.stringify(map));
    } catch (_) { /* storage best-effort */ }
}
function _clearSourceCloudBlock(sourceId) {
    if (!sourceId) return;
    try {
        const map = _readCloudBlocked();
        if (map[String(sourceId)]) {
            delete map[String(sourceId)];
            localStorage.setItem(CLOUD_BLOCK_KEY, JSON.stringify(map));
        }
    } catch (_) { /* storage best-effort */ }
}
function _looksProviderBlocked(err) {
    if (!err) return false;
    const detail = err.payload && err.payload.details;
    const text = (String(err.message || '') + ' '
        + (detail && typeof detail === 'object' ? JSON.stringify(detail) : String(detail || ''))).toLowerCase();
    return /\b401\b|\b403\b|\b429\b|unauthor|forbidden|too many/.test(text);
}

// LIVE back-off — distinct from the VOD cloud-block. Single-slot providers
// 403-block under a connection storm (rapid zapping + retries). A SHORT back-off
// (vs VOD's 30 min) stops the client from hammering for a moment so the
// provider's cooldown lifts and the next attempt succeeds — without locking the
// user out of live for half an hour.
const LIVE_BLOCK_KEY = 'norva-live-blocked-sources-v1';
const LIVE_BLOCK_TTL_MS = 60 * 1000;
function _readLiveBlocked() {
    try { return JSON.parse(localStorage.getItem(LIVE_BLOCK_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function _isLiveBlocked(sourceId) {
    if (!sourceId) return false;
    const at = Number(_readLiveBlocked()[String(sourceId)] || 0);
    return at > 0 && (Date.now() - at) < LIVE_BLOCK_TTL_MS;
}
function _markLiveBlocked(sourceId) {
    if (!sourceId) return;
    try { const m = _readLiveBlocked(); m[String(sourceId)] = Date.now(); localStorage.setItem(LIVE_BLOCK_KEY, JSON.stringify(m)); } catch (_) { /* best-effort */ }
}
function _clearLiveBlock(sourceId) {
    if (!sourceId) return;
    try { const m = _readLiveBlocked(); if (m[String(sourceId)]) { delete m[String(sourceId)]; localStorage.setItem(LIVE_BLOCK_KEY, JSON.stringify(m)); } } catch (_) { /* best-effort */ }
}
// A single dead channel returning 403 must NOT back-off the whole source — that
// would wrongly show "fournisseur saturé" on the next (healthy) channel. Only a
// real provider cooldown (several DISTINCT channels failing in quick succession)
// warrants a back-off. Track recent distinct failures in a short window.
const LIVE_FAIL_WINDOW_MS = 30 * 1000;
const LIVE_FAIL_DISTINCT_THRESHOLD = 3;
let _recentLiveFails = [];
function _noteLiveFailureMaybeBlock(sourceId, itemId) {
    if (!sourceId) return;
    const now = Date.now();
    const src = String(sourceId);
    _recentLiveFails = _recentLiveFails.filter((f) => (now - f.at) < LIVE_FAIL_WINDOW_MS);
    _recentLiveFails.push({ src, item: String(itemId || now), at: now });
    const distinct = new Set(
        _recentLiveFails.filter((f) => f.src === src).map((f) => f.item)
    );
    if (distinct.size >= LIVE_FAIL_DISTINCT_THRESHOLD) {
        _markLiveBlocked(sourceId);
        _recentLiveFails = _recentLiveFails.filter((f) => f.src !== src);
    }
}

function _isHostedApp() {
    const host = window.location.hostname;
    return Boolean(host && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1');
}

function _hasCloudUserSession() {
    try {
        const session = JSON.parse(localStorage.getItem('norva-cloud-session') || 'null');
        const now = Math.floor(Date.now() / 1000);
        return Boolean(
            session?.access_token &&
            session?.user?.id &&
            (!session.expires_at || Number(session.expires_at) > now + 30)
        );
    } catch (_) {
        return false;
    }
}

// True when a signed-in USER session exists in storage, IGNORING token expiry. Used only to
// choose the user vs. device edge endpoints: requestToBase refreshes an expired access token on
// the first 401, so a logged-in user must always use the user endpoints. _hasCloudUserSession
// (expiry-aware) still gates cloud-vs-local mode. Routing a logged-in user to the device endpoint
// on a momentarily-lapsed token 401s (no device token) and silently empties dynamic menus such as
// the Audio/Subtitle language facets — the bug this fixes.
function _hasCloudUserAccount() {
    try {
        const session = JSON.parse(localStorage.getItem('norva-cloud-session') || 'null');
        return Boolean(session?.access_token && session?.user?.id);
    } catch (_) {
        return false;
    }
}

function _hasCloudDeviceSession() {
    return Boolean(window.NorvaCloud?.deviceToken || localStorage.getItem('norva-cloud-device-token'));
}

function _cloudAvailable() {
    return Boolean(window.NorvaCloud) && (_hasCloudUserSession() || _hasCloudDeviceSession());
}

function _shouldUseCloud() {
    if (!_cloudAvailable()) return false;
    if (localStorage.getItem('norva-api-mode') === 'local') return false;
    if (localStorage.getItem('norva-api-mode') === 'cloud') return true;
    return _isHostedApp() || !_hubBase();
}

function _cloudClientSurface() {
    const ua = navigator.userAgent || '';
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone;
    if (window.NorvaAndroidTV || /android tv|afts|aftt|aftm|bravia|smart-tv|smarttv|tizen|webos/i.test(ua)) return 'android-tv';
    if (standalone) return 'pwa';
    if (/mobi|android|iphone|ipad|ipod/i.test(ua)) return 'mobile-web';
    return 'web';
}

function _cloudViewportClass() {
    const width = Math.max(0, Number(window.innerWidth) || 0);
    if (width && width < 600) return 'phone';
    if (width && width < 1024) return 'tablet';
    return 'desktop';
}

function _cloudClientTelemetryMetadata() {
    return {
        clientSurface: _cloudClientSurface(),
        viewportClass: _cloudViewportClass(),
        appMode: _isHostedApp() ? 'cloud' : 'local',
        playbackEntry: 'watch'
    };
}

function compactPlaybackHint(value = {}) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ''));
}

const CloudAdapter = (() => {
    const SOURCE_ALIAS_KEY = 'norva-cloud-source-aliases';
    const PAGE_CACHE_TTL_MS = 120000;
    let sourcesCache = [];
    let mediaCache = new Map();
    let pageCache = new Map();
    let liveCatalogCache = new Map();
    let homeRailCache = new Map();

    function readAliases() {
        try {
            return JSON.parse(localStorage.getItem(SOURCE_ALIAS_KEY) || '{}') || {};
        } catch (_) {
            return {};
        }
    }

    function writeAliases(aliases) {
        localStorage.setItem(SOURCE_ALIAS_KEY, JSON.stringify(aliases));
    }

    function localSourceId(cloudId) {
        const aliases = readAliases();
        if (!aliases[cloudId]) {
            const used = Object.values(aliases).map(Number).filter(Number.isFinite);
            aliases[cloudId] = Math.max(900000, ...used) + 1;
            writeAliases(aliases);
        }
        return aliases[cloudId];
    }

    function activeContentRegion() {
        try {
            const resolved = window.NorvaCloud?.regions?.resolve?.();
            if (resolved?.region) return String(resolved.region).toUpperCase();
        } catch (_) { }
        try {
            const stored = localStorage.getItem('norva-preferred-content-region') || localStorage.getItem('norva-country');
            if (stored) return String(stored).toUpperCase();
        } catch (_) { }
        return 'INTERNATIONAL';
    }

    async function resolveSourceId(id) {
        const raw = String(id);
        if (raw.includes('-')) return raw;
        const local = Number(raw);
        const cached = sourcesCache.find(source => Number(source.id) === local);
        if (cached?.cloudId) return cached.cloudId;
        await listSources();
        return sourcesCache.find(source => Number(source.id) === local)?.cloudId || raw;
    }

    function normalizeSource(source) {
        const config = source.config_hint || source.configHint || {};
        const type = source.source_type || source.sourceType || source.type || 'xtream';
        const cloudId = source.id;
        const id = localSourceId(cloudId);
        const providerHost = config.serverHost || config.playlistHost || '';
        return {
            ...source,
            id,
            cloudId,
            cloud_id: cloudId,
            configHint: config,
            config_hint: config,
            source_type: type,
            type,
            name: source.display_name || source.displayName || source.name || 'Norva provider',
            url: config.serverUrl || providerHost || '',
            providerHost,
            serverHost: config.serverHost || '',
            playlistHost: config.playlistHost || '',
            username: config.username || source.username || '',
            hasPassword: Boolean(config.hasPassword),
            enabled: source.revoked !== true,
            sync_status: source.sync_status || source.syncStatus || 'idle',
            sync_error: source.sync_error || source.syncError || '',
            last_sync: source.last_synced_at || source.lastSyncedAt || null,
            lastSync: config.lastSync || source.lastSync || null,
            cloud: true
        };
    }

    async function listSources() {
        const payload = await cloudSourcesApi().list();
        // A transient 2xx with a MALFORMED body — e.g. a carrier/CDN proxy returning an HTML
        // interstitial with status 200 — arrives here as {} or {error:'…'} (cloudApi requestToBase
        // resolves, not rejects, a 2xx whose body isn't the expected JSON). Coercing that to [] used
        // to classify a fully-onboarded user as first-run: it blanked their sources, showed the
        // "add your first account" gate AND hid the Live/Movies/Series tabs (phantom "no account"
        // incident, 2026-07-08). THROW on a bad shape instead — loadSummary already maps a rejected
        // /sources fetch to the safe, non-gating 'unknown' state (keeps the last-known-good cache +
        // a retry banner). Onboarding now renders ONLY on a genuine, well-formed {sources: []}.
        if (!payload || !Array.isArray(payload.sources)) {
            throw new Error('Unexpected /sources response shape');
        }
        sourcesCache = payload.sources.map(normalizeSource);
        return sourcesCache;
    }

    function clearMediaCaches() {
        mediaCache.clear();
        pageCache.clear();
        liveCatalogCache.clear();
        homeRailCache.clear();
    }

    // Resolved synopsis language — folded into the catalog cache keys so a language change
    // (subtitle / audio / region preference) yields a cache miss and a re-fetch of the
    // localized overviews, instead of serving stale text. See cloudApi.resolveLang().
    function contentLang() {
        try {
            return (window.NorvaCloud && window.NorvaCloud.contentLanguage && window.NorvaCloud.contentLanguage()) || 'en';
        } catch (_) {
            return 'en';
        }
    }

    function normalizeCategory(value) {
        const raw = value === null || value === undefined || value === '' ? 'uncategorized' : String(value);
        return {
            category_id: raw,
            category_name: raw === 'uncategorized' ? 'Uncategorized' : `Category ${raw}`,
            name: raw === 'uncategorized' ? 'Uncategorized' : `Category ${raw}`
        };
    }

    function itemTypeToLocal(type) {
        if (type === 'live') return 'channel';
        if (type === 'movie') return 'movie';
        if (type === 'series') return 'series';
        if (type === 'episode') return 'episode';
        return type || 'channel';
    }

    function cloudTypeFromLocal(type) {
        if (type === 'channel') return 'live';
        return type || 'live';
    }

    function defaultProviderContainerForType(type) {
        const normalized = String(type || '').toLowerCase();
        if (normalized === 'live' || normalized === 'channel') return 'ts';
        return 'mp4';
    }

    function normalizeMediaItem(item, sourceId) {
        const metadata = item.metadata || {};
        const playbackHint = item.playback_hint || item.playbackHint || {};
        const itemType = item.item_type || item.itemType || item.type;
        const id = String(item.external_id || item.externalId || item.item_id || item.id || '');
        const categoryId = String(item.parent_external_id || metadata.categoryId || metadata.group || 'uncategorized');
        const title = item.title || item.name || 'Norva';
        const poster = item.poster_url || item.posterUrl || item.cover || item.stream_icon || '';
        const container = playbackHint.container || metadata.container || defaultProviderContainerForType(itemType);
        const base = {
            ...item,
            sourceId,
            source_id: sourceId,
            cloudSourceId: item.source_id || item.sourceId,
            cloudItemId: item.id,
            name: title,
            title,
            category_id: categoryId,
            category_name: item.subtitle || metadata.categoryName || normalizeCategory(categoryId).category_name,
            stream_icon: poster,
            cover: poster,
            poster_url: poster,
            container_extension: container,
            rating: metadata.rating || item.rating || ''
        };

        if (itemType === 'series') {
            base.series_id = id;
            base.stream_id = id;
        } else {
            base.stream_id = id;
            base.series_id = id;
        }

        return base;
    }

    function categoriesFromMediaItems(items) {
        const categories = new Map();
        for (const item of items) {
            const categoryId = item.category_id || 'uncategorized';
            const fallback = normalizeCategory(categoryId);
            const metadata = item.metadata || {};
            const name = item.category_name || item.subtitle || metadata.categoryName || fallback.category_name;
            const existing = categories.get(categoryId);
            const hasProviderName = name && name !== fallback.category_name;
            if (!existing || (existing.category_name === fallback.category_name && hasProviderName)) {
                categories.set(categoryId, {
                    ...fallback,
                    category_name: name,
                    name
                });
            }
        }
        return [...categories.values()];
    }

    async function listAllMedia({ sourceId, type, q } = {}) {
        const cloudSourceId = sourceId ? await resolveSourceId(sourceId) : '';
        const cacheKey = JSON.stringify({ cloudSourceId, type, q: q || '', lang: contentLang() });
        if (mediaCache.has(cacheKey)) return mediaCache.get(cacheKey);

        const pageSize = 1000;
        let offset = 0;
        const all = [];
        const seen = new Set();

        for (let page = 0; page < 150; page += 1) {
            const payload = await cloudMediaApi().list({
                sourceId: cloudSourceId,
                type,
                q,
                limit: pageSize,
                offset
            });
            const items = payload.items || [];
            let added = 0;
            for (const item of items) {
                const key = `${item.source_id || item.sourceId}:${item.item_type || item.itemType}:${item.external_id || item.externalId || item.id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                all.push(item);
                added += 1;
            }
            if (!added && items.length) break;
            if (payload.hasMore === false) break;
            if (items.length < pageSize) break;
            offset += pageSize;
        }

        const mapped = all.map(item => normalizeMediaItem(item, localSourceId(item.source_id || item.sourceId || cloudSourceId)));
        mediaCache.set(cacheKey, mapped);
        return mapped;
    }

    async function getMediaPage({ sourceId, type, q, categoryId, sort = 'default', limit = 50, offset = 0, year = '', minRating = '', addedDays = '' } = {}) {
        const cloudSourceId = sourceId ? await resolveSourceId(sourceId) : '';
        const normalizedLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 50));
        const normalizedOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
        const cacheKey = JSON.stringify({
            cloudSourceId,
            type: type || '',
            q: q || '',
            categoryId: categoryId || '',
            sort: sort || 'default',
            year: year || '',
            minRating: minRating || '',
            addedDays: addedDays || '',
            lang: contentLang(),
            limit: normalizedLimit,
            offset: normalizedOffset
        });
        const cached = pageCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.page;

        const payload = await cloudMediaApi().list({
            sourceId: cloudSourceId,
            type,
            q,
            categoryId,
            sort,
            // Server-side year/rating/recently-added filters (denormalized columns).
            year,
            minRating,
            addedDays,
            limit: normalizedLimit,
            offset: normalizedOffset
        });
        const items = (payload.items || []).map(item => normalizeMediaItem(item, localSourceId(item.source_id || item.sourceId || cloudSourceId)));
        const page = {
            items,
            count: payload.count ?? null,
            limit: payload.limit ?? normalizedLimit,
            offset: payload.offset ?? normalizedOffset,
            hasMore: payload.hasMore ?? items.length === normalizedLimit
        };
        pageCache.set(cacheKey, {
            expiresAt: Date.now() + PAGE_CACHE_TTL_MS,
            page
        });
        return page;
    }

    async function listMediaPage(options = {}) {
        return (await getMediaPage(options)).items;
    }

    async function listMediaCategories({ sourceId, type } = {}) {
        const cloudSourceId = sourceId ? await resolveSourceId(sourceId) : '';
        const payload = await cloudMediaApi().categories({ sourceId: cloudSourceId, type });
        return (payload.categories || []).map(category => ({
            category_id: String(category.category_id || category.categoryId || 'uncategorized'),
            category_name: category.category_name || category.categoryName || 'Uncategorized',
            name: category.category_name || category.categoryName || 'Uncategorized',
            sourceId: localSourceId(category.source_id || category.sourceId || cloudSourceId)
        }));
    }

    async function getLiveLogicalCatalog({ sourceId, categoryId, country = '', q = '', limit = '', offset = '', includeVariants = true } = {}) {
        country = String(country || activeContentRegion()).toUpperCase();
        const cloudSourceId = sourceId ? await resolveSourceId(sourceId) : '';
        const cacheKey = JSON.stringify({
            cloudSourceId,
            categoryId: categoryId || '',
            country,
            lang: contentLang(),
            q: q || '',
            limit: limit || '',
            offset: offset || '',
            includeVariants: includeVariants ? 1 : 0
        });
        const cached = liveCatalogCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.payload;

        const payload = await cloudLiveApi().logicalChannels({
            sourceId: cloudSourceId,
            categoryId: categoryId || '',
            country,
            q: q || '',
            limit: limit || '',
            offset: offset || '',
            includeVariants: includeVariants ? '1' : ''
        });
        liveCatalogCache.set(cacheKey, {
            expiresAt: Date.now() + PAGE_CACHE_TTL_MS,
            payload
        });
        return payload;
    }

    async function listLiveLogicalCategories({ sourceId, country = '' } = {}) {
        country = String(country || activeContentRegion()).toUpperCase();
        const payload = await getLiveLogicalCatalog({ sourceId, country, includeVariants: false });
        return (payload.groups || []).map(group => ({
            category_id: String(group.category_id || group.id || 'uncategorized'),
            category_name: group.category_name || group.name || 'Uncategorized',
            name: group.category_name || group.name || 'Uncategorized',
            sourceId
        }));
    }

    async function listLiveLogicalChannels({ sourceId, categoryId, country = '', q = '', limit = '', offset = '' } = {}) {
        country = String(country || activeContentRegion()).toUpperCase();
        const payload = await getLiveLogicalCatalog({ sourceId, categoryId, country, q, limit, offset, includeVariants: true });
        return (payload.channels || []).map(channel => normalizeLogicalLiveChannel(channel, sourceId));
    }

    async function getHomeRails({ type = '', limit = 12 } = {}) {
        const normalizedType = type ? cloudTypeFromLocal(type) : '';
        const normalizedLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 12));
        const cacheKey = JSON.stringify({ type: normalizedType, limit: normalizedLimit, lang: contentLang() });
        const cached = homeRailCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.payload;

        const payload = await cloudHomeApi().rails({
            type: normalizedType,
            limit: normalizedLimit
        });
        homeRailCache.set(cacheKey, {
            expiresAt: Date.now() + PAGE_CACHE_TTL_MS,
            payload
        });
        return payload;
    }

    async function getGenreRails({ type = '', limit = 18 } = {}) {
        const normalizedType = type ? cloudTypeFromLocal(type) : 'movie';
        const normalizedLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 18));
        const cacheKey = JSON.stringify({ genre: true, type: normalizedType, limit: normalizedLimit, lang: contentLang() });
        const cached = homeRailCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.payload;

        const payload = await cloudHomeApi().genreRails({
            type: normalizedType,
            limit: normalizedLimit
        });
        homeRailCache.set(cacheKey, {
            expiresAt: Date.now() + PAGE_CACHE_TTL_MS,
            payload
        });
        return payload;
    }

    async function getGenreItems({ type = 'movie', bucket = '', limit = 36, offset = 0, audio = '', subs = '', sort = '', prefAudio = '', prefSubs = '', q = '', year = '', minRating = '' } = {}) {
        const normalizedType = type ? cloudTypeFromLocal(type) : 'movie';
        const normalizedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 36));
        const normalizedOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
        return cloudHomeApi().genreItems({
            type: normalizedType,
            bucket,
            limit: normalizedLimit,
            offset: normalizedOffset,
            // Audio-language / burned-in-subtitle / year / rating filter + "best for
            // my languages" sort + text search — forwarded to the catalog (empty
            // values dropped).
            audio, subs, sort, prefAudio, prefSubs, q, year, minRating
        });
    }

    async function getGenreSummary({ type = 'movie', source = '' } = {}) {
        const normalizedType = type ? cloudTypeFromLocal(type) : 'movie';
        const params = { type: normalizedType };
        if (source) params.source = source;
        return cloudHomeApi().genreSummary(params);
    }

    function liveDefaultPref(variant) {
        const label = String(variant?.label || '');
        let base;
        if (label.startsWith('HD')) base = 0;
        else if (label.startsWith('FHD') || label.startsWith('Super HD')) base = 1;
        else if (label.startsWith('SD')) base = 2;
        else if (label.startsWith('4K')) base = 4;
        else base = 1;
        if (/h265|hevc/i.test(label)) base += 0.5;
        return base;
    }

    function pickDefaultLiveVariant(variants) {
        const available = Array.isArray(variants) ? variants.filter(variant => variant?.streamId) : [];
        const ok = available.filter(variant => Number(variant.healthRank) < 3);
        const pool = (ok.length ? ok : available).slice();
        pool.sort((a, b) =>
            (Number(a.healthRank || 1) - Number(b.healthRank || 1)) ||
            (liveDefaultPref(a) - liveDefaultPref(b)) ||
            (Number(a.rank || 2) - Number(b.rank || 2))
        );
        return pool[0] || null;
    }

    function normalizeLogicalLiveChannel(channel, requestedSourceId) {
        const cloudSourceId = channel.source_id || channel.sourceId || '';
        const localId = requestedSourceId || localSourceId(cloudSourceId);
        const defaultVariantRaw = channel.default_variant || channel.defaultVariant || {};
        const rawVariants = Array.isArray(channel.variants) && channel.variants.length
            ? channel.variants
            : (channel.variant_preview || channel.variantPreview || (defaultVariantRaw.stream_id || defaultVariantRaw.streamId ? [defaultVariantRaw] : []));
        const variants = rawVariants
            .map(variant => normalizeLiveVariant(variant, localId, cloudSourceId))
            .filter(variant => variant.streamId);
        const defaultStreamId = String(defaultVariantRaw.stream_id || defaultVariantRaw.streamId || channel.stream_id || channel.streamId || channel.external_id || '');
        const defaultVariant = pickDefaultLiveVariant(variants)
            || normalizeLiveVariant(defaultVariantRaw, localId, cloudSourceId);
        const streamId = String(defaultVariant.streamId || defaultStreamId || '');
        const categoryId = String(channel.category_id || channel.group_id || channel.section || 'uncategorized');
        const categoryName = channel.category_name || channel.group_name || (categoryId === 'uncategorized' ? 'Uncategorized' : categoryId);
        const poster = channel.stream_icon || channel.poster_url || defaultVariant.streamIcon || defaultVariant.posterUrl || '';
        const base = {
            ...channel,
            id: `xtream_${localId}_${streamId}`,
            stream_id: streamId,
            streamId,
            name: channel.name || channel.title || defaultVariant.raw || 'Norva',
            title: channel.title || channel.name || defaultVariant.raw || 'Norva',
            num: channel.num ?? channel.lcn ?? null,
            epg_channel_id: channel.epg_channel_id || channel.tvgId || '',
            stream_icon: poster,
            tvgLogo: poster,
            category_id: categoryId,
            category_name: categoryName,
            sourceId: localId,
            source_id: localId,
            cloudSourceId,
            cloudLogicalId: channel.id || channel.logical_id || '',
            playback_status: channel.playback_status || 'unknown',
            playback_mode: channel.playback_mode || 'unknown',
            qualityGroup: {
                name: channel.name || channel.title || defaultVariant.raw || 'Norva',
                variants,
                defaultVariant
            },
            currentVariant: defaultVariant,
            _logicalChannel: true,
            _logicalKind: channel.section || 'cloud',
            _variantCount: Number(channel.variant_count || channel.variantCount || variants.length || 1),
            _sourceGroupTitle: categoryName,
            _displayGroupTitle: categoryName
        };
        base.qualityGroup.variants = variants.map(variant => ({
            ...variant,
            channel: {
                ...base,
                id: `xtream_${variant.sourceId}_${variant.streamId}`,
                stream_id: variant.streamId,
                streamId: variant.streamId,
                name: variant.raw || base.name,
                title: variant.raw || base.title,
                sourceId: variant.sourceId,
                source_id: variant.sourceId,
                currentVariant: variant,
                qualityGroup: undefined
            }
        }));
        base.qualityGroup.defaultVariant = base.qualityGroup.variants.find(variant => String(variant.streamId) === String(defaultVariant.streamId))
            || base.qualityGroup.variants[0]
            || defaultVariant;
        base.currentVariant = base.qualityGroup.defaultVariant;
        return base;
    }

    function normalizeLiveVariant(variant, fallbackLocalSourceId, fallbackCloudSourceId) {
        const cloudSourceId = variant.source_id || variant.sourceId || fallbackCloudSourceId || '';
        const sourceId = cloudSourceId ? localSourceId(cloudSourceId) : fallbackLocalSourceId;
        const streamId = String(variant.stream_id || variant.streamId || variant.external_id || variant.externalId || variant.id || '');
        const raw = variant.raw || variant.name || variant.title || '';
        const poster = variant.stream_icon || variant.poster_url || variant.posterUrl || '';
        return {
            ...variant,
            label: variant.label || 'HD',
            rank: Number.isFinite(Number(variant.rank)) ? Number(variant.rank) : 2,
            healthRank: Number.isFinite(Number(variant.healthRank)) ? Number(variant.healthRank) : 1,
            streamId,
            stream_id: streamId,
            sourceId,
            source_id: sourceId,
            cloudSourceId,
            raw,
            title: variant.title || raw,
            streamIcon: poster,
            posterUrl: poster,
            container: variant.container_extension || variant.container || defaultProviderContainerForType('live')
        };
    }

    function normalizeRecentItem(item) {
        const type = itemTypeToLocal(item.item_type || item.itemType || item.type);
        const itemId = String(item.stream_id || item.series_id || item.external_id || item.externalId || item.id || '');
        const poster = item.stream_icon || item.poster_url || item.posterUrl || item.cover || '';
        return {
            ...item,
            item_id: itemId,
            item_type: type,
            type,
            source_id: item.sourceId || item.source_id,
            sourceId: item.sourceId || item.source_id,
            stream_icon: poster,
            container_extension: item.container_extension || item.containerExtension || defaultProviderContainerForType(type),
            data: {
                title: item.name || item.title || 'Norva',
                subtitle: item.category_name || item.subtitle || (type === 'movie' ? 'Movie' : type === 'series' ? 'Series' : 'Live TV'),
                poster,
                sourceId: item.sourceId || item.source_id,
                containerExtension: item.container_extension || item.containerExtension || defaultProviderContainerForType(type)
            }
        };
    }

    function normalizeHomeRailVariant(variant, context) {
        const raw = variant || {};
        const cloudSourceId = raw.source_id || raw.sourceId || context.cloudSourceId || '';
        const sourceId = cloudSourceId ? localSourceId(cloudSourceId) : context.sourceId;
        const itemId = String(
            raw.external_id ||
            raw.externalId ||
            raw.item_id ||
            raw.itemId ||
            raw.stream_id ||
            raw.streamId ||
            raw.id ||
            ''
        );
        const title = firstUsefulTitle(
            raw.raw_title,
            raw.rawTitle,
            raw.title,
            raw.name,
            context.title
        ) || context.title;
        const poster = raw.poster_url ||
            raw.posterUrl ||
            raw.stream_icon ||
            raw.cover ||
            context.poster ||
            '';
        const container = raw.container_extension ||
            raw.containerExtension ||
            raw.playback_hint?.container ||
            raw.playbackHint?.container ||
            context.container;
        const playbackHint = raw.playback_hint || raw.playbackHint || {};
        const codecProfile = raw.codec_profile || raw.codecProfile || {};
        const providerTmdbId = context.providerTmdbId || null;

        return {
            ...raw,
            id: raw.id || itemId,
            item_id: itemId,
            itemId,
            external_id: itemId,
            externalId: itemId,
            stream_id: itemId,
            streamId: itemId,
            series_id: itemId,
            seriesId: itemId,
            item_type: context.type,
            itemType: context.type,
            type: context.type,
            source_id: sourceId,
            sourceId,
            cloudSourceId,
            cloud_source_id: cloudSourceId,
            media_item_id: raw.media_item_id || raw.mediaItemId || null,
            mediaItemId: raw.mediaItemId || raw.media_item_id || null,
            name: title,
            title,
            raw_title: raw.raw_title || raw.rawTitle || title,
            rawTitle: raw.rawTitle || raw.raw_title || title,
            stream_icon: poster,
            cover: poster,
            poster_url: poster,
            posterUrl: poster,
            container_extension: container,
            containerExtension: container,
            playback_hint: playbackHint,
            playbackHint,
            codec_profile: codecProfile,
            codecProfile,
            provider_tmdb_id: providerTmdbId,
            providerTmdbId,
            tmdb_id: providerTmdbId,
            title_id: context.titleId,
            titleId: context.titleId,
            rating: context.rating || '',
            year: context.year || '',
            tmdb: context.tmdb,
            metadata: {
                ...context.metadata,
                ...(raw.metadata || {}),
                tmdb: context.tmdb
            },
            data: {
                ...context.metadata,
                ...context.data,
                ...(raw.metadata || {}),
                title,
                poster,
                sourceId,
                cloudSourceId,
                containerExtension: container,
                providerTmdbId,
                titleId: context.titleId,
                tmdb: context.tmdb,
                codecProfile,
                playbackHint
            }
        };
    }

    function normalizeHomeRailItem(item) {
        const defaultVariant = item.default_variant || item.defaultVariant || {};
        const cloudSourceId = defaultVariant.source_id || defaultVariant.sourceId || item.source_id || item.sourceId || '';
        const sourceId = cloudSourceId ? localSourceId(cloudSourceId) : (item.source_id || item.sourceId || null);
        const type = itemTypeToLocal(item.item_type || item.itemType || item.type);
        const itemId = String(
            defaultVariant.external_id ||
            defaultVariant.externalId ||
            item.external_id ||
            item.externalId ||
            item.item_id ||
            item.itemId ||
            item.id ||
            ''
        );
        const metadata = item.metadata || {};
        const data = item.data || {};
        const tmdb = data.tmdb || metadata.tmdb || item.tmdb || {};
        const title = firstUsefulTitle(
            data.title,
            metadata.title,
            tmdb.title,
            tmdb.name,
            tmdb.original_title,
            tmdb.original_name,
            item.title,
            item.name,
            item.original_title,
            defaultVariant.title,
            defaultVariant.name,
            defaultVariant.raw_title,
            defaultVariant.rawTitle
        ) || 'Norva';
        const poster = item.stream_icon || item.poster_url || item.posterUrl || item.cover || data.poster || data.posterUrl || '';
        const container = defaultVariant.container_extension ||
            defaultVariant.containerExtension ||
            item.container_extension ||
            item.containerExtension ||
            data.containerExtension ||
            defaultProviderContainerForType(type);
        const providerTmdbId = item.providerTmdbId || item.provider_tmdb_id || data.providerTmdbId || metadata.providerTmdbId || null;
        const titleId = item.titleId || item.title_id || item.id || null;
        const context = {
            type,
            title,
            poster,
            container,
            sourceId,
            cloudSourceId,
            providerTmdbId,
            titleId,
            tmdb,
            metadata,
            data,
            rating: item.rating || data.rating || metadata.rating || metadata.voteAverage || tmdb.vote_average || '',
            year: data.year || item.year || metadata.year || '',
        };
        const rawVariants = Array.isArray(item.variants) && item.variants.length
            ? item.variants
            : (defaultVariant && Object.keys(defaultVariant).length ? [defaultVariant] : []);
        const variants = rawVariants
            .map(variant => normalizeHomeRailVariant(variant, context))
            .filter(variant => variant.item_id && variant.sourceId);
        const normalizedDefaultVariant = variants.find(variant =>
            String(variant.id) === String(item.defaultVariantId || item.default_variant_id || defaultVariant.id || '') ||
            String(variant.item_id) === String(itemId)
        ) || variants[0] || normalizeHomeRailVariant(defaultVariant, context);

        return {
            ...item,
            item_id: itemId,
            itemId,
            item_type: type,
            itemType: type,
            type,
            source_id: sourceId,
            sourceId,
            cloudSourceId,
            stream_id: itemId,
            series_id: itemId,
            name: title,
            title,
            stream_icon: poster,
            cover: poster,
            poster_url: poster,
            container_extension: container,
            containerExtension: container,
            provider_tmdb_id: providerTmdbId,
            providerTmdbId,
            tmdb_id: providerTmdbId,
            title_id: titleId,
            titleId,
            variantCount: item.variantCount || item.variant_count || variants.length || 1,
            variant_count: item.variant_count || item.variantCount || variants.length || 1,
            variants,
            exposedVariants: variants,
            defaultVariant: normalizedDefaultVariant,
            default_variant: normalizedDefaultVariant,
            data: {
                ...metadata,
                ...data,
                title,
                subtitle: data.subtitle || (type === 'movie' ? 'Movie' : type === 'series' ? 'Series' : 'Live TV'),
                poster,
                sourceId,
                cloudSourceId,
                containerExtension: container,
                providerTmdbId,
                titleId,
                tmdb,
                variants
            }
        };
    }

    function firstUsefulTitle(...values) {
        for (const value of values) {
            const title = usefulTitle(value);
            if (title) return title;
        }
        return '';
    }

    function usefulTitle(value) {
        let title = String(value ?? '').replace(/\s+/g, ' ').trim();
        if (!title) return '';
        const normalized = title.toLowerCase();
        if (['0', 'null', 'undefined', 'unknown', 'unknown title', 'norva'].includes(normalized)) return '';
        // Display-clean scene-release names ("[ Torrent911.me ] Name.Year.Vostfr.X264" → "Name Year")
        // at the single point every playback/display name funnels through. raw_title fields keep the
        // raw value (version/quality parsers read those, not this display form).
        if (typeof window !== 'undefined' && window.MediaUtils?.cleanReleaseName) {
            title = window.MediaUtils.cleanReleaseName(title) || title;
        }
        return title;
    }

    function compactPlaybackHint(value = {}) {
        return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ''));
    }

    function numericPlaybackHint(value) {
        if (value === null || value === undefined || value === '') return undefined;
        const parsed = Number.parseFloat(String(value));
        if (!Number.isFinite(parsed) || parsed < 0) return undefined;
        return Math.floor(parsed);
    }

    function playbackHintFromQuery(query, container, type = '') {
        const seekOffset = numericPlaybackHint(
            query.get('seekOffset') ??
            query.get('seek_offset') ??
            query.get('startOffset') ??
            query.get('start_offset') ??
            query.get('resumeTime') ??
            query.get('resume_time') ??
            query.get('start')
        );
        return compactPlaybackHint({
            container,
            streamType: type,
            itemType: type,
            seekOffset,
            startOffset: seekOffset,
            resumeTime: seekOffset,
            gatewayMode: query.get('gatewayMode') || query.get('gateway_mode'),
            audioCodec: query.get('audioCodec'),
            audioProfile: query.get('audioProfile'),
            audioChannels: query.get('audioChannels'),
            audioStreamIndex: numericPlaybackHint(query.get('audioStreamIndex') ?? query.get('audio_stream_index')),
            audioMode: query.get('audioMode'),
            videoCodec: query.get('videoCodec'),
            clientAudioPassthrough: query.get('clientAudioPassthrough') === '1' ? true : undefined
        });
    }

    function requiresGatewayForContainer(type, container) {
        const normalizedType = String(type || '').toLowerCase();
        const normalizedContainer = String(container || '').split('?')[0].split('#')[0].toLowerCase();
        // Live channels are MPEG-TS (or provider HLS with no CORS and a
        // UA-locked origin) — the browser can't play them directly. Route them
        // through the gateway so FFmpeg pulls the stream with the provider's
        // accepted User-Agent and serves browser-compatible HLS.
        if (normalizedType === 'live') return true;
        if (!normalizedContainer) return false;
        return [
            'mkv',
            'avi',
            'wmv',
            'flv',
            'mov',
            'webm',
            'ts',
            'mpeg',
            'mpg',
            'vob'
        ].includes(normalizedContainer);
    }

    // Containers the in-browser engine's libav build can actually DEMUX. The custom build ships the
    // Matroska/WebM, QuickTime/MOV (mp4) AND MPEG-TS demuxers, so .ts remuxes in-browser (fast) instead
    // of the slow gateway transcode. For TS the engine synthesises the H.264 avcC from the in-band
    // SPS/PPS (they're not in the container header) so the mp4 moov is valid. NOT in the engine:
    // MPEG-PS, AVI, WMV/ASF, FLV → gateway transcode. A TS whose video the browser can't decode
    // (MPEG-2, or HEVC without the hvcC path / browser support) fails the SourceBuffer append and the
    // player's fallback re-routes it to the gateway. Unknown/empty container → let the engine try.
    const ENGINE_DEMUXABLE_CONTAINERS = new Set(['mkv', 'webm', 'mka', 'mp4', 'm4v', 'mov', 'm4a', '3gp', '3g2', 'ts', 'mpegts', 'm2ts', 'mts']);
    function engineCanPlayContainer(container) {
        const c = String(container || '').split('?')[0].split('#')[0].toLowerCase();
        if (!c) return true;
        return ENGINE_DEMUXABLE_CONTAINERS.has(c);
    }

    function normalizeCodecToken(value) {
        return String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, '');
    }

    function isSafeBrowserAudio(codecValue, profileValue, channelsValue) {
        const codec = normalizeCodecToken(codecValue);
        const profile = normalizeCodecToken(profileValue);
        const channels = Number.parseInt(String(channelsValue || ''), 10);
        const combined = `${codec} ${profile}`;
        if (!codec) return false;
        if (Number.isFinite(channels) && channels > 2) return false;
        if (
            combined.includes('heaac') ||
            combined.includes('aache') ||
            combined.includes('sbr') ||
            combined.includes('mp4a.40.5') ||
            combined.includes('mp4a.40.29') ||
            codec.includes('eac3') ||
            codec.includes('e-ac3') ||
            codec.includes('ac3') ||
            codec.includes('dts') ||
            codec.includes('truehd') ||
            codec.includes('flac') ||
            codec.includes('pcm')
        ) return false;
        return codec.includes('aac') || codec.includes('mp4a.40.2') || codec.includes('mp3') || codec.includes('opus') || codec.includes('vorbis');
    }

    function shouldVodUseGatewayTranscode(container, playbackHint = {}) {
        const normalizedContainer = String(container || '').split('?')[0].split('#')[0].toLowerCase();
        const videoCodec = normalizeCodecToken(playbackHint.videoCodec);
        // MPEG-TS/PS (ts/m2ts/mpeg/…) join the classic unsafe containers: a stream-COPY remux of TS
        // into HLS is unreliable (PCR/timestamp discontinuities, codec quirks → manifestLoadError),
        // so TS goes straight to a full re-encode instead of failing remux then retrying.
        const unsafeContainer = ['mkv', 'webm', 'avi', 'wmv', 'flv', 'vob', 'ts', 'mpegts', 'm2ts', 'mts', 'mpeg', 'mpg', 'ps'].includes(normalizedContainer);
        const unsafeVideo = videoCodec && !(
            videoCodec.includes('h264') ||
            videoCodec.includes('avc1') ||
            videoCodec.includes('avc')
        );
        const hasAudioMetadata = Boolean(playbackHint.audioCodec || playbackHint.audioProfile || playbackHint.audioChannels);
        const unsafeAudio = hasAudioMetadata && !isSafeBrowserAudio(
            playbackHint.audioCodec,
            playbackHint.audioProfile,
            playbackHint.audioChannels
        );
        return unsafeContainer || unsafeVideo || unsafeAudio;
    }

    async function sourcePayloadFromLocal(data) {
        const type = data.type || data.sourceType || data.source_type || 'xtream';
        const payload = {
            sourceType: type,
            displayName: data.name || data.displayName || data.display_name || (type === 'm3u' ? 'Playlist link' : 'TV provider'),
            syncNow: data.syncNow !== false
        };

        if (type === 'xtream') {
            payload.url = data.url || data.serverUrl || data.server_url;
            payload.username = data.username;
            payload.password = data.password;
        } else if (type === 'm3u') {
            payload.url = data.url || data.playlistUrl || data.playlist_url;
        } else if (type === 'epg') {
            payload.url = data.url || data.epgUrl || data.epg_url;
        }

        return payload;
    }

    async function sourcePatchFromLocal(id, data = {}) {
        const cached = (await listSources()).find(source => String(source.id) === String(id) || source.cloudId === id) || {};
        const type = data.type || data.sourceType || data.source_type || cached.type || 'xtream';
        const patch = {
            sourceType: type
        };

        if (data.name || data.displayName || data.display_name) {
            patch.displayName = data.name || data.displayName || data.display_name;
        }

        if (type === 'xtream' && data.password) {
            patch.url = data.url || data.serverUrl || data.server_url || cached.url;
            patch.username = data.username || cached.username || '';
            patch.password = data.password;
            patch.syncNow = data.syncNow !== false;
        } else if ((type === 'm3u' || type === 'epg') && data.url) {
            patch.url = data.url || data.playlistUrl || data.playlist_url || data.epgUrl || data.epg_url;
            patch.syncNow = data.syncNow !== false;
        }

        return patch;
    }

    async function request(method, endpoint, data = null) {
        const [path, queryString = ''] = endpoint.split('?');
        const query = new URLSearchParams(queryString);

        if (method === 'GET' && path === '/sources') return listSources();
        if (method === 'GET' && path.startsWith('/sources/type/')) {
            const type = decodeURIComponent(path.split('/').pop());
            return (await listSources()).filter(source => source.type === type);
        }
        if (method === 'GET' && path === '/sources/status') {
            return (await listSources()).map(source => ({
                source_id: source.id,
                sourceId: source.id,
                status: source.sync_status,
                error: source.sync_error,
                last_sync: source.last_sync
            }));
        }
        if (method === 'GET' && /^\/sources\/[^/]+$/.test(path)) {
            const id = path.split('/').pop();
            return (await listSources()).find(source => String(source.id) === String(id) || source.cloudId === id) || null;
        }
        if (method === 'POST' && path === '/sources') {
            if (!hasUserSession()) throw new Error('Sign in to add a TV provider.');
            const payload = await NorvaCloud.sources.create(await sourcePayloadFromLocal(data || {}));
            clearMediaCaches();
            return normalizeSource(payload.source);
        }
        if ((method === 'PUT' || method === 'PATCH') && /^\/sources\/[^/]+$/.test(path)) {
            const id = await resolveSourceId(path.split('/').pop());
            const patch = await sourcePatchFromLocal(id, data || {});
            if (!hasUserSession()) throw new Error('Sign in to edit a TV provider.');
            const payload = await NorvaCloud.sources.update(id, patch);
            clearMediaCaches();
            return normalizeSource(payload.source);
        }
        if (method === 'DELETE' && /^\/sources\/[^/]+$/.test(path)) {
            const id = await resolveSourceId(path.split('/').pop());
            if (!hasUserSession()) throw new Error('Sign in to remove a TV provider.');
            const payload = await NorvaCloud.sources.remove(id);
            sourcesCache = sourcesCache.filter(source => source.cloudId !== id);
            clearMediaCaches();
            return payload;
        }
        if (method === 'POST' && /^\/sources\/[^/]+\/(sync|hard-sync)$/.test(path)) {
            const parts = path.split('/');
            if (!hasUserSession()) throw new Error('Sign in to sync a TV provider.');
            // Hard refresh forces a full rebuild past the cloud change-detection skip.
            const force = /\/hard-sync$/.test(path);
            const payload = await NorvaCloud.sources.sync(await resolveSourceId(parts[2]), { force });
            clearMediaCaches();
            return normalizeSource(payload.source || {});
        }
        if (method === 'POST' && /^\/sources\/[^/]+\/finalize$/.test(path)) {
            const parts = path.split('/');
            if (!hasUserSession()) throw new Error('Sign in to finish importing a TV provider.');
            const id = await resolveSourceId(parts[2]);
            const sourcesApi = cloudSourcesApi();
            if (!sourcesApi.finalize) throw new Error('Catalog finalization is not available.');
            const payload = await sourcesApi.finalize(id, data || {});
            clearMediaCaches();
            return payload;
        }
        if (method === 'POST' && /^\/sources\/[^/]+\/(toggle|test)$/.test(path)) {
            return { success: true, cloud: true };
        }
        if ((method === 'GET' && /^\/sources\/[^/]+\/estimate$/.test(path)) || (method === 'POST' && path === '/sources/estimate')) {
            return { count: 0, estimatedItems: 0, needsWarning: false, threshold: 50000, cloud: true };
        }

        if (method === 'GET' && path === '/media/page') {
            return getMediaPage({
                sourceId: query.get('sourceId') || '',
                type: query.get('type') || '',
                q: query.get('q') || '',
                categoryId: query.get('categoryId') || '',
                sort: query.get('sort') || 'default',
                year: query.get('year') || '',
                minRating: query.get('minRating') || '',
                addedDays: query.get('addedDays') || '',
                limit: query.get('limit') || 120,
                offset: query.get('offset') || 0
            });
        }

        if (method === 'GET' && path === '/media/categories') {
            return listMediaCategories({
                sourceId: query.get('sourceId') || '',
                type: query.get('type') || ''
            });
        }

        const xtreamMatch = path.match(/^\/proxy\/xtream\/([^/]+)\/([^/]+)(?:\/([^/]+)\/([^/]+))?/);
        if (xtreamMatch && method === 'GET') {
            const sourceId = xtreamMatch[1];
            const action = xtreamMatch[2];
            const streamId = action === 'stream' ? xtreamMatch[3] : xtreamMatch[4];
            if (action === 'auth') return { user_info: { auth: 1, status: 'Active' } };
            if (action === 'live_categories' || action === 'vod_categories' || action === 'series_categories') {
                const type = action === 'live_categories' ? 'live' : action === 'vod_categories' ? 'movie' : 'series';
                try {
                    if (type === 'live') return await listLiveLogicalCategories({ sourceId });
                    return await listMediaCategories({ sourceId, type });
                } catch (err) {
                    console.warn('[Cloud] Unable to load categories without full catalog:', err);
                    if (type === 'live') {
                        try {
                            return await listMediaCategories({ sourceId, type });
                        } catch (fallbackErr) {
                            console.warn('[Cloud] Raw live categories fallback failed:', fallbackErr);
                        }
                    }
                    return [];
                }
            }
            if (action === 'live_streams' || action === 'vod_streams' || action === 'series') {
                const type = action === 'live_streams' ? 'live' : action === 'vod_streams' ? 'movie' : 'series';
                const categoryId = query.get('category_id');
                if (type === 'live') {
                    try {
                        return await listLiveLogicalChannels({
                            sourceId,
                            categoryId,
                            q: query.get('q') || '',
                            limit: query.get('limit') || '',
                            offset: query.get('offset') || ''
                        });
                    } catch (err) {
                        console.warn('[Cloud] Logical live catalog unavailable, falling back to raw media items:', err);
                    }
                }
                const items = await listAllMedia({ sourceId, type, q: query.get('q') || '' });
                return categoryId ? items.filter(item => String(item.category_id) === String(categoryId)) : items;
            }
            if (action === 'series_info') {
                const cloudSourceId = await resolveSourceId(sourceId);
                const seriesId = query.get('series_id');
                const sourcesApi = cloudSourcesApi();
                if (sourcesApi.seriesInfo && seriesId) {
                    return sourcesApi.seriesInfo(cloudSourceId, seriesId);
                }
                return { info: {}, episodes: {} };
            }
            if (action === 'short_epg') {
                const cloudSourceId = await resolveSourceId(sourceId);
                const requestedStreamId = query.get('stream_id') || streamId || '';
                const limit = query.get('limit') || 8;
                const sourcesApi = cloudSourcesApi();
                if (sourcesApi.shortEpg && requestedStreamId) {
                    return sourcesApi.shortEpg(cloudSourceId, requestedStreamId, limit);
                }
                return { epg_listings: [] };
            }
            if (action === 'stream' && streamId) {
                const type = query.get('type') || xtreamMatch[4] || 'live';
                const isVodPlayback = type === 'movie' || type === 'series';
                const requestedContainer = query.get('container') || defaultProviderContainerForType(type);
                const container = (isVodPlayback && (!requestedContainer || requestedContainer === 'm3u8'))
                    ? 'mp4'
                    : requestedContainer;

                // Desktop app / local Norva server in cloud mode: keep catalog +
                // resume in the cloud, but TRANSCODE on this machine (residential
                // IP) so the provider doesn't 401-block a datacenter. Resolve the
                // raw provider URL from the cloud (direct), hand it to the local
                // transcoder, and play its HLS through the normal pipeline. Only
                // triggers when a local transcoder is present (desktop/localhost);
                // norva.tv in a browser never hits this. On any failure it falls
                // through to the normal cloud path.
                const localTranscoder = _localTranscoderBase();
                if (localTranscoder) {
                    try {
                        const hint = playbackHintFromQuery(query, container, type);
                        const cloudSourceId = await resolveSourceId(sourceId);
                        const userAgent = resolveCloudUserAgent();
                        const direct = await cloudPlaybackApi().createSession({
                            sourceId: cloudSourceId,
                            itemType: type === 'series' ? 'series' : type === 'movie' ? 'movie' : 'live',
                            itemId: streamId,
                            playbackHint: hint,
                            mode: 'direct',
                            clientMetadata: _cloudClientTelemetryMetadata(),
                            ...(userAgent ? { userAgent } : {})
                        });
                        const providerUrl = direct?.playback?.url || direct?.url;
                        if (!providerUrl) throw new Error('Cloud did not return a direct stream URL');
                        const seekOffset = Math.max(0, Math.floor(Number(
                            hint.seekOffset ?? hint.startOffset ?? hint.resumeTime ?? 0
                        )) || 0);
                        const transcodeRes = await fetch(`${localTranscoder}/api/transcode/session`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: providerUrl, seekOffset })
                        });
                        if (!transcodeRes.ok) {
                            const detail = await transcodeRes.json().catch(() => ({}));
                            throw new Error(detail.error || `Local transcoder error ${transcodeRes.status}`);
                        }
                        const ts = await transcodeRes.json();
                        if (!ts?.playlistUrl) throw new Error('Local transcoder returned no playlist');
                        const hls = `${localTranscoder}${ts.playlistUrl}`;
                        return {
                            url: hls,
                            streamUrl: hls,
                            playbackUrl: hls,
                            cloud: true,
                            mode: 'desktop-local',
                            sessionId: direct?.session?.id,
                            seekOffset,
                            startOffset: seekOffset
                        };
                    } catch (localErr) {
                        console.warn('[Desktop] Local transcode failed; falling back to cloud gateway:', localErr?.message || localErr);
                        // fall through to the normal cloud path below
                    }
                }

                // Plain browser (no native player, no local transcoder): if this
                // source's cloud playback was just refused by the provider
                // (datacenter 401), skip the doomed ~10s gateway attempt and hand
                // off to the apps immediately. A working source is never skipped
                // (only set after a real block) and it self-heals after a TTL.
                const hasNativeOrLocal = (typeof window !== 'undefined'
                    && (window.NodeCastNative || window.NorvaTVCloud)) || localTranscoder;
                if (!hasNativeOrLocal && isVodPlayback && _isSourceCloudBlocked(sourceId)) {
                    const blockedErr = new Error('Lecture cloud refusee par le fournisseur (401).');
                    blockedErr.cloudBrowserBlocked = true;
                    throw blockedErr;
                }
                // LIVE back-off: the provider just 401/403'd this source (slot storm).
                // Fail fast for a short window instead of piling on more connections,
                // so the single-slot cooldown lifts and the next try succeeds.
                if (!hasNativeOrLocal && type === 'live' && _isLiveBlocked(sourceId)) {
                    const liveBackoff = new Error('Channel temporarily unavailable (provider busy) — try again in a few seconds.');
                    liveBackoff.liveProviderBackoff = true;
                    throw liveBackoff;
                }

                // LIVE — provider's NATIVE HLS through the Cloudflare relay (same
                // path VOD uses), instead of the Railway ffmpeg gateway. The relay
                // fetches the provider's .m3u8 + .ts SEGMENTS as short GET requests
                // — the same access pattern the provider already serves for VOD —
                // rather than the single continuous connection the live ffmpeg
                // holds, which the provider 403-blocks on a datacenter IP. So most
                // (H.264/AAC) channels play with NO Railway and escape the block.
                // HEVC/AC3 channels can't decode in the browser and fall back to
                // the gateway transcode: the player flags the channel and re-asks
                // with liveForceTranscode=1.
                // OPT-IN (default OFF): only worth it for providers that allow
                // multiple concurrent connections / serve open HLS. Single-slot
                // providers (one connection at a time) refuse the relay's .m3u8
                // while the gateway holds the slot, so it just wastes a connection
                // and falls back. Enable per deployment with
                // localStorage['norva-live-hls-relay']='1' once a provider is known
                // to serve open HLS.
                const liveRelayHlsOptIn = (() => {
                    try { return localStorage.getItem('norva-live-hls-relay') === '1'; } catch (_) { return false; }
                })();
                if (type === 'live'
                    && liveRelayHlsOptIn
                    && !hasNativeOrLocal
                    && query.get('liveForceTranscode') !== '1'
                    && query.get('mode') !== 'transcode') {
                    try {
                        const liveCloudSourceId = await resolveSourceId(sourceId);
                        const liveUserAgent = resolveCloudUserAgent();
                        const relayPayload = await cloudPlaybackApi().createSession({
                            sourceId: liveCloudSourceId,
                            itemType: 'live',
                            itemId: streamId,
                            // Force the provider's HLS endpoint (…/<id>.m3u8); the
                            // edge only honours m3u8 for live when explicit.
                            playbackHint: { container: 'm3u8', containerExplicit: true },
                            mode: 'relay',
                            requiresRelay: true,
                            // The relay token is just an HMAC for the relay URL (it
                            // holds no provider connection), so a long TTL is safe
                            // and keeps a long live watch from dropping mid-stream
                            // when a short session TTL would expire the segments.
                            ttlSeconds: 7200,
                            clientMetadata: _cloudClientTelemetryMetadata(),
                            ...(liveUserAgent ? { userAgent: liveUserAgent } : {})
                        });
                        const relayUrl = relayPayload.playback?.url || relayPayload.url;
                        if (relayUrl) {
                            _clearSourceCloudBlock(sourceId);
                            return {
                                ...relayPayload,
                                url: relayUrl,
                                streamUrl: relayUrl,
                                playbackUrl: relayUrl,
                                cloud: true,
                                mode: 'relay-hls',
                                sessionId: relayPayload.session?.id,
                                cloudSourceId: liveCloudSourceId
                            };
                        }
                    } catch (relayErr) {
                        console.warn('[Live] Relay HLS unavailable, falling back to gateway transcode:', relayErr?.message || relayErr);
                        // fall through to the gateway path below
                    }
                }

                const requestedCloudMode = localStorage.getItem('norva-cloud-playback-mode') || '';
                const forcedMode = query.get('mode') || '';
                const preferredMode = forcedMode || (isVodPlayback ? 'transcode' : (requestedCloudMode || 'relay'));
                const needsGateway = requiresGatewayForContainer(type, container);
                // VOD whose container the browser can't play directly (mkv/avi/…):
                // relay/direct can never work for it, so failures must stay on the
                // gateway transcode path instead of cascading into "Media error".
                const gatewayOnlyVod = isVodPlayback && needsGateway;
                const playbackHint = playbackHintFromQuery(query, container, type);
                // Native client (Android TV / standalone): a native ExoPlayer with
                // hardware HEVC/MKV/AC3 decoders plays straight from the user's home
                // network. Pull the RAW provider URL (direct) instead of the cloud
                // gateway, whose datacenter IP the provider 401-blocks. This is what
                // makes the TV behave like TiviMate.
                const nativePlayer = typeof window !== 'undefined'
                    && (window.NodeCastNative || window.NorvaTVCloud);
                // Browser-safe film/series (mp4 + H.264/AAC): the browser plays it
                // directly, so serve it through the RELAY (pass-through, no transcode
                // server) rather than the cloud gateway. The browser then seeks
                // client-side for an instant Resume, and nothing depends on a
                // transcode gateway. Anything that needs decoding help (mkv/HEVC/AC3
                // or live) still takes the gateway/transcode path.
                // "Not proven unsafe" is NOT "safe": an mp4/mov/m4v with an UNKNOWN video codec
                // (series episodes arrive from norva-series-info without the codec_profile that
                // norva-catalog attaches to movies) defaults through here and DEAD-ENDS on the
                // native <video> element when it's actually HEVC. When the codec is unknown and the
                // container is engine-demuxable, prefer the in-browser engine (plays H.264 AND HEVC,
                // and fails over to the gateway transcode on error) over gambling on native.
                // Known-H.264 keeps the fast native/relay path; nativePlayer (hardware HEVC) is
                // handled earlier in the mode ternary and is unaffected.
                const videoCodecKnown = Boolean(normalizeCodecToken(playbackHint.videoCodec));
                const browserSafeVod = isVodPlayback
                    && !needsGateway
                    && !shouldVodUseGatewayTranscode(container, playbackHint)
                    && (videoCodecKnown || !engineCanPlayContainer(container));
                // Browser VOD that needs container/codec help (mkv/avi, HEVC,
                // AC-3/DTS/TrueHD audio, …): play it with the in-browser engine
                // (NorvaEngine remuxes the container + transcodes the audio to
                // AAC client-side and feeds MediaSource). No transcode server, no
                // Railway. Gated on the engine script being present so a stale
                // cache falls back to the gateway instead of failing. Native +
                // browser-safe keep their existing paths.
                const engineVod = isVodPlayback
                    && !nativePlayer
                    && !browserSafeVod
                    && engineCanPlayContainer(container)
                    && typeof window !== 'undefined'
                    && Boolean(window.NorvaEngine);
                const mode = forcedMode
                    || (nativePlayer
                        ? 'direct'
                        : browserSafeVod
                            ? 'relay'
                            : engineVod
                                ? 'engine'
                                : (((isVodPlayback || needsGateway) && preferredMode !== 'direct') ? 'transcode' : preferredMode));
                if ((type === 'series' || type === 'movie') && !playbackHint.gatewayMode) {
                    const needsFullGatewayTranscode = shouldVodUseGatewayTranscode(container, playbackHint);
                    // VOD only uses remux when the container, video and audio
                    // are browser-safe. MKV + AC3/5.1 can decode poorly after
                    // Gateway seeks, so force clean H.264/AAC HLS instead.
                    playbackHint.gatewayMode = needsFullGatewayTranscode ? 'transcode' : 'remux';
                    if (needsFullGatewayTranscode && !playbackHint.audioMode) {
                        playbackHint.audioMode = 'transcode';
                    }
                }
                const cloudSourceId = await resolveSourceId(sourceId);
                const userAgent = resolveCloudUserAgent();
                const baseSession = {
                    sourceId: cloudSourceId,
                    itemType: type === 'series' ? 'series' : type === 'movie' ? 'movie' : 'live',
                    itemId: streamId,
                    playbackHint,
                    seekOffset: playbackHint.seekOffset,
                    clientMetadata: _cloudClientTelemetryMetadata(),
                    corsSafe: false,
                    ...(userAgent ? { userAgent } : {})
                };
                // Engine mode: fetch a RAW pass-through URL (byte-range + CORS)
                // via the relay and hand it to the in-browser engine. No gateway
                // transcode session is created, so there is no Railway dependency
                // and Resume seeks straight to the saved offset client-side.
                if (mode === 'engine') {
                    const enginePayload = await cloudPlaybackApi().createSession({
                        ...baseSession,
                        mode: 'relay',
                        requiresRelay: true,
                        enginePipe: true
                    });
                    const engineUrl = enginePayload.playback?.url || enginePayload.url;
                    if (!engineUrl) {
                        const e = new Error('Engine: relay unavailable (raw URL missing).');
                        e.engineUnavailable = true;
                        throw e;
                    }
                    if (!hasNativeOrLocal) _clearSourceCloudBlock(sourceId);
                    return {
                        ...enginePayload,
                        url: engineUrl,
                        streamUrl: engineUrl,
                        playbackUrl: engineUrl,
                        cloud: true,
                        mode: 'engine',
                        sessionId: enginePayload.session?.id
                    };
                }
                const remuxFirst = mode === 'transcode' && baseSession.playbackHint.gatewayMode === 'remux';
                const createGatewayTranscodeSession = () => cloudPlaybackApi().createSession({
                    ...baseSession,
                    playbackHint: {
                        ...baseSession.playbackHint,
                        gatewayMode: 'transcode',
                        audioMode: baseSession.playbackHint.audioMode || 'transcode'
                    },
                    mode: 'transcode',
                    requiresTranscode: true
                });
                // The IPTV provider grants a single concurrent connection. Right
                // after a refresh or a quick title switch its previous slot can
                // still be held, so the gateway answers the first attempt(s) with
                // a transient 502/503/504 ("Media gateway refused the session").
                // The edge function re-runs its session cleanup + slot-release
                // wait on every call, so retrying with a short backoff lets the
                // slot free. Only provider-slot rejections are retried; a genuinely
                // dead source fails with a different reason and surfaces at once,
                // so this never reopens the old ~30s "Media error" storm.
                const PROVIDER_SLOT_RETRY_DELAYS_MS = [2500, 5000];
                const isProviderSlotBusy = (err) => {
                    if (!err || (err.status !== 502 && err.status !== 503 && err.status !== 504)) return false;
                    const detail = err.payload?.details;
                    const reason = String(
                        detail && typeof detail === 'object' ? (detail.details ?? detail.error ?? '') : (detail ?? '')
                    ).toLowerCase();
                    // Reason not forwarded by the gateway: treat the 5xx as possibly transient.
                    if (!reason) return true;
                    return /\b401\b|\b403\b|unauthor|forbidden|timed out|connection reset|-1005[34]|concurren|\bslot\b/.test(reason);
                };
                const attemptCreateGatewaySession = async () => {
                    let payload;
                    try {
                        payload = await cloudPlaybackApi().createSession({
                            ...baseSession,
                            mode,
                            requiresRelay: mode === 'relay',
                            requiresTranscode: mode === 'transcode'
                        });
                        if (mode === 'transcode' && !payload.playback?.url && preferredMode !== 'direct') {
                            // Gateway-only VOD can't play via relay or direct in the
                            // browser, so retry the transcode instead of cascading
                            // into an unplayable stream.
                            payload = gatewayOnlyVod
                                ? await createGatewayTranscodeSession()
                                : await cloudPlaybackApi().createSession({
                                    ...baseSession,
                                    mode: 'relay',
                                    requiresRelay: true
                                });
                        }
                    } catch (error) {
                        if (mode === 'direct') throw error;
                        if (remuxFirst && (error.status === 502 || error.status === 503 || error.status === 504 || error.status === 500)) {
                            try {
                                payload = await createGatewayTranscodeSession();
                            } catch (transcodeError) {
                                if (!transcodeError.status || transcodeError.status < 500) throw transcodeError;
                            }
                        }
                        // Gateway-only VOD is unplayable via relay/direct in the
                        // browser, so never cascade into them — that is exactly what
                        // produced the ~30s "Media error" storm on Resume. The gateway
                        // already retries provider 401s internally; give the transcode
                        // one more try, otherwise surface the failure.
                        if (!payload && gatewayOnlyVod) {
                            if (error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504) {
                                payload = await createGatewayTranscodeSession();
                            }
                            if (!payload) throw error;
                        }
                        if (!payload && mode === 'transcode' && preferredMode !== 'direct') {
                            try {
                                payload = await cloudPlaybackApi().createSession({
                                    ...baseSession,
                                    mode: 'relay',
                                    requiresRelay: true
                                });
                            } catch (relayError) {
                                if (relayError.status !== 503) throw relayError;
                            }
                        }
                        if (!payload) {
                            if (error.status !== 503 && error.status !== 502) throw error;
                            payload = await cloudPlaybackApi().createSession({
                                ...baseSession,
                                mode: 'direct',
                            });
                        }
                    }
                    return payload;
                };
                let payload;
                if (type === 'live') {
                    // Single-slot provider: the gateway ALREADY retries the provider
                    // internally (PROVIDER_AUTH_RETRY). The client retry-loop + the
                    // relay/direct cascades below re-create sessions on top of that —
                    // ~9-15 provider connections per failed zap — which is exactly
                    // what trips the provider's anti-abuse cooldown. For live, do ONE
                    // attempt; on a provider block, back off briefly so the cooldown
                    // lifts instead of being prolonged. (relay/direct can't play live
                    // in-browser anyway, so the cascades were dead weight.)
                    try {
                        payload = await cloudPlaybackApi().createSession({
                            ...baseSession,
                            mode,
                            requiresTranscode: mode === 'transcode'
                        });
                    } catch (sessionError) {
                        if (!hasNativeOrLocal && _looksProviderBlocked(sessionError)) {
                            // One dead channel's 403 must not block the source — only
                            // a real cooldown (several distinct channels failing in a
                            // short window) trips the back-off.
                            _noteLiveFailureMaybeBlock(sourceId, streamId);
                        }
                        throw sessionError;
                    }
                    // A success clears both the back-off and the recent-failure tally
                    // so an earlier dead-channel click can't accrue toward a block.
                    if (!hasNativeOrLocal) {
                        _clearLiveBlock(sourceId);
                        _recentLiveFails = _recentLiveFails.filter((f) => f.src !== String(sourceId));
                    }
                } else {
                    try {
                        for (let providerAttempt = 0; ; providerAttempt += 1) {
                            try {
                                payload = await attemptCreateGatewaySession();
                                break;
                            } catch (sessionError) {
                                if (!isProviderSlotBusy(sessionError) || providerAttempt >= PROVIDER_SLOT_RETRY_DELAYS_MS.length) {
                                    throw sessionError;
                                }
                                await new Promise((resolve) => setTimeout(resolve, PROVIDER_SLOT_RETRY_DELAYS_MS[providerAttempt]));
                            }
                        }
                    } catch (sessionError) {
                        // Browser: a provider block means the cloud datacenter is
                        // refused for this source — remember it so the next title hands
                        // off instantly instead of spinning again.
                        if (!hasNativeOrLocal && _looksProviderBlocked(sessionError)) {
                            _markSourceCloudBlocked(sourceId);
                        }
                        throw sessionError;
                    }
                    if (!hasNativeOrLocal) _clearSourceCloudBlock(sourceId);
                }
                const url = payload.playback?.url || payload.url;
                return {
                    ...payload,
                    url,
                    streamUrl: url,
                    playbackUrl: url,
                    // Native-only: gateway byte-pipe URL the native player falls back
                    // to when the provider refuses the direct (residential-IP) request.
                    fallbackUrl: payload.playback?.fallbackUrl || null,
                    cloud: true,
                    mode: payload.playback?.mode || mode,
                    sessionId: payload.session?.id,
                    // Resolved cloud source UUID (validated by the edge fn when the
                    // session was created). Callers use it for telemetry so live
                    // events send a real UUID, not the local numeric source id.
                    cloudSourceId
                };
            }
        }

        const epgMatch = path.match(/^\/proxy\/epg\/([^/]+)(?:\/channels)?$/);
        if (epgMatch && (method === 'GET' || method === 'POST')) {
            const cloudSourceId = await resolveSourceId(epgMatch[1]);
            const sourcesApi = cloudSourcesApi();
            if (sourcesApi.epg) {
                return sourcesApi.epg(cloudSourceId, {
                    refresh: query.get('refresh') === '1' ? '1' : '',
                    maxAge: query.get('maxAge') || '',
                    beforeHours: query.get('beforeHours') || query.get('windowBeforeHours') || '2',
                    afterHours: query.get('afterHours') || query.get('windowAfterHours') || '8'
                });
            }
            return { channels: [], programmes: [] };
        }
        if (method === 'DELETE' && path.startsWith('/proxy/cache/')) return { success: true };

        if (path.startsWith('/favorites')) return handleFavorites(method, path, query, data);
        if (path.startsWith('/history')) return handleHistory(method, path, query, data);

        if (path.startsWith('/channels/hidden')) {
            if (method === 'GET') return path.endsWith('/check') ? { hidden: false } : [];
            return { success: true };
        }
        if (method === 'GET' && path === '/home/rails') {
            const requestedType = query.get('type') || '';
            const limit = Math.max(1, Math.min(50, Number.parseInt(query.get('limit') || '18', 10) || 18));
            const payload = await getHomeRails({ type: requestedType, limit });
            return {
                ...payload,
                rails: (payload.rails || []).map(rail => ({
                    ...rail,
                    items: (rail.items || []).slice(0, limit).map(normalizeHomeRailItem)
                }))
            };
        }
        if (method === 'GET' && path === '/media/genre-rails') {
            const requestedType = query.get('type') || 'movie';
            const limit = Math.max(1, Math.min(50, Number.parseInt(query.get('limit') || '18', 10) || 18));
            const payload = await getGenreRails({ type: requestedType, limit });
            return {
                ...payload,
                rails: (payload.rails || []).map(rail => ({
                    ...rail,
                    items: (rail.items || []).slice(0, limit).map(normalizeHomeRailItem)
                }))
            };
        }
        if (method === 'GET' && path === '/media/genre-items') {
            const requestedType = query.get('type') || 'movie';
            const limit = Math.max(1, Math.min(100, Number.parseInt(query.get('limit') || '36', 10) || 36));
            const offset = Math.max(0, Number.parseInt(query.get('offset') || '0', 10) || 0);
            const payload = await getGenreItems({
                type: requestedType, bucket: query.get('bucket') || '', limit, offset,
                audio: query.get('audio') || '', subs: query.get('subs') || '',
                sort: query.get('sort') || '', prefAudio: query.get('prefAudio') || '',
                prefSubs: query.get('prefSubs') || '', q: query.get('q') || '',
                year: query.get('year') || '', minRating: query.get('minRating') || ''
            });
            return {
                ...payload,
                items: (payload.items || []).map(normalizeHomeRailItem)
            };
        }
        if (method === 'GET' && path === '/media/genre-summary') {
            return getGenreSummary({ type: query.get('type') || 'movie', source: query.get('source') || '' });
        }
        if (method === 'GET' && path === '/channels/recent') {
            const requestedType = query.get('type') || 'movie';
            const limit = Math.max(1, Math.min(50, Number.parseInt(query.get('limit') || '12', 10) || 12));
            const type = cloudTypeFromLocal(requestedType);
            try {
                const payload = await getHomeRails({ type, limit });
                const rail = (payload.rails || []).find(item => item.itemType === type || item.item_type === type || String(item.id || '').includes(type));
                if (rail?.items?.length) {
                    return rail.items.slice(0, limit).map(normalizeHomeRailItem);
                }
            } catch (err) {
                console.warn('[Cloud] Home rail unavailable, falling back to media page:', err);
            }
            const items = await listMediaPage({ type, limit });
            return items.map(normalizeRecentItem);
        }
        if (path.startsWith('/channels/')) return { success: true };
        if (path.startsWith('/playback-status')) return method === 'GET' ? [] : { success: true, cloud: true };
        if (path.startsWith('/tmdb')) return { enabled: false, cloud: true };
        if (path === '/settings' || path === '/settings/defaults') {
            if (method === 'DELETE') {
                localStorage.removeItem('norva-cloud-settings');
                return defaultSettings();
            }
            if (method === 'PUT') {
                const next = { ...defaultSettings(), ...JSON.parse(localStorage.getItem('norva-cloud-settings') || '{}'), ...(data || {}) };
                localStorage.setItem('norva-cloud-settings', JSON.stringify(next));
                return next;
            }
            return { ...defaultSettings(), ...JSON.parse(localStorage.getItem('norva-cloud-settings') || '{}') };
        }
        if (method === 'GET' && path === '/settings/sync-status') {
            const sources = await listSources().catch(() => []);
            const lastSyncTime = sources
                .map(source => source.last_sync || source.lastSyncedAt || source.last_synced_at)
                .filter(Boolean)
                .sort()
                .pop() || null;
            return { lastSyncTime, cloud: true };
        }
        if (path.startsWith('/cloud/')) return { linked: true, cloud: true };

        throw new Error(`Cloud API route not mapped: ${method} ${endpoint}`);
    }

    async function handleFavorites(method, path, query, data) {
        if (!hasUserSession()) return method === 'GET' && path === '/favorites/check' ? { favorite: false, isFavorite: false } : (method === 'GET' ? [] : { success: true });
        if (method === 'GET' && path === '/favorites/check') {
            const sourceId = await resolveSourceId(query.get('sourceId'));
            const itemId = String(query.get('itemId') || '');
            const itemType = itemTypeToLocal(query.get('itemType') || 'channel');
            const payload = await NorvaCloud.favorites.list({ sourceId, itemType });
            const favorite = (payload.favorites || []).find(item => String(item.item_id) === itemId);
            return { favorite: Boolean(favorite), isFavorite: Boolean(favorite), id: favorite?.id };
        }
        if (method === 'GET') {
            const sourceId = query.get('sourceId') ? await resolveSourceId(query.get('sourceId')) : '';
            const itemType = query.get('itemType') ? itemTypeToLocal(query.get('itemType')) : '';
            const payload = await NorvaCloud.favorites.list({ sourceId, itemType });
            return (payload.favorites || []).map(mapFavorite);
        }
        if (method === 'POST') {
            const cloudSourceId = await resolveSourceId(data.sourceId);
            const itemType = itemTypeToLocal(data.itemType || 'channel');
            const payload = await NorvaCloud.favorites.add({
                sourceId: cloudSourceId,
                itemId: String(data.itemId),
                itemType,
                itemName: data.itemName,
                itemMeta: data.itemMeta || {}
            });
            return mapFavorite(payload.favorite);
        }
        if (method === 'DELETE') {
            const cloudSourceId = await resolveSourceId(data.sourceId);
            const itemType = itemTypeToLocal(data.itemType || 'channel');
            const payload = await NorvaCloud.favorites.list({ sourceId: cloudSourceId, itemType });
            const favorite = (payload.favorites || []).find(item => String(item.item_id) === String(data.itemId));
            if (favorite) return NorvaCloud.favorites.remove(favorite.id);
            return { success: true };
        }
        return { success: true };
    }

    function mapFavorite(item = {}) {
        const localId = item.source_id ? localSourceId(item.source_id) : null;
        return {
            ...item,
            source_id: localId,
            sourceId: localId,
            item_id: item.item_id,
            itemId: item.item_id,
            item_type: cloudTypeFromLocal(item.item_type) === 'live' ? 'channel' : item.item_type,
            itemType: cloudTypeFromLocal(item.item_type) === 'live' ? 'channel' : item.item_type
        };
    }

    async function handleHistory(method, path, query, data) {
        if (!hasUserSession()) return method === 'GET' ? [] : { success: true };
        if (method === 'GET') {
            const payload = await NorvaCloud.history.list({ limit: query.get('limit') || 200 });
            return (payload.history || []).map(mapHistory);
        }
        if (method === 'POST') {
            const cloudSourceId = data?.sourceId ? await resolveSourceId(data.sourceId) : null;
            const itemType = cloudTypeFromLocal(data?.itemType || data?.type || 'movie');
            const item = {
                ...data,
                sourceId: cloudSourceId,
                itemType,
                itemId: String(data.itemId || data.id),
                itemName: data.itemName || data.name || data.title,
                progressSeconds: data.progressSeconds ?? data.progress,
                durationSeconds: data.durationSeconds ?? data.duration,
                data: { ...(data.data || {}), sourceId: data.sourceId }
            };
            const payload = await NorvaCloud.history.save(item);
            return mapHistory(payload.item);
        }
        if (method === 'DELETE') {
            const itemId = decodeURIComponent(path.split('/').pop());
            const payload = await NorvaCloud.history.list({ limit: 500 });
            const item = (payload.history || []).find(entry => String(entry.id) === itemId || String(entry.item_id) === itemId);
            if (item) return NorvaCloud.history.remove(item.id);
            return { success: true };
        }
        return { success: true };
    }

    function mapHistory(item = {}) {
        const localId = item.source_id ? localSourceId(item.source_id) : null;
        const data = { ...(item.data || {}) };
        if (localId) data.sourceId = localId;
        return {
            ...item,
            source_id: localId,
            sourceId: localId,
            item_id: item.item_id,
            itemId: item.item_id,
            item_type: item.item_type === 'live' ? 'channel' : item.item_type,
            itemType: item.item_type === 'live' ? 'channel' : item.item_type,
            progress: item.progress_seconds || 0,
            duration: item.duration_seconds || 0,
            data
        };
    }

    // Mirrors server/db.js USER_AGENT_PRESETS so the cloud gateway can use the
    // same provider-accepted User-Agent that works for the local server.
    const CLOUD_USER_AGENT_PRESETS = {
        chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        vlc: 'VLC/3.0.20 LibVLC/3.0.20',
        tivimate: 'TiviMate/4.7.0'
    };

    function resolveCloudUserAgent() {
        try {
            const settings = { ...defaultSettings(), ...JSON.parse(localStorage.getItem('norva-cloud-settings') || '{}') };
            const preset = settings.userAgentPreset || '';
            if (preset === 'custom') return (settings.userAgentCustom || '').trim() || null;
            return CLOUD_USER_AGENT_PRESETS[preset] || null;
        } catch (_) {
            return null;
        }
    }

    function defaultSettings() {
        return {
            streamFormat: 'm3u8',
            forceProxy: false,
            forceTranscode: false,
            forceVideoTranscode: false,
            forceRemux: false,
            autoTranscode: false,
            upscaleEnabled: false,
            userAgentPreset: '',
            userAgentCustom: '',
            autoRefreshEnabled: true,
            autoRefreshIntervalHours: 24,
            autoPlayNextEpisode: true,
            groupDuplicates: true,
            duplicateStrategy: 'smart',
            preferredLanguage: '',
            preferredAudioLanguage: '',
            preferredSubtitleLanguage: '',
            strictLanguageMatching: false,
            preferredGenres: [],
            preferredQuality: 'highest'
        };
    }

    function hasUserSession() {
        return _hasCloudUserSession();
    }

    // Route by whether a USER account is signed in (expiry-agnostic), NOT by token freshness:
    // a logged-in user whose access token just lapsed must still hit the user endpoints (which
    // auto-refresh on 401), never the device endpoints (whose token is absent for that user).
    function cloudSourcesApi() {
        return _hasCloudUserAccount() ? NorvaCloud.sources : NorvaCloud.device.sources;
    }

    function cloudMediaApi() {
        return _hasCloudUserAccount() ? NorvaCloud.mediaItems : NorvaCloud.device.mediaItems;
    }

    function cloudLiveApi() {
        return _hasCloudUserAccount() ? NorvaCloud.live : NorvaCloud.device.live;
    }

    function cloudHomeApi() {
        return _hasCloudUserAccount() ? NorvaCloud.home : NorvaCloud.device.home;
    }

    function cloudPlaybackApi() {
        const api = hasUserSession() ? NorvaCloud.playback : NorvaCloud.device.playback;
        // Wrap createSession so a playback/capacity 402 — the soft wall hit at the
        // first play on the free browse tier — routes to the subscribe screen.
        // These calls bypass API.request, so they need their own guard.
        return Object.assign({}, api, {
            createSession: async (session) => {
                try {
                    return await api.createSession(session);
                } catch (error) {
                    if (window.NorvaCloud?.entitlements?.isSubscriptionError?.(error)) {
                        routeToSubscribeWall(error);
                    }
                    throw error;
                }
            }
        });
    }

    return {
        request,
        isCloudMode: _shouldUseCloud,
        hasUserSession,
        resolveSourceId,
        cloudSourcesApi,
        cloudMediaApi,
        cloudLiveApi,
        cloudHomeApi,
        cloudPlaybackApi,
        // Cache invalidators — exposed so the file-scope API.media wrappers can reach the
        // IIFE-internal caches (otherwise they'd throw a swallowed ReferenceError).
        clearMediaCaches,
        clearRailCache: () => { try { homeRailCache.clear(); } catch (_) { /* noop */ } },
        // A cheap, synchronous signature of the account's catalog state, used to version
        // the persistent first-screen cache: the max catalog_version across the loaded
        // sources (bumped server-side on each completed sync). A cache snapshot stamped
        // with an older signature is dropped rather than painted, so a re-synced catalog
        // never flashes pre-sync content on a cold load. Returns null when sources aren't
        // loaded yet (cache then falls back to its time-only TTL — no invalidation).
        catalogSignature: () => {
            try {
                if (!Array.isArray(sourcesCache) || !sourcesCache.length) return null;
                let max = 0;
                for (const s of sourcesCache) {
                    const v = Number(s?.catalog_version ?? s?.catalogVersion ?? 0);
                    if (Number.isFinite(v) && v > max) max = v;
                }
                return max || null;
            } catch (_) { return null; }
        }
    };
})();

// Soft wall: a subscription/capacity 402 routes the user to the in-app subscribe
// screen (start a trial / pick a plan) instead of failing silently or showing
// the generic access gate. Shared by API.request and the createSession wrapper.
function routeToSubscribeWall(error) {
    const details = error?.payload?.details || {};
    try {
        sessionStorage.setItem('norva-entitlement-denied', JSON.stringify({
            reason: details.entitlement?.reason || details.feature || 'subscription_required',
            status: details.entitlement?.status || '',
            message: details.entitlement?.message || error?.message || 'Norva access is required.'
        }));
    } catch (_) { /* sessionStorage may be unavailable */ }
    const returnTo = window.location.pathname + window.location.search + window.location.hash;
    window.location.replace('/subscribe.html?returnTo=' + encodeURIComponent(returnTo || '/'));
}

const API = {
    isCloudMode: () => _shouldUseCloud(),
    getMode: () => _shouldUseCloud() ? 'cloud' : 'local',

    // Resolve a (possibly local/provider) source id to the CLOUD source UUID — the id every
    // cloud edge route keys off. Mirrors what getStreamUrl does internally. Returns the input
    // unchanged when not in cloud mode or already a UUID.
    resolveCloudSourceId: (id) => (_shouldUseCloud() ? CloudAdapter.resolveSourceId(id) : Promise.resolve(id)),

    // Synchronous catalog signature (max catalog_version across loaded sources) used to
    // version the persistent first-screen cache; null outside cloud mode / before load.
    catalogSignature: () => (_shouldUseCloud() ? CloudAdapter.catalogSignature() : null),

    /**
     * Make API request
     */
    async request(method, endpoint, data = null) {
        if (_shouldUseCloud()) {
            try {
                return await CloudAdapter.request(method, endpoint, data);
            } catch (error) {
                if (window.NorvaCloud?.entitlements?.isSubscriptionError?.(error)) {
                    routeToSubscribeWall(error);
                }
                throw error;
            }
        }

        const options = {
            method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        // Add authentication token if available
        const token = localStorage.getItem('authToken');
        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }

        if (data) {
            options.body = JSON.stringify(data);
        }

        const response = await fetch(`${_hubBase()}/api${endpoint}`, options);

        let result;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            result = await response.json();
        } else {
            const text = await response.text();
            result = { error: text || 'API request failed' };
        }

        if (!response.ok) {
            // If unauthorized, redirect to login (absolute when using a remote hub)
            if (response.status === 401) {
                localStorage.removeItem('authToken');
                const hub = _hubBase();
                window.location.href = hub ? `${hub}/login.html` : '/login.html';
                return;
            }
            const message = result.details || result.message || result.error || `Server responded with ${response.status}`;
            const error = new Error(message);
            error.status = response.status;
            error.payload = result;
            error.code = result.code;
            error.upstreamStatus = result.upstreamStatus;
            error.terminal = Boolean(result.terminal);
            throw error;
        }

        return result;
    },

    // Sources
    sources: {
        getAll: () => API.request('GET', '/sources'),
        getByType: (type) => API.request('GET', `/sources/type/${type}`),
        getById: (id) => API.request('GET', `/sources/${id}`),
        create: (data) => API.request('POST', '/sources', data),
        update: (id, data) => API.request('PUT', `/sources/${id}`, data),
        delete: (id) => API.request('DELETE', `/sources/${id}`),
        toggle: (id) => API.request('POST', `/sources/${id}/toggle`),
        test: (id) => API.request('POST', `/sources/${id}/test`),
        sync: (id) => API.request('POST', `/sources/${id}/sync`), // Manual sync
        finalize: (id, params = {}) => API.request('POST', `/sources/${id}/finalize`, params), // Resume catalog finalization
        hardSync: (id) => API.request('POST', `/sources/${id}/hard-sync`), // Clear local content then sync
        getStatus: () => API.request('GET', '/sources/status'), // Get all statuses
        estimate: (id) => API.request('GET', `/sources/${id}/estimate`), // Estimate M3U size
        estimateByUrl: (url, type) => API.request('POST', '/sources/estimate', { url, type }), // Estimate by URL (before creation)
    },

    // Channels (hidden items)
    channels: {
        getHidden: (sourceId = null) => API.request('GET', `/channels/hidden${sourceId ? `?sourceId=${sourceId}` : ''}`),
        hide: (sourceId, itemType, itemId) => API.request('POST', '/channels/hide', { sourceId, itemType, itemId }),
        show: (sourceId, itemType, itemId) => API.request('POST', '/channels/show', { sourceId, itemType, itemId }),
        isHidden: (sourceId, itemType, itemId) => API.request('GET', `/channels/hidden/check?sourceId=${sourceId}&itemType=${itemType}&itemId=${itemId}`),
        bulkHide: (items) => API.request('POST', '/channels/hide/bulk', { items }),
        bulkShow: (items) => API.request('POST', '/channels/show/bulk', { items }),
        // Fast bulk operations - single SQL statement
        showAll: (sourceId, contentType) => API.request('POST', '/channels/show/all', { sourceId, contentType }),
        hideAll: (sourceId, contentType) => API.request('POST', '/channels/hide/all', { sourceId, contentType })
    },

    // Cloud/catalog browsing helpers
    media: {
        page: (params = {}) => {
            const search = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== '') search.set(key, value);
            });
            return API.request('GET', `/media/page${search.toString() ? `?${search.toString()}` : ''}`);
        },
        categories: (params = {}) => {
            const search = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== '') search.set(key, value);
            });
            return API.request('GET', `/media/categories${search.toString() ? `?${search.toString()}` : ''}`);
        },
        genreRails: (params = {}) => {
            const search = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== '') search.set(key, value);
            });
            return API.request('GET', `/media/genre-rails${search.toString() ? `?${search.toString()}` : ''}`);
        },
        genreItems: (params = {}) => {
            const search = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== '') search.set(key, value);
            });
            return API.request('GET', `/media/genre-items${search.toString() ? `?${search.toString()}` : ''}`);
        },
        genreSummary: (params = {}) => {
            const search = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== '') search.set(key, value);
            });
            return API.request('GET', `/media/genre-summary${search.toString() ? `?${search.toString()}` : ''}`);
        },
        // Audio/subtitle languages actually present in the catalogue (cloud-only;
        // drives the dynamic filter menus). Empty on failure so menus fall back.
        // Cached in localStorage for 60s — same as the server memo — so the menus
        // track the background language crawl in near-real-time while page hops
        // within the minute stay free. The grid filter itself stays exact, so a
        // momentarily-stale option is harmless.
        languageFacets: (params = {}) => {
            const type = params && params.type === 'series' ? 'series' : 'movie';
            // v2 key: the v1 cache could persist an EMPTY {audio:[],subtitles:[]} for 60s and serve
            // it before ever hitting the endpoint — so a one-time empty (e.g. while the catalogue
            // was still enriching) stuck the menus on "Any …" indefinitely. Bumping the key drops
            // every stale v1 entry on first load.
            const key = `norva-facets2-${type}`;
            const TTL = 60000; // 60s, aligned with the server-side facet memo
            const nonEmpty = (v) => v && ((Array.isArray(v.audio) && v.audio.length) || (Array.isArray(v.subtitles) && v.subtitles.length));
            try {
                const raw = localStorage.getItem(key);
                if (raw) {
                    const cached = JSON.parse(raw);
                    // Only trust a cached result that actually has options — never an empty one.
                    if (cached && cached.exp > Date.now() && nonEmpty(cached.value)) {
                        return Promise.resolve(cached.value);
                    }
                }
            } catch (_) { /* ignore parse/quota */ }
            let p;
            // NOTE: cloudHomeApi lives INSIDE the CloudAdapter IIFE — a bareword call here (file
            // scope) throws a ReferenceError that this try/catch silently swallows, which is exactly
            // why the Audio/Subtitle menus were always empty (the endpoint was never even reached).
            // Reach it through the exposed handle, like clearRailCache below.
            try { p = CloudAdapter.cloudHomeApi().languageFacets(params); }
            catch (_) { return Promise.resolve({ audio: [], subtitles: [] }); }
            return Promise.resolve(p).then((value) => {
                try {
                    // Cache ONLY a non-empty result. An empty set is treated as "not ready" so the
                    // next call re-fetches instead of serving a stale blank menu.
                    if (nonEmpty(value)) {
                        localStorage.setItem(key, JSON.stringify({ exp: Date.now() + TTL, value }));
                    }
                } catch (_) { /* ignore quota */ }
                return value;
            }).catch(() => ({ audio: [], subtitles: [] }));
        },
        // Best-effort capture of real audio-track languages observed at playback.
        reportObservedLanguages: (body) => {
            try { return CloudAdapter.cloudHomeApi().reportObservedLanguages(body); }
            catch (_) { return Promise.resolve({ ok: false }); }
        },
        // Drop the cached home/genre rails so a hidden-genre change shows on the
        // browse pages immediately instead of after the 2-min TTL.
        clearRailCache: () => CloudAdapter.clearRailCache(),
        // Drop all catalog caches (rails, pages, media, live) — used when the resolved
        // synopsis language changes so localized overviews refresh on the next view.
        clearCatalogCaches: () => CloudAdapter.clearMediaCaches()
    },

    // Playback health (auto-detected broken/working streams)
    playbackStatus: {
        getAll: (options = {}) => {
            const params = [];
            if (options.sourceId) params.push(`sourceId=${encodeURIComponent(options.sourceId)}`);
            if (options.itemType) params.push(`itemType=${encodeURIComponent(options.itemType)}`);
            if (options.includeOk) params.push('includeOk=true');
            if (options.includeModes) params.push('includeModes=true');
            return API.request('GET', `/playback-status${params.length ? `?${params.join('&')}` : ''}`);
        },
        report: (data) => API.request('POST', '/playback-status/report', data),
        scanLiveModes: (data = {}) => API.request('POST', '/playback-status/scan-live-modes', data),
        getLiveModeScan: (jobId, cursor = 0) =>
            API.request('GET', `/playback-status/scan-live-modes/${encodeURIComponent(jobId)}?cursor=${cursor}`)
    },

    // Favorites
    favorites: {
        getAll: (sourceId = null, itemType = null) => {
            let url = '/favorites';
            const params = [];
            if (sourceId) params.push(`sourceId=${sourceId}`);
            if (itemType) params.push(`itemType=${itemType}`);
            if (params.length) url += '?' + params.join('&');
            return API.request('GET', url);
        },
        add: (sourceId, itemId, itemType = 'channel', meta = null) =>
            API.request('POST', '/favorites', {
                sourceId, itemId, itemType,
                // Persist name + poster so the unified "My List" rail can render
                // directly from the favorite row (no per-item catalog lookup).
                ...(meta && meta.name ? { itemName: meta.name } : {}),
                ...(meta && (meta.poster || meta.type) ? { itemMeta: { poster: meta.poster || '', type: meta.type || itemType } } : {})
            }),
        remove: (sourceId, itemId, itemType = 'channel') =>
            API.request('DELETE', '/favorites', { sourceId, itemId, itemType }),
        check: (sourceId, itemId, itemType = 'channel') =>
            API.request('GET', `/favorites/check?sourceId=${sourceId}&itemId=${itemId}&itemType=${itemType}`)
    },

    // Proxy
    proxy: {
        // Xtream
        xtream: {
            auth: (sourceId) => API.request('GET', `/proxy/xtream/${sourceId}/auth`),
            liveCategories: (sourceId, options = {}) => {
                const params = options.includeHidden ? '?includeHidden=true' : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/live_categories${params}`);
            },
            liveStreams: (sourceId, categoryId = null, options = {}) => {
                const params = [];
                if (categoryId) params.push(`category_id=${categoryId}`);
                if (options.includeHidden) params.push('includeHidden=true');
                if (options.q) params.push(`q=${encodeURIComponent(options.q)}`);
                if (options.limit) params.push(`limit=${encodeURIComponent(options.limit)}`);
                if (options.offset) params.push(`offset=${encodeURIComponent(options.offset)}`);
                const query = params.length ? `?${params.join('&')}` : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/live_streams${query}`);
            },
            vodCategories: (sourceId, options = {}) => {
                const params = options.includeHidden ? '?includeHidden=true' : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/vod_categories${params}`);
            },
            vodStreams: (sourceId, categoryId = null, options = {}) => {
                const params = [];
                if (categoryId) params.push(`category_id=${categoryId}`);
                if (options.includeHidden) params.push('includeHidden=true');
                const query = params.length ? `?${params.join('&')}` : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/vod_streams${query}`);
            },
            seriesCategories: (sourceId, options = {}) => {
                const params = options.includeHidden ? '?includeHidden=true' : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/series_categories${params}`);
            },
            series: (sourceId, categoryId = null, options = {}) => {
                const params = [];
                if (categoryId) params.push(`category_id=${categoryId}`);
                if (options.includeHidden) params.push('includeHidden=true');
                const query = params.length ? `?${params.join('&')}` : '';
                return API.request('GET', `/proxy/xtream/${sourceId}/series${query}`);
            },
            // Series info (the episode list) is essential, but single-connection
            // providers 429 it with "user_multi_ip" when it collides with another
            // cloud request. Make it resilient: serve from a short cache, dedupe
            // concurrent calls (double-taps), and retry the transient 429 a couple
            // of times — the collision clears within a second or two.
            seriesInfo: (sourceId, seriesId) => {
                const key = `${sourceId}:${seriesId}`;
                const cache = (API._seriesInfoCache = API._seriesInfoCache || new Map());
                const cached = cache.get(key);
                if (cached && (Date.now() - cached.at < 10 * 60 * 1000)) return Promise.resolve(cached.data);
                const inflight = (API._seriesInfoInflight = API._seriesInfoInflight || new Map());
                if (inflight.has(key)) return inflight.get(key);
                const run = (async () => {
                    let lastErr;
                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            const data = await API.request('GET', `/proxy/xtream/${sourceId}/series_info?series_id=${seriesId}`);
                            cache.set(key, { at: Date.now(), data });
                            return data;
                        } catch (err) {
                            lastErr = err;
                            const transient = err?.status === 429 || /user_multi_ip|too many requests/i.test(String(err?.message || ''));
                            if (!transient || attempt === 2) break;
                            await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 600 : 1500));
                        }
                    }
                    throw lastErr;
                })();
                inflight.set(key, run);
                return run.finally(() => inflight.delete(key));
            },
            shortEpg: async (sourceId, streamId, limit = 8) => {
                // Single-connection providers refuse short-EPG ("user_multi_ip" /
                // 429) while a live stream holds their one connection. After the
                // first refusal, short-circuit per-source for a few minutes so we
                // don't spam the network tab with futile 429s — the XMLTV guide
                // still carries program info. Multi-connection providers never trip
                // this (they don't 429), so they keep getting short-EPG.
                const key = String(sourceId);
                const cooldown = (API._shortEpgCooldown = API._shortEpgCooldown || new Map());
                if (Date.now() < (cooldown.get(key) || 0)) {
                    const cooled = new Error('short-epg cooling down (provider single-connection)');
                    cooled.status = 429;
                    cooled.epgCooled = true;
                    throw cooled;
                }
                try {
                    return await API.request('GET', `/proxy/xtream/${sourceId}/short_epg?stream_id=${streamId}&limit=${encodeURIComponent(limit)}`);
                } catch (err) {
                    if (err?.status === 429 || /user_multi_ip|too many requests/i.test(String(err?.message || ''))) {
                        cooldown.set(key, Date.now() + 10 * 60 * 1000);
                    }
                    throw err;
                }
            },
            getStreamUrl: (sourceId, streamId, type = 'live', container = defaultProviderContainerForType(type), options = {}) => {
                const params = new URLSearchParams({ container });
                Object.entries(compactPlaybackHint(options)).forEach(([key, value]) => {
                    if (key === 'container') return;
                    params.set(key, value === true ? '1' : String(value));
                });
                return API.request('GET', `/proxy/xtream/${sourceId}/stream/${streamId}/${type}?${params.toString()}`);
            }
        },

        // EPG
        epg: {
            get: (sourceId, options = {}) => {
                const params = new URLSearchParams();
                Object.entries(options).forEach(([key, value]) => {
                    if (value !== undefined && value !== null && value !== '') params.set(key, value);
                });
                return API.request('GET', `/proxy/epg/${sourceId}${params.toString() ? `?${params.toString()}` : ''}`);
            },
            getForChannels: (sourceId, channelIds, options = {}) => {
                const params = new URLSearchParams();
                Object.entries(options).forEach(([key, value]) => {
                    if (value !== undefined && value !== null && value !== '') params.set(key, value);
                });
                return API.request('POST', `/proxy/epg/${sourceId}/channels${params.toString() ? `?${params.toString()}` : ''}`, { channelIds });
            }
        },

        // Cache management
        cache: {
            clear: (sourceId) => API.request('DELETE', `/proxy/cache/${sourceId}`)
        }
    },

    // Watch history
    history: {
        getAll: (limit = 200) => API.request('GET', `/history?limit=${limit}`),
        save: (data) => API.request('POST', '/history', data),
        remove: (itemId) => API.request('DELETE', `/history/${itemId}`)
    },

    // TMDB enrichment
    tmdb: {
        status: () => API.request('GET', '/tmdb/status'),
        enrich: () => API.request('POST', '/tmdb/enrich'),
        cancel: () => API.request('POST', '/tmdb/cancel'),
        reset: () => API.request('POST', '/tmdb/reset')
    },

    // Settings
    settings: {
        get: () => API.request('GET', '/settings'),
        update: (data) => API.request('PUT', '/settings', data),
        reset: () => API.request('DELETE', '/settings'),
        getDefaults: () => API.request('GET', '/settings/defaults'),
        getSyncStatus: () => API.request('GET', '/settings/sync-status')
    },

    // Norva Cloud link for the local hub
    cloud: {
        status: () => API.request('GET', '/cloud/status'),
        link: (data) => API.request('POST', '/cloud/link', data),
        unlink: () => API.request('POST', '/cloud/unlink')
    },

    // Users (admin only)
    users: {
        getAll: () => API.request('GET', '/auth/users'),
        create: (data) => API.request('POST', '/auth/users', data),
        update: (id, data) => API.request('PUT', `/auth/users/${id}`, data),
        delete: (id) => API.request('DELETE', `/auth/users/${id}`)
    }
};

// Make API available globally
window.API = API;
