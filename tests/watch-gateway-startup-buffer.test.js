'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WATCH_PATH = path.join(ROOT, 'public/js/pages/WatchPage.js');
const source = fs.readFileSync(WATCH_PATH, 'utf8').replace(/\r\n/g, '\n');

function loadMethod(name, nextName, globals = {}) {
    const starts = [
        source.indexOf(`    ${name}(`),
        source.indexOf(`    async ${name}(`),
    ].filter(index => index >= 0);
    const start = starts.length ? Math.min(...starts) : -1;
    const ends = [
        source.indexOf(`\n    ${nextName}(`, start),
        source.indexOf(`\n    async ${nextName}(`, start),
    ].filter(index => index > start);
    const end = ends.length ? Math.min(...ends) : -1;
    assert.ok(start >= 0 && end > start, `${name} source not found`);
    return vm.runInNewContext(`({${source.slice(start, end).trim()}}).${name}`, {
        setTimeout,
        ...globals,
    });
}

test('Gateway buffered-ahead measurement uses only the range containing currentTime', () => {
    const gatewayBufferedAheadSeconds = loadMethod(
        'gatewayBufferedAheadSeconds',
        'waitForGatewayStartupBuffer',
    );
    const page = {
        video: {
            currentTime: 10,
            buffered: {
                length: 3,
                start: (index) => [0, 9.9, 80][index],
                end: (index) => [5, 34.5, 120][index],
            },
        },
    };

    assert.equal(gatewayBufferedAheadSeconds.call(page), 24.5);
});

test('Gateway buffered-ahead measurement fails closed when live TimeRanges mutates', () => {
    const gatewayBufferedAheadSeconds = loadMethod(
        'gatewayBufferedAheadSeconds',
        'waitForGatewayStartupBuffer',
    );
    const page = {
        video: {
            currentTime: 10,
            buffered: {
                length: 2,
                start: (index) => {
                    if (index === 1) {
                        throw new DOMException('The index is not in the allowed range', 'IndexSizeError');
                    }
                    return 0;
                },
                end: () => 20,
            },
        },
    };

    assert.equal(gatewayBufferedAheadSeconds.call(page), 0);
});

test('Gateway autoplay gate waits for 24 real browser-buffer seconds', async () => {
    const waitForGatewayStartupBuffer = loadMethod(
        'waitForGatewayStartupBuffer',
        'playHls',
    );
    const hls = { levels: [{ details: { live: true, totalduration: 60 } }] };
    let ahead = 0;
    const page = {
        hls,
        isStalePlaybackAttempt: () => false,
        gatewayBufferedAheadSeconds: () => ahead,
    };
    setTimeout(() => { ahead = 24.1; }, 20);

    assert.equal(await waitForGatewayStartupBuffer.call(
        page,
        7,
        hls,
        { minimumSeconds: 24, timeoutMs: 500 },
    ), true);
});

test('Gateway autoplay gate is cancellation-safe and admits a fully buffered short VOD', async () => {
    const waitForGatewayStartupBuffer = loadMethod(
        'waitForGatewayStartupBuffer',
        'playHls',
    );
    const completeHls = { levels: [{ details: { live: false, totalduration: 10 } }] };
    const completePage = {
        hls: completeHls,
        isStalePlaybackAttempt: () => false,
        gatewayBufferedAheadSeconds: () => 9.6,
    };
    assert.equal(await waitForGatewayStartupBuffer.call(
        completePage,
        8,
        completeHls,
        { minimumSeconds: 24, timeoutMs: 200 },
    ), true);

    const stalePage = {
        hls: completeHls,
        isStalePlaybackAttempt: () => true,
        gatewayBufferedAheadSeconds: () => 30,
    };
    assert.equal(await waitForGatewayStartupBuffer.call(
        stalePage,
        9,
        completeHls,
        { minimumSeconds: 24, timeoutMs: 200 },
    ), false);
});

test('Gateway manifest handler gates play and fails closed without opening a retry lane', () => {
    const start = source.indexOf('this.hls.on(Hls.Events.MANIFEST_PARSED');
    const end = source.indexOf('this.hls.on(Hls.Events.ERROR', start);
    assert.ok(start >= 0 && end > start);
    const handler = source.slice(start, end);
    const gateAt = handler.indexOf('await this.waitForGatewayStartupBuffer');
    const playAt = handler.indexOf('this.video.play()');

    assert.ok(gateAt >= 0 && playAt > gateAt, 'Gateway buffer gate must settle before autoplay');
    assert.match(handler, /if \(!bufferReady\)[\s\S]*releasePlaybackPipelineForRetry/);
    assert.doesNotMatch(handler, /getStreamUrl|createSession|retryPlaybackInPlace/,
        'a buffer timeout must not mint another provider session');
});

test('Gateway media recovery cannot play before the startup buffer gate settles', async () => {
    const timers = [];
    let resolveGate;
    const gate = new Promise(resolve => { resolveGate = resolve; });
    let playCalls = 0;

    class FakeHls {
        static Events = {
            MEDIA_ATTACHED: 'media-attached',
            AUDIO_TRACKS_UPDATED: 'audio-tracks-updated',
            AUDIO_TRACK_SWITCHED: 'audio-track-switched',
            SUBTITLE_TRACKS_UPDATED: 'subtitle-tracks-updated',
            SUBTITLE_TRACK_SWITCH: 'subtitle-track-switch',
            MANIFEST_PARSED: 'manifest-parsed',
            ERROR: 'error',
        };
        static ErrorTypes = { MEDIA_ERROR: 'media-error', NETWORK_ERROR: 'network-error' };
        constructor() { this.handlers = new Map(); }
        loadSource() {}
        attachMedia() {}
        on(event, handler) { this.handlers.set(event, handler); }
        recoverMediaError() {}
        swapAudioCodec() {}
        destroy() {}
        emit(event, data) { return this.handlers.get(event)?.(event, data); }
    }

    const playHls = loadMethod('playHls', 'playHlsOrDirect', {
        Hls: FakeHls,
        setTimeout: (fn) => { timers.push(fn); return timers.length; },
        console,
    });

    const page = {
        video: {
            currentTime: 0,
            canPlayType: () => '',
            play: () => { playCalls += 1; return Promise.resolve(); },
        },
        hls: null,
        _playbackAttemptId: 1,
        isGatewayPlaybackUrl: () => true,
        isStalePlaybackAttempt: () => false,
        waitForGatewayStartupBuffer: () => gate,
        _reattachAiTrackIfActive: () => {},
        restorePendingAudioPreference: () => {},
        updateAudioTracks: () => {},
        restorePendingSubtitlePreference: () => {},
        updateCaptionsTracks: () => {},
        showLoading: () => {},
        releasePlaybackPipelineForRetry: async () => {},
        showPlaybackError: () => {},
        retryGatewaySeekAfterFatalPlayback: () => false,
        sendPlaybackEvent: () => {},
        handlePlaybackFailure: async () => {},
        canUseLocalProxy: () => false,
        isGatewaySessionGoneError: () => false,
    };

    playHls.call(
        page,
        'https://norva-production.up.railway.app/sessions/test/playlist.m3u8',
        { playbackAttemptId: 1 },
    );

    const activeHls = page.hls;
    const manifest = activeHls.emit(FakeHls.Events.MANIFEST_PARSED);
    activeHls.emit(FakeHls.Events.ERROR, {
        fatal: true,
        type: FakeHls.ErrorTypes.MEDIA_ERROR,
        details: 'bufferStalledError',
    });
    while (timers.length) timers.shift()();
    assert.equal(playCalls, 0, 'recovery must stay paused while the Gateway gate is pending');

    resolveGate(true);
    await manifest;
    assert.equal(playCalls, 1, 'the manifest path starts playback exactly once after the gate');
});

test('Gateway seek delegates autoplay to loadVideo instead of bypassing its buffer gate', () => {
    const start = source.indexOf('    async restartCloudGatewayStreamAt(');
    const end = source.indexOf('\n    retryGatewaySeekAfterFatalPlayback(', start);
    assert.ok(start >= 0 && end > start);
    const method = source.slice(start, end);
    assert.match(method, /loadVideo\([\s\S]*\bautoplay,/);
    assert.doesNotMatch(method, /if \(autoplay\)[\s\S]*video\?\.play/,
        'seek must not play directly after loadVideo starts the gated HLS lane');
});
