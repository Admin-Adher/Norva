const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/cloudApi.js'), 'utf8');
const body = source.slice(source.indexOf('    const pendingPlaybackPreparations ='),
    source.indexOf('    async function playbackSessionRequest('));
const id = 'b0b761f6-c47d-4284-9626-000000000001';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function harness({ prepare, cancel, create } = {}) {
    const requests = [], closed = [];
    let token = 'owner-before';
    const request = new Function('requestToBase', 'playbackBase', 'getToken', 'playbackSessionRequest',
        `${body}; return playbackRequest;`)(
        async (base, method, route, payload, options) => {
            requests.push({ base, method, route, payload, options });
            if (route === '/playback/preparations') return prepare ? prepare(payload) : { preparation: { id } };
            if (route.endsWith('/cancel')) return cancel ? cancel() : { preparation: { id, status: 'cancelled' }, drained: true };
            return create ? create(payload) : { session: { id: 'live-session' } };
        }, () => '/edge', () => token, async (...args) => { closed.push(args); });
    const live = (signal, options = {}) => request({ sourceId: 'owned-source', itemType: 'live', itemId: 123, deviceId: 'device-a' }, { signal, ...options });
    return { request, live, requests, closed, changeAccount() { token = 'owner-after'; } };
}

test('Back before prepare receipt retires it without ever opening a provider session', async () => {
    const prepare = deferred(), h = harness({ prepare: () => prepare.promise });
    const controller = new AbortController();
    const result = h.live(controller.signal);
    controller.abort();
    const cancelled = assert.rejects(result, { name: 'AbortError' });
    prepare.resolve({ preparation: { id } });
    await cancelled;
    assert.deepEqual(h.requests.map(x => x.route), ['/playback/preparations', `/playback/preparations/${id}/cancel`]);
});

test('Back during unresolved creation cancels immediately and settles before its late receipt', async () => {
    const create = deferred(), h = harness({ create: () => create.promise });
    const controller = new AbortController();
    const result = h.live(controller.signal);
    await tick();
    assert.equal(h.requests[1].payload.preparationId, id);
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(h.requests.at(-1).route, `/playback/preparations/${id}/cancel`);
    create.resolve({ session: { id: 'late-session' } });
    await tick();
    assert.equal(h.closed[0][1], '/playback/sessions/late-session/expire');
});

test('another Play waits for exact producer drainage, including a 202 response', async () => {
    const create = deferred(), drain = deferred(); let cancellations = 0;
    const h = harness({ create: p => p.itemId === 123 ? create.promise : { session: { id: 'next' } },
        cancel: () => ++cancellations === 1
            ? { preparation: { id, status: 'cancel_requested' }, drained: false, retryAfterMs: 500 }
            : drain.promise });
    const controller = new AbortController(); const old = h.live(controller.signal);
    old.catch(() => {}); await tick(); controller.abort();
    const next = h.request({ itemType: 'vod', itemId: 'next', deviceId: 'device-a' });
    await new Promise(resolve => setTimeout(resolve, 520));
    assert.equal(h.requests.filter(x => x.route === '/playback/session').length, 1);
    drain.resolve({ preparation: { id, status: 'cancelled' }, drained: true });
    await assert.rejects(old, { name: 'AbortError' });
    assert.equal((await next).session.id, 'next');
    create.resolve({ session: { id: 'late-session' } }); await tick();
});

for (const failure of ['404', 'wrong-id', 'undrained']) test(`cancellation ${failure} keeps the next Play blocked until a retry is acknowledged`, async () => {
    const create = deferred(); let fail = true;
    const h = harness({ create: p => p.itemId === 123 ? create.promise : { session: { id: 'next' } }, cancel: () => {
        if (!fail) return { preparation: { id, status: 'cancelled' }, drained: true };
        if (failure === '404') throw Object.assign(new Error('not found'), { status: 404 });
        return { preparation: { id: failure === 'wrong-id' ? id.replace(/1$/, '2') : id, status: 'cancelled' }, drained: failure !== 'undrained' };
    } });
    const controller = new AbortController(); const old = h.live(controller.signal);
    old.catch(() => {}); await tick(); controller.abort();
    await assert.rejects(old, { code: 'native_live_cleanup_failed' });
    await assert.rejects(h.request({ itemId: 'next', deviceId: 'device-a' }), { code: 'native_live_cleanup_failed' });
    assert.equal(h.requests.filter(x => x.route === '/playback/session').length, 1);
    fail = false; assert.equal((await h.request({ itemId: 'next', deviceId: 'device-a' })).session.id, 'next');
    create.resolve({ session: { id: 'late-session' } }); await tick();
});

test('cancellation retains the original device token and identity after account changes', async () => {
    const create = deferred(), h = harness({ create: () => create.promise });
    const controller = new AbortController(); const old = h.live(controller.signal, { token: 'original-device-token' });
    await tick(); h.changeAccount(); controller.abort(); await assert.rejects(old, { name: 'AbortError' });
    const cancel = h.requests.find(x => x.route.endsWith('/cancel'));
    assert.equal(cancel.options.token, 'original-device-token');
    assert.deepEqual(cancel.payload, { deviceId: 'device-a' });
    create.resolve({ session: { id: 'late-session' } }); await tick();
    assert.equal(h.closed[0][3].token, 'original-device-token');
});

test('a failed creation drains its preparation and does not mask its original provider error', async () => {
    const h = harness({ create: () => { throw new Error('provider failure'); } });
    await assert.rejects(h.live(new AbortController().signal), /provider failure/);
    assert.equal(h.requests.at(-1).route, `/playback/preparations/${id}/cancel`);
});

test('successful Live stays active and VOD does not acquire the preparation protocol', async () => {
    const h = harness(); const controller = new AbortController();
    assert.equal((await h.live(controller.signal)).session.id, 'live-session');
    controller.abort(); await tick();
    assert.equal(h.requests.length, 2); assert.equal(h.closed.length, 0);
    await h.request({ itemType: 'vod' }, { signal: new AbortController().signal });
    assert.equal(h.requests.length, 3); assert.equal(h.requests.at(-1).route, '/playback/session');
});

test('a refused preparation never falls back to a legacy creation endpoint', async () => {
    const h = harness({ prepare: () => { throw Object.assign(new Error('missing endpoint'), { status: 404 }); } });
    await assert.rejects(h.live(new AbortController().signal), { status: 404 });
    assert.equal(h.requests.length, 1);
});

test('an unacknowledged cancellation from another account cannot block the new account', async () => {
    const create = deferred();
    const h = harness({ create: p => p.itemId === 123 ? create.promise : { session: { id: 'other-owner' } },
        cancel: () => { throw Object.assign(new Error('revoked old token'), { status: 401 }); } });
    const controller = new AbortController(); const old = h.live(controller.signal);
    old.catch(() => {}); await tick(); controller.abort();
    await assert.rejects(old, { code: 'native_live_cleanup_failed' });
    h.changeAccount();
    assert.equal((await h.request({ itemId: 'other-owner', deviceId: 'device-a' })).session.id, 'other-owner');
    create.resolve({ session: { id: 'late-old-owner' } }); await tick();
    assert.equal(h.closed[0][3].token, 'owner-before');
});

test('account change while prepare is pending cancels the receipt before provider creation', async () => {
    const prepare = deferred(); const h = harness({ prepare: () => prepare.promise });
    const result = h.live(new AbortController().signal);
    h.changeAccount(); prepare.resolve({ preparation: { id } });
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(h.requests.filter(x => x.route === '/playback/session').length, 0);
    assert.equal(h.requests.at(-1).options.token, 'owner-before');
});
