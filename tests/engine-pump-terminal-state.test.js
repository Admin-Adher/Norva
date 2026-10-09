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

function makePumpEngine(readResult, { exposeEofConstant = true } = {}) {
    const NorvaEngine = loadEngineClass();
    const reports = [];
    const fatals = [];
    let trailers = 0;
    let drains = 0;
    const engine = new NorvaEngine({}, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    engine.fmtCtx = 1;
    engine.pkt = 2;
    engine.oc = 3;
    engine._bufferedAhead = () => 0;
    engine._drain = () => { drains += 1; };
    engine._commitMuxWrite = () => {};
    engine.lib = {
        EAGAIN: 11,
        ...(exposeEofConstant ? { AVERROR_EOF } : {}),
        ff_read_frame_multi: async () => [readResult, {}],
        av_write_trailer: async () => { trailers += 1; return 0; },
    };
    return {
        engine,
        reports,
        fatals,
        trailerCount: () => trailers,
        drainCount: () => drains,
    };
}

test('a negative non-EOF pump result triggers fatal recovery and never finalises MediaSource', async () => {
    const state = makePumpEngine(-5);
    state.engine._lastReadError = new Error('BLOCK_SHORT_READ:1048576/4194304');

    await state.engine._pump();
    await Promise.resolve();

    assert.strictEqual(state.engine._diag.pumpExitReason, 'readerr');
    assert.strictEqual(state.engine._diag.pumpExitRes, -5);
    assert.match(state.engine._diag.lastReadError, /BLOCK_SHORT_READ/);
    assert.strictEqual(state.engine.ended, false, 'an upstream read failure must not look like a natural media end');
    assert.strictEqual(state.engine._stopRequested, true);
    assert.strictEqual(state.engine._fatalSignaled, true);
    assert.strictEqual(state.trailerCount(), 0, 'a partial stream must not receive a normal MP4 trailer');
    assert.strictEqual(state.drainCount(), 0, 'a partial stream must not drain into endOfStream');
    assert.strictEqual(state.reports.length, 1);
    assert.strictEqual(state.reports[0].stage, 'pump:read');
    assert.match(state.reports[0].message, /ENGINE_READ_FAILED:-5:.*BLOCK_SHORT_READ/);
    assert.strictEqual(state.fatals.length, 1);
    assert.match(state.fatals[0].message, /ENGINE_READ_FAILED:-5/);
});

test('the known FFmpeg EOF remains a clean end when legacy glue omits AVERROR_EOF', async () => {
    const state = makePumpEngine(AVERROR_EOF, { exposeEofConstant: false });

    await state.engine._pump();
    await Promise.resolve();

    assert.strictEqual(state.engine._diag.pumpExitReason, 'eof');
    assert.strictEqual(state.engine.ended, true);
    assert.strictEqual(state.trailerCount(), 1);
    assert.strictEqual(state.drainCount(), 1);
    assert.deepStrictEqual(state.reports, []);
    assert.deepStrictEqual(state.fatals, []);
});

test('EOF commits the final media fragment only after a successful finalisation', async () => {
    const state = makePumpEngine(AVERROR_EOF);
    const committed = [];
    state.engine._commitMuxWrite = (...args) => committed.push(args);
    state.engine.lib.av_write_trailer = async () => {
        state.engine._muxWriteStage.writes.push({ name: 'output', pos: 100, chunk: new Uint8Array([1, 2, 3]) });
        assert.strictEqual(committed.length, 0);
        assert.strictEqual(state.engine.ended, false);
        return 0;
    };
    await state.engine._pump();
    assert.strictEqual(committed.length, 1);
    assert.deepStrictEqual(Array.from(committed[0][2]), [1, 2, 3]);
    assert.strictEqual(state.engine.ended, true);
    const source = fs.readFileSync(path.join(ROOT, 'public/js/norvaEngine.js'), 'utf8');
    assert.match(source, /default_base_moof\+skip_trailer/);
    assert.doesNotMatch(source, /_dropWrites/);
});

for (const failure of ['negative', 'throw', 'missing-result', 'seek', 'stop', 'destroy']) {
    test(`EOF ${failure} drops staged bytes and never reports a clean ending`, async () => {
        const state = makePumpEngine(AVERROR_EOF);
        const committed = [];
        state.engine._commitMuxWrite = (...args) => committed.push(args);
        state.engine.lib.av_write_trailer = async () => {
            state.engine._muxWriteStage.writes.push({ name: 'output', pos: 100, chunk: new Uint8Array([1, 2, 3]) });
            if (failure === 'negative') return -5;
            if (failure === 'throw') throw new Error('final fragment failed');
            if (failure === 'missing-result') return undefined;
            if (failure === 'seek') state.engine._muxGeneration++;
            if (failure === 'stop') state.engine._stopRequested = true;
            if (failure === 'destroy') state.engine.destroyed = true;
            return 0;
        };
        await state.engine._pump();
        await Promise.resolve();
        assert.strictEqual(committed.length, 0);
        assert.strictEqual(state.engine.ended, false);
        assert.strictEqual(state.drainCount(), 0);
        assert.strictEqual(state.engine._muxWriteStage, null);
        assert.strictEqual(state.fatals.length, ['negative', 'throw', 'missing-result'].includes(failure) ? 1 : 0);
    });
}
