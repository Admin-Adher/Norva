'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const providerFailure = require('../services/media-gateway/src/providerFailure.js');
const { providerAccountAffinityKey } = require('../services/media-gateway/src/providerProxyPool.js');

const ROOT = path.join(__dirname, '..');
const GATEWAY_PATH = path.join(ROOT, 'services/media-gateway/src/index.js');
const readGateway = () => fs.readFileSync(GATEWAY_PATH, 'utf8').replace(/\r\n/g, '\n');

function sourceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
    assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
    return source.slice(start, end);
}

function readForPump(reader, signal) {
    if (signal?.aborted) return Promise.resolve({ aborted: true, done: false, timedOut: false });
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
        };
        const onAbort = () => finish({ aborted: true, done: false, timedOut: false });
        signal?.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(reader.read()).then(
            ({ value, done }) => finish({ value, done, aborted: false, timedOut: false }),
            (error) => finish({ error, done: false, aborted: false, timedOut: false }),
        );
        if (signal?.aborted) onAbort();
    });
}

function pumpHarness(overrides = {}) {
    const source = readGateway();
    const looksLikeTextStartSource = sourceBetween(
        source,
        'function looksLikeTextStart(',
        '\nfunction normalizedRawTextPrefix(',
    ).trim();
    const normalizedRawTextPrefixSource = sourceBetween(
        source,
        'function normalizedRawTextPrefix(',
        '\nfunction isRawTextManifest(',
    ).trim();
    const isProviderBusyTextSource = sourceBetween(
        source,
        'function isProviderBusyText(',
        '\n// Returns need-more only while',
    ).trim();
    const helperGlobals = { Buffer, TextDecoder, RAW_PREFIX_SNIFF_BYTES: 512 };
    const looksLikeTextStart = vm.runInNewContext(`(${looksLikeTextStartSource})`, helperGlobals);
    const normalizedRawTextPrefix = vm.runInNewContext(`(${normalizedRawTextPrefixSource})`, helperGlobals);
    const isProviderBusyText = vm.runInNewContext(`(${isProviderBusyTextSource})`, helperGlobals);
    const helpers = sourceBetween(
        source,
        'function normalizeFileSizeBytes(',
        '\nfunction startFfmpeg(',
    );
    const globals = {
        URL,
        path,
        Buffer,
        ArrayBuffer,
        TextDecoder,
        Date,
        AbortController,
        setTimeout,
        clearTimeout,
        VOD_FILE_SIZE_PROBE_TIMEOUT_MS: 100,
        PROVIDER_SLOT_RELEASE_DELAY_MS: 0,
        VOD_INPUT_OPEN_TIMEOUT_MS: 1_000,
        VOD_INPUT_IDLE_TIMEOUT_MS: 1_000,
        VOD_INPUT_RETRY_LIMIT: 2,
        VOD_INPUT_MAX_RECONNECTS: 16,
        VOD_INPUT_RETRY_DELAYS_MS: [0, 0, 0, 0],
        VOD_INPUT_MIN_PROGRESS_RESET_BYTES: 8,
        RAW_PREFIX_SNIFF_BYTES: 512,
        FFMPEG_USER_AGENT: 'Norva/Test',
        providerProxyAgents: [],
        vodInputPumpStats: {
            starts: 0,
            completed: 0,
            failures: 0,
            reconnects: 0,
            bytesForwarded: 0,
            last: null,
        },
        asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
        compactRecord: (record) => Object.fromEntries(Object.entries(record || {}).filter(([, value]) => (
            value !== undefined && value !== null && value !== ''
        ))),
        normalizeCodecToken: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
        isLiveSession: (session) => ['live', 'channel'].includes(String(
            session?.playbackHint?.streamType || session?.playbackHint?.stream_type || '',
        ).toLowerCase()),
        proxyKeyFromUrl: () => 'provider.example/account',
        pickProxyAgent: () => null,
        classifyProviderResponseFailure: providerFailure.classifyProviderResponseFailure,
        classifyProviderFetchFailure: providerFailure.classifyProviderFetchFailure,
        shouldRetryProviderStatus: providerFailure.shouldRetryProviderStatus,
        looksLikeTextStart,
        normalizedRawTextPrefix,
        isProviderBusyText,
        readRawPrefixChunk: readForPump,
        sleep: async () => {},
        fetch: async () => { throw new Error('unexpected fetch'); },
        ...overrides,
    };
    return vm.runInNewContext(
        `(() => { ${helpers}; return {
            normalizeFileSizeBytes,
            fileSizeBytesForSession,
            isFiniteMkvVodSession,
            parseProviderFileSize,
            probeProviderFileSize,
            ensureBoundedMkvInputPump,
            parseBoundedProviderContentRange,
            boundedVodResponseValidator,
            writeVodInputChunk,
            finishVodInput,
            runBoundedMkvInputPump,
            startBoundedMkvInputPump,
            stopBoundedMkvInputPump,
        }; })()`,
        globals,
    );
}

function makeTracker() {
    return { active: 0, maxActive: 0, calls: [], dispatchers: [] };
}

function trackedResponse(tracker, options = {}) {
    const status = options.status ?? 206;
    const chunks = (options.chunks || []).map((chunk) => Buffer.from(chunk));
    const headers = new Headers(options.headers || {});
    tracker.active += 1;
    tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
    let index = 0;
    let settled = false;
    const settle = () => {
        if (settled) return;
        settled = true;
        tracker.active -= 1;
    };
    const reader = {
        async read() {
            if (index < chunks.length) return { value: chunks[index++], done: false };
            settle();
            return { value: undefined, done: true };
        },
        async cancel() { settle(); },
        releaseLock() {},
    };
    const body = {
        locked: false,
        getReader() { return reader; },
        async cancel() { settle(); },
    };
    return {
        status,
        ok: status >= 200 && status < 300,
        headers,
        body,
    };
}

function boundedTextResponse(tracker, text, options = {}) {
    const payload = Buffer.from(String(text));
    const chunkBytes = Math.max(1, Number(options.chunkBytes) || 7);
    const metrics = {
        bytesRead: 0,
        reads: 0,
        chunkBytes,
        cancelled: false,
        released: false,
    };
    const chunks = [];
    for (let offset = 0; offset < payload.length; offset += chunkBytes) {
        chunks.push(payload.subarray(offset, Math.min(payload.length, offset + chunkBytes)));
    }
    // Leave ample unread data after the signature. A correct HTTP-200 classifier
    // must inspect only its bounded prefix and cancel the provider body.
    chunks.push(Buffer.alloc(2_048, 0x78));
    tracker.active += 1;
    tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
    let index = 0;
    let settled = false;
    let locked = false;
    const settle = () => {
        if (settled) return;
        settled = true;
        tracker.active -= 1;
    };
    const reader = {
        async read() {
            metrics.reads += 1;
            if (index < chunks.length) {
                const value = chunks[index++];
                metrics.bytesRead += value.length;
                return { value, done: false };
            }
            settle();
            return { value: undefined, done: true };
        },
        async cancel() {
            metrics.cancelled = true;
            settle();
        },
        releaseLock() {
            metrics.released = true;
            locked = false;
        },
    };
    const body = {
        get locked() { return locked; },
        getReader() {
            locked = true;
            return reader;
        },
        async cancel() {
            metrics.cancelled = true;
            settle();
        },
    };
    return {
        response: {
            status: 200,
            ok: true,
            headers: new Headers({
                'Content-Type': options.contentType || 'text/plain; charset=utf-8',
                'Content-Length': String(payload.length + 2_048),
            }),
            body,
        },
        metrics,
    };
}

function assertBoundedTextResponseClosed(metrics) {
    assert.equal(metrics.cancelled, true, 'the HTTP 200 body must release the mono-account socket');
    assert.equal(metrics.released, true, 'the bounded prefix reader lock must be released');
    // A Web reader may atomically deliver a chunk larger than the retained 512-byte
    // prefix. Bound observable pulls instead of pretending that delivery is sliceable.
    assert.ok(
        metrics.reads <= Math.ceil(512 / metrics.chunkBytes) + 1,
        `classification performed ${metrics.reads} body reads`,
    );
}

function startRetryHarness(overrides = {}) {
    const source = readGateway();
    const retrySource = sourceBetween(
        source,
        'async function startSessionWithProviderRetry(',
        '\nfunction normalizeFileSizeBytes(',
    );
    const insufficientSource = sourceBetween(
        source,
        'function isInsufficientInputProbeFailure(',
        '\nfunction isLiveSession(',
    ).trim();
    const isInsufficientInputProbeFailure = vm.runInNewContext(`(${insufficientSource})`);
    return vm.runInNewContext(`(() => { ${retrySource}; return startSessionWithProviderRetry; })()`, {
        STARTUP_TIMEOUT_MS: 100,
        PROVIDER_SLOT_RELEASE_DELAY_MS: 0,
        sessionStartupStats: { fastInputProbeFallbacks: 0 },
        startFfmpeg: () => ({}),
        waitForPlaylist: async () => { throw new Error('playlist failed'); },
        stopBoundedMkvInputPump: async () => {},
        stopChildProcess: async () => {},
        sleep: async () => {},
        waitForVodInputRetry: async (_delayMs, signal) => !signal?.aborted,
        abortedVodInputPumpError: () => Object.assign(
            new Error('Finite MKV input pump was stopped'),
            { name: 'AbortError', code: 'VOD_INPUT_ABORTED' },
        ),
        removeSessionDir: async () => {},
        fsp: { mkdir: async () => {} },
        isInsufficientInputProbeFailure,
        console: { warn() {} },
        ...overrides,
    });
}

function waitForPlaylistHarness(overrides = {}) {
    const source = readGateway();
    const waitSource = sourceBetween(
        source,
        'async function waitForPlaylist(',
        '\nasync function stopSession(',
    );
    return vm.runInNewContext(`(() => { ${waitSource}; return waitForPlaylist; })()`, {
        Date,
        fs: { existsSync: () => false },
        fsp: {
            readFile: async () => '',
            stat: async () => ({ isFile: () => false, size: 0 }),
        },
        inspectHlsStartupPlaylist: () => ({ ready: false }),
        isWithin: () => true,
        path,
        sleep: async () => new Promise((resolve) => setTimeout(resolve, 2)),
        abortedVodInputPumpError: () => Object.assign(
            new Error('Finite MKV input pump was stopped'),
            { name: 'AbortError', code: 'VOD_INPUT_ABORTED' },
        ),
        ...overrides,
    });
}

class CapturingWritable extends EventEmitter {
    constructor({ backpressureFirstWrite = false, autoDrain = true } = {}) {
        super();
        this.backpressureFirstWrite = backpressureFirstWrite;
        this.autoDrain = autoDrain;
        this.destroyed = false;
        this.writableEnded = false;
        this.chunks = [];
        this.writeCount = 0;
        this.endCount = 0;
        this.drainCount = 0;
        this.firstWrite = new Promise((resolve) => { this.resolveFirstWrite = resolve; });
    }

    write(chunk) {
        this.chunks.push(Buffer.from(chunk));
        this.writeCount += 1;
        this.resolveFirstWrite?.();
        this.resolveFirstWrite = null;
        if (this.backpressureFirstWrite && this.writeCount === 1) {
            if (this.autoDrain) {
                setImmediate(() => {
                    this.drainCount += 1;
                    this.emit('drain');
                });
            }
            return false;
        }
        return true;
    }

    end(callback) {
        this.writableEnded = true;
        this.endCount += 1;
        callback?.();
    }

    destroy() {
        this.destroyed = true;
        this.emit('close');
    }

    bytes() {
        return Buffer.concat(this.chunks);
    }
}

function mkvFixture(length = 64) {
    assert.ok(length >= 4);
    const fixture = Buffer.alloc(length);
    fixture.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    for (let index = 4; index < length; index += 1) fixture[index] = index % 251;
    return fixture;
}

function mkvSession(fileSizeBytes) {
    return {
        sourceUrl: 'https://provider.example/movie/account/title.mkv',
        userAgent: 'Norva/Test',
        playbackHint: { streamType: 'movie', container: 'mkv' },
        codecProfile: { container: 'matroska,webm', fileSizeBytes },
        fileSizeBytes,
        startupTimings: {},
    };
}

test('bounded MKV pump forwards exact bytes, resumes at the exact offset, and never overlaps upstream sockets', async () => {
    const fixture = mkvFixture();
    const tracker = makeTracker();
    const dispatcher = { id: 'sticky-provider-dispatcher' };
    const cut = 19;
    const h = pumpHarness({
        pickProxyAgent: () => dispatcher,
        fetch: async (_url, options) => {
            tracker.calls.push(options.headers);
            tracker.dispatchers.push(options.dispatcher);
            const call = tracker.calls.length;
            if (call === 1) {
                return trackedResponse(tracker, {
                    chunks: [fixture.subarray(0, cut)],
                    headers: {
                        'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                        'Content-Length': String(fixture.length),
                        ETag: '"mkv-v1"',
                    },
                });
            }
            assert.equal(call, 2, 'one premature EOF must create exactly one sequential reconnect');
            return trackedResponse(tracker, {
                chunks: [fixture.subarray(cut)],
                headers: {
                    'Content-Range': `bytes ${cut}-${fixture.length - 1}/${fixture.length}`,
                    'Content-Length': String(fixture.length - cut),
                    ETag: '"mkv-v1"',
                },
            });
        },
    });
    const writable = new CapturingWritable({ backpressureFirstWrite: true });
    const controller = new AbortController();

    const result = await h.runBoundedMkvInputPump(
        mkvSession(fixture.length),
        writable,
        controller.signal,
        dispatcher,
    );

    assert.deepEqual(writable.bytes(), fixture, 'the pipe must contain no duplicated or missing byte');
    assert.equal(result.bytesForwarded, fixture.length);
    assert.equal(result.reconnects, 1);
    assert.equal(writable.drainCount, 1, 'backpressure must be awaited before forwarding continues');
    assert.equal(writable.endCount, 1, 'exact EOF closes FFmpeg stdin once');
    assert.equal(tracker.maxActive, 1, 'a mono-account must never have two active upstream bodies');
    assert.equal(tracker.active, 0);
    assert.deepEqual(tracker.calls.map((headers) => headers.Range), [
        `bytes=0-${fixture.length - 1}`,
        `bytes=${cut}-${fixture.length - 1}`,
    ]);
    assert.equal(tracker.calls[1]['If-Range'], '"mkv-v1"');
    assert.deepEqual(tracker.dispatchers, [dispatcher, dispatcher], 'every reconnect stays on one sticky proxy');
});

test('FFmpeg stdin completion is successful only after the Writable finishes cleanly', async (t) => {
    await t.test('an asynchronous _final EPIPE rejects the pump without a false success or provider reopen', async () => {
        const fixture = mkvFixture(32);
        const tracker = makeTracker();
        const h = pumpHarness({
            fetch: async (_url, options) => {
                tracker.calls.push(options.headers);
                return trackedResponse(tracker, {
                    chunks: [fixture],
                    headers: {
                        'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                        'Content-Length': String(fixture.length),
                    },
                });
            },
        });
        const writable = new Writable({
            write(_chunk, _encoding, callback) { callback(); },
            final(callback) {
                setImmediate(() => callback(Object.assign(new Error('simulated broken pipe'), { code: 'EPIPE' })));
            },
        });
        // startFfmpeg installs the same permanent guard; finishVodInput owns the
        // typed classification while the guard prevents a late unhandled event.
        writable.on('error', () => {});
        const session = mkvSession(fixture.length);
        const pump = h.startBoundedMkvInputPump(session, writable);

        await assert.rejects(
            pump.promise,
            (error) => error?.code === 'FFMPEG_INPUT_CLOSED' && error?.networkCause === 'EPIPE',
        );
        assert.equal(pump.completed, true);
        assert.equal(pump.result, null, 'a rejected stdin flush must never be recorded as a completed pump');
        assert.equal(pump.error?.code, 'FFMPEG_INPUT_CLOSED');
        assert.equal(tracker.calls.length, 1, 'a local stdin flush failure must not reopen the provider');
        assert.equal(tracker.maxActive, 1);
        assert.equal(tracker.active, 0);
    });

    await t.test('destroyed and ended-but-unfinished Writable states reject immediately', async () => {
        const h = pumpHarness();
        const destroyed = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
        destroyed.destroy();
        await assert.rejects(
            h.finishVodInput(destroyed, new AbortController().signal),
            (error) => error?.code === 'FFMPEG_INPUT_CLOSED',
        );

        let releaseFinal;
        const ended = new Writable({
            write(_chunk, _encoding, callback) { callback(); },
            final(callback) { releaseFinal = callback; },
        });
        ended.end();
        assert.equal(ended.writableEnded, true);
        assert.equal(ended.writableFinished, false);
        await assert.rejects(
            h.finishVodInput(ended, new AbortController().signal),
            (error) => error?.code === 'FFMPEG_INPUT_CLOSED',
        );
        releaseFinal();
        await new Promise((resolve) => setImmediate(resolve));
    });

    await t.test('an already-finished Writable resolves idempotently without ending twice', async () => {
        const h = pumpHarness();
        let finalCalls = 0;
        const writable = new Writable({
            write(_chunk, _encoding, callback) { callback(); },
            final(callback) {
                finalCalls += 1;
                callback();
            },
        });
        await new Promise((resolve, reject) => writable.end((error) => (error ? reject(error) : resolve())));
        assert.equal(writable.writableFinished, true);

        await Promise.all([
            h.finishVodInput(writable, new AbortController().signal),
            h.finishVodInput(writable, new AbortController().signal),
        ]);
        assert.equal(finalCalls, 1, 'idempotent finish checks must not call Writable.end again');
    });

    await t.test('close before the end callback rejects and late completion cannot reverse it', async () => {
        const h = pumpHarness();
        let releaseFinal;
        const writable = new Writable({
            write(_chunk, _encoding, callback) { callback(); },
            final(callback) {
                releaseFinal = callback;
                setImmediate(() => writable.destroy());
            },
        });
        writable.on('error', () => {});
        const baselineErrorListeners = writable.listenerCount('error');
        const pending = h.finishVodInput(writable, new AbortController().signal);

        await assert.rejects(pending, (error) => error?.code === 'FFMPEG_INPUT_CLOSED');
        assert.equal(writable.writableFinished, false);
        assert.equal(writable.listenerCount('close'), 0);
        assert.equal(writable.listenerCount('error'), baselineErrorListeners);
        releaseFinal();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(writable.writableFinished, false, 'a late _final callback cannot turn the rejected flush into success');
    });
});

test('bounded range validation rejects rewinds, total drift, compression, and oversized bodies', async (t) => {
    const h = pumpHarness();
    const response = (status, contentRange, contentLength = '') => ({
        status,
        headers: new Headers({
            ...(contentRange ? { 'Content-Range': contentRange } : {}),
            ...(contentLength ? { 'Content-Length': contentLength } : {}),
        }),
    });
    assert.deepEqual(
        JSON.parse(JSON.stringify(h.parseBoundedProviderContentRange(response(206, 'bytes 0-9/10', '10'), 0, 10))),
        { start: 0, end: 9, total: 10 },
    );
    assert.equal(h.parseBoundedProviderContentRange(response(200, '', '10'), 0, 10), null);
    assert.equal(h.parseBoundedProviderContentRange(response(206, 'bytes 0-9/10', '10'), 4, 10), null);
    assert.equal(h.parseBoundedProviderContentRange(response(206, 'bytes 4-9/11', '6'), 4, 10), null);
    assert.equal(h.parseBoundedProviderContentRange(response(206, 'bytes 4-9/10', '7'), 4, 10), null);

    await t.test('a reconnect response that rewinds to zero is terminal', async () => {
        const fixture = mkvFixture(32);
        const cut = 12;
        const tracker = makeTracker();
        const h2 = pumpHarness({
            fetch: async (_url, options) => {
                tracker.calls.push(options.headers);
                if (tracker.calls.length === 1) {
                    return trackedResponse(tracker, {
                        chunks: [fixture.subarray(0, cut)],
                        headers: {
                            'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                            'Content-Length': String(fixture.length),
                        },
                    });
                }
                return trackedResponse(tracker, {
                    chunks: [fixture],
                    headers: {
                        'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                        'Content-Length': String(fixture.length),
                    },
                });
            },
        });
        await assert.rejects(
            h2.runBoundedMkvInputPump(
                mkvSession(fixture.length),
                new CapturingWritable(),
                new AbortController().signal,
                null,
            ),
            (error) => error?.code === 'RANGE_UNSUPPORTED' && error?.status === 502,
        );
        assert.equal(tracker.calls.length, 2, 'a range rewind must never trigger a third request');
        assert.equal(tracker.maxActive, 1);
        assert.equal(tracker.active, 0);
    });
});

test('first provider 458 and proxy 407 are terminal and never consume a retry', async () => {
    for (const scenario of [
        { status: 458, proxy: false, code: 'PROVIDER_BUSY', expectedStatus: 458 },
        { status: 407, proxy: true, code: 'PROXY_AUTH_FAILED', expectedStatus: 502 },
    ]) {
        const tracker = makeTracker();
        const h = pumpHarness({
            providerProxyAgents: scenario.proxy ? [{}] : [],
            fetch: async (_url, options) => {
                tracker.calls.push(options.headers);
                return trackedResponse(tracker, { status: scenario.status });
            },
        });
        await assert.rejects(
            h.runBoundedMkvInputPump(
                mkvSession(32),
                new CapturingWritable(),
                new AbortController().signal,
                null,
            ),
            (error) => (
                error?.code === scenario.code &&
                error?.status === scenario.expectedStatus &&
                error?.upstreamStatus === scenario.status
            ),
        );
        assert.equal(tracker.calls.length, 1, `HTTP ${scenario.status} must be terminal on its first response`);
        assert.equal(tracker.maxActive, 1);
        assert.equal(tracker.active, 0);
    }
});

test('typed finite-input failures never trigger the local FFmpeg probe fallback', async () => {
    for (const scenario of [
        {
            stderr: 'Invalid data found when processing input',
            inputFailure: {
                status: 502,
                code: 'PROVIDER_CONNECTION_RESET',
                upstreamStatus: null,
                networkCause: 'premature_eof',
            },
        },
        {
            stderr: 'HTTP 458 max connections',
            inputFailure: {
                status: 458,
                code: 'PROVIDER_BUSY',
                upstreamStatus: 458,
                networkCause: null,
            },
        },
        {
            stderr: 'HTTP error 407 Proxy Authentication Required',
            inputFailure: {
                status: 502,
                code: 'PROXY_AUTH_FAILED',
                upstreamStatus: 407,
                networkCause: 'proxy_auth',
            },
        },
        {
            stderr: 'FFMPEG_INPUT_CLOSED: FFmpeg rejected the completed VOD input',
            inputFailure: {
                status: 502,
                code: 'FFMPEG_INPUT_CLOSED',
                upstreamStatus: null,
                networkCause: 'EPIPE',
            },
        },
    ]) {
        let starts = 0;
        let fetches = 0;
        const expectedFailure = { ...scenario.inputFailure };
        const session = {
            id: `typed-${scenario.inputFailure.code}`,
            outputDir: '/tmp/typed-input-failure',
            startupTimings: {},
            fastInputProbe: true,
            forceFullInputProbe: false,
            inputFailure: null,
            lastError: null,
            logTail: '',
            status: 'starting',
        };
        const startSessionWithProviderRetry = startRetryHarness({
            startFfmpeg: (activeSession) => {
                starts += 1;
                fetches += 1;
                activeSession.inputFailure = { ...expectedFailure };
                activeSession.lastError = scenario.stderr;
                activeSession.logTail = scenario.stderr;
                return { attempt: starts };
            },
            waitForPlaylist: async () => { throw new Error(scenario.stderr); },
        });

        assert.equal(await startSessionWithProviderRetry(session), false);
        assert.equal(starts, 1, `${scenario.inputFailure.code} must not start a fallback FFmpeg`);
        assert.equal(fetches, 1, `${scenario.inputFailure.code} must consume exactly one provider request`);
        assert.deepEqual(session.inputFailure, expectedFailure, 'the authoritative typed failure must survive unchanged');
        assert.equal(session.forceFullInputProbe, false);
    }
});

test('size preflight rejects empty and oversized one-byte bodies without retry', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from([0, 1])]) {
        const tracker = makeTracker();
        let fetches = 0;
        const h = pumpHarness({
            fetch: async () => {
                fetches += 1;
                return trackedResponse(tracker, {
                    chunks: bytes.length ? [bytes] : [],
                    headers: {
                        'Content-Range': 'bytes 0-0/1024',
                        'Content-Length': String(bytes.length),
                    },
                });
            },
        });
        await assert.rejects(
            h.probeProviderFileSize('https://provider.example/movie/account/title.mkv', 'Norva/Test'),
            (error) => error?.code === 'RANGE_UNSUPPORTED' && error?.status === 502,
        );
        assert.equal(fetches, 1);
        assert.equal(tracker.maxActive, 1);
        assert.equal(tracker.active, 0);
    }
});

test('size preflight timeout keeps the typed 504 contract and performs one fetch', async () => {
    let fetches = 0;
    const h = pumpHarness({
        VOD_FILE_SIZE_PROBE_TIMEOUT_MS: 5,
        fetch: async (_url, options) => {
            fetches += 1;
            return await new Promise((_, reject) => {
                options.signal.addEventListener('abort', () => {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            });
        },
    });
    await assert.rejects(
        h.probeProviderFileSize('https://provider.example/movie/account/title.mkv', 'Norva/Test'),
        (error) => (
            error?.status === 504 &&
            error?.code === 'PROVIDER_RESPONSE_TIMEOUT' &&
            error?.networkCause === 'timeout'
        ),
    );
    assert.equal(fetches, 1);
});

test('size preflight keeps a thrown proxy 407 as infrastructure auth failure', async () => {
    let fetches = 0;
    const proxyError = new TypeError('fetch failed', {
        cause: new Error('Proxy response (407) !== 200 when HTTP Tunneling'),
    });
    const h = pumpHarness({
        fetch: async () => {
            fetches += 1;
            throw proxyError;
        },
    });
    await assert.rejects(
        h.probeProviderFileSize('https://provider.example/movie/account/title.mkv', 'Norva/Test'),
        (error) => (
            error?.status === 502 &&
            error?.code === 'PROXY_AUTH_FAILED' &&
            error?.networkCause === 'proxy_auth'
        ),
    );
    assert.equal(fetches, 1);
});

test('HTTP 200 provider-busy bodies are terminal 458 in preflight and pump with bounded cancellation', async (t) => {
    const signatures = [
        {
            name: 'HTML max connections',
            body: '<html><body>Maximum connections reached</body></html>',
            contentType: 'text/html; charset=utf-8',
        },
        {
            name: 'JSON provider busy',
            body: '{"error":"provider busy"}',
            contentType: 'application/json',
        },
        {
            name: 'JSON user_multi_ip',
            body: '{"message":"user_multi_ip"}',
            contentType: 'application/json',
        },
    ];

    for (const signature of signatures) {
        await t.test(`size preflight: ${signature.name}`, async () => {
            const tracker = makeTracker();
            let fetches = 0;
            let bodyMetrics = null;
            const h = pumpHarness({
                fetch: async () => {
                    fetches += 1;
                    const created = boundedTextResponse(tracker, signature.body, {
                        contentType: signature.contentType,
                    });
                    bodyMetrics = created.metrics;
                    return created.response;
                },
            });
            await assert.rejects(
                h.probeProviderFileSize('https://provider.example/movie/account/title.mkv', 'Norva/Test'),
                (error) => (
                    error?.code === 'PROVIDER_BUSY' &&
                    error?.status === 458 &&
                    error?.upstreamStatus === 200
                ),
            );
            assert.equal(fetches, 1);
            assertBoundedTextResponseClosed(bodyMetrics);
            assert.equal(tracker.active, 0);
        });

        await t.test(`input pump: ${signature.name}`, async () => {
            const tracker = makeTracker();
            let fetches = 0;
            let bodyMetrics = null;
            const writable = new CapturingWritable();
            const h = pumpHarness({
                fetch: async () => {
                    fetches += 1;
                    const created = boundedTextResponse(tracker, signature.body, {
                        contentType: signature.contentType,
                    });
                    bodyMetrics = created.metrics;
                    return created.response;
                },
            });
            await assert.rejects(
                h.runBoundedMkvInputPump(
                    mkvSession(128),
                    writable,
                    new AbortController().signal,
                    null,
                ),
                (error) => (
                    error?.code === 'PROVIDER_BUSY' &&
                    error?.status === 458 &&
                    error?.upstreamStatus === 200
                ),
            );
            assert.equal(fetches, 1, 'a disguised provider-busy response must never be retried');
            assert.equal(writable.bytes().length, 0, 'provider error text must never reach FFmpeg');
            assertBoundedTextResponseClosed(bodyMetrics);
            assert.equal(tracker.active, 0);
        });
    }
});

test('ordinary HTTP 200 bodies remain RANGE_UNSUPPORTED in preflight and pump', async (t) => {
    const ordinaryBody = 'ordinary response without any account-concurrency signature';

    await t.test('size preflight', async () => {
        const tracker = makeTracker();
        let fetches = 0;
        let bodyMetrics = null;
        const h = pumpHarness({
            fetch: async () => {
                fetches += 1;
                const created = boundedTextResponse(tracker, ordinaryBody);
                bodyMetrics = created.metrics;
                return created.response;
            },
        });
        await assert.rejects(
            h.probeProviderFileSize('https://provider.example/movie/account/title.mkv', 'Norva/Test'),
            (error) => error?.code === 'RANGE_UNSUPPORTED' && error?.status === 502,
        );
        assert.equal(fetches, 1);
        assertBoundedTextResponseClosed(bodyMetrics);
        assert.equal(tracker.active, 0);
    });

    await t.test('input pump', async () => {
        const tracker = makeTracker();
        let fetches = 0;
        let bodyMetrics = null;
        const writable = new CapturingWritable();
        const h = pumpHarness({
            fetch: async () => {
                fetches += 1;
                const created = boundedTextResponse(tracker, ordinaryBody);
                bodyMetrics = created.metrics;
                return created.response;
            },
        });
        await assert.rejects(
            h.runBoundedMkvInputPump(
                mkvSession(128),
                writable,
                new AbortController().signal,
                null,
            ),
            (error) => error?.code === 'RANGE_UNSUPPORTED' && error?.status === 502,
        );
        assert.equal(fetches, 1);
        assert.equal(writable.bytes().length, 0);
        assertBoundedTextResponseClosed(bodyMetrics);
        assert.equal(tracker.active, 0);
    });
});

test('changed ETag and compressed ranges are terminal before their bytes reach FFmpeg', async (t) => {
    await t.test('a reconnect with a changed strong ETag writes none of the changed response', async () => {
        const fixture = mkvFixture(32);
        const cut = 12;
        const tracker = makeTracker();
        const h = pumpHarness({
            fetch: async (_url, options) => {
                tracker.calls.push(options.headers);
                if (tracker.calls.length === 1) {
                    return trackedResponse(tracker, {
                        chunks: [fixture.subarray(0, cut)],
                        headers: {
                            'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                            'Content-Length': String(fixture.length),
                            ETag: '"version-1"',
                        },
                    });
                }
                return trackedResponse(tracker, {
                    chunks: [fixture.subarray(cut)],
                    headers: {
                        'Content-Range': `bytes ${cut}-${fixture.length - 1}/${fixture.length}`,
                        'Content-Length': String(fixture.length - cut),
                        ETag: '"version-2"',
                    },
                });
            },
        });
        const writable = new CapturingWritable();
        await assert.rejects(
            h.runBoundedMkvInputPump(
                mkvSession(fixture.length),
                writable,
                new AbortController().signal,
                null,
            ),
            (error) => error?.code === 'VOD_CHANGED' && error?.status === 502,
        );
        assert.deepEqual(writable.bytes(), fixture.subarray(0, cut));
        assert.equal(tracker.calls.length, 2);
        assert.equal(tracker.calls[1]['If-Range'], '"version-1"');
        assert.equal(tracker.maxActive, 1);
        assert.equal(tracker.active, 0);
    });

    await t.test('a compressed bounded response is rejected before its first write', async () => {
        const fixture = mkvFixture(16);
        const tracker = makeTracker();
        let fetches = 0;
        const h = pumpHarness({
            fetch: async () => {
                fetches += 1;
                return trackedResponse(tracker, {
                    chunks: [fixture],
                    headers: {
                        'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                        'Content-Length': String(fixture.length),
                        'Content-Encoding': 'gzip',
                    },
                });
            },
        });
        const writable = new CapturingWritable();
        await assert.rejects(
            h.runBoundedMkvInputPump(
                mkvSession(fixture.length),
                writable,
                new AbortController().signal,
                null,
            ),
            (error) => error?.code === 'RANGE_UNSUPPORTED' && error?.status === 502,
        );
        assert.equal(fetches, 1);
        assert.equal(writable.bytes().length, 0);
        assert.equal(tracker.active, 0);
    });
});

test('abort during FFmpeg backpressure closes the only upstream and removes every listener', async () => {
    const fixture = mkvFixture(32);
    const tracker = makeTracker();
    const h = pumpHarness({
        fetch: async (_url, options) => {
            tracker.calls.push(options.headers);
            return trackedResponse(tracker, {
                chunks: [fixture],
                headers: {
                    'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                    'Content-Length': String(fixture.length),
                },
            });
        },
    });
    const writable = new CapturingWritable({ backpressureFirstWrite: true, autoDrain: false });
    const controller = new AbortController();
    const pending = h.runBoundedMkvInputPump(
        mkvSession(fixture.length),
        writable,
        controller.signal,
        null,
    );
    await writable.firstWrite;
    controller.abort();

    await assert.rejects(pending, (error) => error?.code === 'VOD_INPUT_ABORTED');
    assert.equal(tracker.calls.length, 1, 'abort must not reopen the provider');
    assert.equal(tracker.active, 0);
    assert.equal(writable.endCount, 0);
    assert.equal(writable.listenerCount('drain'), 0);
    assert.equal(writable.listenerCount('error'), 0);
    assert.equal(writable.listenerCount('close'), 0);
});

test('positive progress across at least eight short provider ranges reconstructs the complete MKV', async () => {
    const fixture = mkvFixture(40);
    const tracker = makeTracker();
    const shortRangeBytes = 4;
    const h = pumpHarness({
        VOD_INPUT_RETRY_LIMIT: 2,
        VOD_INPUT_MAX_RECONNECTS: 16,
        // Deliberately larger than each successful short response: every positive
        // byte advance must reset no-progress independently of this legacy value.
        VOD_INPUT_MIN_PROGRESS_RESET_BYTES: 8,
        fetch: async (_url, options) => {
            tracker.calls.push(options.headers);
            const start = Number(/^bytes=(\d+)-/.exec(options.headers.Range)?.[1]);
            assert.ok(Number.isSafeInteger(start));
            const endExclusive = Math.min(fixture.length, start + shortRangeBytes);
            return trackedResponse(tracker, {
                chunks: [fixture.subarray(start, endExclusive)],
                headers: {
                    'Content-Range': `bytes ${start}-${fixture.length - 1}/${fixture.length}`,
                    'Content-Length': String(fixture.length - start),
                    ETag: '"short-ranges-v1"',
                },
            });
        },
    });
    const writable = new CapturingWritable();
    const result = await h.runBoundedMkvInputPump(
        mkvSession(fixture.length),
        writable,
        new AbortController().signal,
        null,
    );

    assert.equal(tracker.calls.length, 10, 'the fixture must require ten short sequential ranges');
    assert.equal(result.reconnects, 9);
    assert.deepEqual(writable.bytes(), fixture);
    assert.equal(writable.endCount, 1);
    assert.equal(tracker.maxActive, 1);
    assert.equal(tracker.active, 0);
    assert.deepEqual(
        tracker.calls.map((headers) => headers.Range),
        Array.from({ length: 10 }, (_, index) => `bytes=${index * shortRangeBytes}-${fixture.length - 1}`),
    );
});

test('request abort prevents the full-probe fallback and makes playlist waiting terminate promptly', async (t) => {
    await t.test('start retry budget is not re-armed after abort', async () => {
        const controller = new AbortController();
        let starts = 0;
        let fetches = 0;
        const session = {
            id: 'aborted-startup',
            outputDir: '/tmp/aborted-startup',
            startupTimings: {},
            fastInputProbe: true,
            forceFullInputProbe: false,
            inputFailure: null,
            lastError: null,
            logTail: '',
            status: 'starting',
        };
        const startSessionWithProviderRetry = startRetryHarness({
            startFfmpeg: (activeSession) => {
                starts += 1;
                fetches += 1;
                activeSession.lastError = 'Invalid data found when processing input';
                activeSession.logTail = activeSession.lastError;
                return { attempt: starts };
            },
            waitForPlaylist: async () => {
                controller.abort();
                throw Object.assign(new Error('Session request aborted'), {
                    name: 'AbortError',
                    code: 'VOD_INPUT_ABORTED',
                });
            },
        });

        await assert.rejects(
            startSessionWithProviderRetry(session, controller.signal),
            (error) => error?.name === 'AbortError' || error?.code === 'VOD_INPUT_ABORTED',
        );
        assert.equal(starts, 1);
        assert.equal(fetches, 1);
        assert.equal(session.forceFullInputProbe, false);
    });

    await t.test('already-aborted playlist wait exits before its polling timeout', async () => {
        const controller = new AbortController();
        controller.abort();
        const waitForPlaylist = waitForPlaylistHarness();
        const startedAt = Date.now();
        await assert.rejects(
            waitForPlaylist({
                status: 'starting',
                lastError: null,
                playlistPath: '/does/not/exist/playlist.m3u8',
                outputDir: '/does/not/exist',
                startupTimings: {},
            }, 100, controller.signal),
            (error) => error?.name === 'AbortError' || error?.code === 'VOD_INPUT_ABORTED',
        );
        assert.ok(Date.now() - startedAt < 50, 'abort must not wait for the playlist polling deadline');
    });
});

test('one-byte size preflight is strict, sequential, and preserves in-band size provenance', async () => {
    const tracker = makeTracker();
    const dispatcher = { id: 'sticky-size-probe' };
    const calls = [];
    const h = pumpHarness({
        pickProxyAgent: () => dispatcher,
        fetch: async (_url, options) => {
            calls.push(options);
            return trackedResponse(tracker, {
                chunks: [Buffer.from([0])],
                headers: {
                    'Content-Range': 'bytes 0-0/1049339212',
                    'Content-Length': '1',
                },
            });
        },
    });
    assert.equal(
        await h.probeProviderFileSize('https://provider.example/movie/account/title.mkv', 'Norva/Test'),
        1_049_339_212,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.Range, 'bytes=0-0');
    assert.equal(calls[0].headers['Accept-Encoding'], 'identity');
    assert.equal(calls[0].dispatcher, dispatcher);
    assert.equal(tracker.maxActive, 1);
    assert.equal(tracker.active, 0, 'the preflight body is closed before returning');

    const source = readGateway();
    const buildSource = sourceBetween(source, 'function buildCodecProfile(', '\nfunction cacheCodecProfile(').trim();
    const buildCodecProfile = vm.runInNewContext(`(${buildSource}\n)`, {
        asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
        compactRecord: (record) => Object.fromEntries(Object.entries(record || {}).filter(([, value]) => (
            value !== undefined && value !== null && value !== ''
        ))),
        stringOrNull: (value) => String(value || '').trim() || null,
        nullableInt: (value) => value === undefined || value === null || value === '' ? null : Number.parseInt(value, 10),
        nullableFloat: (value) => value === undefined || value === null || value === '' ? null : Number.parseFloat(value),
        normalizeFileSizeBytes: (value) => {
            const parsed = Number(value);
            return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
        },
        estimateDurationFromFormat: () => null,
        streamLanguage: () => null,
        streamTitle: (_, fallback) => fallback,
        subtitleKind: () => '',
    });
    const payload = {
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
        format: { format_name: 'matroska,webm', size: '1049339212', duration: '7200' },
    };
    assert.equal(buildCodecProfile(payload, Date.now(), 'gateway_probe').fileSizeBytes, 1_049_339_212);
    assert.equal(buildCodecProfile(payload, Date.now(), 'gateway_inband').fileSizeBytes, undefined,
        'a local cached prefix must never masquerade as the source VOD length');
});

test('an extensionless cached Matroska profile becomes finite after merge without a provider ffprobe', async () => {
    const sourceUrl = 'https://provider.example/movie/account/opaque-title-id';
    const cachedProfile = {
        container: 'matroska,webm',
        fileSizeBytes: 40,
        videoCodec: 'h264',
        audioCodec: 'aac',
    };
    const codecProfileCache = new Map([[
        sourceUrl,
        { profile: cachedProfile, expiresAt: Date.now() + 60_000 },
    ]]);
    let providerFfprobes = 0;
    const probeSource = sourceBetween(
        readGateway(),
        'async function probeCodecProfile(',
        '\nasync function probeCodecProfileUncached(',
    );
    const probeCodecProfile = vm.runInNewContext(
        `(() => { ${probeSource}; return probeCodecProfile; })()`,
        {
            Date,
            CODEC_PROFILE_CACHE_TTL_MS: 60_000,
            codecProfileCache,
            probeStats: { cacheHits: 0, inbandHits: 0 },
            INBAND_HEADER_PARSE: true,
            probeFromHeaderBytes: async () => { throw new Error('cache hit must precede in-band parsing'); },
            hasUsefulCodecProfile: () => true,
            cacheCodecProfile: () => {},
            probeCodecProfileUncached: async () => {
                providerFfprobes += 1;
                throw new Error('seekable provider ffprobe must not run on a cache hit');
            },
        },
    );
    const mergeSource = sourceBetween(
        readGateway(),
        'function mergeCodecProfiles(',
        '\nfunction shouldProbeMissingSubtitleTracks(',
    ).trim();
    const mergeCodecProfiles = vm.runInNewContext(`(${mergeSource})`, {
        asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
        compactRecord: (record) => Object.fromEntries(Object.entries(record || {}).filter(([, value]) => (
            value !== undefined && value !== null && value !== ''
        ))),
    });
    let boundedPreflightFetches = 0;
    const h = pumpHarness({
        fetch: async () => {
            boundedPreflightFetches += 1;
            throw new Error('merged exact size must avoid a provider size preflight');
        },
    });
    const session = {
        sourceUrl,
        userAgent: 'Norva/Test',
        playbackHint: { streamType: 'movie' },
        codecProfile: { videoCodec: 'h264' },
        startupTimings: {},
    };
    assert.equal(h.isFiniteMkvVodSession(session), false, 'the opaque URL alone carries no container evidence');

    const probed = await probeCodecProfile(sourceUrl, 'Norva/Test', { localOnly: false });
    session.codecProfile = mergeCodecProfiles(session.codecProfile, probed);
    assert.equal(providerFfprobes, 0, 'a local cache hit must not open a seekable provider probe');
    assert.equal(h.isFiniteMkvVodSession(session), true, 'the merged Matroska container selects the finite lane');
    await h.ensureBoundedMkvInputPump(session);
    assert.equal(session.startupTimings.boundedMkvInputPump, true);
    assert.equal(session.fileSizeBytes, cachedProfile.fileSizeBytes);
    assert.equal(boundedPreflightFetches, 0);
});

test('viewer startup admission is bounded, provider-first and abort-aware before QoS reservation', async () => {
    const source = readGateway();
    const lockSource = sourceBetween(
        source,
        'const viewerSessionStartupLocks = new Map();',
        '\nfunction sha256Hex(',
    );
    const h = vm.runInNewContext(
        `(() => { ${lockSource}; return {
            viewerSessionStartupLocks,
            viewerSessionStartupAdmissions,
            viewerSessionStartupAdmissionCounts,
            tryAdmitViewerSessionStartup,
            releaseViewerSessionStartupAdmission,
            acquireViewerSessionStartupLock,
            acquireViewerSessionStartupLocks,
        }; })()`,
        {
            AbortController,
            MAX_VIEWER_SESSION_STARTUP_ADMISSIONS: 4,
            MAX_VIEWER_SESSION_STARTUPS_PER_KEY: 4,
            wakePlaybackBlockedQueues() {},
        },
    );

    const firstPending = h.acquireViewerSessionStartupLocks('owner-a', 'provider-a');
    assert.equal(h.viewerSessionStartupLocks.has('provider:provider-a'), true,
        'the provider reservation must exist synchronously before the first await');
    const releaseFirst = await firstPending;

    let sameProviderEntered = false;
    let sameOwnerEntered = false;
    const sameProvider = h.acquireViewerSessionStartupLocks('owner-b', 'provider-a').then((release) => {
        sameProviderEntered = true;
        return release;
    });
    const sameOwner = h.acquireViewerSessionStartupLocks('owner-a', 'provider-b').then((release) => {
        sameOwnerEntered = true;
        return release;
    });
    const releaseDisjoint = await h.acquireViewerSessionStartupLocks('owner-c', 'provider-c');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sameProviderEntered, false);
    assert.equal(sameOwnerEntered, false);
    releaseDisjoint();
    releaseFirst();

    const [releaseSameProvider, releaseSameOwner] = await Promise.all([sameProvider, sameOwner]);
    assert.equal(sameProviderEntered, true);
    assert.equal(sameOwnerEntered, true);
    releaseSameProvider();
    releaseSameOwner();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.viewerSessionStartupLocks.size, 0);

    const held = await h.acquireViewerSessionStartupLocks('owner-abort', 'provider-abort');
    const abortController = new AbortController();
    const abortedWaiter = h.acquireViewerSessionStartupLocks(
        'owner-waiter',
        'provider-abort',
        abortController.signal,
    );
    assert.equal(h.viewerSessionStartupLocks.get('provider:provider-abort').waiters.length, 1);
    abortController.abort();
    await assert.rejects(abortedWaiter, (error) => error?.code === 'VIEWER_STARTUP_ABORTED');
    assert.equal(h.viewerSessionStartupLocks.get('provider:provider-abort').waiters.length, 0,
        'an aborted request must leave the provider queue before the holder releases');
    held();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.viewerSessionStartupLocks.size, 0);

    const admissions = Array.from({ length: 4 }, () =>
        h.tryAdmitViewerSessionStartup('owner-cap', 'provider-cap'));
    assert.equal(admissions.every(Boolean), true);
    assert.equal(h.tryAdmitViewerSessionStartup('owner-cap', 'provider-cap'), null,
        'the per-key admission cap must reject before another promise waiter is allocated');
    assert.equal(h.viewerSessionStartupAdmissions.size, 4);
    for (const admission of admissions) h.releaseViewerSessionStartupAdmission(admission);
    assert.equal(h.viewerSessionStartupAdmissions.size, 0);
    assert.equal(h.viewerSessionStartupAdmissionCounts.size, 0);

    const rawGuard = sourceBetween(source, 'function providerSessionBlocksRawOpening(', '\nfunction viewerPlaybackActiveLocally(');
    assert.match(rawGuard, /viewerSessionStartupLocks\.has\(`provider:\$\{providerSlotKey\}`\)/);
    const rawRoute = sourceBetween(source, "app.get('/raw/:token'", '\n// Tee the leading bytes');
    assert.ok(
        rawRoute.indexOf('providerSessionBlocksRawOpening(pumpProviderSlotKey)') < rawRoute.indexOf('registerRawPump({'),
        '/raw must observe the provider reservation before registering or opening a socket',
    );

    const sessionRoute = sourceBetween(source, "app.post('/sessions'", "\n// Cross-device kill-switch");
    const abortListenerAt = sessionRoute.indexOf("req.once('aborted', abortSessionRequest)");
    const admissionAt = sessionRoute.indexOf('tryAdmitViewerSessionStartup(');
    const acquireAt = sessionRoute.indexOf('await acquireViewerSessionStartupLocks(');
    const qosAt = sessionRoute.indexOf('viewerStartupReservation = reserveViewerStartup();');
    assert.ok(abortListenerAt >= 0 && abortListenerAt < admissionAt && admissionAt < acquireAt && acquireAt < qosAt,
        'abort observation and bounded admission must precede lock wait; QoS starts only after admission');
    assert.match(sessionRoute, /code: 'GATEWAY_STARTUP_BUSY'/);
    assert.match(sessionRoute, /releaseViewerSessionStartupAdmission\(viewerSessionStartupAdmission\)/);
});

test('provider slot identity preserves mono-account handoff without cross-tenant host collisions', async () => {
    const source = readGateway();
    const slotSource = sourceBetween(
        source,
        'function providerSlotKeyFromUrl(',
        '\nfunction providerAccountKeyFromCredentials(',
    ).trim();
    const providerSlotKeyFromUrl = vm.runInNewContext(`(${slotSource})`, {
        URL,
        proxyKeyFromUrl: providerAccountAffinityKey,
        normalizeSessionKey: (value) => /^[a-f0-9]{64}$/.test(String(value || '').toLowerCase())
            ? String(value).toLowerCase()
            : '',
        sha256Hex: (value) => `sha256:${String(value)}`,
    });
    const ownerA = 'a'.repeat(64);
    const ownerB = 'b'.repeat(64);

    const canonicalA = providerSlotKeyFromUrl(
        'https://shared.example/movie/account-a/password/101.mkv',
        ownerA,
    );
    const canonicalB = providerSlotKeyFromUrl(
        'https://shared.example/movie/account-a/password/202.mkv',
        ownerB,
    );
    assert.equal(canonicalA, canonicalB,
        'the same canonical Xtream account must serialize even when used by different owners');
    const sameUsernameDifferentPassword = providerSlotKeyFromUrl(
        'https://shared.example/movie/account-a/different-password/303.mkv',
        ownerB,
    );
    assert.notEqual(canonicalA, sameUsernameDifferentPassword,
        'a username alone must never grant a destructive cross-owner slot collision');

    const opaqueA = providerSlotKeyFromUrl('https://shared.example/media/title-a.mkv', ownerA);
    const opaqueASibling = providerSlotKeyFromUrl('https://shared.example/media/title-b.mkv', ownerA);
    const opaqueB = providerSlotKeyFromUrl('https://shared.example/media/title-c.mkv', ownerB);
    assert.equal(opaqueA, opaqueASibling,
        'opaque titles for one owner and host must retain mono-slot serialization');
    assert.notEqual(opaqueA, opaqueB,
        'different owners on one opaque host must not share a destructive slot key');

    const stopSource = sourceBetween(
        source,
        'async function stopConflictingProviderSessions(',
        '\nasync function stopConflictingOwnerSessions(',
    ).trim();
    const sessions = new Map([
        ['victim', { id: 'victim', sourceUrl: 'https://shared.example/victim.mkv', providerSlotKey: opaqueA }],
        ['same-account', { id: 'same-account', sourceUrl: 'https://shared.example/next.mkv', providerSlotKey: opaqueB }],
    ]);
    const stopped = [];
    const stopConflictingProviderSessions = vm.runInNewContext(`(${stopSource})`, {
        sessions,
        providerSlotKeyForSession: (session) => session.providerSlotKey,
        isSessionBlockingProviderSlot: () => true,
        stopSession: async (session) => { stopped.push(session.id); },
        console: { log() {} },
    });
    assert.equal(await stopConflictingProviderSessions(opaqueB), 1);
    assert.deepEqual(stopped, ['same-account'],
        'provider handoff must stop only the exact provider slot, not an unrelated owner');

    const stopSourceSessionsSource = sourceBetween(
        source,
        'async function stopConflictingSourceSessions(',
        '\nasync function stopConflictingProviderSessions(',
    ).trim();
    const sourceSessions = new Map([
        ['owner-a', { id: 'owner-a', sourceKey: 'shared-path', providerSlotKey: opaqueA }],
        ['owner-b', { id: 'owner-b', sourceKey: 'shared-path', providerSlotKey: opaqueB }],
    ]);
    const sourceStopped = [];
    const stopConflictingSourceSessions = vm.runInNewContext(`(${stopSourceSessionsSource})`, {
        sessions: sourceSessions,
        sourceSessionKey: () => 'shared-path',
        providerSlotKeyForSession: (session) => session.providerSlotKey,
        isSessionBlockingProviderSlot: () => true,
        stopSession: async (session) => { sourceStopped.push(session.id); },
        console: { log() {} },
    });
    assert.equal(await stopConflictingSourceSessions(
        'https://shared.example/stream?token=tenant-b',
        opaqueB,
    ), 1);
    assert.deepEqual(sourceStopped, ['owner-b'],
        'a legacy source-key collision must not stop another owner provider slot');

    const rawRoute = sourceBetween(source, "app.get('/raw/:token'", '\n// Tee the leading bytes');
    assert.match(rawRoute, /providerSlotKey: pumpProviderSlotKey/);
    assert.match(rawRoute, /p\.providerSlotKey === pumpProviderSlotKey/);
    const sessionRoute = sourceBetween(source, "app.post('/sessions'", "\n// Cross-device kill-switch");
    assert.match(sessionRoute, /providerSlotKey: playbackProviderSlotKey/);
    assert.match(sessionRoute, /p\.providerSlotKey === playbackProviderSlotKey/);
    assert.match(sessionRoute, /stopConflictingProviderSessions\(playbackProviderSlotKey\)/);
});

function ffprobeTimeoutHarness() {
    const source = readGateway();
    const runnerSource = sourceBetween(
        source,
        'function isFfprobeProviderBusyFailure(',
        '\nfunction hasReliableVodCodecProfile(',
    );
    class FakeChild extends EventEmitter {
        constructor() {
            super();
            this.stdout = new EventEmitter();
            this.stderr = new EventEmitter();
            this.kills = [];
        }

        kill(signal) {
            this.kills.push(signal);
            return true;
        }
    }
    const child = new FakeChild();
    const scaledSetTimeout = (callback, ms, ...args) => setTimeout(
        callback,
        Number(ms) >= 1_000 ? 1 : ms,
        ...args,
    );
    const runFfprobe = vm.runInNewContext(`(() => { ${runnerSource}; return runFfprobe; })()`, {
        spawn: () => child,
        FFPROBE_PATH: 'ffprobe',
        proxyEnvFor: () => undefined,
        proxyKeyFromUrl: () => 'provider/account',
        viewerPlaybackActiveLocally: () => false,
        accountExtractions: new Map(),
        backgroundProbeError: (status, code, message) => Object.assign(new Error(message), {
            status,
            code,
            publicMessage: message,
        }),
        registerAccountExtraction: () => null,
        isProxyAuthenticationFailure: providerFailure.isProxyAuthenticationFailure,
        sanitizeLog: (value) => String(value || ''),
        lastNonEmptyLine: (value) => String(value || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '',
        setTimeout: scaledSetTimeout,
        clearTimeout,
    });
    return { child, runFfprobe };
}

test('ffprobe timeout preserves terminal 458/407 stderr, waits for exit, and force-kills', async () => {
    for (const scenario of [
        { stderr: 'HTTP 458 max connections', code: 'PROVIDER_BUSY', status: 458 },
        { stderr: 'HTTP error 407 Proxy Authentication Required', code: 'PROXY_AUTH_FAILED', status: 502 },
    ]) {
        const { child, runFfprobe } = ffprobeTimeoutHarness();
        let settled = false;
        const pending = runFfprobe([], 2, 'https://provider.example/movie/account/title.mkv')
            .finally(() => { settled = true; });
        child.stderr.emit('data', Buffer.from(scenario.stderr));
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
        assert.equal(settled, false, 'no next provider request may start before ffprobe exits');
        child.emit('exit', null, 'SIGKILL');
        await assert.rejects(
            pending,
            (error) => error?.code === scenario.code && error?.status === scenario.status,
        );
        assert.equal(settled, true);
    }
});

test('FFmpeg MKV input uses pipe:0 only, keeps exact post-input resume, and teardown awaits the pump owner', () => {
    const source = readGateway();
    const startFfmpeg = sourceBetween(source, 'function startFfmpeg(', '\nfunction seekArgsForSession(');
    assert.match(startFfmpeg, /const pumpedMkvInput = isFiniteMkvVodSession\(session\)/);
    assert.match(startFfmpeg, /const providerHttpInputArgs = pumpedMkvInput \? \[\] : \[/);
    assert.match(startFfmpeg, /'-i', pumpedMkvInput \? 'pipe:0' : session\.sourceUrl/);
    assert.match(startFfmpeg, /stdio: \[pumpedMkvInput \? 'pipe' : 'ignore', 'ignore', 'pipe'\]/);
    assert.match(startFfmpeg, /env: pumpedMkvInput \? undefined : proxyEnvFor/);
    assert.match(startFfmpeg, /startBoundedMkvInputPump\(session, child\.stdin\)/);
    assert.doesNotMatch(startFfmpeg, /end_offset|seekable/);

    const seekSource = sourceBetween(source, 'function seekArgsForSession(', '\nfunction usesSourceTimestampedCopySeek(').trim();
    const seekArgsForSession = vm.runInNewContext(`(${seekSource})`, {
        isFiniteMkvVodSession: (session) => String(session?.sourceUrl || '').endsWith('.mkv'),
    });
    assert.deepEqual(
        JSON.parse(JSON.stringify(seekArgsForSession({ sourceUrl: 'https://p/title.mkv', seekOffset: 120 }, true))),
        { preInputSeek: [], postInputSeek: ['-ss', '120'] },
        'time resume stays after pipe input; it is never guessed as a byte offset',
    );

    const retry = sourceBetween(source, 'async function startSessionWithProviderRetry(', '\nfunction normalizeFileSizeBytes(');
    assert.ok(
        retry.indexOf('await stopBoundedMkvInputPump(session)') < retry.indexOf('await stopChildProcess(session.ffmpeg)'),
        'probe fallback must close and await the old provider pump before another FFmpeg attempt',
    );
    const stop = sourceBetween(source, 'async function stopSession(', '\nasync function stopConflictingSourceSessions(');
    assert.ok(
        stop.indexOf('await stopBoundedMkvInputPump(session)') < stop.indexOf('await stopChildProcess(child)'),
        'session handoff must close and await the provider socket before releasing the old FFmpeg',
    );
    assert.match(source, /boundedMkvInputPumpProtocol:\s*1/);
    assert.match(source, /const GATEWAY_VERSION = 89;/);
});
