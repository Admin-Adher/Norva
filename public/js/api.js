/**
 * API Client - Frontend API wrapper for Norva
 */

// When running from a remote host (e.g. Vercel web version), all API calls
// are proxied to the configured hub URL stored in localStorage.
function _hubBase() {
    const hub = localStorage.getItem('norva-hub-url');
    return hub ? hub.replace(/\/$/, '') : '';
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

const CloudAdapter = (() => {
    const SOURCE_ALIAS_KEY = 'norva-cloud-source-aliases';
    const PAGE_CACHE_TTL_MS = 120000;
    let sourcesCache = [];
    let mediaCache = new Map();
    let pageCache = new Map();
    let liveCatalogCache = new Map();

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
        return {
            ...source,
            id,
            cloudId,
            cloud_id: cloudId,
            source_type: type,
            type,
            name: source.display_name || source.displayName || source.name || 'Norva provider',
            url: config.serverHost || config.playlistHost || '',
            enabled: source.revoked !== true,
            sync_status: source.sync_status || source.syncStatus || 'idle',
            sync_error: source.sync_error || source.syncError || '',
            last_sync: source.last_synced_at || source.lastSyncedAt || null,
            cloud: true
        };
    }

    async function listSources() {
        const payload = await cloudSourcesApi().list();
        sourcesCache = (payload.sources || []).map(normalizeSource);
        return sourcesCache;
    }

    function clearMediaCaches() {
        mediaCache.clear();
        pageCache.clear();
        liveCatalogCache.clear();
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

    function normalizeMediaItem(item, sourceId) {
        const metadata = item.metadata || {};
        const playbackHint = item.playback_hint || item.playbackHint || {};
        const itemType = item.item_type || item.itemType || item.type;
        const id = String(item.external_id || item.externalId || item.item_id || item.id || '');
        const categoryId = String(item.parent_external_id || metadata.categoryId || metadata.group || 'uncategorized');
        const title = item.title || item.name || 'Norva';
        const poster = item.poster_url || item.posterUrl || item.cover || item.stream_icon || '';
        const container = playbackHint.container || metadata.container || (itemType === 'live' ? 'm3u8' : 'mp4');
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
        const cacheKey = JSON.stringify({ cloudSourceId, type, q: q || '' });
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

    async function getMediaPage({ sourceId, type, q, categoryId, limit = 50, offset = 0 } = {}) {
        const cloudSourceId = sourceId ? await resolveSourceId(sourceId) : '';
        const normalizedLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 50));
        const normalizedOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
        const cacheKey = JSON.stringify({
            cloudSourceId,
            type: type || '',
            q: q || '',
            categoryId: categoryId || '',
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

    async function getLiveLogicalCatalog({ sourceId, categoryId, country = 'FR', q = '', limit = '', offset = '', includeVariants = true } = {}) {
        const cloudSourceId = sourceId ? await resolveSourceId(sourceId) : '';
        const cacheKey = JSON.stringify({
            cloudSourceId,
            categoryId: categoryId || '',
            country,
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

    async function listLiveLogicalCategories({ sourceId, country = 'FR' } = {}) {
        const payload = await getLiveLogicalCatalog({ sourceId, country, includeVariants: false });
        return (payload.groups || []).map(group => ({
            category_id: String(group.category_id || group.id || 'uncategorized'),
            category_name: group.category_name || group.name || 'Uncategorized',
            name: group.category_name || group.name || 'Uncategorized',
            sourceId
        }));
    }

    async function listLiveLogicalChannels({ sourceId, categoryId, country = 'FR', q = '', limit = '', offset = '' } = {}) {
        const payload = await getLiveLogicalCatalog({ sourceId, categoryId, country, q, limit, offset, includeVariants: true });
        return (payload.channels || []).map(channel => normalizeLogicalLiveChannel(channel, sourceId));
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
        const defaultVariant = variants.find(variant => String(variant.streamId) === defaultStreamId)
            || variants.find(variant => variant.rank >= 1)
            || variants[0]
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
            container: variant.container_extension || variant.container || 'm3u8'
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
            container_extension: item.container_extension || item.containerExtension || (type === 'channel' ? 'm3u8' : 'mp4'),
            data: {
                title: item.name || item.title || 'Norva',
                subtitle: item.category_name || item.subtitle || (type === 'movie' ? 'Movie' : type === 'series' ? 'Series' : 'Live TV'),
                poster,
                sourceId: item.sourceId || item.source_id,
                containerExtension: item.container_extension || item.containerExtension || (type === 'channel' ? 'm3u8' : 'mp4')
            }
        };
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

    async function sourcePayloadFromLocal(data) {
        const type = data.type || data.sourceType || data.source_type || 'xtream';
        const payload = {
            sourceType: type,
            displayName: data.name || data.displayName || data.display_name || (type === 'm3u' ? 'M3U provider' : 'Xtream provider'),
            syncNow: data.syncNow !== false
        };

        if (type === 'xtream') {
            payload.url = data.url || data.serverUrl || data.server_url;
            payload.username = data.username;
            payload.password = data.password;
        } else if (type === 'm3u') {
            payload.url = data.url || data.playlistUrl || data.playlist_url;
        }

        return payload;
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
            const patch = {};
            if (data?.name || data?.displayName) patch.displayName = data.name || data.displayName;
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
            const payload = await NorvaCloud.sources.sync(await resolveSourceId(parts[2]));
            clearMediaCaches();
            return normalizeSource(payload.source || {});
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
            if (action === 'short_epg') return { epg_listings: [] };
            if (action === 'stream' && streamId) {
                const type = query.get('type') || xtreamMatch[4] || 'live';
                const isVodPlayback = type === 'movie' || type === 'series';
                const requestedContainer = query.get('container') || (type === 'live' ? 'm3u8' : 'mp4');
                const container = (isVodPlayback && (!requestedContainer || requestedContainer === 'm3u8'))
                    ? 'mp4'
                    : requestedContainer;
                const requestedCloudMode = localStorage.getItem('norva-cloud-playback-mode') || '';
                const forcedMode = query.get('mode') || '';
                const preferredMode = forcedMode || (isVodPlayback ? 'transcode' : (requestedCloudMode || 'relay'));
                const needsGateway = requiresGatewayForContainer(type, container);
                const mode = forcedMode || (((isVodPlayback || needsGateway) && preferredMode !== 'direct') ? 'transcode' : preferredMode);
                const cloudSourceId = await resolveSourceId(sourceId);
                const userAgent = resolveCloudUserAgent();
                const baseSession = {
                    sourceId: cloudSourceId,
                    itemType: type === 'series' ? 'series' : type === 'movie' ? 'movie' : 'live',
                    itemId: streamId,
                    playbackHint: { container },
                    corsSafe: false,
                    ...(userAgent ? { userAgent } : {})
                };
                let payload;
                try {
                    payload = await cloudPlaybackApi().createSession({
                        ...baseSession,
                        mode,
                        requiresRelay: mode === 'relay',
                        requiresTranscode: mode === 'transcode'
                    });
                    if (mode === 'transcode' && !payload.playback?.url && preferredMode !== 'direct') {
                        payload = await cloudPlaybackApi().createSession({
                            ...baseSession,
                            mode: 'relay',
                            requiresRelay: true
                        });
                    }
                } catch (error) {
                    if (mode === 'direct') throw error;
                    if (mode === 'transcode' && preferredMode !== 'direct') {
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
                const url = payload.playback?.url || payload.url;
                return {
                    ...payload,
                    url,
                    streamUrl: url,
                    playbackUrl: url,
                    cloud: true,
                    mode: payload.playback?.mode || mode,
                    sessionId: payload.session?.id
                };
            }
        }

        if (method === 'GET' && path.startsWith('/proxy/epg/')) return {};
        if (method === 'POST' && path.includes('/proxy/epg/')) return {};
        if (method === 'DELETE' && path.startsWith('/proxy/cache/')) return { success: true };

        if (path.startsWith('/favorites')) return handleFavorites(method, path, query, data);
        if (path.startsWith('/history')) return handleHistory(method, path, query, data);

        if (path.startsWith('/channels/hidden')) {
            if (method === 'GET') return path.endsWith('/check') ? { hidden: false } : [];
            return { success: true };
        }
        if (method === 'GET' && path === '/channels/recent') {
            const requestedType = query.get('type') || 'movie';
            const limit = Math.max(1, Math.min(50, Number.parseInt(query.get('limit') || '12', 10) || 12));
            const type = cloudTypeFromLocal(requestedType);
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
            autoPlayNextEpisode: true,
            groupDuplicates: true,
            duplicateStrategy: 'smart'
        };
    }

    function hasUserSession() {
        return _hasCloudUserSession();
    }

    function cloudSourcesApi() {
        return hasUserSession() ? NorvaCloud.sources : NorvaCloud.device.sources;
    }

    function cloudMediaApi() {
        return hasUserSession() ? NorvaCloud.mediaItems : NorvaCloud.device.mediaItems;
    }

    function cloudLiveApi() {
        return hasUserSession() ? NorvaCloud.live : NorvaCloud.device.live;
    }

    function cloudPlaybackApi() {
        return hasUserSession() ? NorvaCloud.playback : NorvaCloud.device.playback;
    }

    return {
        request,
        isCloudMode: _shouldUseCloud,
        hasUserSession,
        cloudSourcesApi,
        cloudMediaApi,
        cloudLiveApi,
        cloudPlaybackApi
    };
})();

const API = {
    isCloudMode: () => _shouldUseCloud(),
    getMode: () => _shouldUseCloud() ? 'cloud' : 'local',

    /**
     * Make API request
     */
    async request(method, endpoint, data = null) {
        if (_shouldUseCloud()) {
            return CloudAdapter.request(method, endpoint, data);
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
        }
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
        add: (sourceId, itemId, itemType = 'channel') =>
            API.request('POST', '/favorites', { sourceId, itemId, itemType }),
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
            seriesInfo: (sourceId, seriesId) =>
                API.request('GET', `/proxy/xtream/${sourceId}/series_info?series_id=${seriesId}`),
            shortEpg: (sourceId, streamId) => API.request('GET', `/proxy/xtream/${sourceId}/short_epg?stream_id=${streamId}`),
            getStreamUrl: (sourceId, streamId, type = 'live', container = 'm3u8', options = {}) => {
                const params = new URLSearchParams({ container });
                if (options.mode) params.set('mode', options.mode);
                return API.request('GET', `/proxy/xtream/${sourceId}/stream/${streamId}/${type}?${params.toString()}`);
            }
        },

        // EPG
        epg: {
            get: (sourceId) => API.request('GET', `/proxy/epg/${sourceId}`),
            getForChannels: (sourceId, channelIds) => API.request('POST', `/proxy/epg/${sourceId}/channels`, { channelIds })
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
        getDefaults: () => API.request('GET', '/settings/defaults')
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
