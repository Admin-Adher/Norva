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

test('startup budget ships as engine telemetry revision 51', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'norvaEngine.js'), 'utf8');
    assert.match(source, /const ENGINE_VERSION = 51;/);
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
    engine.lib = {
        ff_read_frame_multi: async () => { throw new Error('BLOCK_HTTP_458'); },
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
