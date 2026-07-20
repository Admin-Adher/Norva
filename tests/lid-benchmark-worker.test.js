'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('isolated LID worker pins engines and model bytes', () => {
  const packageJson = JSON.parse(read('services', 'lid-benchmark-worker', 'package.json'));
  const packageLock = read('services', 'lid-benchmark-worker', 'package-lock.json');
  const fetcher = read('services', 'lid-benchmark-worker', 'fetch_models.py');
  const dockerfile = read('services', 'lid-benchmark-worker', 'Dockerfile');

  assert.equal(packageJson.dependencies['sherpa-onnx-node'], '1.13.4');
  assert.equal(packageJson.dependencies.express, '4.22.2');
  assert.match(packageLock, /sherpa-onnx-node-1\.13\.4\.tgz/);
  assert.match(
    packageLock,
    /jHWWdY9f0dbvJpdsfR\/C4WNhM57\+jT9Os2RyC4\/qUz8HKCtj2VYFmJ9s7tue9OCF/,
  );
  assert.match(fetcher, /0253049ae131d6a4be1c4f0d8b0ff483a0f8c8e9/);
  assert.match(fetcher, /65176e2deb88badc814a94058666cadccc29b61c/);
  assert.match(fetcher, /ab750d5c06d713477045fa798fab5d33e959dbc0dfe4de510a9a47844c79a19a/);
  assert.match(fetcher, /d24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434/);
  assert.match(fetcher, /d2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925/);
  assert.match(fetcher, /9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6/);
  assert.match(fetcher, /"bytes": 643_854/);
  assert.match(fetcher, /actual_hash != asset\["sha256"\]/);
  assert.match(dockerfile, /WHISPER_MODEL=small/);
  assert.match(dockerfile, /080bbbe85230f624f0b52127f1ae1218247989f9/);
  assert.match(dockerfile, /1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b/);
  assert.match(dockerfile, /TORCH_VERSION=2\.6\.0/);
  assert.match(dockerfile, /SPEECHBRAIN_VERSION=1\.1\.0/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /HF_HUB_OFFLINE=1/);
  assert.match(dockerfile, /TRANSFORMERS_OFFLINE=1/);
  assert.match(dockerfile, /LD_LIBRARY_PATH=\/app\/node_modules\/sherpa-onnx-linux-x64/);
  assert.match(dockerfile, /USER node/);
});

test('worker is authenticated, loopback-only and destroys every WAV', () => {
  const server = read('services', 'lid-benchmark-worker', 'server.js');
  const compose = read('ops', 'hetzner', 'lid-benchmark', 'docker-compose.yml');

  assert.match(server, /TOKEN\.length < 32/);
  assert.match(server, /crypto\.timingSafeEqual\(supplied, expected\)/);
  assert.match(server, /express\.raw\(\{[\s\S]*limit: MAX_WAV_BYTES/);
  assert.match(server, /expectedDigest !== digest/);
  assert.match(server, /req\.body\.fill\(0\)/);
  assert.match(server, /await wipeAndUnlink\(wavPath\)/);
  assert.match(server, /persisted: false/);
  assert.match(server, /ecapa\.classify\(wavPath\)/);
  assert.match(server, /sherpa\.detect\(wavPath\)/);
  assert.match(
    server,
    /Promise\.all\(\[\s*ecapa\.start\(\),\s*sherpa\.start\(\),\s*vad\.start\(\),\s*\]\)/,
  );
  assert.match(
    server,
    /startupError === null[\s\S]*ecapa\.health\(\)\.ready === true[\s\S]*sherpa\.status\(\)\.ready === true[\s\S]*vad\.status\(\)\.ready === true/,
  );
  assert.match(compose, /127\.0\.0\.1:8091:8091/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /tmpfs:/);
});

test('real-data runner never persists captured operator audio', () => {
  const runner = read('ops', 'hetzner', 'scripts', '17-run-lid-benchmark.sh');

  assert.match(runner, /LID_WORKER_ENABLED="\$\{LID_WORKER_ENABLED:-1\}"/);
  assert.match(runner, /\. \+ \{captureWav:true\}/);
  assert.match(runner, /benchmark\.wavCapture\.base64/);
  assert.match(runner, /base64 --decode >"\$SAMPLE_WAV"/);
  assert.match(runner, /sha256sum "\$SAMPLE_WAV"/);
  assert.match(runner, /--header "@\$WORKER_AUTH_HEADER"/);
  assert.match(runner, /del\(\.benchmark\.wavCapture\)/);
  assert.match(runner, /rm -f "\$SAMPLE_WAV"/);
  assert.match(runner, /candidateCoverage/);
  assert.match(runner, /\.engines\.ecapa\.ready == true/);
  assert.match(runner, /\.engines\.sherpa\.ready == true/);
  assert.match(runner, /retriedExcluded/);
  assert.match(runner, /\(\.attempts \/\/ 1\) == 1/);
  assert.match(runner, /projectedFixedWindowTracksPerHour/);
  assert.match(
    runner,
    /benchmark\.timings\.extractMs \+\s*\.response\.benchmark\.fastLid\.timings\.ecapaWallMs/,
  );
  assert.match(
    runner,
    /benchmark\.timings\.extractMs \+\s*\.response\.benchmark\.fastLid\.timings\.sherpaWallMs/,
  );
  assert.doesNotMatch(
    runner,
    /benchmark\.timings\.extractMs \+\s*\.response\.benchmark\.fastLid\.(?:ecapa|sherpa)\.metrics\.inferenceMs/,
  );
  assert.match(runner, /accuracy: "not scored: cachedLanguageHint is not human ground truth"/);
});
