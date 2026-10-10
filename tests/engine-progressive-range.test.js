const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const K = 1024, SIZE = 8 * 1024 * K;
const bytes = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i += 4) bytes.writeUInt32LE(i, i);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function engine(url, impl = fetch) {
  const context = { window: {}, navigator: {}, performance, console, URL, fetch: impl, AbortController,
    setTimeout, clearTimeout, queueMicrotask, TextDecoder, crypto };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/norvaEngine.js'), 'utf8'), context);
  const failures = [];
  const e = new context.window.NorvaEngine({ currentTime: 0 }, { progressiveRanges: true, onFatal: x => failures.push(x.message) });
  e.url = url; e.size = SIZE; e.failures = failures;
  return e;
}
async function server(handle) {
  const s = http.createServer(async (q, r) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(q.headers.range || '');
    if (!m) return r.writeHead(400).end();
    try { await handle(q, r, +m[1], +m[2]); } catch { r.destroy(); }
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}/source`, close: () => { s.closeAllConnections(); s.close(); } };
}
function headers(r, a, b, extra = {}) {
  r.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${SIZE}`, ...extra });
  r.flushHeaders();
}

test('returns exact contiguous bytes before response EOF; only the complete response enters cache', async () => {
  const finish = deferred(); let calls = 0;
  const s = await server(async (q, r, a, b) => {
    calls++; headers(r, a, b); r.write(bytes.subarray(a, a + 64 * K));
    await finish.promise; r.end(bytes.subarray(a + 64 * K, b + 1));
  });
  const e = engine(s.url);
  try {
    const first = await e._readRange(1024, 1024 * K);
    assert.equal(first.length, 64 * K);
    assert.deepEqual(Buffer.from(first), bytes.subarray(1024, 1024 + first.length));
    assert.equal(e._raCache.length, 0);
    const done = e._liveRange.done;
    finish.resolve(); await done;
    assert.equal(e._raCache.length, 1);
    assert.equal(e._raCache[0].buf.length, 4 * 1024 * K);
    const second = await e._readRange(1024 + first.length, 64 * K);
    assert.deepEqual(Buffer.from(second), bytes.subarray(1024 + first.length, 1024 + first.length + second.length));
    assert.equal(calls, 1);
  } finally { finish.resolve(); e.destroy(); s.close(); }
});

test('overlapping reads use the same response and a disjoint prefetch waits for its completion', async () => {
  const finish = deferred(); let calls = 0, active = 0, maximum = 0;
  const s = await server(async (q, r, a, b) => {
    calls++; maximum = Math.max(maximum, ++active);
    headers(r, a, b);
    if (a === 0) { r.write(bytes.subarray(0, 128 * K)); await finish.promise; r.end(bytes.subarray(128 * K, b + 1)); }
    else r.end(bytes.subarray(a, b + 1));
    active--;
  });
  const e = engine(s.url);
  try {
    const [a, b] = await Promise.all([e._readRange(0, 64 * K), e._readRange(64 * K, 64 * K)]);
    assert.deepEqual(Buffer.from(a), bytes.subarray(0, 64 * K));
    assert.deepEqual(Buffer.from(b), bytes.subarray(64 * K, 128 * K));
    const prefetch = e._cacheWindow(5 * 1024 * K, 64 * K);
    await new Promise(r => setTimeout(r, 20)); assert.equal(calls, 1);
    finish.resolve(); await prefetch;
    assert.equal(calls, 2); assert.equal(maximum, 1);
  } finally { finish.resolve(); e.destroy(); s.close(); }
});

test('a disjoint demux seek waits for the active transport then reads its exact offset', async () => {
  const finish = deferred(); let calls = 0;
  const s = await server(async (q, r, a, b) => {
    calls++; headers(r, a, b);
    if (a === 0) { r.write(bytes.subarray(0, 64 * K)); await finish.promise; r.end(bytes.subarray(64 * K, b + 1)); }
    else r.end(bytes.subarray(a, b + 1));
  });
  const e = engine(s.url);
  try {
    await e._readRange(0, 64 * K);
    const seek = e._readRange(5 * 1024 * K, 64 * K);
    await new Promise(r => setTimeout(r, 20)); assert.equal(calls, 1);
    finish.resolve(); const result = await seek;
    assert.deepEqual(Buffer.from(result), bytes.subarray(5 * 1024 * K, 5 * 1024 * K + result.length));
    await e._liveRange?.done;
    assert.equal(calls, 2);
  } finally { finish.resolve(); e.destroy(); s.close(); }
});

test('truncation after delivery stops the mux generation once; no retry or cache publication', async () => {
  const finish = deferred(); let calls = 0;
  const s = await server(async (q, r, a, b) => {
    calls++; headers(r, a, b); r.write(bytes.subarray(a, a + 64 * K)); await finish.promise; r.end();
  });
  const e = engine(s.url);
  try {
    await e._readRange(0, 64 * K);
    const done = e._liveRange.done;
    const next = e._readRange(64 * K, 64 * K);
    const rejected = assert.rejects(next, /BLOCK_SHORT_READ/);
    finish.resolve(); await assert.rejects(done, /BLOCK_SHORT_READ/); await rejected;
    await new Promise(r => setImmediate(r));
    assert.equal(e._raCache.length, 0); assert.equal(calls, 1);
    assert.equal(e.failures.length, 1); assert.match(e.failures[0], /ENGINE_READ_FAILED:progressive/);
    assert.equal(e._stopRequested, true);
    await assert.rejects(e._readRange(0, 64 * K), /ENGINE_READ_ABORTED|BLOCK_SHORT_READ/);
  } finally { finish.resolve(); e.destroy(); s.close(); }
});

test('destroy cancels both active and queued work without reporting an operator abort as media corruption', async () => {
  const finish = deferred(); let calls = 0;
  const s = await server(async (q, r, a, b) => {
    calls++; headers(r, a, b); r.write(bytes.subarray(a, a + 64 * K)); await finish.promise; r.end(bytes.subarray(a + 64 * K, b + 1));
  });
  const e = engine(s.url);
  try {
    await e._readRange(0, 64 * K);
    const done = e._liveRange.done;
    const next = e._readRange(64 * K, 64 * K), queued = e._cacheWindow(5 * 1024 * K, 64 * K);
    const checks = [done, next, queued].map(p => assert.rejects(p));
    e.destroy(); await Promise.all(checks);
    assert.equal(calls, 1); assert.equal(e._raCache.length, 0); assert.equal(e.failures.length, 0);
  } finally { finish.resolve(); e.destroy(); s.close(); }
});

test('the true final range is consumed once, without reading past EOF', async () => {
  let calls = 0;
  const s = await server(async (q, r, a, b) => { calls++; headers(r, a, b); r.end(bytes.subarray(a, b + 1)); });
  const e = engine(s.url);
  try {
    const result = await e._readRange(SIZE - 1234, 1234);
    assert.deepEqual(Buffer.from(result), bytes.subarray(SIZE - 1234));
    await e._liveRange?.done; assert.equal(calls, 1);
  } finally { e.destroy(); s.close(); }
});

for (const [label, declaration, pattern] of [
  ['wrong start', `bytes 1-${4 * 1024 * K}/${SIZE}`, /BLOCK_RANGE_MISMATCH/],
  ['unknown total', `bytes 0-${4 * 1024 * K - 1}/*`, /BLOCK_RANGE_MISMATCH/],
  ['changed size', `bytes 0-${4 * 1024 * K - 1}/${SIZE + 1}`, /BLOCK_RANGE_MISMATCH/],
  ['short declaration', `bytes 0-1000/${SIZE}`, /BLOCK_SHORT_READ/],
  ['malformed', 'nonsense', /BLOCK_RANGE_MISMATCH/],
]) test(`rejects ${label} before exposing bytes`, async () => {
  let calls = 0, bodyReads = 0;
  const e = engine('https://invalid.test', async () => {
    calls++;
    return { status: 206, headers: { get: n => n === 'content-range' ? declaration : null }, body: { getReader() { bodyReads++; throw Error('Must not read'); } } };
  });
  e._waitForRangeRetry = async () => {};
  try {
    await assert.rejects(e._readRange(0, 64 * K), pattern);
    assert.equal(bodyReads, 0); assert.equal(e._raCache.length, 0); assert.equal(calls, 3);
  } finally { e.destroy(); }
});

for (const status of [401, 403, 458]) test(`HTTP ${status} stays terminal for all queued reads`, async () => {
  let calls = 0;
  const e = engine('https://invalid.test', async () => { calls++; return { status, headers: { get: () => null } }; });
  try {
    const a = e._readRange(0, 64 * K), b = e._cacheWindow(5 * 1024 * K, 64 * K);
    await Promise.all([a, b].map(p => assert.rejects(p, new RegExp(`BLOCK_HTTP_${status}`))));
    assert.equal(calls, 1); assert.equal(e._raCache.length, 0);
  } finally { e.destroy(); }
});

test('without a streaming body reader the exact complete body is used', async () => {
  const e = engine('https://invalid.test', async () => ({ status: 206,
    headers: { get: n => n === 'content-range' ? `bytes 0-${4 * 1024 * K - 1}/${SIZE}` : null }, arrayBuffer: async () => bytes.subarray(0, 4 * 1024 * K) }));
  try {
    const result = await e._readRange(0, 64 * K);
    assert.deepEqual(Buffer.from(result), bytes.subarray(0, 64 * K));
    await e._liveRange?.done;
    assert.equal(e._raCache.length, 1); assert.equal(e.timings.progressiveReads || 0, 0);
  } finally { e.destroy(); }
});

test('contradictory Content-Length is rejected before reading the body', async () => {
  let reads = 0;
  const e = engine('https://invalid.test', async () => ({ status: 206,
    headers: { get: n => n === 'content-range' ? `bytes 0-${4 * 1024 * K - 1}/${SIZE}` : '1000' },
    body: { getReader() { reads++; throw Error('Must not read'); } } }));
  e._waitForRangeRetry = async () => {};
  try { await assert.rejects(e._readRange(0, 64 * K), /BLOCK_RANGE_MISMATCH:content-length/); assert.equal(reads, 0); }
  finally { e.destroy(); }
});

test('a streaming body larger than its declared range stops after the first consumed slice', async () => {
  const finish = deferred(); let calls = 0;
  const s = await server(async (q, r, a, b) => {
    calls++; headers(r, a, b); r.write(bytes.subarray(a, a + 64 * K)); await finish.promise;
    r.end(bytes.subarray(a + 64 * K, b + 2));
  });
  const e = engine(s.url);
  try {
    await e._readRange(0, 64 * K); const done = e._liveRange.done;
    finish.resolve(); await assert.rejects(done, /body-overrun/);
    assert.equal(calls, 1); assert.equal(e._raCache.length, 0);
  } finally { finish.resolve(); e.destroy(); s.close(); }
});

test('a startup response that is still draining uses the normal request cap after a usable append', async () => {
  const finish = deferred();
  const s = await server(async (q, r, a, b) => {
    headers(r, a, b); r.write(bytes.subarray(a, a + 64 * K)); await finish.promise; r.end(bytes.subarray(a + 64 * K, b + 1));
  });
  const e = engine(s.url);
  e._startupActive = true; e._startupDeadlineAt = performance.now() + 200;
  try {
    await e._readRange(0, 64 * K); const done = e._liveRange.done;
    // Simulate the already tested SourceBuffer updateend verdict. No usable
    // append means _startupActive remains true and the old watchdog still fires.
    e._startupActive = false; e._startupDeadlineAt = 0;
    await new Promise(r => setTimeout(r, 230)); finish.resolve(); await done;
    assert.equal(e._raCache.length, 1); assert.equal(e.failures.length, 0);
  } finally { finish.resolve(); e.destroy(); s.close(); }
});
