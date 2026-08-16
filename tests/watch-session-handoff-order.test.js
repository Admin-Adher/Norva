// Same-route VOD handoff contract for mono-account providers.
//
// The next cloud session must be resolved inside WatchPage.play(), because
// play() first expires the outgoing session and waits for provider slot release.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const watchSource = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'pages', 'WatchPage.js'),
    'utf8'
);
const appShell = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.html'),
    'utf8'
);

function section(startMarker, endMarker) {
    const start = watchSource.indexOf(startMarker);
    assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
    const end = watchSource.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
    return watchSource.slice(start, end);
}

function assertDeferredSessionResolver(body, label) {
    const playAt = body.indexOf('await this.play(');
    const resolveAt = body.indexOf('API.proxy.xtream.getStreamUrl');
    const resolutions = body.match(/API\.proxy\.xtream\.getStreamUrl/g) || [];

    assert.ok(playAt >= 0, `${label} must await WatchPage.play()`);
    assert.ok(resolveAt > playAt, `${label} must resolve only inside play()`);
    assert.equal(resolutions.length, 1, `${label} must open exactly one new lane`);
    assert.doesNotMatch(body.slice(0, playAt), /API\.proxy\.xtream\.getStreamUrl/);
    assert.match(body.slice(playAt, resolveAt), /async \(\) => \{/);
    assert.match(body.slice(resolveAt), /return result;/);
    assert.doesNotMatch(body.slice(0, playAt), /cloudPlaybackSessionId\s*:/);
}

test('recommended-title handoff defers its session until play() releases the old slot', () => {
    const binding = section('renderRecommendedGrid(movies, sourceId) {', '    async playRecommendedMovie(movie, sourceId) {');
    const body = section('async playRecommendedMovie(movie, sourceId) {', '    // === Series Episodes ===');

    assert.match(binding, /new Map\([\s\S]*String\(movie\.stream_id\)/,
        'the rendered recommendation must retain its already-loaded movie object');
    assert.match(binding, /playRecommendedMovie\(movie, sourceId\)/,
        'the click must pass the retained movie object without another catalogue lookup');
    assert.doesNotMatch(body, /vodStreams\(/,
        'the click path must enter play() without an asynchronous catalogue lookup first');
    assertDeferredSessionResolver(body, 'recommended-title handoff');
});

test('episode-list handoff defers its session until play() releases the old slot', () => {
    const body = section('async playEpisodeFromList(episodeEl) {', '    // === Next Episode ===');
    assertDeferredSessionResolver(body, 'episode-list handoff');
    assert.doesNotMatch(body, /releasePlaybackPipelineForRetry\(\)/,
        'the list path must not pre-release and then race a pre-resolved session');
});

test('next/previous/autoplay episode handoff defers its session through play()', () => {
    const body = section('async playEpisode(ep) {', '    // Restart the current movie/episode from 0');
    assertDeferredSessionResolver(body, 'episode handoff');
});

test('unsafe silent version failover remains dormant', () => {
    const occurrences = watchSource.match(/tryNextVersion\s*\(/g) || [];
    assert.equal(occurrences.length, 1, 'tryNextVersion must have no active caller');
});

test('changed playback assets have fresh app-shell cache versions', () => {
    assert.match(appShell, /\/js\/api\.js\?v=84/);
    assert.match(appShell, /\/js\/pages\/WatchPage\.js\?v=137/);
});

function fakeElement() {
    return {
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        style: {},
        dataset: {},
        scrollTo() {},
        setAttribute() {},
        removeAttribute() {},
        querySelector() { return fakeElement(); },
        querySelectorAll() { return []; },
        appendChild() {},
        remove() {},
        textContent: ''
    };
}

function loadWatchPage({ api = {}, mediaUtils = {} } = {}) {
    const context = {
        window: { NorvaCloud: {} },
        document: {
            getElementById() { return fakeElement(); },
            querySelector() { return fakeElement(); },
            createElement() { return fakeElement(); },
            documentElement: fakeElement(),
            body: fakeElement()
        },
        navigator: {},
        location: { origin: 'https://norva.tv' },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        console: { ...console, log() {} },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Promise,
        URL,
        URLSearchParams,
        API: api,
        MediaUtils: mediaUtils
    };
    vm.runInNewContext(watchSource, context, { filename: 'WatchPage.js' });
    return context.window.WatchPage;
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function dynamicPageHarness(WatchPage, { events, waitPromise = Promise.resolve() }) {
    const page = Object.create(WatchPage.prototype);
    Object.assign(page, {
        _playbackAttemptId: 10,
        _cloudPlaybackLaneAttemptId: null,
        _reportedProviderFailureKeys: new Set(),
        app: {
            currentPage: 'watch',
            player: { stop: async () => {} },
            navigateTo() {}
        },
        content: {
            type: 'series',
            id: 'episode-a',
            sourceId: 'source-a',
            seriesId: 'series-a',
            currentSeason: 1,
            currentEpisode: 1,
            title: 'Series'
        },
        currentSeason: 1,
        currentEpisode: 1,
        titleEl: fakeElement(),
        subtitleEl: fakeElement(),
        episodesSection: fakeElement(),
        recommendedSection: fakeElement(),
        video: fakeElement(),
        cancelFirstFrameTelemetryObserver() {},
        cancelDeferredEngineTrackEnrichment() {},
        trackPlaybackPosition() {},
        saveResumeSnapshotThrottled() {},
        saveProgress: async () => {},
        stop: async () => { events.push('stop'); },
        waitForProviderSlotRelease: async () => {
            events.push('wait');
            await waitPromise;
        },
        playbackMetadataFromResult(value = {}) {
            return {
                ...value,
                sessionId: value.sessionId || null,
                cloudPlaybackSessionId: value.sessionId || null
            };
        },
        beginPlaybackTelemetry() {},
        _fetchServerResumeInfo: async () => ({ answered: false, position: 0 }),
        _loadResumePosition: () => 0,
        recordPlaybackStartupPhase() {},
        normalizeDuration: () => null,
        durationFromCodecProfile: () => null,
        resetTrackSelectionState() {},
        setPendingPlaybackPreferences() {},
        cancelNextEpisode() {},
        resetSkipIntroState() {},
        loadIntroMarkers() {},
        resetStoryboard() {},
        loadStoryboard() {},
        saveResumeSnapshot() {},
        renderDetails() {},
        showLoading() {},
        showPlaybackError() {},
        cleanupStaleCloudPlaybackSession: async () => { events.push('cleanup'); },
        updatePlaybackTelemetrySession() {},
        replaceExactContentAudioMetadata() {}
    });
    return page;
}

function episodeContent(id) {
    return {
        type: 'series',
        id,
        sourceId: 'source-a',
        seriesId: 'series-a',
        currentSeason: 1,
        currentEpisode: id === 'episode-a' ? 1 : 2,
        title: 'Series',
        containerExtension: 'mkv'
    };
}

test('relaunching the active episode expires and cools the old slot before resolving', async () => {
    const WatchPage = loadWatchPage();
    const events = [];
    const page = dynamicPageHarness(WatchPage, { events });

    await page.play(episodeContent('episode-a'), async () => {
        events.push('resolve');
        return {};
    });

    assert.ok(events.indexOf('stop') >= 0);
    assert.ok(events.indexOf('wait') > events.indexOf('stop'));
    assert.ok(events.indexOf('resolve') > events.indexOf('wait'));
});

test('two handoffs sharing one teardown allow only the newest resolver to open', async () => {
    const WatchPage = loadWatchPage();
    const events = [];
    const gate = deferred();
    const page = dynamicPageHarness(WatchPage, { events, waitPromise: gate.promise });

    const first = page.play(episodeContent('episode-b'), async () => {
        events.push('resolve-b');
        return {};
    });
    const second = page.play(episodeContent('episode-c'), async () => {
        events.push('resolve-c');
        return {};
    });

    await Promise.resolve();
    await Promise.resolve();
    gate.resolve();
    await Promise.all([first, second]);

    assert.equal(events.filter((entry) => entry.startsWith('resolve-')).length, 1);
    assert.ok(!events.includes('resolve-b'));
    assert.ok(events.includes('resolve-c'));
});

test('recommendation clicks enter play synchronously without a stale catalogue await', async () => {
    let catalogueLookups = 0;
    const api = {
        proxy: {
            xtream: {
                vodStreams() {
                    catalogueLookups += 1;
                    return new Promise(() => {});
                }
            }
        }
    };
    const mediaUtils = {
        playbackHintFromItem(movie, fallback) {
            return { ...fallback, container: movie.container_extension };
        },
        safeImageUrl(value) { return value || ''; }
    };
    const WatchPage = loadWatchPage({ api, mediaUtils });
    const page = Object.create(WatchPage.prototype);
    const gate = deferred();
    const events = [];
    let leftWatch = false;
    page.play = async (content) => {
        events.push({ id: content.id, afterBack: leftWatch });
        await gate.promise;
    };

    const first = page.playRecommendedMovie({
        stream_id: 'movie-a',
        name: 'Movie A',
        container_extension: 'mkv'
    }, 'source-a');
    assert.deepEqual(events, [{ id: 'movie-a', afterBack: false }],
        'the first play intention must be entered before Back can run');

    leftWatch = true;
    assert.equal(events.length, 1, 'Back must not reveal a pending pre-play catalogue lookup');
    leftWatch = false;

    const second = page.playRecommendedMovie({
        stream_id: 'movie-b',
        name: 'Movie B',
        container_extension: 'mkv'
    }, 'source-a');

    assert.equal(catalogueLookups, 0, 'clicks must reuse the rendered catalogue objects');
    assert.deepEqual(events, [
        { id: 'movie-a', afterBack: false },
        { id: 'movie-b', afterBack: false }
    ], 'each click must reserve its play intention before the caller can navigate or click again');

    gate.resolve();
    await Promise.all([first, second]);
});
