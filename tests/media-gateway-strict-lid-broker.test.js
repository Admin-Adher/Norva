'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const gatewayPath = path.join(root, 'services/media-gateway/src/index.js');
const gatewaySource = fs.readFileSync(gatewayPath, 'utf8');

function brokerHarness() {
  const startMarker = '// ── Strict LID loopback broker (mono-account provider barrier)';
  const endMarker = '// ── End strict LID loopback broker';
  const start = gatewaySource.indexOf(startMarker);
  const end = gatewaySource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'strict LID broker source block must remain extractable');
  const source = gatewaySource.slice(start, end);
  return vm.runInNewContext(
    `(() => { ${source}; return { parseStrictLidRange, createStrictLidBroker, createStrictLidRangeDeadline }; })()`,
    {
      AbortController,
      Buffer,
      Date,
      Error,
      FFMPEG_USER_AGENT: 'Norva-LID-Test/1',
      Number,
      Object,
      Promise,
      PROVIDER_SLOT_RELEASE_DELAY_MS: 0,
      STRICT_LID_BROKER_FIRST_BYTE_TIMEOUT_MS: 30_000,
      STRICT_LID_BROKER_IDLE_TIMEOUT_MS: 15_000,
      Readable: require('node:stream').Readable,
      String,
      URL,
      clearTimeout,
      console,
      crypto: require('node:crypto'),
      fetch,
      http,
      isHttpUrl(value) {
        try {
          const parsed = new URL(value);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch (_) {
          return false;
        }
      },
      isProxyAuthenticationFailure(error) {
        return /proxy_auth_failed|proxy[^\n]{0,120}(?:authentication required|response[^\n]{0,40}\b407\b)/i.test(
          String(error?.code || '') + '\n' + String(error?.message || ''),
        );
      },
      pickProxyAgent: () => null,
      proxyKeyFromUrl: () => 'provider:test',
      setTimeout,
      undiciRequest: require('undici').request,
    },
  );
}

class FakeClock {
  constructor() {
    this.now = 0;
    this.timers = new Map();
  }

  setTimeout = (callback, delay) => {
    const handle = { unref() {} };
    this.timers.set(handle, {
      at: this.now + Math.max(0, Number(delay) || 0),
      callback,
    });
    return handle;
  };

  clearTimeout = (handle) => {
    this.timers.delete(handle);
  };

  advance(ms) {
    const target = this.now + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.now = target;
  }
}

function audioExtractionHarness(spawnImpl, timers = {}) {
  const start = gatewaySource.indexOf('function extractAudioWav(');
  const end = gatewaySource.indexOf('// V2 chunked pipeline', start);
  assert.ok(start >= 0 && end > start, 'audio extraction source must remain dynamically extractable');
  return vm.runInNewContext(
    `(() => { ${gatewaySource.slice(start, end)}; return extractAudioWav; })()`,
    {
      ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION: 'language-validation',
      FFMPEG_PATH: 'ffmpeg-test',
      STRICT_LID_FFMPEG_RW_TIMEOUT_US: 50_000_000,
      clearTimeout: timers.clearTimeout || clearTimeout,
      console: { warn() {} },
      crypto: require('node:crypto'),
      fsp: {
        async stat() { return { size: 0 }; },
        async unlink() {},
      },
      isHttpUrl: () => true,
      loopbackOnlyEnv: () => ({}),
      os: require('node:os'),
      path,
      proxyEnvFor: () => ({}),
      proxyKeyFromUrl: () => 'provider:test',
      redactCreds: (value) => String(value),
      redactStrictLidLoopback: (value) => String(value),
      registerAccountExtraction: () => ({ preempted: false, release() {} }),
      setTimeout: timers.setTimeout || setTimeout,
      spawn: spawnImpl,
      viewerPlaybackActiveLocally: () => false,
    },
  );
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}/movie/account/secret/file.mkv`;
}

async function closeServer(server) {
  await new Promise((resolve) => {
    try { server.close(resolve); } catch (_) { resolve(); }
    try { server.closeAllConnections?.(); } catch (_) {}
  });
}

function exactRange(req, size) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ''));
  assert.ok(match, `provider received a non-exact range: ${String(req.headers.range || '')}`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end));
  assert.ok(start >= 0 && end >= start && end < size);
  return { start, end };
}

function sendExactRange(req, res, data, options = {}) {
  const { start, end } = exactRange(req, data.length);
  const body = data.subarray(start, end + 1);
  res.statusCode = options.status || 206;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Range', options.contentRange || `bytes ${start}-${end}/${data.length}`);
  if (options.contentLength !== false) {
    res.setHeader('Content-Length', String(options.contentLength ?? body.length));
  }
  if (options.contentEncoding) res.setHeader('Content-Encoding', options.contentEncoding);
  if (options.etag !== false) res.setHeader('ETag', options.etag || '"fixture-v1"');
  res.end(options.body || body);
}

test('strict LID range parser converts only one bounded range into exact safe offsets', () => {
  const { parseStrictLidRange } = brokerHarness();
  assert.deepEqual({ ...parseStrictLidRange('bytes=5-', 20) }, { start: 5, end: 19, total: 20 });
  assert.deepEqual({ ...parseStrictLidRange('bytes=5-99', 20) }, { start: 5, end: 19, total: 20 });
  assert.deepEqual({ ...parseStrictLidRange('bytes=-4', 20) }, { start: 16, end: 19, total: 20 });
  for (const invalid of ['', 'bytes=-0', 'bytes=20-', 'bytes=9-2', 'bytes=0-1,4-5', 'items=0-1']) {
    assert.equal(parseStrictLidRange(invalid, 20), null, invalid);
  }
});

test('strict LID range deadline times out before the first byte with a fake clock', () => {
  const { createStrictLidRangeDeadline } = brokerHarness();
  const clock = new FakeClock();
  const controller = new AbortController();
  const deadline = createStrictLidRangeDeadline({
    controller,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
  });

  clock.advance(29_999);
  assert.equal(controller.signal.aborted, false);
  clock.advance(1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(deadline.timedOut, true);
  assert.equal(deadline.timeoutKind, 'first-byte');
  assert.equal(clock.timers.size, 0);
});

test('strict LID broker maps the fake first-byte deadline to a closed 504', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const clock = new FakeClock();
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: 100,
    dispatcher: null,
    releaseDelayMs: 0,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    fetchImpl: async (_url, options) => {
      markFetchStarted();
      return new Promise((_resolve, reject) => {
        const fail = () => reject(options.signal.reason || new Error('aborted'));
        options.signal.addEventListener('abort', fail, { once: true });
        if (options.signal.aborted) fail();
      });
    },
  });
  t.after(() => broker.close());

  const responsePromise = fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
  await fetchStarted;
  clock.advance(29_999);
  assert.equal(broker.terminalError, null);
  clock.advance(1);
  const response = await responsePromise;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'PROVIDER_FIRST_BYTE_TIMEOUT');
  assert.equal(broker.terminalError.code, 'PROVIDER_FIRST_BYTE_TIMEOUT');
  assert.equal(clock.timers.size, 0);
});

test('strict LID range progress may exceed 30 s total while resetting only the idle deadline', () => {
  const { createStrictLidRangeDeadline } = brokerHarness();
  const clock = new FakeClock();
  const controller = new AbortController();
  const deadline = createStrictLidRangeDeadline({
    controller,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
  });

  deadline.progress();
  for (let index = 0; index < 4; index++) {
    clock.advance(10_000);
    deadline.progress();
  }
  assert.equal(clock.now, 40_000);
  assert.equal(controller.signal.aborted, false);
  assert.equal(deadline.timedOut, false);
  deadline.close();
  assert.equal(clock.timers.size, 0);
  clock.advance(60_000);
  assert.equal(controller.signal.aborted, false, 'cleanup must prevent a late timeout');
});

test('strict LID range deadline aborts a stalled body after the inactivity interval', () => {
  const { createStrictLidRangeDeadline } = brokerHarness();
  const clock = new FakeClock();
  const controller = new AbortController();
  const deadline = createStrictLidRangeDeadline({
    controller,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
  });

  deadline.progress();
  clock.advance(14_999);
  assert.equal(controller.signal.aborted, false);
  clock.advance(1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(deadline.timeoutKind, 'idle');
  assert.equal(clock.timers.size, 0);
});

test('HTTP 200 busy-prefix stall preserves the fake first-byte timeout instead of RANGE_UNSUPPORTED', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const clock = new FakeClock();
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: 100,
    dispatcher: null,
    releaseDelayMs: 0,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    fetchImpl: async (_url, options) => {
      markFetchStarted();
      const body = new ReadableStream({
        start(controller) {
          options.signal.addEventListener('abort', () => {
            try { controller.error(options.signal.reason || new Error('aborted')); } catch (_) {}
          }, { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    },
  });
  t.after(() => broker.close());

  const responsePromise = fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
  await fetchStarted;
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(30_000);
  const response = await responsePromise;
  assert.equal(response.status, 504);
  const payload = await response.json();
  assert.equal(payload.code, 'PROVIDER_FIRST_BYTE_TIMEOUT');
  assert.notEqual(payload.code, 'RANGE_UNSUPPORTED');
  assert.equal(broker.terminalError.code, 'PROVIDER_FIRST_BYTE_TIMEOUT');
  assert.equal(broker.providerFetches, 1);
  assert.equal(clock.timers.size, 0);
});

test('strict LID broker maps a fake body stall to the idle timeout and drains it', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const clock = new FakeClock();
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: 10,
    dispatcher: null,
    releaseDelayMs: 0,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    fetchImpl: async (_url, options) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.of(0x2a));
          options.signal.addEventListener('abort', () => {
            try { controller.error(options.signal.reason || new Error('aborted')); } catch (_) {}
          }, { once: true });
        },
      });
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': 'bytes 0-9/10',
          'Content-Length': '10',
          ETag: '"idle-v1"',
        },
      });
    },
  });
  t.after(() => broker.close());

  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
  assert.equal(response.status, 206);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).value.byteLength, 1);
  const closedBody = reader.read().catch(() => null);
  clock.advance(14_999);
  assert.equal(broker.terminalError, null);
  clock.advance(1);
  for (let attempt = 0; attempt < 5 && !broker.terminalError; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(broker.terminalError.code, 'PROVIDER_IDLE_TIMEOUT');
  await closedBody;
  assert.equal(clock.timers.size, 0);
});

test('strict LID broker stays on loopback, answers HEAD locally, and forwards exact sticky ranges', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const calls = [];
  const provider = http.createServer((req, res) => {
    calls.push({ range: req.headers.range, ifRange: req.headers['if-range'] || null });
    sendExactRange(req, res, data);
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  const local = new URL(broker.inputUrl);
  assert.equal(local.hostname, '127.0.0.1');
  assert.match(local.pathname, /^\/strict-lid\/[A-Za-z0-9_-]{40,}$/);
  assert.doesNotMatch(broker.inputUrl, /account|secret|file\.mkv/);

  const head = await fetch(broker.inputUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(data.length));
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(calls.length, 0, 'local HEAD must consume zero provider sockets');

  const first = await fetch(broker.inputUrl, { headers: { Range: 'bytes=3-9' } });
  assert.equal(first.status, 206);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), data.subarray(3, 10));
  const second = await fetch(broker.inputUrl, { headers: { Range: 'bytes=-5' } });
  assert.equal(second.status, 206);
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), data.subarray(data.length - 5));
  assert.deepEqual(calls, [
    { range: 'bytes=3-9', ifRange: null },
    { range: `bytes=${data.length - 5}-${data.length - 1}`, ifRange: '"fixture-v1"' },
  ]);
});

test('strict LID freezes one sticky provider dispatcher for every sequential range', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(20, 0x41);
  const stickyDispatcher = { slot: 3 };
  const observedDispatchers = [];
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: data.length,
    dispatcher: stickyDispatcher,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
    fetchImpl: async (_url, options) => {
      observedDispatchers.push(options.dispatcher);
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = data.subarray(start, end + 1);
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': String(body.length),
          ETag: '"sticky-v1"',
        },
      });
    },
  });
  t.after(() => broker.close());

  for (const range of ['bytes=0-4', 'bytes=5-9']) {
    const response = await fetch(broker.inputUrl, { headers: { Range: range } });
    assert.equal(response.status, 206);
    await response.arrayBuffer();
  }
  assert.equal(observedDispatchers.length, 2);
  assert.equal(observedDispatchers[0], stickyDispatcher);
  assert.equal(observedDispatchers[1], stickyDispatcher);
});

test('strict broker can reopen immediately only after an exact provider range is fully drained', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(64, 0x5c);
  const openedAt = [];
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 500,
    completedReleaseDelayMs: 0,
    openTimeoutMs: 2000,
    fetchImpl: async (_url, options) => {
      openedAt.push(Date.now());
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = data.subarray(start, end + 1);
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': String(body.length),
          ETag: '"drained-v1"',
        },
      });
    },
  });
  t.after(() => broker.close());

  for (const range of ['bytes=0-15', 'bytes=16-31']) {
    const response = await fetch(broker.inputUrl, { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 16);
  }

  assert.equal(openedAt.length, 2);
  assert.ok(openedAt[1] - openedAt[0] < 400,
    `fully drained successor waited ${openedAt[1] - openedAt[0]}ms`);
  assert.equal(broker.completedProviderFetches, 2);
  assert.equal(broker.interruptedProviderFetches, 0);
});

test('strict LID broker preempts an old local range, awaits close, and never exceeds one provider socket', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(256, 0x5a);
  const state = { active: 0, maxActive: 0, calls: 0, firstClosedAt: 0, secondOpenedAt: 0 };
  const provider = http.createServer((req, res) => {
    state.calls++;
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    if (state.calls === 2) state.secondOpenedAt = Date.now();
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      state.active--;
      if (state.calls === 1) state.firstClosedAt = Date.now();
    };
    res.once('close', release);
    res.once('finish', release);
    const { start, end } = exactRange(req, data.length);
    const length = end - start + 1;
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Content-Length': String(length),
      ETag: '"serial-v1"',
    });
    if (state.calls === 1) {
      res.write(data.subarray(start, start + 1));
      return;
    }
    res.end(data.subarray(start, end + 1));
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 25,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  const first = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-127' } });
  assert.equal(first.status, 206);
  const firstReader = first.body.getReader();
  const firstChunk = await firstReader.read();
  assert.equal(firstChunk.value.length, 1);

  const second = await fetch(broker.inputUrl, { headers: { Range: 'bytes=128-255' } });
  assert.equal(second.status, 206);
  assert.equal((await second.arrayBuffer()).byteLength, 128);
  await firstReader.cancel().catch(() => {});

  assert.equal(state.calls, 2);
  assert.equal(state.maxActive, 1, 'strict LID must never overlap provider bodies');
  assert.ok(state.firstClosedAt > 0 && state.secondOpenedAt >= state.firstClosedAt);
  assert.ok(
    state.secondOpenedAt - state.firstClosedAt >= 20,
    `successor opened only ${state.secondOpenedAt - state.firstClosedAt}ms after close`,
  );
});

test('finite seek broker reopens immediately after planned supersession without overlapping provider sockets', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(256, 0x5b);
  const state = { active: 0, maxActive: 0, calls: 0, firstClosedAt: 0, secondOpenedAt: 0 };
  const provider = http.createServer((req, res) => {
    state.calls++;
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    if (state.calls === 2) state.secondOpenedAt = Date.now();
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      state.active--;
      if (state.calls === 1) state.firstClosedAt = Date.now();
    };
    res.once('close', release);
    res.once('finish', release);
    const { start, end } = exactRange(req, data.length);
    const length = end - start + 1;
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Content-Length': String(length),
      ETag: '"finite-serial-v1"',
    });
    if (state.calls === 1) {
      res.write(data.subarray(start, start + 1));
      return;
    }
    res.end(data.subarray(start, end + 1));
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 500,
    completedReleaseDelayMs: 0,
    supersededReleaseDelayMs: 0,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  const first = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-127' } });
  assert.equal(first.status, 206);
  const firstReader = first.body.getReader();
  const firstChunk = await firstReader.read();
  assert.equal(firstChunk.value.length, 1);

  const second = await fetch(broker.inputUrl, { headers: { Range: 'bytes=128-255' } });
  assert.equal(second.status, 206);
  assert.equal((await second.arrayBuffer()).byteLength, 128);
  await firstReader.cancel().catch(() => {});

  assert.equal(state.calls, 2);
  assert.equal(state.maxActive, 1, 'planned supersession must remain strictly serialized');
  assert.ok(state.firstClosedAt > 0 && state.secondOpenedAt >= state.firstClosedAt);
  assert.ok(
    state.secondOpenedAt - state.firstClosedAt < 300,
    `planned successor waited ${state.secondOpenedAt - state.firstClosedAt}ms`,
  );
  assert.equal(broker.completedProviderFetches, 1);
  assert.equal(broker.interruptedProviderFetches, 1);
});

for (const fixture of [
  {
    name: 'first HTTP 458',
    response(_req, res) { res.writeHead(458, { 'Content-Type': 'text/plain' }); res.end('busy'); },
    upstreamStatus: 458,
  },
  {
    name: 'first HTTP 200 textual provider-busy body',
    response(_req, res) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '45' });
      res.end('user_multi_ip maximum connections provider busy');
    },
    upstreamStatus: 200,
  },
]) {
  test(`strict LID treats ${fixture.name} as terminal after one fetch`, async (t) => {
    const { createStrictLidBroker } = brokerHarness();
    let calls = 0;
    const provider = http.createServer((req, res) => { calls++; fixture.response(req, res); });
    const sourceUrl = await listen(provider);
    t.after(() => closeServer(provider));
    const broker = await createStrictLidBroker({
      sourceUrl,
      fileSizeBytes: 100,
      dispatcher: null,
      releaseDelayMs: 0,
      openTimeoutMs: 2000,
    });
    t.after(() => broker.close());

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
      assert.equal(response.status, 458);
      const payload = await response.json();
      assert.equal(payload.code, 'PROVIDER_BUSY');
      assert.equal(payload.upstreamStatus, fixture.upstreamStatus);
    }
    assert.equal(calls, 1);
    assert.equal(broker.providerFetches, 1);
    assert.equal(broker.terminalError.code, 'PROVIDER_BUSY');
  });
}

test('first HTTP 458 remains terminal when fake range deadlines advance afterwards', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const clock = new FakeClock();
  let calls = 0;
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: 100,
    dispatcher: null,
    releaseDelayMs: 0,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    fetchImpl: async () => {
      calls++;
      return new Response('provider busy', { status: 458 });
    },
  });
  t.after(() => broker.close());

  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
  assert.equal(response.status, 458);
  assert.equal((await response.json()).code, 'PROVIDER_BUSY');
  assert.equal(broker.terminalError.code, 'PROVIDER_BUSY');
  assert.equal(clock.timers.size, 0, 'terminal cleanup must clear the range deadline');
  clock.advance(60_000);
  assert.equal(broker.terminalError.code, 'PROVIDER_BUSY');
  assert.equal(calls, 1);
});

test('strict LID keeps proxy HTTP 407 distinct from provider-busy and never retries it', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  let calls = 0;
  const provider = http.createServer((_req, res) => {
    calls++;
    res.writeHead(407, { 'Content-Type': 'text/plain' });
    res.end('proxy authentication required');
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: 100,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.code, 'PROXY_AUTH_FAILED');
    assert.equal(payload.upstreamStatus, 407);
    assert.notEqual(payload.code, 'PROVIDER_BUSY');
  }
  assert.equal(calls, 1);
  assert.equal(broker.providerFetches, 1);
});

test('strict LID preserves a proxy CONNECT 407 that undici reports as a thrown failure', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  let calls = 0;
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: 100,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
    fetchImpl: async () => {
      calls++;
      const error = new Error('Proxy response 407 authentication required');
      error.code = 'PROXY_AUTH_FAILED';
      throw error;
    },
  });
  t.after(() => broker.close());

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.code, 'PROXY_AUTH_FAILED');
    assert.equal(payload.upstreamStatus, 407);
  }
  assert.equal(calls, 1);
});

test('strict LID fails closed on status/range/length/encoding validation defects', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(32, 0x2a);
  const cases = [
    {
      name: 'status',
      send(req, res) {
        exactRange(req, data.length);
        res.writeHead(204);
        res.end();
      },
      code: 'PROVIDER_REQUEST_FAILED',
    },
    {
      name: 'content-range',
      send(req, res) { sendExactRange(req, res, data, { contentRange: 'bytes 0-8/32' }); },
      code: 'RANGE_UNSUPPORTED',
    },
    {
      name: 'content-length',
      send(req, res) { sendExactRange(req, res, data, { contentLength: 9, body: data.subarray(0, 9) }); },
      code: 'RANGE_UNSUPPORTED',
    },
    {
      name: 'content-encoding',
      send(req, res) { sendExactRange(req, res, data, { contentEncoding: 'gzip' }); },
      code: 'RANGE_UNSUPPORTED',
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let calls = 0;
      const provider = http.createServer((req, res) => { calls++; fixture.send(req, res); });
      const sourceUrl = await listen(provider);
      const broker = await createStrictLidBroker({
        sourceUrl,
        fileSizeBytes: data.length,
        dispatcher: null,
        releaseDelayMs: 0,
        openTimeoutMs: 2000,
      });
      try {
        const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
        assert.equal(response.status, 502);
        assert.equal((await response.json()).code, fixture.code);
        assert.equal(calls, 1);
      } finally {
        await broker.close();
        await closeServer(provider);
      }
    });
  }
});

test('strict LID pins the first strong validator and fails closed if the file changes', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(32, 0x33);
  const calls = [];
  const provider = http.createServer((req, res) => {
    calls.push({ range: req.headers.range, ifRange: req.headers['if-range'] || null });
    sendExactRange(req, res, data, { etag: calls.length === 1 ? '"v1"' : '"v2"' });
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  const first = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
  assert.equal(first.status, 206);
  await first.arrayBuffer();
  const second = await fetch(broker.inputUrl, { headers: { Range: 'bytes=10-19' } });
  assert.equal(second.status, 502);
  assert.equal((await second.json()).code, 'VOD_CHANGED');
  assert.equal(calls[1].ifRange, '"v1"');
});

test('finite MKV seek broker pins preopen validator and effective URL before forwarding bytes', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(32, 0x44);
  const calls = [];
  const provider = http.createServer((req, res) => {
    calls.push({ range: req.headers.range, ifRange: req.headers['if-range'] || null });
    sendExactRange(req, res, data, { etag: '"v1"' });
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));

  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
    pathPrefix: 'finite-mkv-seek',
    expectedValidator: { header: 'If-Range', value: '"v1"', kind: 'etag' },
    effectiveUrlSha256: require('node:crypto').createHash('sha256').update(sourceUrl).digest('hex'),
  });
  t.after(() => broker.close());
  assert.match(new URL(broker.inputUrl).pathname, /^\/finite-mkv-seek\/[A-Za-z0-9_-]{40,}$/);

  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=4-11' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(4, 12));
  assert.deepEqual(calls, [{ range: 'bytes=4-11', ifRange: '"v1"' }]);

  const mismatched = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
    pathPrefix: 'finite-mkv-seek',
    effectiveUrlSha256: require('node:crypto').createHash('sha256').update(`${sourceUrl}/redirected`).digest('hex'),
  });
  try {
    const rejected = await fetch(mismatched.inputUrl, { headers: { Range: 'bytes=0-3' } });
    assert.equal(rejected.status, 502);
    assert.equal((await rejected.json()).code, 'VOD_CHANGED');
  } finally {
    await mismatched.close();
  }
});

test('strict LID rejects invalid exact signed coordinates before creating a server or provider fetch', async () => {
  const { createStrictLidBroker } = brokerHarness();
  let fetches = 0;
  for (const fileSizeBytes of [null, '', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      createStrictLidBroker({
        sourceUrl: 'http://127.0.0.1:9/file.mkv',
        fileSizeBytes,
        dispatcher: null,
        fetchImpl: async () => { fetches++; throw new Error('must not fetch'); },
      }),
      (error) => error && error.code === 'EXACT_FILE_SIZE_REQUIRED',
    );
  }
  assert.equal(fetches, 0);

  const routeStart = gatewaySource.indexOf('async function handleDetectLanguageRequest(');
  const routeEnd = gatewaySource.indexOf("app.post('/extract-language-wav'", routeStart);
  const route = gatewaySource.slice(routeStart, routeEnd);
  assert.ok(route.indexOf("code: 'exact_file_size_required'") < route.indexOf('createStrictLidBroker({'));
  assert.match(route, /normalizeStrictLidTimelineDurationSeconds\(claims\.durationSeconds\)/);
  assert.ok(route.indexOf("code: 'exact_duration_required'") < route.indexOf('createStrictLidBroker({'));
  assert.ok(route.indexOf("code: 'strict_lid_duration_too_short'") < route.indexOf('createStrictLidBroker({'));
  assert.match(
    route,
    /code: 'strict_lid_duration_too_short'[\s\S]*providerDrained: true,[\s\S]*providerDrainProtocol: 1/,
  );
  assert.doesNotMatch(route, /req\.query\.(?:duration|durationSeconds)|WHISPER_STRICT_OFFSETS/);
  assert.match(route, /detectLanguageRequestPolicy\(req, options\)[\s\S]*validateDetectLanguageCapability\(capabilityToken, policy\.requiredScope\)/);
  assert.match(gatewaySource, /strictLidLoopbackBrokerProtocol: 1/);
  assert.match(gatewaySource, /strictLidFileSizeClaim: 'fileSizeBytes'/);
  assert.match(gatewaySource, /const GATEWAY_VERSION = 113/);
  assert.match(gatewaySource, /strictLidProviderDrainProtocol: 1/);
  assert.match(gatewaySource, /strictLidWeakFallbackProtocol: 1/);
  assert.match(gatewaySource, /strictLidTimelineSamplingProtocol: 1/);
  assert.match(gatewaySource, /strictLidRangeTimeoutProtocol: 2/);
  assert.match(gatewaySource, /strictLidRangeFirstByteTimeoutMs: STRICT_LID_BROKER_FIRST_BYTE_TIMEOUT_MS/);
  assert.match(gatewaySource, /strictLidRangeIdleTimeoutMs: STRICT_LID_BROKER_IDLE_TIMEOUT_MS/);
  assert.match(gatewaySource, /strictLidFfmpegRwTimeoutUs: STRICT_LID_FFMPEG_RW_TIMEOUT_US/);
  assert.match(
    route,
    /const sendDetectionJson = async[\s\S]*await closeStrictBrokerForResponse\(\)[\s\S]*providerDrained: true[\s\S]*providerDrainProtocol: 1/,
  );
  assert.ok(
    route.indexOf('await closeStrictBrokerForResponse()') < route.indexOf('return res.status(status).json(responsePayload)'),
    'the strict broker must drain before any attested JSON response is emitted',
  );
});

test('service-only header LID route authenticates before capability handling and preserves terminal statuses', async () => {
  const start = gatewaySource.indexOf('function detectLanguageCapabilityFromHeader(');
  const end = gatewaySource.indexOf('// Service-only production handoff', start);
  assert.ok(start >= 0 && end > start, 'header LID route source must remain extractable');
  const authStart = gatewaySource.indexOf('function requireGatewayAuth(');
  const authEnd = gatewaySource.indexOf('\nfunction requirePlaybackToken(', authStart);
  assert.ok(authStart >= 0 && authEnd > authStart, 'gateway auth guard source must remain extractable');
  const calls = [];
  const postRoutes = new Map();
  const getRoutes = new Map();
  const logs = [];
  const app = {
    post(route, ...handlers) { postRoutes.set(route, handlers); },
    get(route, handler) { getRoutes.set(route, handler); },
  };
  const makeResponse = () => ({
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  });
  vm.runInNewContext(
    `${gatewaySource.slice(authStart, authEnd)}\n${gatewaySource.slice(start, end)}`,
    {
    LID_CAPABILITY_HEADER: 'x-norva-byte-pipe-token',
    LID_LEGACY_FULL_SCOPE: 'lid-legacy-full',
    GATEWAY_TOKEN: 'service-secret',
    app,
    console: {
      log: (...args) => logs.push(args.join(' ')),
      warn: (...args) => logs.push(args.join(' ')),
      error: (...args) => logs.push(args.join(' ')),
    },
    handleDetectLanguageRequest: async (_req, res, token, options) => {
      calls.push({ token, options });
      if (token === 'busy.458') return res.status(458).json({ code: 'PROVIDER_BUSY' });
      if (token === 'proxy.407') return res.status(502).json({ code: 'PROXY_AUTH_FAILED', upstreamStatus: 407 });
      return res.status(200).json({ ok: true });
    },
    String,
    timingSafeEqual: (left, right) => left === right,
  });

  const invoke = async (handlers, req, res) => {
    let cursor = -1;
    const dispatch = async (index) => {
      assert.ok(index > cursor, 'middleware next() must advance exactly once');
      cursor = index;
      const handler = handlers[index];
      if (!handler) return;
      let downstream = null;
      const next = () => {
        downstream = dispatch(index + 1);
        return downstream;
      };
      await handler(req, res, next);
      if (downstream) await downstream;
    };
    await dispatch(0);
  };
  const makeRequest = ({ bearer = null, capability = null } = {}) => ({
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    get: (name) => name === 'x-norva-byte-pipe-token' ? capability : undefined,
  });

  const headerRoute = postRoutes.get('/detect-language');
  assert.equal(Array.isArray(headerRoute), true);
  assert.equal(headerRoute.length, 3, 'security headers, service auth, then capability handler');
  assert.equal(getRoutes.has('/detect-language'), false, 'the unauthenticated GET header route is closed');
  assert.equal(typeof getRoutes.get('/detect-language/:token'), 'function', 'legacy path remains explicit compatibility only');

  const missingBearer = makeResponse();
  await invoke(headerRoute, makeRequest({ capability: 'signedPayload.signature' }), missingBearer);
  assert.equal(missingBearer.statusCode, 401);
  assert.equal(calls.length, 0);
  assert.equal(missingBearer.headers['cache-control'], 'no-store');
  assert.equal(missingBearer.headers['x-content-type-options'], 'nosniff');

  const wrongBearer = makeResponse();
  await invoke(headerRoute, makeRequest({ bearer: 'wrong-secret', capability: 'signedPayload.signature' }), wrongBearer);
  assert.equal(wrongBearer.statusCode, 401);
  assert.equal(calls.length, 0);

  const missingCapability = makeResponse();
  await invoke(headerRoute, makeRequest({ bearer: 'service-secret' }), missingCapability);
  assert.equal(missingCapability.statusCode, 401);
  assert.equal(calls.length, 0);

  const invalid = makeResponse();
  await invoke(headerRoute, makeRequest({ bearer: 'service-secret', capability: 'not a signed token' }), invalid);
  assert.equal(invalid.statusCode, 401);
  assert.equal(calls.length, 0);

  const successToken = 'signedPayload.signature';
  const success = makeResponse();
  await invoke(headerRoute, makeRequest({ bearer: 'service-secret', capability: successToken }), success);
  assert.equal(success.statusCode, 200);
  assert.equal(calls.at(-1).token, successToken);
  assert.equal(calls.at(-1).options.requiredScope, 'lid-legacy-full');
  assert.equal(success.headers['cache-control'], 'no-store');

  const busy = makeResponse();
  await invoke(headerRoute, makeRequest({ bearer: 'service-secret', capability: 'busy.458' }), busy);
  assert.equal(busy.statusCode, 458);
  assert.equal(busy.body.code, 'PROVIDER_BUSY');

  const proxy = makeResponse();
  await invoke(headerRoute, makeRequest({ bearer: 'service-secret', capability: 'proxy.407' }), proxy);
  assert.equal(proxy.statusCode, 502);
  assert.equal(proxy.body.code, 'PROXY_AUTH_FAILED');
  assert.equal(proxy.body.upstreamStatus, 407);

  assert.deepEqual(logs, [], 'the route never logs the header, token, or signed provider URL');
  const handlerStart = gatewaySource.indexOf('function validateDetectLanguageCapability(');
  const handlerEnd = gatewaySource.indexOf('function detectLanguageCapabilityFromHeader(', handlerStart);
  const handlerSource = gatewaySource.slice(handlerStart, handlerEnd);
  assert.match(handlerSource, /verifyRawToken\(capabilityToken, GATEWAY_TOKEN\)/,
    'the header and legacy routes share the exact signature/scope/broker implementation');
  assert.doesNotMatch(handlerSource, /req\.params\.token/);
  assert.doesNotMatch(handlerSource, /console\.(?:log|warn|error)/);
  assert.match(gatewaySource, /strictLidHeaderCapabilityProtocol: 2/);
  assert.match(gatewaySource, /strictLidCapabilityHeader: 'X-Norva-Byte-Pipe-Token'/);
  assert.match(gatewaySource, /strictLidCapabilityMethod: 'POST'/);
  assert.match(gatewaySource, /strictLidServiceAuthRequired: true/);
});

test('strict legacy raw tokens and the service route both require exact lid-legacy-full scope before I/O', () => {
  const start = gatewaySource.indexOf('function validateDetectLanguageCapability(');
  const end = gatewaySource.indexOf('\nasync function handleDetectLanguageRequest(', start);
  assert.ok(start >= 0 && end > start, 'capability policy source must remain extractable');
  const policies = vm.runInNewContext(
    `(() => { ${gatewaySource.slice(start, end)}; return { validateDetectLanguageCapability, detectLanguageRequestPolicy }; })()`,
    {
      Date,
      GATEWAY_TOKEN: 'hmac-secret',
      LID_LEGACY_FULL_SCOPE: 'lid-legacy-full',
      LID_ROUTE_SCOPES: new Set(['lid-production-detect-only', 'lid-shadow', 'lid-legacy-full']),
      String,
      verifyRawToken(token) {
        if (token === 'raw-nonstrict') {
          return { exp: Math.floor(Date.now() / 1000) + 60, scope: 'lid-production-detect-only' };
        }
        if (token === 'full') {
          return { exp: Math.floor(Date.now() / 1000) + 60, scope: 'lid-legacy-full' };
        }
        return null;
      },
    },
  );

  const legacyStrictPolicy = policies.detectLanguageRequestPolicy({ query: { strict: '1' } });
  assert.equal(legacyStrictPolicy.strict, true);
  assert.equal(legacyStrictPolicy.requiredScope, 'lid-legacy-full');
  assert.equal(
    policies.validateDetectLanguageCapability('raw-nonstrict', legacyStrictPolicy.requiredScope).status,
    403,
    'a raw legacy strict token cannot downgrade to detect-only scope',
  );
  assert.equal(
    policies.validateDetectLanguageCapability('full', legacyStrictPolicy.requiredScope).status,
    200,
  );
  const nonStrictPolicy = policies.detectLanguageRequestPolicy({ query: {} });
  assert.equal(nonStrictPolicy.requiredScope, null, 'legacy non-strict compatibility remains explicit');
  assert.equal(policies.validateDetectLanguageCapability('raw-nonstrict', null).status, 200);

  const handlerStart = gatewaySource.indexOf('async function handleDetectLanguageRequest(');
  const handlerEnd = gatewaySource.indexOf('function detectLanguageCapabilityFromHeader(', handlerStart);
  const handler = gatewaySource.slice(handlerStart, handlerEnd);
  assert.ok(handler.indexOf('validateDetectLanguageCapability(') < handler.indexOf('WHISPER_BIN'),
    'scope validation happens before configuration, broker, fetch, or spawn');
  assert.ok(handler.indexOf('validateDetectLanguageCapability(') < handler.indexOf('createStrictLidBroker({'));
});

test('strict ffmpeg uses only loopback while provider identity remains in the background ledger', () => {
  const start = gatewaySource.indexOf('function extractAudioWav(');
  const end = gatewaySource.indexOf('// V2 chunked pipeline', start);
  const extraction = gatewaySource.slice(start, end);
  assert.match(extraction, /const strictLoopback = inputOptions\?\.strictLoopback === true/);
  assert.match(extraction, /providerSourceUrl[\s\S]+proxyKeyFromUrl\(providerSourceUrl\)/);
  assert.match(extraction, /registerAccountExtraction\(\s*providerAccountKey/);
  assert.match(extraction, /env: strictLoopback \? loopbackOnlyEnv\(\)/);
  assert.match(extraction, /\.\.\.\(!strictLoopback \? \[[\s\S]+?'-reconnect'/);
  assert.match(extraction, /strictLoopback \? redactStrictLidLoopback\(stderr\) : stderr/);
  assert.match(
    extraction,
    /'-rw_timeout', strictLoopback[\s\S]*STRICT_LID_CHECKPOINT_FFMPEG_RW_TIMEOUT_US[\s\S]*STRICT_LID_FFMPEG_RW_TIMEOUT_US[\s\S]*: '15000000'/,
  );

  const envStart = gatewaySource.indexOf('function loopbackOnlyEnv()');
  const envEnd = gatewaySource.indexOf('// Xtream URLs embed credentials', envStart);
  const envSource = gatewaySource.slice(envStart, envEnd);
  assert.match(envSource, /'http_proxy'[\s\S]+'ALL_PROXY'/);
  assert.match(envSource, /NO_PROXY = '127\.0\.0\.1,localhost,::1'/);
  assert.match(gatewaySource, /function redactStrictLidLoopback\(value\)[\s\S]+?\[strict-lid-loopback\]/);
});

test('v102 keeps the v101 outer extraction invariant: survive 35 s and kill at 45 s', async () => {
  class TimeoutChild extends EventEmitter {
    constructor() {
      super();
      this.stderr = new EventEmitter();
      this.kills = [];
    }

    kill(signal) {
      this.kills.push(signal);
      setImmediate(() => this.emit('close', null, signal));
      return true;
    }
  }

  const child = new TimeoutChild();
  const clock = new FakeClock();
  let spawnedArgs = null;
  const extractAudioWav = audioExtractionHarness((_bin, args) => {
    spawnedArgs = args;
    return child;
  }, {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const resultPromise = extractAudioWav(
    'http://127.0.0.1/strict-lid-input',
    'Norva-LID-Test/1',
    1,
    600,
    20,
    45_000,
    'account-test',
    true,
    null,
    true,
    {
      strictLoopback: true,
      providerSourceUrl: 'https://provider.invalid/account/movie.mkv',
    },
  );
  const rwTimeoutIndex = spawnedArgs.indexOf('-rw_timeout');
  assert.ok(rwTimeoutIndex >= 0);
  assert.equal(spawnedArgs[rwTimeoutIndex + 1], '50000000');
  clock.advance(15_000);
  assert.deepEqual(child.kills, [], 'libav loopback timeout must not win at the legacy 15 s');
  clock.advance(20_000);
  assert.deepEqual(child.kills, [], 'the widened outer timer must survive the former 35 s limit');
  clock.advance(9_999);
  assert.deepEqual(child.kills, []);
  clock.advance(1);
  const result = await resultPromise;

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.match(result.error, /extract timeout after 45s/);
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.equal(clock.timers.size, 0);
});

test('closing a strict LID broker aborts an active provider body and leaves no live local handle', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  let providerClosed = false;
  const provider = http.createServer((req, res) => {
    const { start, end } = exactRange(req, 100);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/100`,
      'Content-Length': String(end - start + 1),
      ETag: '"close-v1"',
    });
    res.write(Buffer.from([1]));
    res.once('close', () => { providerClosed = true; });
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: 100,
    dispatcher: null,
    releaseDelayMs: 40,
    openTimeoutMs: 2000,
  });
  const localUrl = broker.inputUrl;
  const response = await fetch(localUrl, { headers: { Range: 'bytes=0-99' } });
  assert.equal(response.status, 206);
  await response.body.getReader().read();
  const closeStartedAt = Date.now();
  await broker.close();
  const closeElapsedMs = Date.now() - closeStartedAt;
  const closedDeadline = Date.now() + 500;
  while (!providerClosed && Date.now() < closedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(providerClosed, true);
  assert.ok(
    closeElapsedMs >= 30,
    `broker close acknowledged before provider release grace (${closeElapsedMs}ms)`,
  );
  await assert.rejects(fetch(localUrl, { headers: { Range: 'bytes=0-1' } }));
});
