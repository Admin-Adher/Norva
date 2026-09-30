const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/cloudApi.js'), 'utf8');
const id = 'b0b761f6-c47d-4284-9626-000000000001';
const tick = () => new Promise(resolve => setImmediate(resolve));
const jwt = (sub, version) => `e30.${Buffer.from(JSON.stringify({ sub, version })).toString('base64url')}.signature`;
const response = (status, payload) => ({ status, ok: status >= 200 && status < 300,
    headers: { get: key => key === 'content-type' ? 'application/json' : null },
    json: async () => payload, text: async () => '' });
function fixture({ fetch, refresh } = {}) {
    const values = new Map([['norva-cloud-token', jwt('owner-a', 1)]]);
    const requests = [];
    const window = { location: { origin: 'https://norva.tv', search: '' }, NorvaAuth: {
        refreshSession: async () => {
            const token = refresh ? await refresh() : jwt('owner-a', 2);
            values.set('norva-cloud-token', token);
            return { access_token: token };
        }
    } };
    vm.runInNewContext(source, {
        window, navigator: { userAgent: 'NorvaTV-AndroidPhone/1.3.27', language: 'fr-FR', languages: ['fr-FR'] },
        document: { readyState: 'loading', addEventListener() {} },
        localStorage: { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) },
        fetch: async (url, opts) => {
            const call = { url, auth: opts.headers.Authorization, body: opts.body && JSON.parse(opts.body) };
            requests.push(call);
            return fetch(call, requests.length);
        },
        atob, AbortController, URL, URLSearchParams, Intl, Date, Map, Set, WeakMap, Promise,
        console: { log() {}, warn() {}, error() {}, debug() {} }, setTimeout, clearTimeout,
    });
    return { api: window.NorvaCloud.playback, values, requests };
}

test('ordinary VOD creation still refreshes an expired user session', async () => {
    const f = fixture({ fetch: (_call, count) => count === 1
        ? response(401, { error: 'expired' }) : response(201, { session: { id } }) });
    await f.api.createSession({ itemType: 'vod', itemId: 'movie' });
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].auth, `Bearer ${jwt('owner-a', 2)}`);
});

test('Live prepare refresh is carried into creation and exact cancellation', async () => {
    let resolveCreate;
    const creation = new Promise(resolve => { resolveCreate = resolve; });
    const f = fixture({ fetch: (call, count) => {
        if (count === 1) return response(401, { error: 'expired' });
        if (call.url.endsWith('/preparations')) return response(201, { preparation: { id } });
        if (call.url.endsWith('/session')) return creation;
        if (call.url.endsWith('/cancel')) return response(200, { preparation: { id, status: 'cancelled' }, drained: true });
        return response(200, { session: { id, status: 'expired' }, gatewayErrors: 0 });
    } });
    const controller = new AbortController();
    const result = f.api.createSession({ sourceId: 'owned', itemType: 'live', itemId: '123' }, { signal: controller.signal });
    await tick(); controller.abort(); await assert.rejects(result, { name: 'AbortError' });
    assert.ok(f.requests.slice(1).every(call => call.auth === `Bearer ${jwt('owner-a', 2)}`));
    resolveCreate(response(201, { session: { id } })); await tick();
    assert.equal(f.requests.at(-1).auth, `Bearer ${jwt('owner-a', 2)}`);
});

test('a refresh returning a different owner cannot retry preparation under that identity', async () => {
    const f = fixture({ refresh: async () => jwt('owner-b', 1), fetch: () => response(401, { error: 'expired' }) });
    await assert.rejects(f.api.createSession({ sourceId: 'owned', itemType: 'live', itemId: '123' },
        { signal: new AbortController().signal }), { status: 401 });
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].auth, `Bearer ${jwt('owner-a', 1)}`);
});

test('old owner cancellation cannot refresh through the newly connected account', async () => {
    let resolveCreate, refreshes = 0;
    const creation = new Promise(resolve => { resolveCreate = resolve; });
    const f = fixture({ refresh: async () => { refreshes++; return jwt('owner-b', 2); }, fetch: call => {
        if (call.url.endsWith('/preparations')) return response(201, { preparation: { id } });
        if (call.url.endsWith('/session')) return call.body.itemId === 'next'
            ? response(201, { session: { id: 'next' } }) : creation;
        if (call.url.endsWith('/cancel')) return response(401, { error: 'revoked old owner' });
        return response(200, { session: { id, status: 'expired' }, gatewayErrors: 0 });
    } });
    const controller = new AbortController();
    const old = f.api.createSession({ sourceId: 'owned', itemType: 'live', itemId: '123' }, { signal: controller.signal });
    old.catch(() => {}); await tick();
    f.values.set('norva-cloud-token', jwt('owner-b', 1)); controller.abort();
    await assert.rejects(old, { code: 'native_live_cleanup_failed' });
    assert.equal(refreshes, 0);
    assert.equal(f.requests.at(-1).auth, `Bearer ${jwt('owner-a', 1)}`);
    assert.equal((await f.api.createSession({ itemType: 'vod', itemId: 'next' })).session.id, 'next');
    assert.equal(f.requests.at(-1).auth, `Bearer ${jwt('owner-b', 1)}`);
    resolveCreate(response(201, { session: { id } })); await tick();
    assert.equal(f.requests.at(-1).auth, `Bearer ${jwt('owner-a', 1)}`);
});
