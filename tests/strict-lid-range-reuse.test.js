'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StrictLidRangeReuse, createStrictRangeCollector } = require('../services/media-gateway/src/strict-lid-range-reuse');
const binding = { userHash: 'a'.repeat(64), sourceUrlHash: 'b'.repeat(64), profileHash: 'c'.repeat(64), fileSizeBytes: 4000000 };
const proof = { validator: { kind: 'etag', value: '"one"' }, fileSizeBytes: binding.fileSizeBytes, effectiveUrlIdentitySha256: 'd'.repeat(64) };
const drain = { providerDrained: true };

test('range reuse requires current strong validation and exact account/file/profile binding', () => {
    const cache = new StrictLidRangeReuse(); const first = cache.begin(binding);
    assert.equal(first.remember(0, Buffer.from('abcd'), drain), false);
    assert.equal(first.confirm(proof), true);
    assert.equal(first.remember(0, Buffer.from('abcd')), false);
    assert.equal(first.remember(0, Buffer.from('abcd'), drain), true);
    const second = cache.begin(binding);
    assert.equal(second.hasCandidate(1, 30), true);
    assert.equal(second.read(1, 30), null);
    assert.equal(second.confirm(proof), true);
    const got = second.read(1, 30); assert.equal(got.toString(), 'bcd'); got.fill(0);
    assert.equal(second.read(1, 30).toString(), 'bcd');
    for (const [key, value] of [['userHash', 'e'.repeat(64)], ['sourceUrlHash', 'f'.repeat(64)],
        ['profileHash', '0'.repeat(64)], ['fileSizeBytes', 4000001]]) {
        assert.equal(cache.begin({ ...binding, [key]: value }).hasCandidate(0, 3), false);
    }
});

test('changed ETag, target, missing strong tag and size invalidate; weak metadata never seeds the cache', () => {
    for (const changed of [{ validator: { kind: 'etag', value: '"two"' } },
        { effectiveUrlIdentitySha256: 'e'.repeat(64) }, { validator: null },
        { validator: { kind: 'last-modified', value: 'today' } },
        { validator: { kind: 'etag', value: 'W/"one"' } }, { fileSizeBytes: 4000001 }]) {
        const cache = new StrictLidRangeReuse(); const seed = cache.begin(binding);
        seed.confirm(proof); seed.remember(0, Buffer.from('abcd'), drain);
        const next = cache.begin(binding);
        assert.throws(() => next.confirm({ ...proof, ...changed }), { code: 'VOD_CHANGED' });
        assert.equal(next.read(0, 4), null); assert.equal(seed.read(0, 4), null);
        assert.equal(seed.remember(0, Buffer.from('stale'), drain), false);
        assert.equal(cache.snapshot().bytes, 0);
    }
    const empty = new StrictLidRangeReuse();
    assert.equal(empty.begin(binding).confirm({ ...proof, validator: null }), false);
    assert.equal(empty.snapshot().files, 0);
});

test('overlaps are deduplicated, gaps bounded, and memory/entry/fragment TTL ceilings enforced', () => {
    let at = 0;
    const cache = new StrictLidRangeReuse({ maxBytes: 20, perFileBytes: 12, maxFiles: 2, maxFragments: 3, ttlMs: 20, now: () => at });
    const one = cache.begin(binding); one.confirm(proof);
    one.remember(5, Buffer.from('fghij'), drain);
    one.remember(0, Buffer.from('abcdefg'), drain);
    assert.equal(cache.snapshot().bytes, 10);
    assert.equal(one.missingEnd(10, 20), 20); assert.equal(one.missingEnd(2, 20), 4);
    one.remember(10, Buffer.from('kl'), drain);
    assert.equal(cache.snapshot().bytes, 12);
    one.remember(12, Buffer.from('mn'), drain);
    assert.ok(cache.snapshot().bytes <= 12);
    for (const x of ['1', '2', '3']) {
        const session = cache.begin({ ...binding, sourceUrlHash: x.repeat(64) });
        session.confirm(proof); session.remember(0, Buffer.alloc(10), drain);
        assert.ok(cache.snapshot().bytes <= 20); assert.ok(cache.snapshot().files <= 2);
    }
    at = 21; cache.prune();
    assert.equal(cache.snapshot().bytes, 0);
    assert.equal(one.read(5, 9), null); assert.equal(one.remember(0, Buffer.alloc(5), drain), false);
});

test('bounded collector copies existing bytes only and publishes after explicit teardown', () => {
    const writes = []; const collector = createStrictRangeCollector(90, 6);
    const chunk = Buffer.from('1234'); collector.push(chunk); chunk.fill(0);
    collector.push(Buffer.from('567890'));
    assert.equal(writes.length, 0);
    collector.commit({ remember: (...args) => writes.push(args) });
    assert.equal(writes[0][0], 90); assert.equal(writes[0][1].toString(), '123456');
    assert.deepEqual(writes[0][2], drain);
    collector.commit({ remember: (...args) => writes.push(args) }); assert.equal(writes.length, 1);
});

test('stale sessions cannot remove or replace a newer cache generation', () => {
    const cache = new StrictLidRangeReuse(); const old = cache.begin(binding); old.confirm(proof);
    old.remember(0, Buffer.from('abcd'), drain); const stale = cache.begin(binding);
    old.invalidate();
    const fresh = cache.begin(binding); fresh.confirm({ ...proof, validator: { kind: 'etag', value: '"two"' } });
    fresh.remember(0, Buffer.from('wxyz'), drain);
    assert.equal(stale.confirm(proof), false);
    stale.invalidate(); assert.equal(fresh.read(0, 3).toString(), 'wxyz');
});
