'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const {
  POLICY_VERSION,
  PROTOCOL_VERSION,
  ROUTES,
  calibratedAgreement,
  calibrationFromEnv,
  fullFallbackLanguage,
  routeConfidence,
  whisperTiebreakLanguage,
} = require('../services/lid-benchmark-worker/production-policy');
const {
  parsePcm16MonoWav,
  encodePcm16Wav,
} = require('../services/lid-benchmark-worker/vad-worker');
const {
  parseWhisperLid,
  runWhisperFull,
  transcriptMetrics,
} = require('../services/lid-benchmark-worker/whisper-runner');

test('production protocol and policy are closed allowlists', () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(POLICY_VERSION, 'lid-cascade-v1');
  assert.deepEqual(ROUTES, [
    'fast-consensus',
    'whisper-tiebreak',
    'full-transcript-fallback',
    'pending-no-speech',
    'pending-disagreement',
  ]);
});

test('fast consensus is disabled without a complete calibration', () => {
  const missingRevision = calibrationFromEnv({
    LID_ECAPA_MIN_PROBABILITY: '0.8',
    LID_ECAPA_MIN_MARGIN: '0.15',
    LID_ECAPA_MAX_ENTROPY: '2.5',
  });
  assert.equal(missingRevision.fastEligible, false);
  assert.equal(calibratedAgreement(
    {
      ok: true,
      candidateLanguage: 'fr',
      probability: 0.99,
      margin: 0.8,
      entropy: 0.1,
    },
    { ok: true, lang: 'fr' },
    missingRevision,
  ), null);

  const complete = calibrationFromEnv({
    LID_CALIBRATION_REVISION: 'norva-human-v1',
    LID_ECAPA_MIN_PROBABILITY: '0.8',
    LID_ECAPA_MIN_MARGIN: '0.15',
    LID_ECAPA_MAX_ENTROPY: '2.5',
  });
  assert.equal(complete.fastEligible, true);
  assert.equal(calibratedAgreement(
    {
      ok: true,
      candidateLanguage: 'fr',
      probability: 0.91,
      margin: 0.21,
      entropy: 1.2,
    },
    { ok: true, lang: 'fr' },
    complete,
  ), 'fr');
});

test('Whisper detect-only breaks ties only at 0.95 and by joining an engine', () => {
  const calibration = calibrationFromEnv({
    LID_CALIBRATION_REVISION: 'norva-human-v1',
    LID_ECAPA_MIN_PROBABILITY: '0.8',
    LID_ECAPA_MIN_MARGIN: '0.15',
    LID_ECAPA_MAX_ENTROPY: '2.5',
  });
  const ecapa = { ok: true, candidateLanguage: 'it' };
  const sherpa = { ok: true, lang: 'fr' };
  assert.equal(
    whisperTiebreakLanguage({ ok: true, lang: 'it', prob: 0.95 }, ecapa, sherpa, calibration),
    'it',
  );
  assert.equal(
    whisperTiebreakLanguage({ ok: true, lang: 'it', prob: 0.949 }, ecapa, sherpa, calibration),
    null,
  );
  assert.equal(
    whisperTiebreakLanguage({ ok: true, lang: 'de', prob: 0.99 }, ecapa, sherpa, calibration),
    null,
  );
});

test('full fallback requires language probability and bounded lexical evidence', () => {
  assert.equal(fullFallbackLanguage({
    ok: true,
    lang: 'it',
    prob: 0.88,
    wordCount: 8,
    uniqueWordCount: 6,
  }), 'it');
  assert.equal(fullFallbackLanguage({
    ok: true,
    lang: 'it',
    prob: 0.88,
    wordCount: 3,
    uniqueWordCount: 3,
  }), null);
  assert.equal(fullFallbackLanguage({
    ok: true,
    lang: 'it',
    prob: 0.74,
    wordCount: 8,
    uniqueWordCount: 6,
  }), null);
});

test('route confidence comes from the engine that selected the auditable route', () => {
  const ecapa = { probability: 0.91 };
  const detect = { prob: 0.96 };
  const full = { prob: 0.82 };
  assert.equal(routeConfidence('fast-consensus', ecapa, detect, full), 0.91);
  assert.equal(routeConfidence('whisper-tiebreak', ecapa, detect, full), 0.96);
  assert.equal(routeConfidence('full-transcript-fallback', ecapa, detect, full), 0.82);
  assert.equal(routeConfidence('pending-disagreement', ecapa, detect, full), null);
  assert.equal(routeConfidence('pending-no-speech', ecapa, detect, full), null);
});

test('VAD output encoder produces exact mono 16 kHz PCM16 and keeps no text', () => {
  const samples = new Float32Array(4 * 16_000);
  samples.fill(0.25);
  const wav = encodePcm16Wav(samples);
  const parsed = parsePcm16MonoWav(wav, 35);
  assert.equal(parsed.audioSeconds, 4);
  assert.equal(parsed.bytes, 128_000);

  const metrics = transcriptMetrics('ciao mondo, ciao ancora');
  assert.deepEqual(metrics, { wordCount: 4, uniqueWordCount: 3 });
  assert.equal(Object.hasOwn(metrics, 'text'), false);
  assert.deepEqual(
    parseWhisperLid('whisper: auto-detected language: it (p = 0.9700)'),
    { lang: 'it', prob: 0.97 },
  );
});

test('full Whisper fallback returns lexical evidence but never the transcript', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-whisper-test-'));
  const wavPath = path.join(tempRoot, 'speech.wav');
  let outputPath = null;
  const spawnImpl = (_bin, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const outputPrefix = args[args.indexOf('-of') + 1];
    outputPath = `${outputPrefix}.txt`;
    setImmediate(async () => {
      await fsp.writeFile(outputPath, 'ciao mondo ciao ancora', 'utf8');
      child.stderr.write('auto-detected language: it (p = 0.9700)');
      child.stderr.end();
      child.stdout.end();
      child.emit('close', 0);
    });
    return child;
  };
  try {
    const result = await runWhisperFull({
      bin: '/fake/whisper-cli',
      model: '/fake/ggml-small.bin',
      wavPath,
      threads: 2,
      timeoutMs: 1000,
      spawnImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.lang, 'it');
    assert.equal(result.prob, 0.97);
    assert.equal(result.wordCount, 4);
    assert.equal(result.uniqueWordCount, 3);
    assert.equal(Object.hasOwn(result, 'text'), false);
    await assert.rejects(fsp.stat(outputPath), { code: 'ENOENT' });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('server implements strict raw-WAV metadata, bounded queue and complete cascade', () => {
  const server = read('services', 'lid-benchmark-worker', 'server.js');
  const runner = read('services', 'lid-benchmark-worker', 'whisper-runner.js');

  assert.match(server, /process\.env\.LID_WORKER_TOKEN[\s\S]*LID_BENCHMARK_WORKER_TOKEN/);
  assert.match(server, /app\.get\('\/livez'/);
  assert.match(server, /app\.get\('\/readyz'/);
  assert.match(server, /app\.post\(\s*'\/v1\/classify'/);
  assert.match(server, /x-norva-sample-sha256/);
  assert.match(server, /x-norva-lid-attempt/);
  assert.match(server, /x-norva-lid-policy/);
  assert.match(server, /x-norva-lid-mode/);
  assert.match(server, /parsePcm16MonoWav\(req\.body, 35\)/);
  assert.match(server, /new Set\(\['shadow', 'canary', 'primary'\]\)/);
  assert.match(server, /class BoundedSerialQueue/);
  assert.match(server, /new BoundedSerialQueue\(MAX_QUEUE\)/);
  assert.match(server, /\[ecapaCall, sherpaCall\] = await Promise\.all\(\[/);
  assert.match(server, /runWhisperDetectOnly\(\{/);
  assert.match(server, /runWhisperFull\(\{/);
  assert.match(server, /if \(mode === 'shadow'\) await ensureFull\(\)/);
  assert.match(server, /await Promise\.allSettled\(\[\s*wipeAndUnlink\(inputPath\),\s*wipeAndUnlink\(speechPath\)/);
  assert.match(server, /verified: false/);
  assert.match(server, /persisted: false/);
  assert.match(server, /confidence: routeConfidence\(/);
  assert.doesNotMatch(server, /\btranscript\s*:/);
  assert.doesNotMatch(runner, /\btext\s*:\s*text\b/);
});

test('production image and compose pin models and isolate the runtime', () => {
  const fetcher = read('services', 'lid-benchmark-worker', 'fetch_models.py');
  const dockerfile = read('services', 'lid-benchmark-worker', 'Dockerfile');
  const compose = read('ops', 'hetzner', 'docker-compose.lid.yml');

  assert.match(fetcher, /9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6/);
  assert.match(fetcher, /"bytes": 643_854/);
  assert.match(fetcher, /asr-models\/silero_vad\.onnx/);
  assert.match(dockerfile, /WHISPER_MODEL=small/);
  assert.match(dockerfile, /WHISPER_CPP_COMMIT=080bbbe85230f624f0b52127f1ae1218247989f9/);
  assert.match(dockerfile, /WHISPER_MODEL_SHA256=1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b/);
  assert.match(dockerfile, /sha256sum --check --strict/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/readyz/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /LID_MAX_QUEUE: \$\{LID_MAX_QUEUE:-1\}/);
  assert.match(compose, /LID_REQUEST_TIMEOUT_MS: \$\{LID_REQUEST_TIMEOUT_MS:-20000\}/);
  assert.match(compose, /LID_WHISPER_DETECT_TIMEOUT_MS: \$\{LID_WHISPER_DETECT_TIMEOUT_MS:-15000\}/);
  assert.match(compose, /LID_WHISPER_FULL_TIMEOUT_MS: \$\{LID_WHISPER_FULL_TIMEOUT_MS:-45000\}/);
  assert.match(compose, /LID_VAD_TIMEOUT_MS: \$\{LID_VAD_TIMEOUT_MS:-15000\}/);
  assert.match(compose, /mem_limit: 3g/);
  assert.match(compose, /cpus: 2\.0/);
  assert.match(compose, /WHISPER_MODEL_SHA256: 1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /external: true[\s\S]*name: norva_default/);
  assert.doesNotMatch(compose, /\bports:/);
});
