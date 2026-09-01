'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { FIXTURES } = require('../src/fixture-registry');
const {
    ProviderSimulator,
    FIXED_LAST_MODIFIED,
    parseSingleRange,
} = require('../src/provider-simulator');
const {
    ProviderScenarioError,
    normalizeProviderScenario,
} = require('../src/provider-scenario');

function fixture(id) {
    return FIXTURES.find((item) => item.id === id);
}

async function startSimulator(fixtureRoot) {
    const simulator = new ProviderSimulator({ fixtureRoot });
    const server = http.createServer(async (request, response) => {
        if (!(await simulator.handle(request, response))) {
            response.statusCode = 404;
            response.end();
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    return {
        simulator,
        origin: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

async function rawHttpRequest(url) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.once('end', () => resolve(Object.freeze({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
            })));
        });
        request.once('error', reject);
    });
}

test('single byte-range parsing is strict and bounded', () => {
    assert.deepEqual(parseSingleRange('bytes=2-5', 10), { start: 2, end: 5 });
    assert.deepEqual(parseSingleRange('bytes=4-', 10), { start: 4, end: 9 });
    assert.deepEqual(parseSingleRange('bytes=-3', 10), { start: 7, end: 9 });
    assert.equal(parseSingleRange('bytes=10-12', 10), false);
    assert.equal(parseSingleRange('bytes=4-2', 10), false);
    assert.equal(parseSingleRange('bytes=0-1,4-5', 10), false);
    assert.equal(parseSingleRange('items=0-1', 10), false);
});

test('provider simulator serves exact ranges, strong and weak validators, and removes capabilities', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-media-lab-provider-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bytes = Buffer.from('0123456789abcdef', 'ascii');
    await fs.writeFile(path.join(root, 'h264-closed-aac.mkv'), bytes);
    await fs.writeFile(path.join(root, 'h264-no-etag.mkv'), bytes);
    const harness = await startSimulator(root);
    t.after(() => harness.close());

    const strong = await harness.simulator.openFixture(fixture('h264-closed-aac'), harness.origin);
    const head = await fetch(strong.mediaUrl, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('etag'), /^"[a-f0-9]{64}"$/);
    assert.equal(head.headers.get('last-modified'), FIXED_LAST_MODIFIED);
    assert.equal(head.headers.get('accept-ranges'), 'bytes');

    const partial = await fetch(strong.mediaUrl, { headers: { Range: 'bytes=2-5' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 2-5/16');
    assert.equal(await partial.text(), '2345');
    assert.deepEqual(strong.snapshot(), {
        providerGets: 1,
        providerHeads: 1,
        rangeGets: 1,
        http407: 0,
        http458: 0,
        http5xx: 0,
        forcedDisconnects: 0,
        activeGets: 0,
        maximumConcurrentProviderGets: 1,
        bytesServed: 4,
        mediaRequests: 2,
    });
    assert.equal(strong.resetCounters(), true);
    assert.deepEqual(strong.snapshot(), {
        providerGets: 0,
        providerHeads: 0,
        rangeGets: 0,
        http407: 0,
        http458: 0,
        http5xx: 0,
        forcedDisconnects: 0,
        activeGets: 0,
        maximumConcurrentProviderGets: 0,
        bytesServed: 0,
        mediaRequests: 0,
    });
    assert.equal(strong.close(), true);
    assert.equal(strong.resetCounters(), false);
    assert.equal(strong.close(), false);
    assert.equal(strong.capabilityActive(), false);
    assert.equal((await fetch(strong.mediaUrl)).status, 404);

    const weak = await harness.simulator.openFixture(fixture('h264-no-etag'), harness.origin);
    const weakHead = await fetch(weak.mediaUrl, { method: 'HEAD' });
    const weakEtag = weakHead.headers.get('etag');
    assert.match(weakEtag, /^W\/"[a-f0-9]{64}"$/);
    const ignoredWeakIfRange = await fetch(weak.mediaUrl, {
        headers: { Range: 'bytes=0-2', 'If-Range': weakEtag },
    });
    assert.equal(ignoredWeakIfRange.status, 200);
    assert.equal(await ignoredWeakIfRange.text(), bytes.toString('ascii'));
    weak.close();
});

test('delay and request counters expose provider concurrency without trusting an adapter', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-media-lab-delay-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'hevc-eac3-cold.mkv'), Buffer.alloc(32, 7));
    const harness = await startSimulator(root);
    t.after(() => harness.close());
    const run = await harness.simulator.openFixture(fixture('hevc-eac3-cold'), harness.origin);

    const [first, second] = await Promise.all([
        fetch(run.mediaUrl, { headers: { Range: 'bytes=0-3' } }),
        fetch(run.mediaUrl, { headers: { Range: 'bytes=4-7' } }),
    ]);
    await Promise.all([first.arrayBuffer(), second.arrayBuffer()]);
    const counters = run.snapshot();
    assert.equal(counters.providerGets, 2);
    assert.equal(counters.maximumConcurrentProviderGets, 2);
    assert.equal(counters.rangeGets, 2);
    run.close();
});

test('the first 458 is exact, counted, and a retry stays observable', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-media-lab-458-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const harness = await startSimulator(root);
    t.after(() => harness.close());
    const run = await harness.simulator.openFixture(fixture('provider-458'), harness.origin);

    const first = await fetch(run.mediaUrl);
    assert.equal(first.status, 458);
    assert.equal(first.headers.get('retry-after'), '120');
    assert.deepEqual(await first.json(), { error: 'Provider busy' });
    const retry = await fetch(run.mediaUrl);
    assert.equal(retry.status, 503);
    const counters = run.snapshot();
    assert.equal(counters.providerGets, 2);
    assert.equal(counters.http458, 1);
    run.close();
});

test('provider scenarios are strict, bounded and preserve the fixed 458 fixture', () => {
    assert.deepEqual(normalizeProviderScenario(fixture('provider-458').provider), {
        protocol: 1,
        delayMs: 0,
        bandwidthBytesPerSecond: 0,
        statusSequence: [458],
        disconnectAfterBytes: 0,
        disconnectCount: 0,
    });
    assert.deepEqual(normalizeProviderScenario(fixture('h264-closed-aac').provider, {
        delayMs: 25,
        bandwidthBytesPerSecond: 64 * 1024,
        statusSequence: [407, 502],
        disconnectAfterBytes: 4096,
        disconnectCount: 2,
    }), {
        protocol: 1,
        delayMs: 25,
        bandwidthBytesPerSecond: 64 * 1024,
        statusSequence: [407, 502],
        disconnectAfterBytes: 4096,
        disconnectCount: 2,
    });
    for (const invalid of [
        { unknown: true },
        { statusSequence: [200] },
        { statusSequence: [407, 599] },
        { bandwidthBytesPerSecond: -1 },
        { disconnectAfterBytes: 0, disconnectCount: 1 },
        { disconnectAfterBytes: 10, disconnectCount: 0 },
    ]) assert.throws(
        () => normalizeProviderScenario(fixture('h264-closed-aac').provider, invalid),
        ProviderScenarioError,
    );
});

test('scripted 407 and 5xx responses remain sequential and observable', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-media-lab-statuses-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'h264-closed-aac.mkv'), Buffer.from('provider-ok'));
    const harness = await startSimulator(root);
    t.after(() => harness.close());
    const run = await harness.simulator.openFixture(fixture('h264-closed-aac'), harness.origin, {
        statusSequence: [407, 502],
    });

    const proxyAuth = await rawHttpRequest(run.mediaUrl);
    assert.equal(proxyAuth.status, 407);
    assert.equal(proxyAuth.headers['proxy-authenticate'], 'Basic realm="norva-media-lab"');
    const upstreamFailure = await fetch(run.mediaUrl);
    assert.equal(upstreamFailure.status, 502);
    const success = await fetch(run.mediaUrl);
    assert.equal(success.status, 200);
    assert.equal(await success.text(), 'provider-ok');
    const counters = run.snapshot();
    assert.equal(counters.providerGets, 3);
    assert.equal(counters.http407, 1);
    assert.equal(counters.http5xx, 1);
    assert.equal(counters.http458, 0);
    run.close();
});

test('bandwidth shaping and one forced disconnect are deterministic and retryable', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-media-lab-shaped-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bytes = Buffer.alloc(32 * 1024, 19);
    await fs.writeFile(path.join(root, 'h264-closed-aac.mkv'), bytes);
    const harness = await startSimulator(root);
    t.after(() => harness.close());
    const run = await harness.simulator.openFixture(fixture('h264-closed-aac'), harness.origin, {
        bandwidthBytesPerSecond: 64 * 1024,
        disconnectAfterBytes: 4 * 1024,
        disconnectCount: 1,
    });

    const interrupted = await fetch(run.mediaUrl);
    await assert.rejects(() => interrupted.arrayBuffer());
    const startedAt = Date.now();
    const retry = await fetch(run.mediaUrl, { headers: { Range: 'bytes=0-16383' } });
    assert.equal(retry.status, 206);
    assert.equal((await retry.arrayBuffer()).byteLength, 16 * 1024);
    assert.ok(Date.now() - startedAt >= 180, '16 KiB at 64 KiB/s must be visibly throttled');
    const counters = run.snapshot();
    assert.equal(counters.providerGets, 2);
    assert.equal(counters.forcedDisconnects, 1);
    assert.equal(counters.rangeGets, 1);
    assert.equal(counters.bytesServed, 20 * 1024);
    run.close();
});
