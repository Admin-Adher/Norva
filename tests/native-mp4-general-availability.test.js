'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { allowsNativeMp4Capability } = require('../services/media-gateway/src/native-mp4-access-policy');
const { createNativeMp4Sessions } = require('../services/media-gateway/src/native-mp4-sessions');
const { useProviderHttpForward, parseHttpForwardAccounts } = require('../services/media-gateway/src/provider-http-forward-policy');
const crypto = require('node:crypto');
const edge = import('../supabase/functions/_shared/native-mp4-gateway-policy.mjs');
const sourceId = '12345678-1234-4234-a234-123456789012';
const sid = '12345678-1234-4234-a234-123456789013';
const uid = '12345678-1234-4234-a234-123456789014';
const now = Date.parse('2026-09-22T12:00:00Z');
const publicBaseUrl = 'https://media.example.test/gateway';
function profile(patch = {}) {
    return { codecProfile: { probeSource: 'gateway-probe', probedAt: new Date(now - 1000).toISOString(),
        container: 'mov,mp4,m4a,3gp,3g2,mj2', videoCodec: 'h264', videoPixelFormat: 'yuv420p',
        fileSizeBytes: 123456, durationSeconds: 120,
        audioTracks: [{ index: 1, codec: 'aac', profile: 'LC', channels: 2, default: true }],
        subtitles: [], ...patch } };
}
function claims(patch = {}) {
    return { v: 1, scope: 'native-browser-mp4', sid, uid, resumeSourceId: sourceId,
        url: 'https://new-provider.example.test/movie/account/password/123.mp4',
        fileSizeBytes: 123456, exp: Math.floor(now / 1000) + 900, ...patch };
}

test('new owned provider is eligible without any owner or source rollout allowlist', async () => {
    const { useNativeMp4Gateway, browserNativeMp4Proof } = await edge;
    assert.equal(useNativeMp4Gateway({ sourceId, itemType: 'movie', container: 'mp4' }), true);
    assert.deepEqual(browserNativeMp4Proof(profile(), {}, now), { fileSizeBytes: 123456, durationSeconds: 120 });
    for (const patch of [{ enabled: false }, { itemType: 'series' }, { itemType: 'live' },
        { sourceId: 'unowned request hint' }, { container: 'mkv' }]) {
        assert.equal(useNativeMp4Gateway({ sourceId, itemType: 'movie', container: 'mp4', ...patch }), false);
    }
});

test('unknown, stale and incompatible owned profiles keep the HLS adaptation lane', async () => {
    const { browserNativeMp4Proof } = await edge;
    assert.equal(browserNativeMp4Proof({}, profile(), now), null);
    for (const patch of [{ probeSource: 'request-hint' }, { probedAt: new Date(now - 15 * 86400_000).toISOString() },
        { probedAt: new Date(now + 1).toISOString() }, { container: 'matroska' }, { videoCodec: 'hevc' },
        { videoPixelFormat: 'yuv420p10le' }, { fileSizeBytes: 0 }, { audioTracks: [] },
        { audioTracks: [{ index: 1, codec: 'ac3', profile: 'LC', channels: 2 }] },
        { audioTracks: [{ index: 1, codec: 'aac', profile: 'HE-AAC', channels: 2 }] },
        { audioTracks: [{ index: 1, codec: 'aac', profile: 'LC', channels: 6 }] }]) {
        assert.equal(browserNativeMp4Proof(profile(patch), {}, now), null, JSON.stringify(patch));
    }
});

test('ambiguous audio and explicit alternate track or subtitle selection keep adaptation', async () => {
    const { browserNativeMp4Proof } = await edge;
    const first = profile().codecProfile.audioTracks[0];
    for (const audioTracks of [[null], [{ ...first, index: undefined }], [first, { ...first }],
        [{ ...first, default: false }, { ...first, index: 2 }], [first, { ...first, index: 2 }]]) {
        assert.equal(browserNativeMp4Proof(profile({ audioTracks }), {}, now), null);
    }
    for (const hint of [{ audioStreamIndex: 2 }, { audioStreamIndex: true }, { audioStreamIndex: '' },
        { subtitleStreamIndex: 0 }, { burnSubtitles: true }, { burn_subtitles: true }]) {
        assert.equal(browserNativeMp4Proof(profile(), hint, now), null);
    }
    assert.ok(browserNativeMp4Proof(profile(), { audioStreamIndex: '1' }, now));
});

test('grant is pinned to the chosen HTTPS gateway origin, path and opaque token', async () => {
    const { validNativeMp4Grant } = await edge;
    const grant = { protocol: 1, url: `${publicBaseUrl}/sessions/${sid}/native.mp4?token=${'a'.repeat(43)}` };
    assert.equal(validNativeMp4Grant(grant, sid, publicBaseUrl), true);
    assert.equal(validNativeMp4Grant(grant, sid), false);
    for (const url of [grant.url.replace('media.example.test', 'attacker.example.test'),
        grant.url.replace('https:', 'http:'), `${grant.url}&url=secret`, `${grant.url}&token=${'b'.repeat(43)}`,
        `${grant.url}#fragment`, grant.url.replace('/gateway/', '/other/'), grant.url.replace(sid, sourceId),
        grant.url.replace('https://', 'https://user:password@')]) {
        assert.equal(validNativeMp4Grant({ ...grant, url }, sid, publicBaseUrl), false, url);
    }
});

test('generic gateway admission keeps signed scope and exact movie binding', () => {
    const allowed = value => allowsNativeMp4Capability(value, { publicBaseUrl });
    assert.equal(allowed(claims()), true);
    assert.equal(allowed(claims({ url: 'http://unknown.example.test/vod/123.MP4?token=x' })), true);
    for (const path of ['/123.m4v', '/123.mkv', '/get.php?movie=123', '/vod/123']) {
        assert.equal(allowed(claims({ url: `https://unknown.example.test${path}` })), true);
    }
    for (const patch of [{ scope: 'raw' }, { uid: 'unknown' }, { resumeSourceId: '' }, { fileSizeBytes: '123456' },
        { url: 'ftp://unknown.example.test/123.mp4' },
        { url: 'https://user:password@unknown.example.test/123.mp4' }]) assert.equal(allowed(claims(patch)), false);
    assert.equal(allowsNativeMp4Capability(claims(), { publicBaseUrl, enabled: false }), false);
    assert.equal(allowsNativeMp4Capability(claims(), { publicBaseUrl: 'http://internal:8081' }), false);
});

for (const scope of ['native-browser-mp4', 'native-vod-recovery']) test(`${scope} sessions remain single-opening, owner-scoped and irrevocable`, async () => {
    let opens = 0, closes = 0;
    const sessions = createNativeMp4Sessions({ now: () => now,
        allows: value => allowsNativeMp4Capability(value, { publicBaseUrl }),
        open: async () => { opens += 1; return { close: async () => { closes += 1; } }; } });
    const entry = sessions.grant(claims({scope}));
    assert.throws(() => sessions.authorize(sid, 'b'.repeat(43)), { code: 'NATIVE_MP4_ACCESS_DENIED' });
    assert.equal(sessions.authorize(sid, entry.token), entry);
    await Promise.all([sessions.resource(entry), sessions.resource(entry)]);
    assert.equal(opens, 1);
    assert.equal(await sessions.revoke('another-owner', sid), 0);
    assert.equal(await sessions.revoke(entry.ownerHash, sid), 1);
    assert.equal(closes, 1);
    assert.throws(() => sessions.authorize(sid, entry.token), { code: 'NATIVE_MP4_SESSION_EXPIRED' });
    assert.throws(() => sessions.grant(claims({scope})), { code: 'NATIVE_MP4_SESSION_EXPIRED' });
});

test('native finite recovery accepts exact MKV or TS proof without relaxing browser codec proof', async () => {
    const { nativeVodFileProof, browserNativeMp4Proof } = await edge;
    for (const container of ['matroska,webm', 'mpegts', 'avi', 'mp4']) {
        const owned = profile({container,videoCodec:'hevc'});
        assert.deepEqual(nativeVodFileProof(owned, now), {fileSizeBytes:123456,durationSeconds:120});
        assert.equal(browserNativeMp4Proof(owned, {}, now), null);
    }
    for (const patch of [{probeSource:'caller'}, {probedAt:new Date(now-15*86400_000).toISOString()},
        {fileSizeBytes:0}, {fileSizeBytes:'123456'}, {container:'hls'}, {container:'unknown'}]) {
        assert.equal(nativeVodFileProof(profile(patch), now), null);
    }
    assert.equal(nativeVodFileProof({}, now), null);
});

test('native generalization cannot force HTTP forwarding for unrelated accounts or HTTPS', () => {
    const selected = 'selected-provider-account';
    const accounts = parseHttpForwardAccounts(crypto.createHash('sha256').update(selected).digest('hex'));
    assert.equal(useProviderHttpForward(selected, 'http://provider.example.test/123.mp4', accounts), true);
    assert.equal(useProviderHttpForward(selected, 'https://provider.example.test/123.mp4', accounts), false);
    assert.equal(useProviderHttpForward('new-provider-account', 'http://provider.example.test/123.mp4', accounts), false);
    assert.equal(useProviderHttpForward(selected, 'http://provider.example.test/123.mkv', accounts), false);
});

test('native recovery accepts complete exact playback-produced profiles and rejects partial evidence', async () => {
    const { nativeVodFileProof } = await edge;
    for (const container of ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm']) {
        const observed = profile({container, probeSource:'gateway_inband', metadataComplete:true});
        assert.deepEqual(nativeVodFileProof(observed, now), {fileSizeBytes:123456,durationSeconds:120});
        for (const metadataComplete of [false, undefined]) {
            assert.deepEqual(nativeVodFileProof(profile({...observed.codecProfile, metadataComplete}), now), {fileSizeBytes:123456,durationSeconds:120});
        }
        for (const fileSizeBytes of [0, undefined, '123456']) {
            assert.equal(nativeVodFileProof(profile({...observed.codecProfile, fileSizeBytes}), now), null);
        }
    }
});
