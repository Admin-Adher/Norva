'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(fetchImpl) {
    const values = new Map([['norva-cloud-token', 'user-token']]);
    const location = { origin: 'https://norva.test', hostname: 'norva.test', search: '', pathname: '/app' };
    const window = { location, dispatchEvent() {}, addEventListener() {} };
    const context = { window, location, URL, URLSearchParams, Headers, Response, navigator: { language: 'fr', languages: ['fr'], userAgent: 'test' },
        AbortController, console, setTimeout, clearTimeout,
        document: { dispatchEvent() {}, addEventListener() {} },
        CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        localStorage: { getItem: key => values.get(key) || null,
            setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
        fetch: fetchImpl,
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/cloudApi.js'), 'utf8'), context);
    return window.NorvaCloud;
}
function response(status, payload, epoch = 'v2.1.10') {
    return new Response(JSON.stringify(payload), { status, headers: {
        'content-type': 'application/json', 'x-norva-visibility-epoch': epoch,
    } });
}

test('a delayed successful playback creation survives a newer catalogue response without replay', async () => {
    let finish, started;
    const observed = new Promise(resolve => { started = resolve; });
    const calls = [];
    const cloud = harness(async (url, options) => {
        calls.push({ url, options });
        started();
        return await new Promise(resolve => { finish = resolve; });
    });
    cloud.catalogVisibility.invalidate('v2.1.10');
    const pending = cloud.playback.createSession({ sourceId: 'source', itemId: 'movie', itemType: 'movie' });
    await observed;
    cloud.catalogVisibility.invalidate('v2.1.11');
    finish(response(201, { session: { id: 'created-once' }, playback: { url: 'https://media.test/playlist.m3u8' } }));
    const result = await pending;
    assert.equal(result.session.id, 'created-once');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer user-token');
    assert.equal(cloud.catalogVisibility.epoch(), 'v2.1.11');
});

test('playback still rejects the server visibility fence without retrying creation', async () => {
    let calls = 0;
    const cloud = harness(async () => { calls++; return response(409, {
        error: 'Mutation outcome must be reconciled before another attempt',
        details: { code: 'CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN' },
    }); });
    await assert.rejects(cloud.playback.createSession({}), error => error.status === 409);
    assert.equal(calls, 1);
});

test('catalogue GETs still reject older responses after one bounded refresh', async () => {
    let calls = 0;
    const cloud = harness(async () => { calls++; return response(200, { sources: [] }); });
    cloud.catalogVisibility.invalidate('v2.1.11');
    await assert.rejects(cloud.sources.list(), error => error.code === 'STALE_CATALOG_VISIBILITY_EPOCH');
    assert.equal(calls, 2);
});
