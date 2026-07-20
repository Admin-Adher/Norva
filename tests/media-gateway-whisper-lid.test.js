const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildWhisperDetectOnlyArgs,
  parseWhisperLid,
  runWhisperDetectOnly,
} = require('../services/media-gateway/src/whisper-lid');

test('parseWhisperLid accepts official whisper.cpp output and 3-letter codes', () => {
  assert.deepEqual(
    parseWhisperLid('whisper_full_with_state: auto-detected language: it (p = 0.998164)\r\n'),
    { lang: 'it', prob: 0.998164 },
  );
  assert.deepEqual(
    parseWhisperLid('noise\nAUTO-DETECTED LANGUAGE: YUE (p=.98)\nmore noise'),
    { lang: 'yue', prob: 0.98 },
  );
  assert.deepEqual(
    parseWhisperLid('auto-detected language: haw (p = 1e+0)'),
    { lang: 'haw', prob: 1 },
  );
});

test('parseWhisperLid fails closed on invalid or conflicting output', () => {
  assert.equal(parseWhisperLid('no language here'), null);
  assert.equal(parseWhisperLid('auto-detected language: en (p = nan)'), null);
  assert.equal(parseWhisperLid('auto-detected language: en (p = 1.2)'), null);
  assert.equal(parseWhisperLid('auto-detected language: en (p = -0.1)'), null);
  assert.equal(
    parseWhisperLid(
      'auto-detected language: en (p = 0.8)\nauto-detected language: fr (p = 0.9)',
    ),
    null,
  );
});

test('detect-only arguments request LID without transcription artifacts', () => {
  const args = buildWhisperDetectOnlyArgs({
    model: '/models/small.bin',
    wavPath: '/tmp/sample.wav',
    threads: 4,
  });
  assert.deepEqual(args, [
    '-m', '/models/small.bin',
    '-f', '/tmp/sample.wav',
    '-l', 'auto',
    '-dl',
    '-t', '4',
  ]);
  assert.equal(args.includes('-otxt'), false);
  assert.equal(args.includes('-of'), false);
  assert.equal(args.includes('-nt'), false);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCount = 0;
  child.kill = () => { child.killCount += 1; };
  return child;
}

test('runWhisperDetectOnly parses chunked stderr and exposes the exact CLI args', async () => {
  const child = fakeChild();
  let spawnCall = null;
  let spawnedChild = null;
  const resultPromise = runWhisperDetectOnly({
    bin: '/bin/whisper-cli',
    model: '/models/small.bin',
    wavPath: '/tmp/sample.wav',
    threads: 6,
    timeoutMs: 1000,
    spawnImpl: (...args) => {
      spawnCall = args;
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('auto-detected lang'));
        child.stderr.emit('data', Buffer.from('uage: fr (p = 0.973)\n'));
        child.emit('close', 0);
      });
      return child;
    },
    onSpawn: (value) => {
      spawnedChild = value;
    },
  });
  const result = await resultPromise;
  assert.equal(spawnedChild, child);
  assert.equal(spawnCall[0], '/bin/whisper-cli');
  assert.deepEqual(spawnCall[1], [
    '-m', '/models/small.bin',
    '-f', '/tmp/sample.wav',
    '-l', 'auto',
    '-dl',
    '-t', '6',
  ]);
  assert.deepEqual(result, {
    ok: true,
    lang: 'fr',
    prob: 0.973,
    code: 0,
    timedOut: false,
    error: null,
  });
});

test('runWhisperDetectOnly fails closed on process errors and timeout', async () => {
  const nonZero = fakeChild();
  const nonZeroPromise = runWhisperDetectOnly({
    bin: 'whisper',
    model: 'model',
    wavPath: 'sample',
    threads: 1,
    timeoutMs: 1000,
    spawnImpl: () => {
      queueMicrotask(() => {
        nonZero.stderr.emit('data', Buffer.from('auto-detected language: en (p = 0.99)'));
        nonZero.emit('close', 2);
      });
      return nonZero;
    },
  });
  assert.deepEqual(await nonZeroPromise, {
    ok: false,
    lang: null,
    prob: 0,
    code: 2,
    timedOut: false,
    error: 'exit 2',
  });

  const timedOut = fakeChild();
  const timeoutResult = await runWhisperDetectOnly({
    bin: 'whisper',
    model: 'model',
    wavPath: 'sample',
    threads: 1,
    timeoutMs: 1,
    spawnImpl: () => timedOut,
    setTimer: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
    clearTimer: () => {},
  });
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.timedOut, true);
  assert.equal(timedOut.killCount, 1);
});

test('a timed-out detect-only process must close before the comparison can continue', async () => {
  const child = fakeChild();
  const timers = [];
  let resolved = false;
  const resultPromise = runWhisperDetectOnly({
    bin: 'whisper',
    model: 'model',
    wavPath: 'sample',
    threads: 1,
    timeoutMs: 10,
    spawnImpl: () => child,
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => {},
  }).then((result) => {
    resolved = true;
    return result;
  });

  timers[0]();
  await Promise.resolve();
  assert.equal(child.killCount, 1);
  assert.equal(resolved, false);

  child.emit('close', null);
  const result = await resultPromise;
  assert.equal(result.timedOut, true);
  assert.equal(result.error, 'timeout');
});

test('production detect-only is signed-scope only, non-strict and falls back on the same WAV', () => {
  const root = path.join(__dirname, '..');
  const gateway = fs.readFileSync(
    path.join(root, 'services/media-gateway/src/index.js'),
    'utf8',
  );
  const routeStart = gateway.indexOf("app.get('/detect-language/:token'");
  const routeEnd = gateway.indexOf('// Service-only A/B benchmark.', routeStart);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);
  const route = gateway.slice(routeStart, routeEnd);

  assert.match(gateway, /const GATEWAY_VERSION = 76/);
  assert.match(gateway, /const LID_DETECT_ONLY_SCOPE = 'lid-production-detect-only'/);
  assert.match(gateway, /const LID_SHADOW_SCOPE = 'lid-shadow'/);
  assert.match(
    route,
    /const detectOnlyMode = !strict && WHISPER_DETECT_ONLY_PRODUCTION_AVAILABLE/,
  );
  assert.match(route, /claims\.scope === LID_DETECT_ONLY_SCOPE[\s\S]*\? 'primary'/);
  assert.match(route, /claims\.scope === LID_SHADOW_SCOPE \? 'shadow' : 'off'/);
  assert.match(route, /if \(detectOnlyMode !== 'off'\) \{/);

  // Only primary may short-circuit. Shadow always proceeds to the historical
  // transcription result and merely appends diagnostics.
  assert.match(route, /if \(detectOnlyMode === 'primary' && fastEligible\) \{/);
  assert.match(route, /if \(!result\) \{[\s\S]*runWhisperDetect\(wavPath,\s*lidBackgroundOptions\)/);
  assert.match(
    route,
    /runProductionWhisperDetectOnly\([\s\S]*wavPath,[\s\S]*detectOnlyMode,[\s\S]*lidBackgroundOptions[\s\S]*runWhisperDetect\(wavPath,\s*lidBackgroundOptions\)/,
  );
  assert.match(route, /if \(detectOnlyMode === 'shadow' && fast\) \{/);
  assert.match(
    route,
    /const fullLanguage = result\.confident === true[\s\S]*Number\(result\.wordCount \|\| 0\) >= 4/,
  );
  assert.match(route, /result\.detectOnlyShadow = \{/);
  assert.match(
    route,
    /Diagnostic only:[\s\S]*language\/method\/wordCount returned above remain[\s\S]*historical transcription path/,
  );

  // The accepted fast response is deliberately a non-certifying LID contract.
  for (const field of [
    "method: 'whisper-detect-only-v1'",
    "evidence: 'lid-only-high-confidence'",
    "acceptanceBasis: 'whisper-lid-probability'",
    'fastPathAccepted: true',
    'confident: true',
    'verified: false',
    "validationStatus: 'pending'",
    'fallbackUsed: false',
    'wordCount: 0',
    'uniqueWordCount: 0',
  ]) {
    assert.ok(route.includes(field), `missing explicit fast-contract field: ${field}`);
  }
  assert.match(
    gateway,
    /const WHISPER_DETECT_ONLY_MIN_PROBABILITY = Math\.min\([\s\S]*Math\.max\(0\.95,/,
  );
  assert.match(
    route,
    /Number\(fast\.prob \|\| 0\) >= WHISPER_DETECT_ONLY_MIN_PROBABILITY/,
  );
  assert.match(
    route,
    /result\.fastPathAccepted === true \|\| Number\(result\.wordCount \|\| 0\) >= 4/,
  );

  // Strict mode cannot enter either detect-only scope and retains the stronger,
  // multi-window full-transcript consensus.
  assert.match(route, /const detectOnlyMode = !strict/);
  assert.match(route, /const offsets =[\s\S]*strict \? WHISPER_STRICT_OFFSETS : WHISPER_SWEEP_OFFSETS/);
  assert.match(route, /strictSamples\.length >= consensusNeeded/);
  assert.match(route, /strictRejectedSpeechSamples === 0/);
  assert.match(route, /method: strict[\s\S]*\? 'whisper-strict-consensus-v4'/);
});

test('production LID health exposes the kill switch, threshold and bounded rollout counters', () => {
  const root = path.join(__dirname, '..');
  const gateway = fs.readFileSync(
    path.join(root, 'services/media-gateway/src/index.js'),
    'utf8',
  );
  const healthStart = gateway.indexOf("app.get('/health'");
  const healthEnd = gateway.indexOf("app.get('/debug/failures'", healthStart);
  assert.notEqual(healthStart, -1);
  assert.notEqual(healthEnd, -1);
  const health = gateway.slice(healthStart, healthEnd);

  assert.match(
    gateway,
    /const WHISPER_DETECT_ONLY_PRODUCTION_AVAILABLE =[\s\S]*WHISPER_DETECT_ONLY_PRODUCTION_AVAILABLE[\s\S]*=== 'true'/,
  );
  assert.match(health, /version: GATEWAY_VERSION/);
  assert.match(health, /detectOnlyProductionAvailable: WHISPER_DETECT_ONLY_PRODUCTION_AVAILABLE/);
  assert.match(health, /detectOnlyMinProbability: WHISPER_DETECT_ONLY_MIN_PROBABILITY/);
  assert.match(health, /detectOnlyTimeoutMs: WHISPER_DETECT_ONLY_TIMEOUT_MS/);
  assert.match(health, /lidDetectOnlyStats: \{/);
  assert.match(health, /\.\.\.lidDetectOnlyStats/);
  assert.match(
    health,
    /averageFastMs:[\s\S]*lidDetectOnlyStats\.primaryAttempts \+ lidDetectOnlyStats\.shadowAttempts/,
  );
  assert.match(health, /shadowAgreementRate:[\s\S]*lidDetectOnlyStats\.shadowAgreements/);
  assert.match(health, /primaryAcceptanceRate:[\s\S]*lidDetectOnlyStats\.primaryAccepted/);

  const statsStart = gateway.indexOf('const lidDetectOnlyStats = {');
  const statsEnd = gateway.indexOf('\n};', statsStart);
  assert.notEqual(statsStart, -1);
  assert.notEqual(statsEnd, -1);
  const stats = gateway.slice(statsStart, statsEnd);
  for (const counter of [
    'primaryAttempts',
    'primaryAccepted',
    'primaryFallbacks',
    'shadowAttempts',
    'shadowEligible',
    'shadowAgreements',
    'shadowDisagreements',
    'shadowNoFullVerdict',
    'failures',
    'timeouts',
    'totalFastMs',
    'shadowFullRuns',
    'shadowFullMs',
    'fallbackFullRuns',
    'fallbackFullMs',
    'last',
  ]) {
    assert.match(stats, new RegExp(`\\b${counter}:`), `missing health counter ${counter}`);
  }
});

test('LID benchmark is service-only, scoped, read-only and reproducibly pinned', () => {
  const root = path.join(__dirname, '..');
  const gateway = fs.readFileSync(
    path.join(root, 'services/media-gateway/src/index.js'),
    'utf8',
  );
  const playback = fs.readFileSync(
    path.join(root, 'supabase/functions/norva-playback/index.ts'),
    'utf8',
  );
  const dockerfile = fs.readFileSync(
    path.join(root, 'services/media-gateway/Dockerfile'),
    'utf8',
  );
  const runner = fs.readFileSync(
    path.join(root, 'ops/hetzner/scripts/17-run-lid-benchmark.sh'),
    'utf8',
  );
  const flagMigration = fs.readFileSync(
    path.join(root, 'supabase/migrations/20260719210000_lid_benchmark_flag.sql'),
    'utf8',
  );

  assert.match(
    gateway,
    /app\.post\('\/benchmark-language\/:token', requireGatewayAuth/,
  );
  assert.match(gateway, /claims\.scope !== 'lid-benchmark'/);
  assert.match(gateway, /persisted: false/);
  assert.match(gateway, /detectOnlyBenchmark: true/);
  assert.match(gateway, /binarySha256: WHISPER_BIN_SHA256/);
  assert.match(gateway, /modelSha256: WHISPER_MODEL_SHA256/);
  assert.match(gateway, /runtimeVerified: WHISPER_RUNTIME_VERIFIED/);
  assert.match(gateway, /gatewayVersion: GATEWAY_VERSION/);
  assert.match(gateway, /lidProductionCpuBusy\(\)/);
  assert.match(gateway, /digest\('hex'\);\s*\n/);
  assert.match(gateway, /runWhisperDetect\(wavPath\)/);
  assert.match(gateway, /runWhisperDetectOnly\(\{[\s\S]*wavPath,/);
  assert.match(gateway, /claims\.uid,\s*\n\s*false,\s*\n\s*\)\)/);
  assert.match(gateway, /entry\.reportActivity !== false/);
  assert.match(playback, /\.eq\("key", "lid_benchmark_enabled"\)/);
  assert.match(playback, /operator lease expired/);
  assert.match(playback, /"lid-benchmark",\s*\n\s*\)/);
  assert.match(playback, /persisted: false/);
  assert.match(playback, /sanitizeTelemetryText\(stringOr\(payload\.details/);
  assert.match(playback, /lidBenchmarkProtocol: 2/);
  assert.match(playback, /segments\[0\] === "lid-benchmark"/);
  assert.match(
    dockerfile,
    /ARG WHISPER_CPP_COMMIT=[0-9a-f]{40}/,
  );
  assert.match(dockerfile, /sha256sum build\/bin\/whisper-cli/);
  assert.match(dockerfile, /sha256sum \/opt\/whisper-model\.bin/);
  assert.match(dockerfile, /git fetch --depth 1 origin "\$\{WHISPER_CPP_COMMIT\}"/);
  assert.doesNotMatch(dockerfile, /git clone --depth 1 .*whisper\.cpp/);
  assert.match(runner, /fixedWindowCurrentAcceptance/);
  assert.match(
    runner,
    /agreementWithAcceptedCurrent:[\s\S]*\(\$acceptedCurrent\|length\)/,
  );
  assert.match(runner, /productionPipelineCoverage: "not measured/);
  assert.match(runner, /detailed evidence: \$RESULTS/);
  assert.match(runner, /MIN_COMPLETION_PCT/);
  assert.match(runner, /BENCH_OFFSET/);
  assert.match(runner, /--header "@\$AUTH_HEADER"/);
  assert.match(runner, /gateway_is_idle/);
  assert.match(runner, /lidBenchmarkProtocol >= 2/);
  assert.match(runner, /\.version >= 73/);
  assert.match(runner, /norva-playback\/lid-benchmark/);
  assert.doesNotMatch(runner, /norva-playback\/audio-backfill/);
  assert.match(runner, /http_status.*\^5\[0-9\]\[0-9\]\$/);
  assert.match(runner, /provider_auth_terminal/);
  assert.match(runner, /authorization failed/);
  assert.match(runner, /engine\.gatewayVersion/);
  assert.match(runner, /max_parallel_workers_per_gather=0/);
  assert.match(flagMigration, /'lid_benchmark_enabled',\s*\n\s*false/);
});

test('operator WAV capture is opt-in, bounded, integrity-checked and service-endpoint only', () => {
  const root = path.join(__dirname, '..');
  const gateway = fs.readFileSync(
    path.join(root, 'services/media-gateway/src/index.js'),
    'utf8',
  );
  const playback = fs.readFileSync(
    path.join(root, 'supabase/functions/norva-playback/index.ts'),
    'utf8',
  );

  assert.match(gateway, /const LID_BENCHMARK_WAV_MAX_BYTES = 1536 \* 1024/);
  assert.match(gateway, /const LID_BENCHMARK_WAV_BASE64_MAX_CHARS = 1536 \* 1024/);
  assert.match(gateway, /res\.setHeader\('Cache-Control', 'no-store'\)/);
  assert.match(gateway, /claims\.scope !== 'lid-benchmark'/);
  assert.match(gateway, /const includeWav = body\.includeWav === true/);
  assert.match(gateway, /includeWav && wavBytes > LID_BENCHMARK_WAV_MAX_BYTES/);
  assert.match(gateway, /wavBuffer\.subarray\(0, 4\)\.toString\('ascii'\) !== 'RIFF'/);
  assert.match(gateway, /wavBuffer\.subarray\(8, 12\)\.toString\('ascii'\) !== 'WAVE'/);
  assert.match(gateway, /const base64 = wavBuffer\.toString\('base64'\)/);
  assert.match(gateway, /base64\.length > LID_BENCHMARK_WAV_BASE64_MAX_CHARS/);
  assert.match(gateway, /digest: sampleDigest,\s*\n\s*base64,/);
  assert.match(gateway, /\.\.\.\(wavCapture \? \{ wavCapture \} : \{\}\)/);

  assert.match(playback, /const LID_BENCHMARK_WAV_MAX_BYTES = 1536 \* 1024/);
  assert.match(playback, /const LID_BENCHMARK_WAV_BASE64_MAX_CHARS = 1536 \* 1024/);
  assert.match(playback, /runLidBenchmark\(db, \{ \.\.\.body, mode: "lid-benchmark" \}, true\)/);
  assert.match(playback, /allowWavCapture = false/);
  assert.match(playback, /!allowWavCapture && body\.captureWav === true/);
  assert.match(playback, /const captureWav = allowWavCapture && body\.captureWav === true/);
  assert.match(playback, /includeWav: captureWav/);
  assert.match(playback, /base64\.length !== Math\.ceil\(bytes \/ 3\) \* 4/);
  assert.match(playback, /sample\.wavBytes !== bytes/);
  assert.match(playback, /sample\.digest !== digest/);
  assert.match(playback, /decoded\[0\] !== 0x52[\s\S]*decoded\[11\] !== 0x45/);
  assert.match(playback, /crypto\.subtle\.digest\("SHA-256", decoded\)/);
  assert.match(playback, /benchmark\.wavCapture = await sanitizeLidBenchmarkWavCapture\(payload\)/);
  assert.match(playback, /Gateway returned an invalid LID benchmark WAV capture/);
});
