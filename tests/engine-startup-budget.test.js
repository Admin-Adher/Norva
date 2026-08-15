const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const KIB = 1024;
const MIB = 1024 * KIB;

function loadEngineClass(fetchImpl = fetch) {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'norvaEngine.js'), 'utf8');
    const sandbox = {
        window: {},
        document: { createElement: () => ({}) },
        navigator: { userAgent: 'node-test' },
        performance,
        console,
        URL,
        fetch: fetchImpl,
        AbortController,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        TextDecoder,
        crypto,
    };
    sandbox.self = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'norvaEngine.js' });
    return sandbox.window.NorvaEngine;
}

function makeBareEngine(NorvaEngine) {
    const engine = Object.create(NorvaEngine.prototype);
    engine.url = 'https://media.invalid/title.mkv';
    engine.size = 16 * MIB;
    engine._raCache = [];
    engine._smallNextRead = false;
    engine._ac = new AbortController();
    engine._fetchCount = 0;
    engine._fetchAttemptCount = 0;
    engine._fetchBytes = 0;
    engine._fetchMs = 0;
    engine._fetchWindows = [];
    engine._startupFetchWindows = [];
    engine._startupActive = true;
    engine._startupDeadlineAt = performance.now() + 15_000;
    engine.timings = {};
    engine.log = () => {};
    return engine;
}

function rangeResponse(options, total = 64) {
    const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return {
        status: 206,
        ok: true,
        headers: { get: (name) => name.toLowerCase() === 'content-range' ? `bytes ${start}-${end}/${total}` : null },
        arrayBuffer: async () => new Uint8Array(end - start + 1).buffer,
    };
}

function providerBusyResponse() {
    return { status: 458, ok: false, headers: { get: () => null } };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test('startup budget ships with report ownership and cache-busted engine/Watch assets', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'norvaEngine.js'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');
    assert.match(source, /const ENGINE_VERSION = 53;/);
    assert.match(app, /\/js\/norvaEngine\.js\?v=55/);
    assert.match(app, /\/js\/pages\/WatchPage\.js\?v=137/);
});

test('load arms cue indexing after playable startup instead of a wall-clock timer', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'norvaEngine.js'), 'utf8');
    const start = source.indexOf('async load(url');
    const end = source.indexOf('_startupTimeoutError(stage)', start);
    const load = source.slice(start, end);
    assert.match(load, /await this\._withStartupDeadline\(this\._startupOutcomePromise, 'first-usable-append'\);[\s\S]*this\._armCueIndexAfterFirstFrame\(\)/);
    assert.doesNotMatch(load, /setTimeout\([\s\S]*_buildCueIndex/);
    assert.match(load.slice(0, load.indexOf('const factoryP')), /this\._nudgeDone = false;/,
        'every load, including a fresh start, must allow one startup playhead correction');
});

test('startup prefetch uses 512 KiB and later startup windows never exceed 1 MiB', async () => {
    const NorvaEngine = loadEngineClass();
    const engine = makeBareEngine(NorvaEngine);
    const requested = [];

    engine._cacheWindow = async (start, len) => {
        requested.push({ start, len });
        const window = { start, end: start + len, buf: new Uint8Array(len) };
        engine._raCache.push(window);
        return window;
    };

    await engine._prefetchStart();
    assert.deepStrictEqual(requested[0], { start: 0, len: 512 * KIB });

    const startupRead = await engine._readRange(0, 2 * MIB);
    assert.strictEqual(requested.length, 1, 'the cached 512 KiB head must not be fetched twice');
    assert.strictEqual(startupRead.length, 512 * KIB);

    const startupRemainder = await engine._readRange(512 * KIB, 2 * MIB);
    assert.deepStrictEqual(requested[1], { start: 512 * KIB, len: MIB });
    assert.strictEqual(requested[1].len, MIB,
        'a libav request larger than the startup cap must be fulfilled incrementally');
    assert.strictEqual(startupRemainder.length, MIB);

    engine._startupActive = false;
    engine._raCache.length = 0;
    await engine._readRange(0, 64 * KIB);
    assert.strictEqual(requested[2].len, 4 * MIB,
        'steady-state playback retains the existing 4 MiB connection-efficient window');
});

test('the global startup deadline stops transient retry cascades before a second fetch', async () => {
    const NorvaEngine = loadEngineClass();
    const engine = makeBareEngine(NorvaEngine);
    // Leave enough headroom for this assertion to run alongside CPU-heavy VM
    // engine tests; the bounded retry sleep itself consumes the remaining budget.
    engine._startupDeadlineAt = performance.now() + 500;
    let calls = 0;
    engine._fetchRange = async () => {
        calls += 1;
        throw new Error('Failed to fetch');
    };

    const startedAt = performance.now();
    await assert.rejects(
        () => engine._cacheWindow(0, 512 * KIB),
        (error) => error && error.code === 'ENGINE_STARTUP_TIMEOUT' && /cache-retry/.test(error.message),
    );
    assert.strictEqual(calls, 1, 'the expired global budget must prevent another upstream connection');
    assert.ok(performance.now() - startedAt < 1500, 'the test deadline must not inherit a 60 second request timeout');
});

test('an in-flight startup range is aborted at the remaining global deadline', async () => {
    let calls = 0;
    const stalledFetch = (_url, { signal }) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
        });
    };
    const NorvaEngine = loadEngineClass(stalledFetch);
    const engine = makeBareEngine(NorvaEngine);
    engine._startupDeadlineAt = performance.now() + 25;

    const startedAt = performance.now();
    await assert.rejects(
        () => engine._fetchRange(0, 512 * KIB),
        (error) => error && error.code === 'ENGINE_STARTUP_TIMEOUT' && /:fetch:/.test(error.message),
    );
    assert.strictEqual(calls, 1);
    assert.ok(performance.now() - startedAt < 500);
    assert.strictEqual(engine.timings.fetchAttempts, 1);
    assert.strictEqual(engine.timings.startupFetchWindows[0].outcome, 'timeout');
});

test('HTTP 458 remains terminal during the startup budget', async () => {
    let calls = 0;
    const NorvaEngine = loadEngineClass(async () => {
        calls += 1;
        return { status: 458, headers: { get: () => null } };
    });
    const engine = makeBareEngine(NorvaEngine);

    await assert.rejects(() => engine._cacheWindow(0, 512 * KIB), /BLOCK_HTTP_458/);
    assert.strictEqual(calls, 1, 'the deadline/retry policy must never soften a provider 458');
    assert.strictEqual(engine.timings.fetchAttempts, 1);
    assert.strictEqual(engine.timings.startupFetchWindows[0].outcome, 'http_458');
    assert.strictEqual(engine._stopRequested, true);
    assert.strictEqual(engine._ac.signal.aborted, true,
        'the active 458 must close the engine Range lane before any queued startup read can run');
});

test('appendBuffer alone does not end startup; updateend needs a real buffered range', () => {
    const NorvaEngine = loadEngineClass();
    const engine = new NorvaEngine({ currentTime: 0 }, {});
    const appended = [];
    const init = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]); // ftyp
    const media = new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66]); // moof

    engine.loadStartedAt = performance.now() - 100;
    engine._startupActive = true;
    engine._startupDeadlineAt = performance.now() + 15_000;
    engine._createStartupOutcome();
    engine._fetchCount = 2;
    engine._fetchAttemptCount = 3;
    engine._fetchBytes = 768 * KIB;
    engine._startupFetchWindows = [{ start: 0, requestedBytes: 512 * KIB, bytes: 512 * KIB, ms: 30, outcome: 'ok' }];
    engine.queue.push(init, media);
    const ranges = [];
    engine.sb = {
        updating: false,
        buffered: {
            get length() { return ranges.length; },
            start(index) { return ranges[index][0]; },
            end(index) { return ranges[index][1]; },
        },
        appendBuffer(chunk) { appended.push(chunk); },
    };

    engine._drain();
    assert.strictEqual(appended[0], init);
    assert.strictEqual(engine._startupActive, true, 'an init segment alone is not usable playback');
    assert.ok(Number.isFinite(engine.timings.firstAppendMs));
    assert.strictEqual(engine.timings.firstMediaAppendMs, undefined);

    engine._drain();
    assert.strictEqual(appended[1], media);
    assert.strictEqual(engine._startupActive, true, 'a synchronous moof append is not yet usable');
    assert.strictEqual(engine._markStartupUsableFromBuffer(), false);

    ranges.push([0, 3]);
    assert.strictEqual(engine._markStartupUsableFromBuffer(), true);
    assert.strictEqual(engine._startupActive, false);
    assert.ok(engine.timings.firstMediaAppendMs >= engine.timings.firstAppendMs);
    assert.strictEqual(engine.timings.firstMediaAppendFetches, 3);
    assert.strictEqual(engine.timings.firstMediaAppendSuccessfulFetches, 2);
    assert.strictEqual(engine.timings.firstMediaAppendFetchKB, 768);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(engine.timings.startupFetchWindows)),
        [{ start: 0, requestedBytes: 512 * KIB, bytes: 512 * KIB, ms: 30, outcome: 'ok' }],
    );
});

test('a buffered fragment before the resume playhead does not settle startup', () => {
    const NorvaEngine = loadEngineClass();
    const video = { currentTime: 132 };
    const engine = new NorvaEngine(video, {});
    const ranges = [[127.885, 129.95]];

    engine.loadStartedAt = performance.now() - 250;
    engine._startupActive = true;
    engine._startupDeadlineAt = performance.now() + 15_000;
    engine._startupTargetTime = 132;
    engine.timings = { startupTargetTime: 132 };
    engine._createStartupOutcome();
    engine.sb = {
        buffered: {
            get length() { return ranges.length; },
            start(index) { return ranges[index][0]; },
            end(index) { return ranges[index][1]; },
        },
    };

    assert.strictEqual(engine._markStartupUsableFromBuffer(), false);
    assert.strictEqual(engine._startupActive, true);
    assert.ok(Number.isFinite(engine.timings.firstBufferedAppendMs),
        'the first accepted media range must be timed independently');
    assert.strictEqual(engine.timings.firstBufferedRangeStart, 127.885);
    assert.strictEqual(engine.timings.firstBufferedRangeEnd, 129.95);
    assert.strictEqual(engine.timings.firstUsableAppendMs, undefined,
        'a range behind the playhead must never claim playable startup');

    ranges[0][1] = 132.6;
    assert.strictEqual(engine._markStartupUsableFromBuffer(), true);
    assert.strictEqual(engine._startupActive, false);
    assert.ok(Number.isFinite(engine.timings.firstUsableAppendMs));
    assert.strictEqual(engine.timings.playableTargetTime, 132);
    assert.strictEqual(engine.timings.playableRangeStart, 127.885);
    assert.strictEqual(engine.timings.playableRangeEnd, 132.6);
    assert.ok(engine.timings.playableBufferedAhead >= 0.5);
});

test('a pre-target range keeps startup reads capped at 1 MiB', async () => {
    const NorvaEngine = loadEngineClass();
    const engine = makeBareEngine(NorvaEngine);
    const requested = [];

    engine.video = { currentTime: 132 };
    engine._startupTargetTime = 132;
    engine.sb = {
        buffered: {
            length: 1,
            start: () => 127.885,
            end: () => 129.95,
        },
    };
    engine._createStartupOutcome();
    engine._cacheWindow = async (start, len) => {
        requested.push({ start, len });
        return { start, end: start + len, buf: new Uint8Array(len) };
    };

    assert.strictEqual(engine._markStartupUsableFromBuffer(), false);
    await engine._readRange(8 * MIB, 64 * KIB);
    assert.deepStrictEqual(requested[0], { start: 8 * MIB, len: MIB });
    assert.strictEqual(engine._startupActive, true);
});

test('startup nudge retargets an approximate seek that landed after the requested playhead', () => {
    const NorvaEngine = loadEngineClass();
    const video = { currentTime: 132 };
    const engine = new NorvaEngine(video, {});

    engine.loadStartedAt = performance.now() - 300;
    engine._startupActive = true;
    engine._startupDeadlineAt = performance.now() + 15_000;
    engine._startupTargetTime = 132;
    engine.timings = { startupTargetTime: 132 };
    engine._createStartupOutcome();
    engine._nudgeDone = false;
    engine.sb = {
        updating: false,
        timestampOffset: 134,
        buffered: {
            length: 1,
            start: () => 134,
            end: () => 136,
        },
    };

    engine._drain();

    assert.strictEqual(video.currentTime, 134.05);
    assert.strictEqual(engine._startupTargetTime, 134.05,
        'the playable target must follow the engine nudge, not wait forever on the old gap');
    assert.strictEqual(engine._startupActive, false);
    assert.strictEqual(engine.timings.playableTargetTime, 134.05);
});

test('startup nudge closes a sub-half-second resume gap in the same drain', () => {
    const NorvaEngine = loadEngineClass();
    const video = { currentTime: 132 };
    const engine = new NorvaEngine(video, {});

    engine.loadStartedAt = performance.now() - 300;
    engine._startupActive = true;
    engine._startupDeadlineAt = performance.now() + 15_000;
    engine._startupTargetTime = 132;
    engine.timings = { startupTargetTime: 132 };
    engine._createStartupOutcome();
    engine._nudgeDone = false;
    engine.sb = {
        updating: false,
        buffered: {
            length: 1,
            start: () => 132.2,
            end: () => 134,
        },
    };

    engine._drain();

    assert.strictEqual(video.currentTime, 132.25);
    assert.strictEqual(engine._startupTargetTime, 132.25);
    assert.strictEqual(engine._startupActive, false,
        'retargeted coverage must be re-evaluated without a second updateend');
    assert.strictEqual(engine.timings.playableTargetTime, 132.25);
});

test('fresh startup nudges onto a small positive first-range offset', () => {
    const NorvaEngine = loadEngineClass();
    const video = { currentTime: 0 };
    const engine = new NorvaEngine(video, {});

    engine.loadStartedAt = performance.now() - 100;
    engine._startupActive = true;
    engine._startupDeadlineAt = performance.now() + 15_000;
    engine._startupTargetTime = 0;
    engine.timings = { startupTargetTime: 0 };
    engine._createStartupOutcome();
    engine._nudgeDone = false;
    engine.sb = {
        updating: false,
        buffered: {
            length: 1,
            start: () => 0.1,
            end: () => 2,
        },
    };

    engine._drain();

    assert.ok(Math.abs(video.currentTime - 0.15) < 1e-9);
    assert.ok(Math.abs(engine._startupTargetTime - 0.15) < 1e-9);
    assert.strictEqual(engine._startupActive, false);
});

test('startup nudge selects the first future playable range, not buffered range zero', () => {
    const NorvaEngine = loadEngineClass();
    const video = { currentTime: 132 };
    const engine = new NorvaEngine(video, {});
    const ranges = [[127, 130], [134, 136]];

    engine.loadStartedAt = performance.now() - 300;
    engine._startupActive = true;
    engine._startupDeadlineAt = performance.now() + 15_000;
    engine._startupTargetTime = 132;
    engine.timings = { startupTargetTime: 132 };
    engine._createStartupOutcome();
    engine._nudgeDone = false;
    engine.sb = {
        updating: false,
        buffered: {
            get length() { return ranges.length; },
            start(index) { return ranges[index][0]; },
            end(index) { return ranges[index][1]; },
        },
    };

    engine._drain();

    assert.strictEqual(video.currentTime, 134.05);
    assert.strictEqual(engine._startupTargetTime, 134.05);
    assert.strictEqual(engine._startupActive, false,
        'the future range must settle startup in this drain without another append');
    assert.strictEqual(engine.timings.playableRangeStart, 134);
});

test('a short containing range cannot mask a later playable startup range', () => {
    const NorvaEngine = loadEngineClass();
    const video = { currentTime: 132 };
    const engine = new NorvaEngine(video, {});
    const ranges = [[131, 132.2], [134, 136]];

    engine.loadStartedAt = performance.now() - 300;
    engine._startupActive = true;
    engine._startupDeadlineAt = performance.now() + 15_000;
    engine._startupTargetTime = 132;
    engine.timings = { startupTargetTime: 132 };
    engine._createStartupOutcome();
    engine._nudgeDone = false;
    engine.sb = {
        updating: false,
        buffered: {
            get length() { return ranges.length; },
            start(index) { return ranges[index][0]; },
            end(index) { return ranges[index][1]; },
        },
    };

    engine._drain();

    assert.strictEqual(video.currentTime, 134.05,
        'the future decodable range must win over 0.2 seconds stranded at the old target');
    assert.strictEqual(engine._startupTargetTime, 134.05);
    assert.strictEqual(engine._startupActive, false);
    assert.strictEqual(engine.timings.playableRangeStart, 134);
});

test('cue indexing waits after the first frame until playback has 20 seconds buffered', async () => {
    const NorvaEngine = loadEngineClass();
    let frameCallback = null;
    let builds = 0;
    let bufferedAhead = 0.5;
    const video = {
        currentTime: 0,
        requestVideoFrameCallback(callback) { frameCallback = callback; return 15; },
        cancelVideoFrameCallback() {},
    };
    const engine = new NorvaEngine(video, {});
    engine.loadStartedAt = performance.now() - 100;
    engine._bufferedAhead = () => bufferedAhead;
    engine._buildCueIndex = async () => { builds += 1; };

    engine._armCueIndexAfterFirstFrame();
    frameCallback(performance.now(), { presentedFrames: 1, mediaTime: 0.1 });
    await Promise.resolve();

    assert.strictEqual(builds, 0,
        'a 4 MiB cue read must not take the Range lane while only startup margin remains');
    assert.strictEqual(engine.timings.cueIndexTrigger, 'video-frame-callback');
    assert.strictEqual(engine.timings.cueIndexStartedMs, undefined);

    bufferedAhead = 20;
    engine._handleTimeUpdate();
    await Promise.resolve();
    assert.strictEqual(builds, 1);
    assert.strictEqual(engine.timings.cueIndexBufferedAhead, 20);

    engine._handleTimeUpdate();
    await Promise.resolve();
    assert.strictEqual(builds, 1, 'buffer rechecks must remain single-flight');
});

test('cue index waits for the local video-frame callback and starts only once', async () => {
    const NorvaEngine = loadEngineClass();
    let frameCallback = null;
    let builds = 0;
    const video = {
        currentTime: 0,
        requestVideoFrameCallback(callback) { frameCallback = callback; return 17; },
        cancelVideoFrameCallback() {},
    };
    const engine = new NorvaEngine(video, {});
    engine.loadStartedAt = performance.now() - 100;
    engine._bufferedAhead = () => 20;
    engine._buildCueIndex = async () => { builds += 1; };

    assert.strictEqual(engine._armCueIndexAfterFirstFrame(), true);
    assert.strictEqual(builds, 0, 'cue parsing must not compete with startup media reads');

    frameCallback(performance.now(), { presentedFrames: 1, mediaTime: 132 });
    await Promise.resolve();
    assert.strictEqual(builds, 1);
    assert.strictEqual(engine.timings.cueIndexTrigger, 'video-frame-callback');

    assert.strictEqual(engine._armCueIndexAfterFirstFrame(), false);
    frameCallback(performance.now(), { presentedFrames: 2, mediaTime: 132.04 });
    await Promise.resolve();
    assert.strictEqual(builds, 1, 'frame callbacks and re-arming must remain single-flight');
});

test('cue index has a strict playing fallback when video-frame callbacks are unavailable', async () => {
    const NorvaEngine = loadEngineClass();
    const listeners = new Map();
    let builds = 0;
    const video = {
        currentTime: 0,
        paused: false,
        readyState: 2,
        videoWidth: 1920,
        videoHeight: 1080,
        addEventListener(name, callback) { listeners.set(name, callback); },
        removeEventListener(name, callback) {
            if (listeners.get(name) === callback) listeners.delete(name);
        },
    };
    const engine = new NorvaEngine(video, {});
    engine._bufferedAhead = () => 20;
    engine._buildCueIndex = async () => { builds += 1; };

    assert.strictEqual(engine._armCueIndexAfterFirstFrame(), true);
    assert.strictEqual(builds, 0);
    listeners.get('playing')();
    await Promise.resolve();
    assert.strictEqual(builds, 1);
    assert.strictEqual(engine.timings.cueIndexTrigger, 'playing-ready-state');
    assert.strictEqual(listeners.has('playing'), false);
});

test('cue index falls back to strict playing evidence when frame callback registration throws', async () => {
    const NorvaEngine = loadEngineClass();
    const listeners = new Map();
    let builds = 0;
    const video = {
        currentTime: 0,
        paused: false,
        readyState: 2,
        videoWidth: 1280,
        videoHeight: 720,
        requestVideoFrameCallback() { throw new Error('rVFC unavailable'); },
        addEventListener(name, callback) { listeners.set(name, callback); },
        removeEventListener(name, callback) {
            if (listeners.get(name) === callback) listeners.delete(name);
        },
    };
    const engine = new NorvaEngine(video, {});
    engine._bufferedAhead = () => 20;
    engine._buildCueIndex = async () => { builds += 1; };

    assert.strictEqual(engine._armCueIndexAfterFirstFrame(), true);
    listeners.get('playing')();
    await Promise.resolve();
    assert.strictEqual(builds, 1);
    assert.strictEqual(engine.timings.cueIndexTrigger, 'playing-ready-state');
});

test('a first HTTP 458 from post-frame cue indexing remains terminal', async () => {
    const NorvaEngine = loadEngineClass();
    const reports = [];
    const fatals = [];
    let frameCallback = null;
    const video = {
        currentTime: 0,
        requestVideoFrameCallback(callback) { frameCallback = callback; return 31; },
        cancelVideoFrameCallback() {},
    };
    const engine = new NorvaEngine(video, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    const busy = new Error('BLOCK_HTTP_458');
    engine._bufferedAhead = () => 20;
    engine._buildCueIndex = async () => { throw busy; };

    engine._armCueIndexAfterFirstFrame();
    frameCallback(performance.now(), { presentedFrames: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(engine._stopRequested, true);
    assert.strictEqual(engine._fatalSignaled, true);
    assert.strictEqual(fatals.length, 1);
    assert.strictEqual(fatals[0], busy);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'cue-index:provider-busy');
});

test('destroy cancels the pending cue-index frame observer', async () => {
    const NorvaEngine = loadEngineClass();
    let frameCallback = null;
    let cancelled = null;
    let builds = 0;
    const video = {
        currentTime: 0,
        requestVideoFrameCallback(callback) { frameCallback = callback; return 23; },
        cancelVideoFrameCallback(id) { cancelled = id; },
    };
    const engine = new NorvaEngine(video, {});
    engine._buildCueIndex = async () => { builds += 1; };

    engine._armCueIndexAfterFirstFrame();
    engine.destroy();
    assert.strictEqual(cancelled, 23);

    frameCallback(performance.now(), { presentedFrames: 1 });
    await Promise.resolve();
    assert.strictEqual(builds, 0);
});

test('destroy after the first frame prevents a deferred cue build at the healthy-buffer threshold', async () => {
    const NorvaEngine = loadEngineClass();
    let frameCallback = null;
    let builds = 0;
    let bufferedAhead = 0.5;
    const video = {
        currentTime: 0,
        removeEventListener() {},
        requestVideoFrameCallback(callback) { frameCallback = callback; return 29; },
        cancelVideoFrameCallback() {},
    };
    const engine = new NorvaEngine(video, {});
    engine._bufferedAhead = () => bufferedAhead;
    engine._buildCueIndex = async () => { builds += 1; };

    engine._armCueIndexAfterFirstFrame();
    frameCallback(performance.now(), { presentedFrames: 1 });
    await Promise.resolve();
    assert.strictEqual(builds, 0);

    engine.destroy();
    bufferedAhead = 20;
    engine._handleTimeUpdate();
    await Promise.resolve();
    assert.strictEqual(builds, 0);
});

test('SourceBuffer updateend and timeupdate both recheck the deferred cue health gate', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'norvaEngine.js'), 'utf8');
    const attachStart = source.indexOf('async _attachMediaSource()');
    const attachEnd = source.indexOf('// ---- audio transcode', attachStart);
    const attach = source.slice(attachStart, attachEnd);
    assert.match(attach, /addEventListener\('updateend',[\s\S]*this\._drain\(\);[\s\S]*this\._maybeStartCueIndexBuild\(\)/);

    const timeUpdateStart = source.indexOf('_handleTimeUpdate()');
    const timeUpdateEnd = source.indexOf('_handleSeeking()', timeUpdateStart);
    assert.match(source.slice(timeUpdateStart, timeUpdateEnd), /this\._maybeStartCueIndexBuild\(\)/);
});

test('range requests stay serialized when background cue work meets the media pump', async () => {
    let active = 0;
    let maxActive = 0;
    const NorvaEngine = loadEngineClass(async (_url, options) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
        const start = Number(match[1]);
        const end = Number(match[2]);
        return {
            status: 206,
            ok: true,
            headers: { get: (name) => name.toLowerCase() === 'content-range' ? `bytes ${start}-${end}/64` : null },
            arrayBuffer: async () => new Uint8Array(end - start + 1).buffer,
        };
    });
    const engine = makeBareEngine(NorvaEngine);
    engine._startupActive = false;

    await Promise.all([
        engine._fetchRange(0, 8),
        engine._fetchRange(8, 16),
    ]);

    assert.strictEqual(maxActive, 1, 'one engine must never own two concurrent raw Range pumps');
    assert.strictEqual(engine.timings.maxConcurrentRangeFetches, 1);
});

test('an active cue-index 458 aborts a queued pump with one terminal report', async () => {
    let calls = 0;
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const NorvaEngine = loadEngineClass(async (_url, options) => {
        calls += 1;
        if (calls === 1) {
            markFirstStarted();
            await new Promise((resolve) => { releaseFirst = resolve; });
            return providerBusyResponse();
        }
        return rangeResponse(options);
    });
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({ currentTime: 0 }, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    engine.url = 'https://media.invalid/cue-active-458.mkv';
    engine.size = 64;
    engine._startupActive = false;
    engine._bufferedAhead = () => 20;

    engine._startCueIndexAfterFirstFrame('video-frame-callback');
    await firstStarted;
    engine._pump = () => engine._fetchRange(8, 16);
    engine._startPump();
    releaseFirst();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(calls, 1, 'the queued media read must observe abort before entering fetch');
    assert.strictEqual(engine._pumpRunning, false);
    assert.strictEqual(engine.timings.maxConcurrentRangeFetches, 1);
    assert.strictEqual(engine._ac.signal.aborted, true);
    assert.strictEqual(engine._fatalSignaled, true);
    assert.match(engine._providerBusyTerminalError?.message || '', /BLOCK_HTTP_458/);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'cue-index:provider-busy');
    assert.strictEqual(fatals.length, 1, 'cue and aborted media paths must share one terminal callback');
    assert.match(fatals[0].message, /BLOCK_HTTP_458/);
});

test('a scrub prefetch 458 aborts a queued pump with one terminal report', async () => {
    let calls = 0;
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const NorvaEngine = loadEngineClass(async (_url, options) => {
        calls += 1;
        if (calls === 1) {
            markFirstStarted();
            await new Promise((resolve) => { releaseFirst = resolve; });
            return providerBusyResponse();
        }
        return rangeResponse(options);
    });
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({ currentTime: 0 }, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    engine.url = 'https://media.invalid/prefetch-active-458.mkv';
    engine.size = 64;
    engine._startupActive = false;
    engine._cueIndex = [{ t: 10, off: 0 }];

    const prefetch = engine.prefetchAt(10);
    await firstStarted;
    engine._pump = () => engine._fetchRange(8, 16);
    engine._startPump();
    releaseFirst();

    await prefetch;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(calls, 1);
    assert.strictEqual(engine._pumpRunning, false);
    assert.strictEqual(engine._fatalSignaled, true);
    assert.match(engine._providerBusyTerminalError?.message || '', /BLOCK_HTTP_458/);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'prefetch:provider-busy');
    assert.strictEqual(fatals.length, 1);
    assert.match(fatals[0].message, /BLOCK_HTTP_458/);
});

test('a scrub prefetch 458 aborts a queued demux seek with one terminal report', async () => {
    let calls = 0;
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const NorvaEngine = loadEngineClass(async (_url, options) => {
        calls += 1;
        if (calls === 1) {
            markFirstStarted();
            await new Promise((resolve) => { releaseFirst = resolve; });
            return providerBusyResponse();
        }
        return rangeResponse(options);
    });
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({ currentTime: 0 }, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    engine.url = 'https://media.invalid/prefetch-seek-active-458.mkv';
    engine.size = 64;
    engine.durationSec = 100;
    engine._startupActive = false;
    engine._cueIndex = [{ t: 10, off: 0 }];
    engine.oc = {};
    engine.fmtCtx = 1;
    engine.vS = { time_base_num: 1, time_base_den: 1000, index: 0 };
    engine.aS = null;
    engine._isBuffered = () => false;
    engine._stopPump = async () => {};
    engine._resetForSeek = async () => {};
    engine._clearSourceBuffer = async () => {};
    engine._initMuxer = async () => {};
    engine.lib = {
        AVSEEK_FLAG_BYTE: 2,
        avformat_seek_file_approx: async () => {
            try {
                await engine._readRange(8, 8);
                return 0;
            } catch (error) {
                // Mirrors the block-reader contract: libav sees a negative
                // AVERROR while the engine retains the authoritative cause.
                engine._lastReadError = error;
                return -5;
            }
        },
    };

    const prefetch = engine.prefetchAt(10);
    await firstStarted;
    const seek = engine.seek(10);
    releaseFirst();

    await Promise.all([prefetch, seek]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(calls, 1, 'the queued demux read must abort before opening another Range');
    assert.ok(engine._lastReadError == null || engine._lastReadError.code === 'ENGINE_RANGE_ABORTED',
        'the post-await terminal guard may skip demux entirely; otherwise its queued read must abort');
    assert.strictEqual(engine._fatalSignaled, true);
    assert.match(engine._providerBusyTerminalError?.message || '', /BLOCK_HTTP_458/);
    assert.strictEqual(reports.length, 1,
        'the derived byte-seek AVERROR must not become a second playback_error');
    assert.strictEqual(reports[0].stage, 'prefetch:provider-busy');
    assert.strictEqual(fatals.length, 1);
    assert.match(fatals[0].message, /BLOCK_HTTP_458/);
});

for (const blockedPhase of ['reset', 'clear-source-buffer', 'init-muxer']) {
    test(`a prefetch 458 stops seek after its awaited ${blockedPhase} phase`, async () => {
        let calls = 0;
        let releaseFirst;
        let markFirstStarted;
        const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
        const phaseStarted = deferred();
        const releasePhase = deferred();
        const NorvaEngine = loadEngineClass(async (_url, options) => {
            calls += 1;
            if (calls === 1) {
                markFirstStarted();
                await new Promise((resolve) => { releaseFirst = resolve; });
                return providerBusyResponse();
            }
            return rangeResponse(options);
        });
        const reports = [];
        const fatals = [];
        let demuxCalls = 0;
        let clearCalls = 0;
        let initCalls = 0;
        let pumpStarts = 0;
        let seekCallbacks = 0;
        const engine = new NorvaEngine({ currentTime: 0 }, {
            report: (event) => reports.push(event),
            onFatal: (error) => fatals.push(error),
            onSeek: () => { seekCallbacks += 1; },
        });
        engine.url = `https://media.invalid/seek-${blockedPhase}-458.mkv`;
        engine.size = 64;
        engine.durationSec = 100;
        engine._startupActive = false;
        engine._cueIndex = [{ t: 10, off: 0 }];
        engine.oc = {};
        engine.fmtCtx = 1;
        engine.vS = { time_base_num: 1, time_base_den: 1000, index: 0 };
        engine.aS = null;
        engine._isBuffered = () => false;
        engine._resetForSeek = async () => {
            if (blockedPhase !== 'reset') return;
            phaseStarted.resolve();
            await releasePhase.promise;
            throw new Error('LIB_TERMINATED');
        };
        engine._seekDemuxer = async () => { demuxCalls += 1; };
        engine._clearSourceBuffer = async () => {
            clearCalls += 1;
            if (blockedPhase !== 'clear-source-buffer') return;
            phaseStarted.resolve();
            await releasePhase.promise;
        };
        engine._initMuxer = async () => {
            initCalls += 1;
            if (blockedPhase !== 'init-muxer') return;
            phaseStarted.resolve();
            await releasePhase.promise;
        };
        engine._startPump = () => { pumpStarts += 1; };
        engine.lib = {};

        const prefetch = engine.prefetchAt(10);
        await firstStarted;
        const seek = engine.seek(10);
        await phaseStarted.promise;
        releaseFirst();
        await prefetch;
        releasePhase.resolve();
        await seek;
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.strictEqual(calls, 1);
        assert.strictEqual(reports.length, 1);
        assert.strictEqual(reports[0].stage, 'prefetch:provider-busy');
        assert.strictEqual(fatals.length, 1);
        if (blockedPhase === 'reset') {
            assert.strictEqual(demuxCalls, 0, 'a generic reset rejection after 458 must not reach demux');
        }
        if (blockedPhase === 'clear-source-buffer') {
            assert.strictEqual(initCalls, 0, 'a 458 during SourceBuffer clear must not initialize a muxer');
        }
        assert.strictEqual(pumpStarts, 0, 'a terminal seek must never clear stop by restarting the pump');
        assert.strictEqual(seekCallbacks, 0, 'a terminal seek must not publish misleading success telemetry');
    });
}

test('startPump cannot re-arm an engine whose provider-busy Range circuit is closed', async () => {
    const NorvaEngine = loadEngineClass();
    const engine = new NorvaEngine({ currentTime: 0 }, {});
    const busy = new Error('BLOCK_HTTP_458');
    let pumpCalls = 0;
    engine._startupActive = false;
    engine._recordProviderBusyTerminal(busy);
    engine._stopRequested = true;
    engine._ac.abort();
    engine._pump = async () => { pumpCalls += 1; };

    engine._startPump();
    await Promise.resolve();

    assert.strictEqual(pumpCalls, 0);
    assert.strictEqual(engine._pumpRunning, false);
    assert.strictEqual(engine._stopRequested, true,
        'startPump must not clear the stop flag after a terminal provider circuit');
});

test('an active demux seek 458 is restored from block-reader AVERROR and terminal once', async () => {
    let calls = 0;
    let seekCalls = 0;
    const NorvaEngine = loadEngineClass(async () => {
        calls += 1;
        return providerBusyResponse();
    });
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({ currentTime: 0 }, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    engine.url = 'https://media.invalid/active-seek-458.mkv';
    engine.size = 64;
    engine.durationSec = 100;
    engine._startupActive = false;
    engine._cueIndex = [{ t: 10, off: 0 }];
    engine.oc = {};
    engine.fmtCtx = 1;
    engine.vS = { time_base_num: 1, time_base_den: 1000, index: 0 };
    engine.aS = null;
    engine._isBuffered = () => false;
    engine._stopPump = async () => {};
    engine._resetForSeek = async () => {};
    engine._clearSourceBuffer = async () => {};
    engine._initMuxer = async () => {};
    engine.lib = {
        AVSEEK_FLAG_BYTE: 2,
        avformat_seek_file_approx: async () => {
            seekCalls += 1;
            try {
                await engine._readRange(0, 8);
                return 0;
            } catch (error) {
                engine._lastReadError = error;
                return -5;
            }
        },
    };

    await engine.seek(10);

    assert.strictEqual(calls, 1);
    assert.strictEqual(seekCalls, 1, 'provider busy must not be reclassified into a byte fallback');
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'seek:provider-busy');
    assert.strictEqual(fatals.length, 1);
    assert.match(fatals[0].message, /BLOCK_HTTP_458/);
    assert.strictEqual(engine._providerBusyTerminalError, fatals[0]);
});

test('a resume demux seek propagates the original block-reader 458 before fallback', async () => {
    let calls = 0;
    let seekCalls = 0;
    const NorvaEngine = loadEngineClass(async () => {
        calls += 1;
        return providerBusyResponse();
    });
    const engine = new NorvaEngine({ currentTime: 0 }, {});
    engine.url = 'https://media.invalid/resume-seek-458.mkv';
    engine.size = 64;
    engine.durationSec = 100;
    engine._startupActive = false;
    engine._cueIndex = [{ t: 10, off: 0 }];
    engine.fmtCtx = 1;
    engine.vS = { time_base_num: 1, time_base_den: 1000, index: 0 };
    engine.aS = null;
    engine.lib = {
        AVSEEK_FLAG_BYTE: 2,
        avformat_seek_file_approx: async () => {
            seekCalls += 1;
            try {
                await engine._readRange(0, 8);
                return 0;
            } catch (error) {
                engine._lastReadError = error;
                return -5;
            }
        },
    };

    await assert.rejects(engine._seekDemuxer(10), /BLOCK_HTTP_458/);

    assert.strictEqual(calls, 1);
    assert.strictEqual(seekCalls, 1);
    assert.match(engine._providerBusyTerminalError?.message || '', /BLOCK_HTTP_458/);
});

test('an unexpected demux Range abort remains diagnostic without provider-busy ownership', async () => {
    const NorvaEngine = loadEngineClass();
    const reports = [];
    const engine = new NorvaEngine({ currentTime: 0 }, {
        report: (event) => reports.push(event),
    });
    const aborted = new Error('ENGINE_RANGE_ABORTED');
    aborted.code = 'ENGINE_RANGE_ABORTED';
    engine.size = 64;
    engine.durationSec = 100;
    engine._startupActive = false;
    engine.oc = {};
    engine.fmtCtx = 1;
    engine.vS = { time_base_num: 1, time_base_den: 1000, index: 0 };
    engine.aS = null;
    engine._isBuffered = () => false;
    engine._stopPump = async () => {};
    engine._resetForSeek = async () => {};
    engine._clearSourceBuffer = async () => {};
    engine._initMuxer = async () => {};
    engine._ac.abort();
    engine.lib = {
        AVSEEK_FLAG_BYTE: 2,
        avformat_seek_file_approx: async () => {
            engine._lastReadError = aborted;
            return -5;
        },
    };

    await engine.seek(10);

    assert.strictEqual(engine._stopRequested, false);
    assert.strictEqual(engine._fatalSignaled, false);
    assert.strictEqual(engine._providerBusyTerminalError, null);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'seek:demux');
    assert.match(reports[0].message, /byte seek failed \(-5\)/);
});

test('a pump 458 aborts its queued Range and reports one original terminal cause', async () => {
    let calls = 0;
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const NorvaEngine = loadEngineClass(async (_url, options) => {
        calls += 1;
        if (calls === 1) {
            markFirstStarted();
            await new Promise((resolve) => { releaseFirst = resolve; });
            return providerBusyResponse();
        }
        return rangeResponse(options);
    });
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({ currentTime: 0 }, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    engine.url = 'https://media.invalid/pump-active-458.mkv';
    engine.size = 64;
    engine._startupActive = false;
    engine._pump = () => engine._fetchRange(0, 64);

    engine._startPump();
    await firstStarted;
    const queuedCue = engine._fetchRange(8, 16);
    releaseFirst();

    await assert.rejects(queuedCue, (error) => error?.code === 'ENGINE_RANGE_ABORTED');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(calls, 1);
    assert.strictEqual(engine._fatalSignaled, true);
    assert.match(engine._providerBusyTerminalError?.message || '', /BLOCK_HTTP_458/);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'pump:provider-busy');
    assert.strictEqual(fatals.length, 1);
    assert.match(fatals[0].message, /BLOCK_HTTP_458/);
});

test('a runtime pump restores block-reader 458 from AVERROR before the stop early-return', async () => {
    let calls = 0;
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const NorvaEngine = loadEngineClass(async (_url, options) => {
        calls += 1;
        if (calls === 1) {
            markFirstStarted();
            await new Promise((resolve) => { releaseFirst = resolve; });
            return providerBusyResponse();
        }
        return rangeResponse(options);
    });
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({ currentTime: 0 }, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    engine.url = 'https://media.invalid/runtime-block-reader-458.mkv';
    engine.size = 64;
    engine._startupActive = false;
    engine.fmtCtx = 1;
    engine.pkt = 2;
    engine._bufferedAhead = () => 0;
    engine.lib = {
        EAGAIN: 6,
        ff_read_frame_multi: async () => {
            try {
                await engine._readRange(0, 8);
                return [0, {}];
            } catch (error) {
                engine._lastReadError = error;
                return [-5, {}];
            }
        },
    };

    engine._startPump();
    await firstStarted;
    const queued = engine._fetchRange(8, 16);
    releaseFirst();

    await assert.rejects(queued, (error) => error?.code === 'ENGINE_RANGE_ABORTED');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(calls, 1);
    assert.strictEqual(engine._pumpRunning, false);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'pump:provider-busy');
    assert.strictEqual(fatals.length, 1);
    assert.match(fatals[0].message, /BLOCK_HTTP_458/);
    assert.strictEqual(engine._providerBusyTerminalError, fatals[0]);
});

test('a startup pump rejects its outcome with block-reader 458 before the watchdog', async () => {
    let calls = 0;
    let releaseFirst;
    let markFirstStarted;
    const workerSawReadError = deferred();
    const releaseWorker = deferred();
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const NorvaEngine = loadEngineClass(async (_url, options) => {
        calls += 1;
        if (calls === 1) {
            markFirstStarted();
            await new Promise((resolve) => { releaseFirst = resolve; });
            return providerBusyResponse();
        }
        return rangeResponse(options);
    });
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({ currentTime: 0 }, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    engine.url = 'https://media.invalid/startup-block-reader-458.mkv';
    engine.size = 64;
    engine._startupActive = true;
    engine._startupDeadlineAt = performance.now() + 25;
    engine.fmtCtx = 1;
    engine.pkt = 2;
    engine._bufferedAhead = () => 0;
    const outcome = engine._createStartupOutcome();
    engine._armStartupDeadline();
    engine.lib = {
        EAGAIN: 6,
        ff_read_frame_multi: async () => {
            try {
                await engine._readRange(0, 8);
                return [0, {}];
            } catch (error) {
                engine._lastReadError = error;
                workerSawReadError.resolve();
                await releaseWorker.promise;
                return [-5, {}];
            }
        },
    };

    engine._startPump();
    await firstStarted;
    const queued = engine._fetchRange(8, 16);
    releaseFirst();

    await assert.rejects(queued, (error) => error?.code === 'ENGINE_RANGE_ABORTED');
    await workerSawReadError.promise;
    const outcomeResult = await Promise.race([
        outcome.then(
            () => ({ state: 'resolved' }),
            (error) => ({ state: 'rejected', error }),
        ),
        new Promise((resolve) => setTimeout(() => resolve({ state: 'watchdog-wait' }), 40)),
    ]);

    assert.strictEqual(outcomeResult.state, 'rejected',
        'the first marker must settle startup before either worker AVERROR or watchdog');
    assert.match(outcomeResult.error?.message || '', /BLOCK_HTTP_458/);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.strictEqual(calls, 1);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'startup:provider-busy');
    assert.strictEqual(fatals.length, 0, 'load owns startup failures; runtime onFatal must stay unused');
    assert.match(engine._providerBusyTerminalError?.message || '', /BLOCK_HTTP_458/);
    assert.strictEqual(engine._providerBusyTerminalError?._norvaPlaybackFailureReported, true,
        'the exact startup error must carry the persisted-report ownership into WatchPage.load');
    assert.strictEqual(engine._providerBusyTerminalError?._norvaPlaybackFailureReportStage,
        'startup:provider-busy');

    releaseWorker.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(reports.length, 1,
        'the delayed pump AVERROR must not report after central startup settlement');
    assert.strictEqual(fatals.length, 0);
});

test('a startup stage cannot swallow or replace a block-reader 458', async () => {
    let calls = 0;
    const NorvaEngine = loadEngineClass(async () => {
        calls += 1;
        return providerBusyResponse();
    });
    const engine = new NorvaEngine({ currentTime: 0 }, {});
    engine.url = 'https://media.invalid/ts-extradata-stage-458.ts';
    engine.size = 64;
    engine._startupActive = true;
    engine._startupDeadlineAt = performance.now() + 15_000;
    engine._createStartupOutcome();

    const swallowedStage = (async () => {
        try {
            await engine._readRange(0, 8);
        } catch (error) {
            // Mirrors best-effort TS extradata probes that intentionally finish
            // after libav turns an onblockread failure into an AVERROR.
            engine._lastReadError = error;
        }
        return 'stage-resolved';
    })();

    await assert.rejects(
        engine._withStartupDeadline(swallowedStage, 'video-extradata'),
        /BLOCK_HTTP_458/,
    );
    await assert.rejects(
        engine._withStartupDeadline(Promise.reject(new Error('generic setup failure')), 'mime-select'),
        /BLOCK_HTTP_458/,
        'the first provider-busy cause must also outrank a later generic stage rejection',
    );
    engine._startupDeadlineAt = performance.now() - 1;
    await assert.rejects(
        engine._withStartupDeadline(Promise.resolve('late stage'), 'expired-stage'),
        /BLOCK_HTTP_458/,
        'provider busy must win even when the deadline assertion is already due',
    );

    assert.strictEqual(calls, 1);
    assert.match(engine._providerBusyTerminalError?.message || '', /BLOCK_HTTP_458/);
});

test('a provider-busy follower abort cannot finalize the pump EOF fallback', async () => {
    let calls = 0;
    let releaseFirst;
    let markFirstStarted;
    let trailerCalls = 0;
    let drains = 0;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const NorvaEngine = loadEngineClass(async (_url, options) => {
        calls += 1;
        if (calls === 1) {
            markFirstStarted();
            await new Promise((resolve) => { releaseFirst = resolve; });
            return providerBusyResponse();
        }
        return rangeResponse(options);
    });
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({ currentTime: 0 }, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    engine.url = 'https://media.invalid/eof-follower-abort.mkv';
    engine.size = 64;
    engine.durationSec = 100;
    engine._startupActive = false;
    engine._cueIndex = [{ t: 10, off: 0 }];
    engine.fmtCtx = 1;
    engine.pkt = 2;
    engine.vS = { time_base_num: 1, time_base_den: 1000, index: 0 };
    engine.vBase = null;
    engine.aS = null;
    engine._lastSeekT = 10;
    engine._byteSeekRetried = false;
    engine._bufferedAhead = () => 0;
    engine._writeTrailerChecked = async () => { trailerCalls += 1; return true; };
    engine._flushVideoPacketsAtEof = () => [];
    engine._drain = () => { drains += 1; };
    engine.lib = {
        EAGAIN: 6,
        AVERROR_EOF: -541478725,
        AVSEEK_FLAG_BYTE: 2,
        ff_read_frame_multi: async () => [-541478725, {}],
        avformat_seek_file_approx: async () => {
            try {
                await engine._readRange(8, 8);
                return 0;
            } catch (error) {
                engine._lastReadError = error;
                return -5;
            }
        },
    };

    const prefetch = engine.prefetchAt(10);
    await firstStarted;
    engine._startPump();
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirst();

    await prefetch;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(calls, 1);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'prefetch:provider-busy');
    assert.strictEqual(fatals.length, 1);
    assert.strictEqual(trailerCalls, 0, 'a terminal follower abort must never write a trailer');
    assert.strictEqual(drains, 0, 'a terminal follower abort must never drain or signal EOS');
    assert.strictEqual(engine.ended, false);
});

for (const fastTrailer of [false, true]) {
    test(`a provider 458 during ${fastTrailer ? 'fast' : 'legacy'} trailer cannot end MediaSource`, async () => {
        let calls = 0;
        let releaseFirst;
        let markFirstStarted;
        let eosCalls = 0;
        const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
        const trailerStarted = deferred();
        const releaseTrailer = deferred();
        const NorvaEngine = loadEngineClass(async (_url, options) => {
            calls += 1;
            if (calls === 1) {
                markFirstStarted();
                await new Promise((resolve) => { releaseFirst = resolve; });
                return providerBusyResponse();
            }
            return rangeResponse(options);
        });
        const reports = [];
        const fatals = [];
        const engine = new NorvaEngine({ currentTime: 0 }, {
            report: (event) => reports.push(event),
            onFatal: (error) => fatals.push(error),
        });
        engine.url = `https://media.invalid/${fastTrailer ? 'fast' : 'legacy'}-trailer-458.mkv`;
        engine.size = 64;
        engine._startupActive = false;
        engine._cueIndex = [{ t: 10, off: 0 }];
        engine.fmtCtx = 1;
        engine.pkt = 2;
        engine.oc = 3;
        engine.vS = null;
        engine.aS = null;
        engine._bufferedAhead = () => 0;
        engine._muxSkipTrailer = fastTrailer;
        engine._commitMuxWrite = () => {};
        engine.sb = {
            updating: false,
            buffered: { length: 0 },
            appendBuffer() { throw new Error('no append expected'); },
        };
        engine.ms = {
            readyState: 'open',
            endOfStream() { eosCalls += 1; },
        };
        engine.lib = {
            EAGAIN: 6,
            AVERROR_EOF: -541478725,
            ff_read_frame_multi: async () => [-541478725, {}],
            av_write_trailer: async () => {
                trailerStarted.resolve();
                await releaseTrailer.promise;
                return 0;
            },
        };

        const prefetch = engine.prefetchAt(10);
        await firstStarted;
        engine._startPump();
        await trailerStarted.promise;
        releaseFirst();
        await prefetch;
        releaseTrailer.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.strictEqual(calls, 1);
        assert.strictEqual(reports.length, 1);
        assert.strictEqual(reports[0].stage, 'prefetch:provider-busy');
        assert.strictEqual(fatals.length, 1);
        assert.strictEqual(engine.ended, false);
        assert.strictEqual(eosCalls, 0);
    });
}

for (const eofPhase of ['audio-decode', 'audio-encode']) {
    test(`a provider 458 during EOF ${eofPhase} prevents every later output phase`, async () => {
        let calls = 0;
        let releaseFirst;
        let markFirstStarted;
        let encodeCalls = 0;
        let trailerCalls = 0;
        const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
        const phaseStarted = deferred();
        const releasePhase = deferred();
        const NorvaEngine = loadEngineClass(async (_url, options) => {
            calls += 1;
            if (calls === 1) {
                markFirstStarted();
                await new Promise((resolve) => { releaseFirst = resolve; });
                return providerBusyResponse();
            }
            return rangeResponse(options);
        });
        const reports = [];
        const fatals = [];
        const engine = new NorvaEngine({ currentTime: 0 }, {
            report: (event) => reports.push(event),
            onFatal: (error) => fatals.push(error),
        });
        engine.url = `https://media.invalid/eof-${eofPhase}-458.mkv`;
        engine.size = 64;
        engine._startupActive = false;
        engine._cueIndex = [{ t: 10, off: 0 }];
        engine.fmtCtx = 1;
        engine.pkt = 2;
        engine.oc = 3;
        engine.vS = null;
        engine.aS = {};
        engine.copyAudio = false;
        engine._bufferedAhead = () => 0;
        engine._encodeAudio = async () => {
            encodeCalls += 1;
            if (eofPhase === 'audio-encode') {
                phaseStarted.resolve();
                await releasePhase.promise;
            }
            return [];
        };
        engine.lib = {
            EAGAIN: 6,
            AVERROR_EOF: -541478725,
            ff_read_frame_multi: async () => [-541478725, {}],
            ff_decode_multi: async () => {
                if (eofPhase === 'audio-decode') {
                    phaseStarted.resolve();
                    await releasePhase.promise;
                }
                return [];
            },
            av_write_trailer: async () => { trailerCalls += 1; return 0; },
        };

        const prefetch = engine.prefetchAt(10);
        await firstStarted;
        engine._startPump();
        await phaseStarted.promise;
        releaseFirst();
        await prefetch;
        releasePhase.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.strictEqual(calls, 1);
        assert.strictEqual(reports.length, 1);
        assert.strictEqual(fatals.length, 1);
        if (eofPhase === 'audio-decode') {
            assert.strictEqual(encodeCalls, 0, 'terminal state after decode must skip encode');
        }
        assert.strictEqual(trailerCalls, 0);
        assert.strictEqual(engine.ended, false);
    });
}

test('drain cannot append or signal EOS after stop, fatal, or provider-busy terminal state', () => {
    const NorvaEngine = loadEngineClass();
    for (const terminalState of ['stop', 'fatal', 'provider-busy']) {
        let appends = 0;
        let eosCalls = 0;
        const appendEngine = new NorvaEngine({ currentTime: 0 }, {});
        appendEngine.sb = {
            updating: false,
            buffered: { length: 0 },
            appendBuffer() { appends += 1; },
        };
        appendEngine.ms = { readyState: 'open', endOfStream() { eosCalls += 1; } };
        appendEngine.queue = [new Uint8Array([1, 2, 3])];
        const eosEngine = new NorvaEngine({ currentTime: 0 }, {});
        eosEngine.sb = {
            updating: false,
            buffered: { length: 0 },
            appendBuffer() { appends += 1; },
        };
        eosEngine.ms = { readyState: 'open', endOfStream() { eosCalls += 1; } };
        eosEngine.ended = true;
        for (const engine of [appendEngine, eosEngine]) {
            if (terminalState === 'stop') engine._stopRequested = true;
            if (terminalState === 'fatal') engine._fatalSignaled = true;
            if (terminalState === 'provider-busy') {
                engine._providerBusyTerminalError = new Error('BLOCK_HTTP_458');
            }
            engine._drain();
        }

        assert.strictEqual(appends, 0, `${terminalState} must block appendBuffer`);
        assert.strictEqual(eosCalls, 0, `${terminalState} must block endOfStream`);
        assert.strictEqual(appendEngine.queue.length, 1,
            `${terminalState} must leave terminal queue disposal to teardown`);
    }
});

test('an unexpected pump Range abort remains diagnostic without an armed terminal stop', async () => {
    const NorvaEngine = loadEngineClass();
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({ currentTime: 0 }, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    const aborted = new Error('ENGINE_RANGE_ABORTED');
    aborted.code = 'ENGINE_RANGE_ABORTED';
    engine._startupActive = false;
    engine._ac.abort();
    engine._pump = async () => { throw aborted; };

    engine._startPump();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(engine._stopRequested, false,
        'an AbortSignal alone is not proof that another terminal path owns reporting');
    assert.strictEqual(engine._fatalSignaled, false);
    assert.strictEqual(engine._providerBusyTerminalError, null);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'pump');
    assert.match(reports[0].message, /ENGINE_RANGE_ABORTED/);
    assert.strictEqual(fatals.length, 0);
});

test('a transient non-458 Range failure releases FIFO without globally aborting the engine', async () => {
    let calls = 0;
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const NorvaEngine = loadEngineClass(async (_url, options) => {
        calls += 1;
        if (calls === 1) {
            markFirstStarted();
            await new Promise((resolve) => { releaseFirst = resolve; });
            return { status: 503, ok: false, headers: { get: () => null } };
        }
        return rangeResponse(options);
    });
    const engine = new NorvaEngine({ currentTime: 0 }, {});
    engine.url = 'https://media.invalid/transient-503.mkv';
    engine.size = 64;
    engine._startupActive = false;

    const failed = engine._fetchRange(0, 8);
    await firstStarted;
    const queued = engine._fetchRange(8, 16);
    releaseFirst();

    await assert.rejects(failed, /BLOCK_HTTP_503/);
    const bytes = await queued;

    assert.strictEqual(bytes.length, 8);
    assert.strictEqual(calls, 2);
    assert.strictEqual(engine._ac.signal.aborted, false);
    assert.strictEqual(engine._stopRequested, false);
    assert.strictEqual(engine._providerBusyTerminalError, null);
});

test('a provider 458 abort is isolated to one engine instance', async () => {
    let callsA = 0;
    let callsB = 0;
    const NorvaEngine = loadEngineClass(async (url, options) => {
        if (url.includes('engine-a')) {
            callsA += 1;
            return providerBusyResponse();
        }
        callsB += 1;
        return rangeResponse(options);
    });
    const engineA = new NorvaEngine({ currentTime: 0 }, {});
    const engineB = new NorvaEngine({ currentTime: 0 }, {});
    engineA.url = 'https://media.invalid/engine-a.mkv';
    engineB.url = 'https://media.invalid/engine-b.mkv';
    engineA.size = engineB.size = 64;
    engineA._startupActive = engineB._startupActive = false;

    const [resultA, resultB] = await Promise.allSettled([
        engineA._fetchRange(0, 8),
        engineB._fetchRange(0, 8),
    ]);

    assert.strictEqual(resultA.status, 'rejected');
    assert.match(resultA.reason.message, /BLOCK_HTTP_458/);
    assert.strictEqual(resultB.status, 'fulfilled');
    assert.strictEqual(resultB.value.length, 8);
    assert.strictEqual(callsA, 1);
    assert.strictEqual(callsB, 1);
    assert.strictEqual(engineA._ac.signal.aborted, true);
    assert.strictEqual(engineB._ac.signal.aborted, false);
    assert.match(engineA._providerBusyTerminalError?.message || '', /BLOCK_HTTP_458/);
    assert.strictEqual(engineB._providerBusyTerminalError, null);
});

test('an expired append rejects startup for the load catch instead of runtime retry', async () => {
    const NorvaEngine = loadEngineClass();
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({ currentTime: 0 }, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    const media = new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66]);
    let appendCalls = 0;

    engine._startupActive = true;
    engine._startupDeadlineAt = performance.now() - 1;
    const outcome = engine._createStartupOutcome();
    engine.queue.push(media);
    engine.sb = {
        updating: false,
        buffered: { length: 0 },
        appendBuffer() { appendCalls += 1; },
    };

    engine._drain();
    await assert.rejects(outcome, (error) => error?.code === 'ENGINE_STARTUP_TIMEOUT');

    assert.strictEqual(appendCalls, 0, 'late startup bytes must not be appended after the deadline');
    assert.strictEqual(engine._stopRequested, true);
    assert.strictEqual(engine._fatalSignaled, false);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'startup:append');
    assert.strictEqual(fatals.length, 0, 'runtime onFatal would reopen the engine during startup');
});

test('the independent watchdog rejects a hung worker at the absolute startup deadline', async () => {
    const NorvaEngine = loadEngineClass();
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({}, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    engine._startupActive = true;
    engine._startupDeadlineAt = performance.now() + 25;
    engine._createStartupOutcome();
    engine._armStartupDeadline();

    const hungWorker = engine._withStartupDeadline(new Promise(() => {}), 'hung-worker');
    await assert.rejects(hungWorker,
        (error) => error?.code === 'ENGINE_STARTUP_TIMEOUT' && /:global:/.test(error.message));
    assert.strictEqual(engine._stopRequested, true);
    assert.strictEqual(reports[0].stage, 'startup:global');
    assert.strictEqual(fatals.length, 0);
});

test('a first pump 458 rejects load startup and never enters runtime onFatal', async () => {
    const NorvaEngine = loadEngineClass();
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({}, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    engine._startupActive = true;
    engine._startupDeadlineAt = performance.now() + 15_000;
    const outcome = engine._createStartupOutcome();
    const terminalError = new Error('BLOCK_HTTP_458');
    engine.lib = {
        ff_read_frame_multi: async () => { throw terminalError; },
    };
    engine.fmtCtx = 1;
    engine.pkt = 2;
    engine._bufferedAhead = () => 0;

    engine._startPump();
    await assert.rejects(outcome, /BLOCK_HTTP_458/);
    await Promise.resolve();

    assert.strictEqual(engine._stopRequested, true);
    assert.strictEqual(fatals.length, 0);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'pump:startup');
    assert.match(reports[0].message, /BLOCK_HTTP_458/);
    assert.strictEqual(terminalError._norvaPlaybackFailureReported, true,
        'direct startup pump failures must transfer report ownership to the load catch');
    assert.strictEqual(terminalError._norvaPlaybackFailureReportStage, 'pump:startup');
});

test('a post-startup pump 458 signals one terminal fatal and never retries', async () => {
    const NorvaEngine = loadEngineClass();
    const reports = [];
    const fatals = [];
    let reads = 0;
    const terminalError = new Error('BLOCK_HTTP_458');
    const engine = new NorvaEngine({}, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });

    engine._startupActive = false;
    engine._startupOutcomeSettled = true;
    engine.lib = {
        ff_read_frame_multi: async () => {
            reads += 1;
            throw terminalError;
        },
    };
    engine.fmtCtx = 1;
    engine.pkt = 2;
    engine._bufferedAhead = () => 0;

    engine._startPump();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();

    assert.strictEqual(reads, 1, 'HTTP 458 must never open another provider read');
    assert.strictEqual(engine._stopRequested, true);
    assert.strictEqual(engine._fatalSignaled, true);
    assert.strictEqual(fatals.length, 1, 'the terminal UI callback must run exactly once');
    assert.strictEqual(fatals[0], terminalError, 'the exact provider cause must reach the player');
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'pump:provider-busy');

    engine._startPump();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(reads, 1, 'a fatal engine must not restart its pump');
    assert.strictEqual(fatals.length, 1, 'a fatal engine must not duplicate the UI error');
});
