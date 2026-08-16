const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildWhisperBatchArgs,
  cleanupStrictLidFiles,
  parseWhisperBatchLid,
  resolveStrictLidConsensus,
  runWhisperBatchProcess,
} = require('../services/media-gateway/src/strict-lid-batch');

class FakeChild extends EventEmitter {
  constructor({ closeOnKill = true } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = [];
    this.closeOnKill = closeOnKill;
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.closeOnKill) setImmediate(() => this.emit('close', null));
    return true;
  }
}

function sixPaths(prefix) {
  return Array.from({ length: 6 }, (_, index) => `/tmp/${prefix}-${index}.wav`);
}

function languageLines(languages) {
  return languages.map(({ lang, prob }) => (
    `whisper_full_with_state: auto-detected language: ${lang} (p = ${prob})`
  )).join('\n');
}

test('strict batch builds ordered multi -f/-of args and accepts exactly six ordered LID lines', () => {
  const wavPaths = sixPaths('sample');
  const outputPrefixes = sixPaths('out').map((file) => file.replace(/\.wav$/, ''));
  const args = buildWhisperBatchArgs({
    model: '/opt/whisper/model.bin',
    wavPaths,
    outputPrefixes,
    threads: 4,
  });

  assert.deepEqual(
    args.filter((value, index) => args[index - 1] === '-f'),
    wavPaths,
  );
  assert.deepEqual(
    args.filter((value, index) => args[index - 1] === '-of'),
    outputPrefixes,
  );
  assert.equal(args.filter((value) => value === '-f').length, 6);
  assert.equal(args.filter((value) => value === '-of').length, 6);

  const parsed = parseWhisperBatchLid(languageLines([
    { lang: 'fr', prob: 0.99 },
    { lang: 'en', prob: 0.98 },
    { lang: 'es', prob: 0.97 },
    { lang: 'it', prob: 0.96 },
    { lang: 'de', prob: 0.95 },
    { lang: 'pt', prob: 0.94 },
  ]), 6);
  assert.deepEqual(parsed.map((sample) => sample.lang), ['fr', 'en', 'es', 'it', 'de', 'pt']);
  assert.equal(parseWhisperBatchLid(languageLines([{ lang: 'fr', prob: 0.99 }]), 6), null);
  assert.equal(parseWhisperBatchLid(`${languageLines(Array.from({ length: 6 }, () => ({ lang: 'fr', prob: 0.99 })))}\nauto-detected language: fr (p = 0.99)`, 6), null);
  assert.equal(parseWhisperBatchLid(`${languageLines(Array.from({ length: 6 }, () => ({ lang: 'fr', prob: 0.99 })))}\nauto-detected language: broken`, 6), null);
});

test('strict batch spawns Whisper once, preserves six transcript/LID pairs, and cleans every output', async () => {
  const wavPaths = sixPaths('ordered');
  const outputPrefixes = sixPaths('ordered-out').map((file) => file.replace(/\.wav$/, ''));
  const languages = [
    { lang: 'fr', prob: 0.991 },
    { lang: 'en', prob: 0.992 },
    { lang: 'es', prob: 0.993 },
    { lang: 'it', prob: 0.994 },
    { lang: 'de', prob: 0.995 },
    { lang: 'pt', prob: 0.996 },
  ];
  const transcriptByPath = new Map(outputPrefixes.map((prefix, index) => (
    [`${prefix}.txt`, `transcript-${index}`]
  )));
  const unlinked = [];
  const spawnCalls = [];
  const child = new FakeChild();
  const resultPromise = runWhisperBatchProcess({
    bin: '/usr/local/bin/whisper-cli',
    model: '/opt/whisper/model.bin',
    wavPaths,
    outputPrefixes,
    threads: 4,
    timeoutMs: 1000,
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return child;
    },
    readFileImpl: async (filePath) => {
      if (!transcriptByPath.has(filePath)) throw new Error('missing');
      return transcriptByPath.get(filePath);
    },
    unlinkImpl: async (filePath) => { unlinked.push(filePath); },
  });
  setImmediate(() => {
    child.stderr.emit('data', Buffer.from(languageLines(languages)));
    child.emit('close', 0);
  });

  const result = await resultPromise;
  assert.equal(spawnCalls.length, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.samples.map((sample) => sample.lang), languages.map((sample) => sample.lang));
  assert.deepEqual(result.samples.map((sample) => sample.text), Array.from({ length: 6 }, (_, index) => `transcript-${index}`));
  assert.deepEqual(unlinked.sort(), outputPrefixes.map((prefix) => `${prefix}.txt`).sort());
});

test('strict consensus verifies four strong plus two weak samples but one strong conflict vetoes', () => {
  const accepted = Array.from({ length: 4 }, (_, index) => ({
    disposition: 'accepted',
    result: {
      offset: index * 600,
      language: 'fr',
      confidence: 0.99,
      wordCount: 20 + index,
      uniqueWordCount: 15,
      transcriptAgrees: true,
    },
  }));
  const weak = Array.from({ length: 2 }, (_, index) => ({
    disposition: 'weak',
    result: {
      offset: 3000 + index * 60,
      language: null,
      confidence: 0.82,
      wordCount: 18,
      uniqueWordCount: 12,
      transcriptAgrees: null,
    },
  }));
  const verified = resolveStrictLidConsensus([...accepted, ...weak], 4);
  assert.equal(verified.verified, true);
  assert.equal(verified.language, 'fr');
  assert.equal(verified.acceptedSamples.length, 4);
  assert.equal(verified.ignoredWeakSpeechSampleCount, 2);
  assert.equal(verified.rejectedSpeechSampleCount, 0);

  const vetoed = resolveStrictLidConsensus([
    ...accepted,
    weak[0],
    {
      disposition: 'conflict',
      result: {
        offset: 3060,
        language: null,
        confidence: 0.99,
        wordCount: 24,
        uniqueWordCount: 16,
        transcriptAgrees: false,
      },
    },
  ], 4);
  assert.equal(vetoed.verified, false);
  assert.equal(vetoed.language, null);
  assert.equal(vetoed.rejectedSpeechSampleCount, 1);
});

test('missing auto-detected line fails the whole batch closed with six empty results', async () => {
  const wavPaths = sixPaths('missing-line');
  const outputPrefixes = sixPaths('missing-line-out').map((file) => file.replace(/\.wav$/, ''));
  const child = new FakeChild();
  const resultPromise = runWhisperBatchProcess({
    bin: 'whisper-cli',
    model: 'model.bin',
    wavPaths,
    outputPrefixes,
    threads: 4,
    timeoutMs: 1000,
    spawnImpl: () => child,
    readFileImpl: async () => 'must not be read',
    unlinkImpl: async () => {},
  });
  setImmediate(() => {
    child.stderr.emit('data', Buffer.from(languageLines(
      Array.from({ length: 5 }, () => ({ lang: 'fr', prob: 0.99 })),
    )));
    child.emit('close', 0);
  });
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'language output count mismatch');
  assert.equal(result.samples.length, 6);
  assert.ok(result.samples.every((sample) => sample.lang === null && sample.text === ''));
});

test('strict batch bounds timeout, abort and preemption and still cleans output files', async (t) => {
  const wavPaths = sixPaths('stop');
  const outputPrefixes = sixPaths('stop-out').map((file) => file.replace(/\.wav$/, ''));

  await t.test('timeout', async () => {
    const child = new FakeChild();
    const unlinked = [];
    const result = await runWhisperBatchProcess({
      bin: 'whisper-cli', model: 'model.bin', wavPaths, outputPrefixes, threads: 4,
      timeoutMs: 5,
      spawnImpl: () => child,
      unlinkImpl: async (filePath) => { unlinked.push(filePath); },
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(unlinked.length, 6);
  });

  await t.test('abort', async () => {
    const controller = new AbortController();
    const child = new FakeChild();
    const resultPromise = runWhisperBatchProcess({
      bin: 'whisper-cli', model: 'model.bin', wavPaths, outputPrefixes, threads: 4,
      timeoutMs: 1000,
      abortSignal: controller.signal,
      spawnImpl: () => child,
      unlinkImpl: async () => {},
    });
    controller.abort();
    const result = await resultPromise;
    assert.equal(result.aborted, true);
    assert.equal(result.ok, false);
    assert.deepEqual(child.kills, ['SIGKILL']);
  });

  await t.test('viewer preemption', async () => {
    let preempted = false;
    const child = new FakeChild();
    const resultPromise = runWhisperBatchProcess({
      bin: 'whisper-cli', model: 'model.bin', wavPaths, outputPrefixes, threads: 4,
      timeoutMs: 1000,
      spawnImpl: () => child,
      onSpawn: () => { preempted = true; },
      isPreempted: () => preempted,
      unlinkImpl: async () => {},
    });
    setImmediate(() => child.emit('close', null));
    const result = await resultPromise;
    assert.equal(result.preempted, true);
    assert.equal(result.ok, false);
    assert.ok(result.samples.every((sample) => sample.lang === null));
  });
});

test('strict WAV cleanup is ordered-independent and fail-closed on unlink errors', async () => {
  const seen = [];
  await cleanupStrictLidFiles(sixPaths('cleanup'), async (filePath) => {
    seen.push(filePath);
    if (filePath.endsWith('-2.wav')) throw new Error('already gone');
  });
  assert.equal(seen.length, 6);
});

test('v94 route batches strict only inside a 195 s request budget and keeps drain attestations', () => {
  const gateway = fs.readFileSync(
    path.join(__dirname, '../services/media-gateway/src/index.js'),
    'utf8',
  );
  const routeStart = gateway.indexOf('async function handleDetectLanguageRequest(');
  const routeEnd = gateway.indexOf('// Service-only A/B benchmark.', routeStart);
  const route = gateway.slice(routeStart, routeEnd);
  assert.match(gateway, /const GATEWAY_VERSION = 94;/);
  assert.match(gateway, /const STRICT_LID_REQUEST_BUDGET_MS = clampInt\([\s\S]*195_000,[\s\S]*195_000,/);
  assert.match(gateway, /strictLidBatchProtocol: 1/);
  assert.match(gateway, /strictLidRequestBudgetMs: STRICT_LID_REQUEST_BUDGET_MS/);
  assert.match(route, /strictWavSamples\.push\(\{ offset: off, path: wavPath \}\)/);
  assert.match(route, /const batchTimeoutMs = strictWorkDeadlineAt - Date\.now\(\)/);
  assert.match(route, /runStrictWhisperBatch\([\s\S]*strictWavSamples\.map/);
  assert.match(route, /strictLanguageBatchSampleResult\(batch\.samples\[index\], sample\.offset\)/);
  assert.match(route, /providerDrained: true/);
  assert.match(route, /await closeStrictBrokerForResponse\(\)/);
  assert.match(route, /if \(strict\) \{[\s\S]*strictWavSamples\.push[\s\S]*continue;/);
  assert.match(route, /runWhisperDetect\(wavPath, lidBackgroundOptions\)/);
  const terminalAfterExtraction = route.indexOf('if (strictBroker?.terminalError)');
  const budgetAfterExtraction = route.indexOf('if (strictWorkBudgetExpired)', terminalAfterExtraction);
  assert.ok(terminalAfterExtraction >= 0 && budgetAfterExtraction > terminalAfterExtraction,
    'a terminal first 458 must win over a simultaneous strict request timeout');
});
