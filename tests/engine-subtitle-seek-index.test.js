const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const AVERROR_EOF = -541478725;

function loadEngineClass() {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'norvaEngine.js'), 'utf8');
    const sandbox = {
        window: {},
        document: { createElement: () => ({}) },
        navigator: { userAgent: 'node-test' },
        performance,
        console,
        URL,
        fetch,
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


function uint(id, value) {
    let n = Math.max(1, Math.ceil(Math.log2(value + 1) / 8));
    const bytes = Array.from({ length: n }, (_, i) => Math.floor(value / 256 ** (n - i - 1)) % 256);
    return element(id, bytes);
}
function element(id, bytes) {
    const hex = id.toString(16).padStart(Math.ceil(id.toString(16).length / 2) * 2, '0');
    assert.ok(bytes.length < 127);
    return [...Buffer.from(hex, 'hex'), 0x80 | bytes.length, ...bytes];
}
function point(t, positions) {
    return element(0xbb, [...uint(0xb3, t), ...positions.flatMap(p => element(0xb7,
        [...uint(0xf1, p.off), ...(p.duration === undefined ? [] : uint(0xb2, p.duration))]))]);
}
function makeEngine() {
    const Engine = loadEngineClass();
    const engine = new Engine({}, { inbandSubtitles: true });
    engine.size = 100000;
    engine.vS = { index: 0, time_base_num: 1, time_base_den: 1000 };
    engine._subMeta = new Map([[2, { text: true }]]);
    engine._subCapture = true;
    return engine;
}

test('Matroska durations and multiple track positions preserve the crossing cue before a seek', () => {
    const engine = makeEngine();
    const bytes = Uint8Array.from([
        ...point(88000, [{ off: 100 }]),
        ...point(89000, [{ off: 100, duration: 6000 }, { off: 120, duration: 1000 }]),
        ...point(90000, [{ off: 200 }]),
    ]);
    engine._cueIndex = engine._parseCuePoints(bytes, 500, 1e6);
    assert.strictEqual(engine._cueIndex.length, 4);
    assert.strictEqual(engine._offsetForTime(90), 700);
    assert.strictEqual(engine._subtitleSeekOffset(90), 600);
    assert.strictEqual(engine._subtitleSeekOffset(94.999), 600);
    assert.strictEqual(engine._subtitleSeekOffset(95), null, 'ended cues do not cause rewind');
    assert.strictEqual(engine._subtitleSeekOffset(88.999), null);
    assert.strictEqual(engine._parseCuePoints(bytes.slice(0, -1), 500, 1e6).length, 0, 'truncated indexes are not seek evidence');
});

test('missing duration is unknown and invalid/out-of-file offsets are never used', () => {
    const engine = makeEngine();
    engine._cueIndex = [{ t: 1, off: 100 }, { t: 2, off: 100001, duration: 10 }, { t: 3, off: -1, duration: 10 }];
    assert.strictEqual(engine._subtitleSeekOffset(4), null);
});

test('an indexed crossing cue uses one backward timestamp seek in the existing demuxer', async () => {
    const engine = makeEngine();
    engine.fmtCtx = 7;
    engine._cueIndex = [{ t: 89, off: 1234, duration: 6 }, { t: 90, off: 4321 }];
    const calls = [];
    engine.lib = { AVSEEK_FLAG_BACKWARD: 1, avformat_seek_file_approx: async (...args) => { calls.push(args); return 0; } };
    await engine._seekDemuxer(90);
    assert.deepStrictEqual(calls, [[7, 0, 89000, 0, 1]]);
    assert.strictEqual(engine._diag.subtitleSeekCluster.target, 90);
});

test('a cold resume builds its index once; concurrent requests share the same bounded read', async () => {
    const engine = makeEngine();
    let reads = 0, release;
    engine._readCueIndex = async () => { reads++; await new Promise(r => { release = r; }); engine._cueIndex = [{ t: 89, off: 1234, duration: 6 }]; };
    const a = engine._buildCueIndex(), b = engine._buildCueIndex();
    assert.strictEqual(reads, 1);
    release();
    await Promise.all([a, b]);
    assert.strictEqual(engine._subtitleSeekOffset(90), 1234);
    assert.strictEqual(engine._cueIndexPending, null);
});

test('seeks without a crossing cue retain the ordinary timestamp path and its epoch', async () => {
    const engine = makeEngine();
    engine._ptsEpoch = 5000;
    engine._cueIndex = [{ t: 80, off: 1234, duration: 6 }];
    engine.fmtCtx = 7;
    const calls = [];
    engine.lib = { avformat_seek_file_approx: async (...args) => { calls.push(args); return 0; } };
    await engine._seekDemuxer(90);
    assert.deepStrictEqual(calls, [[7, 0, 95000, 0, 0]]);
    assert.strictEqual(engine._diag.subtitleSeekCluster, undefined);
});

test('background cue discovery never fetches an uncached header or competes with playback', async () => {
    const engine = makeEngine();
    let requests = 0;
    engine._readRange = async () => { requests++; throw Error('unexpected network'); };
    await engine._buildCueIndex(true);
    assert.strictEqual(requests, 0);
    assert.strictEqual(engine._cueIndex, null);
});

test('a requested seek waits for cache-only discovery, then performs one shared on-demand read', async () => {
    const engine = makeEngine();
    const modes = []; let release;
    engine._readCueIndex = async cacheOnly => {
        modes.push(cacheOnly);
        if (cacheOnly) await new Promise(r => { release = r; });
        else { await new Promise(r => setTimeout(r, 5)); engine._cueIndex = [{ t: 89, off: 100, duration: 6 }]; }
    };
    const background = engine._buildCueIndex(true);
    const seek = engine._buildCueIndex();
    const second = engine._buildCueIndex();
    release(); await Promise.all([background, seek, second]);
    assert.deepStrictEqual(modes, [true, false]);
    assert.strictEqual(engine._subtitleSeekOffset(90), 100);
});

function indexedHead() {
    const info = element(0x1549a966, uint(0x2ad7b1, 1000000));
    const seek = element(0x114d9b74, element(0x4dbb,
        [...element(0x53ab, [0x1c, 0x53, 0xbb, 0x6b]), ...uint(0x53ac, 128)]));
    // EBML + an unknown-sized Segment; Info and SeekHead are complete.
    return Uint8Array.from([...element(0x1a45dfa3, []), 0x18, 0x53, 0x80, 0x67, 0xff, ...info, ...seek]);
}

test('retained cue header survives read-ahead eviction and avoids another source-head request', async () => {
    const engine = makeEngine(); engine._progressiveRanges = true; engine.url = 'https://invalid.test/current';
    const head = indexedHead(); engine._raCache = [{ start: 0, end: head.length, buf: head }];
    engine._rememberCueHeader(); assert.ok(engine._cueHeader);
    const saved = engine._cueHeader, points = point(89000, [{ off: 100, duration: 6000 }]);
    const cue = Uint8Array.from(element(0x1c53bb6b, points));
    engine._raCache = []; const requests = [];
    engine._readRange = async (pos, len) => { requests.push(pos); assert.ok(pos >= saved.cuesPos); return cue.subarray(pos - saved.cuesPos, pos - saved.cuesPos + len); };
    await engine._readCueIndex();
    assert.equal(engine.timings.cueHeaderReused, true);
    assert.equal(engine._subtitleSeekOffset(90), saved.segStart + 100);
    assert.equal(requests.includes(0), false);
});

test('incomplete Info or SeekHead never becomes a reusable cue-header hint', () => {
    const engine = makeEngine(); engine._progressiveRanges = true;
    const head = indexedHead();
    for (const candidate of [head.subarray(0, 15), head.subarray(0, head.length - 1)]) {
        engine._raCache = [{ start: 0, end: candidate.length, buf: candidate }];
        engine._rememberCueHeader(); assert.equal(engine._cueHeader, null);
    }
});

test('a hint for a different URL or size falls back to the ordinary current-source read', async () => {
    for (const delta of [{ source: 'old' }, { size: 2 }]) {
        const engine = makeEngine(); engine._progressiveRanges = true; engine.url = 'current';
        engine._cueHeader = { segStart: 10, scaleNs: 1e6, cuesPos: 100, size: engine.size, source: engine.url, ...delta };
        const positions = []; engine._readRange = async pos => { positions.push(pos); throw Error('bounded fixture stop'); };
        await engine._readCueIndex(); assert.deepEqual(positions, [0]);
        assert.equal(engine.timings.cueHeaderReused, undefined);
    }
});

test('cue elements delivered in short positive slices are assembled before parsing', async () => {
    const engine = makeEngine(); engine._progressiveRanges = true; engine.url = 'current';
    const points = point(89000, [{ off: 100, duration: 6000 }]), cue = Uint8Array.from(element(0x1c53bb6b, points));
    engine._cueHeader = { segStart: 10, scaleNs: 1e6, cuesPos: 1000, size: engine.size, source: engine.url };
    let reads = 0;
    engine._readRange = async (pos, len) => { reads++; return cue.subarray(pos - 1000, pos - 1000 + Math.min(7, len)); };
    await engine._readCueIndex(); assert.ok(reads > 2);
    assert.equal(engine._subtitleSeekOffset(90), 110);
});
