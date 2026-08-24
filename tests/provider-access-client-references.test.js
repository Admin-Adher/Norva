'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function createStorage(initial = {}) {
    const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
    return {
        get length() { return values.size; },
        key(index) { return [...values.keys()][index] ?? null; },
        getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
        setItem(key, value) { values.set(String(key), String(value)); },
        removeItem(key) { values.delete(String(key)); },
        clear() { values.clear(); },
        dump() { return Object.fromEntries([...values.entries()].sort(([a], [b]) => a.localeCompare(b))); }
    };
}

function loadApi({
    local = {},
    session = {},
    sourcesPayload = { sources: [] },
    initialEpoch = '',
    languageFacetsPayload = { audio: ['fr'], subtitles: [] }
} = {}) {
    const localStorage = createStorage({
        'norva-cloud-session': JSON.stringify({ access_token: 'token', user: { id: 'account-a' } }),
        ...local
    });
    const sessionStorage = createStorage(session);
    const invalidations = [];
    let epoch = String(initialEpoch || '');
    const cloud = {
        catalogVisibility: {
            epoch: () => epoch || null,
            invalidate: (next) => {
                if (next !== undefined && next !== null && next !== '') epoch = String(next);
                invalidations.push(epoch || null);
                return epoch || null;
            }
        },
        sources: {
            list: async () => sourcesPayload
        },
        device: {
            sources: { list: async () => sourcesPayload },
            mediaItems: {},
            live: {},
            home: { languageFacets: async () => languageFacetsPayload },
            playback: {},
            favorites: {},
            history: {}
        },
        mediaItems: {},
        live: {},
        home: { languageFacets: async () => languageFacetsPayload },
        playback: {},
        favorites: {},
        history: {},
        profiles: { getActiveId: () => 'default' }
    };
    const window = {
        NorvaCloud: cloud,
        location: {
            hostname: 'app.norva.tv',
            origin: 'https://app.norva.tv',
            pathname: '/app.html',
            search: '',
            hash: '#home',
            replace() {}
        },
        matchMedia: () => ({ matches: false }),
        innerWidth: 1280
    };
    const factory = new Function(
        'window',
        'NorvaCloud',
        'localStorage',
        'sessionStorage',
        'navigator',
        'fetch',
        'URLSearchParams',
        'indexedDB',
        'document',
        'setTimeout',
        'clearTimeout',
        'console',
        `${read('public/js/api.js')}\nreturn window.API;`
    );
    const API = factory(
        window,
        cloud,
        localStorage,
        sessionStorage,
        { userAgent: 'node-test' },
        async () => { throw new Error('unexpected network request'); },
        URLSearchParams,
        undefined,
        {},
        setTimeout,
        clearTimeout,
        console
    );
    return { API, localStorage, sessionStorage, invalidations, window };
}

test('cloud source normalization preserves the authoritative enabled bit and epochs persistent signatures', async () => {
    const { API, localStorage } = loadApi({
        initialEpoch: '17',
        sourcesPayload: {
            visibilityEpoch: '17',
            sources: [
                {
                    id: '11111111-1111-4111-8111-111111111111',
                    display_name: 'Paused provider',
                    enabled: false,
                    revoked: false,
                    config_hint: { serverHost: 'provider.example', username: 'must-not-leak', hasPassword: true },
                    catalog_version: 4
                },
                {
                    id: '22222222-2222-4222-8222-222222222222',
                    display_name: 'Enabled provider',
                    enabled: true,
                    revoked: true,
                    catalog_version: 5
                },
                {
                    id: '33333333-3333-4333-8333-333333333333',
                    display_name: 'Legacy revoked provider',
                    revoked: true,
                    catalog_version: 6
                },
                {
                    id: '44444444-4444-4444-8444-444444444444',
                    display_name: 'Provider-hidden catalog',
                    enabled: true,
                    catalog_visible: false,
                    catalog_version: 7
                }
            ]
        }
    });

    const sources = await API.sources.getAll();

    assert.equal(sources.length, 4);
    assert.equal(sources[0].enabled, false);
    assert.equal(sources[0].username, '');
    assert.equal(sources[1].enabled, true);
    assert.equal(sources[2].enabled, false);
    assert.equal(sources[3].managementEnabled, true);
    assert.equal(sources[3].catalogVisible, false);
    assert.equal(sources[3].enabled, false);
    assert.equal(API.catalogSignature(), 'catalog:7|visibility:17');

    await API.media.languageFacets({ type: 'movie' });
    assert.notEqual(localStorage.getItem('norva-facets4-user-account-a-movie-all-visibility-17'), null);
});

test('replaceSourceReferences keeps the local alias stable and fails safe for provider-scoped state', async () => {
    const oldId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const newId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const { API, localStorage, sessionStorage, invalidations } = loadApi({
        local: {
            'norva-cloud-source-aliases': JSON.stringify({ [oldId]: 900001, [newId]: 900002 }),
            'norva-filters-v2-user-account-a-movies': JSON.stringify({ source: '900001', categories: ['provider-a-action'], audio: 'fr' }),
            'norva-filters-v2-user-account-a-series': JSON.stringify({ source: '900099', categories: ['provider-c-drama'], subtitle: 'fr' }),
            'norva-filters-series': JSON.stringify({ source: '900002', categories: ['staging-drama'], subtitle: 'en' }),
            'norva-recent-channels': JSON.stringify([
                { id: 'old-channel', sourceId: 900001 },
                { id: 'staging-channel', sourceId: 900002 },
                { id: 'other-channel', sourceId: 900099 }
            ]),
            'norva_last_live_channel_v1': JSON.stringify({ id: 'old-channel', sourceId: 900001 }),
            'norva.series.versionChoice': JSON.stringify({ old: { sourceId: 900001, series_id: '7' }, other: { sourceId: 900099, series_id: '9' } }),
            'norva-resume-pos-v1': JSON.stringify({ '900001:movie-1::': { position: 42 }, '900099:movie-2::': { position: 12 } }),
            'norva-cloud-blocked-sources-v1': JSON.stringify({ [oldId]: 1, 900001: 2, untouched: 3 }),
            'norva-live-blocked-sources-v1': JSON.stringify({ [newId]: 1, 900002: 2, untouched: 3 }),
            'norva-subtitle-offset:900001:movie-1:0': '1.2',
            'norva-facets4-user-account-a-movie-900001': JSON.stringify({ value: { audio: ['fr'] } }),
            'norva-cc:account-a:movies:first': JSON.stringify({ at: Date.now(), data: [{ id: 'old' }] }),
            'unrelated-preference': 'keep-me'
        },
        session: {
            'norva-watch-resume-v1': JSON.stringify({ version: 1, content: { id: 'movie-1', sourceId: 900001 } }),
            'norva-watch-error-refresh-v1': JSON.stringify({ key: '900001:movie:movie-1', at: Date.now() })
        }
    });

    const first = await API.replaceSourceReferences(oldId, newId, '42');

    assert.equal(first.remapped, true);
    assert.equal(first.localSourceId, '900001');
    assert.equal(first.visibilityEpoch, '42');
    assert.deepEqual(JSON.parse(localStorage.getItem('norva-cloud-source-aliases')), { [newId]: 900001 });
    assert.deepEqual(
        JSON.parse(localStorage.getItem('norva-filters-v2-user-account-a-movies')),
        { source: '900001', categories: [], audio: 'fr' }
    );
    assert.deepEqual(
        JSON.parse(localStorage.getItem('norva-filters-v2-user-account-a-series')),
        { source: '900099', categories: ['provider-c-drama'], subtitle: 'fr' }
    );
    assert.deepEqual(
        JSON.parse(localStorage.getItem('norva-filters-series')),
        { source: '900001', categories: [], subtitle: 'en' }
    );
    assert.deepEqual(JSON.parse(localStorage.getItem('norva-recent-channels')), [{ id: 'other-channel', sourceId: 900099 }]);
    assert.equal(localStorage.getItem('norva_last_live_channel_v1'), null);
    assert.deepEqual(JSON.parse(localStorage.getItem('norva.series.versionChoice')), { other: { sourceId: 900099, series_id: '9' } });
    assert.deepEqual(JSON.parse(localStorage.getItem('norva-resume-pos-v1')), { '900099:movie-2::': { position: 12 } });
    assert.deepEqual(JSON.parse(localStorage.getItem('norva-cloud-blocked-sources-v1')), { untouched: 3 });
    assert.deepEqual(JSON.parse(localStorage.getItem('norva-live-blocked-sources-v1')), { untouched: 3 });
    assert.equal(localStorage.getItem('norva-subtitle-offset:900001:movie-1:0'), null);
    assert.equal(localStorage.getItem('norva-facets4-user-account-a-movie-900001'), null);
    assert.equal(localStorage.getItem('norva-cc:account-a:movies:first'), null);
    assert.equal(localStorage.getItem('unrelated-preference'), 'keep-me');
    assert.equal(sessionStorage.getItem('norva-watch-resume-v1'), null);
    assert.equal(sessionStorage.getItem('norva-watch-error-refresh-v1'), null);
    assert.deepEqual(invalidations, ['42']);

    localStorage.setItem('norva-recent-channels', JSON.stringify([
        { id: 'other-channel', sourceId: 900099 },
        { id: 'new-provider-channel', sourceId: 900001 }
    ]));
    localStorage.setItem('norva-resume-pos-v1', JSON.stringify({
        '900099:movie-2::': { position: 12 },
        '900001:new-provider-movie::': { position: 24 }
    }));
    const afterFirst = localStorage.dump();
    const afterFirstSession = sessionStorage.dump();
    const second = await API.replaceSourceReferences(oldId, newId, '42');
    assert.equal(second.remapped, true);
    assert.deepEqual(localStorage.dump(), afterFirst);
    assert.deepEqual(sessionStorage.dump(), afterFirstSession);

    const retryByTransferredAlias = await API.replaceSourceReferences(900001, newId, '42');
    assert.equal(retryByTransferredAlias.remapped, true);
    assert.deepEqual(localStorage.dump(), afterFirst);
    assert.deepEqual(sessionStorage.dump(), afterFirstSession);
});

test('replaceSourceReferences clears selected and playable references when no exact target exists', async () => {
    const oldId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const { API, localStorage, sessionStorage } = loadApi({
        local: {
            'norva-cloud-source-aliases': JSON.stringify({ [oldId]: 900010 }),
            'norva-filters-v2-user-account-a-series': JSON.stringify({ source: '900010', categories: ['old-category'], subtitle: 'fr' }),
            'norva-recent-channels': JSON.stringify([{ id: 'old-channel', sourceId: 900010 }]),
            'norva_last_live_channel_v1': JSON.stringify({ id: 'old-channel', sourceId: 900010 })
        },
        session: {
            'norva-watch-resume-v1': JSON.stringify({ version: 1, content: { id: 'series-1', sourceId: 900010 } })
        }
    });

    const result = await API.replaceSourceReferences(oldId, null, '43');

    assert.equal(result.remapped, false);
    assert.deepEqual(JSON.parse(localStorage.getItem('norva-cloud-source-aliases')), {});
    assert.deepEqual(
        JSON.parse(localStorage.getItem('norva-filters-v2-user-account-a-series')),
        { source: '', categories: [], subtitle: 'fr' }
    );
    assert.deepEqual(JSON.parse(localStorage.getItem('norva-recent-channels')), []);
    assert.equal(localStorage.getItem('norva_last_live_channel_v1'), null);
    assert.equal(sessionStorage.getItem('norva-watch-resume-v1'), null);
});

function response(payload, headers = {}, status = 200) {
    const normalizedHeaders = Object.fromEntries(Object.entries({
        'content-type': 'application/json',
        ...headers
    }).map(([key, value]) => [key.toLowerCase(), value]));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (key) => normalizedHeaders[String(key).toLowerCase()] || null },
        json: async () => payload,
        text: async () => JSON.stringify(payload)
    };
}

function loadCloudApi(fetch, local = {}) {
    const localStorage = createStorage(local);
    const window = {
        location: { origin: 'https://app.norva.tv', hostname: 'app.norva.tv' },
        matchMedia: () => ({ matches: false }),
        innerWidth: 1280
    };
    const factory = new Function(
        'window',
        'localStorage',
        'navigator',
        'fetch',
        'performance',
        'URLSearchParams',
        'document',
        'setTimeout',
        'clearTimeout',
        'console',
        `${read('public/js/cloudApi.js')}\nreturn window.NorvaCloud;`
    );
    return factory(
        window,
        localStorage,
        { userAgent: 'node-test' },
        fetch,
        { now: () => 0 },
        URLSearchParams,
        { readyState: 'loading', addEventListener() {} },
        setTimeout,
        clearTimeout,
        console
    );
}

test('paired series-info fallback keeps the device route and device bearer', async () => {
    const requests = [];
    const cloud = loadCloudApi(async (url, init = {}) => {
        const parsed = new URL(String(url));
        requests.push({ pathname: parsed.pathname, search: parsed.search, authorization: init.headers?.Authorization });
        if (parsed.pathname.includes('/norva-series-info/')) {
            return response({ error: 'rolling deployment' }, {}, 404);
        }
        if (parsed.pathname.includes('/norva-cloud/device/sources/')) {
            return response({ episodes: {} });
        }
        throw new Error(`unexpected request: ${url}`);
    }, { 'norva-cloud-device-token': 'device-token' });

    await cloud.device.sources.seriesInfo('source/id', 'series id');

    assert.equal(requests.length, 2);
    assert.match(requests[0].pathname, /\/norva-series-info\/sources\/source%2Fid\/series-info$/);
    assert.match(requests[1].pathname, /\/norva-cloud\/device\/sources\/source%2Fid\/series-info$/);
    assert.equal(requests[0].search, '?series_id=series%20id');
    assert.equal(requests[1].search, '?series_id=series%20id');
    assert.equal(requests[0].authorization, 'Bearer device-token');
    assert.equal(requests[1].authorization, 'Bearer device-token');
});

test('cloud GET caches are visibility-epoch scoped and invalidate when a response advances the epoch', async () => {
    let serverEpoch = '7';
    let sourceFetches = 0;
    let healthFetches = 0;
    const cloud = loadCloudApi(async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname.endsWith('/sources')) {
            sourceFetches += 1;
            return response({ sources: [], visibility_epoch: serverEpoch });
        }
        if (pathname.endsWith('/health')) {
            healthFetches += 1;
            serverEpoch = healthFetches === 1 ? '8' : '6';
            return response({ ok: true }, { 'x-norva-visibility-epoch': serverEpoch });
        }
        throw new Error(`unexpected request: ${url}`);
    });

    await cloud.sources.list();
    await cloud.sources.list();
    assert.equal(sourceFetches, 1);
    assert.equal(cloud.catalogVisibility.epoch(), '7');

    await cloud.health();
    assert.equal(cloud.catalogVisibility.epoch(), '8');
    await cloud.sources.list();
    assert.equal(sourceFetches, 2);

    await cloud.health();
    assert.equal(cloud.catalogVisibility.epoch(), '8');
    await cloud.sources.list();
    assert.equal(sourceFetches, 2);
});

test('a v2 cache token is monotone and cannot be downgraded by a rolling v1 endpoint', async () => {
    const epochs = ['9', 'v2.3.9', '10', 'v2.2.99', 'v2.4.10'];
    let requestIndex = 0;
    const cloud = loadCloudApi(async () => response(
        { ok: true },
        { 'x-norva-visibility-epoch': epochs[requestIndex++] }
    ));

    await cloud.health();
    assert.equal(cloud.catalogVisibility.epoch(), '9');
    await cloud.health();
    assert.equal(cloud.catalogVisibility.epoch(), 'v2.3.9');

    await cloud.health();
    assert.equal(cloud.catalogVisibility.epoch(), 'v2.3.9', 'numeric v1 cannot replace v2');
    await cloud.health();
    assert.equal(cloud.catalogVisibility.epoch(), 'v2.3.9', 'an older global component cannot replace v2');

    await cloud.health();
    assert.equal(cloud.catalogVisibility.epoch(), 'v2.4.10');
});

test('Live IndexedDB entries and multi-page hydration are fenced by one exact v2 token', () => {
    const cloudApi = read('public/js/cloudApi.js');
    const api = read('public/js/api.js');
    const channelList = read('public/js/components/ChannelList.js');

    assert.match(cloudApi, /epochFor: \(payload\) => visibilityEpochFromPayload\(payload\) \|\| null/);
    assert.match(api, /Object\.defineProperty\(value, '_norvaVisibilityEpoch'/);
    assert.match(api, /catalogVisibilityEpoch: \(\) => \(_shouldUseCloud\(\) \? CloudAdapter\.visibilityEpoch\(\) : null\)/);
    assert.match(channelList, /entry\?\.visibilityEpoch === visibilityEpoch/);
    assert.match(channelList, /visibilityEpoch: expectedVisibilityEpoch/);
    assert.match(channelList, /this\.liveCatalogVisibilityEpoch\(streams\) !== expectedVisibilityEpoch/);
    assert.match(channelList, /this\.liveCatalogVisibilityEpoch\(streams\) !== visibilityEpoch/);
    assert.match(channelList, /writeLiveCatalogCache\(sourceId, 'xtream', loadRunId, visibilityEpoch\)/);
    assert.match(channelList, /writeLiveCatalogCache\(sourceId, 'm3u', loadRunId, visibilityEpoch\)/);
});

test('authenticated GETs version the browser-cache URL and retry an older epoch fail-closed', async () => {
    const requests = [];
    let sourceFetches = 0;
    const cloud = loadCloudApi(async (url, init = {}) => {
        requests.push({ url: String(url), cache: init.cache || null });
        sourceFetches += 1;
        if (sourceFetches === 1) {
            return response({ sources: [] }, { 'x-norva-visibility-epoch': '7' });
        }
        if (sourceFetches === 2) {
            // Simulate a previously fresh private-cache entry racing a promotion.
            return response({ sources: [{ id: 'source-a' }] }, { 'x-norva-visibility-epoch': '7' });
        }
        return response({ sources: [{ id: 'source-b' }] }, { 'x-norva-visibility-epoch': '8' });
    });
    cloud.setToken('user-token');

    await cloud.sources.list();
    assert.equal(requests[0].cache, 'no-store');
    assert.equal(new URL(requests[0].url).searchParams.has('__norva_visibility_epoch'), false);

    cloud.catalogVisibility.invalidate('8');
    const payload = await cloud.sources.list();

    assert.deepEqual(payload.sources, [{ id: 'source-b' }]);
    assert.equal(sourceFetches, 3);
    assert.equal(new URL(requests[1].url).searchParams.get('__norva_visibility_epoch'), '8');
    assert.equal(new URL(requests[2].url).searchParams.get('__norva_visibility_epoch'), '8');
    assert.equal(requests[2].cache, 'no-store');
    assert.equal(cloud.catalogVisibility.epoch(), '8');
});

test('authenticated GET retries once when the server discards a body built across a cutover', async () => {
    const requests = [];
    const cloud = loadCloudApi(async (url, init = {}) => {
        requests.push({ url: String(url), cache: init.cache || null });
        if (requests.length === 1) {
            return response({
                error: 'Catalog visibility changed while the response was being prepared',
                details: { code: 'CATALOG_VISIBILITY_EPOCH_CHANGED' }
            }, {
                'x-norva-visibility-epoch': '9',
                'retry-after': '0'
            }, 409);
        }
        return response({ sources: [{ id: 'source-b' }] }, {
            'x-norva-visibility-epoch': '9'
        });
    });
    cloud.setToken('user-token');

    const payload = await cloud.sources.list();

    assert.deepEqual(payload.sources, [{ id: 'source-b' }]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].cache, 'no-store');
    assert.equal(new URL(requests[1].url).searchParams.get('__norva_visibility_epoch'), '9');
    assert.equal(requests[1].cache, 'no-store');
    assert.equal(cloud.catalogVisibility.epoch(), '9');
});

test('catalog GETs always bypass the browser HTTP cache after the visibility epoch is known', async () => {
    const requests = [];
    let serverEpoch = '11';
    const cloud = loadCloudApi(async (url, init = {}) => {
        requests.push({ url: String(url), cache: init.cache || null });
        return response({ items: [] }, { 'x-norva-visibility-epoch': serverEpoch });
    });
    cloud.setToken('user-token');
    cloud.setDeviceToken('device-token');

    await cloud.mediaItems.list({ type: 'movie' });
    assert.equal(cloud.catalogVisibility.epoch(), '11');

    // Simulate a cutover completed by another device while this tab was idle.
    // The request still reaches the server even though its URL carries epoch 11,
    // allowing this process to observe epoch 12 instead of serving stale bytes.
    serverEpoch = '12';
    await cloud.mediaItems.list({ type: 'movie' });
    await cloud.device.mediaItems.list({ type: 'movie' });

    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((request) => request.cache), ['no-store', 'no-store', 'no-store']);
    assert.equal(new URL(requests[1].url).searchParams.get('__norva_visibility_epoch'), '11');
    assert.equal(new URL(requests[2].url).searchParams.get('__norva_visibility_epoch'), '12');
    assert.equal(cloud.catalogVisibility.epoch(), '12');
});
