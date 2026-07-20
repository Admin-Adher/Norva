'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const gateway = fs.readFileSync(
  path.join(root, 'services/media-gateway/src/index.js'),
  'utf8',
);

function sourceBetween(startMarker, endMarker) {
  const start = gateway.indexOf(startMarker);
  const end = gateway.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return gateway.slice(start, end).trim();
}

const backgroundLedgerSource = sourceBetween(
  'const accountBackgroundWhispers',
  '// True while THIS box holds',
);
const detectOnlyRunnerSource = sourceBetween(
  'async function runProductionWhisperDetectOnly',
  '// Run whisper.cpp on a WAV',
);
const whisperRunnerSource = sourceBetween(
  'function runWhisperVtt',
  '// ONE provider-touching background ffmpeg',
);
const lidRunnerSource = sourceBetween(
  'function runWhisperDetect',
  '// whisper hallucinates repetition',
);
const prioritySource = sourceBetween(
  'const JOB_PRIORITY',
  'function insertByPriority',
);
const rawRouteSource = sourceBetween(
  "app.get('/raw/:token'",
  "app.delete('/raw-pumps'",
);
const sessionsRouteSource = sourceBetween(
  "app.post('/sessions'",
  "app.get('/sessions/:id",
);
const chunkedSource = sourceBetween(
  'async function runChunkedTranscription',
  '// Phase 3b translation queue',
);
const lidRouteSource = sourceBetween(
  "app.get('/detect-language/:token'",
  '// Service-only production handoff',
);
const playbackEdge = fs.readFileSync(
  path.join(root, 'supabase/functions/norva-playback/index.ts'),
  'utf8',
);
const untaggedEdgeSource = sourceBetweenFrom(
  playbackEdge,
  'async function detectUntaggedAudioLanguages',
  '// Verify TAGGED-but-contradictory tracks',
);
const taggedEdgeSource = sourceBetweenFrom(
  playbackEdge,
  'async function verifyTaggedAudioLanguages',
  '// Resolve the parent title plus the exact variant codec profile',
);

function sourceBetweenFrom(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end).trim();
}

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stderr = new EventEmitter();
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal);
    return true;
  }
}

function makeHarness({ viewerBusy = false, viewerBusyChecks = null, setPriorityThrows = false } = {}) {
  const children = [];
  const priorityCalls = [];
  const busyChecks = Array.isArray(viewerBusyChecks) ? [...viewerBusyChecks] : null;
  const context = {
    Map,
    Set,
    Number,
    String,
    console: { log() {}, warn() {} },
    clearTimeout,
    setTimeout,
    WHISPER_TRANSCRIBE_TIMEOUT_MS: 60_000,
    WHISPER_TIMEOUT_MS: 60_000,
    WHISPER_DETECT_ONLY_TIMEOUT_MS: 60_000,
    WHISPER_MODEL: '/fake/model.bin',
    WHISPER_BIN: '/fake/whisper',
    WHISPER_THREADS: 2,
    whisperInferenceActive: 0,
    lidDetectOnlyStats: {
      primaryAttempts: 0, shadowAttempts: 0, totalFastMs: 0, failures: 0, timeouts: 0,
    },
    accountKeyBusyLocally() {
      if (busyChecks?.length) return busyChecks.shift();
      return viewerBusy;
    },
    cleanVtt(value) {
      return String(value || '');
    },
    fsp: {
      async readFile(file) {
        if (String(file).endsWith('.txt')) return 'bonjour tout le monde';
        return 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n';
      },
      unlink() {
        return Promise.resolve();
      },
    },
    os: {
      constants: { priority: { PRIORITY_LOW: 19 } },
      setPriority(pid, priority) {
        priorityCalls.push({ pid, priority });
        if (setPriorityThrows) throw new Error('setpriority denied');
      },
    },
    spawn() {
      const child = new FakeChild(1000 + children.length);
      children.push(child);
      return child;
    },
    runWhisperDetectOnly({ onSpawn }) {
      const child = context.spawn();
      onSpawn?.(child);
      return new Promise((resolve) => child.on('close', (code) => resolve({
        ok: code === 0,
        lang: code === 0 ? 'fr' : null,
        prob: code === 0 ? 0.99 : 0,
        timedOut: false,
        error: code === 0 ? null : 'process failed',
      })));
    },
    proxyKeyFromUrl(url) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      return `${parsed.host}/${segments[1] || ''}`;
    },
  };

  const harness = vm.runInNewContext(
    `(() => {
      ${backgroundLedgerSource}
      ${detectOnlyRunnerSource}
      ${lidRunnerSource}
      ${whisperRunnerSource}
      ${prioritySource}
      return {
        accountBackgroundWhispers,
        backgroundWhisperCount,
        preemptAccountBackgroundWhispers,
        runProductionWhisperDetectOnly,
        runWhisperDetect,
        runWhisperVtt,
        whisperOptionsForJob,
        active: () => whisperInferenceActive,
      };
    })()`,
    context,
  );
  return { ...harness, children, priorityCalls };
}

const providerUrl = 'https://provider.test/movie/alice/secret/42.mkv';
const providerKey = 'provider.test/alice';

test('same-account raw playback kills and releases service/pregen Whisper', async () => {
  const harness = makeHarness();
  const options = harness.whisperOptionsForJob({ url: providerUrl, prio: 2 });
  const pending = harness.runWhisperVtt('/tmp/chunk.wav', '', 60_000, options);

  assert.equal(harness.children.length, 1);
  assert.equal(harness.backgroundWhisperCount(), 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.priorityCalls)),
    [{ pid: 1000, priority: 19 }],
  );
  assert.equal(harness.preemptAccountBackgroundWhispers('provider.test/bob', 'other viewer'), 0);
  assert.deepEqual(harness.children[0].killSignals, []);

  assert.equal(harness.preemptAccountBackgroundWhispers(providerKey, 'viewer play'), 1);
  assert.deepEqual(harness.children[0].killSignals, ['SIGKILL']);
  assert.equal(harness.preemptAccountBackgroundWhispers(providerKey, 'parallel range'), 0);
  assert.deepEqual(harness.children[0].killSignals, ['SIGKILL']);
  harness.children[0].emit('close', null);

  const result = await pending;
  assert.equal(result.preempted, true);
  assert.match(result.failReason, /preempted by viewer/i);
  assert.equal(harness.backgroundWhisperCount(), 0);
  assert.equal(harness.active(), 0);
});

test('viewer-origin subtitle Whisper is neither demoted nor preempted', async () => {
  const harness = makeHarness();
  const options = harness.whisperOptionsForJob({ url: providerUrl, prio: 0 });
  const pending = harness.runWhisperVtt('/tmp/chunk.wav', 'en', 60_000, options);

  assert.equal(harness.children.length, 1);
  assert.equal(harness.backgroundWhisperCount(), 0);
  assert.deepEqual(harness.priorityCalls, []);
  assert.equal(harness.preemptAccountBackgroundWhispers(providerKey, 'viewer play'), 0);
  assert.deepEqual(harness.children[0].killSignals, []);

  harness.children[0].emit('close', 0);
  const result = await pending;
  assert.notEqual(result.preempted, true);
  assert.match(result.vtt, /Hello/);
  assert.equal(result.lang, 'en');
  assert.equal(harness.active(), 0);
});

test('background inference does not spawn after playback won the race', async () => {
  const harness = makeHarness({ viewerBusy: true });
  const result = await harness.runWhisperVtt(
    '/tmp/chunk.wav',
    '',
    60_000,
    harness.whisperOptionsForJob({ url: providerUrl, prio: 1 }),
  );

  assert.equal(result.preempted, true);
  assert.equal(harness.children.length, 0);
  assert.equal(harness.backgroundWhisperCount(), 0);
  assert.equal(harness.active(), 0);
});

test('all background Whisper modes lose safely when playback starts at spawn registration', async (t) => {
  const scenarios = [
    {
      name: 'detect-only',
      start: (h, options) => h.runProductionWhisperDetectOnly('/tmp/lid.wav', 'primary', options),
      assertResult(result) {
        assert.equal(result.preempted, true);
        assert.equal(result.lang, null);
        assert.match(result.error, /preempted by viewer/i);
      },
    },
    {
      name: 'full LID',
      start: (h, options) => h.runWhisperDetect('/tmp/lid.wav', options),
      assertResult(result) {
        assert.equal(result.preempted, true);
        assert.equal(result.lang, null);
        assert.equal(result.text, '');
        assert.match(result.error, /preempted by viewer/i);
      },
    },
    {
      name: 'VTT',
      start: (h, options) => h.runWhisperVtt('/tmp/chunk.wav', '', 60_000, options),
      assertResult(result) {
        assert.equal(result.preempted, true);
        assert.equal(result.lang, null);
        assert.match(result.failReason, /preempted by viewer/i);
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      // First check (before spawn) is clear; the post-registration check sees the viewer.
      const harness = makeHarness({ viewerBusyChecks: [false, true] });
      const options = harness.whisperOptionsForJob({ url: providerUrl, prio: 1 });
      const pending = scenario.start(harness, options);

      assert.equal(harness.children.length, 1);
      assert.deepEqual(harness.children[0].killSignals, ['SIGKILL']);
      assert.equal(harness.backgroundWhisperCount(), 1);
      harness.children[0].emit('close', null);

      const result = await pending;
      scenario.assertResult(result);
      assert.equal(harness.backgroundWhisperCount(), 0);
      assert.equal(harness.active(), 0);
    });
  }
});

test('same-account raw playback kills the catalogue full-LID Whisper only', async () => {
  const harness = makeHarness();
  const pending = harness.runWhisperDetect(
    '/tmp/lid.wav',
    harness.whisperOptionsForJob({ url: providerUrl, prio: 1 }),
  );

  assert.equal(harness.children.length, 1);
  assert.equal(harness.backgroundWhisperCount(), 1);
  assert.equal(harness.preemptAccountBackgroundWhispers('provider.test/bob', 'other viewer'), 0);
  assert.deepEqual(harness.children[0].killSignals, []);

  assert.equal(harness.preemptAccountBackgroundWhispers(providerKey, 'same viewer'), 1);
  assert.deepEqual(harness.children[0].killSignals, ['SIGKILL']);
  harness.children[0].emit('close', null);

  const result = await pending;
  assert.equal(result.preempted, true);
  assert.equal(result.lang, null);
  assert.equal(result.text, '');
  assert.match(result.error, /preempted by viewer/i);
  assert.equal(harness.backgroundWhisperCount(), 0);
  assert.equal(harness.active(), 0);
});

test('OS priority is best-effort and cannot fail a background transcription', async () => {
  const harness = makeHarness({ setPriorityThrows: true });
  const pending = harness.runWhisperVtt(
    '/tmp/chunk.wav',
    'fr',
    60_000,
    harness.whisperOptionsForJob({ url: providerUrl, prio: 1 }),
  );

  harness.children[0].emit('close', 0);
  const result = await pending;
  assert.match(result.vtt, /Hello/);
  assert.equal(result.lang, 'fr');
  assert.equal(harness.backgroundWhisperCount(), 0);
});

test('both interactive playback lanes preempt same-account background Whisper', () => {
  assert.match(
    rawRouteSource,
    /preemptAccountBackgroundWhispers\(pumpProxyKey,\s*rawPlaybackReason\)/,
  );
  assert.match(
    sessionsRouteSource,
    /preemptAccountBackgroundWhispers\(playbackProxyKey,\s*'transcode session start'\)/,
  );
});

test('chunked background transcription stops after extraction or inference preemption', () => {
  assert.match(
    chunkedSource,
    /extractionSettled\s*&&\s*extractionResult\.preempted/,
  );
  assert.match(
    chunkedSource,
    /runWhisperVtt\([\s\S]*whisperOptionsForJob\(job\)/,
  );
  assert.match(
    chunkedSource,
    /if \(w\.preempted\)[\s\S]*return \{ jobId, requeue: true \}/,
  );
});

test('catalogue LID preemption is retryable and cannot become writable language evidence', () => {
  assert.match(
    lidRouteSource,
    /runProductionWhisperDetectOnly\([\s\S]*lidBackgroundOptions/,
  );
  assert.match(
    lidRouteSource,
    /runWhisperDetect\(wavPath,\s*lidBackgroundOptions\)/,
  );
  assert.match(
    lidRouteSource,
    /if \(inferencePreempted\)[\s\S]*status\(409\)[\s\S]*code:\s*'viewer_preempted'[\s\S]*retryable:\s*true/,
  );

  // Both Edge consumers leave their exact-file cursor untouched for a non-2xx gateway result.
  // The attempted timestamp and basicLidEvidence parsing are reached only after this guard.
  for (const edgeSource of [untaggedEdgeSource, taggedEdgeSource]) {
    const transportGuard = edgeSource.indexOf('if (!res.ok)');
    const evidenceRead = edgeSource.indexOf('const evidence = basicLidEvidence(det)');
    assert.notEqual(transportGuard, -1);
    assert.notEqual(evidenceRead, -1);
    assert.ok(transportGuard < evidenceRead);
  }
  assert.ok(
    untaggedEdgeSource.indexOf('if (!res.ok) continue') <
      untaggedEdgeSource.indexOf('track.lidAttemptedAt = nowIso'),
  );
  assert.ok(
    taggedEdgeSource.indexOf('if (!res.ok) { transient++; continue; }') <
      taggedEdgeSource.indexOf('t.speechVerifiedAt = nowIso'),
  );
});
