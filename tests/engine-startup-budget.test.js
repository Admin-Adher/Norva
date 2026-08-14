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
    return engine;
}

test('startup budget ships as engine telemetry revision 46', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'norvaEngine.js'), 'utf8');
    assert.match(source, /const ENGINE_VERSION = 46;/);
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
