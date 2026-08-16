'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const watchSource = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'pages', 'WatchPage.js'),
    'utf8',
);

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
    static instances = [];

    constructor() {
        this.handlers = new Map();
        this.audioTracks = [];
        this._audioTrack = -1;
        this.audioTrackRequests = [];
        this.loadSourceCalls = [];
        this.attachMediaCalls = [];
        this.destroyCalls = 0;
        this.autoConfirmAudioSwitch = false;
        FakeHls.instances.push(this);
    }

    on(event, handler) { this.handlers.set(event, handler); }
    emit(event, data = {}) { return this.handlers.get(event)?.(event, data); }
    loadSource(url) { this.loadSourceCalls.push(url); }
    attachMedia(media) { this.attachMediaCalls.push(media); }
    destroy() { this.destroyCalls += 1; }
    recoverMediaError() {}
    swapAudioCodec() {}

    get audioTrack() { return this._audioTrack; }
    set audioTrack(index) {
        this.audioTrackRequests.push(index);
        this._audioTrack = index;
        if (this.autoConfirmAudioSwitch) {
            queueMicrotask(() => this.emit(FakeHls.Events.AUDIO_TRACK_SWITCHED, { id: index }));
        }
    }
}

function fakeElement() {
    return {
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        dataset: {},
        style: {},
        setAttribute() {},
        removeAttribute() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        appendChild() {},
        remove() {},
        pause() {},
        load() {},
        textContent: '',
        innerHTML: '',
    };
}

function loadWatchPage() {
    const forbidden = () => { throw new Error('unexpected network/session operation'); };
    const activeTimers = new Set();
    const trackedSetTimeout = (callback, delay, ...args) => {
        const timerId = setTimeout(() => {
            activeTimers.delete(timerId);
            callback(...args);
        }, delay);
        activeTimers.add(timerId);
        return timerId;
    };
    const trackedClearTimeout = (timerId) => {
        activeTimers.delete(timerId);
        clearTimeout(timerId);
    };
    const context = {
        window: {
            NorvaCloud: {
                playback: { expireSession: forbidden, createSession: forbidden },
                device: { playback: { expireSession: forbidden, createSession: forbidden } },
            },
            location: { href: 'https://norva.tv/app', protocol: 'https:' },
        },
        document: {
            getElementById() { return fakeElement(); },
            querySelector() { return fakeElement(); },
            createElement() { return fakeElement(); },
            documentElement: fakeElement(),
            body: fakeElement(),
        },
        navigator: {},
        location: { origin: 'https://norva.tv' },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        console: { ...console, log() {}, warn() {} },
        setTimeout: trackedSetTimeout,
        clearTimeout: trackedClearTimeout,
        setInterval,
        clearInterval,
        queueMicrotask,
        Promise,
        URL,
        URLSearchParams,
        Hls: FakeHls,
        fetch: forbidden,
        API: {
            proxy: { xtream: { getStreamUrl: forbidden } },
            playback: { createSession: forbidden, expireSession: forbidden },
        },
        MediaUtils: {},
    };
    vm.runInNewContext(watchSource, context, { filename: 'WatchPage.js' });
    context.window.WatchPage.__activeTestTimers = activeTimers;
    return context.window.WatchPage;
}

function makePage(WatchPage, { validationStatus = 'verified' } = {}) {
    let playCalls = 0;
    let gateCalls = 0;
    const savedPreferences = [];
    const page = Object.create(WatchPage.prototype);
    Object.assign(page, {
        _playbackAttemptId: 17,
        _gatewayAudioRenditionStatus: 'absent',
        _gatewayAudioRenditions: [],
        _gatewayMultiAudioHls: null,
        _gatewayAudioRenditionAttemptId: null,
        _gatewayAudioRenditionRequired: false,
        _gatewayHlsAudioTracksReady: false,
        _pendingHlsAudioSwitch: null,
        _pendingAudioPreferenceApplied: false,
        _pendingSubtitlePreferenceApplied: false,
        pendingPlaybackPreferences: null,
        currentPlaybackMode: 'gateway-session',
        selectedAudioStreamIndex: null,
        directAudioStreamIndex: null,
        selectedAudioTrackUserChoice: false,
        audioTracks: [],
        currentStreamInfo: null,
        hls: null,
        content: {
            id: 'movie-1',
            type: 'movie',
            audioTracksScope: 'file',
            audioLanguageValidationStatus: validationStatus,
            audioTracks: [
                { index: 2, lang: 'fra' },
                { index: 5, lang: 'fra' },
                { index: 9, lang: null },
            ],
        },
        audioLanguageValidationStatus: validationStatus,
        video: {
            currentTime: 0,
            canPlayType: () => '',
            play: () => { playCalls += 1; return Promise.resolve(); },
        },
        isGatewayPlaybackUrl: () => true,
        isStalePlaybackAttempt(attemptId) { return attemptId !== this._playbackAttemptId; },
        updateAudioTracks() {},
        updateCaptionsTracks() {},
        closeAudioMenu() { this.audioMenuOpen = false; },
        restorePendingAudioPreference() { return false; },
        restorePendingSubtitlePreference() { return false; },
        setSelectedAudioPreference(track) { savedPreferences.push(track); return { audio: track }; },
        saveResumeSnapshotThrottled() { throw new Error('audio rendition switch must not save/reload'); },
        saveProgress() { throw new Error('audio rendition switch must not perform a network progress write'); },
        queueSelectedAudioTrackRestart() { throw new Error('audio rendition switch must not restart playback'); },
        waitForGatewayStartupBuffer() { gateCalls += 1; return Promise.resolve(true); },
        _reattachAiTrackIfActive() {},
        showLoading() {},
        releasePlaybackPipelineForRetry: async () => {},
        showPlaybackError() {},
        retryGatewaySeekAfterFatalPlayback: () => false,
        sendPlaybackEvent() {},
        handlePlaybackFailure: async () => {},
        canUseLocalProxy: () => false,
        isGatewaySessionGoneError: () => false,
    });
    return {
        page,
        savedPreferences,
        get playCalls() { return playCalls; },
        get gateCalls() { return gateCalls; },
    };
}

const audioRenditions = [
    { hlsIndex: 0, streamIndex: 2, language: 'und', title: 'Unknown tag', sourceChannels: 6, outputChannels: 2, codec: 'aac' },
    { hlsIndex: 1, streamIndex: 5, language: 'eng', title: 'English tag', sourceChannels: 6, outputChannels: 2, codec: 'aac' },
    { hlsIndex: 2, streamIndex: 9, language: null, title: null, sourceChannels: 2, outputChannels: 2, codec: 'aac' },
];
const multiAudioHls = { defaultHlsIndex: 1, defaultStreamIndex: 5 };
const codecTracks = [
    { index: 2, codec: 'ac3', channels: 6 },
    { index: 5, codec: 'ac3', channels: 6 },
    { index: 9, codec: 'aac', channels: 2 },
];

function configureAndAttach(harness) {
    const { page } = harness;
    assert.equal(page.configureGatewayAudioRenditions(
        audioRenditions,
        multiAudioHls,
        codecTracks,
        {
            required: true,
            playbackAttemptId: 17,
            audioStreamIndex: 5,
            verifiedTracks: page.getContentAudioTracks(),
            audioLanguageValidationStatus: page.audioLanguageValidationStatus,
        },
    ), true);
    page.playHls('https://gateway.example/sessions/session-1/playlist.m3u8?token=redacted', {
        playbackAttemptId: 17,
        autoplay: false,
    });
    const hls = page.hls;
    hls.audioTracks = [
        { id: 0, lang: 'und', name: 'audio_0' },
        { id: 1, lang: 'eng', name: 'English' },
        { id: 2, lang: 'jpn', name: 'Japanese' },
    ];
    hls._audioTrack = 1;
    hls.emit(FakeHls.Events.AUDIO_TRACKS_UPDATED, { audioTracks: hls.audioTracks });
    hls.emit(FakeHls.Events.AUDIO_TRACK_SWITCHED, { id: 1 });
    return hls;
}

test('nested playback metadata preserves the signed rendition/default contract', () => {
    const WatchPage = loadWatchPage();
    const page = Object.create(WatchPage.prototype);
    const result = page.playbackMetadataFromResult({
        playback: { audioRenditions, multiAudioHls },
    });
    assert.equal(result.audioRenditions, audioRenditions);
    assert.equal(result.multiAudioHls, multiAudioHls);
    assert.match(watchSource, /audioRenditions:\s*playbackMetadata\.audioRenditions/);
    assert.match(watchSource, /multiAudioHls:\s*playbackMetadata\.multiAudioHls/);
    assert.match(watchSource, /configureGatewayAudioRenditions\([\s\S]*?options\.audioRenditions/);
});

test('Gateway menu maps exact HLS indexes to absolute streams and names only verified languages', () => {
    FakeHls.instances.length = 0;
    const WatchPage = loadWatchPage();
    const harness = makePage(WatchPage);
    const hls = configureAndAttach(harness);
    const tracks = harness.page.getVisibleAudioTracks();

    assert.deepEqual(Array.from(tracks, (track) => [track.index, track.streamIndex]), [
        [0, 2], [1, 5], [2, 9],
    ]);
    assert.equal(tracks[0].language, 'fr', 'rendition UND must use verified exact-file FRA');
    assert.equal(tracks[1].language, 'fr', 'the unverified HLS English tag must not override verified FRA');
    assert.equal(tracks[2].language, null);
    assert.match(tracks[2].label, /^Unknown language/);
    assert.notEqual(tracks[0].label, tracks[1].label, 'duplicate exact languages remain separate menu rows');
    assert.equal(tracks[1].active, true);
    assert.equal(harness.page.selectedAudioStreamIndex, 5);
    assert.equal(harness.page._gatewayAudioRenditions[0].codec, 'ac3');
    assert.equal(harness.page._gatewayAudioRenditions[0].renditionCodec, 'aac');
    assert.deepEqual(
        JSON.parse(JSON.stringify(harness.page.getCurrentAudioPreference())),
        { source: 'probe', streamIndex: 5, label: 'French - AC3 - 6ch', language: 'fr', codec: 'ac3', channels: 6 },
        'resume state persists the verified absolute identity, never the HLS English tag',
    );
    assert.equal(hls.loadSourceCalls.length, 1);
});

test('uncertified rendition language and title stay explicitly unknown', () => {
    const WatchPage = loadWatchPage();
    const harness = makePage(WatchPage, { validationStatus: 'pending' });
    configureAndAttach(harness);
    const tracks = harness.page.getVisibleAudioTracks();

    assert.equal(tracks[0].language, null);
    assert.equal(tracks[1].language, null);
    assert.match(tracks[1].label, /^Unknown language/);
    assert.doesNotMatch(tracks[1].label, /English/i);
});

test('a restored absolute preference remains pending until Hls.js confirms it', async () => {
    const WatchPage = loadWatchPage();
    const harness = makePage(WatchPage);
    harness.page.pendingPlaybackPreferences = { audio: { source: 'probe', streamIndex: 2 } };
    const hls = configureAndAttach(harness);

    assert.equal(harness.page.selectedAudioStreamIndex, 5);
    assert.equal(harness.page.directAudioStreamIndex, 5);
    assert.equal(harness.page.selectedAudioTrackUserChoice, false);
    assert.deepEqual(hls.audioTrackRequests, [0]);

    hls.emit(FakeHls.Events.AUDIO_TRACK_SWITCHED, { id: 0 });
    await Promise.resolve();
    assert.equal(harness.page.selectedAudioStreamIndex, 2);
    assert.equal(harness.page.directAudioStreamIndex, 2);
    assert.equal(harness.page.selectedAudioTrackUserChoice, true);
    assert.equal(harness.page._pendingGatewayAudioStreamIndex, null);
    assert.equal(WatchPage.__activeTestTimers.size, 0);
});

test('confirmed HLS switch stays in the same session and updates only the absolute selection', async () => {
    FakeHls.instances.length = 0;
    const WatchPage = loadWatchPage();
    const harness = makePage(WatchPage);
    const hls = configureAndAttach(harness);
    const instance = harness.page.hls;
    hls.autoConfirmAudioSwitch = true;

    const switched = await harness.page.selectAudioTrack('hls', 0, 2);
    assert.equal(switched, true);
    assert.equal(harness.page.hls, instance);
    assert.equal(hls.loadSourceCalls.length, 1, 'the master playlist is not reloaded');
    assert.deepEqual(hls.audioTrackRequests, [0]);
    assert.equal(harness.page.selectedAudioStreamIndex, 2);
    assert.equal(harness.page.directAudioStreamIndex, 2);
    assert.equal(harness.page.selectedAudioTrackUserChoice, true);
    assert.equal(harness.savedPreferences.length, 1);
    assert.equal(harness.savedPreferences[0].index, 2);
    assert.equal(harness.playCalls, 0, 'switching audio never calls video.play directly');
    assert.equal(harness.gateCalls, 0, 'switching audio never re-enters the startup gate');
    assert.equal(FakeHls.instances.length, 1, 'no replacement HLS/session provider is created');
    assert.equal(WatchPage.__activeTestTimers.size, 0);
});

test('active-track selection is idempotent and rapid choices are latest-wins without timer/listener leaks', async () => {
    const WatchPage = loadWatchPage();
    const harness = makePage(WatchPage);
    const hls = configureAndAttach(harness);
    const listenerCount = hls.handlers.size;

    assert.equal(await harness.page.selectAudioTrack('hls', 1, 5), true);
    assert.deepEqual(hls.audioTrackRequests, [], 'the already confirmed active track needs no event');
    assert.equal(WatchPage.__activeTestTimers.size, 0);

    const first = harness.page.selectAudioTrack('hls', 0, 2);
    assert.equal(WatchPage.__activeTestTimers.size, 1);
    const latest = harness.page.selectAudioTrack('hls', 2, 9);
    assert.equal(await first, false, 'a superseded choice settles immediately');
    assert.equal(WatchPage.__activeTestTimers.size, 1, 'only the latest confirmation timer remains');

    hls.emit(FakeHls.Events.AUDIO_TRACK_SWITCHED, { id: 0 });
    assert.equal(harness.page.selectedAudioStreamIndex, 5, 'an older confirmation cannot win');
    assert.equal(harness.page.directAudioStreamIndex, 5);
    hls.emit(FakeHls.Events.AUDIO_TRACK_SWITCHED, { id: 2 });
    assert.equal(await latest, true);
    assert.equal(harness.page.selectedAudioStreamIndex, 9);
    assert.equal(harness.page.directAudioStreamIndex, 9);
    assert.equal(WatchPage.__activeTestTimers.size, 0);
    assert.equal(harness.page._pendingHlsAudioSwitch, null);
    assert.equal(hls.handlers.size, listenerCount, 'choices reuse the one Hls.js event listener');

    hls.emit(FakeHls.Events.AUDIO_TRACK_SWITCHED, { id: 0 });
    assert.equal(harness.page.selectedAudioStreamIndex, 9, 'late stale events stay ignored after confirmation');
    assert.equal(harness.page.directAudioStreamIndex, 9);
});

test('missing or mismatched Gateway maps fail closed while legacy mono-audio stays available', async () => {
    const WatchPage = loadWatchPage();

    const mismatched = makePage(WatchPage);
    const mismatchHls = configureAndAttach(mismatched);
    mismatchHls.audioTracks.pop();
    mismatchHls.emit(FakeHls.Events.AUDIO_TRACKS_UPDATED, { audioTracks: mismatchHls.audioTracks });
    assert.equal(mismatched.page.getVisibleAudioTracks()[0].source, 'none');
    const requestsBefore = mismatchHls.audioTrackRequests.length;
    assert.equal(await mismatched.page.selectAudioTrack('hls', 0, 2), false);
    assert.equal(mismatchHls.audioTrackRequests.length, requestsBefore);

    const absent = makePage(WatchPage);
    absent.page.configureGatewayAudioRenditions(null, null, [], {
        required: true,
        playbackAttemptId: 17,
    });
    absent.page.playHls('https://gateway.example/sessions/session-2/playlist.m3u8', {
        playbackAttemptId: 17,
        autoplay: false,
    });
    absent.page.hls.audioTracks = [{ id: 0 }, { id: 1 }];
    absent.page.hls.emit(FakeHls.Events.AUDIO_TRACKS_UPDATED, { audioTracks: absent.page.hls.audioTracks });
    assert.equal(absent.page.getVisibleAudioTracks()[0].source, 'none');

    const mono = makePage(WatchPage);
    mono.page.configureGatewayAudioRenditions(null, null, [], {
        required: true,
        playbackAttemptId: 17,
    });
    mono.page.audioTracks = [{ index: 7, language: 'fr', codec: 'aac', channels: 2, default: true }];
    mono.page.selectedAudioStreamIndex = 7;
    mono.page.playHls('https://gateway.example/sessions/session-3/playlist.m3u8', {
        playbackAttemptId: 17,
        autoplay: false,
    });
    mono.page.hls.audioTracks = [{ id: 0, lang: 'fra' }];
    mono.page.hls.emit(FakeHls.Events.AUDIO_TRACKS_UPDATED, { audioTracks: mono.page.hls.audioTracks });
    assert.equal(mono.page.getVisibleAudioTracks()[0].source, 'probe');
    assert.equal(mono.page.getVisibleAudioTracks()[0].streamIndex, 7);
});

test('a stale playback attempt cannot confirm or mutate a pending HLS audio switch', async () => {
    const WatchPage = loadWatchPage();
    const harness = makePage(WatchPage);
    const hls = configureAndAttach(harness);
    const priorStreamIndex = harness.page.selectedAudioStreamIndex;

    const pending = harness.page.selectAudioTrack('hls', 0, 2);
    harness.page._playbackAttemptId += 1;
    hls.emit(FakeHls.Events.AUDIO_TRACK_SWITCHED, { id: 0 });

    assert.equal(await pending, false);
    assert.equal(harness.page.selectedAudioStreamIndex, priorStreamIndex);
    assert.equal(harness.page.directAudioStreamIndex, 5);
    assert.equal(harness.page.selectedAudioTrackUserChoice, false);
    assert.equal(harness.savedPreferences.length, 0);
    assert.equal(harness.page._pendingHlsAudioSwitch, null);
});
