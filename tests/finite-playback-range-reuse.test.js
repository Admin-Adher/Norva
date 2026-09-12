'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { FinitePlaybackRangeReuse } = require('../services/media-gateway/src/finitePlaybackRangeReuse');
const binding = { ownerKey: 'a'.repeat(64), sourceUrl: 'https://fixture.invalid/account/secret/file.ts', fileSizeBytes: 1024 };
const proof = { fileSizeBytes: 1024, validator: { kind: 'etag', header: 'If-Range', value: '"v1"' }, effectiveUrlIdentitySha256: 'b'.repeat(64) };

test('playback fragments require current strong proof and only count previous-session reuse', () => {
    const cache = new FinitePlaybackRangeReuse();
    const first = cache.begin(binding);
    assert.equal(first.remember(0, Buffer.alloc(16, 7)), false);
    assert.equal(first.confirm(proof), true);
    assert.equal(first.remember(0, Buffer.alloc(16, 7)), true);
    assert.equal(first.read(0, 15), null, 'new bytes stay in the ordinary session cache');
    const second = cache.begin(binding);
    assert.equal(second.read(0, 15), null, 'no stale bytes before current provider revalidation');
    assert.equal(second.confirm(proof), true);
    const bytes = second.read(0, 40);
    assert.deepEqual(bytes, Buffer.alloc(16, 7));
    bytes.fill(9);
    assert.deepEqual(second.read(0, 15), Buffer.alloc(16, 7), 'returned bytes cannot modify proof');
    assert.equal(second.reusedBytes, 32);
    second.remember(100, Buffer.alloc(16, 2));
    assert.equal(second.read(100, 115), null);
    assert.equal(second.missingEnd(50, 120), 120, 'new fragments are not old cache hits');
    assert.equal(second.missingEnd(0, 15), 15);
    assert.doesNotMatch(JSON.stringify(cache.publicStatus()), /secret|fixture|account|https:/);
});

for (const [name, change] of [
    ['etag', { validator: { kind: 'etag', header: 'If-Range', value: '"v2"' } }],
    ['weak etag', { validator: { kind: 'etag', header: 'If-Range', value: 'W/"v1"' } }],
    ['last modified', { validator: { kind: 'last-modified', value: 'Wed, 01 Jul 2026 00:00:00 GMT' } }],
    ['missing validator', { validator: null }],
    ['target identity', { effectiveUrlIdentitySha256: 'c'.repeat(64) }],
    ['size', { fileSizeBytes: 2048 }],
]) test(`stale ${name} is a cache miss, never a forced playback failure`, () => {
    const cache = new FinitePlaybackRangeReuse();
    const first = cache.begin(binding); first.confirm(proof); first.remember(0, Buffer.alloc(16));
    const second = cache.begin(binding);
    assert.equal(second.confirm({ ...proof, ...change }), false);
    assert.equal(second.read(0, 15), null);
    assert.equal(second.remember(0, Buffer.alloc(16)), false);
    assert.equal(cache.publicStatus().bytes, 0);
});

test('cache is isolated by owner, exact credential-bearing source and file size', () => {
    const cache = new FinitePlaybackRangeReuse();
    const first = cache.begin(binding); first.confirm(proof); first.remember(0, Buffer.alloc(16));
    for (const change of [{ ownerKey: 'd'.repeat(64) }, { sourceUrl: binding.sourceUrl + '?other=1' }, { fileSizeBytes: 1025 }]) {
        const second = cache.begin({ ...binding, ...change });
        second.confirm({ ...proof, fileSizeBytes: change.fileSizeBytes || 1024 });
        assert.equal(second.read(0, 15), null);
    }
    assert.equal(cache.begin({ ...binding, ownerKey: '' }), null);
});

test('global/per-file byte bounds, LRU, fragment counts and absolute expiry survive live handles', () => {
    let now = 1;
    const cache = new FinitePlaybackRangeReuse({ maxBytes: 24, perFileBytes: 16,
        maxFiles: 2, maxFragments: 2, ttlMs: 50, now: () => now });
    const first = cache.begin(binding); first.confirm(proof); first.remember(0, Buffer.alloc(8));
    first.remember(20, Buffer.alloc(8)); first.remember(40, Buffer.alloc(8));
    assert.ok(cache.publicStatus().bytes <= 16);
    for (const ownerKey of ['c', 'd'].map(x => x.repeat(64))) {
        const item = cache.begin({ ...binding, ownerKey }); item.confirm(proof); item.remember(0, Buffer.alloc(16));
        assert.ok(cache.publicStatus().bytes <= 24); assert.ok(cache.publicStatus().files <= 2);
    }
    const last = cache.begin({ ...binding, ownerKey: 'd'.repeat(64) }); last.confirm(proof);
    assert.equal(last.read(0, 7).length, 8);
    const retainedEntry = [...cache.store.entries.values()].at(-1);
    now += 51;
    assert.equal(last.read(0, 7), null); assert.equal(last.remember(0, Buffer.alloc(8)), false);
    assert.equal(cache.publicStatus().bytes, 0); assert.equal(cache.publicStatus().files, 0);
    assert.equal(retainedEntry.fragments.length, 0, 'live broker handles cannot retain evicted payloads');
    assert.equal(retainedEntry.bytes, 0);
});
