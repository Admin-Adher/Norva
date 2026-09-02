'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  PrivateR2Simulator,
  R2SimulatorError,
} = require('../services/media-lab-runner/src/r2-object-store-simulator');
const {
  SharedHlsObjectPublisher,
} = require('../services/media-gateway/src/sharedHlsObjectPublisher');
const { deriveGlobalMediaCacheObjectKey } = require('../services/media-gateway/src/mediaCacheIdentity');

const HMAC_KEY = Buffer.from('c1'.repeat(32), 'hex');

async function temporary(t, prefix) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

function identity(overrides = {}) {
  return {
    contentSha256: 'd1'.repeat(32),
    fileSizeBytes: 50_000_000,
    videoProfile: {
      streamIndex: 0,
      codec: 'h264',
      profile: 'high',
      level: 41,
      width: 1920,
      height: 1080,
      pixelFormat: 'yuv420p',
      frameRateNumerator: 25,
      frameRateDenominator: 1,
    },
    audioTopology: [
      { streamIndex: 1, codec: 'aac', language: 'eng', channels: 2, sampleRate: 48_000, title: 'English', default: true, forced: false },
      { streamIndex: 2, codec: 'aac', language: 'fra', channels: 2, sampleRate: 48_000, title: 'Français', default: false, forced: false },
    ],
    subtitleTopology: [
      { streamIndex: 3, codec: 'webvtt', language: 'fra', title: null, default: false, forced: false, hearingImpaired: false },
    ],
    durationMilliseconds: 5_400_000,
    pipelineBuild: 'mkv-h264-hls-fmp4-v3',
    segmenterBuild: 'ffmpeg-8.0-norva-4',
    ...overrides,
  };
}

async function hlsFixture(t, marker = 'segment-one') {
  const directory = await temporary(t, 'norva-shared-hls-stage-');
  const files = ['index.m3u8', 'init.mp4', 'segment-000.m4s', 'segment-001.m4s'];
  await fsp.writeFile(path.join(directory, 'index.m3u8'), [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:2.000,',
    'segment-000.m4s',
    '#EXTINF:2.000,',
    'segment-001.m4s',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n'));
  await fsp.writeFile(path.join(directory, 'init.mp4'), Buffer.from('init'));
  await fsp.writeFile(path.join(directory, 'segment-000.m4s'), Buffer.from(marker));
  await fsp.writeFile(path.join(directory, 'segment-001.m4s'), Buffer.from('segment-two'));
  return { directory, files, rootPlaylist: 'index.m3u8' };
}

function publisher(store, options = {}) {
  return new SharedHlsObjectPublisher({
    objectStore: store,
    manifestHmacKey: HMAC_KEY,
    ttlMs: 60_000,
    maxEntryBytes: 1024 * 1024,
    ...options,
  });
}

function completeOptions(fixture, overrides = {}) {
  return {
    identity: identity(),
    sourceDirectory: fixture.directory,
    rootPlaylist: fixture.rootPlaylist,
    files: fixture.files,
    completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
    ...overrides,
  };
}

test('shared publisher writes every immutable asset before one authenticated manifest', async (t) => {
  const simulator = new PrivateR2Simulator({ root: await temporary(t, 'norva-shared-hls-r2-') });
  const writes = [];
  const store = {
    get: (key) => simulator.get(key),
    put: async (key, body, options) => {
      writes.push(key);
      return simulator.put(key, body, options);
    },
  };
  const fixture = await hlsFixture(t);
  const result = await publisher(store).publish(completeOptions(fixture));
  assert.equal(result.objectKey, deriveGlobalMediaCacheObjectKey(identity()).key);
  assert.equal(writes.at(-1), result.manifestKey, 'the manifest is the only publication event and is always last');
  assert.equal(writes.slice(0, -1).every((key) => key.includes('/assets/')), true);
  assert.equal(result.fileCount, fixture.files.length);

  const manifestObject = await simulator.get(result.manifestKey);
  assert.equal(manifestObject.sha256, result.manifestSha256);
  const envelope = JSON.parse(manifestObject.body.toString('utf8'));
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
  assert.equal(payload.objectKey, result.objectKey);
  assert.equal(payload.identityKind, 'global-media-object');
  assert.equal(payload.files.length, fixture.files.length);
  assert.equal(payload.files.every((file) => file.objectName.startsWith('assets/')), true);
  assert.equal(payload.files.every((file) => !file.objectName.includes(file.path)), true);
  assert.deepEqual(payload.completion, { ffmpegExitCode: 0, kind: 'complete-hls', sourceEof: true });
});

test('an interrupted R2 upload leaves no readable manifest', async (t) => {
  const simulator = new PrivateR2Simulator({
    root: await temporary(t, 'norva-shared-hls-r2-fail-'),
    failPutOrdinals: [2],
  });
  const fixture = await hlsFixture(t);
  const objectKey = deriveGlobalMediaCacheObjectKey(identity()).key;
  const manifestKey = `media-cache/v1/${objectKey.slice(0, 2)}/${objectKey}/manifest.auth.json`;
  await assert.rejects(
    () => publisher(simulator).publish(completeOptions(fixture)),
    (error) => error instanceof R2SimulatorError && error.code === 'R2_SIMULATOR_UNAVAILABLE',
  );
  assert.equal(await simulator.head(manifestKey), null);
});

test('republication is idempotent while a different graph under one immutable identity conflicts', async (t) => {
  const simulator = new PrivateR2Simulator({ root: await temporary(t, 'norva-shared-hls-r2-idempotent-') });
  const first = await hlsFixture(t, 'same-segment');
  const cache = publisher(simulator);
  const published = await cache.publish(completeOptions(first));
  assert.equal((await cache.publish(completeOptions(first))).manifestSha256, published.manifestSha256);

  const changed = await hlsFixture(t, 'changed-output-under-same-source-identity');
  await assert.rejects(
    () => cache.publish(completeOptions(changed)),
    (error) => error.code === 'SHARED_HLS_OBJECT_COLLISION',
  );
  assert.equal((await simulator.get(published.manifestKey)).sha256, published.manifestSha256);
});

test('two distributed publishers converge on the first valid manifest without overwriting it', async (t) => {
  const simulator = new PrivateR2Simulator({ root: await temporary(t, 'norva-shared-hls-r2-race-') });
  const fixture = await hlsFixture(t, 'distributed-race');
  let initialManifestReads = 0;
  let releaseInitialReads;
  const initialReadBarrier = new Promise((resolve) => { releaseInitialReads = resolve; });
  const store = {
    put: (...args) => simulator.put(...args),
    get: async (key) => {
      if (key.endsWith('/manifest.auth.json') && initialManifestReads < 2) {
        initialManifestReads += 1;
        if (initialManifestReads === 2) releaseInitialReads();
        await initialReadBarrier;
        return null;
      }
      return simulator.get(key);
    },
  };
  const first = publisher(store, { now: () => 1_000_000 });
  const second = publisher(store, { now: () => 1_001_000 });
  const results = await Promise.all([
    first.publish(completeOptions(fixture)),
    second.publish(completeOptions(fixture)),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['already-ready', 'published']);
  assert.equal(results[0].objectKey, results[1].objectKey);
  assert.equal(results[0].manifestSha256, results[1].manifestSha256);
  assert.equal(simulator.snapshot().conflicts >= 1, true, 'one conditional manifest write loses safely');
});

test('prefix-only, live and failed FFmpeg outputs never start an object publication', async (t) => {
  const simulator = new PrivateR2Simulator({ root: await temporary(t, 'norva-shared-hls-r2-incomplete-') });
  const fixture = await hlsFixture(t);
  for (const completion of [
    { kind: 'complete-hls', sourceEof: false, ffmpegExitCode: 0 },
    { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 1 },
    { kind: 'prefix-hls', sourceEof: true, ffmpegExitCode: 0 },
  ]) {
    await assert.rejects(
      () => publisher(simulator).publish(completeOptions(fixture, { completion })),
      (error) => error.code === 'INCOMPLETE_SHARED_HLS_REJECTED',
    );
  }
  assert.equal(simulator.snapshot().puts, 0);
});

test('admission TTL can shorten shared retention but never exceed the configured maximum', async (t) => {
  const simulator = new PrivateR2Simulator({ root: await temporary(t, 'norva-shared-hls-r2-ttl-') });
  const fixture = await hlsFixture(t);
  const now = 5_000_000;
  const cache = publisher(simulator, { now: () => now, ttlMs: 60_000 });
  const published = await cache.publish(completeOptions(fixture, { ttlMs: 5_000 }));
  assert.equal(published.expiresAtMs, now + 5_000);
  const other = new PrivateR2Simulator({ root: await temporary(t, 'norva-shared-hls-r2-ttl-over-') });
  await assert.rejects(
    () => publisher(other, { ttlMs: 60_000 }).publish(completeOptions(fixture, {
      identity: identity({ contentSha256: 'e1'.repeat(32) }),
      ttlMs: 60_001,
    })),
    (error) => error.code === 'INVALID_SHARED_HLS_CONFIG',
  );
});
