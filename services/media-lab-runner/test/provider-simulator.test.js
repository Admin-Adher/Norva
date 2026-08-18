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
        http458: 0,
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
        http458: 0,
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
