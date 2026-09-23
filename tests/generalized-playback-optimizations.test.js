'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPlaybackStartupWindowPolicy } = require('../services/media-gateway/src/playback-startup-window');
const { createPrivateResumeOwnerGate, privateResumeBinding } = require('../services/media-gateway/src/private-resume-binding');
const { PrivateResumeHlsCache } = require('../services/media-gateway/src/private-resume-hls-cache');
const { FinitePlaybackRangeReuse } = require('../services/media-gateway/src/finitePlaybackRangeReuse');

const MiB = 1024 * 1024;
const owner = n => crypto.createHash('sha256').update(`test-owner-${n}`).digest('hex');
const fileSizeBytes = 10 * MiB;
const session = { finite: true, knownProfile: true, fileSizeBytes };
const source = { sourceUrl: 'https://new-provider.invalid/one.mp4', sourceId: 'source-one',
    sourceRevision: 'revision-one', fileSizeBytes };
const observed = { fileSizeBytes, validator: { kind: 'etag', value: '"file-one"' },
    effectiveUrlIdentitySha256: 'f'.repeat(64) };

test('an explicit global startup policy admits previously unknown authenticated owners', () => {
    const policy = createPlaybackStartupWindowPolicy({ enabled: true, allAuthenticatedOwners: true });
    for (let n = 0; n < 100; n++) {
        assert.equal(policy.mp4Session(owner(n), session), true);
        assert.equal(policy.bytes(owner(n), 8 * MiB), 2 * MiB);
        assert.equal(policy.bytes(owner(n), MiB), MiB);
        assert.equal(policy.requestEnd(owner(n), MiB, 9 * MiB - 1), 3 * MiB - 1);
        assert.equal(policy.requestEnd(owner(n), MiB, 2 * MiB - 1), 2 * MiB - 1);
    }
    assert.deepEqual(policy.status(), { enabled: true, ownerScoped: false,
        scope: 'all-authenticated-owners', windowBytes: 2 * MiB });
});

test('global eligibility preserves the authentication-shaped owner and exact MP4 profile guards', () => {
    const policy = createPlaybackStartupWindowPolicy({ enabled: true, allAuthenticatedOwners: true });
    for (const invalid of [undefined, null, '', 'raw-user-id', 'A'.repeat(64), 'a'.repeat(63)]) {
        assert.equal(policy.mp4Session(invalid, session), false);
        assert.equal(policy.bytes(invalid, 8 * MiB), 8 * MiB);
        assert.equal(policy.requestEnd(invalid, 0, 8 * MiB - 1), 8 * MiB - 1);
    }
    for (const change of [{ finite: false }, { knownProfile: false }, { fileSizeBytes: 0 },
        { fileSizeBytes: NaN }, { fileSizeBytes: '1024' }, { fileSizeBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
        assert.equal(policy.mp4Session(owner(0), { ...session, ...change }), false);
    }
});

test('legacy allowlists and disabled policies cannot accidentally become global', () => {
    for (const allAuthenticatedOwners of [undefined, false, 'true', 1]) {
        for (const ownerHashes of [undefined, '', 'invalid']) {
            const policy = createPlaybackStartupWindowPolicy({ enabled: true, ownerHashes, allAuthenticatedOwners });
            assert.equal(policy.mp4Session(owner(0), session), false);
            assert.equal(policy.status().ownerScoped, true);
        }
    }
    const pilot = createPlaybackStartupWindowPolicy({ enabled: true, ownerHashes: ` ${owner(0)}, invalid ` });
    assert.equal(pilot.mp4Session(owner(0), session), true);
    assert.equal(pilot.mp4Session(owner(1), session), false);
    for (const enabled of [undefined, false, 'true', 1]) {
        const policy = createPlaybackStartupWindowPolicy({ enabled, allAuthenticatedOwners: true });
        assert.equal(policy.mp4Session(owner(0), session), false);
        assert.equal(policy.status().enabled, false);
    }
});

const playlist = '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n'
    + Array.from({ length: 20 }, (_, n) => `#EXTINF:4,\nsegment-${n}.ts\n`).join('');
const binding = (n, change = {}) => privateResumeBinding({ ownerKey: owner(n), ...source, ...change });
const capture = (cache, n, change = {}) => cache.capture({ binding: binding(n), observed,
    position: 10, actualStartOffset: 0, playlist, readAsset: async () => Buffer.alloc(188, n), ...change });

test('global private HLS eligibility never crosses owners, source revisions, or media profiles', async () => {
    const allows = createPrivateResumeOwnerGate({ enabled: true });
    const cache = new PrivateResumeHlsCache();
    for (let n = 0; n < 2; n++) {
        assert.equal(allows(owner(n)), true);
        assert.equal(await capture(cache, n), true);
    }
    for (let n = 0; n < 2; n++) {
        const lease = cache.acquire(binding(n), 10, observed);
        assert.equal(lease.asset('resume-0.ts')[0], n);
        lease.release();
        for (const change of [{ sourceId: 'other-source' }, { sourceRevision: 'other-revision' },
            { sourceUrl: source.sourceUrl + '?token=other' }, { profile: 'audio=2' }]) {
            assert.equal(cache.acquire(binding(n, change), 10, observed), null);
        }
    }
    assert.equal(cache.acquire(binding(2), 10, observed), null);
    cache.revokeOwner(owner(0));
    assert.equal(cache.acquire(binding(0), 10, observed), null);
    const retained = cache.acquire(binding(1), 10, observed);
    assert.equal(retained.asset('resume-0.ts')[0], 1);
    retained.release();
});

test('one aggregate HLS budget bounds 100 eligible owners and preserves active leases', async () => {
    const cache = new PrivateResumeHlsCache({ maxBytes: 32 * 1024, perFileBytes: 4 * 1024, maxEntries: 8 });
    assert.equal(await capture(cache, 0), true);
    const lease = cache.acquire(binding(0), 10, observed);
    for (let n = 1; n < 100; n++) {
        assert.equal(await capture(cache, n), true);
        const status = cache.publicStatus();
        assert.ok(status.bytes + status.reservedBytes <= 32 * 1024);
        assert.ok(status.entries <= 8);
        assert.equal(lease.asset('resume-0.ts')[0], 0);
    }
    assert.ok(cache.publicStatus().evictions > 0);
    lease.release();
});

test('concurrent captures by 100 owners reserve the same global HLS memory budget', async () => {
    const cache = new PrivateResumeHlsCache({ maxBytes: 32 * 1024, perFileBytes: 4 * 1024, maxEntries: 8 });
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const tasks = Array.from({ length: 100 }, (_, n) => capture(cache, n,
        { readAsset: async () => { await barrier; return Buffer.alloc(188, n); } }));
    assert.equal(cache.publicStatus().reservedBytes, 32 * 1024);
    release();
    const stored = await Promise.all(tasks);
    assert.equal(stored.filter(Boolean).length, 4);
    const status = cache.publicStatus();
    assert.equal(status.reservedBytes, 0);
    assert.ok(status.bytes <= 32 * 1024);
    assert.equal(status.entries, 4);
});

test('global private range reuse requires current proof and retains a single aggregate budget', () => {
    const cache = new FinitePlaybackRangeReuse({ maxBytes: 4096, perFileBytes: 1024,
        maxFiles: 8, maxRetainedWindowBytes: 1024 });
    const begin = n => cache.begin({ ownerKey: owner(n), ...source });
    for (let n = 0; n < 100; n++) {
        const ranges = begin(n);
        assert.equal(ranges.read(0, 187), null);
        assert.equal(ranges.confirm(observed), true);
        assert.equal(ranges.remember(0, Buffer.alloc(188, n)), true);
        const status = cache.publicStatus();
        assert.ok(status.bytes <= 4096);
        assert.ok(status.files <= 8);
    }
    const last = begin(99);
    assert.equal(last.read(0, 187), null, 'current provider validation precedes reuse');
    assert.equal(last.confirm(observed), true);
    assert.equal(last.read(0, 187)[0], 99);
    assert.equal(begin(100).hasPriorRanges, false);
    assert.equal(begin(98).confirm({ ...observed, validator: null }), false);
    cache.revokeOwner(owner(99));
    assert.equal(last.read(0, 187), null);
});
