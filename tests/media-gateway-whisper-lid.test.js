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
  });
  const result = await resultPromise;
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
  assert.match(gateway, /lidProductionCpuBusy\(\)/);
  assert.match(gateway, /digest\('hex'\);\s*\n/);
  assert.match(gateway, /runWhisperDetect\(wavPath\)/);
  assert.match(gateway, /runWhisperDetectOnly\(\{[\s\S]*wavPath,/);
  assert.match(playback, /\.eq\("key", "lid_benchmark_enabled"\)/);
  assert.match(playback, /operator lease expired/);
  assert.match(playback, /"lid-benchmark",\s*\n\s*\)/);
  assert.match(playback, /persisted: false/);
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
  assert.match(runner, /--header "@\$AUTH_HEADER"/);
  assert.match(runner, /gateway_is_idle/);
  assert.match(flagMigration, /'lid_benchmark_enabled',\s*\n\s*false/);
});
