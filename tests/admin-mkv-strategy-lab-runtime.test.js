'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../public/js/utils/MkvStrategyLabRuntime.js'),
  'utf8',
);

function loadRuntime(fetchImpl) {
  const window = { fetch: fetchImpl };
  vm.runInNewContext(SOURCE, {
    window,
    URL,
    TextEncoder,
    AbortController,
    Error,
    Object,
    Array,
    Set,
    Number,
    String,
    JSON,
    Promise,
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 2)),
    clearTimeout,
  });
  return new window.MkvStrategyLabRuntime({
    baseUrl: 'https://api.example',
    apiKey: 'publishable-key',
    getToken: () => 'admin-jwt-token',
    fetchImpl,
  });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function completeResult() {
  return {
    protocol: 1,
    status: 'pass',
    pipeline: 'video-copy-audio-copy',
    reason: 'mkv-h264-copy-ready',
    ttffMs: 6500,
    manifestReadyMs: 900,
    firstSegmentMs: 1200,
    bufferedAheadSeconds: 7,
    productionRateX: 8,
    browserBufferRateX: 3,
    rebufferCount: 0,
    rebufferMs: 0,
    providerGets: 1,
    maximumConcurrentProviderGets: 1,
    ffmpegSpawns: 1,
    analyzerSpawns: 0,
    http458: 0,
    retriesAfter458: 0,
    seekPassed: true,
    audioPassed: true,
    cleanupPassed: true,
  };
}

test('browser runtime sends one fixed fixture enum then polls the caller-owned result', async () => {
  const calls = [];
  let polls = 0;
  const runtime = loadRuntime(async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), { protocol: 1, fixtureId: 'h264-closed-aac' });
      return json({ protocol: 1, state: 'running', fixtureId: 'h264-closed-aac' }, 202);
    }
    polls += 1;
    return polls === 1
      ? json({ protocol: 1, state: 'running', fixtureId: 'h264-closed-aac' })
      : json({ protocol: 1, state: 'complete', fixtureId: 'h264-closed-aac', result: completeResult() });
  });

  const result = await runtime.runCase({ protocol: 1, fixtureId: 'h264-closed-aac' }, { signal: new AbortController().signal });
  assert.equal(result.ttffMs, 6500);
  assert.deepEqual(calls.map((call) => call.init.method), ['POST', 'GET', 'GET']);
  for (const call of calls) {
    assert.equal(call.init.headers.Authorization, 'Bearer admin-jwt-token');
    assert.equal(call.init.headers.apikey, 'publishable-key');
    assert.equal(call.url.includes('provider'), false);
    assert.equal(call.url.includes('session'), false);
  }
});

test('browser runtime rejects URLs and additional request keys before network I/O', async () => {
  let calls = 0;
  const runtime = loadRuntime(async () => { calls += 1; return json({}); });
  for (const request of [
    { protocol: 1, fixtureId: 'https://provider.invalid/secret.mkv' },
    { protocol: 1, fixtureId: 'h264-closed-aac', sourceUrl: 'https://provider.invalid/secret.mkv' },
    { protocol: '1', fixtureId: 'h264-closed-aac' },
  ]) await assert.rejects(runtime.runCase(request, {}), /INVALID_RUNTIME_REQUEST/);
  assert.equal(calls, 0);
});

test('browser runtime preserves an immediate bounded blocked result without polling', async () => {
  const calls = [];
  const result = {
    protocol: 1,
    status: 'blocked',
    pipeline: 'video-copy-audio-copy',
    reason: 'runner-busy',
  };
  const runtime = loadRuntime(async (_url, init) => {
    calls.push(init.method);
    return json({ protocol: 1, state: 'complete', fixtureId: 'h264-closed-aac', result }, 202);
  });
  assert.deepEqual(
    await runtime.runCase({ protocol: 1, fixtureId: 'h264-closed-aac' }, { signal: new AbortController().signal }),
    result,
  );
  assert.deepEqual(calls, ['POST']);
});

test('aborting a run issues one bounded caller cleanup and never restarts media', async () => {
  const methods = [];
  const controller = new AbortController();
  const runtime = loadRuntime(async (_url, init) => {
    methods.push(init.method);
    if (init.method === 'POST') {
      queueMicrotask(() => controller.abort());
      return json({ protocol: 1, state: 'running', fixtureId: 'h264-closed-aac' }, 202);
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error('poll must not survive abort');
  });
  await assert.rejects(
    runtime.runCase({ protocol: 1, fixtureId: 'h264-closed-aac' }, { signal: controller.signal }),
    /RUNTIME_ABORTED/,
  );
  assert.deepEqual(methods, ['POST', 'DELETE']);
});
