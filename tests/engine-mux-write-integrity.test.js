// Transactional mux writes. The generated libav helper checks each packet write
// inside its worker (one RPC per batch), while NorvaEngine withholds all onwrite
// chunks until that batch succeeds. A partial moof from a rejected batch must
// never reach MediaSource.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

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

function makeEngine(NorvaEngine) {
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({}, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    engine.pkt = 101;
    engine.oc = 202;
    engine.destroyed = false;
    engine._stopRequested = false;
    engine._fatalSignaled = false;
    engine._muxGeneration = 7;
    engine._muxWriteStage = null;
    return { engine, reports, fatals };
}

test('every generated wasm helper checks packet-write errors inside the worker', () => {
    const dir = path.join(ROOT, 'public', 'webengine', 'vendor', 'libav');
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.wasm.mjs'));
    assert.ok(files.length >= 2, 'expected the vendored norva and webcodecs wasm glue');
    for (const name of files) {
        const src = fs.readFileSync(path.join(dir, name), 'utf8');
        assert.ok(src.includes('var __norvaMuxWriteRet=step(oc,pkt);'),
            `${name} must retain the packet write result`);
        assert.ok(src.includes('throw new Error("MUX_PACKET_WRITE_FAILED:"'),
            `${name} must surface a typed worker error`);
        assert.ok(!src.includes('step(oc,pkt);av_packet_unref(pkt)'),
            `${name} must not contain the unchecked generated helper`);
    }

    const patcher = fs.readFileSync(path.join(ROOT, 'scripts', 'patch-libav-logs.js'), 'utf8');
    assert.ok(patcher.includes("const MUX_MARKER = 'MUX_PACKET_WRITE_FAILED:'"),
        'the build-time patch must be independently idempotent');
    assert.ok(patcher.includes('src.includes(MUX_MARKER)'),
        'the build-time patch must detect an already-patched helper');
});

test('engine cache-busts the loader, worker glue, and wasm binary together', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'norvaEngine.js'), 'utf8');
    assert.ok(src.includes("libav-norva.mjs?v=40"),
        'dynamic loader import must be revisioned');
    assert.ok(src.includes("libav-6.8.8.0-norva.wasm.mjs?v=40"),
        'worker glue import must be revisioned');
    assert.ok(src.includes("libav-6.8.8.0-norva.wasm.wasm?v=40"),
        'wasm binary fetch must be revisioned');
    assert.ok(src.includes('toImport: LIBAV_RUNTIME'));
    assert.ok(src.includes('wasmurl: LIBAV_WASM'));
});

test('a successful batch uses one worker RPC and commits staged bytes only afterwards', async () => {
    const NorvaEngine = loadEngineClass();
    const { engine, reports, fatals } = makeEngine(NorvaEngine);
    const events = [];
    const committed = [];
    let batchCalls = 0;
    engine._commitMuxWrite = (name, pos, chunk) => {
        events.push('commit');
        committed.push({ name, pos, bytes: Array.from(chunk) });
    };
    engine.lib = {
        ff_write_multi: async (oc, pkt, packets) => {
            batchCalls += 1;
            events.push('worker');
            assert.strictEqual(oc, 202);
            assert.strictEqual(pkt, 101);
            assert.strictEqual(packets.length, 2);
            assert.deepStrictEqual(committed, [], 'bytes must remain private while the worker call is pending');
            engine._muxWriteStage.writes.push({
                name: 'output',
                pos: 0,
                chunk: new Uint8Array([0, 0, 0, 8, 109, 111, 111, 102]),
            });
        },
    };

    const packets = [
        { data: new Uint8Array([1]), stream_index: 0, time_base_num: 1, time_base_den: 1000 },
        { data: new Uint8Array([2]), stream_index: 1, time_base_num: 1, time_base_den: 48000 },
    ];
    assert.strictEqual(await engine._writePacketsChecked(packets), true);
    assert.strictEqual(batchCalls, 1, 'the whole batch must stay one worker RPC');
    assert.deepStrictEqual(events, ['worker', 'commit']);
    assert.strictEqual(committed.length, 1);
    assert.deepStrictEqual(reports, []);
    assert.deepStrictEqual(fatals, []);
});

test('a rejected batch drops every partial chunk and signals fatal recovery', async () => {
    const NorvaEngine = loadEngineClass();
    const { engine, reports, fatals } = makeEngine(NorvaEngine);
    const committed = [];
    engine._commitMuxWrite = (...args) => committed.push(args);
    engine.lib = {
        ff_write_multi: async () => {
            engine._muxWriteStage.writes.push({
                name: 'output',
                pos: 123,
                chunk: new Uint8Array([0, 0, 0, 16, 109, 111, 111, 102]),
            });
            engine._muxWriteStage.writes.push({
                name: 'output',
                pos: 131,
                chunk: new Uint8Array([1, 2, 3, 4]),
            });
            throw new Error('MUX_PACKET_WRITE_FAILED:-29:Illegal seek');
        },
    };

    const ok = await engine._writePacketsChecked([
        { data: new Uint8Array([7]), stream_index: 1 },
    ]);
    await Promise.resolve();

    assert.strictEqual(ok, false);
    assert.deepStrictEqual(committed, [], 'partial moof bytes must never be committed to appendBuffer');
    assert.strictEqual(engine._stopRequested, true);
    assert.strictEqual(engine._fatalSignaled, true);
    assert.strictEqual(engine._muxWriteStage, null);
    assert.strictEqual(engine._diag.muxPacketWriteErrors, 1);
    assert.strictEqual(engine._diag.muxRejectedBytes, 12);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(engine._diag.firstMuxPacketWriteError)),
        {
            ret: -29,
            batchPackets: 1,
            streamIndexes: [1],
            stagedChunks: 2,
            stagedBytes: 12,
            stagedBoxes: ['moof(16)', ''],
            detail: 'Illegal seek',
        });
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'mux:packet-write');
    assert.match(reports[0].message, /MUX_PACKET_WRITE_FAILED:-29:Illegal seek/);
    assert.strictEqual(fatals.length, 1);
    assert.match(fatals[0].message, /MUX_PACKET_WRITE_FAILED:-29/);
});

test('a batch resolved after a seek generation change is dropped without replacing the new mux', async () => {
    const NorvaEngine = loadEngineClass();
    const { engine, reports, fatals } = makeEngine(NorvaEngine);
    const committed = [];
    engine._commitMuxWrite = (...args) => committed.push(args);
    engine.lib = {
        ff_write_multi: async () => {
            engine._muxWriteStage.writes.push({
                name: 'output',
                pos: 0,
                chunk: new Uint8Array([0, 0, 0, 8, 109, 111, 111, 102]),
            });
            engine._muxGeneration += 1; // a newer seek/mux won while this RPC was pending
        },
    };

    const ok = await engine._writePacketsChecked([
        { data: new Uint8Array([1]), stream_index: 0 },
    ]);
    assert.strictEqual(ok, false);
    assert.deepStrictEqual(committed, []);
    assert.strictEqual(engine._diag.staleMuxBytesDropped, 8);
    assert.strictEqual(engine._diag.firstStaleMuxDrop.reason, 'stale-success');
    assert.deepStrictEqual(reports, [], 'an intentionally obsolete mux must not trigger recovery');
    assert.deepStrictEqual(fatals, []);
});
