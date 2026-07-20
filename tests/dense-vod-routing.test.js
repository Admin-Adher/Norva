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

function memoryStorage(seed = {}) {
    const values = new Map(Object.entries(seed));
    return {
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key)
    };
}

function loadCloudApi({ native = false } = {}) {
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
        const url = request.mode === 'transcode'
            ? 'https://gateway.test/sessions/test/playlist.m3u8'
            : request.mode === 'direct'
                ? 'https://provider.test/movie.mkv'
                : 'https://gateway.test/raw/test';
        return {
            session: { id: `session-${calls.length}` },
            playback: { url },
            url
        };
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

test('dense browser VOD uses Gateway remux with audio transcode and selected track', async () => {
    const { API, calls } = loadCloudApi();
    const playbackHint = loadMediaUtils().playbackHintFromItem({
        container_extension: 'mkv',
        tmdb: { runtime: 156 },
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

test('ordinary multi-audio VOD stays on the browser engine', async () => {
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
    assert.strictEqual(calls[0].enginePipe, true);
    assert.strictEqual(calls[0].playbackHint.audioStreamIndex, 3);
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
