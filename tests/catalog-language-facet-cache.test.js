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

function loadApi(storage, languageFacets) {
    const NorvaCloud = {
        home: { languageFacets },
        device: {
            home: { languageFacets },
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
        matchMedia: () => ({ matches: false })
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
        'norva-facets3-user-account-a-series',
        'norva-facets3-user-account-b-movie',
        'norva-facets3-user-account-b-series'
    ]);
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
