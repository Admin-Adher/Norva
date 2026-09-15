'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), { once } = require('node:events');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');
const { SharedPlaybackRanges, hybridPlaybackRanges } = require('../services/media-gateway/src/shared-playback-ranges');
const { FinitePlaybackRangeReuse } = require('../services/media-gateway/src/finitePlaybackRangeReuse');
const brokerHarness = require('./fixtures/finite-ts-index-broker');
const MiB = 1024 * 1024, owner = 'a'.repeat(64), other = 'b'.repeat(64), fileSizeBytes = 32 * MiB;
const grant = (ownerKey = owner, more = {}) => ({ protocol: 1, ownerKey, providerIdentitySha256: 'c'.repeat(64),
    catalogueItemSha256: 'd'.repeat(64), expiresAtMs: Date.now() + 3600_000, ...more });
const proof = { fileSizeBytes, validator: { kind: 'etag', value: '"same-content"' },
    effectiveUrlSha256: 'e'.repeat(64), effectiveUrlIdentitySha256: 'f'.repeat(64), cacheControl: 'public, max-age=60' };
const begin = (cache, ownerKey = owner, more = {}) => cache.begin({ ownerKey, fileSizeBytes, grant: grant(ownerKey), ...more });

test('Edge grants sharing only for explicitly opted-in server-resolved identities; default adds no lookup', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
    const start = source.indexOf('async function createSharedFragmentGrant(');
    const end = source.indexOf('// catalog_media_items keying', start);
    const code = stripTypeScriptTypes(source.slice(start, end));
    let allowed = '', resolved = 'verified-provider', lookups = 0;
    const create = vm.runInNewContext('(' + code.trim() + ')', {
        Deno: { env: { get: () => allowed } }, Date, Set, Number,
        resolveSourceIdentity: async (sourceId, userId) => {
            lookups++; assert.equal(sourceId, 'owned-source'); assert.equal(userId, 'signed-in-user');
            if (resolved === 'database-error') throw Error('unavailable');
            return { key: resolved };
        },
        sha256Hex: async value => crypto.createHash('sha256').update(value).digest('hex'),
    });
    const args = ['owned-source', 'signed-in-user', 'movie', 'item-42', new Date(Date.now() + 3600_000).toISOString(), {}];
    assert.equal(await create(...args), null); assert.equal(lookups, 0);
    allowed = 'another-provider'; assert.equal(await create(...args), null);
    for (const value of ['source:owned-source', '', 'database-error']) {
        resolved = value; allowed = value; assert.equal(await create(...args), null);
    }
    resolved = allowed = 'verified-provider';
    const result = await create(...args);
    assert.equal(result.protocol, 1);
    assert.equal(result.ownerKey, crypto.createHash('sha256').update('signed-in-user').digest('hex'));
    assert.match(result.catalogueItemSha256, /^[a-f0-9]{64}$/);
    assert.notEqual((await create(...[...args.slice(0, 3), 'other-item', ...args.slice(4)])).catalogueItemSha256, result.catalogueItemSha256);
    assert.equal(await create(...[...args.slice(0, 4), 'invalid-date', args[5]]), null);
});

test('disabled by default, grants are server-only, scoped, bounded and expiring', () => {
    assert.equal(begin(new SharedPlaybackRanges()), null);
    const cache = new SharedPlaybackRanges({ enabled: true });
    for (const g of [null, {}, grant(other), grant(owner, { expiresAtMs: 0 }), grant(owner, { providerIdentitySha256: 'source:1' }),
        grant(owner, { expiresAtMs: Date.now() + 48 * 3600_000 })]) assert.equal(begin(cache, owner, { grant: g }), null);
    const first = begin(cache); assert.equal(first.read(0, 9), null);
    assert.equal(first.remember(0, Buffer.alloc(10)), false);
});

test('two authorized users share exact initialization bytes only after their own fresh provider proof', () => {
    const cache = new SharedPlaybackRanges({ enabled: true });
    const first = begin(cache); first.confirm(proof); first.remember(0, Buffer.alloc(2 * MiB, 47));
    const second = begin(cache, other); assert.equal(second.read(0, 20), null);
    second.confirm(proof); const bytes = second.read(0, 20); assert.deepEqual(bytes, Buffer.alloc(21, 47));
    bytes.fill(0); assert.equal(second.read(0, 1)[0], 47);
    assert.ok(second.reusedBytes > 0);
    for (const change of [{ providerIdentitySha256: '1'.repeat(64) }, { catalogueItemSha256: '2'.repeat(64) }]) {
        const isolated = begin(cache, other, { grant: grant(other, change) }); isolated.confirm(proof);
        assert.equal(isolated.read(0, 20), null);
    }
});

for (const [label, more] of [
    ['weak ETag', { validator: { kind: 'etag', value: 'W/"same-content"' } }],
    ['absent ETag', { validator: null }], ['changed file', { validator: { kind: 'etag', value: '"changed"' } }],
    ['changed query values', { effectiveUrlSha256: '3'.repeat(64) }], ['size', { fileSizeBytes: fileSizeBytes + 1 }],
    ['no-store', { cacheControl: 'public, no-store' }], ['private', { cacheControl: 'private, max-age=60' }],
    ['no-cache', { cacheControl: 'public, no-cache' }], ['no shared permission', { cacheControl: 'max-age=60' }],
    ['Vary', { vary: 'Authorization' }], ['cookie', { setCookie: true }],
]) test(`${label}: never reuse another account's bytes`, () => {
    const cache = new SharedPlaybackRanges({ enabled: true }); const first = begin(cache);
    first.confirm(proof); first.remember(0, Buffer.alloc(30));
    const second = begin(cache, other); second.confirm({ ...proof, ...more }); assert.equal(second.read(0, 20), null);
});

test('interior fragments require two different users; one repeated resume does not fill shared storage', () => {
    const cache = new SharedPlaybackRanges({ enabled: true });
    for (let visit = 0; visit < 4; visit++) {
        const session = begin(cache); session.confirm(proof); assert.equal(session.remember(12 * MiB, Buffer.alloc(MiB, 12)), false);
    }
    assert.equal(cache.publicStatus().bytes, 0);
    const second = begin(cache, other); second.confirm(proof); assert.equal(second.remember(12 * MiB, Buffer.alloc(MiB, 12)), true);
    const third = begin(cache, '1'.repeat(64)); third.confirm(proof); assert.equal(third.read(12 * MiB, 12 * MiB + 10)[0], 12);
});

test('expiry, cancellation and revocation fence existing and pending consumers without destroying valid shared data', () => {
    let now = Date.now(); const cache = new SharedPlaybackRanges({ enabled: true, now: () => now, ttlMs: 50 });
    const first = begin(cache); first.confirm(proof); first.remember(0, Buffer.alloc(30, 2));
    const ac = new AbortController(), cancelled = begin(cache, other, { signal: ac.signal }); cancelled.confirm(proof);
    ac.abort(); assert.equal(cancelled.read(0, 9), null); assert.equal(cancelled.remember(0, Buffer.alloc(3)), false);
    const pending = begin(cache, other); cache.revokeOwner(other); assert.equal(pending.confirm(proof), false);
    const fresh = begin(cache); fresh.confirm(proof); assert.equal(fresh.read(0, 9)[0], 2);
    now += 51; assert.equal(fresh.read(0, 9), null); assert.equal(cache.publicStatus().bytes, 0);
});

test('quota and demand tables stay bounded; diagnostics contain no keys or personal progress', () => {
    const cache = new SharedPlaybackRanges({ enabled: true, maxBytes: 2 * MiB, perFileBytes: MiB,
        fragmentBytes: MiB, prefixBytes: MiB, tailBytes: 0, maxEntries: 2, maxDemandEntries: 4 });
    for (let item = 0; item < 20; item++) {
        const s = begin(cache, owner, { grant: grant(owner, { catalogueItemSha256: item.toString(16).padStart(64, '0') }) });
        s.confirm(proof); s.remember(0, Buffer.alloc(MiB));
        assert.ok(cache.publicStatus().bytes <= 2 * MiB); assert.ok(cache.publicStatus().entries <= 2);
    }
    assert.ok(cache.publicStatus().demandEntries <= 4);
    assert.doesNotMatch(JSON.stringify(cache.publicStatus()), /aaaa|cccc|eeee|same-content|https:|position|ownerKey/);
});

test('a rejected shared identity leaves the private validated resume cache usable', () => {
    const privateCache = new FinitePlaybackRangeReuse(), sharedCache = new SharedPlaybackRanges({ enabled: true });
    const binding = { ownerKey: owner, sourceUrl: 'https://p.invalid/u/private/f.mp4', fileSizeBytes, sourceId: 'source-a', sourceRevision: '1' };
    const cold = privateCache.begin(binding); cold.confirm(proof); cold.remember(0, Buffer.alloc(32, 9));
    const hybrid = hybridPlaybackRanges(privateCache.begin(binding), begin(sharedCache));
    assert.equal(hybrid.confirm({ ...proof, cacheControl: 'private' }), true);
    assert.equal(hybrid.read(0, 9)[0], 9); assert.equal(sharedCache.publicStatus().bytes, 0);
});

for (const format of ['mp4', 'mkv', 'ts']) test(`${format}: real serialized Range broker shares a prefix without fetching a whole file`, async t => {
    const bytes = Buffer.alloc(3 * MiB, 41), requests = [];
    let active = 0, peak = 0;
    const origin = http.createServer((req, res) => {
        const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || ''); assert.ok(match);
        const start = Number(match[1]), end = Number(match[2]); requests.push([start, end]); active++; peak = Math.max(peak, active);
        res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1,
            'etag': '"fixture-exact"', 'cache-control': 'public, max-age=60' });
        setTimeout(() => { active--; res.end(bytes.subarray(start, end + 1)); }, 5);
    }).listen(0, '127.0.0.1'); await once(origin, 'listening');
    t.after(() => new Promise(resolve => origin.close(resolve)));
    const cache = new SharedPlaybackRanges({ enabled: true }); const sourceUrl = `http://127.0.0.1:${origin.address().port}/exact.${format}`;
    const sessions = [];
    t.after(async () => { for (const s of sessions) await s.close(); });
    for (const [iteration, ownerKey] of [owner, other].entries()) {
        const ranges = hybridPlaybackRanges(null, cache.begin({ ownerKey, fileSizeBytes: bytes.length, grant: grant(ownerKey) }));
        const broker = await brokerHarness().createStrictLidBroker({ sourceUrl, fileSizeBytes: bytes.length,
            dispatcher: null, pathPrefix: 'finite-mkv-seek', finiteWindowBytes: MiB,
            finiteWarmupWindowBytes: 65536, finiteResumeRanges: ranges, releaseDelayMs: 0 });
        sessions.push(broker); const before = requests.length;
        const response = await fetch(broker.inputUrl, { headers: { range: `bytes=0-${MiB - 1}` } });
        assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, MiB));
        await broker.close();
        if (iteration === 1) {
            assert.deepEqual(requests.slice(before), [[0, 65535]], 'own current validation, all remaining prefix bytes shared');
            assert.equal(ranges.sharedReusedBytes, MiB - 65536);
        }
    }
    assert.equal(peak, 1); assert.ok(requests.reduce((n, [start, end]) => n + end - start + 1, 0) < bytes.length);
});

test('optional range-cache bookkeeping failure cannot retry or interrupt a valid provider response', async t => {
    const bytes = Buffer.alloc(65536, 23);
    let fetches = 0;
    const origin = http.createServer((req, res) => {
        fetches++;
        res.writeHead(206, { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
            'content-length': bytes.length, etag: '"fixture"' });
        res.end(bytes);
    }).listen(0, '127.0.0.1');
    await once(origin, 'listening');
    t.after(() => new Promise(resolve => origin.close(resolve)));
    const broker = await brokerHarness().createStrictLidBroker({
        sourceUrl: `http://127.0.0.1:${origin.address().port}/fixture.mp4`, fileSizeBytes: bytes.length,
        dispatcher: null, pathPrefix: 'finite-mkv-seek', finiteWindowBytes: bytes.length,
        finiteWarmupWindowBytes: bytes.length, releaseDelayMs: 0,
        finiteResumeRanges: { read: () => null, missingEnd: (_, end) => end,
            confirm() { throw Error('SIMULATED_CACHE_FAILURE'); }, invalidate() {} },
    });
    t.after(() => broker.close());
    const response = await fetch(broker.inputUrl, { headers: { range: `bytes=0-${bytes.length - 1}` } });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(fetches, 1);
});
