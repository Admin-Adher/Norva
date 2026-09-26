const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/cloudApi.js'), 'utf8');
const body = source.slice(source.indexOf('    async function playbackRequest('),
    source.indexOf('    async function playbackSessionRequest('));
function harness() {
    let resolve, reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const created = [], closed = [];
    const request = new Function('requestToBase', 'playbackBase', 'getToken', 'playbackSessionRequest',
        `${body}; return playbackRequest;`)(
        (...args) => { created.push(args); return pending; }, () => '/edge', () => 'owner-token',
        async (...args) => { closed.push(args); });
    return { request, resolve, reject, created, closed };
}
test('Back after POST keeps the receipt and closes only that session', async () => {
    const h = harness(), controller = new AbortController();
    const result = h.request({ itemId: 'film' }, { signal: controller.signal });
    assert.equal(h.created[0][4].signal, undefined);
    controller.abort();
    h.resolve({ session: { id: 'abandoned-session' } });
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(h.closed.length, 1);
    assert.equal(h.closed[0][1], '/playback/sessions/abandoned-session/expire');
    assert.equal(h.closed[0][3].token, 'owner-token');
    assert.equal(h.closed[0][3].catalogVisibility, false);
});
test('already cancelled attempt sends no creation request', async () => {
    const h = harness(), controller = new AbortController(); controller.abort();
    await assert.rejects(h.request({}, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(h.created.length, 0);
});
test('successful active attempt retains its session', async () => {
    const h = harness(); const result = h.request({});
    const receipt = { session: { id: 'active-session' } }; h.resolve(receipt);
    assert.equal(await result, receipt); assert.equal(h.closed.length, 0);
});
test('paired device cleanup retains device authority', async () => {
    const h = harness(), controller = new AbortController();
    const result = h.request({}, { signal: controller.signal, token: 'device-token' });
    controller.abort(); h.resolve({ session: { id: 'device-session' } });
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(h.closed[0][3].token, 'device-token');
});
test('stale visibility rejects playback but first closes the committed receipt', async () => {
    const h = harness(); const result = h.request({});
    const error = Object.assign(new Error('stale'), { playbackSessionReceiptId: 'stale-session' });
    h.reject(error); await assert.rejects(result, (actual) => actual === error);
    assert.equal(h.closed[0][1], '/playback/sessions/stale-session/expire');
});
test('server rejection without receipt does not close any other session', async () => {
    const h = harness(); const result = h.request({});
    h.reject(new Error('provider unavailable')); await assert.rejects(result, /provider unavailable/);
    assert.equal(h.closed.length, 0);
});
