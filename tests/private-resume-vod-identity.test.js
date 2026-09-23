'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { privateResumeBinding } = require('../services/media-gateway/src/private-resume-binding');
const { FinitePlaybackRangeReuse } = require('../services/media-gateway/src/finitePlaybackRangeReuse');
const { PrivateResumeHlsCache } = require('../services/media-gateway/src/private-resume-hls-cache');
const sha256Hex = value => crypto.createHash('sha256').update(value).digest('hex');
const edge = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
const gateway = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
const base = { ownerKey: 'a'.repeat(64), sourceUrl: 'https://fixture.invalid/file.mp4',
    sourceId: 'source', sourceRevision: '1', fileSizeBytes: 1024, profile: 'audio=1' };
const proof = { fileSizeBytes: 1024, validator: { kind: 'etag', header: 'If-Range', value: '"v1"' },
    effectiveUrlIdentitySha256: 'b'.repeat(64) };
const id = '1'.repeat(64), otherId = '2'.repeat(64);

test('restored Edge identity is stable across editorial metadata and changes with file authority', async () => {
    const expression = edge.match(/const identityForTarget = ([\s\S]*?);/)[1].replace(': string', '');
    const identity = { sourceId: 'source', itemType: 'movie', itemId: 'item', variantId: 'variant' };
    const calculate = (playbackIdentity, url = base.sourceUrl) => vm.runInNewContext(
        '(' + expression + ')', { playbackIdentity, sha256Hex })(url);
    const first = await calculate(identity);
    assert.equal(first, await calculate({ ...identity, title: 'New title', poster: 'new.jpg' }));
    for (const change of [{ sourceId: 'other' }, { itemType: 'episode' }, { itemId: 'other' }, { variantId: 'other' }]) {
        assert.notEqual(first, await calculate({ ...identity, ...change }));
    }
    assert.notEqual(first, await calculate(identity, base.sourceUrl + '?version=2'));
    assert.match(await calculate({ ...identity, itemId: '', variantId: null }), /^[a-f0-9]{64}$/);
    assert.match(edge, /playbackIdentity: compactRecord\(\{ \.\.\.playbackIdentity,\s*vodIdentityKey,/);
    assert.match(edge, /vodIdentityKey: await identityForTarget\(correctedTargetUrl\)/);
});

test('Gateway carries the Edge VOD identity into both private cache bindings', () => {
    const binding = gateway.slice(gateway.indexOf('function privateResumeHlsBindingForSession('),
        gateway.indexOf('\nfunction privateResumeObservedIdentity('));
    const ranges = gateway.slice(gateway.indexOf('const identity = asRecord(session.playbackIdentity);',
        gateway.indexOf('const primaryProviderRoute = providerNodeRouteForSession(session);',
            gateway.indexOf('async function tryStartPrivateResumeWindow('))),
        gateway.indexOf('session.privateResumeRangeHandle = resumeRanges;'));
    assert.match(binding, /vodIdentityKey: identity\.vodIdentityKey/);
    assert.match(ranges, /vodIdentityKey: identity\.vodIdentityKey/);
});

test('VOD identity partitions retained byte ranges without granting stale byte access', () => {
    const cache = new FinitePlaybackRangeReuse();
    const params = { ...base, vodIdentityKey: id };
    const first = cache.begin(params); first.confirm(proof); first.remember(0, Buffer.alloc(16, 7));
    const other = cache.begin({ ...params, vodIdentityKey: otherId }); other.confirm(proof);
    assert.equal(other.read(0, 15), null);
    const same = cache.begin(params);
    assert.equal(same.read(0, 15), null);
    assert.equal(same.confirm(proof), true);
    assert.deepEqual(same.read(0, 15), Buffer.alloc(16, 7));
});

const playlist = '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n' + Array.from({ length: 15 },
    (_, i) => `#EXTINF:4,\nsegment-${i}.ts\n`).join('');
async function capture(cache, observed = proof) {
    return cache.capture({ binding: privateResumeBinding({ ...base, vodIdentityKey: id }), observed,
        position: 10, actualStartOffset: 0, playlist, readAsset: async () => Buffer.alloc(188, 0x47) });
}

test('VOD identity partitions HLS windows and permits reusing the same exact file', async () => {
    const cache = new PrivateResumeHlsCache();
    assert.equal(await capture(cache), true);
    assert.equal(cache.candidate(privateResumeBinding({ ...base, vodIdentityKey: otherId }), 10), null);
    const binding = privateResumeBinding({ ...base, vodIdentityKey: id });
    assert.ok(cache.candidate(binding, 10));
    // The fixture payload has only TS sync bytes, so it is intentionally not
    // a subtitle-validating playback lease. Candidate lookup is the identity
    // contract under test; actual acquisition is covered by the media fixture.
});

test('a stable catalogue VOD identity cannot replace fresh provider byte evidence', async () => {
    for (const validator of [null, { kind: 'etag', value: 'W/"v1"' }]) {
        const observed = { ...proof, validator };
        const cache = new PrivateResumeHlsCache();
        assert.equal(await capture(cache, observed), false);
        const ranges = new FinitePlaybackRangeReuse();
        const handle = ranges.begin({ ...base, vodIdentityKey: id });
        assert.equal(handle.confirm(observed), false);
        assert.equal(handle.remember(0, Buffer.alloc(16)), false);
    }
});

test('malformed VOD identity fails closed while the legacy caller remains compatible', () => {
    for (const vodIdentityKey of ['bad', 0, false, null, {}]) {
        assert.equal(privateResumeBinding({ ...base, vodIdentityKey }), null);
    }
    assert.ok(privateResumeBinding(base));
    assert.notEqual(privateResumeBinding(base).profileHash,
        privateResumeBinding({ ...base, vodIdentityKey: id }).profileHash);
});
