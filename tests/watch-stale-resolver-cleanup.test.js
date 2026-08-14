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
    const resolver = play.indexOf('resolved = await streamUrlResolver()');
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
    const stale = retry.indexOf('if (this.isStalePlaybackAttempt(playbackAttemptId))', session);
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
