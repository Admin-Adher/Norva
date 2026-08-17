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
