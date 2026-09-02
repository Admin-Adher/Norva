'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
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

test('an authenticated VOD kind wins over an inaccurate provider URL suffix', () => {
    const source = readGateway();
    const liveStart = source.indexOf('function isLiveSession(');
    const liveEnd = source.indexOf('\n// An H.264 stream', liveStart);
    assert.ok(liveStart >= 0 && liveEnd > liveStart, 'isLiveSession source not found');
    const isLiveSession = vm.runInNewContext(
        `(${source.slice(liveStart, liveEnd).trim()})`,
        { asRecord: gatewayGlobals.asRecord, path, URL },
    );
    assert.strictEqual(isLiveSession({
        sourceUrl: 'https://provider.example/movie/account/file.ts',
        playbackHint: { streamType: 'movie', container: 'mkv' },
    }), false);
    assert.strictEqual(isLiveSession({
        sourceUrl: 'https://provider.example/live/account/channel.ts',
        playbackHint: { streamType: 'live' },
    }), true);
    assert.strictEqual(isLiveSession({
        sourceUrl: 'https://provider.example/channel.m3u8',
        playbackHint: {},
    }), true);

    const isFiniteMkvVodSession = loadGatewayFunction(
        'isFiniteMkvVodSession',
        'parseProviderFileSize',
        {
            asRecord: gatewayGlobals.asRecord,
            isLiveSession,
            normalizeCodecToken: gatewayGlobals.normalizeCodecToken,
            path,
            URL,
        },
    );
    assert.strictEqual(isFiniteMkvVodSession({
        sourceUrl: 'https://provider.example/movie/account/file.ts',
        playbackHint: { streamType: 'movie', container: 'mkv' },
        codecProfile: {},
    }), true);
});

test('Gateway readiness requires ten seconds and three finalized HLS segments', () => {
    const inspectHlsStartupPlaylist = loadGatewayFunction(
        'inspectHlsStartupPlaylist',
        'inspectMediaCacheLiveJoinGraph',
        { path, MIN_HLS_STARTUP_BUFFER_SECONDS: 10, MIN_HLS_STARTUP_SEGMENTS: 3 },
    );

    assert.deepStrictEqual(
        plain(inspectHlsStartupPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:0\n')),
        {
            ready: false,
            reason: 'no_segments',
            segmentCount: 0,
            durationSeconds: 0,
            firstSegment: null,
            segmentFiles: [],
            discontinuityCount: 0,
            mediaSequence: 0,
        },
    );
    assert.deepStrictEqual(
        plain(inspectHlsStartupPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.100000,\nsegment-00000.ts\n')),
        {
            ready: false,
            reason: 'insufficient_segments',
            segmentCount: 1,
            durationSeconds: 0.1,
            firstSegment: 'segment-00000.ts',
            segmentFiles: ['segment-00000.ts'],
            discontinuityCount: 0,
            mediaSequence: 0,
        },
    );

    const playlist = (durations, endList = false) => [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        ...durations.flatMap((duration, index) => [
            `#EXTINF:${duration.toFixed(6)},`,
            `segment-${String(index).padStart(5, '0')}.ts`,
        ]),
        ...(endList ? ['#EXT-X-ENDLIST'] : []),
        '',
    ].join('\n');

    assert.equal(inspectHlsStartupPlaylist(playlist([3.333, 3.333, 3.333])).reason, 'insufficient_duration');
    assert.equal(inspectHlsStartupPlaylist(playlist([3.33334, 3.33334, 3.33334])).ready, true,
        'comparison uses the unrounded duration at the exact ten-second boundary');
    assert.equal(inspectHlsStartupPlaylist(playlist([4.004, 4.004, 4.004])).ready, true,
        'the normal 4 s plan exposes three finalized segments (~12 s)');
    assert.equal(inspectHlsStartupPlaylist(playlist([2, 2, 2, 2, 2])).ready, true,
        'the exact-Matroska 2 s plan exposes five finalized segments');
    assert.equal(inspectHlsStartupPlaylist(playlist([4], true)).ready, true,
        'a genuinely complete short VOD is not forced to time out');

    const source = readGateway();
    assert.match(source, /MIN_HLS_STARTUP_BUFFER_SECONDS\s*=\s*clampInt\([^,]+,\s*10,\s*1,\s*180\)/);
    assert.match(source, /STARTUP_TIMEOUT_MS\s*=\s*clampInt\([^,]+,\s*60_000,\s*5_000,\s*180_000\)/);
    assert.match(source, /MIN_HLS_STARTUP_SEGMENTS\s*=\s*clampInt\([^,]+,\s*3,\s*1,\s*10\)/);
    assert.match(
        source,
        /waitForPlaylist[\s\S]*inspection\.segmentFiles[\s\S]*Promise\.all[\s\S]*stats\.every[\s\S]*size\s*>\s*0/,
        'startup must wait for every referenced buffered segment to exist and be non-empty',
    );
    assert.match(source, /startupTimings[\s\S]*playlistBufferSeconds/);
});

test('Gateway readiness materializes every segment in the ten-second buffer', async () => {
    const source = readGateway();
    const start = source.indexOf('function parseHlsAttributeList(');
    const end = source.indexOf('\nasync function stopSession(', start);
    assert.ok(start >= 0 && end > start);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-hls-ready-'));
    const isWithin = (root, candidate) => {
        const relative = path.relative(path.resolve(root), path.resolve(candidate));
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    };
    const harness = vm.runInNewContext(
        `(() => { ${source.slice(start, end)}; return { inspectHlsStartupPlaylist, waitForPlaylist }; })()`,
        {
            path,
            fs,
            fsp: fs.promises,
            sleep: async () => {},
            waitForVodInputRetry: async (_delayMs, signal) => !signal?.aborted,
            abortedVodInputPumpError: () => Object.assign(
                new Error('Finite MKV input pump was stopped'),
                { name: 'AbortError', code: 'VOD_INPUT_ABORTED' },
            ),
            isWithin,
            multiAudioHlsEnabled: () => false,
            exactSubtitleHlsEnabled: () => false,
            mappedAudioStreamIndexForSession: () => null,
            MIN_HLS_STARTUP_BUFFER_SECONDS: 10,
            MIN_HLS_STARTUP_SEGMENTS: 3,
        },
    );
    const playlistPath = path.join(dir, 'playlist.m3u8');
    fs.writeFileSync(playlistPath, [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        '#EXTINF:4.000000,', 'segment-00000.ts',
        '#EXTINF:4.000000,', 'segment-00001.ts',
        '#EXTINF:4.000000,', 'segment-00002.ts',
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'segment-00000.ts'), Buffer.alloc(11));
    fs.writeFileSync(path.join(dir, 'segment-00001.ts'), Buffer.alloc(13));
    const session = { outputDir: dir, playlistPath, startupTimings: {} };

    try {
        await assert.rejects(harness.waitForPlaylist(session, 15), /Playlist timeout/,
            'an absent final segment cannot be advertised');
        fs.writeFileSync(path.join(dir, 'segment-00002.ts'), Buffer.alloc(0));
        await assert.rejects(harness.waitForPlaylist(session, 15), /Playlist timeout/,
            'an empty final segment cannot be advertised');
        fs.writeFileSync(path.join(dir, 'segment-00002.ts'), Buffer.alloc(17));
        await harness.waitForPlaylist(session, 100);
        assert.equal(session.startupTimings.playlistSegmentCount, 3);
        assert.equal(session.startupTimings.playlistBufferSeconds, 12);
        assert.equal(session.startupTimings.firstSegmentBytes, 11);
        assert.equal(session.startupTimings.playlistSegmentBytes, 41);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Gateway readiness honors a proof-sized configured VOD window', () => {
    const inspectHlsStartupPlaylist = loadGatewayFunction(
        'inspectHlsStartupPlaylist',
        'inspectMediaCacheLiveJoinGraph',
        { path, MIN_HLS_STARTUP_BUFFER_SECONDS: 125, MIN_HLS_STARTUP_SEGMENTS: 3 },
    );
    const playlist = (count) => [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:2',
        ...Array.from({ length: count }, (_, index) => [
            '#EXTINF:2.000000,',
            `segment-${String(index).padStart(5, '0')}.ts`,
        ]).flat(),
        '',
    ].join('\n');

    assert.equal(inspectHlsStartupPlaylist(playlist(62)).reason, 'insufficient_duration');
    assert.equal(inspectHlsStartupPlaylist(playlist(63)).ready, true,
        'the browser is admitted only after the configured 125-second proof window exists');
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
            multiAudioHlsEnabled: () => false,
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
    assert.strictEqual(shouldCopyAudio({
        mkvH264FastStart: { eligible: true },
        mkvH264FastStartAudioAuthority: true,
        codecProfile: {
            audioTracks: [{ index: 1, codec: 'aac', profile: 'LC', channels: 2 }],
        },
        audioCodec: 'ac3',
        audioProfile: 'HE-AAC',
        audioChannels: 8,
        clientAudioPassthrough: true,
    }), true, 'fast-start audio copy is derived only from the proof-bound exact track');
    assert.strictEqual(shouldCopyAudio({
        mkvH264FastStart: { eligible: true },
        mkvH264FastStartAudioAuthority: true,
        codecProfile: {
            audioTracks: [{ index: 1, codec: 'ac3', profile: '', channels: 2 }],
        },
        audioCodec: 'aac',
        audioProfile: 'LC',
        audioChannels: 2,
        clientAudioPassthrough: true,
    }), false, 'proof-bound AC3 is transcoded even when mutable flat hints claim AAC-LC');
    assert.strictEqual(shouldCopyAudio({
        mkvH264FastStart: { eligible: true },
        mkvH264FastStartAudioAuthority: true,
        codecProfile: {
            audioTracks: [{ index: 1, codec: 'aac', profile: 'HE-AAC', channels: 2 }],
        },
        audioCodec: 'aac',
        audioProfile: 'LC',
        audioChannels: 2,
        clientAudioPassthrough: true,
    }), false, 'proof-bound HE-AAC remains on the AAC-LC normalization path');
    assert.strictEqual(shouldCopyAudio({
        mkvH264FastStart: { eligible: true },
        mkvH264FastStartAudioAuthority: true,
        codecProfile: {
            audioTracks: [{ index: 1, codec: 'aac', profile: 'LC', channels: 6 }],
        },
        clientAudioPassthrough: true,
    }), false, 'proof-bound multichannel AAC is normalized to stereo');

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

test('an exact finite Matroska H264 profile selects the 2s keyframe encode plan before provider I/O', () => {
    const shouldReencodeExactMatroskaH264 = loadGatewayFunction(
        'shouldReencodeExactMatroskaH264',
        'mkvH264FastStartProofForProfile',
        {
            asRecord: gatewayGlobals.asRecord,
            normalizeCodecToken: gatewayGlobals.normalizeCodecToken,
            EXACT_MATROSKA_H264_MAX_WIDTH: 1_920,
            EXACT_MATROSKA_H264_MAX_HEIGHT: 1_080,
            EXACT_MATROSKA_H264_MAX_PIXELS: 1_920 * 1_080,
            isLiveSession: (session) => ['live', 'channel'].includes(
                String(session?.playbackHint?.streamType || '').toLowerCase(),
            ),
        },
    );
    const exactMkvH264 = {
        sourceUrl: 'https://provider.example/movie/account/file.mkv',
        codecProfileSource: 'request',
        playbackHint: { streamType: 'movie' },
        codecProfile: {
            videoCodec: 'h264',
            videoWidth: 1_920,
            videoHeight: 1_080,
            audioCodec: 'aac',
            audioTracks: [{ index: 1, codec: 'aac', channels: 2 }],
            subtitles: [],
            container: 'matroska,webm',
            durationSeconds: 7_200,
            probeSource: 'gateway_probe',
            probedAt: '2026-08-15T00:00:00.000Z',
        },
    };

    assert.strictEqual(shouldReencodeExactMatroskaH264(exactMkvH264), true);
    assert.strictEqual(shouldReencodeExactMatroskaH264({
        ...exactMkvH264,
        codecProfileSource: 'gateway_probe',
    }), false, 'a decision made only after Gateway ffprobe is too late for the no-extra-provider-connection invariant');
    assert.strictEqual(shouldReencodeExactMatroskaH264({
        ...exactMkvH264,
        codecProfile: { ...exactMkvH264.codecProfile, probeSource: null },
    }), false, 'an unproven client hint must not force an expensive encode');
    assert.strictEqual(shouldReencodeExactMatroskaH264({
        ...exactMkvH264,
        codecProfile: { ...exactMkvH264.codecProfile, audioTracks: undefined },
    }), false, 'a partial profile must stay on the existing conservative route');
    assert.strictEqual(shouldReencodeExactMatroskaH264({
        ...exactMkvH264,
        playbackHint: { streamType: 'live' },
    }), false, 'live streams are excluded');
    assert.strictEqual(shouldReencodeExactMatroskaH264({
        ...exactMkvH264,
        codecProfile: { ...exactMkvH264.codecProfile, videoCodec: 'hevc' },
    }), false, 'HEVC already follows the ordinary video-transcode path');
    assert.strictEqual(shouldReencodeExactMatroskaH264({
        ...exactMkvH264,
        codecProfile: { ...exactMkvH264.codecProfile, container: 'mov,mp4,m4a,3gp,3g2,mj2' },
    }), false, 'MP4 remains on its existing route');
    assert.strictEqual(shouldReencodeExactMatroskaH264({
        ...exactMkvH264,
        codecProfile: { ...exactMkvH264.codecProfile, videoWidth: 3_840, videoHeight: 2_160 },
    }), false, '4K must not enter the CPU-expensive route without a dedicated capacity proof');
    assert.strictEqual(shouldReencodeExactMatroskaH264({
        ...exactMkvH264,
        codecProfile: { ...exactMkvH264.codecProfile, videoWidth: undefined },
    }), false, 'unknown dimensions fail closed instead of risking an unbounded encode');

    const source = readGateway();
    const decision = source.indexOf('const forceExactMatroskaH264Reencode = shouldReencodeExactMatroskaH264(');
    const providerProbe = source.indexOf('const probedCodecProfile = await probeCodecProfile(');
    const providerFfmpeg = source.indexOf('const started = await startSessionWithProviderRetry(');
    assert.ok(decision >= 0 && decision < providerProbe && decision < providerFfmpeg,
        'the exact-profile route must be frozen before ffprobe or FFmpeg can connect to the provider');
    const initialFiniteMkv = source.indexOf('const finiteMkvPlaybackAtRequest = isFiniteMkvVodSession(');
    const effectiveFiniteMkv = source.indexOf('finiteMkvPlayback = isFiniteMkvVodSession(', initialFiniteMkv + 1);
    assert.ok(initialFiniteMkv > decision && initialFiniteMkv < providerProbe,
        'the declared finite-MKV lane must be known before any provider probe');
    assert.ok(effectiveFiniteMkv > providerProbe && effectiveFiniteMkv < providerFfmpeg,
        'cache/in-band Matroska evidence must be applied before mode selection and FFmpeg startup');
});

test('exact Matroska H264 uses independent 2s HLS segments with forced keyframes and no split-by-time', () => {
    const source = readGateway();

    assert.match(source, /const GATEWAY_VERSION = 155;/);
    assert.match(source, /exactMatroskaH264ReencodeProtocol:\s*1/);
    assert.match(source, /exactMatroskaH264HlsTargetSeconds:\s*EXACT_MATROSKA_H264_HLS_TARGET_SECONDS/);
    assert.match(source, /exactMatroskaH264MaxPixels:\s*EXACT_MATROSKA_H264_MAX_PIXELS/);
    assert.match(source, /videoEncoderOutputArgs\(VIDEO_ENCODER_CONFIG,[\s\S]*forceAligned:\s*forceAlignedHlsVideoEncode[\s\S]*targetSeconds:\s*session\.hlsTargetSeconds\s*\|\|\s*4/);
    const encoder = fs.readFileSync(path.join(ROOT, 'services/media-gateway/src/video-encoder.js'), 'utf8');
    assert.match(encoder, /'-force_key_frames',\s*`expr:gte\(t,n_forced\*\$\{boundedTargetSeconds\}\)`/);
    assert.match(source, /'-hls_time',\s*String\(session\.hlsTargetSeconds\s*\|\|\s*4\)/);
    assert.match(source, /'-hls_flags',\s*'independent_segments\+temp_file'/);
    assert.doesNotMatch(source, /split_by_time/);
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
