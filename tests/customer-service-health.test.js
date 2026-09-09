const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { importTypescriptModule } = require('./helpers/import-typescript-module');
const modulePath = path.join(__dirname, '../supabase/functions/_shared/customer-service-health.ts');

test('only the correct healthy service can confirm customer incident recovery', async () => {
    const { readCustomerServiceHealth } = await importTypescriptModule(modulePath);
    for (const [service, name] of [['gateway', 'norva-media-gateway'], ['relay', 'norva-edge']]) {
        assert.equal(await readCustomerServiceHealth('https://example.test/', service, async (url) => {
            assert.equal(url, 'https://example.test/health');
            return Response.json({ ok: true, service: name });
        }), false);
        assert.equal(await readCustomerServiceHealth('https://example.test', service, async () => Response.json({ ok: false, service: name })), true);
    }
});

test('timeouts and server errors count as unavailable, unknown content cannot resolve an incident', async () => {
    const { readCustomerServiceHealth: read } = await importTypescriptModule(modulePath);
    assert.equal(await read('https://example.test', 'gateway', async () => { throw new DOMException('timeout', 'TimeoutError'); }), true);
    assert.equal(await read('https://example.test', 'gateway', async () => new Response('down', { status: 503 })), true);
    for (const response of [new Response('missing', { status: 404 }), new Response('<html>proxy</html>'), Response.json({ ok: true, service: 'different-service' }), Response.json({ ok: true }), new Response('x'.repeat(131073))]) {
        assert.equal(await read('https://example.test', 'gateway', async () => response), null);
    }
    assert.equal(await read('', 'gateway', async () => { throw new Error('must not fetch'); }), null);
});
