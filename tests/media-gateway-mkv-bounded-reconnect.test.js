'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Writable, PassThrough } = require('node:stream');
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
    const matroskaMetadataHelpers = sourceBetween(
        source,
        'function readEbmlElementSize(',
        '\nasync function probeFromHeaderBytes(',
    );
    const globals = {
        URL,
        crypto,
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
        VOD_INPUT_DISCOVERY_RANGE_END: Number.MAX_SAFE_INTEGER - 1,
        VOD_INPUT_FULL_BODY_MAX_BYTES: 1024 * 1024,
        VOD_INPUT_RETRY_DELAYS_MS: [0, 0, 0, 0],
        VOD_INPUT_MIN_PROGRESS_RESET_BYTES: 8,
        INBAND_HEADER_PARSE: false,
        BOUNDED_MKV_HEADER_PARSE: false,
        INBAND_HEADER_BYTES: 4_000_000,
        INBAND_HEADER_CACHE_MAX: 16,
        MAX_MATROSKA_METADATA_ELEMENTS: 4_096,
        headerByteCache: new Map(),
        MKV_H264_FAST_START_PROOF_CURRENT_KEY: null,
        MKV_H264_FAST_START_COPY_ACTIVATION_READY: false,
        PassThrough,
        FFPROBE_PATH: 'ffprobe-test',
        FFMPEG_PATH: 'ffmpeg-test',
        MKV_H264_FAST_START_ANALYZER_BUFFER_BYTES: 8 * 1024 * 1024,
        MKV_H264_FAST_START_ANALYZER_STOP_TIMEOUT_MS: 100,
        MKV_H264_FAST_START_ANALYZER_MAX_LINE_BYTES: 4 * 1024,
        MKV_H264_FAST_START_ANALYZER_MAX_TIMELINE_RECORDS: 100_000,
        MKV_H264_FAST_START_MIN_KEYFRAMES: 3,
        MKV_H264_FAST_START_ANALYZER_TYPE: 'ffprobe-key-packets-plus-ffmpeg-idr-framecrc-v2',
        MKV_H264_FAST_START_ANALYZER_DIGEST: 'a'.repeat(64),
        CODEC_PROBE_TIMEOUT_MS: 100,
        EXACT_MATROSKA_H264_HLS_TARGET_SECONDS: 2,
        EXACT_MATROSKA_H264_MAX_WIDTH: 1920,
        EXACT_MATROSKA_H264_MAX_HEIGHT: 1080,
        EXACT_MATROSKA_H264_MAX_PIXELS: 1920 * 1080,
        mkvH264FullFileAnalyzers: new Set(),
        mkvH264FastStartIdentityContext: () => null,
        loopbackOnlyEnv: () => ({}),
        sanitizeLog: (value) => String(value || ''),
        spawn: () => { throw new Error('unexpected analyzer spawn'); },
        sha256Hex: (value) => crypto.createHash('sha256').update(String(value)).digest('hex'),
        strictLidEffectiveUrlIdentitySha256: (value) => {
            const parsed = new URL(String(value || ''));
            const queryKeys = [...new Set([...parsed.searchParams.keys()])].sort();
            const identity = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
                + (queryKeys.length > 0 ? `?${queryKeys.join('&')}` : '');
            return crypto.createHash('sha256').update(identity).digest('hex');
        },
        needsMkvH264CurrentHeaderAuthority: () => false,
        maybeFinalizeMkvH264FastStartProof: () => null,
        RAW_PREFIX_SNIFF_BYTES: 512,
        FFMPEG_USER_AGENT: 'Norva/Test',
        providerHttpProxyUrls: [],
        providerSocksProxyUrls: [],
        providerHttpProxyAgents: [],
        providerSocksProxyAgents: [],
        providerProxyAgents: [],
        vodInputPumpStats: {
            starts: 0,
            completed: 0,
            failures: 0,
            reconnects: 0,
            bytesForwarded: 0,
            validatorEvidence: { strongEtag: 0, lastModified: 0, weakOrAbsent: 0 },
            last: null,
        },
        asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
        exactRecordKeys: (value, expected) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
            const actual = Object.keys(value).sort();
            const wanted = [...expected].sort();
            return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
        },
        compactRecord: (record) => Object.fromEntries(Object.entries(record || {}).filter(([, value]) => (
            value !== undefined && value !== null && value !== ''
        ))),
        normalizeCodecToken: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
        hasCompleteMkvPlaybackProfile: () => false,
        isLiveSession: (session) => ['live', 'channel'].includes(String(
            session?.playbackHint?.streamType || session?.playbackHint?.stream_type || '',
        ).toLowerCase()),
        proxyKeyFromUrl: () => 'provider.example/account',
        providerRouteForKey: () => null,
        createProviderProxyAgent: () => null,
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
        `(() => { ${helpers}\n${matroskaMetadataHelpers}; return {
            normalizeFileSizeBytes,
            fileSizeBytesForSession,
            normalizeSourceContainerAuthority,
            isFiniteMkvVodSession,
            classifyMediaContainerPrefix,
            providerNodeRouteIsAvailable,
            providerNodeRouteForSession,
            providerProxyAgentForRoute,
            pinProviderNodeRouteForSession,
            alternateProviderNodeTransportRoute,
            shouldFallbackProviderNodeTransport,
            parseProviderFileSize,
            probeProviderFileSize,
            ensureBoundedMkvInputPump,
            prefetchRetainedBoundedMkvHeader,
            parseBoundedProviderContentRange,
            boundedVodResponseValidator,
            openBoundedVodInputAttempt,
            writeVodInputChunk,
            finishVodInput,
            captureBoundedMkvHeaderBytes,
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
    const readErrorAt = Number.isInteger(options.readErrorAt) ? options.readErrorAt : -1;
    let settled = false;
    const settle = () => {
        if (settled) return;
        settled = true;
        tracker.active -= 1;
    };
    const reader = {
        async read() {
            if (index === readErrorAt) {
                index += 1;
                settle();
                throw options.readError || Object.assign(new Error('provider connection reset'), { code: 'ECONNRESET' });
            }
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
        url: options.url,
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
        stopFiniteMkvLinearSeekBridge: async () => {},
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
        isVaapiHardwareDecodeFailure: () => false,
        applyFiniteMkvSeekBrokerFailure: () => false,
        closeFiniteMkvSeekBroker: async () => {},
        asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
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

function mp4Fixture(length = 64, majorBrand = 'isom') {
    assert.ok(length >= 12);
    const fixture = Buffer.alloc(length);
    fixture.writeUInt32BE(24, 0);
    fixture.write('ftyp', 4, 'ascii');
    fixture.write(majorBrand, 8, 'ascii');
    for (let index = 12; index < length; index += 1) fixture[index] = (index * 7) % 251;
    return fixture;
}

function mpegTsFixture(packetCount = 3) {
    assert.ok(packetCount >= 3);
    const fixture = Buffer.alloc(packetCount * 188, 0xff);
    for (let packet = 0; packet < packetCount; packet += 1) {
        fixture[packet * 188] = 0x47;
    }
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

function analyzerChild({ slow = false, kind = 'packet' } = {}) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = 0;
    child.exited = false;
    child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
            if (!slow) callback();
        },
        final(callback) {
            if (!slow) {
                child.stdout.end(kind === 'packet'
                    ? 'packet|stream_index=0|pts=0|dts=N/A|duration=40|flags=K__\npacket|stream_index=0|pts=80|dts=0|duration=40|flags=___\npacket|stream_index=0|pts=2000|dts=1920|duration=40|flags=K__\npacket|stream_index=0|pts=4000|dts=3920|duration=40|flags=K__\nstream|index=0|profile=High|width=320|height=180|pix_fmt=yuv420p|level=40|refs=1|r_frame_rate=25/1|avg_frame_rate=25/1|time_base=1/1000\n'
                    : '#tb 0: 1/1000\n0,0,0,40,100,0x01\n0,1920,2000,40,100,0x02\n0,3920,4000,40,100,0x03\n');
                callback();
                queueMicrotask(() => {
                    child.exited = true;
                    child.emit('exit', 0);
                    child.emit('close', 0);
                });
            }
        },
    });
    child.kill = () => {
        child.kills += 1;
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        queueMicrotask(() => {
            child.exited = true;
            child.emit('exit', null);
            child.emit('close', null);
        });
        return true;
    };
    return child;
}

function analyzerChildPair(options = {}) {
    return [
        analyzerChild({ slow: options.slow === true || options.slowPacket === true, kind: 'packet' }),
        analyzerChild({ slow: options.slow === true || options.slowIdr === true, kind: 'idr' }),
    ];
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
    const session = mkvSession(fixture.length);

    const result = await h.runBoundedMkvInputPump(
        session,
        writable,
        controller.signal,
        dispatcher,
    );

    assert.deepEqual(writable.bytes(), fixture, 'the pipe must contain no duplicated or missing byte');
    assert.equal(result.bytesForwarded, fixture.length);
    assert.equal(result.reconnects, 1);
    assert.equal(result.contentSha256, crypto.createHash('sha256').update(fixture).digest('hex'));
    assert.equal(session.vodInputContentSha256, result.contentSha256);
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

test('bounded MKV pump can rescue an interrupted body by changing protocol without changing proxy slot', async () => {
    const fixture = mkvFixture(80);
    const tracker = makeTracker();
    const httpDispatcher = { id: 'slot-3-http' };
    const socksDispatcher = { id: 'slot-3-socks5' };
    const cut = 24;
    const h = pumpHarness({
        providerHttpProxyUrls: ['http://1', 'http://2', 'http://3'],
        providerSocksProxyUrls: ['socks5://1', 'socks5://2', 'socks5://3'],
        providerHttpProxyAgents: [{}, {}, httpDispatcher],
        providerSocksProxyAgents: [{}, {}, socksDispatcher],
        providerProxyAgents: [{}, {}, httpDispatcher],
        providerRouteForKey: () => ({ slot: 3, ffmpegSlot: 3, nodeTransport: 'http' }),
        fetch: async (_url, options) => {
            tracker.dispatchers.push(options.dispatcher);
            if (options.dispatcher === httpDispatcher) {
                return trackedResponse(tracker, {
                    chunks: [fixture.subarray(0, cut)],
                    headers: {
                        'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                        'Content-Length': String(fixture.length),
                        ETag: '"pump-transport-v1"',
                    },
                });
            }
            assert.equal(options.dispatcher, socksDispatcher);
            return trackedResponse(tracker, {
                chunks: [fixture.subarray(cut)],
                headers: {
                    'Content-Range': `bytes ${cut}-${fixture.length - 1}/${fixture.length}`,
                    'Content-Length': String(fixture.length - cut),
                    ETag: '"pump-transport-v1"',
                },
            });
        },
    });
    const session = mkvSession(fixture.length);
    const writable = new CapturingWritable();

    const result = await h.runBoundedMkvInputPump(
        session,
        writable,
        new AbortController().signal,
        httpDispatcher,
    );

    assert.deepEqual(writable.bytes(), fixture);
    assert.equal(result.reconnects, 1);
    assert.deepEqual(tracker.dispatchers, [httpDispatcher, socksDispatcher]);
    assert.equal(session.providerNodeRoute.slot, 3);
    assert.equal(session.providerNodeRoute.nodeTransport, 'socks5');
    assert.equal(session.startupTimings.providerTransportFallbackAttempted, true);
    assert.equal(session.startupTimings.providerTransportFallbackFrom, 'http');
    assert.equal(session.startupTimings.providerTransportFallbackTo, 'socks5');
    assert.equal(tracker.maxActive, 1);
    assert.equal(tracker.active, 0);
});

test('cold unknown-size MKV discovers total from the retained playback GET and opens one provider socket', async () => {
    const fixture = mkvFixture(64);
    const tracker = makeTracker();
    let fetches = 0;
    const h = pumpHarness({
        fetch: async (_url, options) => {
            fetches += 1;
            tracker.calls.push(options.headers);
            return trackedResponse(tracker, {
                chunks: [fixture],
                headers: {
                    'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                    'Content-Length': String(fixture.length),
                    ETag: '"unknown-size-v1"',
                },
            });
        },
    });
    const session = mkvSession(null);
    delete session.fileSizeBytes;
    delete session.codecProfile.fileSizeBytes;
    await h.ensureBoundedMkvInputPump(session);
    const writable = new CapturingWritable();
    const result = await h.runBoundedMkvInputPump(session, writable, new AbortController().signal, null);
    assert.equal(fetches, 1);
    assert.equal(tracker.maxActive, 1);
    assert.equal(result.bytesForwarded, fixture.length);
    assert.equal(result.contentSha256, crypto.createHash('sha256').update(fixture).digest('hex'));
    assert.equal(session.vodInputContentSha256, result.contentSha256);
    assert.deepEqual(writable.bytes(), fixture);
    assert.equal(session.startupTimings.fileSizeDiscoveredFromPlaybackGet, true);
});

test('cold MKV preopen changes only the Node transport on the same proxy slot after a network failure', async () => {
    const fixture = mkvFixture(96);
    const tracker = makeTracker();
    const httpDispatcher = { id: 'slot-2-http' };
    const socksDispatcher = { id: 'slot-2-socks5' };
    const dispatchers = [];
    const h = pumpHarness({
        providerHttpProxyUrls: ['http://slot-1', 'http://slot-2'],
        providerSocksProxyUrls: ['socks5://slot-1', 'socks5://slot-2'],
        providerHttpProxyAgents: [{ id: 'slot-1-http' }, httpDispatcher],
        providerSocksProxyAgents: [{ id: 'slot-1-socks5' }, socksDispatcher],
        providerProxyAgents: [{ id: 'slot-1-http' }, httpDispatcher],
        providerRouteForKey: () => ({
            slot: 2,
            ffmpegSlot: 2,
            nodeTransport: 'http',
            ffmpegTransport: 'http',
            selectionReason: 'deterministic-fallback',
            controlStatus: 'fallback',
        }),
        fetch: async (_url, options) => {
            dispatchers.push(options.dispatcher);
            if (options.dispatcher === httpDispatcher) {
                throw Object.assign(new Error('provider connection reset'), { code: 'ECONNRESET' });
            }
            assert.equal(options.dispatcher, socksDispatcher);
            return trackedResponse(tracker, {
                chunks: [fixture],
                headers: {
                    'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                    'Content-Length': String(fixture.length),
                    ETag: '"transport-fallback-v1"',
                },
            });
        },
    });
    const session = mkvSession(null);

    await h.ensureBoundedMkvInputPump(session);

    assert.deepEqual(dispatchers, [httpDispatcher, socksDispatcher]);
    assert.equal(session.providerNodeRoute.slot, 2, 'the provider exit slot must never rotate');
    assert.equal(session.providerNodeRoute.ffmpegSlot, 2);
    assert.equal(session.providerNodeRoute.nodeTransport, 'socks5');
    assert.equal(session.providerNodeRoute.controlStatus, 'session-fallback');
    assert.equal(session.startupTimings.providerTransportFallbackAttempted, true);
    assert.equal(session.startupTimings.providerTransportFallbackTriggerCode, 'PROVIDER_CONNECTION_RESET');
    assert.equal(session.startupTimings.providerTransportFallbackTo, 'socks5');
    assert.equal(session.startupTimings.providerPreopenRetries, 0);

    const writable = new CapturingWritable();
    const pump = h.startBoundedMkvInputPump(session, writable);
    assert.equal(pump.dispatcher, socksDispatcher, 'later byte-pump reconnects stay on the rescued transport');
    await pump.promise;
    assert.deepEqual(writable.bytes(), fixture);
    assert.equal(tracker.maxActive, 1, 'the HTTP attempt is closed before SOCKS5 opens');
    assert.equal(tracker.active, 0);
});

test('same-slot transport fallback never masks provider or proxy HTTP refusals', async (t) => {
    for (const scenario of [
        { status: 458, code: 'PROVIDER_BUSY' },
        { status: 407, code: 'PROXY_AUTH_FAILED' },
    ]) {
        await t.test(String(scenario.status), async () => {
            const tracker = makeTracker();
            const httpDispatcher = { id: `slot-http-${scenario.status}` };
            const socksDispatcher = { id: `slot-socks-${scenario.status}` };
            const dispatchers = [];
            const h = pumpHarness({
                providerHttpProxyUrls: ['http://slot-1'],
                providerSocksProxyUrls: ['socks5://slot-1'],
                providerHttpProxyAgents: [httpDispatcher],
                providerSocksProxyAgents: [socksDispatcher],
                providerProxyAgents: [httpDispatcher],
                providerRouteForKey: () => ({ slot: 1, ffmpegSlot: 1, nodeTransport: 'http' }),
                fetch: async (_url, options) => {
                    dispatchers.push(options.dispatcher);
                    return trackedResponse(tracker, { status: scenario.status, chunks: [] });
                },
            });

            await assert.rejects(
                h.ensureBoundedMkvInputPump(mkvSession(null)),
                (error) => error?.code === scenario.code,
            );
            assert.deepEqual(dispatchers, [httpDispatcher]);
            assert.equal(tracker.maxActive, 1);
            assert.equal(tracker.active, 0);
        });
    }
});

test('cold offset-zero MKV accepts one exact HTTP 200 body without losing pre-read bytes', async () => {
    const fixture = mkvFixture(97);
    const tracker = makeTracker();
    let fetches = 0;
    const h = pumpHarness({
        fetch: async (_url, options) => {
            fetches += 1;
            tracker.calls.push(options.headers);
            return trackedResponse(tracker, {
                status: 200,
                chunks: [fixture.subarray(0, 2), fixture.subarray(2, 11), fixture.subarray(11)],
                headers: {
                    'Content-Length': String(fixture.length),
                    ETag: '"full-body-v1"',
                },
            });
        },
    });
    const session = mkvSession(null);
    delete session.fileSizeBytes;
    delete session.codecProfile.fileSizeBytes;

    await h.ensureBoundedMkvInputPump(session);
    const writable = new CapturingWritable();
    const result = await h.runBoundedMkvInputPump(
        session,
        writable,
        new AbortController().signal,
        null,
    );

    assert.equal(fetches, 1, 'the retained HTTP 200 body is the only provider connection');
    assert.equal(tracker.calls[0].Range, `bytes=0-${Number.MAX_SAFE_INTEGER - 1}`);
    assert.equal(session.startupTimings.providerFullBodyAtZero, true);
    assert.equal(session.fileSizeBytes, fixture.length);
    assert.equal(result.bytesForwarded, fixture.length);
    assert.deepEqual(writable.bytes(), fixture, 'the bytes consumed for EBML validation are replayed exactly once');
    assert.equal(tracker.maxActive, 1);
    assert.equal(tracker.active, 0);
});

test('cold MKV preloads one bounded metadata prefix and replays every byte on the same provider socket', async () => {
    const prefixBytes = 300_000;
    const fixture = mkvFixture(500_000);
    const tracker = makeTracker();
    const headerByteCache = new Map();
    let fetches = 0;
    const h = pumpHarness({
        BOUNDED_MKV_HEADER_PARSE: true,
        INBAND_HEADER_BYTES: prefixBytes,
        INBAND_HEADER_CACHE_MAX: 2,
        headerByteCache,
        fetch: async (_url, options) => {
            fetches += 1;
            tracker.calls.push(options.headers);
            return trackedResponse(tracker, {
                status: 206,
                chunks: [
                    fixture.subarray(0, 12),
                    fixture.subarray(12, 100_000),
                    fixture.subarray(100_000, prefixBytes),
                    fixture.subarray(prefixBytes),
                ],
                headers: {
                    'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                    'Content-Length': String(fixture.length),
                    ETag: '"cold-metadata-v1"',
                },
            });
        },
    });
    const session = mkvSession(fixture.length);

    await h.ensureBoundedMkvInputPump(session);

    assert.equal(fetches, 1, 'metadata prefetch must reuse the retained playback GET');
    assert.equal(tracker.active, 1, 'the retained provider body remains the sole active socket');
    assert.equal(session.startupTimings.providerColdHeaderPrefetch, true);
    assert.equal(session.startupTimings.providerColdHeaderPrefetchBytes, prefixBytes);
    const captured = headerByteCache.get(session.sourceUrl);
    assert.equal(captured?.len, prefixBytes);
    assert.equal(captured?.done, true);
    assert.equal(Buffer.concat(captured?.chunks || []).equals(fixture.subarray(0, prefixBytes)), true);

    const writable = new CapturingWritable();
    const result = await h.runBoundedMkvInputPump(
        session,
        writable,
        new AbortController().signal,
        null,
    );

    assert.equal(fetches, 1, 'FFmpeg replay must not open a second provider connection');
    assert.equal(result.bytesForwarded, fixture.length);
    assert.deepEqual(writable.bytes(), fixture, 'prefetched bytes are replayed exactly once and in order');
    assert.equal(tracker.maxActive, 1);
    assert.equal(tracker.active, 0);
});

test('cold MKV with a complete profile publishes a resume prefix from the existing playback body', async () => {
    const prefixBytes = 8;
    const fixture = mkvFixture(32);
    const tracker = makeTracker();
    const headerByteCache = new Map();
    const published = [];
    let fetches = 0;
    const h = pumpHarness({
        BOUNDED_MKV_HEADER_PARSE: true,
        INBAND_HEADER_BYTES: prefixBytes,
        INBAND_HEADER_CACHE_MAX: 2,
        FINITE_MKV_SEEK_WINDOW_BYTES: prefixBytes,
        FINITE_MKV_MULTI_AUDIO_SEEK_WINDOW_BYTES: prefixBytes,
        headerByteCache,
        hasCompleteMkvPlaybackProfile: () => true,
        audioTracksForSession: () => [{ index: 1 }, { index: 2 }],
        finiteMkvResumePrefixCache: {
            put(value) {
                published.push({ ...value, payload: Buffer.from(value.payload) });
                return true;
            },
        },
        fetch: async (_url, options) => {
            fetches += 1;
            tracker.calls.push(options.headers);
            return trackedResponse(tracker, {
                status: 206,
                chunks: [fixture.subarray(0, 4), fixture.subarray(4)],
                headers: {
                    'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                    'Content-Length': String(fixture.length),
                    ETag: '"cold-complete-v1"',
                },
            });
        },
    });
    const session = mkvSession(fixture.length);
    session.seekOffset = 0;

    await h.ensureBoundedMkvInputPump(session);
    const writable = new CapturingWritable();
    const result = await h.runBoundedMkvInputPump(
        session,
        writable,
        new AbortController().signal,
        null,
    );

    assert.equal(fetches, 1, 'resume warming reuses the sole cold-playback provider body');
    assert.equal(result.bytesForwarded, fixture.length);
    assert.deepEqual(writable.bytes(), fixture);
    assert.equal(published.length, 1);
    assert.deepEqual(published[0].payload, fixture.subarray(0, prefixBytes));
    assert.equal(session.startupTimings.finiteMkvResumePrefixPublishedFromColdPump, true);
    assert.equal(headerByteCache.has(session.sourceUrl), false, 'the duplicated transient prefix is released');
    assert.equal(tracker.maxActive, 1);
    assert.equal(tracker.active, 0);
});

test('cold MKV retains the bounded prefix after Info and Tracks so local ffprobe sees packet data', async () => {
    const targetBytes = 300_000;
    const metadataBytes = 100_000;
    const fixture = Buffer.concat([
        completeMatroskaPrefix(metadataBytes),
        Buffer.alloc(400_000, 0x5a),
    ]);
    const tracker = makeTracker();
    const headerByteCache = new Map();
    let fetches = 0;
    const h = pumpHarness({
        BOUNDED_MKV_HEADER_PARSE: true,
        INBAND_HEADER_BYTES: targetBytes,
        INBAND_HEADER_CACHE_MAX: 2,
        headerByteCache,
        fetch: async (_url, options) => {
            fetches += 1;
            tracker.calls.push(options.headers);
            return trackedResponse(tracker, {
                status: 206,
                chunks: [
                    fixture.subarray(0, 12),
                    fixture.subarray(12, metadataBytes),
                    fixture.subarray(metadataBytes, targetBytes),
                    fixture.subarray(targetBytes),
                ],
                headers: {
                    'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                    'Content-Length': String(fixture.length),
                    ETag: '"cold-adaptive-v1"',
                },
            });
        },
    });
    const session = mkvSession(fixture.length);

    await h.ensureBoundedMkvInputPump(session);

    assert.equal(fetches, 1, 'metadata detection and the demuxer prefix reuse the retained provider GET');
    assert.equal(session.startupTimings.providerColdHeaderPrefetchBytes, targetBytes);
    assert.equal(session.startupTimings.providerColdHeaderPrefetchTargetBytes, targetBytes);
    assert.equal(session.startupTimings.providerColdHeaderMetadataComplete, true);
    assert.equal(session.startupTimings.providerColdHeaderMetadataCompleteAtBytes, metadataBytes);
    assert.equal(session.startupTimings.providerColdHeaderPrefetchAvoidedBytes, 0);
    const captured = headerByteCache.get(session.sourceUrl);
    assert.equal(captured?.len, targetBytes);
    assert.equal(captured?.done, true);
    assert.equal(captured?.metadataComplete, true);
    assert.equal(captured?.metadataCompleteAtBytes, metadataBytes);
    assert.equal(captured?.completionReason, 'bounded-prefix-target');

    const writable = new CapturingWritable();
    const result = await h.runBoundedMkvInputPump(
        session,
        writable,
        new AbortController().signal,
        null,
    );

    assert.equal(fetches, 1, 'FFmpeg replay keeps the original provider socket');
    assert.equal(result.bytesForwarded, fixture.length);
    assert.deepEqual(writable.bytes(), fixture, 'the full bounded prefix is replayed exactly once');
    assert.equal(tracker.maxActive, 1);
    assert.equal(tracker.active, 0);
});

test('cold MKV retries one interrupted metadata prefetch without overlapping provider sockets or replaying stale bytes', async () => {
    const prefixBytes = 300_000;
    const fixture = mkvFixture(500_000);
    const tracker = makeTracker();
    const headerByteCache = new Map();
    let fetches = 0;
    const h = pumpHarness({
        BOUNDED_MKV_HEADER_PARSE: true,
        INBAND_HEADER_BYTES: prefixBytes,
        INBAND_HEADER_CACHE_MAX: 2,
        headerByteCache,
        fetch: async (_url, options) => {
            fetches += 1;
            tracker.calls.push(options.headers);
            if (fetches === 1) {
                return trackedResponse(tracker, {
                    status: 206,
                    chunks: [fixture.subarray(0, 12)],
                    readErrorAt: 1,
                    headers: {
                        'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                        'Content-Length': String(fixture.length),
                        ETag: '"cold-retry-v1"',
                    },
                });
            }
            return trackedResponse(tracker, {
                status: 206,
                chunks: [
                    fixture.subarray(0, 12),
                    fixture.subarray(12, prefixBytes),
                    fixture.subarray(prefixBytes),
                ],
                headers: {
                    'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                    'Content-Length': String(fixture.length),
                    ETag: '"cold-retry-v1"',
                },
            });
        },
    });
    const session = mkvSession(fixture.length);

    await h.ensureBoundedMkvInputPump(session);

    assert.equal(fetches, 2);
    assert.equal(session.startupTimings.providerPreopenRetries, 1);
    assert.equal(session.startupTimings.providerPreopenLastRetryCode, 'PROVIDER_CONNECTION_RESET');
    assert.equal(tracker.maxActive, 1, 'the failed provider body is closed before retry');
    assert.equal(tracker.active, 1, 'only the successful retained body stays open');
    const captured = headerByteCache.get(session.sourceUrl);
    assert.equal(captured?.len, prefixBytes);
    assert.equal(Buffer.concat(captured?.chunks || []).equals(fixture.subarray(0, prefixBytes)), true);

    const writable = new CapturingWritable();
    const result = await h.runBoundedMkvInputPump(
        session,
        writable,
        new AbortController().signal,
        null,
    );

    assert.equal(result.bytesForwarded, fixture.length);
    assert.deepEqual(writable.bytes(), fixture, 'only the successful prefetch is replayed');
    assert.equal(tracker.maxActive, 1);
    assert.equal(tracker.active, 0);
});

test('known-size cold MKV accepts chunked HTTP 200 only after exact EOF', async () => {
    const fixture = mkvFixture(103);
    const tracker = makeTracker();
    let fetches = 0;
    const h = pumpHarness({
        fetch: async (_url, options) => {
            fetches += 1;
            tracker.calls.push(options.headers);
            return trackedResponse(tracker, {
                status: 200,
                chunks: [fixture.subarray(0, 3), fixture.subarray(3, 29), fixture.subarray(29)],
                headers: { ETag: '"known-size-chunked-v1"' },
            });
        },
    });
    const session = mkvSession(fixture.length);

    await h.ensureBoundedMkvInputPump(session);
    const writable = new CapturingWritable();
    const result = await h.runBoundedMkvInputPump(
        session,
        writable,
        new AbortController().signal,
        null,
    );

    assert.equal(fetches, 1);
    assert.equal(session.startupTimings.providerFullBodyAtZero, true);
    assert.equal(session.startupTimings.providerFullBodyBoundary, 'known-size-exact-eof');
    assert.equal(result.bytesForwarded, fixture.length);
    assert.deepEqual(writable.bytes(), fixture);
    assert.equal(tracker.maxActive, 1);
    assert.equal(tracker.active, 0);
});

test('known-size chunked HTTP 200 rejects an extra byte beyond the exact boundary', async () => {
    const fixture = mkvFixture(81);
    const tracker = makeTracker();
    let fetches = 0;
    const h = pumpHarness({
        fetch: async () => {
            fetches += 1;
            return trackedResponse(tracker, {
                status: 200,
                chunks: [fixture, Buffer.from([0xff])],
                headers: { ETag: '"known-size-too-long"' },
            });
        },
    });

    await assert.rejects(
        h.runBoundedMkvInputPump(
            mkvSession(fixture.length),
            new CapturingWritable(),
            new AbortController().signal,
            null,
        ),
        (error) => error?.code === 'RANGE_UNSUPPORTED' && error?.status === 502,
    );
    assert.equal(fetches, 1);
    assert.equal(tracker.active, 0);
});

test('unknown-size cold MKV streams one HTTP 200 body and binds its size only at EOF', async () => {
    const fixture = mkvFixture(109);
    const tracker = makeTracker();
    let fetches = 0;
    const h = pumpHarness({
        fetch: async (_url, options) => {
            fetches += 1;
            tracker.calls.push(options.headers);
            return trackedResponse(tracker, {
                status: 200,
                chunks: [fixture.subarray(0, 1), fixture.subarray(1, 17), fixture.subarray(17)],
                headers: { ETag: '"unknown-size-stream-eof"' },
            });
        },
    });
    const session = mkvSession(null);
    delete session.fileSizeBytes;
    delete session.codecProfile.fileSizeBytes;

    await h.ensureBoundedMkvInputPump(session);
    assert.equal(session.fileSizeBytes, undefined);
    assert.equal(session.startupTimings.providerFullBodyBoundary, 'stream-eof');
    assert.equal(session.startupTimings.fileSizePendingFullBodyEof, true);

    const writable = new CapturingWritable();
    const result = await h.runBoundedMkvInputPump(
        session,
        writable,
        new AbortController().signal,
        null,
    );

    assert.equal(fetches, 1);
    assert.equal(result.bytesForwarded, fixture.length);
    assert.equal(session.fileSizeBytes, fixture.length);
    assert.equal(session.codecProfile.fileSizeBytes, fixture.length);
    assert.equal(session.startupTimings.fileSizeDiscoveredFromPlaybackGet, true);
    assert.equal(session.startupTimings.fileSizePendingFullBodyEof, false);
    assert.deepEqual(writable.bytes(), fixture);
    assert.equal(tracker.maxActive, 1);
    assert.equal(tracker.active, 0);
});

test('HTTP 200 full-body fallback stays fail-closed outside an exact offset-zero MKV', async (t) => {
    const fixture = mkvFixture(64);

    for (const scenario of [
        {
            name: 'compressed body',
            headers: {
                'Content-Length': String(fixture.length),
                'Content-Encoding': 'gzip',
                ETag: '"compressed"',
            },
            expectedCode: 'RANGE_UNSUPPORTED',
        },
        {
            name: 'non-Matroska binary',
            chunks: [Buffer.alloc(fixture.length, 0xff)],
            headers: { 'Content-Length': String(fixture.length), ETag: '"not-mkv"' },
            expectedCode: 'INVALID_MKV_INPUT',
        },
    ]) {
        await t.test(scenario.name, async () => {
            const tracker = makeTracker();
            let fetches = 0;
            const writable = new CapturingWritable();
            const h = pumpHarness({
                fetch: async () => {
                    fetches += 1;
                    return trackedResponse(tracker, {
                        status: 200,
                        chunks: scenario.chunks || [fixture],
                        headers: scenario.headers,
                    });
                },
            });
            const session = mkvSession(fixture.length);
            const operation = h.runBoundedMkvInputPump(
                session,
                writable,
                new AbortController().signal,
                null,
            );
            await assert.rejects(
                operation,
                (error) => error?.code === scenario.expectedCode && error?.status === 502,
            );
            assert.equal(fetches, 1);
            assert.equal(writable.bytes().length, 0);
            assert.equal(tracker.active, 0);
        });
    }

    await t.test('resumed MKV drains one exact identity byte before indexed seek', async () => {
        const tracker = makeTracker();
        let fetches = 0;
        const h = pumpHarness({
            fetch: async (_url, options) => {
                fetches += 1;
                tracker.calls.push(options.headers);
                return trackedResponse(tracker, {
                    status: 206,
                    chunks: [fixture.subarray(0, 1)],
                    headers: {
                        'Content-Range': `bytes 0-0/${fixture.length}`,
                        'Content-Length': '1',
                        ETag: '"seek-identity"',
                    },
                });
            },
        });
        const session = mkvSession(fixture.length);
        session.seekOffset = 12;

        await h.ensureBoundedMkvInputPump(session);

        assert.equal(fetches, 1);
        assert.equal(tracker.calls[0].Range, 'bytes=0-0');
        assert.equal(session.preopenedVodInputAttempt, undefined);
        assert.equal(session.startupTimings.providerGetPreopened, false);
        assert.equal(session.startupTimings.providerSeekIdentityPreflight, true);
        assert.equal(session.startupTimings.providerSeekIdentityPreflightBytes, 1);
        assert.equal(session.startupTimings.fileSizeBytes, fixture.length);
        assert.equal(session.vodInputValidator.value, '"seek-identity"');
        assert.equal(tracker.active, 0);
    });

    await t.test('resumed MKV reuses its exact identity request to capture a bounded metadata prefix', async () => {
        const prefixBytes = 300_000;
        const largeFixture = mkvFixture(500_000);
        const tracker = makeTracker();
        const headerByteCache = new Map();
        let fetches = 0;
        const h = pumpHarness({
            BOUNDED_MKV_HEADER_PARSE: true,
            INBAND_HEADER_BYTES: prefixBytes,
            INBAND_HEADER_CACHE_MAX: 2,
            headerByteCache,
            fetch: async (_url, options) => {
                fetches += 1;
                tracker.calls.push(options.headers);
                return trackedResponse(tracker, {
                    status: 206,
                    chunks: [largeFixture.subarray(0, prefixBytes)],
                    headers: {
                        'Content-Range': `bytes 0-${prefixBytes - 1}/${largeFixture.length}`,
                        'Content-Length': String(prefixBytes),
                        ETag: '"seek-metadata"',
                    },
                });
            },
        });
        const session = mkvSession(largeFixture.length);
        session.seekOffset = 12;

        await h.ensureBoundedMkvInputPump(session);

        assert.equal(fetches, 1, 'metadata capture must not add a second provider request');
        assert.equal(tracker.calls[0].Range, `bytes=0-${prefixBytes - 1}`);
        assert.equal(tracker.maxActive, 1);
        assert.equal(tracker.active, 0, 'the prefix socket is closed before indexed seek');
        assert.equal(session.startupTimings.providerSeekIdentityPreflightBytes, prefixBytes);
        assert.equal(session.startupTimings.providerSeekHeaderPrefetch, true);
        assert.equal(session.vodInputPrefixIdentityBytes, 512);
        assert.equal(
            session.vodInputPrefixIdentitySha256,
            crypto.createHash('sha256').update(largeFixture.subarray(0, 512)).digest('hex'),
        );
        assert.equal(session.startupTimings.providerSeekPrefixIdentityBytes, 512);
        const captured = headerByteCache.get(session.sourceUrl);
        assert.equal(captured?.len, prefixBytes);
        assert.equal(captured?.done, true);
        assert.equal(Buffer.concat(captured?.chunks || []).equals(largeFixture.subarray(0, prefixBytes)), true);
    });

    await t.test('resumed MKV with a complete exact-size profile defers identity to the first seek window', async () => {
        const largeFixture = mkvFixture(500_000);
        const tracker = makeTracker();
        const headerByteCache = new Map();
        let fetches = 0;
        const h = pumpHarness({
            BOUNDED_MKV_HEADER_PARSE: true,
            INBAND_HEADER_BYTES: 300_000,
            INBAND_HEADER_CACHE_MAX: 2,
            headerByteCache,
            hasCompleteMkvPlaybackProfile: (profile) => profile?.metadataComplete === true,
            fetch: async (_url, options) => {
                fetches += 1;
                tracker.calls.push(options.headers);
                return trackedResponse(tracker, {
                    status: 206,
                    chunks: [largeFixture.subarray(0, 512)],
                    headers: {
                        'Content-Range': `bytes 0-511/${largeFixture.length}`,
                        'Content-Length': '512',
                        ETag: '"seek-complete-profile"',
                    },
                });
            },
        });
        const session = mkvSession(largeFixture.length);
        session.seekOffset = 12;
        session.codecProfile = {
            container: 'matroska,webm',
            fileSizeBytes: largeFixture.length,
            metadataComplete: true,
            durationSeconds: 7_200,
            videoCodec: 'h264',
            audioTracks: [{ index: 1, codec: 'aac', language: 'eng' }],
            subtitles: [],
            probeSource: 'gateway_inband',
            probedAt: '2026-08-31T12:00:00.000Z',
        };

        await h.ensureBoundedMkvInputPump(session);

        assert.equal(fetches, 0, 'the seek broker must own the only provider round trip');
        assert.equal(tracker.calls.length, 0);
        assert.equal(tracker.maxActive, 0);
        assert.equal(tracker.active, 0);
        assert.ok(
            session.startupTimings.providerGetPreopenMs >= 0 &&
            session.startupTimings.providerGetPreopenMs < 50,
            'deferral performs no network wait even under a parallel test load',
        );
        assert.equal(session.startupTimings.providerSeekIdentityPreflight, false);
        assert.equal(session.startupTimings.providerSeekIdentityDeferredToBroker, true);
        assert.equal(session.startupTimings.providerSeekHeaderPrefetch, false);
        assert.equal(session.vodInputPrefixIdentityBytes, undefined);
        assert.equal(session.vodInputPrefixIdentitySha256, undefined);
        assert.equal(headerByteCache.has(session.sourceUrl), false);
    });

    await t.test('reconnect at a non-zero offset', async () => {
        const tracker = makeTracker();
        const cut = 19;
        let fetches = 0;
        const h = pumpHarness({
            fetch: async (_url, options) => {
                fetches += 1;
                tracker.calls.push(options.headers);
                if (fetches === 1) {
                    return trackedResponse(tracker, {
                        chunks: [fixture.subarray(0, cut)],
                        headers: {
                            'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                            'Content-Length': String(fixture.length),
                            ETag: '"reconnect-v1"',
                        },
                    });
                }
                return trackedResponse(tracker, {
                    status: 200,
                    chunks: [fixture],
                    headers: { 'Content-Length': String(fixture.length), ETag: '"reconnect-v1"' },
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
        assert.equal(fetches, 2);
        assert.equal(tracker.calls[1].Range, `bytes=${cut}-${fixture.length - 1}`);
        assert.deepEqual(writable.bytes(), fixture.subarray(0, cut));
        assert.equal(tracker.active, 0);
    });
});

test('a declared MKV with an ISO-BMFF prefix returns one bound correction and closes the only provider body', async (t) => {
    const fixture = mp4Fixture(96, 'isom');

    for (const status of [200, 206]) {
        await t.test(`HTTP ${status}`, async () => {
            const tracker = makeTracker();
            let fetches = 0;
            const h = pumpHarness({
                fetch: async () => {
                    fetches += 1;
                    return trackedResponse(tracker, {
                        status,
                        chunks: [fixture.subarray(0, 5), fixture.subarray(5)],
                        headers: status === 200
                            ? { 'Content-Length': String(fixture.length), ETag: '"mp4-as-mkv"' }
                            : {
                                'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                                'Content-Length': String(fixture.length),
                                ETag: '"mp4-as-mkv"',
                            },
                    });
                },
            });
            const session = mkvSession(fixture.length);
            await assert.rejects(
                h.ensureBoundedMkvInputPump(session),
                (error) => {
                    assert.equal(error?.code, 'SOURCE_CONTAINER_MISMATCH');
                    assert.equal(error?.status, 409);
                    assert.deepEqual(JSON.parse(JSON.stringify(error?.details)), {
                        protocol: 1,
                        code: 'SOURCE_CONTAINER_MISMATCH',
                        declaredContainer: 'mkv',
                        observedContainer: 'mp4',
                        evidence: {
                            kind: 'iso-bmff-ftyp-v1',
                            prefixSha256: crypto.createHash('sha256').update(fixture).digest('hex'),
                            sourceUrlSha256: crypto.createHash('sha256').update(session.sourceUrl).digest('hex'),
                            effectiveUrlSha256: crypto.createHash('sha256').update(session.sourceUrl).digest('hex'),
                            validatorKind: 'etag',
                            validatorSha256: crypto.createHash('sha256').update('"mp4-as-mkv"').digest('hex'),
                            fileSizeBytes: fixture.length,
                        },
                    });
                    return true;
                },
            );
            assert.equal(fetches, 1);
            assert.equal(tracker.maxActive, 1);
            assert.equal(tracker.active, 0);
        });
    }
});

test('a declared MKV with three MPEG-TS sync packets returns one bound correction', async () => {
    const fixture = mpegTsFixture();
    const tracker = makeTracker();
    let fetches = 0;
    const h = pumpHarness({
        fetch: async () => {
            fetches += 1;
            return trackedResponse(tracker, {
                status: 206,
                chunks: [fixture.subarray(0, 96), fixture.subarray(96, 240), fixture.subarray(240)],
                headers: {
                    'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                    'Content-Length': String(fixture.length),
                    ETag: '"ts-as-mkv"',
                },
            });
        },
    });
    const session = mkvSession(fixture.length);
    await assert.rejects(
        h.ensureBoundedMkvInputPump(session),
        (error) => {
            assert.equal(error?.code, 'SOURCE_CONTAINER_MISMATCH');
            assert.equal(error?.status, 409);
            assert.equal(error?.details?.observedContainer, 'ts');
            assert.equal(error?.details?.evidence?.kind, 'mpeg-ts-sync-v1');
            assert.equal(
                error?.details?.evidence?.prefixSha256,
                crypto.createHash('sha256').update(fixture.subarray(0, 512)).digest('hex'),
            );
            return true;
        },
    );
    assert.equal(fetches, 1);
    assert.equal(tracker.maxActive, 1);
    assert.equal(tracker.active, 0);
});

test('a server-observed MP4 authority overrides stale MKV hints without provider I/O', async () => {
    const sourceUrl = 'https://provider.example/movie/account/title.mkv';
    const h = pumpHarness({
        fetch: async () => { throw new Error('an observed non-MKV must not enter the bounded MKV lane'); },
    });
    const authority = h.normalizeSourceContainerAuthority({
        protocol: 1,
        container: 'mp4',
        sourceUrlSha256: crypto.createHash('sha256').update(sourceUrl).digest('hex'),
        evidenceKind: 'iso-bmff-ftyp-v1',
        prefixSha256: 'a'.repeat(64),
    }, sourceUrl);
    assert.ok(authority);
    const session = {
        ...mkvSession(96),
        sourceUrl,
        sourceContainerAuthority: authority,
    };
    assert.equal(h.isFiniteMkvVodSession(session), false);
    await h.ensureBoundedMkvInputPump(session);
    assert.equal(session.preopenedVodInputAttempt, undefined);
    assert.equal(h.normalizeSourceContainerAuthority({ ...authority, sourceUrlSha256: 'b'.repeat(64) }, sourceUrl), null);
});

test('finite MKV resume leaves no provider body open before indexed FFmpeg seek', async () => {
    const fixture = mkvFixture(128);
    const tracker = makeTracker();
    const h = pumpHarness({
        fetch: async (_url, options) => {
            tracker.calls.push(options.headers);
            return trackedResponse(tracker, {
                chunks: [fixture.subarray(0, 1)],
                headers: {
                    'Content-Range': `bytes 0-0/${fixture.length}`,
                    'Content-Length': '1',
                    ETag: '"seek-identity-v1"',
                },
            });
        },
    });
    const session = mkvSession(fixture.length);
    session.seekOffset = 93;

    await h.ensureBoundedMkvInputPump(session);

    assert.equal(tracker.calls.length, 1);
    assert.equal(tracker.calls[0].Range, 'bytes=0-0');
    assert.equal(tracker.maxActive, 1);
    assert.equal(tracker.active, 0, 'the identity range is fully drained before the seek broker opens');
    assert.equal(session.preopenedVodInputAttempt, undefined);
    assert.equal(session.startupTimings.providerGetPreopened, false);
    assert.equal(session.startupTimings.providerSeekIdentityPreflight, true);
    assert.equal(session.startupTimings.providerSeekIdentityPreflightBytes, 1);
    assert.equal(session.startupTimings.fileSizeBytes, fixture.length);
    assert.equal(session.vodInputValidator.value, '"seek-identity-v1"');
});

test('cold proof training reuses that one provider body for both local analyzers', async () => {
    const fixture = mkvFixture(4_096);
    const tracker = makeTracker();
    const children = analyzerChildPair();
    let spawned = 0;
    let fetches = 0;
    const h = pumpHarness({
        MKV_H264_FAST_START_COPY_ACTIVATION_READY: true,
        MKV_H264_FAST_START_PROOF_CURRENT_KEY: Buffer.alloc(32, 1),
        mkvH264FastStartIdentityContext: () => ({ tenantScopeSha256: 'a', itemScopeSha256: 'b' }),
        spawn: () => children[spawned++],
        fetch: async () => {
            fetches += 1;
            return trackedResponse(tracker, {
                chunks: [fixture],
                headers: {
                    'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                    'Content-Length': String(fixture.length),
                    ETag: '"training-v1"',
                },
            });
        },
    });
    const session = mkvSession(null);
    delete session.fileSizeBytes;
    delete session.codecProfile.fileSizeBytes;
    session.codecProfile.videoCodec = 'h264';
    session.codecProfile.audioTracks = [{ index: 1, codec: 'aac', channels: 2 }];
    session.playbackIdentity = { sourceId: 's', itemType: 'movie', itemId: 'm' };
    session.mkvH264FastStart = { eligible: false };
    session.mode = 'remux';
    await h.ensureBoundedMkvInputPump(session);
    const writable = new CapturingWritable();
    const result = await h.runBoundedMkvInputPump(session, writable, new AbortController().signal, null);
    assert.equal(fetches, 1);
    assert.equal(tracker.maxActive, 1);
    assert.equal(spawned, 2, 'both analyzers are local children of the retained body');
    assert.equal(result.bytesForwarded, fixture.length);
    assert.equal(session.mkvH264FullFilePacketMetrics.closedGopIdrVerified, true);
    assert.equal(session.mkvH264FullFilePacketMetrics.keyframeCount, 3);
    assert.equal(session.mkvH264FullFilePacketMetrics.idrCount, 3);
    assert.ok(children.every((child) => child.exited));
});

test('optional analyzer backpressure abandons proof without slowing the primary pump', async () => {
    const fixture = mkvFixture(4_096);
    const tracker = makeTracker();
    const children = analyzerChildPair({ slowIdr: true });
    let spawned = 0;
    const analyzers = new Set();
    const h = pumpHarness({
        MKV_H264_FAST_START_COPY_ACTIVATION_READY: true,
        MKV_H264_FAST_START_PROOF_CURRENT_KEY: Buffer.alloc(32, 1),
        MKV_H264_FAST_START_ANALYZER_BUFFER_BYTES: 1,
        mkvH264FastStartIdentityContext: () => ({ tenantScopeSha256: 'a', itemScopeSha256: 'b' }),
        mkvH264FullFileAnalyzers: analyzers,
        spawn: () => children[spawned++],
        fetch: async () => trackedResponse(tracker, {
            chunks: [fixture],
            headers: {
                'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                'Content-Length': String(fixture.length),
                ETag: '"analyzer-slow"',
            },
        }),
    });
    const session = mkvSession(fixture.length);
    session.playbackIdentity = { sourceId: 's', itemType: 'movie', itemId: 'm' };
    session.mkvH264FastStart = { eligible: false };
    const writable = new CapturingWritable();
    const result = await h.runBoundedMkvInputPump(session, writable, new AbortController().signal, null);
    assert.equal(result.bytesForwarded, fixture.length);
    assert.deepEqual(writable.bytes(), fixture);
    assert.ok(children.some((child) => child.kills >= 1));
    assert.ok(children.every((child) => child.exited));
    assert.equal(analyzers.size, 0);
    assert.equal(session.mkvH264FullFilePacketMetrics, null);
});

test('provider error and abort reap the optional analyzer and preserve the primary error', async (t) => {
    for (const [label, setup, expectedCode] of [
        ['provider-error', () => ({ fetch: async () => { throw new Error('provider down'); }, signal: new AbortController().signal }), 'PROVIDER_FETCH_FAILED'],
        ['abort', () => { const controller = new AbortController(); controller.abort(); return { fetch: async () => { throw new Error('must not fetch'); }, signal: controller.signal }; }, 'VOD_INPUT_ABORTED'],
    ]) {
        await t.test(label, async () => {
            const children = analyzerChildPair();
            let spawned = 0;
            const analyzers = new Set();
            const scenario = setup();
            const h = pumpHarness({
                MKV_H264_FAST_START_COPY_ACTIVATION_READY: true,
                MKV_H264_FAST_START_PROOF_CURRENT_KEY: Buffer.alloc(32, 1),
                mkvH264FastStartIdentityContext: () => ({ tenantScopeSha256: 'a', itemScopeSha256: 'b' }),
                mkvH264FullFileAnalyzers: analyzers,
                spawn: () => children[spawned++],
                fetch: scenario.fetch,
            });
            const session = mkvSession(64);
            session.playbackIdentity = { sourceId: 's', itemType: 'movie', itemId: 'm' };
            session.mkvH264FastStart = { eligible: false };
            await assert.rejects(
                h.runBoundedMkvInputPump(session, new CapturingWritable(), scenario.signal, null),
                (error) => error?.code === expectedCode,
            );
            assert.ok(children.some((child) => child.kills >= 1));
            assert.ok(children.every((child) => child.exited));
            assert.equal(analyzers.size, 0);
            assert.equal(session.mkvH264FullFilePacketMetrics, undefined);
        });
    }
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
    assert.deepEqual(
        JSON.parse(JSON.stringify(h.parseBoundedProviderContentRange(response(206, 'bytes 4-9/11', '6'), 4, 10))),
        { start: 4, end: 9, total: 11 },
    );
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

test('exhausted indexed MKV resume falls back once after releasing the broker and provider slot', async () => {
    const events = [];
    let starts = 0;
    const session = {
        id: 'indexed-resume-fallback',
        outputDir: '/tmp/indexed-resume-fallback',
        startupTimings: { slotReleaseWaitMs: 2500 },
        finiteMkvSeekBroker: { inputUrl: 'http://127.0.0.1/private' },
        inputFailure: null,
        lastError: null,
        logTail: '',
        status: 'starting',
        fastInputProbe: true,
    };
    const startSessionWithProviderRetry = startRetryHarness({
        PROVIDER_SLOT_RELEASE_DELAY_MS: 2500,
        startFfmpeg: (activeSession) => {
            starts += 1;
            events.push(`start:${activeSession.finiteMkvSeekBroker ? 'indexed' : 'linear'}`);
            return { attempt: starts };
        },
        waitForPlaylist: async (activeSession) => {
            if (starts === 1) {
                activeSession.finiteMkvSeekBroker.terminalError = {
                    status: 502,
                    code: 'PROVIDER_RECONNECT_EXHAUSTED',
                };
                throw new Error('indexed seek failed');
            }
        },
        applyFiniteMkvSeekBrokerFailure: (activeSession) => {
            const failure = activeSession.finiteMkvSeekBroker?.terminalError;
            if (!failure) return false;
            activeSession.inputFailure = { ...failure };
            activeSession.lastError = failure.code;
            return true;
        },
        closeFiniteMkvSeekBroker: async (activeSession) => {
            events.push('broker-close');
            activeSession.finiteMkvSeekBroker = null;
        },
        stopChildProcess: async (child) => {
            if (child) events.push(`child-stop:${child.attempt}`);
        },
        waitForVodInputRetry: async (delayMs) => {
            events.push(`release-wait:${delayMs}`);
            return true;
        },
    });

    assert.equal(await startSessionWithProviderRetry(session), true);
    assert.equal(starts, 2);
    assert.deepEqual(events.slice(0, 5), [
        'start:indexed',
        'broker-close',
        'child-stop:1',
        'release-wait:2500',
        'start:linear',
    ]);
    assert.equal(session.finiteMkvSeekBroker, null);
    assert.equal(session.finiteMkvLinearFallbacks, 1);
    assert.equal(session.startupTimings.finiteMkvSeekFallbackCode, 'PROVIDER_RECONNECT_EXHAUSTED');
    assert.equal(session.startupTimings.finiteMkvResumeMode, 'linear-byte-zero-fallback');
    assert.equal(session.startupTimings.boundedMkvInputPump, true);
    assert.equal(session.startupTimings.finiteMkvLinearFallbackReleaseWaitMs, 2500);
    assert.equal(session.startupTimings.slotReleaseWaitMs, 5000);
    assert.equal(session.forceFullInputProbe, true);
    assert.equal(session.fastInputProbeFallbacks, 1);
    assert.equal(session.startupTimings.finiteMkvLinearFallbackFullProbe, true);
    assert.equal(session.inputFailure, null);
});

test('indexed MKV resume preserves terminal provider and integrity failures', async () => {
    for (const code of ['PROVIDER_BUSY', 'PROXY_AUTH_FAILED', 'VOD_CHANGED', 'RANGE_UNSUPPORTED']) {
        let starts = 0;
        let brokerCloses = 0;
        const session = {
            id: `indexed-terminal-${code}`,
            outputDir: '/tmp/indexed-terminal',
            startupTimings: {},
            finiteMkvSeekBroker: { inputUrl: 'http://127.0.0.1/private' },
            inputFailure: null,
            lastError: null,
            logTail: '',
            status: 'starting',
        };
        const startSessionWithProviderRetry = startRetryHarness({
            startFfmpeg: () => {
                starts += 1;
                return { attempt: starts };
            },
            waitForPlaylist: async () => { throw new Error(code); },
            applyFiniteMkvSeekBrokerFailure: (activeSession) => {
                activeSession.inputFailure = { code, status: code === 'PROVIDER_BUSY' ? 458 : 502 };
                activeSession.lastError = code;
                return true;
            },
            closeFiniteMkvSeekBroker: async () => { brokerCloses += 1; },
        });

        assert.equal(await startSessionWithProviderRetry(session), false, `${code} must remain terminal`);
        assert.equal(starts, 1, `${code} must not open a fallback provider input`);
        assert.equal(brokerCloses, 0, `${code} must not close-and-rearm the broker as a retry`);
        assert.equal(session.inputFailure.code, code);
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

    await t.test('an offset-zero retry cannot switch the effective redirect target', async () => {
        const fixture = mkvFixture(16);
        const tracker = makeTracker();
        const originalUrl = 'https://cdn-a.example/title.mkv';
        const session = mkvSession(fixture.length);
        session.vodInputEffectiveUrlSha256 = crypto.createHash('sha256').update(originalUrl).digest('hex');
        const h = pumpHarness({
            fetch: async () => trackedResponse(tracker, {
                url: 'https://cdn-b.example/title.mkv',
                chunks: [fixture],
                headers: {
                    'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                    'Content-Length': String(fixture.length),
                    ETag: '"same-etag"',
                },
            }),
        });
        const writable = new CapturingWritable();
        await assert.rejects(
            h.runBoundedMkvInputPump(session, writable, new AbortController().signal, null),
            (error) => error?.code === 'VOD_CHANGED' && error?.status === 502,
        );
        assert.equal(writable.bytes().length, 0);
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

test('linear resume fault harness revalidates byte zero before accepting a rotated CDN target', async (t) => {
    const fixture = mkvFixture(1024);
    const originalTarget = 'https://cdn.example/media/title.mkv?expires=100&signature=old';
    const rotatedTarget = 'https://cdn.example/media/title.mkv?signature=new&expires=200';
    const prefixBytes = 512;
    const prefixSha256 = crypto.createHash('sha256')
        .update(fixture.subarray(0, prefixBytes))
        .digest('hex');

    await t.test('matching prefix permits one exact byte-zero stream without a validator', async () => {
        const tracker = makeTracker();
        const session = mkvSession(fixture.length);
        session.finiteMkvLinearFallbacks = 1;
        session.vodInputPrefixIdentityBytes = prefixBytes;
        session.vodInputPrefixIdentitySha256 = prefixSha256;
        session.vodInputEffectiveUrlSha256 = crypto.createHash('sha256').update(originalTarget).digest('hex');
        const h = pumpHarness({
            fetch: async (_url, options) => {
                tracker.calls.push(options.headers);
                return trackedResponse(tracker, {
                    url: rotatedTarget,
                    chunks: [fixture],
                    headers: {
                        'Content-Range': `bytes 0-${fixture.length - 1}/${fixture.length}`,
                        'Content-Length': String(fixture.length),
                    },
                });
            },
        });
        const writable = new CapturingWritable();

        const result = await h.runBoundedMkvInputPump(
            session,
            writable,
            new AbortController().signal,
            null,
        );

        assert.equal(result.bytesForwarded, fixture.length);
        assert.deepEqual(writable.bytes(), fixture);
        assert.equal(session.finiteMkvLinearFallbackIdentityVerified, true);
        assert.equal(
            session.vodInputEffectiveUrlSha256,
            crypto.createHash('sha256').update(rotatedTarget).digest('hex'),
        );
        assert.equal(tracker.calls.length, 1);
        assert.equal(tracker.maxActive, 1);
        assert.equal(tracker.active, 0);
    });

    await t.test('same-size changed media is rejected before one byte reaches FFmpeg', async () => {
        const changedFixture = Buffer.from(fixture);
        changedFixture[128] ^= 0xff;
        const tracker = makeTracker();
        const session = mkvSession(fixture.length);
        session.finiteMkvLinearFallbacks = 1;
        session.vodInputPrefixIdentityBytes = prefixBytes;
        session.vodInputPrefixIdentitySha256 = prefixSha256;
        session.vodInputEffectiveUrlSha256 = crypto.createHash('sha256').update(originalTarget).digest('hex');
        const h = pumpHarness({
            fetch: async () => trackedResponse(tracker, {
                url: rotatedTarget,
                chunks: [changedFixture],
                headers: {
                    'Content-Range': `bytes 0-${changedFixture.length - 1}/${changedFixture.length}`,
                    'Content-Length': String(changedFixture.length),
                },
            }),
        });
        const writable = new CapturingWritable();

        await assert.rejects(
            h.runBoundedMkvInputPump(session, writable, new AbortController().signal, null),
            (error) => error?.code === 'VOD_CHANGED' && error?.status === 502,
        );
        assert.equal(writable.bytes().length, 0);
        assert.equal(session.finiteMkvLinearFallbackIdentityVerified, undefined);
        assert.equal(tracker.maxActive, 1);
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
    const rationalSource = sourceBetween(
        source,
        'function strictMkvAnalyzerRational(',
        '\nfunction sameMkvAnalyzerRational(',
    );
    const buildCodecProfile = vm.runInNewContext(
        `(() => { ${rationalSource}\n${buildSource}\nreturn buildCodecProfile; })()`, {
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
            BOUNDED_MKV_HEADER_PARSE: false,
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
            return trackedResponse(makeTracker(), {
                chunks: [mkvFixture(cachedProfile.fileSizeBytes)],
                headers: {
                    'Content-Range': `bytes 0-${cachedProfile.fileSizeBytes - 1}/${cachedProfile.fileSizeBytes}`,
                    'Content-Length': String(cachedProfile.fileSizeBytes),
                    ETag: '"opaque-v1"',
                },
            });
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
    assert.equal(boundedPreflightFetches, 1, 'the single playback GET is preopened and retained');
});

test('the bounded MKV pump tees one exact leading prefix without another provider request', async () => {
    const file = Buffer.from([
        0x1a, 0x45, 0xdf, 0xa3,
        4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    const cache = new Map();
    const tracker = makeTracker();
    let fetches = 0;
    const h = pumpHarness({
        INBAND_HEADER_PARSE: true,
        BOUNDED_MKV_HEADER_PARSE: true,
        INBAND_HEADER_BYTES: 8,
        INBAND_HEADER_CACHE_MAX: 2,
        headerByteCache: cache,
        fetch: async (_url, options) => {
            fetches += 1;
            const start = Number(/^bytes=(\d+)-/.exec(options.headers.Range)?.[1] || 0);
            return trackedResponse(tracker, {
                chunks: [file.subarray(start, start + 5), file.subarray(start + 5)],
                headers: {
                    'content-range': `bytes ${start}-${file.length - 1}/${file.length}`,
                    'content-length': String(file.length - start),
                },
            });
        },
    });
    const written = [];
    const writable = new Writable({ write(chunk, _enc, callback) { written.push(Buffer.from(chunk)); callback(); } });
    const session = {
        id: 'capture-session',
        sourceUrl: 'https://provider.example/movie/account/capture.mkv',
        playbackHint: { streamType: 'movie', container: 'mkv' },
        codecProfile: { container: 'matroska,webm', fileSizeBytes: file.length },
    };

    await h.runBoundedMkvInputPump(session, writable, new AbortController().signal, null);
    assert.equal(fetches, 1, 'header capture must reuse the playback request');
    assert.deepEqual(Buffer.concat(written), file);
    const entry = cache.get(session.sourceUrl);
    assert.ok(entry);
    assert.equal(entry.len, 8);
    assert.equal(entry.done, true);
    assert.deepEqual(Buffer.concat(entry.chunks), file.subarray(0, 8));
    assert.equal(tracker.maxActive, 1);
});

function exactMetadataPayload() {
    return {
        streams: [
            { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
            {
                index: 1,
                codec_type: 'audio',
                codec_name: 'eac3',
                channels: 6,
                tags: { language: 'fre', title: 'Fran\u00e7ais' },
                disposition: { default: 0 },
            },
            {
                index: 2,
                codec_type: 'audio',
                codec_name: 'eac3',
                channels: 6,
                tags: { language: 'jpn', title: 'Japanese' },
                disposition: { default: 1 },
            },
        ],
        format: { format_name: 'matroska,webm', duration: '7248.032' },
    };
}

function completeMatroskaPrefix(byteLength) {
    const length = Math.max(20, Number(byteLength) || 20);
    const bytes = Buffer.alloc(length);
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(bytes, 0);
    bytes[4] = 0x80; // finite zero-byte EBML header payload
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0xff]).copy(bytes, 5); // unknown-size Segment
    Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x80]).copy(bytes, 10); // complete Info
    Buffer.from([0x16, 0x54, 0xae, 0x6b, 0x80]).copy(bytes, 15); // complete Tracks
    return bytes;
}

function metadataHarness(overrides = {}) {
    const source = readGateway();
    const snippets = [
        sourceBetween(source, 'function strictMkvAnalyzerRational(', '\nfunction sameMkvAnalyzerRational('),
        sourceBetween(source, 'function buildCodecProfile(', '\n// Store a successful profile'),
        sourceBetween(source, 'function cacheCodecProfile(', '\n// Run ffprobe on the in-band-captured'),
        sourceBetween(source, 'function readEbmlElementSize(', '\nasync function probeFromHeaderBytes('),
        sourceBetween(source, 'async function probeFromHeaderBytes(', '\n// Cached front for probeCodecProfileUncached'),
        sourceBetween(source, 'function mergeCodecProfiles(', '\nfunction shouldProbeMissingSubtitleTracks('),
        sourceBetween(source, 'function selectedAudioTrackForSession(', '\nfunction isKnownBrowserSafeAudio('),
        sourceBetween(source, 'function hasCompleteMkvPlaybackProfile(', '\nasync function waitForPlaylist('),
        sourceBetween(
            source,
            'async function enrichSessionCodecProfileFromBoundedHeader(',
            '\nasync function stopBoundedMkvInputPump(',
        ),
    ].join('\n');
    const headerByteCache = overrides.headerByteCache || new Map();
    const codecProfileCache = overrides.codecProfileCache || new Map();
    const ffprobeCalls = [];
    const writes = [];
    const unlinks = [];
    const runFfprobeImpl = overrides.runFfprobe || (async () => exactMetadataPayload());
    const fsp = {
        mkdir: async () => {},
        writeFile: async (file, bytes) => { writes.push({ file, bytes: Buffer.from(bytes) }); },
        unlink: async (file) => { unlinks.push(file); },
        ...overrides.fsp,
    };
    const nullableInt = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed) ? parsed : null;
    };
    const stringOrNull = (value) => {
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        if (typeof value === 'boolean') return String(value);
        return null;
    };
    const globals = {
        Buffer,
        path,
        Date,
        BOUNDED_MKV_HEADER_PARSE: true,
        MAX_MATROSKA_METADATA_ELEMENTS: 4_096,
        CODEC_PROFILE_CACHE_TTL_MS: 60_000,
        CODEC_PROFILE_CACHE_MAX: 16,
        CODEC_PROBE_ANALYZE_DURATION_US: 4_000_000,
        CODEC_PROBE_TIMEOUT_MS: 5_000,
        OUTPUT_DIR: '/virtual/norva-gateway-test',
        headerByteCache,
        codecProfileCache,
        fsp,
        crypto: { randomBytes: () => Buffer.alloc(8, 0x5a) },
        runFfprobe: async (...args) => {
            ffprobeCalls.push(args);
            return runFfprobeImpl(...args);
        },
        isFiniteMkvVodSession: () => true,
        publishCapturedFiniteMkvResumePrefix: () => false,
        needsMkvH264CurrentHeaderAuthority: () => false,
        maybeFinalizeMkvH264FastStartProof: () => null,
        mkvH264FastStartProfileFingerprint: () => 'a'.repeat(64),
        asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
        stringOrNull,
        nullableInt,
        nullableFloat: (value) => {
            if (value === null || value === undefined || value === '') return null;
            const parsed = Number.parseFloat(String(value));
            return Number.isFinite(parsed) ? parsed : null;
        },
        normalizeAudioStreamIndex: (value) => {
            const parsed = nullableInt(value);
            return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1024 ? parsed : null;
        },
        normalizeCodecToken: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
        compactRecord: (record) => Object.fromEntries(Object.entries(record || {}).filter(([, value]) => (
            value !== undefined && value !== null && value !== '' &&
            !(typeof value === 'number' && !Number.isFinite(value))
        ))),
        normalizeFileSizeBytes: (value) => {
            const parsed = Number(value);
            return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
        },
        fileSizeBytesForSession: (session) => {
            const candidates = [
                session?.fileSizeBytes,
                session?.codecProfile?.fileSizeBytes,
                session?.codecProfile?.file_size_bytes,
            ];
            for (const candidate of candidates) {
                const parsed = Number(candidate);
                if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
            }
            return null;
        },
        estimateDurationFromFormat: overrides.estimateDurationFromFormat || (() => null),
        streamLanguage: (stream) => stringOrNull(stream?.tags?.language),
        streamTitle: (stream, fallback) => stringOrNull(stream?.tags?.title) || fallback,
        subtitleKind: (codec) => ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text'].includes(String(codec || ''))
            ? 'text'
            : 'image',
        hasUsefulCodecProfile: (profile) => Boolean(
            stringOrNull(profile?.videoCodec) || stringOrNull(profile?.audioCodec) ||
            (Array.isArray(profile?.audioTracks) && profile.audioTracks.length > 0) ||
            (Array.isArray(profile?.subtitles) && profile.subtitles.length > 0)
        ),
    };
    const functions = vm.runInNewContext(
        `(() => { ${snippets}; return {
            buildCodecProfile,
            cacheCodecProfile,
            hasCompleteMatroskaMetadataPrefix,
            probeFromHeaderBytes,
            mergeCodecProfiles,
            selectedAudioTrackForSession,
            mappedAudioStreamIndexForSession,
            hasCompleteMkvPlaybackProfile,
            enrichSessionCodecProfileFromBoundedHeader,
        }; })()`,
        globals,
    );
    return { ...functions, headerByteCache, codecProfileCache, ffprobeCalls, writes, unlinks };
}

test('the structural completeness check walks real top-level Matroska elements, not SeekHead references', () => {
    const h = metadataHarness();
    const fixture = fs.readFileSync(path.join(ROOT, 'public/webengine/media/s_h264_ac3.mkv'));
    assert.equal(h.hasCompleteMatroskaMetadataPrefix(fixture), true);

    const tracksId = Buffer.from([0x16, 0x54, 0xae, 0x6b]);
    const tracksAt = fixture.lastIndexOf(tracksId);
    assert.ok(tracksAt > 0);
    assert.equal(
        h.hasCompleteMatroskaMetadataPrefix(fixture.subarray(0, tracksAt + tracksId.length)),
        false,
        'an element ID or SeekHead reference without its complete payload is not proof',
    );
});

test('the structural completeness check fails closed after a bounded number of top-level elements', () => {
    const h = metadataHarness();
    const ebmlHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]);
    const unknownSegment = Buffer.from([0x18, 0x53, 0x80, 0x67, 0xff]);
    const info = Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x80]);
    const tracks = Buffer.from([0x16, 0x54, 0xae, 0x6b, 0x80]);
    const voidElement = Buffer.from([0xec, 0x80]);
    const prefixWithVoids = (count) => Buffer.concat([
        ebmlHeader,
        unknownSegment,
        Buffer.alloc(count * voidElement.length, voidElement),
        info,
        tracks,
    ]);

    assert.equal(
        h.hasCompleteMatroskaMetadataPrefix(prefixWithVoids(4_094)),
        true,
        'Info and Tracks at the deterministic inspection boundary remain accepted',
    );
    assert.equal(
        h.hasCompleteMatroskaMetadataPrefix(prefixWithVoids(4_096)),
        false,
        'excessive Void padding is rejected before an unbounded synchronous walk',
    );
});

function completeInbandProfile(overrides = {}) {
    return {
        container: 'matroska,webm',
        metadataComplete: true,
        durationSeconds: 7_248.032,
        videoCodec: 'h264',
        audioTracks: [
            { index: 1, language: 'fre', codec: 'eac3' },
            { index: 2, language: 'jpn', codec: 'eac3' },
        ],
        subtitles: [],
        probeSource: 'gateway_inband',
        probedAt: '2026-08-16T12:00:00.000Z',
        ...overrides,
    };
}

test('only a dated in-band Matroska profile with complete unique stream families is authoritative', async (t) => {
    const h = metadataHarness();
    const complete = completeInbandProfile();
    assert.equal(h.hasCompleteMkvPlaybackProfile(complete), true,
        'an explicit empty subtitle family is complete and authoritative');

    const incompleteProfiles = [
        ['duration', { durationSeconds: undefined }],
        ['complete EBML metadata proof', { metadataComplete: undefined }],
        ['audio family', { audioTracks: undefined }],
        ['subtitle family', { subtitles: undefined }],
        ['probe source', { probeSource: undefined }],
        ['probe timestamp', { probedAt: undefined }],
        ['video codec', { videoCodec: undefined }],
        ['unique audio indexes', { audioTracks: [{ index: 1 }, { index: 1 }] }],
    ];
    for (const [name, missing] of incompleteProfiles) {
        await t.test(`rejects missing ${name}`, () => {
            assert.equal(h.hasCompleteMkvPlaybackProfile(completeInbandProfile(missing)), false);
        });
    }
});

test('an in-band prefix never invents VOD duration or bitrate from its temporary file', () => {
    const h = metadataHarness({
        estimateDurationFromFormat: (format) => Number(format.size) * 8 / Number(format.bit_rate),
    });
    const payload = exactMetadataPayload();
    delete payload.format.duration;
    payload.format.size = '4000000';
    payload.format.bit_rate = '8000000';
    const profile = h.buildCodecProfile(payload, Date.now(), 'gateway_inband');
    assert.equal(profile.durationSeconds, undefined);
    assert.equal(profile.bitRate, undefined);
    assert.equal(h.hasCompleteMkvPlaybackProfile({
        ...profile,
        metadataComplete: true,
    }), false);
});

test('finishing a local probe never deletes a newer header entry from another owner', async () => {
    const sourceUrl = 'https://provider.example/movie/account/owner-race.mkv';
    const original = {
        chunks: [completeMatroskaPrefix(300_000)],
        len: 300_000,
        done: true,
        captureOwner: 'owner-race-session',
    };
    const headerByteCache = new Map([[sourceUrl, original]]);
    let releaseProbe;
    const probeReleased = new Promise((resolve) => { releaseProbe = resolve; });
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const h = metadataHarness({
        headerByteCache,
        runFfprobe: async () => {
            markStarted();
            await probeReleased;
            return exactMetadataPayload();
        },
    });
    const session = {
        id: 'owner-race-session',
        sourceUrl,
        playbackHint: { streamType: 'movie', container: 'mkv' },
        codecProfile: { fileSizeBytes: 100 },
        startupTimings: {},
    };
    const pending = h.enrichSessionCodecProfileFromBoundedHeader(session);
    await started;
    const replacement = {
        chunks: [completeMatroskaPrefix(300_000)],
        len: 300_000,
        done: true,
        captureOwner: 'new-owner',
    };
    headerByteCache.set(sourceUrl, replacement);
    releaseProbe();
    assert.equal(await pending, true);
    assert.equal(headerByteCache.get(sourceUrl), replacement);
});

test('the ready finite session parses, caches, merges and returns a strict local profile before 201', async () => {
    const sourceUrl = 'https://provider.example/movie/account/metadata.mkv';
    const headerByteCache = new Map([[sourceUrl, {
        chunks: [completeMatroskaPrefix(300_000)],
        len: 300_000,
        done: true,
        capturing: false,
        captureOwner: 'metadata-session',
    }]]);
    const h = metadataHarness({ headerByteCache });
    const session = {
        id: 'metadata-session',
        sourceUrl,
        userAgent: 'Norva/Test',
        playbackHint: { streamType: 'movie', container: 'mkv' },
        codecProfile: { fileSizeBytes: 100 },
        codecProfileSource: '',
        startupTimings: {},
    };

    assert.equal(await h.enrichSessionCodecProfileFromBoundedHeader(session), true);
    assert.equal(h.ffprobeCalls.length, 1);
    assert.equal(h.hasCompleteMkvPlaybackProfile(session.codecProfile), true);
    assert.equal(session.codecProfile.durationSeconds, 7_248.032);
    assert.equal(session.codecProfile.audioTracks.length, 2);
    assert.equal(Array.isArray(session.codecProfile.subtitles), true);
    assert.equal(session.codecProfile.subtitles.length, 0);
    assert.equal(session.codecProfile.probeSource, 'gateway_inband');
    assert.equal(Number.isFinite(Date.parse(session.codecProfile.probedAt)), true);
    assert.equal(session.codecProfileSource, 'gateway_inband');
    assert.equal(session.startupTimings.inbandCodecProfileApplied, true);
    assert.equal(session.startupTimings.inbandCodecProfileComplete, true);
    assert.equal(headerByteCache.has(sourceUrl), false, 'per-startup header bytes are released');
    assert.equal(h.codecProfileCache.get(sourceUrl)?.profile?.probeSource, 'gateway_inband');
    assert.equal(h.codecProfileCache.get(sourceUrl)?.profile?.fileSizeBytes, 100,
        'the exact bounded size is joined to in-band metadata before caching');

    const source = readGateway();
    const route = sourceBetween(source, "app.post('/sessions'", "app.delete('/sessions/:id'");
    const ensureAt = route.indexOf('await ensureBoundedMkvInputPump(');
    const enrichAt = route.indexOf('await enrichSessionCodecProfileFromBoundedHeader(', ensureAt);
    const freezeAt = route.indexOf('freezeMultiAudioHlsTopology(session);', ensureAt);
    const startAt = route.indexOf('const started = await startSessionWithProviderRetry(', ensureAt);
    assert.match(route, /await enrichSessionCodecProfileFromBoundedHeader\(\s*session,\s*sessionRequestAbortController\.signal,?\s*\)/);
    assert.ok(ensureAt >= 0 && enrichAt > ensureAt, 'the bounded prefix must exist before local probing');
    assert.ok(freezeAt > enrichAt, 'the exact local profile must exist before topology freeze');
    assert.ok(startAt > freezeAt, 'FFmpeg must start only after the rendition graph is immutable');
    assert.equal(
        route.indexOf('await enrichSessionCodecProfileFromBoundedHeader(', enrichAt + 1),
        -1,
        'cold metadata enrichment must not be deferred until after FFmpeg startup',
    );
});

test('cold 0:a:0 fallback reports the first actual audio index instead of the requested later index', async () => {
    const sourceUrl = 'https://provider.example/movie/account/cold-map.mkv';
    const headerByteCache = new Map([[sourceUrl, {
        chunks: [completeMatroskaPrefix(300_000)],
        len: 300_000,
        done: true,
        captureOwner: 'cold-map-session',
    }]]);
    const h = metadataHarness({ headerByteCache });
    const session = {
        id: 'cold-map-session',
        sourceUrl,
        playbackHint: { streamType: 'movie', container: 'mkv' },
        codecProfile: { fileSizeBytes: 100 },
        audioStreamIndex: 2,
        actualAudioMap: '0:a:0',
        startupTimings: {},
    };

    assert.equal(await h.enrichSessionCodecProfileFromBoundedHeader(session), true);
    assert.equal(session.actualMappedAudioStreamIndex, 1);
    assert.equal(h.mappedAudioStreamIndexForSession(session), 1);
    assert.notEqual(h.mappedAudioStreamIndexForSession(session), session.audioStreamIndex);
});

test('a new bounded owner replaces a stale partial prefix and invalid EBML is cleaned after enrichment', async () => {
    const sourceUrl = 'https://provider.example/movie/account/takeover.mkv';
    const stale = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    const invalid = Buffer.from('not-ebml');
    const headerByteCache = new Map([[sourceUrl, {
        chunks: [stale],
        len: stale.length,
        done: false,
        capturing: true,
        captureOwner: 'old-owner',
    }]]);
    const pump = pumpHarness({
        BOUNDED_MKV_HEADER_PARSE: true,
        INBAND_HEADER_BYTES: invalid.length,
        INBAND_HEADER_CACHE_MAX: 2,
        headerByteCache,
    });
    const session = {
        id: 'new-owner',
        sourceUrl,
        playbackHint: { streamType: 'movie', container: 'mkv' },
        codecProfile: { container: 'matroska,webm', fileSizeBytes: invalid.length },
        startupTimings: {},
    };

    pump.captureBoundedMkvHeaderBytes(session, 0, invalid);
    const replacement = headerByteCache.get(sourceUrl);
    assert.equal(replacement.captureOwner, 'new-owner');
    assert.deepEqual(Buffer.concat(replacement.chunks), invalid);
    assert.equal(replacement.done, true);

    let invalidProbeCalls = 0;
    const h = metadataHarness({
        headerByteCache,
        runFfprobe: async () => {
            invalidProbeCalls += 1;
            throw new Error('Invalid data found when processing input');
        },
    });
    assert.equal(await h.enrichSessionCodecProfileFromBoundedHeader(session), false);
    assert.equal(invalidProbeCalls, 1);
    assert.equal(headerByteCache.has(sourceUrl), false);
    assert.equal(session.startupTimings.inbandCodecProfileApplied, false);
    assert.equal(session.startupTimings.inbandCodecProfileComplete, false);
});

test('request abort reaches an active local ffprobe and still releases the captured prefix', async () => {
    const sourceUrl = 'https://provider.example/movie/account/abort-local-probe.mkv';
    const headerByteCache = new Map([[sourceUrl, {
        chunks: [completeMatroskaPrefix(300_000)],
        len: 300_000,
        done: true,
        captureOwner: 'abort-session',
    }]]);
    let signalSeen = null;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const h = metadataHarness({
        headerByteCache,
        runFfprobe: async (_args, _timeoutMs, _sourceUrl, options) => {
            signalSeen = options.signal;
            markStarted();
            return new Promise((_resolve, reject) => {
                const abort = () => reject(Object.assign(new Error('Codec probe aborted'), {
                    code: 'VOD_INPUT_ABORTED',
                }));
                options.signal.addEventListener('abort', abort, { once: true });
                if (options.signal.aborted) abort();
            });
        },
    });
    const controller = new AbortController();
    const session = {
        id: 'abort-session',
        sourceUrl,
        playbackHint: { streamType: 'movie', container: 'mkv' },
        codecProfile: { container: 'matroska,webm', fileSizeBytes: 300_000 },
        startupTimings: {},
    };
    const pending = h.enrichSessionCodecProfileFromBoundedHeader(session, controller.signal);
    await started;
    controller.abort();

    assert.equal(await pending, false);
    assert.equal(signalSeen, controller.signal);
    assert.equal(signalSeen.aborted, true);
    assert.equal(headerByteCache.has(sourceUrl), false);
});

test('local ffprobe probesize spans every retained header byte beyond the legacy 2 MB cap', async () => {
    const sourceUrl = 'https://provider.example/movie/account/large-header.mkv';
    const byteLength = 2_500_123;
    const headerByteCache = new Map([[sourceUrl, {
        chunks: [completeMatroskaPrefix(byteLength)],
        len: byteLength,
        done: true,
        captureOwner: 'large-header-session',
    }]]);
    const h = metadataHarness({ headerByteCache });

    const profile = await h.probeFromHeaderBytes(sourceUrl);
    assert.equal(h.hasCompleteMkvPlaybackProfile(profile), true);
    assert.equal(h.ffprobeCalls.length, 1);
    const args = h.ffprobeCalls[0][0];
    const probeSizeAt = args.indexOf('-probesize');
    assert.notEqual(probeSizeAt, -1);
    assert.equal(args[probeSizeAt + 1], String(byteLength));
    assert.ok(Number(args[probeSizeAt + 1]) > 2_000_000);
    assert.equal(h.writes[0].bytes.length, byteLength);
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
    const spacedCredentials = providerSlotKeyFromUrl(
        'https://shared.example:8443/movie/%20%20account-a%20%20/%20password%20/404.mkv',
        ownerB,
    );
    const trimmedCredentials = providerSlotKeyFromUrl(
        'https://shared.example:8443/movie/account-a/password/404.mkv',
        ownerB,
    );
    assert.notEqual(spacedCredentials, trimmedCredentials,
        'significant Xtream credential whitespace must remain part of the destructive slot identity');
    const whitespaceOnlyPassword = providerSlotKeyFromUrl(
        'https://shared.example:8443/movie/account-a/%20%20/405.mkv',
        ownerB,
    );
    assert.match(whitespaceOnlyPassword, /^account:/,
        'a non-empty whitespace password remains exact credential data, not an absent capability');

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

test('ffprobe timeout preserves terminal 458/407 stderr, waits for pipe close, and force-kills', async () => {
    for (const scenario of [
        { stderr: 'HTTP 458 max connections', code: 'PROVIDER_BUSY', status: 458 },
        { stderr: 'HTTP error 407 Proxy Authentication Required', code: 'PROXY_AUTH_FAILED', status: 502 },
    ]) {
        const { child, runFfprobe } = ffprobeTimeoutHarness();
        let settled = false;
        const pending = runFfprobe([], 2, 'https://provider.example/movie/account/title.mkv')
            .finally(() => { settled = true; });
        child.stderr.emit('data', Buffer.from(scenario.stderr));
        const forceKillDeadline = Date.now() + 250;
        while (child.kills.length < 2 && Date.now() < forceKillDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
        assert.equal(settled, false, 'no next provider request may start before ffprobe exits');
        child.emit('exit', null, 'SIGKILL');
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false, 'late pipe output must remain observable after process exit');
        child.emit('close', null, 'SIGKILL');
        await assert.rejects(
            pending,
            (error) => error?.code === scenario.code && error?.status === scenario.status,
        );
        assert.equal(settled, true);
    }
});

test('finite MKV seek preparation drains the retained provider before opening one pinned broker', async () => {
    const source = readGateway();
    const block = sourceBetween(
        source,
        'function usesFiniteMkvSeekBroker(',
        '\nfunction strictMkvAnalyzerInteger(',
    );
    const events = [];
    const broker = {
        inputUrl: 'http://127.0.0.1:12345/finite-mkv-seek/secret',
        providerFetches: 3,
        completedProviderFetches: 2,
        interruptedProviderFetches: 1,
        cacheHits: 4,
        cacheMisses: 5,
        cacheEvictions: 1,
        maxQueuedRequests: 2,
        plannedSupersessions: 2,
        dispatcherRefreshes: 2,
        terminalError: null,
        async close() { events.push('broker-close'); },
    };
    let brokerOptions = null;
    const harness = vm.runInNewContext(
        `(() => { ${block}; return { usesFiniteMkvSeekBroker, prepareFiniteMkvSeekBroker, closeFiniteMkvSeekBroker }; })()`,
        {
            Number,
            FFMPEG_USER_AGENT: 'Norva-Test/1',
            PROVIDER_SLOT_RELEASE_DELAY_MS: 2500,
            FINITE_MKV_SEEK_WINDOW_BYTES: 2 * 1024 * 1024,
            FINITE_MKV_MULTI_AUDIO_SEEK_WINDOW_BYTES: 1 * 1024 * 1024,
            FINITE_MKV_RESUME_WARMUP_WINDOW_BYTES: 256 * 1024,
            FINITE_MKV_RESUME_CUE_GRACE_MS: 50,
            FINITE_MKV_RESUME_PREFIX_WEAK_VALIDATION_BYTES: 1024 * 1024,
            FINITE_MKV_SEEK_CACHE_BYTES: 32 * 1024 * 1024,
            INBAND_HEADER_BYTES: 4 * 1024 * 1024,
            FINITE_MKV_SEEK_PROXY_AGENT_MAX_AGE_MS: 4 * 60_000,
            finiteMkvResumePrefixCache: {
                get: () => null,
                put: () => true,
            },
            providerNodeRouteForSession: () => ({ slot: 3, nodeTransport: 'http' }),
            alternateProviderNodeTransportRoute: () => ({ slot: 3, nodeTransport: 'socks5' }),
            pinnedProxyAgentFactoryForRoute: (route) => () => ({
                slot: route.slot,
                nodeTransport: route.nodeTransport,
            }),
            pinProviderNodeRouteForSession: (session, route) => { session.providerNodeRoute = route; },
            proxyKeyFromUrl: () => 'provider.example/user',
            isFiniteMkvVodSession: () => true,
            fileSizeBytesForSession: (session) => session.fileSizeBytes,
            audioTracksForSession: (session) => session.codecProfile?.audioTracks || [],
            normalizeStrictLidExpectedValidator: (value) => value,
            crypto,
            vodInputPumpStats: {
                validatorEvidence: { strongEtag: 0, lastModified: 0, weakOrAbsent: 0 },
            },
            vodInputPumpError: (code, message, options = {}) => Object.assign(new Error(message), { code, ...options }),
            closePreopenedBoundedMkvInput: async (session) => {
                events.push('preopen-close');
                session.preopenedVodInputAttempt = null;
            },
            waitForVodInputRetry: async () => { events.push('release-wait'); return true; },
            abortedVodInputPumpError: () => Object.assign(new Error('aborted'), { code: 'VOD_INPUT_ABORTED' }),
            asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
            createStrictLidBroker: async (options) => {
                events.push('broker-open');
                brokerOptions = options;
                return broker;
            },
            sanitizeLog: (value) => String(value || ''),
            appendLogTail: () => {},
        },
    );
    const session = {
        sourceUrl: 'https://provider.example/movie/user/pass/title.mkv',
        userAgent: 'Norva/Seek',
        seekOffset: 2062,
        fileSizeBytes: 3_633_791_388,
        codecProfile: { audioTracks: [{ index: 1 }, { index: 2 }] },
        vodInputValidator: { header: 'If-Range', value: '"v1"', kind: 'etag' },
        vodInputEffectiveUrlSha256: 'a'.repeat(64),
        vodInputEffectiveUrlIdentitySha256: 'b'.repeat(64),
        preopenedVodInputAttempt: { attempt: {} },
        startupTimings: { boundedMkvInputPump: true, slotReleaseWaitMs: 0 },
    };

    await harness.prepareFiniteMkvSeekBroker(session, new AbortController().signal);
    assert.deepEqual(events, ['preopen-close', 'release-wait', 'broker-open']);
    assert.equal(session.finiteMkvSeekBroker.inputUrl, broker.inputUrl);
    assert.equal(session.startupTimings.boundedMkvInputPump, false);
    assert.equal(session.startupTimings.finiteMkvSeekBroker, true);
    assert.equal(session.startupTimings.mkvSeekPreopenReleaseWaitMs, 2500);
    assert.equal(brokerOptions.sourceUrl, session.sourceUrl);
    assert.equal(brokerOptions.fileSizeBytes, session.fileSizeBytes);
    assert.deepEqual({ ...brokerOptions.expectedValidator }, session.vodInputValidator);
    assert.equal(brokerOptions.effectiveUrlSha256, session.vodInputEffectiveUrlSha256);
    assert.equal(brokerOptions.effectiveUrlIdentitySha256, session.vodInputEffectiveUrlIdentitySha256);
    assert.equal(brokerOptions.pathPrefix, 'finite-mkv-seek');
    assert.equal(brokerOptions.finiteWindowBytes, 1 * 1024 * 1024);
    assert.equal(brokerOptions.finiteWarmupCueGraceMs, 50);
    assert.equal(brokerOptions.finiteWarmupWindowBytes, 256 * 1024);
    assert.equal(brokerOptions.finiteSequentialWindowBytes, 2 * 1024 * 1024);
    assert.equal(brokerOptions.finiteCacheBytes, 32 * 1024 * 1024);
    assert.equal(session.startupTimings.finiteMkvSeekMultiAudioWindow, true);
    assert.equal(session.startupTimings.finiteMkvSeekWarmupCueGraceMs, 50);
    assert.equal(session.startupTimings.finiteMkvSeekWarmupWindowBytes, 256 * 1024);
    assert.equal(session.startupTimings.finiteMkvSeekSequentialWindowBytes, 2 * 1024 * 1024);
    assert.equal(typeof brokerOptions.dispatcherFactory, 'function');
    assert.equal(typeof brokerOptions.dispatcherFallbackFactory, 'function');
    assert.deepEqual({ ...brokerOptions.dispatcherFactory() }, { slot: 3, nodeTransport: 'http' });
    assert.deepEqual({ ...brokerOptions.dispatcherFallbackFactory() }, { slot: 3, nodeTransport: 'socks5' });
    assert.equal(brokerOptions.dispatcherMaxAgeMs, 4 * 60_000);
    assert.equal(brokerOptions.completedReleaseDelayMs, 0);
    assert.equal(brokerOptions.supersededReleaseDelayMs, 2500);
    assert.equal(typeof brokerOptions.onProviderIdentity, 'function');
    brokerOptions.onProviderIdentity({
        validator: { header: 'If-Range', value: '"v1"', kind: 'etag' },
        effectiveUrlSha256: 'c'.repeat(64),
        effectiveUrlIdentitySha256: 'd'.repeat(64),
    });
    assert.deepEqual({ ...session.vodInputValidator }, {
        header: 'If-Range', value: '"v1"', kind: 'etag',
    });
    assert.deepEqual({ ...session.vodInputStrongValidator }, {
        type: 'etag-sha256',
        digest: crypto.createHash('sha256').update('"v1"').digest('hex'),
    });
    assert.equal(session.vodInputEffectiveUrlSha256, 'c'.repeat(64));
    assert.equal(session.vodInputEffectiveUrlIdentitySha256, 'd'.repeat(64));
    assert.equal(session.startupTimings.finiteMkvSeekProviderIdentityBound, true);
    assert.equal(harness.usesFiniteMkvSeekBroker(session), true);

    await harness.closeFiniteMkvSeekBroker(session);
    assert.equal(session.finiteMkvSeekBroker, null);
    assert.equal(session.startupTimings.finiteMkvSeekProviderFetches, 3);
    assert.equal(session.startupTimings.finiteMkvSeekCompletedProviderFetches, 2);
    assert.equal(session.startupTimings.finiteMkvSeekInterruptedProviderFetches, 1);
    assert.equal(session.startupTimings.finiteMkvSeekCacheHits, 4);
    assert.equal(session.startupTimings.finiteMkvSeekCacheMisses, 5);
    assert.equal(session.startupTimings.finiteMkvSeekProxyAgentRefreshes, 2);
    assert.equal(session.startupTimings.finiteMkvSeekCacheEvictions, 1);
    assert.equal(session.startupTimings.finiteMkvSeekMaxQueuedRequests, 2);
    assert.equal(session.startupTimings.finiteMkvSeekPlannedSupersessions, 2);
    assert.equal(events.at(-1), 'broker-close');
});

test('finite MKV resume spawns FFmpeg against only the loopback URL with pre-input seek', () => {
    const source = readGateway();
    const startSource = sourceBetween(source, 'function startFfmpeg(', '\nfunction seekArgsForSession(').trim();
    const seekSource = sourceBetween(source, 'function seekArgsForSession(', '\nfunction usesSourceTimestampedCopySeek(').trim();
    const isFiniteMkvVodSession = () => true;
    const usesFiniteMkvSeekBroker = (session) => Boolean(session?.finiteMkvSeekBroker?.inputUrl);
    const seekArgsForSession = vm.runInNewContext(`(${seekSource})`, {
        Number,
        isFiniteMkvVodSession,
        usesFiniteMkvSeekBroker,
    });
    let capturedArgs = null;
    let capturedOptions = null;
    const fakeSpawn = (_binary, args, options) => {
        capturedArgs = args;
        capturedOptions = options;
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.stdin.destroy = () => {};
        return child;
    };
    const startFfmpeg = vm.runInNewContext(`(${startSource})`, {
        path,
        Number,
        multiAudioHlsEnabled: () => false,
        exactSubtitleHlsEnabled: () => false,
        inputProbeArgsForSession: () => [],
        shouldCopyAudio: () => false,
        audioArgsForSession: () => ['-c:a', 'aac'],
        audioMapForSession: () => '0:1',
        normalizeAudioStreamIndex: Number,
        videoModeForSession: () => 'encode',
        reserveVideoEncoderAdmission: () => true,
        releaseVideoEncoderAdmission: () => {},
        videoEncoderInputArgs: () => [],
        videoEncoderOutputArgs: () => ['-c:v', 'h264'],
        VIDEO_ENCODER_CONFIG: { backend: 'software' },
        vaapiHardwareDecodeCodecForSession: () => null,
        isFiniteMkvVodSession,
        usesFiniteMkvSeekBroker,
        usesSourceTimestampedCopySeek: () => false,
        seekArgsForSession,
        appendSubtitleOutputs: () => {},
        asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
        spawn: fakeSpawn,
        FFMPEG_PATH: 'ffmpeg',
        proxyEnvFor: () => { throw new Error('provider proxy env must not receive a loopback capability'); },
        proxyKeyFromUrl: () => 'provider.example',
        loopbackOnlyEnv: () => ({ NO_PROXY: '127.0.0.1,localhost,::1' }),
        sanitizeLog: String,
        appendLogTail: () => {},
        applyFiniteMkvSeekBrokerFailure: () => false,
        console: { warn() {}, error() {} },
        lastNonEmptyLine: () => '',
        wakePlaybackBlockedQueues: () => {},
        startBoundedMkvInputPump: () => { throw new Error('seek broker input must not start the byte-zero pipe'); },
        stopChildProcess: async () => {},
        waitForPlaylist: async () => {},
        STARTUP_TIMEOUT_MS: 60_000,
        STRICT_LID_FFMPEG_RW_TIMEOUT_US: 50_000_000,
        EXACT_MATROSKA_H264_HLS_TARGET_SECONDS: 2,
    });
    const session = {
        id: 'seek-2062',
        sourceUrl: 'https://provider.example/movie/user/password/title.mkv',
        finiteMkvSeekBroker: { inputUrl: 'http://127.0.0.1:4567/finite-mkv-seek/private-handle' },
        seekOffset: 2062,
        outputDir: 'C:\\tmp\\seek-2062',
        playlistPath: 'C:\\tmp\\seek-2062\\playlist.m3u8',
        hlsTargetSeconds: 4,
        videoMode: 'encode',
        status: 'starting',
        startupTimings: {},
        logTail: '',
    };

    startFfmpeg(session);
    const inputAt = capturedArgs.indexOf('-i');
    const seekAt = capturedArgs.indexOf('-ss');
    assert.ok(seekAt >= 0 && seekAt < inputAt, 'the temporal seek must be an input seek before -i');
    assert.equal(capturedArgs[seekAt + 1], '2062');
    assert.equal(capturedArgs[inputAt + 1], session.finiteMkvSeekBroker.inputUrl);
    assert.equal(capturedArgs.includes(session.sourceUrl), false, 'FFmpeg must never receive the credential-bearing provider URL');
    assert.equal(capturedArgs.includes('pipe:0'), false);
    assert.equal(capturedArgs[capturedArgs.indexOf('-seekable') + 1], '1');
    assert.equal(capturedArgs[capturedArgs.indexOf('-rw_timeout') + 1], '50000000');
    assert.equal(capturedOptions.stdio[0], 'ignore');
    assert.equal(capturedOptions.env.NO_PROXY, '127.0.0.1,localhost,::1');
});

test('production finite MKV resume uses continuous indexed windows and keeps linear seek only as fallback', () => {
    const source = readGateway();
    const startFfmpeg = sourceBetween(source, 'function startFfmpeg(', '\nfunction seekArgsForSession(');
    assert.match(startFfmpeg, /const seekableMkvInput = usesFiniteMkvSeekBroker\(session\)/);
    assert.match(startFfmpeg, /const pumpedMkvInput = isFiniteMkvVodSession\(session\) && !seekableMkvInput/);
    assert.match(startFfmpeg, /seekableMkvInput \? \[/);
    assert.match(startFfmpeg, /'-seekable', '1'/);
    assert.match(startFfmpeg, /session\.finiteMkvSeekBroker\.inputUrl/);
    assert.match(startFfmpeg, /stdio: \[pumpedMkvInput \? 'pipe' : 'ignore', 'ignore', 'pipe'\]/);
    assert.match(startFfmpeg, /seekableMkvInput[\s\S]+?loopbackOnlyEnv\(\)/);
    assert.match(startFfmpeg, /const pumpWritable = linearSeekBridge \? linearSeekBridge\.child\.stdin : child\.stdin/);
    assert.match(startFfmpeg, /startBoundedMkvInputPump\(session, pumpWritable\)/);
    assert.match(startFfmpeg, /linearSeekBridge\.child\.stdout\.pipe\(child\.stdin\)/);
    assert.match(startFfmpeg, /stopFiniteMkvLinearSeekBridge\(session\)/);

    const seekSource = sourceBetween(source, 'function seekArgsForSession(', '\nfunction usesSourceTimestampedCopySeek(').trim();
    const seekArgsForSession = vm.runInNewContext(`(${seekSource})`, {
        isFiniteMkvVodSession: (session) => String(session?.sourceUrl || '').endsWith('.mkv'),
        usesFiniteMkvSeekBroker: (session) => Boolean(session?.finiteMkvSeekBroker),
    });
    assert.deepEqual(
        JSON.parse(JSON.stringify(seekArgsForSession({
            sourceUrl: 'https://p/title.mkv',
            seekOffset: 120,
            finiteMkvSeekBroker: { inputUrl: 'http://127.0.0.1/private' },
        }, true))),
        { preInputSeek: ['-ss', '120'], postInputSeek: [] },
        'the private seekable input uses Matroska cues instead of decoding from byte zero',
    );
    assert.deepEqual(
        JSON.parse(JSON.stringify(seekArgsForSession({ sourceUrl: 'https://p/title.mkv', seekOffset: 120 }, true))),
        { preInputSeek: [], postInputSeek: ['-ss', '120'] },
        'a missing seek broker fails safe to the legacy linear pipe seek',
    );
    assert.deepEqual(
        JSON.parse(JSON.stringify(seekArgsForSession(
            { sourceUrl: 'https://p/title.mkv', seekOffset: 120 },
            true,
            { fineSeekOffsetSeconds: 30 },
        ))),
        { preInputSeek: [], postInputSeek: ['-ss', '30'] },
        'the packet-copy bridge leaves only a bounded accurate-seek preroll to the encoder',
    );

    const createRoute = sourceBetween(source, "app.post('/sessions'", "\napp.delete('/raw-pumps'");
    assert.match(createRoute, /await prepareFiniteMkvSeekBroker/);
    assert.match(createRoute, /finiteMkvResumeMode = 'continuous-window-indexed-seek'/);
    const ensureAt = createRoute.indexOf('await ensureBoundedMkvInputPump');
    const resumeEnrichAt = createRoute.indexOf('await enrichSessionCodecProfileFromBoundedHeader', ensureAt);
    const prepareAt = createRoute.indexOf('await prepareFiniteMkvSeekBroker', resumeEnrichAt);
    const freezeAt = createRoute.indexOf('freezeMultiAudioHlsTopology(session)', prepareAt);
    assert.ok(
        resumeEnrichAt > ensureAt && resumeEnrichAt < prepareAt,
        'resume metadata must be parsed before opening the indexed seek broker',
    );
    assert.ok(
        resumeEnrichAt < freezeAt,
        'resume audio/subtitle topology must be known before rendition freezing',
    );
    const ensurePump = sourceBetween(
        source,
        'async function ensureBoundedMkvInputPump(',
        '\nfunction parseBoundedProviderContentRange(',
    );
    assert.match(ensurePump, /const resumedSeek = Number\(session\?\.seekOffset \|\| 0\) > 0/);
    assert.match(ensurePump, /drainExactRange:\s*resumedSeek/);

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
    assert.ok(
        stop.indexOf('await closeFiniteMkvSeekBroker(session)') < stop.indexOf('await stopChildProcess(child)'),
        'session handoff must close and await the range broker before releasing the old FFmpeg',
    );
    assert.match(source, /pathPrefix:\s*'finite-mkv-seek'/);
    assert.match(source, /effectiveUrlSha256:\s*session\.vodInputEffectiveUrlSha256/);
    assert.match(source, /effectiveUrlIdentitySha256:\s*session\.vodInputEffectiveUrlIdentitySha256/);
    assert.match(source, /boundedMkvInputPumpProtocol:\s*1/);
    assert.match(source, /finiteMkvSeekBroker:\s*\{[\s\S]+?protocol:\s*9/);
    assert.match(source, /FINITE_MKV_SEEK_WINDOW_BYTES[\s\S]+?8 \* 1024 \* 1024/);
    assert.match(source, /FINITE_MKV_MULTI_AUDIO_SEEK_WINDOW_BYTES[\s\S]+?4 \* 1024 \* 1024/);
    assert.match(source, /FINITE_MKV_SEEK_CACHE_BYTES[\s\S]+?64 \* 1024 \* 1024/);
    assert.match(source, /finiteSequentialWindowBytes:\s*FINITE_MKV_SEEK_WINDOW_BYTES/);
    assert.match(source, /finiteMkvSeekBroker:\s*\{[\s\S]+?sequentialWindowBytes:\s*FINITE_MKV_SEEK_WINDOW_BYTES/);
    assert.match(source, /finiteMkvSeekBroker:\s*\{[\s\S]+?bufferedWindowBeforeLocalResponse:\s*false/);
    assert.match(source, /finiteMkvSeekBroker:\s*\{[\s\S]+?continuousLocalRangeResponse:\s*true/);
    assert.match(source, /finiteMkvSeekBroker:\s*\{[\s\S]+?concurrentLocalRanges:\s*true/);
    assert.match(source, /finiteMkvSeekBroker:\s*\{[\s\S]+?prematureLocalRangeTermination:\s*false/);
    assert.match(source, /finiteMkvSeekBroker:\s*\{[\s\S]+?abandonedRangePreemption:\s*true/);
    assert.match(source, /finiteMkvSeekBroker:\s*\{[\s\S]+?providerWindowQueueSerialized:\s*true/);
    assert.match(source, /finiteMkvSeekBroker:\s*\{[\s\S]+?providerConnectionsSerialized:\s*true/);
    assert.match(source, /finiteMkvSeekBroker:\s*\{[\s\S]+?providerConnectionReuse:\s*true/);
    assert.match(source, /finiteMkvSeekBroker:\s*\{[\s\S]+?identityPreflightRange:[\s\S]+?'bounded-header-prefix'/);
    assert.match(source, /finiteMkvSeekBroker:\s*\{[\s\S]+?identityPreflightMaxBytes:[\s\S]+?INBAND_HEADER_BYTES/);
    assert.match(source, /finiteMkvSeekBroker:\s*\{[\s\S]+?resumeHeaderPrefetch:[\s\S]+?BOUNDED_MKV_HEADER_PARSE/);
});
