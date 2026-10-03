const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { fetchGatewayXmltv } = require('../services/media-gateway/src/provider-xmltv');
const now = Date.now();
const options = { serverUrl: 'https://new.example', username: 'user', password: 'secret',
    windowStartMs: now - 7200000, windowEndMs: now + 28800000, channelNames: ['FR| TF1 UHD'], channelIds: [] };
const xml = `<tv><channel id="tf1.fr"><display-name>TF1 HD</display-name></channel>
<programme channel="tf1.fr" start="${new Date(now-60000).toISOString()}" stop="${new Date(now+60000).toISOString()}"><title>Programme actuel</title></programme></tv>`;
function fixture(body = xml) {
    const evidence = { released: false, closed: false, opens: 0 };
    const registration = { release() { assert.equal(evidence.closed, true); evidence.released = true; } };
    const hooks = { accountKey: () => 'provider-account', userAgent: 'Norva', assertAdmission() {},
        register: (_, transport) => { evidence.transport = transport; return registration; },
        open: async () => { evidence.opens++; return { status: 200, headers: {}, body: Readable.from([Buffer.from(body)]),
            close: async () => { evidence.closed = true; } }; } };
    return { evidence, hooks, registration };
}
test('primary XMLTV returns current guide through provider egress and drains before success', async () => {
    const { evidence, hooks } = fixture();
    const guide = await fetchGatewayXmltv(options, hooks);
    assert.equal(guide.programmes[0].title, 'Programme actuel');
    assert.equal(evidence.closed, true); assert.equal(evidence.released, true);
    assert.equal(evidence.transport.providerDrained, true);
});
test('unknown provider guide failures still close their connection', async () => {
    const { evidence, hooks } = fixture('<html>unavailable</html>');
    await assert.rejects(fetchGatewayXmltv(options, hooks));
    assert.equal(evidence.released, true); assert.equal(evidence.transport.providerDrained, true);
});
test('playback priority refusal never opens another upstream connection', async () => {
    const { evidence, hooks } = fixture();
    hooks.assertAdmission = () => { throw Object.assign(new Error('busy'), { status: 409 }); };
    await assert.rejects(fetchGatewayXmltv(options, hooks), e => e.status === 409);
    assert.equal(evidence.opens, 0);
});
test('a viewer cancels and drains an in-flight XMLTV read before taking the slot', async () => {
    const { evidence, hooks, registration } = fixture();
    hooks.open = async (_, { signal }) => {
        const body = new Readable({ read() {} });
        signal.addEventListener('abort', () => body.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        body.on('error', () => {});
        return { status: 200, headers: {}, body, close: async () => { evidence.closed = true; } };
    };
    const pending = fetchGatewayXmltv(options, hooks);
    await new Promise(resolve => setImmediate(resolve));
    registration.preempted = true;
    const drainage = evidence.transport.stopAndDrain(1000);
    await assert.rejects(pending, e => e.status === 409 && e.code === 'viewer_preempted');
    assert.equal(await drainage, true);
    assert.equal(evidence.released, true);
});
test('invalid selection, date ranges and private redirects cannot trigger unbounded requests', async () => {
    const { evidence, hooks } = fixture();
    for (const changes of [{ channelNames: ['x'.repeat(257)] }, { channelIds: Array(65).fill('a') },
        { windowEndMs: now + 100 * 3600000 }])
        await assert.rejects(fetchGatewayXmltv({ ...options, ...changes }, hooks), e => e.status === 400);
    assert.equal(evidence.opens, 0);
    hooks.open = async () => { evidence.opens++; return { status: 302, headers: { location: 'http://127.0.0.1/private' },
        body: Readable.from([]), close: async () => { evidence.closed = true; } }; };
    await assert.rejects(fetchGatewayXmltv(options, hooks), e => e.kind === 'invalid_epg_url');
    assert.equal(evidence.opens, 1); assert.equal(evidence.released, true);
});
