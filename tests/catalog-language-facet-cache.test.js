'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const API_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/api.js'), 'utf8');

function createStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(String(key), String(value)),
        removeItem: (key) => values.delete(key),
        key: (index) => [...values.keys()][index] ?? null,
        get length() { return values.size; }
    };
}

function session(userId) {
    return JSON.stringify({
        access_token: `token-${userId}`,
        user: { id: userId }
    });
}

function loadApi(
    storage,
    languageFacets,
    reportObservedLanguages = async () => ({ ok: true, updated: false, exact: true }),
    emittedEvents = []
) {
    class TestCustomEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        }
    }
    const NorvaCloud = {
        home: { languageFacets, reportObservedLanguages },
        device: {
            home: { languageFacets, reportObservedLanguages },
            sources: {},
            mediaItems: {},
            live: {},
            playback: {}
        },
        sources: {},
        mediaItems: {},
        live: {},
        playback: {},
        deviceToken: ''
    };
    const window = {
        NorvaCloud,
        location: {
            hostname: 'norva.tv',
            origin: 'https://norva.tv',
            pathname: '/app',
            search: '',
            hash: '#movies',
            replace: () => {}
        },
        matchMedia: () => ({ matches: false }),
        CustomEvent: TestCustomEvent,
        dispatchEvent: (event) => {
            emittedEvents.push(event);
            return true;
        }
    };
    const context = {
        window,
        NorvaCloud,
        localStorage: storage,
        navigator: { userAgent: 'node-test' },
        URL,
        URLSearchParams,
        fetch: async () => { throw new Error('unexpected fetch'); },
        AbortController,
        Headers,
        CustomEvent: TestCustomEvent,
        console,
        setTimeout,
        clearTimeout
    };
    vm.runInNewContext(API_SOURCE, context, { filename: 'public/js/api.js' });
    return context.window.API;
}

test('language facet cache is isolated by signed-in account and media type', async () => {
    const storage = createStorage({
        'norva-cloud-session': session('account-a')
    });
    let requests = 0;
    const API = loadApi(storage, async ({ type }) => {
        requests += 1;
        const active = JSON.parse(storage.getItem('norva-cloud-session')).user.id;
        return {
            audio: [{ value: active, label: `${active}-${type}` }],
            subtitles: []
        };
    });

    const seriesA = await API.media.languageFacets({ type: 'series' });
    assert.equal(seriesA.audio[0].value, 'account-a');
    assert.equal(requests, 1);

    // A second account in the same browser must miss account A's local cache.
    storage.setItem('norva-cloud-session', session('account-b'));
    const seriesB = await API.media.languageFacets({ type: 'series' });
    assert.equal(seriesB.audio[0].value, 'account-b');
    assert.equal(requests, 2);

    // Movie/Series remain separate inside the same account.
    const movieB = await API.media.languageFacets({ type: 'movie' });
    assert.equal(movieB.audio[0].label, 'account-b-movie');
    assert.equal(requests, 3);

    // Returning to account A reuses only account A's Series cache.
    storage.setItem('norva-cloud-session', session('account-a'));
    const seriesAAgain = await API.media.languageFacets({ type: 'series' });
    assert.equal(seriesAAgain.audio[0].value, 'account-a');
    assert.equal(requests, 3);

    const keys = [...storage.values.keys()].filter((key) => key.startsWith('norva-facets'));
    assert.deepEqual(keys.sort(), [
        'norva-facets4-user-account-a-series-all',
        'norva-facets4-user-account-b-movie-all',
        'norva-facets4-user-account-b-series-all'
    ]);
});

test('language facet cache is isolated by selected provider', async () => {
    const storage = createStorage({
        'norva-cloud-session': session('account-a')
    });
    let requests = 0;
    const API = loadApi(storage, async ({ source }) => {
        requests += 1;
        return {
            audio: [{ value: source, label: source }],
            subtitles: []
        };
    });

    const atlas = await API.media.languageFacets({ type: 'series', source: 'provider-atlas' });
    const ferran = await API.media.languageFacets({ type: 'series', source: 'provider-ferran' });
    const atlasAgain = await API.media.languageFacets({ type: 'series', source: 'provider-atlas' });

    assert.equal(atlas.audio[0].value, 'provider-atlas');
    assert.equal(ferran.audio[0].value, 'provider-ferran');
    assert.equal(atlasAgain.audio[0].value, 'provider-atlas');
    assert.equal(requests, 2);
    assert.deepEqual(
        [...storage.values.keys()]
            .filter((key) => key.startsWith('norva-facets4-user-account-a-series-'))
            .sort(),
        [
            'norva-facets4-user-account-a-series-provider-atlas',
            'norva-facets4-user-account-a-series-provider-ferran'
        ]
    );
});

test('language facet responses are not cached without an account or paired-device scope', async () => {
    const storage = createStorage();
    let requests = 0;
    const API = loadApi(storage, async () => {
        requests += 1;
        return { audio: [{ value: 'fr', label: 'French' }], subtitles: [] };
    });

    await API.media.languageFacets({ type: 'movie' });
    await API.media.languageFacets({ type: 'movie' });

    assert.equal(requests, 2);
    assert.equal(
        [...storage.values.keys()].some((key) => key.startsWith('norva-facets')),
        false
    );
});

test('paired-device facet caches are isolated when a screen is paired to another account', async () => {
    const storage = createStorage({
        'norva-cloud-device-id': 'screen-link-a',
        'norva-cloud-device-token': 'device-token-a'
    });
    let requests = 0;
    const API = loadApi(storage, async () => {
        requests += 1;
        const deviceId = storage.getItem('norva-cloud-device-id');
        return { audio: [{ value: deviceId, label: deviceId }], subtitles: [] };
    });

    const first = await API.media.languageFacets({ type: 'series' });
    assert.equal(first.audio[0].value, 'screen-link-a');

    storage.setItem('norva-cloud-device-id', 'screen-link-b');
    storage.setItem('norva-cloud-device-token', 'device-token-b');
    const second = await API.media.languageFacets({ type: 'series' });
    assert.equal(second.audio[0].value, 'screen-link-b');
    assert.equal(requests, 2);

    storage.setItem('norva-cloud-device-id', 'screen-link-a');
    storage.setItem('norva-cloud-device-token', 'device-token-a');
    const firstAgain = await API.media.languageFacets({ type: 'series' });
    assert.equal(firstAgain.audio[0].value, 'screen-link-a');
    assert.equal(requests, 2);
});

test('a successful exact observation immediately clears movie facet caches only', async () => {
    const storage = createStorage({
        'norva-cloud-session': session('account-a')
    });
    let writes = 0;
    const emittedEvents = [];
    const API = loadApi(
        storage,
        async ({ type, source = 'all' }) => ({
            audio: [{ value: `${type}-${source}`, label: `${type}-${source}` }],
            subtitles: []
        }),
        async () => {
            writes += 1;
            return { ok: true, updated: true, exact: true };
        },
        emittedEvents
    );

    await API.media.languageFacets({ type: 'movie' });
    await API.media.languageFacets({ type: 'movie', source: 'provider-a' });
    await API.media.languageFacets({ type: 'series' });

    await API.media.reportObservedLanguages({ itemType: 'movie' });

    assert.equal(writes, 1);
    const keys = [...storage.values.keys()].filter((key) => key.startsWith('norva-facets4-'));
    assert.deepEqual(keys, ['norva-facets4-user-account-a-series-all']);
    assert.deepEqual(
        JSON.parse(JSON.stringify(emittedEvents.map((event) => ({ type: event.type, detail: event.detail })))),
        [{
            type: 'norva:catalog-language-facets-invalidated',
            detail: { type: 'movie', source: null, removed: 2 }
        }]
    );
});

test('an invalidated in-flight facet response cannot overwrite the replacement cache', async () => {
    const storage = createStorage({
        'norva-cloud-session': session('account-a')
    });
    const resolvers = [];
    let requests = 0;
    const API = loadApi(
        storage,
        () => new Promise((resolve) => {
            requests += 1;
            resolvers.push(resolve);
        }),
        async () => ({ ok: true, updated: true, exact: true })
    );

    const staleRequest = API.media.languageFacets({ type: 'movie' });
    assert.equal(resolvers.length, 1);

    await API.media.reportObservedLanguages({ itemType: 'movie' });
    const replacementRequest = API.media.languageFacets({ type: 'movie' });
    assert.equal(resolvers.length, 2);

    resolvers[1]({ audio: [{ value: 'fresh', label: 'Fresh' }], subtitles: [] });
    const replacement = await replacementRequest;
    assert.equal(replacement.audio[0].value, 'fresh');

    // Resolve the pre-invalidation request last: it must neither overwrite the
    // replacement entry nor force a third transport request on the next read.
    resolvers[0]({ audio: [{ value: 'stale', label: 'Stale' }], subtitles: [] });
    await staleRequest;
    const cached = await API.media.languageFacets({ type: 'movie' });

    assert.equal(requests, 2);
    assert.equal(cached.audio[0].value, 'fresh');
    const stored = JSON.parse(storage.getItem('norva-facets4-user-account-a-movie-all'));
    assert.equal(stored.value.audio[0].value, 'fresh');
});

test('failed or non-updating observations preserve local facet caches for retry', async () => {
    const storage = createStorage({
        'norva-cloud-session': session('account-a')
    });
    const emittedEvents = [];
    const API = loadApi(
        storage,
        async () => ({ audio: [{ value: 'fr', label: 'French' }], subtitles: [] }),
        async () => ({ ok: true, updated: false, reason: 'variant_not_owned' }),
        emittedEvents
    );

    await API.media.languageFacets({ type: 'movie' });
    const before = [...storage.values.keys()].filter((key) => key.startsWith('norva-facets4-'));
    await API.media.reportObservedLanguages({ itemType: 'movie' });
    const after = [...storage.values.keys()].filter((key) => key.startsWith('norva-facets4-'));

    assert.deepEqual(after, before);
    assert.deepEqual(emittedEvents, []);
});

test('language facet transport errors propagate and remain immediately retryable', async () => {
    const storage = createStorage({
        'norva-cloud-session': session('account-a')
    });
    let requests = 0;
    const API = loadApi(storage, async () => {
        requests += 1;
        if (requests === 1) throw new Error('temporary facet failure');
        return { audio: [{ value: 'fr', label: 'French' }], subtitles: [] };
    });

    await assert.rejects(
        API.media.languageFacets({ type: 'movie' }),
        /temporary facet failure/
    );
    const recovered = await API.media.languageFacets({ type: 'movie' });

    assert.equal(requests, 2);
    assert.equal(recovered.audio[0].value, 'fr');
});

test('facet invalidation event identifies the exact media and provider scope', async () => {
    const storage = createStorage({
        'norva-cloud-session': session('account-a')
    });
    const emittedEvents = [];
    const API = loadApi(
        storage,
        async () => ({ audio: [], subtitles: [] }),
        async () => ({ ok: true, updated: true, exact: true }),
        emittedEvents
    );

    await API.media.reportObservedLanguages({
        itemType: 'series',
        cloudSourceId: '22222222-2222-4222-8222-222222222222'
    });

    assert.equal(emittedEvents.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(emittedEvents[0].detail)), {
        type: 'series',
        source: '22222222-2222-4222-8222-222222222222',
        removed: 0
    });
});
