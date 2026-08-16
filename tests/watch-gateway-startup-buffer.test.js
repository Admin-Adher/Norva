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
    assert.match(handler, /minimumSeconds:\s*96/,
        'Gateway playback must mirror the production proof buffer before autoplay');
    assert.match(handler, /timeoutMs:\s*210000/,
        'the deeper browser buffer needs a bounded near-realtime fill budget');
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
        waitForGatewayStartupBuffer: () => gate,
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
