// Range-read integrity of the browser engine (norvaEngine.js) — the 2026-07-04 incident.
// A provider reset mid-range can end the socket "cleanly": the fetch resolves with a body
// SHORTER than the requested range. Accepting it poisons the read-ahead cache, libav demuxes
// around a hole and the muxer emits garbage ("bad box" → CHUNK_DEMUXER_ERROR_APPEND → lane
// failover loop). These tests run the REAL class in Node (22+ has fetch/AbortController)
// against a local HTTP server that can serve full, truncated or flaky ranges.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILE_SIZE = 4 * 1024 * 1024;
const FILE = Buffer.alloc(FILE_SIZE);
for (let i = 0; i < FILE_SIZE; i += 4) FILE.writeUInt32LE(i, i); // position-stamped content

function loadEngineClass() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'norvaEngine.js'), 'utf8');
    const sandbox = {
        window: {}, document: { createElement: () => ({}) }, navigator: { userAgent: 'node-test' },
        performance, console, URL, fetch, AbortController, setTimeout, clearTimeout, TextDecoder, crypto,
    };
    sandbox.self = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'norvaEngine.js' });
    assert.ok(sandbox.window.NorvaEngine, 'NorvaEngine class must load in a bare sandbox');
    return sandbox.window.NorvaEngine;
}

// Bare instance: enough internal state for _readRange/_cacheWindow/_fetchRange without
// touching wasm/MSE (Object.create skips the constructor's DOM wiring).
function bareEngine(NorvaEngine, url) {
    const eng = Object.create(NorvaEngine.prototype);
    eng.url = url;
    eng.size = FILE_SIZE;
    eng._raCache = [];
    eng._smallNextRead = false;
    eng._ac = new AbortController();
    eng._fetchCount = 0; eng._fetchBytes = 0; eng._fetchMs = 0;
    return eng;
}

function startRangeServer(behavior) {
    const srv = http.createServer((req, res) => {
        const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
        if (!m) { res.writeHead(400); res.end(); return; }
        const start = Number(m[1]); const end = Math.min(Number(m[2]), FILE_SIZE - 1);
        const mode = behavior(start, end);
        if (mode.status && mode.status !== 206) { res.writeHead(mode.status); res.end(); return; }
        const full = FILE.subarray(start, end + 1);
        const body = mode.truncateTo ? full.subarray(0, mode.truncateTo) : full;
        // No Content-Length: a truncated body ends "cleanly" (the incident shape — nothing
        // for the client to length-check at the transport level).
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${FILE_SIZE}`, 'Accept-Ranges': 'bytes' });
        res.end(body);
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

test('a clean-but-truncated range is rejected, retried, and never poisons the cache', async () => {
    let calls = 0;
    const srv = await startRangeServer(() => {
        calls += 1;
        return calls === 1 ? { truncateTo: 1000 } : {}; // first attempt cut short, then healthy
    });
    try {
        const NorvaEngine = loadEngineClass();
        const eng = bareEngine(NorvaEngine, `http://127.0.0.1:${srv.address().port}/f.mkv`);
        const out = await eng._readRange(0, 64 * 1024);
        assert.strictEqual(out.length, 64 * 1024, 'the requested slice must come back complete');
        assert.strictEqual(out[4], 4 & 0xff, 'bytes must be the real file content');
        assert.ok(calls >= 2, 'the truncated first attempt must have been retried');
        for (const w of eng._raCache) {
            assert.strictEqual(w.end - w.start, w.buf.length, 'cache windows must be self-consistent');
            assert.ok(w.buf.length > 1000, 'the poisoned short window must not be cached');
        }
    } finally { srv.close(); }
});

test('a short read at the true end of file is legal (no retry storm)', async () => {
    let calls = 0;
    const srv = await startRangeServer(() => { calls += 1; return {}; });
    try {
        const NorvaEngine = loadEngineClass();
        const eng = bareEngine(NorvaEngine, `http://127.0.0.1:${srv.address().port}/f.mkv`);
        const tail = 1234;
        const out = await eng._readRange(FILE_SIZE - tail, tail);
        assert.strictEqual(out.length, tail);
        assert.strictEqual(calls, 1, 'EOF-bounded reads must not retry');
    } finally { srv.close(); }
});

test('persistent truncation surfaces BLOCK_SHORT_READ after bounded retries', async () => {
    let calls = 0;
    const srv = await startRangeServer(() => { calls += 1; return { truncateTo: 512 }; });
    try {
        const NorvaEngine = loadEngineClass();
        const eng = bareEngine(NorvaEngine, `http://127.0.0.1:${srv.address().port}/f.mkv`);
        await assert.rejects(() => eng._readRange(0, 64 * 1024), /BLOCK_SHORT_READ/);
        assert.strictEqual(calls, 3, 'exactly the bounded retry count, then surface');
    } finally { srv.close(); }
});

test('transient provider 458 recovers within the window retry ladder', async () => {
    let calls = 0;
    const srv = await startRangeServer(() => {
        calls += 1;
        return calls === 1 ? { status: 458 } : {};
    });
    try {
        const NorvaEngine = loadEngineClass();
        const eng = bareEngine(NorvaEngine, `http://127.0.0.1:${srv.address().port}/f.mkv`);
        const out = await eng._readRange(1024, 4096);
        assert.strictEqual(out.length, 4096);
        assert.strictEqual(calls, 2, 'one 458 then success');
    } finally { srv.close(); }
});

test('auth errors surface immediately (no retry that hammers a banning panel)', async () => {
    let calls = 0;
    const srv = await startRangeServer(() => { calls += 1; return { status: 403 }; });
    try {
        const NorvaEngine = loadEngineClass();
        const eng = bareEngine(NorvaEngine, `http://127.0.0.1:${srv.address().port}/f.mkv`);
        await assert.rejects(() => eng._readRange(0, 4096), /BLOCK_HTTP_403/);
        assert.strictEqual(calls, 1, '403 must not be retried');
    } finally { srv.close(); }
});
