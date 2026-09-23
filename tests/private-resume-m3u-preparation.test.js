'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { finiteVodStartupFormat } = require('../services/media-gateway/src/finite-vod-startup');
const source = fs.readFileSync(require.resolve('../services/media-gateway/src/index.js'), 'utf8');

function extracted(name, next, context) {
    const start = source.indexOf(name);
    const end = source.indexOf(next, start + name.length);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext('(' + source.slice(start, end).trim() + ')', context);
}

test('only admitted finite MP4 resumes without an exact size request bounded preparation', () => {
    const needs = extracted('function privateResumeNeedsMp4Preparation(', '\nfunction privateResumeFormat(', {
        canUsePrivateResumeCache: owner => owner === 'allowed', finiteVodStartupFormat,
        fileSizeBytesForSession: session => session?.codecProfile?.fileSizeBytes || null,
    });
    const input = { ownerKey: 'allowed', seekOffset: 12.5,
        playbackIdentity: { itemType: 'movie' }, playbackHint: { container: 'mp4' },
        codecProfile: { videoCodec: 'h264', audioCodec: 'aac' } };
    assert.equal(needs(input), true);
    assert.equal(needs({ ...input, codecProfile: { ...input.codecProfile, fileSizeBytes: 1000000 } }), false);
    assert.equal(needs({ ...input, ownerKey: 'other' }), false);
    assert.equal(needs({ ...input, seekOffset: 0 }), false);
    assert.equal(needs({ ...input, playbackIdentity: { itemType: 'live' } }), false);
    assert.equal(needs({ ...input, playbackHint: { container: 'mpegts' } }), false);
});

test('resumed MP4 with a drained header discovers the exact profile through its own seek broker', async () => {
    const session = { id: 'own-session', sourceUrl: 'https://provider.invalid/movie.mp4',
        retainedVodStartupFormat: 'mp4', seekOffset: 12.5, fileSizeBytes: 9000000,
        codecProfile: { videoCodec: 'h264' }, startupTimings: {} };
    const controller = new AbortController();
    const tracks = [{ index: 1, codec: 'aac' }, { index: 2, codec: 'aac' }];
    const subtitles = [{ index: 3, codec: 'subrip' }];
    const calls = [];
    const enrich = extracted('async function enrichRetainedFiniteVodProfile(',
        '\nasync function enrichSessionCodecProfileFromBoundedHeader(', {
            headerByteCache: new Map(), hasReliableVodCodecProfile: profile => Boolean(profile?.videoCodec),
            fileSizeBytesForSession: current => current.fileSizeBytes,
            prepareFiniteMkvSeekBroker: async (current, signal) => {
                assert.equal(current, session); assert.equal(signal, controller.signal);
                assert.equal(current.finiteMp4SeekBroker, true);
                calls.push('broker'); return { inputUrl: 'http://127.0.0.1/own-broker' };
            },
            probeCodecProfileUncached: async (url, agent, options) => {
                assert.equal(url, 'http://127.0.0.1/own-broker');
                assert.equal(options.loopbackBroker, true); assert.equal(options.signal, controller.signal);
                calls.push('probe'); return { videoCodec: 'h264', audioCodec: 'aac', audioTracks: tracks, subtitles };
            },
            mergeCodecProfiles: (base, observed) => ({ ...base, ...observed }),
            cacheCodecProfile: (url, profile) => { assert.equal(url, session.sourceUrl); calls.push('cache'); },
        });
    await enrich(session, controller.signal);
    assert.deepEqual(calls, ['broker', 'probe', 'cache']);
    assert.equal(session.retainedVodStartupFormat, null);
    assert.equal(session.codecProfile.fileSizeBytes, 9000000);
    assert.equal(session.codecProfile.audioTracks, tracks);
    assert.equal(session.codecProfile.subtitles, subtitles);
    assert.equal(session.startupTimings.retainedVodFallback, 'shared-seekable-broker');
});
