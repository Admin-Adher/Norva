'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { FinitePlaybackRangeReuse } = require('../services/media-gateway/src/finitePlaybackRangeReuse');

const ownerKey = 'a'.repeat(64), fileSizeBytes = 10_000_000;
const begin = (cache) => cache.begin({ ownerKey, sourceUrl: 'https://provider.invalid/movie/private/secretuser/secretpass/1.mp4',
    sourceId: 'source-a', sourceRevision: '1', fileSizeBytes });
const observed = { fileSizeBytes, validator: { kind: 'etag', value: '"file-v1"' },
    effectiveUrlIdentitySha256: 'b'.repeat(64) };

test('range introspection reports exact retained coordinates and priorities', () => {
    const cache = new FinitePlaybackRangeReuse({ maxBytes: 8 * 1024 * 1024,
        perFileBytes: 4 * 1024 * 1024, maxRetainedWindowBytes: 1024 * 1024 });
    const session = begin(cache);
    assert.equal(session.confirm(observed), true);
    // A protected header window and an interior window.
    assert.equal(session.remember(0, Buffer.alloc(128 * 1024, 1)), true);
    assert.equal(session.remember(5_000_000, Buffer.alloc(64 * 1024, 2)), true);

    const described = cache.describe();
    assert.equal(described.files, 1);
    const entry = described.entries[0];
    assert.equal(entry.fragments, 2);
    assert.equal(entry.live, true);
    assert.ok(entry.expiresInMs > 0);

    const header = entry.ranges.find(r => r.start === 0);
    const interior = entry.ranges.find(r => r.start === 5_000_000);
    assert.deepEqual({ start: header.start, end: header.end, bytes: header.bytes, priority: header.priority },
        { start: 0, end: 128 * 1024 - 1, bytes: 128 * 1024, priority: 1 });
    assert.deepEqual({ start: interior.start, end: interior.end, bytes: interior.bytes, priority: interior.priority },
        { start: 5_000_000, end: 5_000_000 + 64 * 1024 - 1, bytes: 64 * 1024, priority: 0 });
    for (const range of entry.ranges) assert.ok(Number.isInteger(range.idleMs) && range.idleMs >= 0);
});

test('range introspection exposes no payload bytes, validator, identity or owner material', () => {
    const cache = new FinitePlaybackRangeReuse({ maxBytes: 8 * 1024 * 1024, perFileBytes: 4 * 1024 * 1024 });
    const session = begin(cache);
    assert.equal(session.confirm(observed), true);
    assert.equal(session.remember(0, Buffer.alloc(64 * 1024, 7)), true);

    const serialized = JSON.stringify(cache.describe());
    for (const secret of [ownerKey, 'secretuser', 'secretpass', 'provider.invalid',
        observed.validator.value, 'file-v1', observed.effectiveUrlIdentitySha256, 'source-a']) {
        assert.equal(serialized.includes(secret), false, `introspection leaked ${secret}`);
    }
    // No buffer-shaped payload survives serialization either.
    assert.equal(/"type"\s*:\s*"Buffer"/.test(serialized), false);
    assert.equal(/"payload"/.test(serialized), false);
    // The entry reference is a short digest, not reversible binding material.
    assert.equal(cache.describe().entries[0].ref.length, 12);
});

test('range introspection shows the interior window evicted before the protected header', () => {
    // perFileBytes forces trim(); the header is priority 1 and must survive.
    const cache = new FinitePlaybackRangeReuse({ maxBytes: 4 * 1024 * 1024,
        perFileBytes: 512 * 1024, maxRetainedWindowBytes: 1024 * 1024 });
    const session = begin(cache);
    assert.equal(session.confirm(observed), true);
    session.remember(0, Buffer.alloc(256 * 1024, 1));            // header, priority 1
    for (let i = 1; i <= 6; i += 1) {
        session.remember(1_000_000 * i, Buffer.alloc(200 * 1024, i)); // interior, priority 0
    }
    const entry = cache.describe().entries[0];
    assert.ok(entry.bytes <= 512 * 1024, 'per-file budget respected');
    assert.ok(entry.ranges.some(r => r.start === 0 && r.priority === 1), 'header retained');
    const interiorKept = entry.ranges.filter(r => r.priority === 0).length;
    assert.ok(interiorKept < 6, 'interior windows evicted under budget pressure');
});

// --- viewer anchor: eviction must follow the viewer, not the read-ahead frontier ---

test('without an anchor the frontier is retained and the viewer window is evicted', () => {
    const cache = new FinitePlaybackRangeReuse({ maxBytes: 4 * 1024 * 1024,
        perFileBytes: 512 * 1024, maxRetainedWindowBytes: 1024 * 1024 });
    const session = begin(cache);
    assert.equal(session.confirm(observed), true);
    // Viewer sits near 1_000_000; the frontier races ahead.
    session.remember(1_000_000, Buffer.alloc(200 * 1024, 1));
    for (const off of [3_000_000, 5_000_000, 7_000_000, 9_000_000]) {
        session.remember(off, Buffer.alloc(200 * 1024, 2));
    }
    const ranges = cache.describe().entries[0].ranges.filter(r => r.priority === 0);
    assert.equal(ranges.some(r => r.start === 1_000_000), false, 'viewer window survived without an anchor');
    assert.ok(ranges.some(r => r.start >= 7_000_000), 'frontier retained without an anchor');
});

test('an anchor retains the viewer window and evicts the furthest frontier fragment', () => {
    const cache = new FinitePlaybackRangeReuse({ maxBytes: 4 * 1024 * 1024,
        perFileBytes: 512 * 1024, maxRetainedWindowBytes: 1024 * 1024 });
    const session = begin(cache);
    assert.equal(session.confirm(observed), true);
    session.remember(1_000_000, Buffer.alloc(200 * 1024, 1));
    assert.equal(session.anchorAt(1_050_000), true);
    for (const off of [3_000_000, 5_000_000, 7_000_000, 9_000_000]) {
        session.remember(off, Buffer.alloc(200 * 1024, 2));
    }
    const entry = cache.describe().entries[0];
    assert.equal(entry.anchor, 1_050_000);
    const ranges = entry.ranges.filter(r => r.priority === 0);
    assert.ok(ranges.some(r => r.start === 1_000_000), 'viewer window must survive with an anchor');
    assert.equal(ranges.some(r => r.start === 9_000_000), false, 'furthest frontier must be evicted first');
});

test('anchorAt validates its input and never admits bytes or relaxes validation', () => {
    const cache = new FinitePlaybackRangeReuse({ maxBytes: 4 * 1024 * 1024, perFileBytes: 1024 * 1024 });
    const unconfirmed = begin(cache);
    assert.equal(unconfirmed.anchorAt(10), false, 'no anchor before identity is confirmed');
    const session = begin(cache);
    assert.equal(session.confirm(observed), true);
    for (const bad of [-1, 1.5, NaN, fileSizeBytes, fileSizeBytes + 1, '100', null, undefined]) {
        assert.equal(session.anchorAt(bad), false, `anchorAt accepted ${String(bad)}`);
    }
    assert.equal(session.anchorAt(0), true);
    assert.equal(session.anchorAt(fileSizeBytes - 1), true);
    // Anchoring alone must not create readable bytes.
    assert.equal(session.read(0, 10), null);
});

// --- protected viewer window: distant read-ahead is dropped, not retained ---

test('distant prefetch is dropped only when a window and an anchor are both set', () => {
    const cache = new FinitePlaybackRangeReuse({ maxBytes: 8 * 1024 * 1024, perFileBytes: 4 * 1024 * 1024,
        retainBehindBytes: 200_000, retainAheadBytes: 500_000 });
    const session = begin(cache);
    assert.equal(session.confirm(observed), true);
    // No anchor yet: the window must not apply, so a distant window is retained.
    assert.equal(session.remember(8_000_000, Buffer.alloc(64 * 1024, 1)), true);
    assert.equal(cache.describe().droppedDistantPrefetch, 0);

    session.anchorAt(1_000_000);
    assert.equal(session.remember(1_200_000, Buffer.alloc(64 * 1024, 2)), true, 'inside window retained');
    assert.equal(session.remember(4_000_000, Buffer.alloc(64 * 1024, 3)), false, 'ahead of window dropped');
    assert.equal(session.remember(100_000, Buffer.alloc(64 * 1024, 4)), false, 'behind window dropped');
    const described = cache.describe();
    assert.equal(described.droppedDistantPrefetch, 2);
    assert.equal(described.limits.retainAheadBytes, 500_000);
    assert.equal(described.limits.retainBehindBytes, 200_000);
    const ranges = described.entries[0].ranges;
    assert.ok(ranges.some(r => r.start === 1_200_000), 'window fragment kept');
    assert.equal(ranges.some(r => r.start === 4_000_000), false);
});

test('an unset window preserves the previous retention behaviour exactly', () => {
    const cache = new FinitePlaybackRangeReuse({ maxBytes: 8 * 1024 * 1024, perFileBytes: 4 * 1024 * 1024 });
    const session = begin(cache);
    assert.equal(session.confirm(observed), true);
    session.anchorAt(1_000_000);
    assert.equal(session.remember(9_000_000, Buffer.alloc(64 * 1024, 1)), true, 'no window => nothing dropped');
    const d = cache.describe();
    assert.equal(d.droppedDistantPrefetch, 0);
    assert.equal(d.limits.retainAheadBytes, null);
    assert.equal(d.limits.retainBehindBytes, null);
});
