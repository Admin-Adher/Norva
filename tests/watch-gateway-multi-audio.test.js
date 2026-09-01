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
        gatewayStartupBufferOptions() {
            return { minimumSeconds: 96, timeoutMs: 360000, policy: null };
        },
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

test('exact audio labels render immediately but stay disabled until Hls.js proves the topology', () => {
    const WatchPage = loadWatchPage();
    const harness = makePage(WatchPage);
    const { page } = harness;
    const listAttributes = {};
    page.audioList = {
        innerHTML: '',
        setAttribute(name, value) { listAttributes[name] = String(value); },
        querySelectorAll() { return []; },
    };
    page.audioStatus = { dataset: {}, textContent: '' };
    page.updateAudioTracks = WatchPage.prototype.updateAudioTracks;

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
    page.playHls('https://gateway.example/sessions/session-pending/playlist.m3u8', {
        playbackAttemptId: 17,
        autoplay: false,
    });
    page.hls.audioTracks = [
        { id: 0, lang: 'und', name: 'audio_0' },
        { id: 1, lang: 'eng', name: 'English' },
        { id: 2, lang: 'jpn', name: 'Japanese' },
    ];
    page.updateAudioTracks();

    const pendingTracks = page.getVisibleAudioTracks();
    assert.equal(page.isGatewayAudioRenditionFailClosed(), true, 'switching remains fail closed before HLS proof');
    assert.ok(pendingTracks.every(track => track.pending === true && track.source === 'none'));
    assert.deepEqual(Array.from(pendingTracks, track => track.label), [
        'French - AC3 - 6ch - Track 1',
        'French - AC3 - 6ch - Track 2',
        'Unknown language - AAC - 2ch',
    ]);
    assert.match(page.audioList.innerHTML, /data-state="pending" disabled aria-disabled="true"/);
    assert.equal(listAttributes['aria-busy'], 'true');
    assert.equal(page.audioStatus.textContent, 'Checking audio tracks…');

    page.hls._audioTrack = 1;
    page.hls.emit(FakeHls.Events.AUDIO_TRACKS_UPDATED, { audioTracks: page.hls.audioTracks });
    const readyTracks = page.getVisibleAudioTracks();
    assert.ok(readyTracks.every(track => !track.pending));
    assert.ok(readyTracks.some(track => track.source === 'hls'));
    assert.doesNotMatch(page.audioList.innerHTML, /data-state="pending"|\sdisabled/);
    assert.equal(listAttributes['aria-busy'], 'false');
    assert.equal(page.audioStatus.textContent, 'Audio tracks ready.');
});

test('exact-session language tags name pending Gateway rows without becoming authoritative', () => {
    const WatchPage = loadWatchPage();
    const { page } = makePage(WatchPage, { validationStatus: 'pending' });
    const taggedRenditions = audioRenditions.map((track, index) => ({
        ...track,
        language: ['fra', 'jpn', 'eng'][index],
    }));

    assert.equal(page.configureGatewayAudioRenditions(
        taggedRenditions,
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
    page.playHls('https://gateway.example/sessions/session-pending-tags/playlist.m3u8', {
        playbackAttemptId: 17,
        autoplay: false,
    });

    const tracks = page.getVisibleAudioTracks();
    assert.deepEqual(Array.from(tracks, track => track.label), [
        'French - AC3 - 6ch',
        'Japanese - AC3 - 6ch',
        'English - AAC - 2ch',
    ]);
    assert.ok(tracks.every(track => track.pending === true && track.source === 'none'));
    assert.ok(page._gatewayAudioRenditions.every(track => track.language === null));
    assert.deepEqual(
        Array.from(page._gatewayAudioRenditions, track => track.renditionLanguage),
        ['fr', 'ja', 'en'],
    );
});

test('the initial player shell uses exact file labels instead of a terminal unavailable state', () => {
    const WatchPage = loadWatchPage();
    const { page } = makePage(WatchPage);
    page.currentPlaybackMode = null;
    page._gatewayAudioRenditionRequired = false;
    page._audioTopologyPending = true;

    const tracks = page.getVisibleAudioTracks();
    assert.deepEqual(Array.from(tracks, track => [track.label, track.pending, track.source]), [
        ['French - Track 1', true, 'none'],
        ['French - Track 2', true, 'none'],
        ['Unknown language', true, 'none'],
    ]);
    assert.doesNotMatch(tracks.map(track => track.label).join('|'), /unavailable/i);
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
        { source: 'probe', streamIndex: 5, label: 'French · AC3 · 6ch', language: 'fr', codec: 'ac3', channels: 6 },
        'resume state persists the verified absolute identity, never the HLS English tag',
    );
    assert.equal(hls.loadSourceCalls.length, 1);
});

test('Gateway exposes every exact-file audio track while an out-of-cohort choice restarts safely', async () => {
    FakeHls.instances.length = 0;
    const WatchPage = loadWatchPage();
    const harness = makePage(WatchPage);
    const { page } = harness;
    const exactTracks = Array.from({ length: 10 }, (_, position) => ({
        index: position + 2,
        codec: position % 2 === 0 ? 'ac3' : 'eac3',
        channels: 6,
    }));
    const verifiedTracks = exactTracks.map((track, position) => ({
        index: track.index,
        lang: ['fra', 'eng', 'spa', 'deu', 'ita', 'por', 'nld', 'jpn', 'kor', 'ara'][position],
    }));
    const preparedRenditions = exactTracks.slice(0, 8).map((track, hlsIndex) => ({
        hlsIndex,
        streamIndex: track.index,
        language: verifiedTracks[hlsIndex].lang,
        sourceChannels: 6,
        outputChannels: 2,
        codec: 'aac',
    }));

    page.content.audioTracks = verifiedTracks;
    page.audioLanguageValidationStatus = 'verified';
    page.content.audioLanguageValidationStatus = 'verified';
    page.saveResumeSnapshotThrottled = () => {};
    page.saveProgress = () => {};
    let restartCalls = 0;
    page.queueSelectedAudioTrackRestart = async () => {
        restartCalls += 1;
        return true;
    };

    assert.equal(page.configureGatewayAudioRenditions(
        preparedRenditions,
        { defaultHlsIndex: 0, defaultStreamIndex: exactTracks[0].index },
        exactTracks,
        {
            required: true,
            playbackAttemptId: 17,
            audioStreamIndex: exactTracks[0].index,
            verifiedTracks,
            audioLanguageValidationStatus: 'verified',
        },
    ), true);
    page.playHls('https://gateway.example/sessions/session-all-audio/playlist.m3u8', {
        playbackAttemptId: 17,
        autoplay: false,
    });
    page.hls.audioTracks = preparedRenditions.map((entry) => ({
        id: entry.hlsIndex,
        lang: entry.language,
    }));
    page.hls._audioTrack = 0;
    page.hls.emit(FakeHls.Events.AUDIO_TRACKS_UPDATED, { audioTracks: page.hls.audioTracks });
    page.hls.emit(FakeHls.Events.AUDIO_TRACK_SWITCHED, { id: 0 });

    const visible = page.getVisibleAudioTracks();
    assert.equal(visible.length, 10, 'no exact-file audio track is hidden from the user');
    assert.equal(visible.filter((track) => track.source === 'hls').length, 8);
    assert.equal(visible.filter((track) => track.source === 'probe').length, 2);
    assert.deepEqual(Array.from(visible, (track) => track.streamIndex), exactTracks.map((track) => track.index));

    const outsideCohort = visible[9];
    assert.equal(outsideCohort.source, 'probe');
    assert.equal(await page.selectAudioTrack(
        outsideCohort.source,
        outsideCohort.index,
        outsideCohort.streamIndex,
    ), undefined);
    assert.equal(restartCalls, 1, 'an out-of-cohort choice uses the serialized provider-safe restart');
    assert.equal(page.selectedAudioStreamIndex, exactTracks[9].index);
});

test('uncertified rendition language uses provider metadata only as a display fallback', () => {
    const WatchPage = loadWatchPage();
    const harness = makePage(WatchPage, { validationStatus: 'pending' });
    configureAndAttach(harness);
    const tracks = harness.page.getVisibleAudioTracks();

    assert.equal(tracks[0].language, null);
    assert.equal(tracks[1].language, null);
    assert.match(tracks[0].label, /^Unknown language/, 'an absent/und tag remains honestly unknown');
    assert.match(tracks[1].label, /^English/, 'a valid HLS language tag labels the menu immediately');
    assert.doesNotMatch(tracks[1].label, /English tag/i, 'the free-form provider title is not trusted');
    assert.equal(
        harness.page._gatewayAudioRenditions[1].language,
        null,
        'provider metadata never becomes the authoritative verified language',
    );
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

test('verified muxed mono exposes one exact catalogue row and clicking it never restarts playback', async () => {
    const WatchPage = loadWatchPage();
    const harness = makePage(WatchPage);
    const { page } = harness;
    page.content = {
        id: 'movie-mono',
        type: 'movie',
        audioTracksScope: 'file',
        audioLanguageValidationStatus: 'verified',
        audioTracks: [{ index: 7, lang: 'fra' }],
    };
    page.audioLanguageValidationStatus = 'verified';
    page.currentPlaybackMode = 'gateway-session';
    page.audioTracks = [{
        index: 7,
        language: 'fr',
        title: 'Provider supplied title must not appear',
        codec: 'eac3',
        channels: 2,
        default: true,
    }];
    page.selectedAudioStreamIndex = 7;
    page.directAudioStreamIndex = 7;
    page.video.readyState = 4;
    page.video.videoWidth = 1280;
    page.video.videoHeight = 720;
    let restartCalls = 0;
    page.queueSelectedAudioTrackRestart = () => {
        restartCalls += 1;
        throw new Error('muxed mono must never restart playback');
    };

    let option = null;
    page.audioList = {
        _html: '',
        setAttribute() {},
        set innerHTML(value) {
            this._html = value;
            const attrs = Object.fromEntries(
                [...value.matchAll(/data-([a-z-]+)="([^"]*)"/g)]
                    .map((match) => [match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), match[2]]),
            );
            const listener = { click: null };
            option = {
                dataset: attrs,
                textContent: value.replace(/<[^>]+>/g, '').trim(),
                addEventListener(type, callback) { listener[type] = callback; },
                click() { return listener.click?.(); },
            };
        },
        get innerHTML() { return this._html; },
        querySelectorAll(selector) { return selector === '.audio-option' && option ? [option] : []; },
    };
    page.updateAudioTracks = WatchPage.prototype.updateAudioTracks;

    assert.equal(page.configureGatewayAudioRenditions(null, null, [], {
        required: true,
        playbackAttemptId: 17,
    }), false);
    page.playHls('https://gateway.example/sessions/session-mono/playlist.m3u8', {
        playbackAttemptId: 17,
        autoplay: false,
    });
    const activeHls = page.hls;
    activeHls.audioTracks = [];
    activeHls.emit(FakeHls.Events.MANIFEST_PARSED, { audioTracks: [] });

    const tracks = page.getVisibleAudioTracks();
    assert.equal(page.isGatewayAudioRenditionFailClosed(), true, 'global topology remains fail closed');
    assert.deepEqual(Array.from(tracks, (track) => [track.source, track.index, track.streamIndex]), [
        ['gateway-muxed-mono', 0, 7],
    ]);
    assert.equal(tracks[0].label, 'French');
    assert.doesNotMatch(tracks[0].label, /Provider supplied title/i);
    assert.equal(option.dataset.source, 'gateway-muxed-mono');
    assert.equal(option.dataset.streamIndex, '7');

    const loadCalls = activeHls.loadSourceCalls.length;
    const destroyCalls = activeHls.destroyCalls;
    assert.equal(await page.selectAudioTrack('gateway-muxed-mono', 0, 7), true);
    option.click();
    await Promise.resolve();
    assert.equal(restartCalls, 0);
    assert.equal(page.hls, activeHls);
    assert.equal(activeHls.loadSourceCalls.length, loadCalls);
    assert.equal(activeHls.destroyCalls, destroyCalls);
    assert.equal(page.selectedAudioStreamIndex, 7);
    assert.equal(page.directAudioStreamIndex, 7);

    page.directAudioStreamIndex = 8;
    assert.equal(await page.selectAudioTrack('gateway-muxed-mono', 0, 7), false, 'a click-time identity race fails closed');
    assert.equal(restartCalls, 0);
    assert.equal(activeHls.loadSourceCalls.length, loadCalls);
    assert.equal(activeHls.destroyCalls, destroyCalls);

    page.directAudioStreamIndex = 7;
    page._gatewayAudioRenditionRequired = false;
    assert.equal(await page.selectAudioTrack('gateway-muxed-mono', 0, 7), false,
        'a click-time Gateway-context race never falls through to a probe restart');
    assert.equal(restartCalls, 0);
    page._gatewayAudioRenditionRequired = true;
    assert.equal(await page.selectAudioTrack('gateway-muxed-mono', 1, 7), false,
        'a forged relative row index is rejected');
    assert.equal(restartCalls, 0);
});

test('the explicit Gateway disabled-mono contract exposes its exact track before the first frame', () => {
    const WatchPage = loadWatchPage();
    const harness = makePage(WatchPage);
    const { page } = harness;
    page.content = {
        id: 'movie-mono-cold',
        type: 'movie',
        audioTracksScope: 'file',
        audioLanguageValidationStatus: 'verified',
        audioTracks: [{ index: 7, lang: 'eng' }],
    };
    page.audioLanguageValidationStatus = 'verified';
    const sessionAudioTracks = [{ index: 7, language: 'en', codec: 'aac', channels: 2, default: true }];
    page.audioTracks = page.resolvePlaybackAudioTracks(
        { video: 'h264', audioTracks: [] },
        { audioTracks: sessionAudioTracks },
    );
    assert.equal(page.audioTracks, sessionAudioTracks,
        'an empty codec-profile list must not mask the exact session track map');
    page.selectedAudioStreamIndex = 7;
    page.directAudioStreamIndex = 7;
    Object.assign(page.video, { readyState: 1, videoWidth: 0, videoHeight: 0, error: null });

    const disabledMono = {
        protocol: 1,
        enabled: false,
        reason: 'audio_track_count_below_minimum',
        sourceTrackCount: 1,
        preparedTrackCount: 0,
        defaultHlsIndex: null,
        defaultStreamIndex: null,
    };
    assert.equal(page.configureGatewayAudioRenditions([], disabledMono, page.audioTracks, {
        required: true,
        playbackAttemptId: 17,
        audioStreamIndex: 7,
        verifiedTracks: page.getContentAudioTracks(),
        audioLanguageValidationStatus: page.audioLanguageValidationStatus,
    }), false);
    assert.equal(page._gatewayAudioRenditionStatus, 'absent');
    assert.equal(page._gatewayMuxedMonoStreamIndex, 7);

    page.playHls('https://gateway.example/sessions/session-mono-cold/playlist.m3u8', {
        playbackAttemptId: 17,
        autoplay: false,
    });
    page.hls.audioTracks = [];
    page.hls.emit(FakeHls.Events.MANIFEST_PARSED, { audioTracks: [] });

    const tracks = page.getVisibleAudioTracks();
    assert.deepEqual(Array.from(tracks, (track) => [track.source, track.streamIndex, track.label]), [
        ['gateway-muxed-mono', 7, 'English'],
    ]);
});

test('malformed disabled-mono declarations remain visibly fail closed', () => {
    const WatchPage = loadWatchPage();
    const cases = [
        ['wrong reason', { reason: 'profile_incomplete' }],
        ['wrong source count', { sourceTrackCount: 2 }],
        ['prepared rendition mismatch', { preparedTrackCount: 1 }],
        ['default stream present', { defaultStreamIndex: 7 }],
    ];
    for (const [label, mutation] of cases) {
        const { page } = makePage(WatchPage);
        page.audioTracks = [{ index: 7, language: 'en', codec: 'aac', channels: 2 }];
        page.selectedAudioStreamIndex = 7;
        page.directAudioStreamIndex = 7;
        const declaration = {
            protocol: 1,
            enabled: false,
            reason: 'audio_track_count_below_minimum',
            sourceTrackCount: 1,
            preparedTrackCount: 0,
            defaultHlsIndex: null,
            defaultStreamIndex: null,
            ...mutation,
        };
        assert.equal(page.configureGatewayAudioRenditions([], declaration, page.audioTracks, {
            required: true,
            playbackAttemptId: 17,
            audioStreamIndex: 7,
        }), false, label);
        assert.equal(page._gatewayAudioRenditionStatus, 'invalid', label);
        assert.equal(page._gatewayMuxedMonoStreamIndex, null, label);
    }
});

test('unverified muxed mono exposes one honest informational row without enabling a restart', async () => {
    const WatchPage = loadWatchPage();
    const harness = makePage(WatchPage);
    const { page } = harness;
    page.content = { id: 'movie-amar', type: 'movie', rawTitle: 'ES ▎ Amar' };
    page.audioLanguageValidationStatus = 'not_analyzed';
    page.playingAudioVersionLabel = () => 'Spanish · Provider label';
    page.currentPlaybackMode = 'gateway-session';
    page.audioTracks = [{
        index: 1,
        title: 'Audio 1',
        codec: 'ac3',
        channels: 6,
        channelLayout: '5.1(side)',
        default: false,
    }];
    page.selectedAudioStreamIndex = 1;
    page.directAudioStreamIndex = 1;
    page.video.readyState = 4;
    page.video.videoWidth = 720;
    page.video.videoHeight = 304;
    let restartCalls = 0;
    page.queueSelectedAudioTrackRestart = () => { restartCalls += 1; };

    assert.equal(page.configureGatewayAudioRenditions(null, null, [], {
        required: true,
        playbackAttemptId: 17,
    }), false);
    page.playHls('https://gateway.example/sessions/session-amar/playlist.m3u8', {
        playbackAttemptId: 17,
        autoplay: false,
    });
    page.hls.audioTracks = [];
    page.hls.emit(FakeHls.Events.MANIFEST_PARSED, { audioTracks: [] });

    assert.equal(page.isGatewayAudioRenditionFailClosed(), true,
        'unmapped Gateway topology remains non-switchable');
    const tracks = page.getVisibleAudioTracks();
    assert.deepEqual(Array.from(tracks, (track) => [track.source, track.index]), [['none', -1]]);
    assert.equal(tracks[0].label, 'Spanish · Provider label · AC3 · 5.1');
    assert.doesNotMatch(tracks[0].label, /pending|verified/i);
    assert.equal(await page.selectAudioTrack(tracks[0].source, tracks[0].index), undefined);
    assert.equal(restartCalls, 0);

    page.directAudioStreamIndex = 2;
    assert.equal(page.getInformationalGatewayMuxedMonoAudioTrack(), null,
        'a stream identity mismatch stays visibly fail closed');
    assert.equal(page.getVisibleAudioTracks()[0].label, 'Audio tracks unavailable');
});

test('verified muxed mono exception rejects every ambiguous identity and topology', async () => {
    const WatchPage = loadWatchPage();
    const makeMuxedMono = () => {
        const harness = makePage(WatchPage);
        const { page } = harness;
        page.content = {
            id: 'movie-mono',
            type: 'movie',
            audioTracksScope: 'file',
            audioLanguageValidationStatus: 'verified',
            audioTracks: [{ index: 7, lang: 'fra' }],
        };
        page.audioLanguageValidationStatus = 'verified';
        page.currentPlaybackMode = 'gateway-session';
        page.audioTracks = [{ index: 7, language: 'fr', codec: 'aac', channels: 2, default: true }];
        page.selectedAudioStreamIndex = 7;
        page.directAudioStreamIndex = 7;
        page.video.readyState = 4;
        page.video.videoWidth = 1280;
        page.video.videoHeight = 720;
        page.configureGatewayAudioRenditions(null, null, [], {
            required: true,
            playbackAttemptId: 17,
        });
        page.playHls('https://gateway.example/sessions/session-mono/playlist.m3u8', {
            playbackAttemptId: 17,
            autoplay: false,
        });
        page.hls.audioTracks = [];
        page.hls.emit(FakeHls.Events.MANIFEST_PARSED, { audioTracks: [] });
        return page;
    };

    const mutations = [
        ['invalid rendition declaration', (page) => { page._gatewayAudioRenditionStatus = 'invalid'; }],
        ['unexpected ready status', (page) => { page._gatewayAudioRenditionStatus = 'ready'; }],
        ['unknown rendition status', (page) => { page._gatewayAudioRenditionStatus = 'unknown'; }],
        ['pending rendition status', (page) => { page._gatewayAudioRenditionStatus = 'pending'; }],
        ['Gateway not required', (page) => { page._gatewayAudioRenditionRequired = false; }],
        ['wrong playback mode', (page) => { page.currentPlaybackMode = 'engine'; }],
        ['stale attempt', (page) => { page._gatewayAudioRenditionAttemptId = 16; }],
        ['enumeration not observed', (page) => { page._gatewayHlsAudioTracksReady = false; }],
        ['pending audio selection', (page) => { page._pendingGatewayAudioStreamIndex = 7; }],
        ['video not ready', (page) => { page.video.readyState = 2; }],
        ['video readiness missing', (page) => { page.video.readyState = undefined; }],
        ['video readiness is NaN', (page) => { page.video.readyState = Number.NaN; }],
        ['video has a media error', (page) => { page.video.error = { code: 3 }; }],
        ['video has no rendered width', (page) => { page.video.videoWidth = 0; }],
        ['video width missing', (page) => { page.video.videoWidth = undefined; }],
        ['video height missing', (page) => { page.video.videoHeight = undefined; }],
        ['multiple HLS tracks', (page) => { page.hls.audioTracks = [{ id: 0 }, { id: 1 }]; }],
        ['single HLS id mismatch', (page) => { page.hls.audioTracks = [{ id: 2 }]; }],
        ['non-file catalogue scope', (page) => { page.content.audioTracksScope = 'union'; }],
        ['union validation status', (page) => { page.content.audioLanguageValidationStatus = 'verified_union'; }],
        ['fresh playback validation pending', (page) => { page.audioLanguageValidationStatus = 'pending'; }],
        ['unknown verified language', (page) => { page.content.audioTracks[0].lang = 'und'; }],
        ['multiple catalogue tracks', (page) => { page.content.audioTracks.push({ index: 8, lang: 'eng' }); }],
        ['probe index mismatch', (page) => { page.audioTracks[0].index = 8; }],
        ['probe language mismatch', (page) => { page.audioTracks[0].language = 'en'; }],
        ['direct stream mismatch', (page) => { page.directAudioStreamIndex = 8; }],
        ['direct stream missing', (page) => { page.directAudioStreamIndex = null; page.content.audioTracks[0].index = 0; page.audioTracks[0].index = 0; page.selectedAudioStreamIndex = 0; }],
        ['selected stream mismatch', (page) => { page.selectedAudioStreamIndex = 8; }],
        ['selected stream missing', (page) => { page.selectedAudioStreamIndex = null; page.content.audioTracks[0].index = 0; page.audioTracks[0].index = 0; page.directAudioStreamIndex = 0; }],
        ['catalogue stream missing', (page) => { page.content.audioTracks[0].index = null; page.audioTracks[0].index = 0; page.directAudioStreamIndex = 0; page.selectedAudioStreamIndex = 0; }],
        ['probe stream missing', (page) => { page.audioTracks[0].index = null; page.content.audioTracks[0].index = 0; page.directAudioStreamIndex = 0; page.selectedAudioStreamIndex = 0; }],
        ['catalogue stream boolean', (page) => { page.content.audioTracks[0].index = true; page.audioTracks[0].index = 1; page.directAudioStreamIndex = 1; page.selectedAudioStreamIndex = 1; }],
        ['probe stream whitespace', (page) => { page.content.audioTracks[0].index = 0; page.audioTracks[0].index = ' '; page.directAudioStreamIndex = 0; page.selectedAudioStreamIndex = 0; }],
    ];

    for (const [label, mutate] of mutations) {
        const page = makeMuxedMono();
        mutate(page);
        assert.equal(page.getVerifiedGatewayMuxedMonoAudioTrack(), null, label);
        if (label !== 'Gateway not required' && label !== 'wrong playback mode') {
            assert.equal(page.getVisibleAudioTracks()[0].source, 'none', `${label} stays visibly fail closed`);
            assert.equal(await page.selectAudioTrack('gateway-muxed-mono', 0, 7), false,
                `${label} cannot activate a stale muxed-mono button`);
        }
    }

    const strictSingleAlternate = makeMuxedMono();
    strictSingleAlternate.hls.audioTracks = [{ id: 0 }];
    strictSingleAlternate.hls.emit(FakeHls.Events.AUDIO_TRACKS_UPDATED, {
        audioTracks: strictSingleAlternate.hls.audioTracks,
    });
    assert.equal(strictSingleAlternate.getVerifiedGatewayMuxedMonoAudioTrack()?.streamIndex, 7,
        'the strict identity guard also accepts hls.js single-alternate form with id zero');
});

test('muxed-mono manifest proof belongs only to the current Hls instance', () => {
    const WatchPage = loadWatchPage();
    const harness = makePage(WatchPage);
    const { page } = harness;
    page.content = {
        id: 'movie-mono-reset',
        type: 'movie',
        audioTracksScope: 'file',
        audioLanguageValidationStatus: 'verified',
        audioTracks: [{ index: 1, lang: 'fra' }],
    };
    page.audioLanguageValidationStatus = 'verified';
    page.currentPlaybackMode = 'gateway-session';
    page.audioTracks = [{ index: 1, language: 'fr', codec: 'eac3', channels: 2 }];
    page.selectedAudioStreamIndex = 1;
    page.directAudioStreamIndex = 1;
    Object.assign(page.video, { readyState: 4, videoWidth: 1280, videoHeight: 720, error: null });
    page.configureGatewayAudioRenditions(null, null, [], {
        required: true,
        playbackAttemptId: 17,
    });

    page.playHls('https://gateway.example/sessions/first/playlist.m3u8', {
        playbackAttemptId: 17,
        autoplay: false,
    });
    const firstHls = page.hls;
    firstHls.audioTracks = [];
    firstHls.emit(FakeHls.Events.MANIFEST_PARSED, { audioTracks: [] });
    assert.equal(page.getVerifiedGatewayMuxedMonoAudioTrack()?.streamIndex, 1);

    page.playHls('https://gateway.example/sessions/recovery/playlist.m3u8', {
        playbackAttemptId: 17,
        autoplay: false,
    });
    const replacementHls = page.hls;
    assert.notEqual(replacementHls, firstHls);
    assert.equal(page._gatewayHlsAudioTracksReady, false);
    assert.equal(page.getVerifiedGatewayMuxedMonoAudioTrack(), null,
        'a replacement Hls cannot inherit the prior manifest proof');
    assert.equal(page.getVisibleAudioTracks()[0].source, 'none');

    replacementHls.audioTracks = [];
    replacementHls.emit(FakeHls.Events.MANIFEST_PARSED, {
        audioTracks: [{ id: 0 }, { id: 1 }],
    });
    assert.equal(page._gatewayHlsAudioTracksReady, false,
        'parsed alternate tracks cannot be mistaken for muxed mono while tracksInGroup is empty');
    assert.equal(page.getVerifiedGatewayMuxedMonoAudioTrack(), null);

    replacementHls.audioTracks = [];
    replacementHls.emit(FakeHls.Events.MANIFEST_PARSED, { audioTracks: [] });
    assert.equal(page.getVerifiedGatewayMuxedMonoAudioTrack()?.streamIndex, 1);
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
