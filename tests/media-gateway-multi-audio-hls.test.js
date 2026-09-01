'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
    videoEncoderInputArgs,
    videoEncoderOutputArgs,
} = require('../services/media-gateway/src/video-encoder');

const ROOT = path.join(__dirname, '..');
const GATEWAY_PATH = path.join(ROOT, 'services/media-gateway/src/index.js');
const gatewaySource = fs.readFileSync(GATEWAY_PATH, 'utf8').replace(/\r\n/g, '\n');
const plain = (value) => JSON.parse(JSON.stringify(value));

function sourceBetween(startMarker, endMarker) {
    const start = gatewaySource.indexOf(startMarker);
    const end = gatewaySource.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `source block not found: ${startMarker}`);
    return gatewaySource.slice(start, end);
}

function exactMkvSession(audioTracks, overrides = {}) {
    return {
        sourceUrl: 'https://provider.example/movie/account/fixture.mkv',
        codecProfileSource: 'request',
        playbackHint: { streamType: 'movie', container: 'mkv' },
        audioStreamIndex: null,
        codecProfile: {
            container: 'matroska,webm',
            metadataComplete: true,
            durationSeconds: 7_200,
            fileSizeBytes: 1_234_567_890,
            videoCodec: 'h264',
            videoWidth: 1_920,
            videoHeight: 1_080,
            audioTracks,
            subtitles: [],
            probeSource: 'gateway_inband',
            probedAt: '2026-08-16T00:00:00.000Z',
        },
        ...overrides,
    };
}

function loadPlanHarness() {
    const block = sourceBetween(
        'function multiAudioProfileAssessment(',
        '\nfunction audioArgsForSession(',
    );
    return vm.runInNewContext(
        `(() => { ${block}; return {
            multiAudioProfileAssessment,
            buildMultiAudioHlsPlan,
            audioRenditionsForSession,
            multiAudioHlsDiagnosticsForSession,
            freezeMultiAudioHlsTopology,
        }; })()`,
        {
            MAX_MULTI_AUDIO_RENDITIONS: 12,
            MULTI_AUDIO_HLS_PROTOCOL: 1,
            MULTI_AUDIO_HLS_STARTUP_PROOF_SECONDS: 20,
            EXACT_MATROSKA_H264_MAX_WIDTH: 1_920,
            EXACT_MATROSKA_H264_MAX_HEIGHT: 1_080,
            EXACT_MATROSKA_H264_MAX_PIXELS: 1_920 * 1_080,
            EXACT_MATROSKA_H264_HLS_TARGET_SECONDS: 2,
            path,
            isFiniteMkvVodSession: (session) => (
                session?.playbackHint?.streamType === 'movie' &&
                /mkv|matroska/i.test(`${session?.playbackHint?.container} ${session?.codecProfile?.container}`)
            ),
            asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
            normalizeCodecToken: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
            stringOrNull: (value) => String(value || '').trim() || null,
            normalizeAudioStreamIndex: (value) => {
                const parsed = Number(value);
                return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1024 ? parsed : null;
            },
        },
    );
}

test('multi-audio plan is frozen from a complete exact profile with stable hls.js order', () => {
    const h = loadPlanHarness();
    const session = exactMkvSession([
        { index: 2, language: 'eng', title: 'English', codec: 'aac', channels: 6, default: false },
        { index: 5, language: 'fra', title: 'Français', codec: 'eac3', channels: 6, default: true },
        { index: 9, language: 'spa', title: 'Español', codec: 'dts', channels: 2, default: false },
    ], { audioStreamIndex: 9 });
    const plan = h.buildMultiAudioHlsPlan(session);
    session.multiAudioHls = plan;

    assert.equal(plan.enabled, true);
    assert.equal(plan.defaultHlsIndex, 0, 'the requested absolute stream index wins and leads the bounded cohort');
    assert.equal(plan.defaultStreamIndex, 9);
    assert.deepStrictEqual(plain(h.audioRenditionsForSession(session)), [
        { hlsIndex: 0, streamIndex: 9, language: 'spa', title: 'Español', sourceChannels: 2, outputChannels: 2, codec: 'aac' },
        { hlsIndex: 1, streamIndex: 5, language: 'fra', title: 'Français', sourceChannels: 6, outputChannels: 2, codec: 'aac' },
        { hlsIndex: 2, streamIndex: 2, language: 'eng', title: 'English', sourceChannels: 6, outputChannels: 2, codec: 'aac' },
    ]);
    assert.match(plan.varStreamMap, /^a:0,/);
    assert.match(plan.varStreamMap, /a:0,agroup:audio,language:spa,default:yes,name:audio_0/);
    assert.match(plan.varStreamMap, /v:0,agroup:audio,name:video$/);
    assert.equal((plan.varStreamMap.match(/default:yes/g) || []).length, 1);
    assert.deepStrictEqual(plain(h.multiAudioHlsDiagnosticsForSession(session)), {
        protocol: 1,
        enabled: true,
        reason: 'enabled',
        maxAudioRenditions: 12,
        sourceTrackCount: 3,
        preparedTrackCount: 3,
        masterPlaylist: 'playlist.m3u8',
        videoPlaylist: 'video.m3u8',
        defaultHlsIndex: 0,
        defaultStreamIndex: 9,
    });
});

test('multi-audio eligibility keeps every source track visible while bounding only the prepared HLS cohort', () => {
    const h = loadPlanHarness();
    const tracks = (count) => Array.from({ length: count }, (_, index) => ({
        index: index + 1,
        language: index % 2 ? 'fra' : 'eng',
        title: `Track ${index + 1}`,
        codec: 'aac',
        channels: 2,
        default: index === 0,
    }));

    assert.equal(h.buildMultiAudioHlsPlan(exactMkvSession(tracks(12))).enabled, true, 'cap is inclusive');
    assert.equal(h.buildMultiAudioHlsPlan(exactMkvSession(tracks(1))).reason, 'audio_track_count_below_minimum');
    const overCap = h.buildMultiAudioHlsPlan(exactMkvSession(tracks(13), { audioStreamIndex: 13 }));
    assert.equal(overCap.enabled, true);
    assert.equal(overCap.sourceTrackCount, 13);
    assert.equal(overCap.audioRenditions.length, 12);
    assert.equal(overCap.audioRenditions[0].streamIndex, 13, 'the requested track is always prepared');
    assert.equal(overCap.audioRenditions.some((track) => track.streamIndex === 1), true, 'the source default is retained');
    assert.equal(h.buildMultiAudioHlsPlan(exactMkvSession([
        ...tracks(1),
        { ...tracks(1)[0], title: 'Duplicate' },
    ])).reason, 'invalid_audio_tracks');
    assert.equal(h.buildMultiAudioHlsPlan(exactMkvSession(tracks(2), {
        codecProfile: { ...exactMkvSession(tracks(2)).codecProfile, fileSizeBytes: null },
    })).reason, 'profile_incomplete');
    assert.equal(h.buildMultiAudioHlsPlan(exactMkvSession(tracks(2), {
        codecProfileSource: 'request_flat',
    })).reason, 'profile_source_untrusted');
    assert.equal(h.buildMultiAudioHlsPlan(exactMkvSession(tracks(2), {
        codecProfile: {
            ...exactMkvSession(tracks(2)).codecProfile,
            videoWidth: 3_840,
            videoHeight: 2_160,
        },
    })).reason, 'video_dimensions_out_of_capacity');
    assert.equal(h.buildMultiAudioHlsPlan(exactMkvSession(tracks(2), {
        codecProfile: { ...exactMkvSession(tracks(2)).codecProfile, metadataComplete: false },
    })).enabled, false);
});

test('normal exact-size preflight freezes a reachable gateway-inband multi graph before spawn', () => {
    const h = loadPlanHarness();
    const session = exactMkvSession([
        { index: 2, language: 'eng', title: 'Provider label', codec: 'aac', channels: 2, default: true },
        { index: 5, language: 'fra', title: 'Provider label', codec: 'eac3', channels: 6 },
    ]);
    delete session.codecProfile.fileSizeBytes;
    session.outputDir = path.join(os.tmpdir(), 'norva-multi-freeze');
    session.playlistPath = path.join(session.outputDir, 'playlist.m3u8');
    session.startupTimings = {};
    session.hlsTargetSeconds = 4;
    session.minHlsStartupBufferSeconds = 10;

    assert.equal(h.buildMultiAudioHlsPlan(session).reason, 'profile_incomplete');
    session.codecProfile.fileSizeBytes = 987_654_321;
    const plan = h.freezeMultiAudioHlsTopology(session);
    assert.equal(plan.enabled, true);
    assert.equal(session.forceAlignedMultiAudioVideoEncode, true);
    assert.equal(session.hlsTargetSeconds, 2);
    assert.equal(session.minHlsStartupBufferSeconds, 20);
    assert.match(session.videoPlaylistPath, /video\.m3u8$/);

    const route = sourceBetween("app.post('/sessions'", "\n// Cross-device kill-switch");
    const boundedPumpIndex = route.indexOf('await ensureBoundedMkvInputPump(');
    const normalMissFreezeIndex = route.indexOf('freezeMultiAudioHlsTopology(session)', boundedPumpIndex);
    assert.ok(
        boundedPumpIndex >= 0 && normalMissFreezeIndex > boundedPumpIndex,
        'the exact size is attached before the graph freezes',
    );
    assert.ok(
        normalMissFreezeIndex < route.indexOf('startSessionWithProviderRetry('),
        'the graph freezes before any FFmpeg spawn',
    );
    assert.match(route, /forceAlignedMultiAudioVideoEncode === true[\s\S]*\? 'encode' : 'copy'/);
    assert.match(route, /multi_audio_aligned_hls/);
    const enrichment = sourceBetween('async function enrichSessionCodecProfileFromBoundedHeader(', '\nasync function stopBoundedMkvInputPump(');
    assert.match(enrichment, /exactLocal[\s\S]*fileSizeBytesForSession\(session\)[\s\S]*cacheCodecProfile\(session\.sourceUrl, exactLocal\)/);
});

test('one FFmpeg maps absolute input indexes to audio-only ordinals and keeps the one pipe pump', () => {
    const h = loadPlanHarness();
    const session = exactMkvSession([
        { index: 2, language: 'eng', title: 'English', codec: 'aac', channels: 6, default: true },
        { index: 5, language: 'fra', title: 'Français', codec: 'eac3', channels: 6 },
        { index: 9, language: 'spa', title: 'Español', codec: 'dts', channels: 2 },
    ], { audioStreamIndex: 5 });
    session.id = 'session-1';
    session.outputDir = path.join(os.tmpdir(), 'norva-multi-audio-args');
    session.playlistPath = path.join(session.outputDir, 'playlist.m3u8');
    session.hlsTargetSeconds = 2;
    session.forceExactMatroskaH264Reencode = false;
    session.forceAlignedMultiAudioVideoEncode = true;
    session.videoMode = 'encode';
    session.status = 'starting';
    session.logTail = '';
    session.multiAudioHls = h.buildMultiAudioHlsPlan(session);

    let spawnCount = 0;
    let capturedArgs = null;
    let capturedOptions = null;
    const fakeSpawn = (_binary, args, options) => {
        spawnCount += 1;
        capturedArgs = args;
        capturedOptions = options;
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.stdin.destroy = () => {};
        return child;
    };
    const startFfmpeg = vm.runInNewContext(
        `(${sourceBetween('function startFfmpeg(', '\nfunction seekArgsForSession(').trim()})`,
        {
            path,
            multiAudioHlsEnabled: (value) => value?.multiAudioHls?.enabled === true,
            inputProbeArgsForSession: () => [],
            shouldCopyAudio: () => { throw new Error('single-audio copy predicate must not run'); },
            audioArgsForSession: (_value, copyAudio) => {
                assert.equal(copyAudio, false);
                return ['-af', 'aresample=48000:async=1:first_pts=0', '-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2', '-b:a', '160k'];
            },
            audioMapForSession: () => { throw new Error('relative a:N input map must not run'); },
            normalizeAudioStreamIndex: (value) => Number(value),
            videoModeForSession: (value) => value.videoMode,
            videoEncoderInputArgs,
            videoEncoderOutputArgs,
            VIDEO_ENCODER_CONFIG: { backend: 'software' },
            vaapiHardwareDecodeCodecForSession: () => null,
            reserveVideoEncoderAdmission: () => true,
            releaseVideoEncoderAdmission: () => {},
            isFiniteMkvVodSession: () => true,
            usesFiniteMkvSeekBroker: () => false,
            finiteMkvLinearSeekBridgePlanForSession: () => null,
            usesSourceTimestampedCopySeek: () => false,
            seekArgsForSession: () => ({ preInputSeek: [], postInputSeek: [] }),
            appendSubtitleOutputs: () => {},
            asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
            spawn: fakeSpawn,
            FFMPEG_PATH: 'ffmpeg',
            proxyEnvFor: () => ({}),
            loopbackOnlyEnv: () => ({}),
            proxyKeyFromUrl: () => 'provider.example',
            sanitizeLog: (value) => value,
            appendLogTail: () => {},
            applyFiniteMkvSeekBrokerFailure: () => false,
            console: { warn() {}, error() {} },
            lastNonEmptyLine: () => '',
            wakePlaybackBlockedQueues: () => {},
            startBoundedMkvInputPump: () => ({
                controller: { abort() {} },
                promise: new Promise(() => {}),
                completed: false,
            }),
            stopChildProcess: async () => {},
            waitForPlaylist: async () => {},
            STARTUP_TIMEOUT_MS: 60_000,
            EXACT_MATROSKA_H264_HLS_TARGET_SECONDS: 2,
        },
    );

    startFfmpeg(session);
    assert.equal(spawnCount, 1);
    assert.equal(capturedOptions.stdio[0], 'pipe');
    const inputIndex = capturedArgs.indexOf('-i');
    assert.equal(capturedArgs[inputIndex + 1], 'pipe:0');
    assert.equal(capturedArgs.includes('-reconnect'), false, 'the bounded MKV pipe never reconnects inside FFmpeg');

    const maps = capturedArgs.flatMap((value, index) => value === '-map' ? [capturedArgs[index + 1]] : []);
    assert.deepStrictEqual(plain(maps), ['0:V:0', '0:5', '0:2', '0:9']);
    assert.equal(maps.some((value) => /^0:a:/i.test(value)), false);
    assert.equal(session.actualMappedAudioStreamIndex, 5);
    assert.equal(capturedArgs[capturedArgs.indexOf('-ac') + 1], '2');
    assert.equal(capturedArgs[capturedArgs.indexOf('-profile:a') + 1], 'aac_low');
    assert.equal(capturedArgs[capturedArgs.indexOf('-c:v') + 1], 'libx264');
    assert.equal(capturedArgs[capturedArgs.indexOf('-force_key_frames') + 1], 'expr:gte(t,n_forced*2)');
    assert.equal(capturedArgs[capturedArgs.indexOf('-hls_time') + 1], '2');
    assert.match(capturedArgs[capturedArgs.indexOf('-hls_segment_filename') + 1], /%v-%05d\.ts$/);
    assert.equal(capturedArgs[capturedArgs.indexOf('-master_pl_name') + 1], 'playlist.m3u8');
    assert.equal(capturedArgs[capturedArgs.indexOf('-var_stream_map') + 1], session.multiAudioHls.varStreamMap);
    assert.match(capturedArgs.at(-1), /%v\.m3u8$/);
});

function masterPlaylist(plan) {
    const media = plan.audioRenditions.map((rendition) => [
        '#EXT-X-MEDIA:TYPE=AUDIO',
        'GROUP-ID="group_audio"',
        `NAME="audio_${rendition.hlsIndex}"`,
        `DEFAULT=${rendition.hlsIndex === plan.defaultHlsIndex ? 'YES' : 'NO'}`,
        'AUTOSELECT=YES',
        `LANGUAGE="${rendition.language}"`,
        `URI="audio_${rendition.hlsIndex}.m3u8"`,
    ].join(','));
    return [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        ...media,
        '#EXT-X-STREAM-INF:BANDWIDTH=1200000,CODECS="avc1.64001f",AUDIO="group_audio"',
        'video.m3u8',
        '',
    ].join('\n');
}

test('master validation requires one video, every ordered audio rendition and one requested default', () => {
    const h = loadPlanHarness();
    const plan = h.buildMultiAudioHlsPlan(exactMkvSession([
        { index: 1, language: 'eng', title: 'English', codec: 'aac', channels: 2, default: true },
        { index: 4, language: 'fra', title: 'Français', codec: 'aac', channels: 2 },
    ], { audioStreamIndex: 4 }));
    const block = sourceBetween('function parseHlsAttributeList(', '\nfunction inspectHlsStartupPlaylist(');
    const inspect = vm.runInNewContext(
        `(() => { ${block}; return inspectMultiAudioMasterPlaylist; })()`,
        {
            path,
            normalizeHlsAudioLanguage: (value) => String(value || '').toLowerCase(),
            multiAudioHlsEnabled: () => true,
            mappedAudioStreamIndexForSession: () => null,
            isWithin: () => true,
            fsp: fs.promises,
        },
    );
    const master = masterPlaylist(plan);
    assert.deepStrictEqual(plain(inspect(master, plan)), {
        ready: true,
        reason: 'ready',
        audioRenditionCount: 2,
        videoRenditionCount: 1,
    });
    assert.equal(inspect(master.replace(/^#EXT-X-MEDIA:.*audio_1.*\n/m, ''), plan).ready, false);
    assert.equal(inspect(master.replace('DEFAULT=NO', 'DEFAULT=YES'), plan).reason, 'audio_default_mismatch');
    assert.equal(inspect(master.replace('URI="audio_0.m3u8"', 'URI="../audio_0.m3u8"'), plan).ready, false);
    assert.equal(inspect(master.replace('URI="audio_0.m3u8"', 'URI="//foreign.example/audio_0.m3u8"'), plan).ready, false);
    assert.equal(inspect(master.replace('video.m3u8', 'other.m3u8'), plan).reason, 'video_variant_contract_mismatch');
});

function mediaPlaylist(prefix, segmentCount = 3) {
    return [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        ...Array.from({ length: segmentCount }, (_, index) => [
            '#EXTINF:4.000000,',
            `${prefix}-${String(index).padStart(5, '0')}.ts`,
        ]).flat(),
        '',
    ].join('\n');
}

test('readiness waits for the video and every non-empty audio playlist and segment', async () => {
    const h = loadPlanHarness();
    const plan = h.buildMultiAudioHlsPlan(exactMkvSession([
        { index: 1, language: 'eng', title: 'English', codec: 'aac', channels: 2, default: true },
        { index: 4, language: 'fra', title: 'Français', codec: 'aac', channels: 2 },
    ]));
    const readinessBlock = sourceBetween('function parseHlsAttributeList(', '\nasync function stopSession(');
    const isWithin = (root, candidate) => {
        const relative = path.relative(path.resolve(root), path.resolve(candidate));
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    const waitForPlaylist = vm.runInNewContext(
        `(() => { ${readinessBlock}; return waitForPlaylist; })()`,
        {
            path,
            fs,
            fsp: fs.promises,
            normalizeHlsAudioLanguage: (value) => String(value || '').toLowerCase(),
            multiAudioHlsEnabled: (session) => session?.multiAudioHls?.enabled === true,
            mappedAudioStreamIndexForSession: () => null,
            multiAudioHlsDiagnosticsForSession: (session) => ({
                protocol: 1,
                enabled: true,
                reason: 'enabled',
                maxAudioRenditions: 12,
                sourceTrackCount: session.multiAudioHls.audioRenditions.length,
                preparedTrackCount: session.multiAudioHls.audioRenditions.length,
                masterPlaylist: 'playlist.m3u8',
                videoPlaylist: 'video.m3u8',
                defaultHlsIndex: session.multiAudioHls.defaultHlsIndex,
                defaultStreamIndex: session.multiAudioHls.defaultStreamIndex,
            }),
            isWithin,
            MIN_HLS_STARTUP_BUFFER_SECONDS: 10,
            MIN_HLS_STARTUP_SEGMENTS: 3,
            waitForVodInputRetry: async (_delay, signal) => !signal?.aborted,
            abortedVodInputPumpError: () => Object.assign(new Error('aborted'), { code: 'VOD_INPUT_ABORTED' }),
        },
    );

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-multi-ready-'));
    const playlistPath = path.join(dir, 'playlist.m3u8');
    const session = {
        status: 'starting',
        outputDir: dir,
        playlistPath,
        multiAudioHls: plan,
        startupTimings: {},
        minHlsStartupBufferSeconds: 20,
    };
    const writeSegments = (prefix, segmentCount = 3, emptyLast = false) => {
        for (let index = 0; index < segmentCount; index += 1) {
            fs.writeFileSync(
                path.join(dir, `${prefix}-${String(index).padStart(5, '0')}.ts`),
                Buffer.alloc(emptyLast && index === segmentCount - 1 ? 0 : 11 + index),
            );
        }
    };

    try {
        fs.writeFileSync(playlistPath, masterPlaylist(plan));
        fs.writeFileSync(path.join(dir, 'video.m3u8'), mediaPlaylist('video'));
        fs.writeFileSync(path.join(dir, 'audio_0.m3u8'), mediaPlaylist('audio_0'));
        writeSegments('video');
        writeSegments('audio_0');
        await assert.rejects(waitForPlaylist(session, 15), /Playlist timeout/, 'missing audio child blocks 201');

        fs.writeFileSync(path.join(dir, 'audio_1.m3u8'), mediaPlaylist('audio_1'));
        writeSegments('audio_1', 3, true);
        await assert.rejects(waitForPlaylist(session, 15), /Playlist timeout/, 'empty audio segment blocks 201');

        fs.writeFileSync(path.join(dir, 'audio_1-00002.ts'), Buffer.alloc(17));
        fs.writeFileSync(
            path.join(dir, 'audio_1.m3u8'),
            mediaPlaylist('audio_1').replace('audio_1-00000.ts', '//foreign.example/audio_1-00000.ts'),
        );
        await assert.rejects(waitForPlaylist(session, 15), /Playlist timeout/, 'network-path segment cannot alias a local basename');

        fs.writeFileSync(path.join(dir, 'audio_1.m3u8'), mediaPlaylist('audio_1'));
        await assert.rejects(
            waitForPlaylist(session, 15),
            /Playlist timeout/,
            'a fast 12-second prefix cannot prove sustained multi-audio production',
        );

        for (const prefix of ['video', 'audio_0', 'audio_1']) {
            fs.writeFileSync(path.join(dir, `${prefix}.m3u8`), mediaPlaylist(prefix, 5));
            writeSegments(prefix, 5);
        }
        await waitForPlaylist(session, 100);
        assert.equal(session.startupTimings.playlistSegmentCount, 5);
        assert.equal(session.startupTimings.multiAudioHls.ready, true);
        assert.deepStrictEqual(
            plain(session.startupTimings.multiAudioHls.audio.map(({ hlsIndex, streamIndex, segmentCount }) => ({
                hlsIndex, streamIndex, segmentCount,
            }))),
            [
                { hlsIndex: 0, streamIndex: 1, segmentCount: 5 },
                { hlsIndex: 1, streamIndex: 4, segmentCount: 5 },
            ],
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('master, child and init-map URIs are tokenized once without cross-origin leakage', () => {
    const block = sourceBetween('function controlledAudioRenditionName(', '\nfunction sanitizeLog(');
    const rewritePlaylistSegments = vm.runInNewContext(
        `(() => { ${block}; return rewritePlaylistSegments; })()`,
        {
            encodeURIComponent,
            path,
            multiAudioHlsEnabled: (session) => session?.multiAudioHls?.enabled === true,
            normalizeHlsAudioLanguage: (value) => String(value || '').toLowerCase() || 'und',
            parseHlsAttributeList: (line) => Object.fromEntries(
                Array.from(String(line).slice(String(line).indexOf(':') + 1).matchAll(/(?:^|,)([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi))
                    .map((match) => [match[1].toUpperCase(), match[2].replace(/^"|"$/g, '')]),
            ),
            controlledLocalPlaylistName: (value) => {
                const raw = String(value || '').split(/[?#]/, 1)[0];
                return /^[a-z0-9][a-z0-9_-]*\.m3u8$/i.test(raw) && raw === path.basename(raw) ? raw : null;
            },
        },
    );
    const playlist = [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio_0",URI="audio_0.m3u8"',
        '#EXT-X-MAP:URI="init.mp4?version=1#fragment"',
        'video.m3u8',
        'segment-00000.ts?part=1',
        'https://foreign.example/segment.ts',
        '//foreign.example/network-segment.ts',
        '../foreign-segment.ts',
        '',
    ].join('\n');
    const session = {
        multiAudioHls: {
            enabled: true,
            audioRenditions: [
                { hlsIndex: 0, language: 'eng', title: 'Untrusted provider title' },
            ],
        },
    };
    const rewritten = rewritePlaylistSegments(playlist, 'secret token', session);
    assert.match(rewritten, /NAME="ENG"/, 'hls.js receives a controlled language label instead of audio_0');
    assert.match(rewritten, /URI="audio_0\.m3u8\?token=secret%20token"/);
    assert.match(rewritten, /URI="init\.mp4\?version=1&token=secret%20token#fragment"/);
    assert.match(rewritten, /video\.m3u8\?token=secret%20token/);
    assert.match(rewritten, /segment-00000\.ts\?part=1&token=secret%20token/);
    assert.match(rewritten, /https:\/\/foreign\.example\/segment\.ts/);
    assert.doesNotMatch(rewritten, /foreign\.example\/segment\.ts\?token=/);
    assert.match(rewritten, /\/\/foreign\.example\/network-segment\.ts/);
    assert.doesNotMatch(rewritten, /network-segment\.ts\?token=/);
    assert.doesNotMatch(rewritten, /\.\.\/foreign-segment\.ts\?token=/);
    assert.equal(rewritePlaylistSegments(rewritten, 'secret token', session), rewritten, 'rewriting is idempotent');
});

test('child playlist serving is allowlisted, rewritten no-store, and rejects traversal', () => {
    const helperBlock = sourceBetween('function safeSessionArtifactName(', '\nfunction segmentContentType(');
    const helpers = vm.runInNewContext(
        `(() => { ${helperBlock}; return { safeSessionArtifactName, isAllowedSessionPlaylistName }; })()`,
        {
            path,
            multiAudioHlsEnabled: (session) => session?.multiAudioHls?.enabled === true,
        },
    );
    const session = {
        multiAudioHls: {
            enabled: true,
            videoPlaylistName: 'video.m3u8',
            audioRenditions: [{ hlsIndex: 0 }, { hlsIndex: 1 }],
        },
    };
    assert.equal(helpers.safeSessionArtifactName('../video.m3u8'), null);
    assert.equal(helpers.safeSessionArtifactName('..\\video.m3u8'), null);
    assert.equal(helpers.safeSessionArtifactName('video/child.m3u8'), null);
    assert.equal(helpers.isAllowedSessionPlaylistName(session, 'video.m3u8'), true);
    assert.equal(helpers.isAllowedSessionPlaylistName(session, 'audio_1.m3u8'), true);
    assert.equal(helpers.isAllowedSessionPlaylistName(session, 'unknown.m3u8'), false);

    const route = sourceBetween(
        "app.get('/sessions/:id/:file'",
        '\n\napp.use((err, req, res, next)',
    );
    assert.match(route, /safeSessionArtifactName\(req\.params\.file\)/);
    assert.match(route, /isAllowedSessionPlaylistName\(session, requested\)/);
    assert.match(route, /requested\.toLowerCase\(\)\.endsWith\('\.m3u8'\)[\s\S]*fsp\.readFile[\s\S]*Cache-Control', 'no-store'[\s\S]*rewritePlaylistSegments/);
    assert.match(route, /else|sendFile|return res\.sendFile/);
});

test('serialization, health and cleanup retain the bounded single-provider contract', () => {
    assert.match(gatewaySource, /multiAudioHls:\s*\{\s*protocol:\s*MULTI_AUDIO_HLS_PROTOCOL[\s\S]*maxAudioRenditions:\s*MAX_MULTI_AUDIO_RENDITIONS/);
    assert.ok((gatewaySource.match(/audioRenditions:\s*audioRenditionsForSession\(session\)/g) || []).length >= 3);
    const stop = sourceBetween('async function stopSession(', '\nasync function stopConflictingSourceSessions(');
    const pumpStopIndex = stop.indexOf('await stopBoundedMkvInputPump(session)');
    const bridgeStopIndex = stop.indexOf('await stopFiniteMkvLinearSeekBridge(session)');
    const ffmpegStopIndex = stop.indexOf('await stopChildProcess(child)');
    assert.ok(pumpStopIndex >= 0 && pumpStopIndex < bridgeStopIndex);
    assert.ok(bridgeStopIndex < ffmpegStopIndex);
    const retry = sourceBetween('async function startSessionWithProviderRetry(', '\nfunction normalizeFileSizeBytes(');
    assert.match(retry, /removeSessionDir\(session\.outputDir\)[\s\S]*fsp\.mkdir\(session\.outputDir/,
        'a local probe retry cannot reuse a stale master or rendition');
    assert.match(
        gatewaySource,
        /const pumpWritable\s*=\s*linearSeekBridge\s*\?\s*linearSeekBridge\.child\.stdin\s*:\s*child\.stdin;[\s\S]*inputPump\s*=\s*startBoundedMkvInputPump\(session, pumpWritable\)/,
        'one provider pump feeds either the local packet-copy bridge or the primary FFmpeg pipe',
    );
    assert.match(
        gatewaySource,
        /finiteMkvLinearSeekBridge:\s*\{[\s\S]*active:\s*finiteMkvLinearSeekBridges\.size[\s\S]*providerConnections:\s*0/,
        'health exposes the local bridge without attributing a second provider connection',
    );
    assert.match(gatewaySource, /upstream\.status === 458[\s\S]*PROVIDER_BUSY/,
        'the first upstream 458 remains terminal provider-busy evidence');
});
