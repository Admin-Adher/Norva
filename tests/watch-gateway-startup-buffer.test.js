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
        'normalizeGatewayStartupPolicy',
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
        'normalizeGatewayStartupPolicy',
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

test('Gateway fast-start policy accepts only a measured file-exact or complete-cache graph', () => {
    const normalizeGatewayStartupPolicy = loadMethod(
        'normalizeGatewayStartupPolicy',
        'gatewayStartupBufferOptions',
    );
    const valid = {
        protocol: 2,
        eligible: true,
        pipeline: 'audio-transcode',
        reason: 'mkv-h264-copy-ready',
        targetBufferSeconds: 6,
        minimumEncodeRateX: 1.15,
        observedEncodeRateX: 1.42,
    };

    assert.deepEqual(
        normalizeGatewayStartupPolicy.call({}, valid),
        valid,
    );
    const completeCache = {
        ...valid,
        pipeline: 'copy',
        reason: 'complete-hls-cache-hit',
        observedEncodeRateX: 20,
    };
    assert.deepEqual(
        normalizeGatewayStartupPolicy.call({}, completeCache),
        completeCache,
    );
    const vaapiTranscode = {
        ...valid,
        pipeline: 'video-transcode',
        reason: 'vaapi-transcode-ready',
        minimumEncodeRateX: 2,
        observedEncodeRateX: 12,
    };
    assert.deepEqual(
        normalizeGatewayStartupPolicy.call({}, vaapiTranscode),
        vaapiTranscode,
    );

    const invalidMutations = [
        null,
        [],
        { ...valid, protocol: 1 },
        { ...valid, eligible: false },
        { ...valid, pipeline: 'video-transcode' },
        { ...valid, reason: 'encode-rate-below-minimum' },
        { ...completeCache, pipeline: 'audio-transcode' },
        { ...vaapiTranscode, pipeline: 'copy' },
        { ...vaapiTranscode, minimumEncodeRateX: 1.99 },
        { ...valid, targetBufferSeconds: 5.99 },
        { ...valid, targetBufferSeconds: 24.01 },
        { ...valid, minimumEncodeRateX: 1.14 },
        { ...valid, observedEncodeRateX: 1.149 },
        { ...valid, observedEncodeRateX: 21 },
    ];
    for (const mutation of invalidMutations) {
        assert.equal(normalizeGatewayStartupPolicy.call({}, mutation), null);
    }
});

test('Gateway startup buffer keeps mono fast while multi-audio gets a durable first-refresh reserve', () => {
    const gatewayStartupBufferOptions = loadMethod(
        'gatewayStartupBufferOptions',
        'gatewayRecoveryBufferOptions',
    );
    const valid = {
        protocol: 2,
        eligible: true,
        pipeline: 'copy',
        reason: 'mkv-h264-copy-ready',
        targetBufferSeconds: 6,
        minimumEncodeRateX: 1.15,
        observedEncodeRateX: 3.25,
    };
    const page = {
        _gatewayAudioRenditionStatus: 'absent',
        _gatewayAudioRenditions: [],
        normalizeGatewayStartupPolicy(value) {
            return value === valid ? valid : null;
        },
    };

    assert.deepEqual(gatewayStartupBufferOptions.call(page, valid), {
        minimumSeconds: 6,
        timeoutMs: 45000,
        policy: valid,
    });
    assert.deepEqual(gatewayStartupBufferOptions.call({
        ...page,
        _gatewayAudioRenditionStatus: 'ready',
        _gatewayAudioRenditions: [{ streamIndex: 1 }, { streamIndex: 3 }],
    }, valid), {
        minimumSeconds: 12,
        timeoutMs: 45000,
        policy: valid,
    });
    assert.deepEqual(gatewayStartupBufferOptions.call(page, { ...valid, eligible: false }), {
        minimumSeconds: 96,
        timeoutMs: 360000,
        policy: null,
    });
});

test('Gateway recovery builds a larger reserve than startup without returning to the 96-second legacy gate', () => {
    const gatewayRecoveryBufferOptions = loadMethod(
        'gatewayRecoveryBufferOptions',
        'waitForGatewayRecoveryBuffer',
    );
    const policy = {
        protocol: 2,
        eligible: true,
        pipeline: 'video-transcode',
        reason: 'vaapi-transcode-ready',
        targetBufferSeconds: 6,
        minimumEncodeRateX: 2,
        observedEncodeRateX: 3.2,
    };
    const page = {
        normalizeGatewayStartupPolicy(value) { return value === policy ? policy : null; },
    };

    assert.deepEqual(gatewayRecoveryBufferOptions.call(page, policy), {
        minimumSeconds: 12,
        timeoutMs: 60000,
        policy,
    });
    assert.deepEqual(gatewayRecoveryBufferOptions.call(page, null), {
        minimumSeconds: 24,
        timeoutMs: 60000,
        policy: null,
    });
});

test('Gateway recovery waits for the reserve even when media time was already advancing', async () => {
    const waitForGatewayRecoveryBuffer = loadMethod(
        'waitForGatewayRecoveryBuffer',
        'waitForGatewayStartupBuffer',
    );
    const hls = { levels: [{ details: { live: true, totalduration: 120 } }] };
    let ahead = 2;
    const page = {
        hls,
        video: { currentTime: 30, paused: false, ended: false },
        isStalePlaybackAttempt: () => false,
        gatewayBufferedAheadSeconds: () => ahead,
    };
    let settled = false;
    const gate = waitForGatewayRecoveryBuffer.call(
        page,
        15,
        hls,
        { minimumSeconds: 12, timeoutMs: 500 },
    ).then((value) => { settled = true; return value; });

    await new Promise(resolve => setTimeout(resolve, 25));
    page.video.currentTime = 31;
    await new Promise(resolve => setTimeout(resolve, 110));
    assert.equal(settled, false, 'prior playback progress must not bypass the recovery floor');
    ahead = 12.2;
    assert.equal(await gate, true);
});

test('Gateway autoplay gate holds at 56 and 95.9 seconds, then admits 96.1 seconds', async () => {
    const waitForGatewayStartupBuffer = loadMethod(
        'waitForGatewayStartupBuffer',
        'playHls',
    );
    const hls = { levels: [{ details: { live: true, totalduration: 60 } }] };
    let ahead = 24.1;
    const page = {
        hls,
        isStalePlaybackAttempt: () => false,
        gatewayBufferedAheadSeconds: () => ahead,
    };
    let settled = false;
    const gate = waitForGatewayStartupBuffer.call(
        page,
        7,
        hls,
        { minimumSeconds: 96, timeoutMs: 500 },
    ).then(result => {
        settled = true;
        return result;
    });

    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(settled, false, '56 seconds must no longer start Gateway playback');
    ahead = 95.9;
    await new Promise(resolve => setTimeout(resolve, 110));
    assert.equal(settled, false, 'the gate must not round a sub-threshold range up to 96 seconds');
    ahead = 96.1;
    assert.equal(await gate, true);
});

test('Gateway startup gate never tears down playback the viewer already started', async () => {
    const waitForGatewayStartupBuffer = loadMethod(
        'waitForGatewayStartupBuffer',
        'playHls',
    );
    const hls = { levels: [{ details: { live: true, totalduration: 24 } }] };
    const video = { currentTime: 0, paused: false, ended: false };
    const page = {
        hls,
        video,
        isStalePlaybackAttempt: () => false,
        gatewayBufferedAheadSeconds: () => 12,
    };

    const gate = waitForGatewayStartupBuffer.call(
        page,
        12,
        hls,
        { minimumSeconds: 96, timeoutMs: 500 },
    );
    await new Promise(resolve => setTimeout(resolve, 25));
    video.currentTime = 0.5;

    assert.equal(await gate, true);
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
        { minimumSeconds: 96, timeoutMs: 200 },
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
        { minimumSeconds: 96, timeoutMs: 200 },
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
    assert.match(handler, /minimumSeconds:\s*gatewayStartupBuffer\.minimumSeconds/,
        'Gateway playback must consume only the normalized per-session buffer policy');
    assert.match(handler, /timeoutMs:\s*gatewayStartupBuffer\.timeoutMs/,
        'the fast and fallback paths keep independently bounded fill budgets');
    assert.match(handler, /if \(!bufferReady\)[\s\S]*releasePlaybackPipelineForRetry/);
    assert.doesNotMatch(handler, /getStreamUrl|createSession|retryPlaybackInPlace/,
        'a buffer timeout must not mint another provider session');
});

test('Gateway media recovery cannot play before the startup buffer gate settles', async () => {
    const timers = [];
    const switchMetrics = [];
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
        gatewayStartupBufferOptions: () => ({ minimumSeconds: 96, timeoutMs: 360000, policy: null }),
        gatewayRecoveryBufferOptions: () => ({ minimumSeconds: 24, timeoutMs: 60000, policy: null }),
        waitForGatewayStartupBuffer: () => gate,
        waitForGatewayRecoveryBuffer: async () => true,
        gatewayBufferedAheadSeconds: () => 96.25,
        updateGatewayAudioSwitchMetrics: (requestId, status, details) => {
            switchMetrics.push({ requestId, status, details });
        },
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
        { playbackAttemptId: 1, audioSwitchRequestId: 4 },
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
    assert.deepEqual(switchMetrics, [], 'the switch must not report readiness before the real gate');

    resolveGate(true);
    await manifest;
    await Promise.resolve();
    assert.equal(playCalls, 1, 'the manifest path starts playback exactly once after the gate');
    assert.deepEqual(switchMetrics.map(metric => metric.status), ['gateway_gate_ready', 'playing']);
    assert.equal(switchMetrics[0].details.bufferedAheadSeconds, 96.25);
    assert.equal(switchMetrics[0].details.startupPolicy, null);
});

test('Gateway non-fatal starvation pauses once and resumes only after the recovery reserve is rebuilt', async () => {
    let resolveRecovery;
    const recoveryGate = new Promise(resolve => { resolveRecovery = resolve; });
    let playCalls = 0;
    let pauseCalls = 0;
    let recoveryCalls = 0;

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
        constructor() { this.handlers = new Map(); this.audioTracks = []; }
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
        setTimeout: (callback) => { queueMicrotask(callback); return 1; },
        console,
    });
    const video = {
        paused: true,
        ended: false,
        currentTime: 20,
        canPlayType: () => '',
        play() { playCalls += 1; this.paused = false; return Promise.resolve(); },
        pause() { pauseCalls += 1; this.paused = true; },
    };
    const page = {
        video,
        hls: null,
        _playbackAttemptId: 22,
        _gatewayAutomaticRebuffering: false,
        _gatewayUserPaused: false,
        isGatewayPlaybackUrl: () => true,
        isStalePlaybackAttempt: () => false,
        gatewayStartupBufferOptions: () => ({ minimumSeconds: 6, timeoutMs: 45000, policy: null }),
        gatewayRecoveryBufferOptions: () => ({ minimumSeconds: 12, timeoutMs: 60000, policy: null }),
        waitForGatewayStartupBuffer: async () => true,
        waitForGatewayRecoveryBuffer: async () => { recoveryCalls += 1; return recoveryGate; },
        gatewayBufferedAheadSeconds: () => 1,
        _reattachAiTrackIfActive: () => {},
        restorePendingAudioPreference: () => {},
        updateAudioTracks: () => {},
        restorePendingSubtitlePreference: () => {},
        updateCaptionsTracks: () => {},
        showLoading: () => {},
        hideLoading: () => {},
        showOverlay: () => {},
        releasePlaybackPipelineForRetry: async () => {},
        showPlaybackError: () => {},
        retryGatewaySeekAfterFatalPlayback: () => false,
        sendPlaybackEvent: () => {},
        handlePlaybackFailure: async () => {},
        handleAutoplayError: () => {},
        canUseLocalProxy: () => false,
        isGatewaySessionGoneError: () => false,
        centerPlayBtn: { classList: { add() {} } },
    };

    playHls.call(page, 'https://norva-production.up.railway.app/sessions/test/playlist.m3u8', {
        playbackAttemptId: 22,
    });
    const activeHls = page.hls;
    await activeHls.emit(FakeHls.Events.MANIFEST_PARSED, { audioTracks: [] });
    assert.equal(playCalls, 1);
    assert.equal(video.paused, false);

    // Chromium can expose paused=true before hls.js dispatches the soft-stall
    // event. This is still an automatic starvation, not a viewer pause.
    video.paused = true;
    activeHls.emit(FakeHls.Events.ERROR, {
        fatal: false,
        type: FakeHls.ErrorTypes.MEDIA_ERROR,
        details: 'bufferStalledError',
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(pauseCalls, 0, 'an already-paused stalled element is not paused twice');
    assert.equal(playCalls, 1, 'the empty edge must not be replayed immediately');
    assert.equal(page._gatewayAutomaticRebuffering, true);
    assert.equal(recoveryCalls, 1);

    resolveRecovery(true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(playCalls, 2);
    assert.equal(page._gatewayAutomaticRebuffering, false);
});

test('Gateway starvation never overrides an explicit viewer pause', async () => {
    let recoveryCalls = 0;
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
        constructor() { this.handlers = new Map(); this.audioTracks = []; }
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
        setTimeout: (callback) => { queueMicrotask(callback); return 1; },
        console,
    });
    const page = {
        video: {
            paused: true,
            ended: false,
            currentTime: 20,
            canPlayType: () => '',
            play() { playCalls += 1; this.paused = false; return Promise.resolve(); },
            pause() {},
        },
        hls: null,
        _playbackAttemptId: 23,
        _gatewayAutomaticRebuffering: false,
        _gatewayUserPaused: true,
        isGatewayPlaybackUrl: () => true,
        isStalePlaybackAttempt: () => false,
        gatewayStartupBufferOptions: () => ({ minimumSeconds: 6, timeoutMs: 45000, policy: null }),
        gatewayRecoveryBufferOptions: () => ({ minimumSeconds: 12, timeoutMs: 60000, policy: null }),
        waitForGatewayStartupBuffer: async () => true,
        waitForGatewayRecoveryBuffer: async () => { recoveryCalls += 1; return true; },
        gatewayBufferedAheadSeconds: () => 1,
        _reattachAiTrackIfActive: () => {},
        restorePendingAudioPreference: () => {},
        updateAudioTracks: () => {},
        restorePendingSubtitlePreference: () => {},
        updateCaptionsTracks: () => {},
        showLoading: () => {},
        hideLoading: () => {},
        showOverlay: () => {},
        releasePlaybackPipelineForRetry: async () => {},
        showPlaybackError: () => {},
        retryGatewaySeekAfterFatalPlayback: () => false,
        sendPlaybackEvent: () => {},
        handlePlaybackFailure: async () => {},
        handleAutoplayError: () => {},
        canUseLocalProxy: () => false,
        isGatewaySessionGoneError: () => false,
        centerPlayBtn: { classList: { add() {} } },
    };

    playHls.call(page, 'https://norva-production.up.railway.app/sessions/test/playlist.m3u8', {
        playbackAttemptId: 23,
    });
    await page.hls.emit(FakeHls.Events.MANIFEST_PARSED, { audioTracks: [] });
    assert.equal(playCalls, 1);
    page.video.paused = true;
    page._gatewayUserPaused = true;
    page.hls.emit(FakeHls.Events.ERROR, {
        fatal: false,
        type: FakeHls.ErrorTypes.MEDIA_ERROR,
        details: 'bufferStalledError',
    });
    await Promise.resolve();
    assert.equal(recoveryCalls, 0);
    assert.equal(page._gatewayAutomaticRebuffering, false);
});

test('Playback metadata forwards Gateway fast-start policy into the HLS attachment only', () => {
    const metadataStart = source.indexOf('    playbackMetadataFromResult(');
    const metadataEnd = source.indexOf('\n    normalizePlaybackCodecProfile(', metadataStart);
    const metadata = source.slice(metadataStart, metadataEnd);
    const playStart = source.indexOf('    async play(');
    const playEnd = source.indexOf('\n    updateMediaSessionMetadata(', playStart);
    const play = source.slice(playStart, playEnd);
    const loadStart = source.indexOf('    async loadVideo(');
    const loadEnd = source.indexOf('\n    gatewayBufferedAheadSeconds(', loadStart);
    const load = source.slice(loadStart, loadEnd);

    assert.match(metadata, /gatewaySession\?\.startupPolicy/);
    assert.match(play, /startupPolicy:\s*playbackMetadata\.startupPolicy/);
    assert.match(load, /startupPolicy:\s*options\.startupPolicy/);
    assert.doesNotMatch(load, /createSession|getStreamUrl|retryPlaybackInPlace/,
        'policy forwarding must not open a second lane');
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

test('Gateway audio switch expires the prior lane, creates once, and delegates autoplay to gate96', async () => {
    const restartCloudGatewayWithSelectedAudioTrack = loadMethod(
        'restartCloudGatewayWithSelectedAudioTrack',
        'updateGatewayAudioSwitchMetrics',
        {
            MediaUtils: {
                playbackHintFromItem: () => ({ container: 'mkv', streamType: 'movie' }),
            },
            console,
        },
    );
    const lifecycle = [];
    const metrics = [];
    let createCalls = 0;
    let playCalls = 0;
    let attached = null;
    const page = {
        _audioSwitchRequestId: 11,
        _playbackAttemptId: 27,
        video: {
            paused: false,
            play: () => { playCalls += 1; return Promise.resolve(); },
        },
        content: { sourceId: 'source-1', id: '90843', type: 'movie', containerExtension: 'mkv' },
        containerExtension: 'mkv',
        captureVodPlaybackIdentity: () => ({
            sourceId: 'source-1',
            itemId: '90843',
            itemType: 'movie',
            container: 'mkv',
            playbackItem: { sourceId: 'source-1', id: '90843', type: 'movie', streamType: 'movie' },
        }),
        currentStreamInfo: { audioTracks: [{ index: 2, language: 'fra' }] },
        audioTracks: [{ index: 2, language: 'fra' }],
        getSelectedAudioTrack: () => ({ index: 2, language: 'fra' }),
        getPlaybackPosition: () => 125,
        getGatewaySeekPreRoll: () => 5,
        getAudioProcessingOptions: () => ({ audioStreamIndex: 2, audioCodec: 'ac3' }),
        setSelectedAudioPreference: () => ({ audio: { streamIndex: 2 } }),
        getTrackLabel: () => 'French',
        hidePlaybackError: () => {},
        showLoading: () => {},
        updateTranscodeStatus: () => {},
        trackPlaybackPosition: () => {},
        saveResumeSnapshotThrottled: () => {},
        releasePlaybackPipelineForRetry: async () => { lifecycle.push('release'); },
        waitForProviderSlotRelease: async () => { lifecycle.push('cooldown'); },
        isStaleAudioSwitch: () => false,
        updateGatewayAudioSwitchMetrics: (requestId, status, details = {}) => {
            metrics.push({ requestId, status, details });
        },
        requestAudioSwitchGatewayUrl: async () => {
            createCalls += 1;
            lifecycle.push('create');
            return {
                url: 'https://gateway.test/sessions/new/playlist.m3u8',
                session: { id: 'session-new' },
                playback: {
                    audioStreamIndex: 2,
                    actualStartOffset: 120,
                    localSeekTarget: 5,
                    sourceTimestamps: true,
                },
            };
        },
        playbackMetadataFromResult: (playback = {}, extra = {}) => ({
            ...(playback.playback || playback),
            ...extra,
            sessionId: extra.sessionId || playback.sessionId || playback.session?.id || 'session-new',
            audioStreamIndex: extra.audioStreamIndex ?? playback.playback?.audioStreamIndex ?? playback.audioStreamIndex,
        }),
        cleanupStaleCloudPlaybackSession: async () => {},
        handlePlaybackFailure: async () => {},
        getMeasuredGatewaySeekPlan: () => ({
            actualStartOffset: 120,
            localSeekTarget: 5,
            sourceTimestamps: true,
        }),
        loadVideo: async (url, options) => {
            lifecycle.push('attach');
            attached = { url, options };
        },
        setVolumeFromStorage: () => {},
    };

    assert.equal(await restartCloudGatewayWithSelectedAudioTrack.call(page, 11), true);
    assert.equal(createCalls, 1, 'an audio switch may mint only one provider session');
    assert.ok(lifecycle.indexOf('release') < lifecycle.indexOf('create'), 'old lane release is a hard barrier');
    assert.equal(playCalls, 0, 'restart must never bypass loadVideo/gate96 with a direct play call');
    assert.equal(attached.options.autoplay, true);
    assert.equal(attached.options.audioSwitchRequestId, 11);
    assert.equal(attached.options.audioStreamIndex, 2);
    assert.equal(attached.options.cloudPlaybackSessionId, 'session-new');
    assert.equal(page.content.cloudPlaybackSessionId, 'session-new');
    assert.deepEqual(
        metrics.map(metric => metric.status),
        ['provider_cooldown', 'creating_session', 'attaching_gateway_lane', 'waiting_gateway_gate'],
    );
});

test('Gateway audio switch resolver does not retry an ambiguous session create', async () => {
    let createCalls = 0;
    const requestAudioSwitchGatewayUrl = loadMethod(
        'requestAudioSwitchGatewayUrl',
        'clearExternalSubtitleTracks',
        {
            API: {
                proxy: {
                    xtream: {
                        getStreamUrl: async () => {
                            createCalls += 1;
                            throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
                        },
                    },
                },
            },
        },
    );
    const page = {
        content: { sourceId: 'source-1', id: '90843' },
        isStaleAudioSwitch: () => false,
        isPlaybackSupersededError: () => false,
        isProviderBusyError: () => false,
        getErrorText: (error) => error.message,
        reportProviderPlaybackFailure: async () => {},
    };

    await assert.rejects(
        requestAudioSwitchGatewayUrl.call(page, 'movie', 'mkv', { audioStreamIndex: 2 }, 12),
        /connection reset/,
    );
    assert.equal(createCalls, 1, 'network ambiguity must not create a second provider session');
});

test('Gateway audio switch never treats a missing mapped index as stream zero or as the requested track', () => {
    const start = source.indexOf('    async restartCloudGatewayWithSelectedAudioTrack(');
    const end = source.indexOf('\n    updateGatewayAudioSwitchMetrics(', start);
    assert.ok(start >= 0 && end > start);
    const method = source.slice(start, end);

    assert.match(method, /rawActualAudioStreamIndex === null[\s\S]*\? null[\s\S]*: Number\(rawActualAudioStreamIndex\)/);
    assert.match(method, /!Number\.isInteger\(actualAudioStreamIndex\)[\s\S]*audio_map_unverified/);
    assert.doesNotMatch(
        method,
        /effectiveAudioStreamIndex[\s\S]*requestedAudioStreamIndex\s*:\s*null/,
        'the requested index is intent, never proof of the stream mapped by Gateway',
    );
});
