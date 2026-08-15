'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function indexedTracks(count, start = 0) {
    return Array.from({ length: count }, (_, index) => ({ index: start + index }));
}

function loadMediaUtils() {
    const window = {};
    // eslint-disable-next-line no-new-func
    new Function('window', read('public/js/utils/mediaUtils.js'))(window);
    return window.MediaUtils;
}

function loadNorvaEngine() {
    const window = {};
    const sandbox = {
        window,
        self: window,
        document: { createElement: () => ({}) },
        navigator: { userAgent: 'node-test' },
        performance,
        console,
        URL,
        fetch,
        AbortController,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        TextDecoder,
        crypto: globalThis.crypto,
    };
    vm.createContext(sandbox);
    vm.runInContext(read('public/js/norvaEngine.js'), sandbox, { filename: 'norvaEngine.js' });
    return window.NorvaEngine;
}

test('playback hint carries only unique exact-file track counts', () => {
    const MediaUtils = loadMediaUtils();
    const hint = MediaUtils.playbackHintFromItem({
        container_extension: 'mkv',
        audio_tracks_scope: 'file',
        audio_tracks: [
            ...indexedTracks(23, 1),
            { index: 1 },
            { index: null },
            {}
        ],
        subtitleTracksScope: 'file',
        subtitleTracks: indexedTracks(34, 40)
    });

    assert.strictEqual(hint.audioTrackCount, 23);
    assert.strictEqual(hint.subtitleTrackCount, 34);
});

test('title-level unions never become dense-file routing evidence', () => {
    const MediaUtils = loadMediaUtils();
    const hint = MediaUtils.playbackHintFromItem({
        container_extension: 'mkv',
        audio_tracks_scope: 'title',
        audio_tracks: indexedTracks(23, 1),
        subtitle_tracks_scope: 'title',
        subtitle_tracks: indexedTracks(34, 40)
    });

    assert.strictEqual(hint.audioTrackCount, undefined);
    assert.strictEqual(hint.subtitleTrackCount, undefined);
});

test('playback duration is normalized from item, codec profile, or TMDB runtime', () => {
    const MediaUtils = loadMediaUtils();
    assert.strictEqual(MediaUtils.playbackHintFromItem({ duration: '02:35:33' }).durationSeconds, 9333);
    assert.strictEqual(MediaUtils.playbackHintFromItem({
        codecProfile: { durationSeconds: 7205 }
    }).durationSeconds, 7205);
    assert.strictEqual(MediaUtils.playbackHintFromItem({
        tmdb: { runtime: 156 }
    }).durationSeconds, 9360);
});

test('playback hint carries the compact codec facts already known for the exact file', () => {
    const MediaUtils = loadMediaUtils();
    const hint = MediaUtils.playbackHintFromItem({
        container_extension: 'mkv',
        bit_rate: 9000000,
        codecProfile: {
            videoCodec: 'h264',
            audioCodec: 'eac3',
            audioProfile: 'E-AC-3',
            audioChannels: 6,
            bitRate: 3200000,
            durationSeconds: 9333
        }
    });

    assert.deepStrictEqual(
        {
            videoCodec: hint.videoCodec,
            audioCodec: hint.audioCodec,
            audioProfile: hint.audioProfile,
            audioChannels: hint.audioChannels,
            bitRate: hint.bitRate,
            durationSeconds: hint.durationSeconds
        },
        {
            videoCodec: 'h264',
            audioCodec: 'eac3',
            audioProfile: 'E-AC-3',
            audioChannels: 6,
            bitRate: 3200000,
            durationSeconds: 9333
        }
    );
});

function loadGatewayFunction(name, nextName, globals = {}) {
    const source = read('services/media-gateway/src/index.js').replace(/\r\n/g, '\n');
    const start = source.indexOf(`function ${name}(`);
    let end = source.indexOf(`\nfunction ${nextName}(`, start);
    if (end < 0) end = source.indexOf(`\nasync function ${nextName}(`, start);
    assert.ok(start >= 0 && end > start, `${name} source not found`);
    return vm.runInNewContext(`(${source.slice(start, end).trim()})`, globals);
}

test('Gateway seek never mixes source-timestamped copied video with rebased encoded audio', () => {
    const usesSourceTimestampedCopySeek = loadGatewayFunction(
        'usesSourceTimestampedCopySeek',
        'observeSessionStartOffset',
        {
            shouldCopyVideo: () => true,
            shouldCopyAudio: () => true,
        }
    );
    const seekSession = { mode: 'remux', seekOffset: 384 };

    assert.strictEqual(
        usesSourceTimestampedCopySeek(seekSession, false, false),
        false,
        'AAC encoding must rebase copied video onto the same zero-based HLS timeline'
    );
    assert.strictEqual(
        usesSourceTimestampedCopySeek(seekSession, false, true),
        true,
        'a pure A/V copy seek may preserve timestamps for exact offset measurement'
    );
    assert.strictEqual(
        usesSourceTimestampedCopySeek(seekSession, true, true),
        false,
        'encoded video already uses the normalized session timeline'
    );
    assert.strictEqual(
        usesSourceTimestampedCopySeek({ ...seekSession, seekOffset: 0 }, false, true),
        false,
        'initial playback does not need source-timestamp preservation'
    );
});

test('only a proven exact subtitle map, including an empty one, suppresses the cold Gateway track probe', () => {
    const shouldProbeMissingSubtitleTracks = loadGatewayFunction(
        'shouldProbeMissingSubtitleTracks',
        'shouldProbeCodecProfile',
        {
            asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
            nullableInt: (value) => value === null || value === undefined || value === ''
                ? null
                : Number.parseInt(String(value), 10),
            stringOrNull: (value) => String(value || '').trim() || null,
            path,
            URL
        }
    );
    const profile = { videoCodec: 'h264', audioCodec: 'eac3' };

    assert.strictEqual(
        shouldProbeMissingSubtitleTracks(profile, {
            container: 'mkv',
            streamType: 'movie',
            subtitleTrackCount: 34
        }, 'https://provider.test/movie/2045146.mkv'),
        true,
        'a positive count still needs absolute indexes for selectable captions'
    );
    assert.strictEqual(
        shouldProbeMissingSubtitleTracks(profile, {
            container: 'mkv',
            streamType: 'movie',
            subtitleTrackCount: 0
        }, 'https://provider.test/movie/no-subs.mkv'),
        false,
        'an exact zero is authoritative too'
    );
    assert.strictEqual(
        shouldProbeMissingSubtitleTracks({
            ...profile,
            subtitles: [],
            probeSource: 'gateway_probe',
            probedAt: '2026-08-14T20:00:00.000Z'
        }, {
            container: 'mkv',
            streamType: 'movie'
        }, 'https://provider.test/movie/exact-no-subs.mkv'),
        false,
        'an exact empty subtitle map from the backfill must prevent a second provider probe'
    );
    assert.strictEqual(
        shouldProbeMissingSubtitleTracks({
            ...profile,
            subtitle_tracks: [],
            probe_source: 'gateway_probe',
            probed_at: '2026-08-14T20:00:00.000Z'
        }, {
            container: 'mkv',
            streamType: 'movie'
        }, 'https://provider.test/movie/exact-no-subs-alias.mkv'),
        false,
        'the persisted snake-case empty map is authoritative too'
    );
    assert.strictEqual(
        shouldProbeMissingSubtitleTracks({
            ...profile,
            subtitles: []
        }, {
            container: 'mkv',
            streamType: 'movie'
        }, 'https://provider.test/movie/normalized-partial-profile.mkv'),
        true,
        'normalization may synthesize an empty array; without probe provenance it is not authoritative'
    );
    assert.strictEqual(
        shouldProbeMissingSubtitleTracks(profile, {
            container: 'mkv',
            streamType: 'movie'
        }, 'https://provider.test/movie/unknown.mkv'),
        true,
        'unknown track metadata must retain the safe probe fallback'
    );
});

test('known exact VOD codecs select the bounded FFmpeg input probe fast path', () => {
    const knownVodInputProbeEligible = loadGatewayFunction(
        'knownVodInputProbeEligible',
        'isInsufficientInputProbeFailure',
        {
            asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
            normalizeCodecToken: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9.,]+/g, ''),
            stringOrNull: (value) => String(value || '').trim() || null,
            nullableInt: (value) => value === null || value === undefined || value === ''
                ? null
                : Number.parseInt(String(value), 10),
            KNOWN_VOD_INPUT_PROBE_FAST_PATH_ENABLED: true,
            selectedAudioTrackForSession: (session) => session.codecProfile?.audioTracks?.[0] || null
        }
    );

    assert.strictEqual(knownVodInputProbeEligible({
        codecProfileSource: 'request+gateway_probe',
        playbackHint: {
            container: 'mkv',
            audioTrackCount: 23,
            subtitleTrackCount: 34
        },
        codecProfile: {
            videoCodec: 'h264',
            audioTracks: [{ index: 1, codec: 'eac3' }]
        }
    }), true, 'a completed gateway probe remains detailed when supplementing a full request profile');
    assert.strictEqual(knownVodInputProbeEligible({
        codecProfileSource: 'gateway_probe',
        playbackHint: {
            container: 'mkv',
            audioTrackCount: 23,
            subtitleTrackCount: 34
        },
        codecProfile: { audioCodec: 'eac3' }
    }), false, 'unknown video codec must retain the conservative probe');
    assert.strictEqual(knownVodInputProbeEligible({
        codecProfileSource: 'gateway_probe',
        playbackHint: {
            container: 'mp4',
            audioTrackCount: 23,
            subtitleTrackCount: 34
        },
        codecProfile: {
            videoCodec: 'h264',
            audioTracks: [{ index: 1, codec: 'aac' }]
        }
    }), true, 'an exact MP4 profile must not pay the full FFmpeg discovery budget again');
    assert.strictEqual(knownVodInputProbeEligible({
        codecProfileSource: 'gateway_probe',
        playbackHint: {
            container: 'mkv',
            audioTrackCount: 8,
            subtitleTrackCount: 12
        },
        codecProfile: {
            videoCodec: 'h264',
            audioTracks: [{ index: 1, codec: 'aac' }]
        }
    }), true, 'an ordinary exact-file profile is as useful as a dense-file profile');
    assert.strictEqual(knownVodInputProbeEligible({
        codecProfileSource: 'request_flat',
        audioStreamIndex: 1,
        playbackHint: {
            container: 'mkv',
            audioTrackCount: 23,
            subtitleTrackCount: 34
        },
        codecProfile: {
            videoCodec: 'h264',
            audioCodec: 'eac3'
        }
    }), false, 'flattened routing hints are not a complete demux profile');
    assert.strictEqual(knownVodInputProbeEligible({
        codecProfileSource: 'gateway_probe',
        forceFullInputProbe: true,
        playbackHint: {
            container: 'mkv',
            audioTrackCount: 23,
            subtitleTrackCount: 34
        },
        codecProfile: {
            videoCodec: 'h264',
            audioTracks: [{ index: 1, codec: 'eac3' }]
        }
    }), false, 'the safe fallback must restore the full probe budget');

    const disabledFastPath = loadGatewayFunction(
        'knownVodInputProbeEligible',
        'isInsufficientInputProbeFailure',
        {
            asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
            normalizeCodecToken: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9.,]+/g, ''),
            stringOrNull: (value) => String(value || '').trim() || null,
            nullableInt: (value) => value === null || value === undefined || value === ''
                ? null
                : Number.parseInt(String(value), 10),
            KNOWN_VOD_INPUT_PROBE_FAST_PATH_ENABLED: false,
            selectedAudioTrackForSession: (session) => session.codecProfile?.audioTracks?.[0] || null
        }
    );
    assert.strictEqual(disabledFastPath({
        codecProfileSource: 'gateway_probe',
        playbackHint: {
            container: 'mkv',
            audioTrackCount: 23,
            subtitleTrackCount: 34
        },
        codecProfile: {
            videoCodec: 'h264',
            audioTracks: [{ index: 1, codec: 'eac3' }]
        }
    }), false, 'the environment kill switch must fail closed');
});

test('known-file FFmpeg fast path keeps a full-probe fallback for demux discovery failures', () => {
    const source = read('services/media-gateway/src/index.js').replace(/\r\n/g, '\n');
    const isInsufficientInputProbeFailure = loadGatewayFunction(
        'isInsufficientInputProbeFailure',
        'isLiveSession'
    );

    assert.strictEqual(isInsufficientInputProbeFailure({
        lastError: 'FFmpeg exited with code 1: Conversion failed!',
        logTail: "Stream map '0:8' matches no streams."
    }), true, 'the actionable FFmpeg diagnostic can live only in logTail');
    assert.strictEqual(isInsufficientInputProbeFailure({
        lastError: 'Connection timed out',
        logTail: ''
    }), false, 'provider failures must retain their own retry ladder');

    const audioMapForSession = loadGatewayFunction(
        'audioMapForSession',
        'selectedAudioTrackForSession',
        {
            nullableInt: (value) => value === null || value === undefined || value === ''
                ? null
                : Number.parseInt(String(value), 10),
            selectedAudioTrackForSession: (session) => session.codecProfile?.audioTracks?.[0] || null
        }
    );
    const exactSession = {
        codecProfile: { audioTracks: [{ index: 8, codec: 'eac3' }] }
    };
    assert.strictEqual(audioMapForSession(exactSession, true), '0:8');
    assert.strictEqual(audioMapForSession(exactSession, false), '0:8?');

    assert.match(source, /KNOWN_VOD_INPUT_ANALYZE_DURATION_US[\s\S]*2_000_000/);
    assert.match(source, /KNOWN_VOD_INPUT_PROBE_SIZE_BYTES[\s\S]*2_000_000/);
    assert.match(source, /forceFullInputProbe = true[\s\S]*known-profile input probe was insufficient/);
    assert.match(
        source,
        /requireKnownStreams\s*=\s*[\s\S]*session\.fastInputProbe === true[\s\S]*session\.forceFullInputProbe === true[\s\S]*audioMapForSession\(session, requireKnownStreams\)/,
        'the full-budget fallback must keep exact A/V maps required'
    );
    assert.match(source, /knownVodInputProbeFastPathEnabled: KNOWN_VOD_INPUT_PROBE_FAST_PATH_ENABLED/);
    assert.match(source, /startupTimings[\s\S]*inputProbeMode/);
});

function memoryStorage(seed = {}) {
    const values = new Map(Object.entries(seed));
    return {
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key)
    };
}

function loadCloudApi({ native = false, createSessionError = null, createSessionPayload = null } = {}) {
    const calls = [];
    const localStorage = memoryStorage({
        'norva-cloud-session': JSON.stringify({
            access_token: 'test-token',
            user: { id: 'user-1' }
        })
    });
    const sessionStorage = memoryStorage();
    const createSession = async (request) => {
        calls.push(request);
        if (createSessionError) throw createSessionError;
        const url = request.mode === 'transcode'
            ? 'https://gateway.test/sessions/test/playlist.m3u8'
            : request.mode === 'direct'
                ? 'https://provider.test/movie.mkv'
                : 'https://gateway.test/raw/test';
        const defaultPayload = {
            session: { id: `session-${calls.length}` },
            playback: { url },
            url
        };
        return typeof createSessionPayload === 'function'
            ? createSessionPayload(request, defaultPayload)
            : (createSessionPayload || defaultPayload);
    };
    const NorvaCloud = {
        playback: { createSession },
        device: { playback: { createSession } },
        entitlements: { isSubscriptionError: () => false },
        regions: { resolve: () => ({ region: 'FR' }) }
    };
    const window = {
        NorvaCloud,
        NorvaEngine: function NorvaEngine() {},
        ...(native ? { NodeCastNative: {} } : {}),
        innerWidth: 1280,
        innerHeight: 720,
        location: {
            hostname: 'norva.tv',
            origin: 'https://norva.tv',
            pathname: '/app',
            search: '',
            hash: '#movies',
            replace() {}
        },
        matchMedia: () => ({ matches: false })
    };
    const sandbox = {
        window,
        NorvaCloud,
        localStorage,
        sessionStorage,
        navigator: { userAgent: 'node-test' },
        location: window.location,
        URL,
        URLSearchParams,
        fetch: async () => { throw new Error('unexpected local fetch'); },
        console,
        setTimeout,
        clearTimeout,
        AbortController,
        Headers,
        Request,
        Response,
        crypto: globalThis.crypto,
        document: {
            documentElement: { classList: { contains: () => false } },
            body: { classList: { contains: () => false } },
            querySelector: () => null
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(read('public/js/api.js'), sandbox, { filename: 'api.js' });
    return { API: window.API, calls };
}

function loadMovieLaunchClasses({ API, MediaUtils }) {
    const document = {
        documentElement: { classList: { contains: () => false } },
        getElementById: () => null,
    };
    const context = {
        window: {},
        document,
        API,
        MediaUtils,
        Icons: { play: '' },
        console,
        setTimeout,
        clearTimeout,
    };
    vm.createContext(context);
    vm.runInContext(read('public/js/pages/HomePage.js'), context, { filename: 'HomePage.js' });
    vm.runInContext(read('public/js/pages/MoviesPage.js'), context, { filename: 'MoviesPage.js' });
    return {
        HomePage: context.window.HomePage,
        MoviesPage: context.window.MoviesPage,
    };
}

test('dense browser VOD uses Gateway remux with audio transcode and selected track', async () => {
    const { API, calls } = loadCloudApi();
    const playbackHint = loadMediaUtils().playbackHintFromItem({
        container_extension: 'mkv',
        tmdb: { runtime: 156 },
        codec_profile: {
            videoCodec: 'h264',
            audioCodec: 'eac3',
            audioChannels: 6,
            bitRate: 3000000,
        },
        audio_tracks_scope: 'file',
        audio_tracks: indexedTracks(23, 1),
        subtitle_tracks_scope: 'file',
        subtitle_tracks: indexedTracks(34, 40)
    });
    playbackHint.audioStreamIndex = 8;
    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        '2045146',
        'movie',
        'mkv',
        playbackHint
    );

    assert.strictEqual(result.mode, 'transcode');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'transcode');
    assert.strictEqual(calls[0].requiresTranscode, true);
    assert.strictEqual(calls[0].playbackHint.gatewayMode, 'remux');
    assert.strictEqual(calls[0].playbackHint.audioMode, 'transcode');
    assert.strictEqual(calls[0].playbackHint.audioTrackCount, 23);
    assert.strictEqual(calls[0].playbackHint.subtitleTrackCount, 34);
    assert.strictEqual(calls[0].playbackHint.durationSeconds, 9360);
    assert.strictEqual(calls[0].playbackHint.audioStreamIndex, 8);
});

test('dense track maps nested only in the exact codec profile still force Gateway', async () => {
    const { API, calls } = loadCloudApi();
    const playbackHint = loadMediaUtils().playbackHintFromItem({
        container_extension: 'mkv',
        codec_profile: {
            videoCodec: 'h264',
            audioCodec: 'aac',
            audioProfile: 'LC',
            audioChannels: 2,
            bitRate: 3000000,
            audioTracks: indexedTracks(23, 1),
            subtitles: indexedTracks(34, 100),
        },
    });

    assert.strictEqual(playbackHint.audioTrackCount, 23);
    assert.strictEqual(playbackHint.subtitleTrackCount, 34);

    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        'nested-dense-profile',
        'movie',
        'mkv',
        playbackHint
    );

    assert.strictEqual(result.mode, 'transcode');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'transcode');
    assert.strictEqual(calls[0].enginePipe, undefined);
    assert.strictEqual(calls[0].playbackHint.gatewayMode, 'remux');
    assert.strictEqual(calls[0].playbackHint.audioMode, undefined);
});

test('ordinary unknown MKV keeps one bounded Engine lane until exact codecs are known', async () => {
    const { API, calls } = loadCloudApi();
    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        'ordinary',
        'movie',
        'mkv',
        {
            audioTrackCount: 8,
            subtitleTrackCount: 12,
            audioStreamIndex: 3
        }
    );

    assert.strictEqual(result.mode, 'engine');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'relay');
    assert.strictEqual(calls[0].requiresTranscode, undefined);
    assert.strictEqual(calls[0].enginePipe, true);
    assert.strictEqual(calls[0].playbackHint.audioStreamIndex, 3);
});

test('a fresh probe replaces stale exact track maps even when the new maps are empty', () => {
    const mergeCodecProfiles = loadGatewayFunction(
        'mergeCodecProfiles',
        'shouldProbeMissingSubtitleTracks',
        {
            asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
            compactRecord: (value) => Object.fromEntries(
                Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
            )
        }
    );
    const base = {
        videoCodec: 'h264',
        audioTracks: [{ index: 1, codec: 'aac' }],
        subtitles: [{ index: 2, codec: 'subrip' }]
    };

    assert.deepStrictEqual(
        mergeCodecProfiles(base, {
            probeSource: 'gateway_probe',
            probedAt: '2026-08-14T20:00:00.000Z',
            audioTracks: [],
            subtitles: []
        }),
        {
            ...base,
            probeSource: 'gateway_probe',
            probedAt: '2026-08-14T20:00:00.000Z',
            audioTracks: [],
            subtitles: []
        },
        'an authoritative empty probe must remove stale audio and subtitle indexes'
    );
    assert.deepStrictEqual(
        mergeCodecProfiles(base, { videoProfile: 'High' }),
        { ...base, videoProfile: 'High' },
        'an omitted map must preserve the previous exact map'
    );
});

test('known low-bitrate H264 AAC MKV uses one bounded Engine range lane', async () => {
    const { API, calls } = loadCloudApi();
    const playbackHint = loadMediaUtils().playbackHintFromItem({
        container_extension: 'mkv',
        codec_profile: {
            videoCodec: 'h264',
            audioCodec: 'aac',
            audioProfile: 'LC',
            audioChannels: 2,
            bitRate: 3100000,
        },
    });
    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        'known-safe-mkv',
        'movie',
        'mkv',
        playbackHint
    );

    assert.strictEqual(result.mode, 'engine');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'relay');
    assert.strictEqual(calls[0].enginePipe, true);
    assert.strictEqual(calls[0].requiresTranscode, undefined);
    assert.strictEqual(calls[0].playbackHint.bitRate, 3100000);
    assert.strictEqual(calls[0].playbackHint.gatewayMode, undefined);
    assert.strictEqual(calls[0].playbackHint.audioMode, undefined);
});

test('the 3.2 Mbps boundary accepts exact H264 and AVC aliases on one Engine lane', async () => {
    const cases = [
        { videoCodec: 'h264', bitRateHint: { bitRate: 3200000 } },
        { videoCodec: 'H.264', bitRateHint: { bit_rate: '3200000' } },
        { videoCodec: 'avc', bitRateHint: { bitrate: 3200000 } },
        { videoCodec: 'avc1.640028', bitRateHint: { bitRate: 3200000 } },
    ];
    for (const { videoCodec, bitRateHint } of cases) {
        const { API, calls } = loadCloudApi();
        const playbackHint = loadMediaUtils().playbackHintFromItem({
            container_extension: 'mkv',
            codec_profile: {
                videoCodec,
                audioCodec: 'aac',
                audioProfile: 'LC',
                audioChannels: 2,
                ...bitRateHint,
            },
        });

        const result = await API.proxy.xtream.getStreamUrl(
            '00000000-0000-4000-8000-000000000001',
            `boundary-${videoCodec}`,
            'movie',
            'mkv',
            playbackHint
        );

        assert.strictEqual(result.mode, 'engine', `${videoCodec} must be accepted at the inclusive boundary`);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].mode, 'relay');
        assert.strictEqual(calls[0].enginePipe, true);
        assert.strictEqual(calls[0].playbackHint.bitRate, 3200000);
    }
});

test('the routing query normalizes bitRate, bit_rate, and bitrate aliases', async () => {
    for (const alias of ['bitRate', 'bit_rate', 'bitrate']) {
        const { API, calls } = loadCloudApi();
        const result = await API.proxy.xtream.getStreamUrl(
            '00000000-0000-4000-8000-000000000001',
            `query-alias-${alias}`,
            'movie',
            'mkv',
            {
                videoCodec: 'h264',
                audioCodec: 'aac',
                audioChannels: 2,
                [alias]: 3200000,
            }
        );

        assert.strictEqual(result.mode, 'engine', `${alias} must select Engine at the boundary`);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].mode, 'relay');
        assert.strictEqual(calls[0].enginePipe, true);
        assert.strictEqual(calls[0].playbackHint.bitRate, 3200000);
    }
});

test('high, missing, and invalid H264 MKV bitrates remain on one Gateway lane', async () => {
    const rejectedBitRates = [
        { label: 'above-boundary-camel', bitRateHint: { bitRate: 3200001 } },
        { label: 'above-boundary-snake', bitRateHint: { bit_rate: 3200001 } },
        { label: 'above-boundary-flat', bitRateHint: { bitrate: 3200001 } },
        { label: 'missing', bitRateHint: {} },
        { label: 'zero', bitRateHint: { bitRate: 0 } },
        { label: 'negative', bitRateHint: { bitRate: -1 } },
        { label: 'mixed-unit-string', bitRateHint: { bitRate: '3200000bps' } },
        { label: 'not-a-number', bitRateHint: { bitRate: 'not-a-number' } },
    ];

    for (const { label, bitRateHint } of rejectedBitRates) {
        const { API, calls } = loadCloudApi();
        const playbackHint = loadMediaUtils().playbackHintFromItem({
            container_extension: 'mkv',
            codec_profile: {
                videoCodec: 'h264',
                audioCodec: 'aac',
                audioProfile: 'LC',
                audioChannels: 2,
                ...bitRateHint,
            },
        });

        const result = await API.proxy.xtream.getStreamUrl(
            '00000000-0000-4000-8000-000000000001',
            `rejected-${label}`,
            'movie',
            'mkv',
            playbackHint
        );

        assert.strictEqual(result.mode, 'transcode', `${label} must stay on Gateway`);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].mode, 'transcode');
        assert.strictEqual(calls[0].requiresTranscode, true);
        assert.strictEqual(calls[0].enginePipe, undefined);
        assert.strictEqual(calls[0].playbackHint.gatewayMode, 'remux');
    }
});

test('a low flat item bitrate never substitutes for a missing exact-profile bitrate', async () => {
    const { API, calls } = loadCloudApi();
    const playbackHint = loadMediaUtils().playbackHintFromItem({
        container_extension: 'mkv',
        bit_rate: 2500,
        codec_profile: {
            videoCodec: 'h264',
            audioCodec: 'aac',
            audioProfile: 'LC',
            audioChannels: 2,
        },
    });

    assert.strictEqual(playbackHint.bitRate, undefined);
    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        'ambiguous-flat-bitrate',
        'movie',
        'mkv',
        playbackHint
    );

    assert.strictEqual(result.mode, 'transcode');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'transcode');
    assert.strictEqual(calls[0].requiresTranscode, true);
    assert.strictEqual(calls[0].enginePipe, undefined);
    assert.strictEqual(calls[0].playbackHint.gatewayMode, 'remux');
});

test('known low-bitrate HEVC MKV remains on the single Gateway conversion lane', async () => {
    const { API, calls } = loadCloudApi();
    const playbackHint = loadMediaUtils().playbackHintFromItem({
        container_extension: 'mkv',
        codec_profile: {
            videoCodec: 'hevc',
            audioCodec: 'eac3',
            audioChannels: 6,
            bitRate: 2500000,
        },
    });

    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        'known-hevc-mkv',
        'movie',
        'mkv',
        playbackHint
    );

    assert.strictEqual(result.mode, 'transcode');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'transcode');
    assert.strictEqual(calls[0].requiresTranscode, true);
    assert.strictEqual(calls[0].enginePipe, undefined);
    assert.strictEqual(calls[0].playbackHint.gatewayMode, 'remux');
    assert.strictEqual(calls[0].playbackHint.audioMode, 'transcode');
});

test('exact-file codecs override conflicting flat item annotations before routing', async () => {
    const { API, calls } = loadCloudApi();
    const playbackHint = loadMediaUtils().playbackHintFromItem({
        container_extension: 'mkv',
        videoCodec: 'h264',
        audioCodec: 'aac',
        audioProfile: 'LC',
        audioChannels: 2,
        codec_profile: {
            videoCodec: 'hevc',
            audioCodec: 'eac3',
            audioProfile: 'E-AC-3',
            audioChannels: 6,
            bitRate: 2500000,
        },
    });

    assert.strictEqual(playbackHint.videoCodec, 'hevc');
    assert.strictEqual(playbackHint.audioCodec, 'eac3');
    assert.strictEqual(playbackHint.audioProfile, 'E-AC-3');
    assert.strictEqual(playbackHint.audioChannels, 6);

    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        'exact-hevc-conflicts-with-flat-h264',
        'movie',
        'mkv',
        playbackHint
    );

    assert.strictEqual(result.mode, 'transcode');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'transcode');
    assert.strictEqual(calls[0].requiresTranscode, true);
    assert.strictEqual(calls[0].enginePipe, undefined);
    assert.strictEqual(calls[0].playbackHint.videoCodec, 'hevc');
    assert.strictEqual(calls[0].playbackHint.audioCodec, 'eac3');
});

test('a partial exact profile cannot combine with flat codecs to opt into Engine', async () => {
    const { API, calls } = loadCloudApi();
    const playbackHint = loadMediaUtils().playbackHintFromItem({
        container_extension: 'mkv',
        videoCodec: 'h264',
        codec_profile: {
            audioCodec: 'aac',
            bitRate: 2500000,
        },
    });

    assert.strictEqual(playbackHint.videoCodec, 'h264');
    assert.strictEqual(playbackHint.audioCodec, 'aac');
    assert.strictEqual(playbackHint.bitRate, undefined);

    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        'partial-profile-flat-codec',
        'movie',
        'mkv',
        playbackHint
    );

    assert.strictEqual(result.mode, 'transcode');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'transcode');
    assert.strictEqual(calls[0].enginePipe, undefined);
    assert.strictEqual(calls[0].playbackHint.gatewayMode, 'remux');
});

test('only the combined dense threshold excludes low-bitrate H264 MKV from Engine', async () => {
    for (const counts of [
        { audioTrackCount: 19, subtitleTrackCount: 30 },
        { audioTrackCount: 20, subtitleTrackCount: 29 },
    ]) {
        const { API, calls } = loadCloudApi();
        const result = await API.proxy.xtream.getStreamUrl(
            '00000000-0000-4000-8000-000000000001',
            `non-dense-${counts.audioTrackCount}-${counts.subtitleTrackCount}`,
            'movie',
            'mkv',
            {
                ...counts,
                videoCodec: 'h264',
                audioCodec: 'aac',
                audioChannels: 2,
                bitRate: 3000000,
            }
        );

        assert.strictEqual(result.mode, 'engine');
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].mode, 'relay');
        assert.strictEqual(calls[0].enginePipe, true);
    }
});

test('a selected grouped MKV keeps its exact codec profile and opens one Gateway remux lane', async () => {
    const MediaUtils = loadMediaUtils();
    const { API, calls } = loadCloudApi();
    const { HomePage, MoviesPage } = loadMovieLaunchClasses({ API, MediaUtils });
    const sourceId = '00000000-0000-4000-8000-000000000365';
    const exactProfile = {
        audioChannelLayout: '5.1(side)',
        audioChannels: 6,
        audioCodec: 'ac3',
        audioSampleRate: 48000,
        audioTracks: [
            { index: 1, codec: 'ac3', language: 'en', channels: 6, default: true },
            { index: 2, codec: 'ac3', language: 'fr', channels: 6 },
        ],
        bitRate: 8500000,
        container: 'matroska,webm',
        durationSeconds: 6600,
        probedAt: '2026-08-14T20:00:00.000Z',
        probeMs: 140,
        probeSource: 'gateway_probe',
        subtitles: [{ index: 3, codec: 'subrip', language: 'fr' }],
        videoCodec: 'h264',
        videoHeight: 1080,
        videoPixelFormat: 'yuv420p',
        videoProfile: 'High',
        videoWidth: 1920,
    };
    assert.strictEqual(Object.keys(exactProfile).length, 17, 'fixture mirrors the complete catalog profile');
    const catalogTitle = {
        item_type: 'movie',
        title: 'Le professionnel',
        name: 'Le professionnel',
        sourceId,
        source_id: sourceId,
        // A grouped title/default wrapper may carry the camel-case alias before
        // the selected exact variant overlays its authoritative DB-shaped alias.
        codecProfile: {},
        variants: [
            {
                source_id: sourceId,
                external_id: 'le-professionnel-default',
                raw_title: 'Le professionnel FHD 1994',
                container_extension: 'mkv',
                codec_profile: {},
            },
            {
                source_id: sourceId,
                external_id: 'leon-multi-fhd-1994',
                raw_title: 'Léon (MULTI) FHD 1994',
                container_extension: 'mkv',
                codec_profile: exactProfile,
                audio_tracks_scope: 'file',
                audio_tracks: exactProfile.audioTracks,
                subtitle_tracks_scope: 'file',
                subtitle_tracks: exactProfile.subtitles,
            },
        ],
    };

    const home = Object.create(HomePage.prototype);
    const group = home.buildHomeMediaGroup(catalogTitle, 'movie');
    const selected = group.items.find((item) => item.stream_id === 'leon-multi-fhd-1994');
    assert.ok(selected, 'the UI group must retain the selected exact variant');
    assert.strictEqual(selected.codecProfile && Object.keys(selected.codecProfile).length, 0);
    assert.strictEqual(selected.codec_profile.videoCodec, 'h264');

    let resolvedPlayback = null;
    const movies = Object.create(MoviesPage.prototype);
    movies.currentMovie = selected;
    movies.currentMovieVersions = group.items;
    movies.getMovieWatchState = () => ({ status: 'unwatched', resumeTime: 0, data: {} });
    movies.getSourceName = () => 'KING365';
    movies.getMovieDisplayTitle = () => 'Le professionnel';
    movies.getItemYear = () => 1994;
    movies.prepareForPlaybackSession = async () => {};
    movies.app = {
        player: { stop: async () => {} },
        pages: {
            watch: {
                releasePlaybackPipelineForRetry: async () => {},
                play: async (_content, resolver) => {
                    resolvedPlayback = await resolver();
                },
            },
        },
    };

    await movies.playPrimaryMovie();

    assert.ok(resolvedPlayback?.url, 'the selected variant must resolve a playable URL');
    assert.strictEqual(calls.length, 1, 'one click must create exactly one cloud session');
    assert.strictEqual(calls[0].itemId, 'leon-multi-fhd-1994');
    assert.strictEqual(calls[0].mode, 'transcode', 'the known MKV must select the Gateway transport');
    assert.strictEqual(calls[0].requiresTranscode, true);
    assert.strictEqual(calls[0].enginePipe, undefined, 'the known profile must not open the Engine lane');
    assert.strictEqual(calls[0].playbackHint.videoCodec, 'h264');
    assert.strictEqual(calls[0].playbackHint.audioCodec, 'ac3');
    assert.strictEqual(calls[0].playbackHint.bitRate, 8500000);
    assert.strictEqual(calls[0].playbackHint.gatewayMode, 'remux');
    assert.strictEqual(calls[0].playbackHint.audioMode, 'transcode');
});

test('playback hint skips empty aliases before every nested exact-profile casing', () => {
    const exactProfile = {
        videoCodec: 'h264',
        audioCodec: 'ac3',
        audioChannels: 6,
        durationSeconds: 6600,
    };
    for (const nested of [
        { playbackHint: { codecProfile: exactProfile } },
        { playbackHint: { codec_profile: exactProfile } },
        { playback_hint: { codecProfile: exactProfile } },
        { playback_hint: { codec_profile: exactProfile } },
    ]) {
        const playbackHint = loadMediaUtils().playbackHintFromItem({
            codecProfile: {},
            codec_profile: {},
            defaultVariant: { codecProfile: {}, codec_profile: {} },
            data: { codecProfile: {}, codec_profile: {} },
            ...nested,
        }, { container: 'mkv', streamType: 'movie' });

        assert.strictEqual(playbackHint.videoCodec, 'h264');
        assert.strictEqual(playbackHint.audioCodec, 'ac3');
        assert.strictEqual(playbackHint.audioChannels, 6);
        assert.strictEqual(playbackHint.durationSeconds, 6600);
    }
});

test('the selected exact variant profile reaches NorvaEngine through a client-only response channel', async () => {
    const MediaUtils = loadMediaUtils();
    const NorvaEngine = loadNorvaEngine();
    const sourceId = '00000000-0000-4000-8000-000000000365';
    const selectedId = 'betes-de-flic-fhd';
    const exactProfile = {
        videoCodec: 'h264',
        videoWidth: 1920,
        videoHeight: 1080,
        audioCodec: 'ac3',
        audioChannels: 2,
        audioSampleRate: 48000,
        audioTracks: [{ index: 1, codec: 'ac3', channels: 2, default: true }],
        subtitles: [],
        container: 'matroska,webm',
        durationSeconds: 5342.304,
        bitRate: 2_561_086,
        probeSource: 'gateway_probe',
        probedAt: '2026-08-15T04:42:00.000Z',
    };
    const siblingProfile = {
        ...exactProfile,
        videoCodec: 'hevc',
        bitRate: 8_500_000,
    };
    const selected = {
        sourceId,
        stream_id: selectedId,
        container_extension: 'mkv',
        // The selected row overlays the DB-shaped alias. The grouped camel-case
        // alias and default variant are deliberately not authoritative here.
        codecProfile: {},
        codec_profile: exactProfile,
        defaultVariant: {
            sourceId,
            stream_id: 'sibling-default',
            codecProfile: siblingProfile,
        },
        variants: [
            { sourceId, stream_id: 'sibling-default', codecProfile: siblingProfile },
            { sourceId, stream_id: selectedId, codec_profile: exactProfile },
        ],
    };
    const hint = MediaUtils.playbackHintFromItem(selected, { container: 'mkv', streamType: 'movie' });
    const { API, calls } = loadCloudApi({
        createSessionPayload: {
            session: { id: 'session-selected' },
            playback: { url: 'https://gateway.test/raw/selected', codecProfile: {} },
            codecProfile: {},
            url: 'https://gateway.test/raw/selected',
        },
    });

    const result = await API.proxy.xtream.getStreamUrl(sourceId, selectedId, 'movie', 'mkv', hint);
    const engine = new NorvaEngine({}, { codecProfile: result.codecProfile });

    assert.strictEqual(hint._clientCodecProfile, exactProfile,
        'the client channel must retain only the identity-matched selected variant');
    assert.strictEqual(result.codecProfile, exactProfile,
        'empty response aliases must not mask the selected exact catalog profile');
    assert.ok(engine._exactFastOpenProfile, 'the realistic exact profile must make fast-open eligible');
    assert.strictEqual(engine._exactFastOpenProfile.raw, exactProfile);
    assert.strictEqual(calls.length, 1, 'profile wiring must not create another playback lane');
    assert.strictEqual(calls[0].itemId, selectedId);
    assert.strictEqual(calls[0].playbackHint._clientCodecProfile, undefined,
        'the client-only profile must never enter the server playback hint');
    assert.strictEqual(calls[0].playbackHint.codecProfile, undefined);

    const siblingOnlyHint = MediaUtils.playbackHintFromItem({
        sourceId,
        stream_id: 'selected-without-profile',
        container_extension: 'mkv',
        codecProfile: siblingProfile,
        defaultVariant: {
            sourceId,
            stream_id: 'sibling-default',
            codecProfile: siblingProfile,
        },
        variants: [{ sourceId, stream_id: 'sibling-default', codecProfile: siblingProfile }],
        data: {
            sourceId,
            stream_id: 'selected-without-profile',
            codecProfile: siblingProfile,
        },
    }, { container: 'mkv', streamType: 'movie' });
    assert.strictEqual(siblingOnlyHint._clientCodecProfile, undefined,
        'neither a sibling nor grouped data may populate the client profile channel');

    const sourceLessNestedHint = MediaUtils.playbackHintFromItem({
        stream_id: 'source-less-selected',
        defaultVariant: {
            stream_id: 'source-less-selected',
            codecProfile: exactProfile,
        },
    }, { container: 'mkv', streamType: 'movie' });
    assert.strictEqual(sourceLessNestedHint._clientCodecProfile, undefined,
        'a nested/group match without both source identities is not exact-file evidence');

    const sourceLessDirectHint = MediaUtils.playbackHintFromItem({
        stream_id: 'source-less-direct',
        codecProfile: exactProfile,
    }, { container: 'mkv', streamType: 'movie' });
    assert.strictEqual(sourceLessDirectHint._clientCodecProfile, exactProfile,
        'an ungrouped selected file may still carry its profile directly');
});

test('a useful server profile outranks the selected client profile and keeps the runtime gate authoritative', async () => {
    const MediaUtils = loadMediaUtils();
    const NorvaEngine = loadNorvaEngine();
    const selectedProfile = {
        videoCodec: 'h264', videoWidth: 1920, videoHeight: 1080,
        audioCodec: 'ac3', audioChannels: 2, audioSampleRate: 48000,
        audioTracks: [{ index: 1, codec: 'ac3', channels: 2 }], subtitles: [],
        container: 'matroska,webm', durationSeconds: 5400, bitRate: 2_500_000,
        probeSource: 'gateway_probe', probedAt: '2026-08-15T04:42:00.000Z',
    };
    const serverProfile = {
        ...selectedProfile,
        videoCodec: 'hevc',
        probeSource: 'exact_file_probe',
        probedAt: '2026-08-15T05:10:00.000Z',
    };
    const hint = MediaUtils.playbackHintFromItem({
        sourceId: 'source-1',
        stream_id: 'selected-1',
        container_extension: 'mkv',
        codec_profile: selectedProfile,
    }, { container: 'mkv', streamType: 'movie' });
    const { API } = loadCloudApi({
        createSessionPayload: {
            session: { id: 'session-server-profile' },
            playback: { url: 'https://gateway.test/raw/server', codecProfile: serverProfile },
            codecProfile: {},
            url: 'https://gateway.test/raw/server',
        },
    });

    const result = await API.proxy.xtream.getStreamUrl('source-1', 'selected-1', 'movie', 'mkv', hint);
    const engine = new NorvaEngine({}, { codecProfile: result.codecProfile });

    assert.strictEqual(result.codecProfile, serverProfile,
        'a non-empty server profile must win even when an empty root alias precedes it');
    assert.strictEqual(engine._exactFastOpenProfile, null,
        'the Engine must reject the server-observed HEVC mismatch instead of trusting the client');
});

test('empty gateway and session wrappers cannot mask useful server profile aliases', async () => {
    const MediaUtils = loadMediaUtils();
    const clientProfile = {
        videoCodec: 'h264', videoWidth: 1920, videoHeight: 1080,
        audioCodec: 'ac3', audioTracks: [{ index: 1, codec: 'ac3' }], subtitles: [],
        container: 'matroska,webm', durationSeconds: 5400,
        probeSource: 'gateway_probe', probedAt: '2026-08-15T04:42:00.000Z',
    };
    const gatewayProfile = { ...clientProfile, videoCodec: 'hevc', probedAt: '2026-08-15T05:20:00.000Z' };
    const sessionProfile = { ...clientProfile, audioCodec: 'eac3', probedAt: '2026-08-15T05:30:00.000Z' };
    const hint = MediaUtils.playbackHintFromItem({
        sourceId: 'source-wrapper',
        stream_id: 'selected-wrapper',
        codecProfile: clientProfile,
    }, { container: 'mkv', streamType: 'movie' });

    for (const [payload, expected] of [
        [{
            url: 'https://gateway.test/raw/wrapper-gateway',
            playback: {
                url: 'https://gateway.test/raw/wrapper-gateway',
                gatewaySession: {},
                gateway_session: { codec_profile: gatewayProfile },
            },
            gatewaySession: {},
        }, gatewayProfile],
        [{
            url: 'https://gateway.test/raw/wrapper-session',
            session: {},
            playback: {
                url: 'https://gateway.test/raw/wrapper-session',
                session: { codecProfile: sessionProfile },
            },
        }, sessionProfile],
    ]) {
        const { API } = loadCloudApi();
        API.request = async () => payload;
        const result = await API.proxy.xtream.getStreamUrl(
            'source-wrapper', 'selected-wrapper', 'movie', 'mkv', hint
        );
        assert.strictEqual(result.codecProfile, expected);
    }
});

test('partial or untrusted selected profiles stay ineligible for Engine fast-open', async () => {
    const MediaUtils = loadMediaUtils();
    const NorvaEngine = loadNorvaEngine();
    const profiles = [
        { videoCodec: 'h264', audioCodec: 'ac3', container: 'matroska,webm' },
        {
            videoCodec: 'h264', videoWidth: 1920, videoHeight: 1080,
            audioCodec: 'ac3', audioTracks: [{ index: 1, codec: 'ac3' }], subtitles: [],
            container: 'matroska,webm', durationSeconds: 5400,
            probeSource: 'request_flat', probedAt: '2026-08-15T04:42:00.000Z',
        },
    ];

    for (const [index, profile] of profiles.entries()) {
        const itemId = `unsafe-${index}`;
        const hint = MediaUtils.playbackHintFromItem({
            sourceId: 'source-unsafe',
            stream_id: itemId,
            container_extension: 'mkv',
            codec_profile: profile,
        }, { container: 'mkv', streamType: 'movie' });
        const { API } = loadCloudApi();
        const result = await API.proxy.xtream.getStreamUrl('source-unsafe', itemId, 'movie', 'mkv', hint);
        const engine = new NorvaEngine({}, { codecProfile: result.codecProfile });

        assert.strictEqual(result.codecProfile, profile,
            `selected profile ${index} must reach the runtime gate without being upgraded or merged`);
        assert.strictEqual(engine._exactFastOpenProfile, null,
            `unsafe profile ${index} must retain the legacy stream-info path`);
    }
});

test('the full exact profile never enters the stream request URL', async () => {
    const MediaUtils = loadMediaUtils();
    const { API } = loadCloudApi();
    const exactProfile = {
        videoCodec: 'h264', videoWidth: 1920, videoHeight: 1080,
        audioCodec: 'ac3', audioChannels: 2, audioSampleRate: 48000,
        audioTracks: [{ index: 1, codec: 'ac3' }], subtitles: [],
        container: 'matroska,webm', durationSeconds: 5400, bitRate: 2_500_000,
        probeSource: 'gateway_probe', probedAt: '2026-08-15T04:42:00.000Z',
    };
    const hint = MediaUtils.playbackHintFromItem({
        sourceId: 'source-url',
        stream_id: 'selected-url',
        container_extension: 'mkv',
        codec_profile: exactProfile,
    }, { container: 'mkv', streamType: 'movie' });
    let endpoint = '';
    API.request = async (_method, requestedEndpoint) => {
        endpoint = requestedEndpoint;
        return { url: 'https://gateway.test/raw/url', playback: { url: 'https://gateway.test/raw/url' } };
    };

    const result = await API.proxy.xtream.getStreamUrl('source-url', 'selected-url', 'movie', 'mkv', hint);

    assert.strictEqual(result.codecProfile, exactProfile);
    assert.doesNotMatch(endpoint, /_clientCodecProfile|codecProfile|codec_profile|audioTracks|subtitles|%5Bobject|\[object/i);
    assert.ok(endpoint.length < 800, 'only compact scalar routing facts belong in the URL');
});

test('the app shell cache-busts the bitrate-aware MKV router and exact-profile resolver', () => {
    assert.match(read('public/app.html'), /\/js\/api\.js\?v=85/);
    assert.match(read('public/app.html'), /\/js\/utils\/mediaUtils\.js\?v=20/);
});

test('low-bitrate Engine MKV provider busy is terminal and never opens a second lane', async () => {
    const providerBusy = Object.assign(new Error('provider busy'), {
        status: 458,
        code: 'PROVIDER_BUSY'
    });
    const MediaUtils = loadMediaUtils();
    const { API, calls } = loadCloudApi({ createSessionError: providerBusy });
    const playbackHint = MediaUtils.playbackHintFromItem({
        sourceId: '00000000-0000-4000-8000-000000000001',
        stream_id: 'busy-mkv',
        container_extension: 'mkv',
        codecProfile: {
            videoCodec: 'h264', videoWidth: 1920, videoHeight: 1080,
            audioCodec: 'aac', audioChannels: 2, audioSampleRate: 48000,
            audioTracks: [{ index: 1, codec: 'aac', channels: 2 }], subtitles: [],
            container: 'matroska,webm', durationSeconds: 5400, bitRate: 3_000_000,
            probeSource: 'gateway_probe', probedAt: '2026-08-15T04:42:00.000Z',
        },
    }, { container: 'mkv', streamType: 'movie' });

    await assert.rejects(
        API.proxy.xtream.getStreamUrl(
            '00000000-0000-4000-8000-000000000001',
            'busy-mkv',
            'movie',
            'mkv',
            playbackHint
        ),
        (error) => error === providerBusy
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'relay');
    assert.strictEqual(calls[0].enginePipe, true);
    assert.strictEqual(calls[0].requiresTranscode, undefined);
    assert.strictEqual(calls[0].playbackHint.gatewayMode, undefined);
    assert.strictEqual(calls[0].playbackHint._clientCodecProfile, undefined);
});

test('explicit transcode keeps a low-bitrate H264 MKV on one Gateway lane', async () => {
    const { API, calls } = loadCloudApi();
    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        'explicit-transcode-mkv',
        'movie',
        'mkv',
        {
            mode: 'transcode',
            videoCodec: 'h264',
            audioCodec: 'aac',
            audioChannels: 2,
            bitRate: 3000000,
        }
    );

    assert.strictEqual(result.mode, 'transcode');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'transcode');
    assert.strictEqual(calls[0].requiresTranscode, true);
    assert.strictEqual(calls[0].enginePipe, undefined);
    assert.strictEqual(calls[0].playbackHint.gatewayMode, 'remux');
});

test('live MKV never enters the low-bitrate VOD Engine route', async () => {
    const { API, calls } = loadCloudApi();
    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        'live-mkv',
        'live',
        'mkv',
        {
            videoCodec: 'h264',
            audioCodec: 'aac',
            audioChannels: 2,
            bitRate: 3000000,
        }
    );

    assert.strictEqual(result.mode, 'transcode');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'transcode');
    assert.strictEqual(calls[0].requiresTranscode, true);
    assert.strictEqual(calls[0].enginePipe, undefined);
});

test('dense but browser-safe MP4 keeps the normal relay path', async () => {
    const { API, calls } = loadCloudApi();
    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        'dense-mp4',
        'movie',
        'mp4',
        {
            audioTrackCount: 23,
            subtitleTrackCount: 34,
            audioStreamIndex: 8,
            videoCodec: 'h264',
            audioCodec: 'aac',
            audioChannels: 2
        }
    );

    assert.strictEqual(result.mode, 'relay');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'relay');
    assert.strictEqual(calls[0].enginePipe, undefined);
    assert.strictEqual(calls[0].playbackHint.audioStreamIndex, 8);
});

test('unknown-codec MP4/M4V optimistically opens one relay lane and never pre-opens Gateway', async () => {
    for (const container of ['mp4', 'm4v']) {
        const { API, calls } = loadCloudApi();
        const result = await API.proxy.xtream.getStreamUrl(
            '00000000-0000-4000-8000-000000000001',
            `unknown-${container}`,
            'movie',
            container,
            {}
        );

        assert.strictEqual(result.mode, 'relay', `${container} must let the browser try its native fast path`);
        assert.strictEqual(calls.length, 1, `${container} must open exactly one upstream lane`);
        assert.strictEqual(calls[0].mode, 'relay');
        assert.strictEqual(calls[0].requiresTranscode, false);
        assert.strictEqual(calls[0].enginePipe, undefined);
        assert.strictEqual(calls[0].playbackHint.gatewayMode, 'remux');
    }
});

test('unknown-codec MOV remains on the bounded engine because it is not browser-safe', async () => {
    const { API, calls } = loadCloudApi();
    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        'unknown-mov',
        'movie',
        'mov',
        {}
    );

    assert.strictEqual(result.mode, 'engine');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'relay');
    assert.strictEqual(calls[0].enginePipe, true);
});

test('an optimistic relay HTTP 458 is terminal and never opens a Gateway session', async () => {
    const providerBusy = Object.assign(new Error('provider busy'), {
        status: 458,
        code: 'PROVIDER_BUSY'
    });
    const { API, calls } = loadCloudApi({ createSessionError: providerBusy });

    await assert.rejects(
        API.proxy.xtream.getStreamUrl(
            '00000000-0000-4000-8000-000000000001',
            'busy-unknown-mp4',
            'movie',
            'mp4',
            {}
        ),
        (error) => error === providerBusy
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'relay');
    assert.strictEqual(calls[0].enginePipe, undefined);
});

test('explicit conversion of an unknown-codec MP4 opens exactly one Gateway lane', async () => {
    const { API, calls } = loadCloudApi();
    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        'convert-unknown-mp4',
        'movie',
        'mp4',
        { mode: 'transcode', gatewayMode: 'remux' }
    );

    assert.strictEqual(result.mode, 'transcode');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'transcode');
    assert.strictEqual(calls[0].requiresTranscode, true);
    assert.strictEqual(calls[0].enginePipe, undefined);
});

test('dense VOD remains direct on a native player', async () => {
    const { API, calls } = loadCloudApi({ native: true });
    const result = await API.proxy.xtream.getStreamUrl(
        '00000000-0000-4000-8000-000000000001',
        '2045146',
        'movie',
        'mkv',
        {
            audioTrackCount: 23,
            subtitleTrackCount: 34,
            audioStreamIndex: 8
        }
    );

    assert.strictEqual(result.mode, 'direct');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mode, 'direct');
    assert.strictEqual(calls[0].playbackHint.audioStreamIndex, 8);
});
