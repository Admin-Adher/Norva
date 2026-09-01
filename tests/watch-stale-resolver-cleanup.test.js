const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pages', 'WatchPage.js'), 'utf8');

function methodBody(anchor, nextAnchor) {
    const start = source.indexOf(anchor);
    assert.notStrictEqual(start, -1, `missing method anchor: ${anchor}`);
    const end = source.indexOf(nextAnchor, start + anchor.length);
    assert.notStrictEqual(end, -1, `missing method boundary: ${nextAnchor}`);
    return source.slice(start, end);
}

function loadWatchPage(cloud) {
    const context = {
        window: { NorvaCloud: cloud },
        console,
        setTimeout,
        clearTimeout,
        Promise,
        AbortController,
    };
    vm.runInNewContext(source, context, { filename: 'WatchPage.js' });
    return context.window.WatchPage;
}

function makeSessionPage(WatchPage, sessionIds = ['session-a']) {
    const page = Object.create(WatchPage.prototype);
    page.stopCloudPlaybackHeartbeat = () => {};
    page.activeCloudPlaybackSessionIds = new Set(sessionIds);
    page.currentCloudPlaybackSessionId = null;
    return page;
}

test('a playback session resolved after Back is expired before the stale result is ignored', () => {
    const play = methodBody('async play(content, streamUrl, playback = {})', '\n    async ');
    const resolver = play.indexOf('resolved = await streamUrlResolver({');
    const metadata = play.indexOf('const resolvedPlaybackMetadata = this.playbackMetadataFromResult');
    const session = play.indexOf('const resolvedSessionId = resolvedPlaybackMetadata.sessionId');
    const stale = play.indexOf('if (this.isStalePlaybackAttempt(playbackAttemptId))', session);
    const cleanup = play.indexOf('await this.cleanupStaleCloudPlaybackSession(resolvedSessionId)', stale);

    assert.ok(resolver >= 0, 'the asynchronous playback resolver must remain present');
    assert.ok(metadata > resolver, 'resolved metadata must be parsed immediately after resolution');
    assert.ok(session > metadata, 'the server-owned session id must be captured before the stale guard');
    assert.ok(stale > session, 'staleness must be checked only after the late session id is known');
    assert.ok(cleanup > stale, 'a stale late result must expire its exact server session');
    assert.ok(cleanup < play.indexOf('if (!resolved || !resolved.url)', stale),
        'cleanup must happen before any stale result is discarded');
});

test('Back invalidates an in-flight playback resolver before teardown starts', () => {
    const WatchPage = loadWatchPage({});
    const page = Object.create(WatchPage.prototype);
    page._playbackAttemptId = 7;
    page._cloudPlaybackLaneAttemptId = 7;
    page._goingBack = false;
    page.trackPlaybackPosition = () => {};
    page.saveResumeSnapshotThrottled = () => {};
    page.saveProgress = () => Promise.resolve();
    page.clearResumeSnapshot = () => {};
    page.cancelNextEpisode = () => {};
    page.stop = () => {
        assert.strictEqual(page._playbackAttemptId, 8,
            'a late resolver must already be stale when teardown starts');
        assert.strictEqual(page._cloudPlaybackLaneAttemptId, null);
        return Promise.resolve();
    };
    page.app = { navigateTo: () => {} };
    page.returnPage = 'movies';

    page.goBack();

    assert.strictEqual(page._playbackAttemptId, 8);
});

test('a newer playback attempt actively aborts the previous resolver request', () => {
    const WatchPage = loadWatchPage({});
    const page = Object.create(WatchPage.prototype);
    page._playbackAttemptId = 4;
    page._cloudPlaybackLaneAttemptId = 4;
    page._playbackResolveAbortController = new AbortController();
    const previousSignal = page._playbackResolveAbortController.signal;

    const attemptId = page.beginPlaybackAttempt();

    assert.strictEqual(attemptId, 5);
    assert.strictEqual(previousSignal.aborted, true,
        'the request owned by the previous attempt must be cancelled, not merely ignored later');
    assert.strictEqual(page.playbackResolveSignalForAttempt(attemptId).aborted, false);
});

test('Back still navigates and releases its latch when teardown throws synchronously', () => {
    const WatchPage = loadWatchPage({});
    const page = Object.create(WatchPage.prototype);
    const navigations = [];
    page._playbackAttemptId = 3;
    page._cloudPlaybackLaneAttemptId = 3;
    page._goingBack = false;
    page._suspendResumeSnapshotSave = false;
    page.beginPlaybackAttempt = WatchPage.prototype.beginPlaybackAttempt;
    page.persistPlaybackStateForExit = () => {};
    page.deactivateHistoryPersistence = () => {};
    page.stop = () => { throw new Error('synthetic teardown failure'); };
    page.clearResumeSnapshot = () => { throw new Error('must not run after stop throws'); };
    page.cancelNextEpisode = () => {};
    page.app = { navigateTo: (pageName) => navigations.push(pageName) };
    page.returnPage = 'movies';

    page.goBack();

    assert.deepStrictEqual(navigations, ['movies']);
    assert.strictEqual(page._goingBack, false);
    assert.strictEqual(page._suspendResumeSnapshotSave, false);
    assert.strictEqual(page._playbackAttemptId, 4);
});

test('route hide invalidates an in-flight playback resolver before teardown starts', () => {
    const WatchPage = loadWatchPage({});
    const page = Object.create(WatchPage.prototype);
    page._playbackAttemptId = 11;
    page._cloudPlaybackLaneAttemptId = 11;
    page._goingBack = false;
    page.trackPlaybackPosition = () => {};
    page.saveResumeSnapshotThrottled = () => {};
    page.saveProgress = () => Promise.resolve();
    page.clearResumeSnapshot = () => {};
    page.cancelNextEpisode = () => {};
    page.stop = () => {
        assert.strictEqual(page._playbackAttemptId, 12,
            'route navigation must stale a resolver before releasing known sessions');
        assert.strictEqual(page._cloudPlaybackLaneAttemptId, null);
        return Promise.resolve();
    };

    page.hide();

    assert.strictEqual(page._playbackAttemptId, 12);
});

test('an explicit conversion resolved after Back expires its exact late session', () => {
    const retry = methodBody('async retryPlaybackInPlace(positionOverride = null)', '\n    clearPlaybackErrorRefreshTimer()');
    const resolve = retry.indexOf('const result = await API.proxy.xtream.getStreamUrl');
    const session = retry.indexOf('const resultSessionId = this.playbackMetadataFromResult(result).sessionId', resolve);
    const stale = retry.indexOf('if (this.isStalePlaybackAttempt(playbackAttemptId)', session);
    const cleanup = retry.indexOf('await this.cleanupStaleCloudPlaybackSession(resultSessionId)', stale);
    const register = retry.indexOf('this.content.cloudPlaybackSessionId = resultSessionId || null', cleanup);
    const load = retry.indexOf('await this.loadVideo(', register);

    assert.ok(resolve >= 0, 'the explicit conversion resolver must remain present');
    assert.ok(session > resolve, 'the late server-owned session id must be extracted immediately');
    assert.ok(stale > session, 'Back/navigation staleness must be checked after the id is known');
    assert.ok(cleanup > stale, 'the exact late session must be expired before returning');
    assert.ok(register > cleanup, 'a stale session must never become the active page session');
    assert.ok(load > register, 'media loading must only begin after the stale guard');
});

test('a resolved response without a media URL also expires its server-owned session', () => {
    const play = methodBody('async play(content, streamUrl, playback = {})', '\n    async ');
    const missingUrl = play.indexOf('if (!resolved || !resolved.url)');
    const cleanup = play.indexOf('await this.cleanupStaleCloudPlaybackSession(resolvedSessionId)', missingUrl);
    const error = play.indexOf("this.showPlaybackError('This title could not be started. Please try again.'", missingUrl);

    assert.ok(missingUrl >= 0);
    assert.ok(cleanup > missingUrl, 'malformed responses must release the session they already created');
    assert.ok(error > cleanup, 'the session release must be awaited before the terminal error is painted');
});

test('an initial resolver failure disables silent retry while keeping the explicit Retry action', () => {
    const play = methodBody('async play(content, streamUrl, playback = {})', '\n    async ');
    const resolverCatchStart = play.indexOf('} catch (err) {', play.indexOf('resolved = await streamUrlResolver()'));
    const resolverCatchEnd = play.indexOf('// A cloud resolver can finish after Back/navigation', resolverCatchStart);
    const resolverCatch = play.slice(resolverCatchStart, resolverCatchEnd);
    assert.match(resolverCatch, /allowAutomaticRetry:\s*false/,
        'a rejected initial resolver must not schedule a second hidden session');

    const missingUrlStart = play.indexOf('if (!resolved || !resolved.url)');
    const missingUrlEnd = play.indexOf('streamUrl = resolved.url', missingUrlStart);
    assert.match(play.slice(missingUrlStart, missingUrlEnd), /allowAutomaticRetry:\s*false/,
        'a malformed initial resolution must also remain user-driven after cleanup');

    let retryClick = null;
    let scheduled = 0;
    let explicitRetries = 0;
    const videoSectionClasses = new Set();
    const videoSection = {
        appendChild() {},
        classList: {
            add(value) { videoSectionClasses.add(value); },
            remove(value) { videoSectionClasses.delete(value); },
            contains(value) { return videoSectionClasses.has(value); },
        },
    };
    const errorEl = {
        innerHTML: '',
        classList: { add() {}, remove() {}, contains() { return false; } },
        setAttribute() {},
    };
    const retryButton = {
        addEventListener(type, listener) {
            if (type === 'click') retryClick = listener;
        },
    };
    const document = {
        getElementById(id) {
            if (id === 'watch-error') return errorEl;
            if (id === 'watch-error-refresh-btn') return retryButton;
            return null;
        },
        createElement() { return errorEl; },
        querySelector(selector) {
            return selector === '.watch-video-section' ? videoSection : null;
        },
    };
    const context = {
        window: { NorvaCloud: {} },
        document,
        console,
        setTimeout: () => 0,
        clearTimeout,
        Promise,
    };
    vm.runInNewContext(source, context, { filename: 'WatchPage.js' });
    const page = Object.create(context.window.WatchPage.prototype);
    page.hasCurrentMedia = () => false;
    page.sanitizePlaybackMessage = (message) => message;
    page.shouldDeferPlaybackError = () => false;
    page.clearDeferredPlaybackError = () => {};
    page.hideLoading = () => {};
    page.updateTranscodeStatus = () => {};
    page.getFriendlyPlaybackError = (message) => message;
    page.isPlaybackSupersededError = () => false;
    page.isProviderBusyError = () => false;
    page.isConnectionLimitError = () => false;
    page.isCloudPlaybackMode = () => false;
    page.schedulePlaybackErrorRefresh = () => { scheduled += 1; return true; };
    page.escapeHtml = (value) => String(value);
    page.clearPlaybackErrorRefreshTimer = () => {};
    page.retryPlaybackInPlace = () => { explicitRetries += 1; };

    page.showPlaybackError('resolver failed', {
        immediate: true,
        allowAutomaticRetry: false,
    });

    assert.strictEqual(scheduled, 0, 'no timer-driven retry may be armed');
    assert.strictEqual(typeof retryClick, 'function', 'the visible Retry button must stay wired');
    assert.strictEqual(videoSectionClasses.has('has-playback-error'), true,
        'the player shell must expose an error state so Back can stay above the blocking panel');
    retryClick();
    assert.strictEqual(explicitRetries, 1, 'only the explicit click starts a new attempt');

    page.hidePlaybackError();
    assert.strictEqual(videoSectionClasses.has('has-playback-error'), false,
        'clearing the error must restore the ordinary player stacking order');
});

test('terminal playback errors keep only Back interactive above the retry panel', () => {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'main.css'), 'utf8');
    assert.match(css, /\.watch-video-section\.has-playback-error\s+\.watch-overlay\s*\{[^}]*display:\s*flex\s*!important/s,
        'the error state must override the global .hidden display rule so Back keeps real geometry');
    assert.match(css, /\.watch-video-section\.has-playback-error\s+\.watch-overlay\s*\{[^}]*z-index:\s*16[^}]*pointer-events:\s*none/s);
    assert.match(css, /\.watch-video-section\.has-playback-error\s+\.watch-overlay\s*>\s*:not\(\.watch-top-bar\)\s*\{[^}]*visibility:\s*hidden/s);
    assert.match(css, /\.watch-video-section\.has-playback-error\s+\.watch-top-bar\s*>\s*\*\s*\{[^}]*pointer-events:\s*none/s);
    assert.match(css, /\.watch-video-section\.has-playback-error\s+\.watch-back-btn\s*\{[^}]*pointer-events:\s*auto/s);
});

test('stale-session cleanup keeps the JWT playback API when a user token is present', async () => {
    const calls = [];
    const cloud = {
        token: 'user-jwt',
        deviceToken: 'device-token',
        playback: { expireSession: async (id) => calls.push(['jwt', id]) },
        device: { playback: { expireSession: async (id) => calls.push(['device', id]) } },
    };
    const WatchPage = loadWatchPage(cloud);

    await Object.create(WatchPage.prototype).cleanupStaleCloudPlaybackSession('stale-jwt');

    assert.deepStrictEqual(calls, [['jwt', 'stale-jwt']]);
});

test('stale-session cleanup uses device playback when only a device token is present', async () => {
    const calls = [];
    const cloud = {
        token: null,
        deviceToken: 'device-token',
        playback: { expireSession: async (id) => calls.push(['jwt', id]) },
        device: { playback: { expireSession: async (id) => calls.push(['device', id]) } },
    };
    const WatchPage = loadWatchPage(cloud);

    await Object.create(WatchPage.prototype).cleanupStaleCloudPlaybackSession('stale-device');

    assert.deepStrictEqual(calls, [['device', 'stale-device']]);
});

test('bulk session stop keeps the JWT playback API when a user token is present', async () => {
    const calls = [];
    const options = { reason: 'navigation' };
    const cloud = {
        token: 'user-jwt',
        deviceToken: 'device-token',
        playback: { expireSession: async (id, value) => calls.push(['jwt', id, value]) },
        device: { playback: { expireSession: async (id, value) => calls.push(['device', id, value]) } },
    };
    const WatchPage = loadWatchPage(cloud);
    const page = makeSessionPage(WatchPage, ['session-jwt']);

    await page.stopCloudPlaybackSessions(options);

    assert.deepStrictEqual(calls, [['jwt', 'session-jwt', options]]);
});

test('bulk session stop uses device playback when only a device token is present', async () => {
    const calls = [];
    const options = { reason: 'navigation' };
    const cloud = {
        token: null,
        deviceToken: 'device-token',
        playback: { expireSession: async (id, value) => calls.push(['jwt', id, value]) },
        device: { playback: { expireSession: async (id, value) => calls.push(['device', id, value]) } },
    };
    const WatchPage = loadWatchPage(cloud);
    const page = makeSessionPage(WatchPage, ['session-device']);

    await page.stopCloudPlaybackSessions(options);

    assert.deepStrictEqual(calls, [['device', 'session-device', options]]);
});

test('session expiry fails closed without an authenticated matching API', async () => {
    const calls = [];
    const cloud = {
        token: null,
        deviceToken: null,
        playback: { expireSession: async (id) => calls.push(['jwt', id]) },
        device: { playback: { expireSession: async (id) => calls.push(['device', id]) } },
    };
    const WatchPage = loadWatchPage(cloud);
    const page = makeSessionPage(WatchPage, ['unauthenticated-active']);
    page.currentCloudPlaybackSessionId = 'unauthenticated-current';

    await Object.create(WatchPage.prototype).cleanupStaleCloudPlaybackSession('unauthenticated-stale');
    await page.stopCloudPlaybackSessions();

    assert.deepStrictEqual(Array.from(page.activeCloudPlaybackSessionIds), ['unauthenticated-active'],
        'unreleased sessions must remain tracked so a later authenticated cleanup can retry');
    assert.strictEqual(page.currentCloudPlaybackSessionId, 'unauthenticated-current');
    assert.deepStrictEqual(calls, [], 'an exposed API object without its matching token must not be called');
});
