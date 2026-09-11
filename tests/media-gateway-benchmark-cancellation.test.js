'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { runWhisperDetectOnly } = require('../services/media-gateway/src/whisper-lid');

const source = fs.readFileSync(process.env.NORVA_BENCHMARK_REPLAY_SOURCE
  || path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a);
  return source.slice(a, b);
}
const route = section("app.post('/benchmark-language/:token'", '// Phase 3: full timestamped transcription');
const full = section('function runWhisperDetect(wavPath', '// whisper hallucinates repetition');

function harness(t, { order = 'current-first', pause = null, preemptAtSpawn = false,
  extractFailure = null } = {}) {
  const children = [], removed = [], registrations = new Set();
  const calls = { extract: 0, current: 0, fast: 0, writes: 0 };
  const phases = new Map();
  let viewer = false, handler, pending, activeExtraction, selectedSignal;
  const wav = Buffer.alloc(44 + 30 * 32000);
  wav.write('RIFF'); wav.write('WAVE', 8);
  function signalPhase(name) {
    phases.get(name)?.(); phases.set(name, true);
  }
  function phase(name) {
    if (phases.get(name) === true) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('phase not reached: ' + name)), 1500);
      phases.set(name, () => { clearTimeout(timer); resolve(); });
    });
  }
  function spawn(_bin, args) {
    const name = args.includes('-dl') ? 'fast' : 'current';
    calls[name]++;
    const child = new EventEmitter();
    child.stderr = new EventEmitter(); child.stdout = new EventEmitter();
    child.kills = 0; child.closed = false;
    child.close = code => { if (!child.closed) { child.closed = true; child.emit('close', code); } };
    child.kill = () => { child.kills++; setImmediate(() => child.close(null)); };
    children.push(child);
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('auto-detected language: en (p = 0.99)'));
      signalPhase(name);
      if (pause !== name) child.close(0);
    });
    return child;
  }
  const res = new EventEmitter();
  Object.assign(res, { writableEnded: false, destroyed: false, statusCode: 200,
    setHeader() {}, status(code) { this.statusCode = code; return this; },
    json(value) { calls.writes++; this.payload = value; this.writableEnded = true; return this; },
  });
  const req = new EventEmitter();
  Object.assign(req, { aborted: false, params: { token: 'test-token' },
    body: { index: 1, start: 100, dur: 30, order, includeWav: true } });
  const context = vm.createContext({
    Buffer, crypto, performance, AbortController, setTimeout, clearTimeout,
    console: { warn() {}, log() {}, info() {} },
    app: { post(_path, _auth, callback) { handler = callback; } },
    requireGatewayAuth() {}, GATEWAY_TOKEN: 'fake-gateway',
    verifyRawToken: () => ({ scope: 'lid-benchmark', exp: Math.ceil(Date.now()/1000)+60,
      uid: 'fixture', url: 'https://provider.invalid/movie/test/password/1.mkv' }),
    WHISPER_BIN: '/fake/whisper', WHISPER_MODEL: '/fake/model', WHISPER_THREADS: 2,
    WHISPER_TIMEOUT_MS: 500, FFMPEG_USER_AGENT: 'fixture', GATEWAY_VERSION: 167,
    WHISPER_MODEL_NAME: 'small', WHISPER_CPP_COMMIT: 'fixture',
    WHISPER_BIN_SHA256: 'fixture', WHISPER_MODEL_SHA256: 'fixture',
    WHISPER_RUNTIME_VERIFIED: true, LID_BENCHMARK_INSTANCE: 'fixture',
    LID_BENCHMARK_WAV_MAX_BYTES: 2*1024*1024, LID_BENCHMARK_WAV_BASE64_MAX_CHARS: 3*1024*1024,
    lidBenchmarkBusy: false, whisperInferenceActive: 0,
    lidProductionCpuBusy: () => false, activeSessionCount: () => viewer ? 1 : 0,
    rawPumps: new Set(), viewerPlaybackActiveLocally: () => viewer,
    accountJobKey: () => 'fixture-key', proxyKeyFromUrl: () => 'fixture-key', sha256Hex: () => 'fixture',
    isAccountJobBusy: () => false, accountSlotBusyLocally: () => viewer,
    withAccountJobLock: async (_key, fn) => fn(),
    extractAudioWav: async (...args) => {
      calls.extract++; selectedSignal = args[8]; signalPhase('extract');
      if (pause === 'extract') await new Promise(resolve => {
        activeExtraction = resolve;
        selectedSignal?.addEventListener('abort', resolve, { once: true });
      });
      if (selectedSignal?.aborted) return { ok: false, aborted: true };
      return extractFailure || { ok: true, path: '/fixture/sample.wav' };
    },
    fsp: { stat: async () => ({ size: wav.length }),
      readFile: async name => name.endsWith('.txt') ? 'hello actual fixture words here' : wav,
      unlink: async name => { removed.push(name); } },
    readContainerCpuUsageMs: async () => 0, os: { loadavg: () => [0,0,0] },
    detectLanguageFromText: () => ({ confident: true, lang: 'en', words: 5 }),
    spawn,
    runWhisperDetectOnly: options => runWhisperDetectOnly({ ...options, spawnImpl: spawn }),
    registerPreemptibleBackgroundWhisper: (_key, child) => {
      const entry = { child, preempted: false, release: () => registrations.delete(entry) };
      registrations.add(entry);
      if (preemptAtSpawn) { viewer = true; entry.preempted = true; child.kill('SIGKILL'); }
      return entry;
    },
    sanitizeLanguageWavError: () => 'sanitized error',
  });
  vm.runInContext(full + '\n' + route, context);
  const run = () => pending = handler(req, res);
  t.after(async () => {
    activeExtraction?.();
    for (const child of children) child.close(0);
    await pending;
  });
  return { req, res, calls, children, removed, registrations, context, run, phase,
    extractionSignal: () => selectedSignal,
    disconnect() { res.destroyed = true; res.emit('close'); },
    viewerStart() {
      viewer = true;
      for (const entry of registrations) { entry.preempted = true; entry.child.kill('SIGKILL'); }
    },
  };
}

test('benchmark caller close cancels extraction before either inference', async t => {
  const h = harness(t, { pause: 'extract' }); const done = h.run(); await h.phase('extract');
  h.disconnect();
  assert.equal(h.extractionSignal()?.aborted, true);
  await done;
  assert.equal(h.calls.current + h.calls.fast, 0);
  assert.equal(h.calls.writes, 0);
  assert.equal(h.context.lidBenchmarkBusy, false);
});

for (const stage of ['current', 'fast']) {
  for (const event of ['caller-close', 'viewer-start']) {
    test(`benchmark ${event} interrupts ${stage} and does not start comparison`, async t => {
      const h = harness(t, { pause: stage, order: stage === 'fast' ? 'detect-first' : 'current-first' });
      const done = h.run(); await h.phase(stage);
      if (event === 'caller-close') h.disconnect(); else h.viewerStart();
      await done;
      assert(h.children[0].kills > 0);
      assert.equal(h.children.length, 1);
      assert.equal(h.calls.extract, 1);
      assert.equal(h.registrations.size, 0);
      assert.equal(h.context.whisperInferenceActive, 0);
      assert.equal(h.context.lidBenchmarkBusy, false);
      assert(h.removed.includes('/fixture/sample.wav'));
      assert.equal(h.res.listenerCount('close'), 0);
      if (event === 'caller-close') assert.equal(h.calls.writes, 0);
      else { assert.equal(h.res.statusCode, 409); assert.equal(h.res.payload.preempted, true); }
    });
  }
}

test('benchmark viewer spawn race drains the first process and skips the second', async t => {
  const h = harness(t, { preemptAtSpawn: true }); await h.run();
  assert.equal(h.children.length, 1); assert.equal(h.res.statusCode, 409);
  assert.equal(h.registrations.size, 0); assert(h.removed.includes('/fixture/sample.wav'));
});

test('completed benchmark keeps one extraction and both original methods', async t => {
  const h = harness(t); await h.run();
  assert.deepEqual(h.calls, { extract: 1, current: 1, fast: 1, writes: 1 });
  assert.equal(h.res.statusCode, 200);
  assert.equal(h.res.payload.persisted, false);
  assert.equal(h.res.payload.sample.requestedDurationSec, 30);
  assert.equal(h.res.payload.current.candidateLanguage, 'en');
  assert.equal(h.res.payload.detectOnly.candidateLanguage, 'en');
  assert.equal(h.registrations.size, 0);
  assert.equal(h.res.listenerCount('close'), 0);
  assert(h.removed.includes('/fixture/sample.wav'));
});

test('extraction timeout is not mistaken for viewer preemption or retried', async t => {
  const h = harness(t, { extractFailure: { ok: false, timedOut: true, error: 'timeout' } });
  await h.run();
  assert.equal(h.res.statusCode, 502); assert.notEqual(h.res.payload.preempted, true);
  assert.equal(h.calls.extract, 1); assert.equal(h.children.length, 0);
  assert.equal(h.context.lidBenchmarkBusy, false);
});
