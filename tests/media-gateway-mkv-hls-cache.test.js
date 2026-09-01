'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  CompleteMkvHlsCache,
  MkvHlsCacheError,
  deriveCompleteHlsCacheKey,
  deriveCompleteHlsCacheKeyFromVerifiedBinding,
  deriveGlobalMediaCacheObjectKey,
  deriveMediaCacheBindingKey,
  parseDedicatedManifestHmacKey,
} = require('../services/media-gateway/src/mkv-hls-cache');

const HMAC_KEY = Buffer.from('11'.repeat(32), 'hex');

async function tempDirectory(t, prefix) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

function cacheIdentity(overrides = {}) {
  return {
    tenantId: 'tenant-private',
    providerId: 'provider-private',
    itemId: 'movie-private',
    variantId: 'variant-private',
    initialUrl: 'https://user:password@provider.example/movie/42.mkv?token=initial-secret',
    effectiveUrl: 'https://cdn.example/signed/42.mkv?token=effective-secret',
    strongEtag: '"etag-private"',
    profile: { video: 'h264', audio: 'aac', width: 1920, safeCopy: true },
    pipelineBuild: 'pipeline-private-build-7',
    ...overrides,
  };
}

function cacheOptions(root, overrides = {}) {
  return {
    root,
    manifestHmacKey: HMAC_KEY,
    maxBytes: 1024 * 1024,
    minFreeBytes: 0,
    ttlMs: 60_000,
    maxEntryBytes: 256 * 1024,
    statfs: async () => ({ availableBytes: 1024 * 1024 * 1024 }),
    ...overrides,
  };
}

function verifiedBinding(overrides = {}) {
  return {
    tenantScopeSha256: '11'.repeat(32),
    providerScopeSha256: '22'.repeat(32),
    itemScopeSha256: '33'.repeat(32),
    sourceUrlSha256: '44'.repeat(32),
    effectiveUrlSha256: '55'.repeat(32),
    strongEtagSha256: '66'.repeat(32),
    profileFingerprint: '77'.repeat(32),
    fileSizeBytes: 123456,
    pipelineBuild: 'mkv-h264-hls-fmp4-v2',
    proofBuild: 2,
    ...overrides,
  };
}

function globalObjectIdentity(overrides = {}) {
  return {
    contentSha256: '81'.repeat(32),
    fileSizeBytes: 987_654_321,
    videoProfile: {
      streamIndex: 0,
      codec: 'h264',
      profile: 'high',
      level: 41,
      width: 1920,
      height: 1080,
      pixelFormat: 'yuv420p',
      frameRateNumerator: 24_000,
      frameRateDenominator: 1_001,
    },
    audioTopology: [
      { streamIndex: 1, codec: 'aac', language: 'eng', channels: 2, sampleRate: 48_000, title: 'English', default: true, forced: false },
      { streamIndex: 2, codec: 'aac', language: 'fra', channels: 2, sampleRate: 48_000, title: 'Français', default: false, forced: false },
    ],
    subtitleTopology: [
      { streamIndex: 3, codec: 'webvtt', language: 'fra', title: null, default: false, forced: false, hearingImpaired: false },
    ],
    durationMilliseconds: 7_200_000,
    pipelineBuild: 'mkv-h264-hls-fmp4-v3',
    segmenterBuild: 'ffmpeg-8.0-norva-4',
    ...overrides,
  };
}

function globalBinding(overrides = {}) {
  return {
    tenantScopeSha256: '91'.repeat(32),
    sourceScopeSha256: '92'.repeat(32),
    mediaItemScopeSha256: '93'.repeat(32),
    variantScopeSha256: '94'.repeat(32),
    itemType: 'movie',
    targetUrlSha256: '95'.repeat(32),
    ...overrides,
  };
}

async function makeSimpleHls(t, options = {}) {
  const directory = await tempDirectory(t, 'norva-hls-stage-');
  const playlist = options.playlist || [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:2.000,',
    'segment-000.m4s',
    '#EXTINF:2.000,',
    'segment-001.m4s',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  await fsp.writeFile(path.join(directory, 'index.m3u8'), playlist);
  await fsp.writeFile(path.join(directory, 'init.mp4'), Buffer.alloc(options.initBytes || 128, 0x11));
  await fsp.writeFile(path.join(directory, 'segment-000.m4s'), Buffer.alloc(options.segmentBytes || 2048, 0x22));
  await fsp.writeFile(path.join(directory, 'segment-001.m4s'), Buffer.alloc(options.segmentBytes || 2048, 0x33));
  return {
    directory,
    rootPlaylist: 'index.m3u8',
    files: ['index.m3u8', 'init.mp4', 'segment-000.m4s', 'segment-001.m4s'],
  };
}

function publishOptions(stage, identity = cacheIdentity(), completion = {}) {
  return {
    identity,
    sourceDirectory: stage.directory,
    rootPlaylist: stage.rootPlaylist,
    files: stage.files,
    completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0, ...completion },
  };
}

async function manifestPath(root, identity) {
  const { key } = deriveCompleteHlsCacheKey(identity);
  return path.join(root, 'entries', key.slice(0, 2), key, 'manifest.auth.json');
}

test('cache key changes for every authority binding and contains only a digest', () => {
  const baseline = deriveCompleteHlsCacheKey(cacheIdentity());
  assert.match(baseline.key, /^[0-9a-f]{64}$/);
  for (const [field, value] of [
    ['tenantId', 'tenant-b'],
    ['providerId', 'provider-b'],
    ['itemId', 'movie-b'],
    ['variantId', null],
    ['initialUrl', 'https://provider.example/other.mkv'],
    ['effectiveUrl', 'https://cdn.example/other.mkv'],
    ['strongEtag', '"etag-b"'],
    ['profile', { video: 'h264', audio: 'ac3', safeCopy: true }],
    ['pipelineBuild', 'pipeline-build-8'],
  ]) {
    const changed = deriveCompleteHlsCacheKey(cacheIdentity({ [field]: value }));
    assert.notEqual(changed.key, baseline.key, field);
  }
  const encoded = JSON.stringify(baseline);
  for (const secret of ['tenant-private', 'provider-private', 'movie-private', 'user:password', 'initial-secret', 'effective-secret', 'etag-private', 'pipeline-private']) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});

test('manifest key must be a dedicated exact 32-byte value', () => {
  assert.deepEqual(parseDedicatedManifestHmacKey('22'.repeat(32)), Buffer.from('22'.repeat(32), 'hex'));
  for (const invalid of ['', 'secret', 'aa'.repeat(31), 'aa'.repeat(33), Buffer.alloc(31), Buffer.alloc(33)]) {
    assert.throws(() => parseDedicatedManifestHmacKey(invalid), (error) => error.code === 'INVALID_CACHE_HMAC_KEY');
  }
  assert.throws(() => new CompleteMkvHlsCache(cacheOptions('C:\\unused', { ttlMs: 91 * 24 * 60 * 60 * 1000 })), (error) => error.code === 'INVALID_CACHE_CONFIG');
});

test('verified proof bindings derive a secret-free key and reject any missing or malformed authority', () => {
  const baseline = deriveCompleteHlsCacheKeyFromVerifiedBinding(verifiedBinding());
  assert.match(baseline.key, /^[0-9a-f]{64}$/);
  for (const [field, value] of [
    ['tenantScopeSha256', 'aa'.repeat(32)],
    ['providerScopeSha256', 'bb'.repeat(32)],
    ['itemScopeSha256', 'cc'.repeat(32)],
    ['sourceUrlSha256', 'dd'.repeat(32)],
    ['effectiveUrlSha256', 'ee'.repeat(32)],
    ['strongEtagSha256', 'ff'.repeat(32)],
    ['profileFingerprint', '01'.repeat(32)],
    ['fileSizeBytes', 123457],
    ['pipelineBuild', 'mkv-h264-hls-fmp4-v3'],
    ['proofBuild', 3],
  ]) {
    assert.notEqual(deriveCompleteHlsCacheKeyFromVerifiedBinding(verifiedBinding({ [field]: value })).key, baseline.key, field);
  }
  assert.throws(
    () => deriveCompleteHlsCacheKeyFromVerifiedBinding({ ...verifiedBinding(), sourceUrlSha256: 'not-a-digest' }),
    (error) => error.code === 'INVALID_CACHE_IDENTITY',
  );
  const missing = verifiedBinding();
  delete missing.itemScopeSha256;
  assert.throws(
    () => deriveCompleteHlsCacheKeyFromVerifiedBinding(missing),
    (error) => error.code === 'INVALID_CACHE_IDENTITY',
  );
});

test('verified proof bindings publish and acquire the same complete HLS graph', async (t) => {
  const root = await tempDirectory(t, 'norva-hls-cache-verified-');
  const stage = await makeSimpleHls(t);
  const binding = verifiedBinding();
  const cache = new CompleteMkvHlsCache(cacheOptions(root));
  const published = await cache.publishCompleteVerified({
    binding,
    sourceDirectory: stage.directory,
    rootPlaylist: stage.rootPlaylist,
    files: stage.files,
    completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
  });
  assert.equal(published.key, deriveCompleteHlsCacheKeyFromVerifiedBinding(binding).key);
  const hit = await cache.acquireVerified(binding);
  assert.equal(hit.hit, true);
  const playlist = await hit.openAsset(hit.rootPlaylist);
  assert.match(await playlist.readFile('utf8'), /#EXT-X-ENDLIST/);
  await playlist.close();
  hit.release();
});

test('a complete HLS publish yields an authenticated private hit with zero provider and FFmpeg calls', async (t) => {
  const root = await tempDirectory(t, 'norva-hls-cache-hit-');
  const stage = await makeSimpleHls(t);
  const identity = cacheIdentity();
  const cache = new CompleteMkvHlsCache(cacheOptions(root));
  const published = await cache.publishComplete(publishOptions(stage, identity));
  assert.equal(published.status, 'published');
  assert.equal(published.key, deriveCompleteHlsCacheKey(identity).key);

  let providerCalls = 0;
  let ffmpegCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalSpawn = childProcess.spawn;
  globalThis.fetch = async () => { providerCalls += 1; throw new Error('provider must not run on hit'); };
  childProcess.spawn = () => { ffmpegCalls += 1; throw new Error('FFmpeg must not run on hit'); };
  let hit;
  try {
    hit = await cache.acquire(identity);
  } finally {
    globalThis.fetch = originalFetch;
    childProcess.spawn = originalSpawn;
  }
  assert.equal(hit.hit, true);
  assert.equal(providerCalls, 0);
  assert.equal(ffmpegCalls, 0);
  assert.equal(hit.rootPlaylist, 'index.m3u8');
  const playlistHandle = await hit.openAsset(hit.rootPlaylist);
  const playlistText = await playlistHandle.readFile('utf8');
  await playlistHandle.close();
  assert.match(playlistText, /#EXT-X-ENDLIST/);
  const segmentHandle = await hit.openAsset('segment-000.m4s');
  assert.equal((await segmentHandle.stat()).size, 2048);
  await segmentHandle.close();
  await assert.rejects(hit.openAsset('../outside'), (error) => error.code === 'UNSAFE_CACHE_ASSET');
  hit.release();
  hit.release();
  await assert.rejects(hit.openAsset('segment-000.m4s'), (error) => error.code === 'CACHE_LEASE_RELEASED');

  const manifest = await fsp.readFile(await manifestPath(root, identity), 'utf8');
  for (const secret of ['tenant-private', 'provider-private', 'movie-private', 'variant-private', 'user:password', 'initial-secret', 'effective-secret', 'etag-private', 'pipeline-private']) {
    assert.equal(manifest.includes(secret), false, secret);
  }
  const relativeFiles = [];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      relativeFiles.push(path.relative(root, path.join(directory, entry.name)));
      if (entry.isDirectory()) await walk(path.join(directory, entry.name));
    }
  }
  await walk(root);
  const names = relativeFiles.join('\n');
  for (const secret of ['tenant-private', 'provider-private', 'movie-private', 'user', 'password']) assert.equal(names.includes(secret), false);
});

test('prefix, live, non-EOF, and failed-FFmpeg artifacts are rejected before promotion', async (t) => {
  const cases = [
    { name: 'source not EOF', completion: { sourceEof: false }, code: 'INCOMPLETE_HLS_REJECTED' },
    { name: 'FFmpeg failed', completion: { ffmpegExitCode: 1 }, code: 'INCOMPLETE_HLS_REJECTED' },
    { name: 'prefix kind', completion: { kind: 'prefix-hls' }, code: 'INCOMPLETE_HLS_REJECTED' },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (inner) => {
      const root = await tempDirectory(inner, 'norva-hls-cache-incomplete-');
      const stage = await makeSimpleHls(inner);
      const cache = new CompleteMkvHlsCache(cacheOptions(root));
      await assert.rejects(cache.publishComplete(publishOptions(stage, cacheIdentity(), scenario.completion)), (error) => error.code === scenario.code);
      assert.equal((await cache.acquire(cacheIdentity())).hit, false);
    });
  }

  await t.test('playlist without ENDLIST', async (inner) => {
    const root = await tempDirectory(inner, 'norva-hls-cache-no-end-');
    const stage = await makeSimpleHls(inner, {
      playlist: '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment-000.m4s\n#EXTINF:2,\nsegment-001.m4s\n',
    });
    stage.files = ['index.m3u8', 'segment-000.m4s', 'segment-001.m4s'];
    const cache = new CompleteMkvHlsCache(cacheOptions(root));
    await assert.rejects(cache.publishComplete(publishOptions(stage)), (error) => error.code === 'INCOMPLETE_HLS_REJECTED');
  });

  await t.test('LL-HLS preload hint', async (inner) => {
    const root = await tempDirectory(inner, 'norva-hls-cache-preload-');
    const stage = await makeSimpleHls(inner, {
      playlist: '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment-000.m4s\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="segment-001.m4s"\n#EXT-X-ENDLIST\n',
    });
    stage.files = ['index.m3u8', 'segment-000.m4s', 'segment-001.m4s'];
    const cache = new CompleteMkvHlsCache(cacheOptions(root));
    await assert.rejects(cache.publishComplete(publishOptions(stage)), (error) => error.code === 'INCOMPLETE_HLS_REJECTED');
  });
});

test('manifest tampering, wrong HMAC key, and asset mutation turn a would-be hit into a miss', async (t) => {
  await t.test('tampered MAC', async (inner) => {
    const root = await tempDirectory(inner, 'norva-hls-cache-tamper-');
    const stage = await makeSimpleHls(inner);
    const identity = cacheIdentity();
    const cache = new CompleteMkvHlsCache(cacheOptions(root));
    await cache.publishComplete(publishOptions(stage, identity));
    const file = await manifestPath(root, identity);
    const envelope = JSON.parse(await fsp.readFile(file, 'utf8'));
    envelope.mac = `${envelope.mac.slice(0, -1)}${envelope.mac.endsWith('A') ? 'B' : 'A'}`;
    await fsp.writeFile(file, JSON.stringify(envelope));
    assert.deepEqual(await cache.acquire(identity), { hit: false, reason: 'invalid', key: deriveCompleteHlsCacheKey(identity).key });
    assert.equal((await cache.acquire(identity)).reason, 'miss', 'invalid manifests are removed after quarantine');
  });

  await t.test('wrong dedicated key', async (inner) => {
    const root = await tempDirectory(inner, 'norva-hls-cache-wrong-key-');
    const stage = await makeSimpleHls(inner);
    const identity = cacheIdentity();
    await new CompleteMkvHlsCache(cacheOptions(root)).publishComplete(publishOptions(stage, identity));
    const wrong = new CompleteMkvHlsCache(cacheOptions(root, { manifestHmacKey: Buffer.from('33'.repeat(32), 'hex') }));
    assert.equal((await wrong.acquire(identity)).reason, 'invalid');
  });

  await t.test('asset size changed', async (inner) => {
    const root = await tempDirectory(inner, 'norva-hls-cache-asset-change-');
    const stage = await makeSimpleHls(inner);
    const identity = cacheIdentity();
    const cache = new CompleteMkvHlsCache(cacheOptions(root));
    const published = await cache.publishComplete(publishOptions(stage, identity));
    const entry = path.dirname(await manifestPath(root, identity));
    await fsp.appendFile(path.join(entry, 'segment-000.m4s'), 'tamper');
    assert.equal((await cache.acquire(identity)).reason, 'invalid');
    assert.match(published.key, /^[0-9a-f]{64}$/);
  });

  await t.test('same-size segment content changed', async (inner) => {
    const root = await tempDirectory(inner, 'norva-hls-cache-same-size-change-');
    const stage = await makeSimpleHls(inner);
    const identity = cacheIdentity();
    const cache = new CompleteMkvHlsCache(cacheOptions(root));
    await cache.publishComplete(publishOptions(stage, identity));
    const entry = path.dirname(await manifestPath(root, identity));
    await fsp.writeFile(path.join(entry, 'segment-000.m4s'), Buffer.alloc(2048, 0x99));
    const hit = await cache.acquire(identity);
    assert.equal(hit.hit, true, 'segment verification is intentionally lazy per asset');
    await assert.rejects(hit.openAsset('segment-000.m4s'), (error) => error.code === 'INVALID_CACHE_ENTRY');
    hit.release();
    assert.equal((await cache.acquire(identity)).reason, 'miss', 'a poisoned leased entry is removed after release');
    assert.equal((await cache.publishComplete(publishOptions(stage, identity))).status, 'published');
  });
});

test('unlisted, external, traversal, and malformed HLS references fail closed', async (t) => {
  const playlists = [
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nunlisted.m4s\n#EXT-X-ENDLIST\n',
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttps://evil.example/segment.m4s\n#EXT-X-ENDLIST\n',
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n../segment-000.m4s\n#EXT-X-ENDLIST\n',
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI=init.mp4\n#EXTINF:2,\nsegment-000.m4s\n#EXT-X-ENDLIST\n',
  ];
  for (const [index, playlist] of playlists.entries()) {
    await t.test(`invalid graph ${index + 1}`, async (inner) => {
      const root = await tempDirectory(inner, 'norva-hls-cache-graph-');
      const stage = await makeSimpleHls(inner, { playlist });
      stage.files = ['index.m3u8', 'init.mp4', 'segment-000.m4s'];
      const cache = new CompleteMkvHlsCache(cacheOptions(root));
      await assert.rejects(cache.publishComplete(publishOptions(stage)), (error) => {
        assert.ok(['INVALID_HLS_PLAYLIST', 'UNSAFE_CACHE_ASSET'].includes(error.code), error.code);
        return true;
      });
    });
  }
});

test('TTL expiry is a miss and prune removes the expired complete entry', async (t) => {
  const root = await tempDirectory(t, 'norva-hls-cache-ttl-');
  const stage = await makeSimpleHls(t);
  let now = 10_000;
  const identity = cacheIdentity();
  const cache = new CompleteMkvHlsCache(cacheOptions(root, { now: () => now, ttlMs: 500 }));
  await cache.publishComplete(publishOptions(stage, identity));
  const first = await cache.acquire(identity);
  assert.equal(first.hit, true);
  first.release();
  now = 10_501;
  assert.deepEqual(await cache.acquire(identity), { hit: false, reason: 'expired', key: deriveCompleteHlsCacheKey(identity).key });
  const pruned = await cache.prune();
  assert.equal(pruned.removedEntries, 1);
  assert.ok(pruned.removedBytes > 0);
  assert.equal((await cache.acquire(identity)).reason, 'miss');
});

test('single-instance startup removes only bounded crash residue from the private publish temp root', async (t) => {
  const root = await tempDirectory(t, 'norva-hls-cache-crash-residue-');
  const orphan = path.join(root, 'tmp', 'publish-orphan123');
  await fsp.mkdir(orphan, { recursive: true });
  await fsp.writeFile(path.join(orphan, 'partial.ts'), Buffer.alloc(1024, 0x47));
  const cache = new CompleteMkvHlsCache(cacheOptions(root));
  assert.equal((await cache.acquire(cacheIdentity())).reason, 'miss');
  await assert.rejects(fsp.stat(orphan), (error) => error.code === 'ENOENT');
});

test('quota eviction is LRU and never evicts an active refcounted hit', async (t) => {
  const root = await tempDirectory(t, 'norva-hls-cache-lru-');
  const stages = [await makeSimpleHls(t), await makeSimpleHls(t), await makeSimpleHls(t)];
  let now = 100_000;
  const cache = new CompleteMkvHlsCache(cacheOptions(root, {
    now: () => now,
    maxBytes: 80_000,
  }));
  const a = cacheIdentity({ itemId: 'movie-a' });
  const b = cacheIdentity({ itemId: 'movie-b' });
  const c = cacheIdentity({ itemId: 'movie-c' });
  await cache.publishComplete(publishOptions(stages[0], a));
  now += 10_000;
  await cache.publishComplete(publishOptions(stages[1], b));
  now += 10_000;
  const activeA = await cache.acquire(a);
  assert.equal(activeA.hit, true);
  const activeB = await cache.acquire(b);
  assert.equal(activeB.hit, true);
  await assert.rejects(cache.publishComplete(publishOptions(stages[2], c)), (error) => error.code === 'CACHE_QUOTA_EXCEEDED');
  activeB.release();

  now += 10_000;
  const publishedC = await cache.publishComplete(publishOptions(stages[2], c));
  assert.equal(publishedC.status, 'published');
  assert.equal((await cache.acquire(b)).reason, 'miss', 'the only released entry is evicted');
  const secondA = await cache.acquire(a);
  assert.equal(secondA.hit, true, 'active entry survives admission');
  secondA.release();
  const hitC = await cache.acquire(c);
  assert.equal(hitC.hit, true);
  hitC.release();
  activeA.release();
});

test('quota chooses the least-recently-used released entry', async (t) => {
  const root = await tempDirectory(t, 'norva-hls-cache-true-lru-');
  const stages = [await makeSimpleHls(t), await makeSimpleHls(t), await makeSimpleHls(t)];
  let now = 100_000;
  const cache = new CompleteMkvHlsCache(cacheOptions(root, { now: () => now, maxBytes: 80_000 }));
  const a = cacheIdentity({ itemId: 'lru-a' });
  const b = cacheIdentity({ itemId: 'lru-b' });
  const c = cacheIdentity({ itemId: 'lru-c' });
  await cache.publishComplete(publishOptions(stages[0], a));
  now = 110_000;
  await cache.publishComplete(publishOptions(stages[1], b));
  now = 120_000;
  const refreshedA = await cache.acquire(a);
  assert.equal(refreshedA.hit, true);
  refreshedA.release();
  now = 130_000;
  await cache.publishComplete(publishOptions(stages[2], c));
  assert.equal((await cache.acquire(b)).reason, 'miss', 'older B is evicted after A was touched');
  const keptA = await cache.acquire(a);
  assert.equal(keptA.hit, true);
  keptA.release();
});

test('free-space floor rejects publication without creating a cache hit', async (t) => {
  const root = await tempDirectory(t, 'norva-hls-cache-space-');
  const stage = await makeSimpleHls(t);
  const identity = cacheIdentity();
  const cache = new CompleteMkvHlsCache(cacheOptions(root, {
    minFreeBytes: 100_000,
    statfs: async () => ({ availableBytes: 120_000 }),
  }));
  await assert.rejects(cache.publishComplete(publishOptions(stage, identity)), (error) => error.code === 'CACHE_QUOTA_EXCEEDED');
  assert.equal((await cache.acquire(identity)).hit, false);
});

test('symlinked staging assets are rejected when the platform permits symlink creation', async (t) => {
  const root = await tempDirectory(t, 'norva-hls-cache-symlink-root-');
  const stage = await makeSimpleHls(t);
  const outside = path.join(await tempDirectory(t, 'norva-hls-cache-outside-'), 'outside.m4s');
  await fsp.writeFile(outside, 'outside');
  await fsp.rm(path.join(stage.directory, 'segment-000.m4s'));
  try {
    await fsp.symlink(outside, path.join(stage.directory, 'segment-000.m4s'), 'file');
  } catch (error) {
    if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      const outsideDirectory = path.dirname(outside);
      const junction = path.join(stage.directory, 'linked');
      try {
        await fsp.symlink(outsideDirectory, junction, 'junction');
        await fsp.writeFile(path.join(stage.directory, 'index.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nlinked/outside.m4s\n#EXT-X-ENDLIST\n');
        stage.files = ['index.m3u8', 'linked/outside.m4s'];
      } catch (junctionError) {
        if (junctionError && ['EPERM', 'EACCES', 'ENOTSUP'].includes(junctionError.code)) {
          t.skip(`symlinks and junctions unavailable on this host: ${junctionError.code}`);
          return;
        }
        throw junctionError;
      }
    } else {
      throw error;
    }
  }
  const cache = new CompleteMkvHlsCache(cacheOptions(root));
  await assert.rejects(cache.publishComplete(publishOptions(stage)), (error) => {
    assert.ok(['UNSAFE_CACHE_ASSET', 'UNSAFE_CACHE_PATH'].includes(error.code), error.code);
    return true;
  });
});

test('two authorized tenants share one immutable global object through separate signed bindings', async (t) => {
  const root = await tempDirectory(t, 'norva-global-hls-cache-');
  const stage = await makeSimpleHls(t);
  const identity = globalObjectIdentity();
  const tenantA = globalBinding();
  const tenantB = globalBinding({
    tenantScopeSha256: 'a1'.repeat(32),
    sourceScopeSha256: 'a2'.repeat(32),
    mediaItemScopeSha256: 'a3'.repeat(32),
    variantScopeSha256: 'a4'.repeat(32),
    targetUrlSha256: 'a5'.repeat(32),
  });
  const cache = new CompleteMkvHlsCache(cacheOptions(root));
  const published = await cache.publishGlobalObject({
    ...publishOptions(stage),
    identity,
  });
  assert.equal(published.key, deriveGlobalMediaCacheObjectKey(identity).key);
  assert.equal((await cache.bindGlobalObject({ identity, binding: tenantA })).status, 'bound');
  assert.equal((await cache.bindGlobalObject({ identity, binding: tenantB })).status, 'bound');

  const hitA = await cache.acquireBound({ identity, binding: tenantA });
  const hitB = await cache.acquireBound({ identity, binding: tenantB });
  assert.equal(hitA.hit, true);
  assert.equal(hitB.hit, true);
  assert.equal(hitA.key, hitB.key, 'both bindings lease exactly one global object');
  assert.notEqual(hitA.bindingKey, hitB.bindingKey, 'each authority remains independently revocable');
  hitA.release();
  hitB.release();

  const objectKey = deriveGlobalMediaCacheObjectKey(identity).key;
  const entryParent = path.join(root, 'entries', objectKey.slice(0, 2));
  assert.deepEqual(await fsp.readdir(entryParent), [objectKey]);
  const envelope = JSON.parse(await fsp.readFile(path.join(entryParent, objectKey, 'manifest.auth.json'), 'utf8'));
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
  assert.equal(payload.schema, 2);
  assert.equal(payload.identityKind, 'global-media-object');
  const serialized = JSON.stringify(payload).toLowerCase();
  for (const forbidden of ['tenant', 'provider', 'tmdb', 'multi', 'https://']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('an unbound or tampered tenant fails closed without quarantining the shared object', async (t) => {
  const root = await tempDirectory(t, 'norva-global-hls-binding-auth-');
  const stage = await makeSimpleHls(t);
  const identity = globalObjectIdentity();
  const binding = globalBinding();
  const stranger = globalBinding({ tenantScopeSha256: 'b1'.repeat(32) });
  const cache = new CompleteMkvHlsCache(cacheOptions(root));
  await cache.publishGlobalObject({ ...publishOptions(stage), identity });
  await cache.bindGlobalObject({ identity, binding });

  assert.equal((await cache.acquireBound({ identity, binding: stranger })).reason, 'binding-miss');
  const derived = deriveMediaCacheBindingKey(binding, deriveGlobalMediaCacheObjectKey(identity).key);
  const bindingPath = path.join(root, 'bindings', derived.key.slice(0, 2), `${derived.key}.auth.json`);
  const envelope = JSON.parse(await fsp.readFile(bindingPath, 'utf8'));
  envelope.mac = `${envelope.mac.slice(0, -1)}${envelope.mac.endsWith('A') ? 'B' : 'A'}`;
  await fsp.writeFile(bindingPath, JSON.stringify(envelope));
  assert.equal((await cache.acquireBound({ identity, binding })).reason, 'binding-invalid');

  const direct = await cache.acquireGlobalObject(identity);
  assert.equal(direct.hit, true, 'binding corruption never deletes the globally valid object');
  direct.release();
});

test('rebinding one authority replaces only its object pointer and revocation preserves both objects', async (t) => {
  const root = await tempDirectory(t, 'norva-global-hls-rebind-');
  const stages = [await makeSimpleHls(t), await makeSimpleHls(t)];
  const firstIdentity = globalObjectIdentity();
  const secondIdentity = globalObjectIdentity({ contentSha256: '82'.repeat(32) });
  const binding = globalBinding();
  const cache = new CompleteMkvHlsCache(cacheOptions(root));
  await cache.publishGlobalObject({ ...publishOptions(stages[0]), identity: firstIdentity });
  await cache.publishGlobalObject({ ...publishOptions(stages[1]), identity: secondIdentity });
  await cache.bindGlobalObject({ identity: firstIdentity, binding });
  await cache.bindGlobalObject({ identity: secondIdentity, binding });

  assert.equal((await cache.acquireBound({ identity: firstIdentity, binding })).reason, 'binding-invalid');
  const secondHit = await cache.acquireBound({ identity: secondIdentity, binding });
  assert.equal(secondHit.hit, true);
  secondHit.release();
  assert.equal((await cache.revokeGlobalBinding({ identity: secondIdentity, binding })).status, 'revoked');
  assert.equal((await cache.acquireBound({ identity: secondIdentity, binding })).reason, 'binding-revoked');

  for (const identity of [firstIdentity, secondIdentity]) {
    const object = await cache.acquireGlobalObject(identity);
    assert.equal(object.hit, true, 'revocation affects no immutable object');
    object.release();
  }
});

test('binding TTL expires independently before a still-valid global object', async (t) => {
  const root = await tempDirectory(t, 'norva-global-hls-binding-ttl-');
  const stage = await makeSimpleHls(t);
  const identity = globalObjectIdentity();
  const binding = globalBinding();
  let now = 1_000_000;
  const cache = new CompleteMkvHlsCache(cacheOptions(root, {
    now: () => now,
    ttlMs: 60_000,
    bindingTtlMs: 5_000,
  }));
  await cache.publishGlobalObject({ ...publishOptions(stage), identity });
  await cache.bindGlobalObject({ identity, binding });
  now += 5_001;
  assert.equal((await cache.acquireBound({ identity, binding })).reason, 'binding-expired');
  const object = await cache.acquireGlobalObject(identity);
  assert.equal(object.hit, true);
  object.release();
});
