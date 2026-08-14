'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GATEWAY_PATH = 'services/media-gateway/src/index.js';
const readGateway = () => fs.readFileSync(path.join(ROOT, GATEWAY_PATH), 'utf8').replace(/\r\n/g, '\n');
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadGatewayFunction(name, nextName, globals = {}) {
    const source = readGateway();
    const start = source.indexOf(`function ${name}(`);
    let end = source.indexOf(`\nfunction ${nextName}(`, start);
    if (end < 0) end = source.indexOf(`\nasync function ${nextName}(`, start);
    assert.ok(start >= 0 && end > start, `${name} source not found`);
    return vm.runInNewContext(`(${source.slice(start, end).trim()})`, globals);
}

const gatewayGlobals = {
    asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    normalizeCodecToken: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
    stringOrNull: (value) => String(value || '').trim() || null,
    nullableInt: (value) => value === null || value === undefined || value === ''
        ? null
        : Number.parseInt(String(value), 10),
    KNOWN_VOD_INPUT_PROBE_FAST_PATH_ENABLED: true,
    selectedAudioTrackForSession: (session) => {
        const tracks = session.codecProfile?.audioTracks || [];
        if (Number.isInteger(session.audioStreamIndex)) {
            const selected = tracks.find((track) => Number(track.index) === session.audioStreamIndex);
            if (selected) return selected;
        }
        return tracks.find((track) => track.default === true) || tracks[0] || null;
    },
};

test('a reliable exact MP4 profile skips the duplicate full FFmpeg probe', () => {
    const knownVodInputProbeEligible = loadGatewayFunction(
        'knownVodInputProbeEligible',
        'isInsufficientInputProbeFailure',
        gatewayGlobals,
    );

    assert.strictEqual(knownVodInputProbeEligible({
        codecProfileSource: 'request',
        playbackHint: { container: 'mp4', streamType: 'movie' },
        codecProfile: {
            videoCodec: 'h264',
            audioCodec: 'aac',
            audioChannels: 2,
        },
    }), true);
    assert.strictEqual(knownVodInputProbeEligible({
        codecProfileSource: 'gateway_probe',
        playbackHint: { container: 'mkv', streamType: 'movie' },
        codecProfile: {
            videoCodec: 'h264',
            audioTracks: [{ index: 1, codec: 'aac', channels: 2 }],
        },
    }), true);
    assert.strictEqual(knownVodInputProbeEligible({
        codecProfileSource: 'request',
        playbackHint: { container: 'mp4', streamType: 'movie' },
        codecProfile: { videoCodec: 'h264' },
    }), false, 'a partial profile must retain the conservative probe budget');
    assert.strictEqual(knownVodInputProbeEligible({
        codecProfileSource: 'request_flat',
        playbackHint: { container: 'mp4', streamType: 'movie' },
        codecProfile: { videoCodec: 'h264', audioCodec: 'aac' },
    }), false, 'flattened hints are not an exact demux profile');
});

test('a partial request profile is completed once before FFmpeg chooses copy or transcode', () => {
    const hasReliableVodCodecProfile = loadGatewayFunction(
        'hasReliableVodCodecProfile',
        'hasUsefulCodecProfile',
        {
            asRecord: gatewayGlobals.asRecord,
            stringOrNull: gatewayGlobals.stringOrNull,
        },
    );

    assert.strictEqual(hasReliableVodCodecProfile({
        videoCodec: 'h264',
        audioCodec: 'mp3',
    }), true);
    assert.strictEqual(hasReliableVodCodecProfile({
        videoCodec: 'h264',
        audioTracks: [{ index: 1, codec: 'mp3' }],
    }), true);
    assert.strictEqual(hasReliableVodCodecProfile({
        audioTracks: [{ index: 1, codec: 'mp3' }],
    }), false, 'audio metadata alone must not authorize copying an unknown video codec');
    assert.strictEqual(hasReliableVodCodecProfile({ videoCodec: 'h264' }), false);

    const source = readGateway();
    assert.match(
        source,
        /requestCodecProfileReliable[\s\S]*\(!codecProfileSource\s*\|\|\s*!requestCodecProfileReliable\s*\|\|\s*shouldCompleteProfile\)/,
    );
});

test('Gateway readiness rejects a header-only or one-frame HLS playlist', () => {
    const inspectHlsStartupPlaylist = loadGatewayFunction(
        'inspectHlsStartupPlaylist',
        'waitForPlaylist',
        { path, MIN_HLS_STARTUP_BUFFER_SECONDS: 2 },
    );

    assert.deepStrictEqual(
        plain(inspectHlsStartupPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:0\n')),
        { ready: false, reason: 'no_segments', segmentCount: 0, durationSeconds: 0, firstSegment: null },
    );
    assert.deepStrictEqual(
        plain(inspectHlsStartupPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.100000,\nsegment-00000.ts\n')),
        { ready: false, reason: 'insufficient_duration', segmentCount: 1, durationSeconds: 0.1, firstSegment: 'segment-00000.ts' },
    );
    assert.deepStrictEqual(
        plain(inspectHlsStartupPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.004000,\nsegment-00000.ts\n')),
        { ready: true, reason: 'ready', segmentCount: 1, durationSeconds: 4.004, firstSegment: 'segment-00000.ts' },
    );

    const source = readGateway();
    assert.match(
        source,
        /waitForPlaylist[\s\S]*inspectHlsStartupPlaylist[\s\S]*stat[\s\S]*size\s*>\s*0/,
        'startup must wait for the finalized referenced segment to be non-empty',
    );
    assert.match(source, /startupTimings[\s\S]*playlistBufferSeconds/);
});

test('Gateway MPEG-TS HLS copies only AAC-LC stereo and transcodes MP3-family audio', () => {
    const isKnownBrowserSafeAudio = loadGatewayFunction(
        'isKnownBrowserSafeAudio',
        'isKnownUnsafeAudio',
        {
            hasHeAacMarker: (value) => /heaac|aache|mp4a\.40\.5|mp4a\.40\.29|sbr/i.test(
                String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
            ),
        },
    );

    assert.strictEqual(isKnownBrowserSafeAudio('aac', 'LC'), true);
    assert.strictEqual(isKnownBrowserSafeAudio('mp4a.40.2', 'AAC LC'), true);
    assert.strictEqual(isKnownBrowserSafeAudio('mp3', ''), false);
    assert.strictEqual(isKnownBrowserSafeAudio('opus', ''), false);
    assert.strictEqual(isKnownBrowserSafeAudio('vorbis', ''), false);
    assert.strictEqual(isKnownBrowserSafeAudio('aac', 'HE-AAC'), false);

    const shouldCopyAudio = loadGatewayFunction(
        'shouldCopyAudio',
        'shouldCopyVideo',
        {
            normalizeCodecToken: gatewayGlobals.normalizeCodecToken,
            nullableInt: gatewayGlobals.nullableInt,
            selectedAudioTrackForSession: gatewayGlobals.selectedAudioTrackForSession,
            isKnownUnsafeAudio: () => false,
            isKnownBrowserSafeAudio,
        },
    );
    assert.strictEqual(shouldCopyAudio({
        audioCodec: 'mp3',
        audioChannels: 2,
        clientAudioPassthrough: true,
    }), false, 'Beat Battle MP3 must be normalized to AAC for HLS');
    assert.strictEqual(shouldCopyAudio({
        audioCodec: 'aac',
        audioProfile: 'LC',
        audioChannels: 2,
        clientAudioPassthrough: true,
    }), true, 'proven AAC-LC stereo remains a zero-cost copy');

    const source = readGateway();
    assert.match(source, /TRANSCODE_AUDIO_ARGS[\s\S]*'-c:a', 'aac'[\s\S]*'-profile:a', 'aac_low'/);
});

test('an unknown finite MKV video fails safe to encoding while live remains copy-compatible', () => {
    const shouldCopyVideo = loadGatewayFunction(
        'shouldCopyVideo',
        'isKnownBrowserSafeVideo',
        {
            normalizeCodecToken: gatewayGlobals.normalizeCodecToken,
            isLiveSession: (session) => session?.playbackHint?.streamType === 'live',
            isKnownBrowserSafeVideo: (codec) => /h264|avc/i.test(String(codec || '')),
        },
    );

    assert.strictEqual(shouldCopyVideo({
        playbackHint: { streamType: 'movie', container: 'mkv' },
        codecProfile: {},
    }), false, 'an unproven finite MKV must never be copied blindly into browser HLS');
    assert.strictEqual(shouldCopyVideo({
        playbackHint: { streamType: 'movie', container: 'mkv' },
        codecProfile: { videoCodec: 'h264' },
    }), true);
    assert.strictEqual(shouldCopyVideo({
        playbackHint: { streamType: 'movie', container: 'mkv' },
        codecProfile: { videoCodec: 'hevc' },
    }), false);
    assert.strictEqual(shouldCopyVideo({
        playbackHint: { streamType: 'live' },
        codecProfile: {},
    }), true, 'live keeps the existing non-probing compatibility path');
});

test('the first provider 458 seen by ffprobe is terminal while proxy 407 stays infrastructure', () => {
    const isFfprobeProviderBusyFailure = loadGatewayFunction(
        'isFfprobeProviderBusyFailure',
        'runFfprobe',
        {
            isProxyAuthenticationFailure: (value) => /407|proxy authentication/i.test(
                `${String(value?.message || value || '')}\n${String(value?.logTail || '')}`
            ),
        },
    );

    assert.strictEqual(isFfprobeProviderBusyFailure(
        new Error('Server returned 4XX Client Error, but not one of 40{0,1,3,4}')
    ), false, 'a generic FFmpeg 4xx summary must not invent a provider 458');
    assert.strictEqual(isFfprobeProviderBusyFailure(new Error('HTTP 458 max connections')), true);
    assert.strictEqual(isFfprobeProviderBusyFailure(new Error('HTTP error 407 Proxy Authentication Required')), false);
    const hiddenProxyFailure = new Error('Server returned 4XX Client Error, but not one of 40{0,1,3,4}');
    hiddenProxyFailure.logTail = 'HTTP error 407 Proxy Authentication Required';
    assert.strictEqual(isFfprobeProviderBusyFailure(hiddenProxyFailure), false);

    const source = readGateway();
    assert.match(source, /if \(err\?\.status === 458[\s\S]*code: 'PROVIDER_BUSY'[\s\S]*upstreamStatus: 458/);
    assert.match(source, /if \(err\?\.code === 'PROXY_AUTH_FAILED'[\s\S]*networkCause: 'proxy_auth'/);
});
