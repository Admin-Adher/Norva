'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { privateResumeBinding } = require('../services/media-gateway/src/private-resume-binding');
const { PrivateResumeHlsCache } = require('../services/media-gateway/src/private-resume-hls-cache');

const ownerKey = 'a'.repeat(64);
const fileSizeBytes = 10_000_000;
const binding = privateResumeBinding({
    ownerKey,
    sourceUrl: 'https://provider.invalid/movie.mp4',
    sourceId: 'source-a',
    sourceRevision: 'revision-1',
    vodIdentityKey: 'b'.repeat(64),
    fileSizeBytes,
    profile: 'audio=1',
});
const playlist = '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n'
    + Array.from({ length: 20 }, (_, index) => `#EXTINF:4,\nsegment-${index}.ts\n`).join('');
const strongObservation = {
    fileSizeBytes,
    validator: { kind: 'etag', value: '"file-v1"' },
    effectiveUrlIdentitySha256: 'c'.repeat(64),
};

async function capture(cache, observed, readAsset = async () => Buffer.alloc(188, 0x47)) {
    return cache.capture({ binding, observed, position: 10, actualStartOffset: 0, playlist, readAsset });
}

test('weak or absent provider freshness proof keeps private HLS cache disabled', async () => {
    const observations = [
        { ...strongObservation, validator: null },
        { ...strongObservation, validator: { kind: 'etag', value: 'W/"file-v1"' } },
        { ...strongObservation, validator: { kind: 'last-modified', value: 'yesterday' } },
        { ...strongObservation, fileSizeBytes: fileSizeBytes + 1 },
    ];
    for (const observed of observations) {
        const cache = new PrivateResumeHlsCache();
        let reads = 0;
        assert.equal(await capture(cache, observed, async () => {
            reads++;
            return Buffer.alloc(188, 0x47);
        }), false);
        assert.equal(reads, 0, 'unverified providers must be rejected before reading cache assets');
        const status = cache.publicStatus();
        assert.equal(status.entries, 0);
        assert.equal(status.bytes, 0);
        assert.equal(status.lastCaptureRejection, 'unverified-identity');
        assert.equal(status.revalidation, 'current-strong-etag-size-target');
    }
});

test('a stable VOD identity does not authorize stale bytes without current provider proof', async () => {
    const cache = new PrivateResumeHlsCache();
    assert.equal(await capture(cache, strongObservation), true);
    assert.equal(cache.acquire(binding, 10, { ...strongObservation, validator: null }), null);
    assert.equal(cache.publicStatus().entries, 0, 'a failed revalidation discards the prior window');
});

test('a changed effective URL invalidates the prior window even with a strong ETag', async () => {
    const cache = new PrivateResumeHlsCache();
    assert.equal(await capture(cache, strongObservation), true);
    assert.equal(cache.acquire(binding, 10, {
        ...strongObservation,
        effectiveUrlIdentitySha256: 'd'.repeat(64),
    }), null);
    assert.equal(cache.publicStatus().entries, 0);
});
