'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { PrivateMediaCacheStoreClient } = require('../services/media-gateway/src/privateMediaCacheStoreClient');
const { SharedHlsObjectPublisher } = require('../services/media-gateway/src/sharedHlsObjectPublisher');

const ROOT = path.join(__dirname, '..');
const SERVICE_TOKEN = 'worker-gateway-service-token-'.padEnd(64, 'x');
const MANIFEST_KEY = 'a1'.repeat(32);
const TICKET_KEY = 'b2'.repeat(32);

function loadBundle(entryPoint) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, entryPoint)],
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const workerModule = loadBundle('workers/media-cache/src/index.ts');
const ticketModule = loadBundle('supabase/functions/_shared/media-cache-ticket.ts');
const worker = workerModule.default;

const sha256 = (body) => crypto.createHash('sha256').update(body).digest('hex');

function bodyStream(buffer) {
  const body = Buffer.from(buffer);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(body));
      controller.close();
    },
  });
}

async function requestBody(body) {
  if (body === null || body === undefined) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('unsupported fake R2 body');
}

class FakeR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  record(key, stored, range = null) {
    const source = stored.body;
    let selected = source;
    let selectedRange;
    if (range) {
      const header = range instanceof Headers ? range.get('range') : range?.get?.('range');
      const match = /^bytes=(\d+)-(\d*)$/.exec(header || '');
      if (match) {
        const offset = Number(match[1]);
        const end = match[2] ? Math.min(source.length - 1, Number(match[2])) : source.length - 1;
        selected = source.subarray(offset, end + 1);
        selectedRange = { offset, length: selected.length };
      }
    }
    const checksum = Buffer.from(stored.sha256, 'hex');
    const record = {
      key,
      size: source.length,
      etag: `"${stored.sha256.slice(0, 32)}"`,
      httpEtag: `"${stored.sha256.slice(0, 32)}"`,
      uploaded: stored.uploaded || new Date(),
      customMetadata: { ...stored.customMetadata },
      httpMetadata: { ...stored.httpMetadata },
      checksums: stored.omitChecksum
        ? {}
        : { sha256: checksum.buffer.slice(checksum.byteOffset, checksum.byteOffset + checksum.byteLength) },
      range: selectedRange,
      body: bodyStream(selected),
      arrayBuffer: async () => selected.buffer.slice(selected.byteOffset, selected.byteOffset + selected.byteLength),
    };
    return record;
  }

  async put(key, body, options = {}) {
    const bytes = await requestBody(body);
    const digest = sha256(bytes);
    if (options.sha256 && options.sha256 !== digest) throw new Error('BadDigest');
    if (this.objects.has(key) && options.onlyIf) return null;
    const stored = {
      body: bytes,
      sha256: digest,
      customMetadata: { ...(options.customMetadata || {}) },
      httpMetadata: { ...(options.httpMetadata || {}) },
    };
    this.objects.set(key, stored);
    return this.record(key, stored);
  }

  async get(key, options = {}) {
    const stored = this.objects.get(key);
    return stored ? this.record(key, stored, options.range || null) : null;
  }

  async head(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const record = this.record(key, stored);
    delete record.body;
    delete record.arrayBuffer;
    return record;
  }

  async list(options = {}) {
    const prefix = String(options.prefix || '');
    const limit = Math.max(1, Math.min(1000, Number(options.limit) || 1000));
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const cursorIndex = options.cursor ? keys.findIndex((key) => key > options.cursor) : 0;
    const start = options.cursor && cursorIndex < 0 ? keys.length : cursorIndex;
    const pageKeys = keys.slice(start, start + limit);
    const truncated = start + pageKeys.length < keys.length;
    return {
      objects: pageKeys.map((key) => {
        const record = this.record(key, this.objects.get(key));
        delete record.body;
        delete record.arrayBuffer;
        return record;
      }),
      truncated,
      ...(truncated && pageKeys.length ? { cursor: pageKeys[pageKeys.length - 1] } : {}),
    };
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

class FakeEdgeCache {
  constructor() {
    this.responses = new Map();
    this.matches = 0;
    this.puts = 0;
    this.deletes = 0;
  }

  async match(request) {
    this.matches += 1;
    const response = this.responses.get(request.url);
    return response ? response.clone() : undefined;
  }

  async put(request, response) {
    this.puts += 1;
    this.responses.set(request.url, response.clone());
  }

  async delete(request) {
    this.deletes += 1;
    return this.responses.delete(request.url);
  }
}

async function temporary(t, prefix) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t) {
  const directory = await temporary(t, 'norva-worker-hls-');
  await fsp.writeFile(path.join(directory, 'index.m3u8'), [
    '#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXTINF:2,', 'segment-000.ts', '#EXT-X-ENDLIST', '',
  ].join('\n'));
  await fsp.writeFile(path.join(directory, 'segment-000.ts'), Buffer.from('video-segment'));
  return { directory, rootPlaylist: 'index.m3u8', files: ['index.m3u8', 'segment-000.ts'] };
}

function identity() {
  return {
    contentSha256: 'c3'.repeat(32),
    fileSizeBytes: 10_000_000,
    videoProfile: {
      streamIndex: 0, codec: 'h264', profile: 'high', level: 41,
      width: 1920, height: 1080, pixelFormat: 'yuv420p',
      frameRateNumerator: 25, frameRateDenominator: 1,
    },
    audioTopology: [
      { streamIndex: 1, codec: 'aac', language: 'eng', channels: 2, sampleRate: 48_000, title: null, default: true, forced: false },
    ],
    subtitleTopology: [],
    durationMilliseconds: 7_200_000,
    pipelineBuild: 'mkv-h264-hls-fmp4-v3',
    segmenterBuild: 'ffmpeg-8.0-norva-4',
  };
}

function environment(bucket) {
  return {
    MEDIA_CACHE_BUCKET: bucket,
    MEDIA_CACHE_GATEWAY_TOKEN: SERVICE_TOKEN,
    MEDIA_CACHE_MANIFEST_HMAC_KEY: MANIFEST_KEY,
    MEDIA_CACHE_TICKET_HMAC_KEY: TICKET_KEY,
    MEDIA_CACHE_CLOUDFLARE_ZONE_ID: 'ab'.repeat(16),
    MEDIA_CACHE_CLOUDFLARE_PURGE_TOKEN: 'cloudflare-purge-token-'.padEnd(40, 'x'),
    MEDIA_CACHE_CLOUDFLARE_PURGE_FETCH: async () => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    MEDIA_CACHE_ALLOWED_ORIGINS: 'https://norva.tv',
  };
}

async function publishedFixture(t, env, identityOverrides = {}) {
  const store = new PrivateMediaCacheStoreClient({
    baseUrl: 'https://cache.test/', serviceToken: SERVICE_TOKEN,
    fetch: workerFetch(env), retryDelaysMs: [], timeoutMs: 2_000,
  });
  const hls = await fixture(t);
  const publication = await new SharedHlsObjectPublisher({
    objectStore: store, manifestHmacKey: MANIFEST_KEY, ttlMs: 60_000, maxEntryBytes: 1024 * 1024,
  }).publish({
    identity: { ...identity(), ...identityOverrides },
    sourceDirectory: hls.directory, rootPlaylist: hls.rootPlaylist, files: hls.files,
    completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
  });
  const playbackSessionId = crypto.randomUUID();
  const ticket = await ticketModule.createMediaCacheTicket(TICKET_KEY, {
    objectKey: publication.objectKey,
    bindingId: crypto.randomUUID(),
    playbackSessionId,
    expiresAtMs: Date.now() + 60_000,
  });
  return { publication, playbackSessionId, ticket };
}

function workerFetch(env) {
  return (url, init) => worker.fetch(new Request(url, init), env);
}

test('Gateway publication through the private Worker yields an authenticated HLS hit and no public bucket access', async (t) => {
  const bucket = new FakeR2Bucket();
  const env = environment(bucket);
  const store = new PrivateMediaCacheStoreClient({
    baseUrl: 'https://cache.test/',
    serviceToken: SERVICE_TOKEN,
    fetch: workerFetch(env),
    retryDelaysMs: [],
    timeoutMs: 2_000,
  });
  const hls = await fixture(t);
  const publisher = new SharedHlsObjectPublisher({
    objectStore: store,
    manifestHmacKey: MANIFEST_KEY,
    ttlMs: 60_000,
    maxEntryBytes: 1024 * 1024,
  });
  const publication = await publisher.publish({
    identity: identity(),
    sourceDirectory: hls.directory,
    rootPlaylist: hls.rootPlaylist,
    files: hls.files,
    completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
  });
  assert.equal(bucket.objects.has(publication.manifestKey), true);
  assert.equal([...bucket.objects.keys()].every((key) => key.startsWith('media-cache/v1/')), true);

  const playbackSessionId = '11111111-1111-4111-8111-111111111111';
  const bindingId = '22222222-2222-4222-8222-222222222222';
  const ticket = await ticketModule.createMediaCacheTicket(TICKET_KEY, {
    objectKey: publication.objectKey,
    bindingId,
    playbackSessionId,
    expiresAtMs: Date.now() + 60_000,
  });
  const playlistUrl = `https://cache.test/v1/hls/${publication.objectKey}/index.m3u8`;
  const playlist = await worker.fetch(new Request(playlistUrl, {
    headers: { authorization: `Bearer ${ticket}`, origin: 'https://norva.tv' },
  }), env);
  assert.equal(playlist.status, 200);
  assert.equal(playlist.headers.get('cache-control'), 'private, no-store');
  assert.match(await playlist.text(), /segment-000\.ts/);
  assert.equal(playlist.headers.get('access-control-allow-origin'), 'https://norva.tv');

  const segment = await worker.fetch(new Request(
    `https://cache.test/v1/hls/${publication.objectKey}/segment-000.ts`,
    { headers: { authorization: `Bearer ${ticket}`, origin: 'https://norva.tv' } },
  ), env);
  assert.equal(segment.status, 200);
  assert.deepEqual(Buffer.from(await segment.arrayBuffer()), Buffer.from('video-segment'));

  const range = await worker.fetch(new Request(
    `https://cache.test/v1/hls/${publication.objectKey}/segment-000.ts`,
    { headers: { authorization: `Bearer ${ticket}`, range: 'bytes=0-4' } },
  ), env);
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 0-4/13');
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.from('video'));

  const head = await worker.fetch(new Request(playlistUrl, {
    method: 'HEAD', headers: { authorization: `Bearer ${ticket}` },
  }), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment-000.ts\n#EXT-X-ENDLIST\n')));
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const anonymous = await worker.fetch(new Request(playlistUrl), env);
  assert.equal(anonymous.status, 401);
  const wrongObject = await worker.fetch(new Request(
    `https://cache.test/v1/hls/${'d4'.repeat(32)}/index.m3u8`,
    { headers: { authorization: `Bearer ${ticket}` } },
  ), env);
  assert.equal(wrongObject.status, 403);
  const malformedPath = await worker.fetch(new Request(
    `https://cache.test/v1/hls/${publication.objectKey}/%E0%A4%A`,
    { headers: { authorization: `Bearer ${ticket}` } },
  ), env);
  assert.equal(malformedPath.status, 400);
  assert.equal(bucket.objects.has('public/index.m3u8'), false);
});

test('private object writes require service auth, bind metadata to their object and stay immutable', async () => {
  const bucket = new FakeR2Bucket();
  const env = environment(bucket);
  const body = Buffer.from('immutable-asset');
  const digest = sha256(body);
  const key = `media-cache/v1/${'d7'.repeat(1)}/${'d7'.repeat(32)}/assets/${digest}`;
  const encodedKey = Buffer.from(key).toString('base64url');
  const url = `https://cache.test/internal/v1/objects/${encodedKey}`;
  const objectKey = 'd7'.repeat(32);
  const metadata = {
    kind: 'hls-asset',
    'object-key': objectKey,
    'asset-sha256': digest,
    'logical-path-sha256': sha256('segment-000.ts'),
  };
  const headers = {
    authorization: `Bearer ${SERVICE_TOKEN}`,
    'content-length': String(body.length),
    'content-type': 'video/mp2t',
    'x-norva-content-sha256': digest,
    'x-norva-object-metadata': Buffer.from(JSON.stringify(metadata)).toString('base64url'),
  };
  assert.equal((await worker.fetch(new Request(url, { method: 'PUT', headers: { ...headers, authorization: undefined }, body }), env)).status, 401);
  assert.equal((await worker.fetch(new Request(url, { method: 'PUT', headers, body }), env)).status, 201);
  assert.equal((await worker.fetch(new Request(url, { method: 'PUT', headers, body }), env)).status, 200);

  const mismatchedMetadata = { ...metadata, 'asset-sha256': '0'.repeat(64) };
  const mismatch = await worker.fetch(new Request(url, {
    method: 'PUT',
    headers: { ...headers, 'x-norva-object-metadata': Buffer.from(JSON.stringify(mismatchedMetadata)).toString('base64url') },
    body,
  }), env);
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).code, 'OBJECT_METADATA_MISMATCH');

  const conflictingMetadata = { ...metadata, 'logical-path-sha256': sha256('different-path.ts') };
  const conflictHeaders = {
    ...headers,
    'x-norva-object-metadata': Buffer.from(JSON.stringify(conflictingMetadata)).toString('base64url'),
  };
  const conflict = await worker.fetch(new Request(url, { method: 'PUT', headers: conflictHeaders, body }), env);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'IMMUTABLE_CONFLICT');
});

test('R2 SHA-256 metadata is mandatory for manifests and assets', async (t) => {
  const manifestBucket = new FakeR2Bucket();
  const manifestEnv = environment(manifestBucket);
  const manifestFixture = await publishedFixture(t, manifestEnv, { contentSha256: '71'.repeat(32) });
  manifestBucket.objects.get(manifestFixture.publication.manifestKey).omitChecksum = true;
  const manifestResponse = await worker.fetch(new Request(
    `https://cache.test/v1/hls/${manifestFixture.publication.objectKey}/index.m3u8`,
    { headers: { authorization: `Bearer ${manifestFixture.ticket}` } },
  ), manifestEnv);
  assert.equal(manifestResponse.status, 502);
  assert.equal((await manifestResponse.json()).code, 'MANIFEST_INVALID');

  const assetBucket = new FakeR2Bucket();
  const assetEnv = environment(assetBucket);
  const assetFixture = await publishedFixture(t, assetEnv, { contentSha256: '72'.repeat(32) });
  const assetKey = [...assetBucket.objects.keys()].find((key) => (
    key.startsWith(assetFixture.publication.objectPrefix)
      && assetBucket.objects.get(key).httpMetadata.contentType === 'video/mp2t'
  ));
  assert.ok(assetKey);
  assetBucket.objects.get(assetKey).omitChecksum = true;
  const assetResponse = await worker.fetch(new Request(
    `https://cache.test/v1/hls/${assetFixture.publication.objectKey}/segment-000.ts`,
    { headers: { authorization: `Bearer ${assetFixture.ticket}` } },
  ), assetEnv);
  assert.equal(assetResponse.status, 502);
  assert.equal((await assetResponse.json()).code, 'ASSET_CORRUPT');
});

test('session revocation blocks a valid ticket without deleting the shared HLS object', async (t) => {
  const bucket = new FakeR2Bucket();
  const env = environment(bucket);
  const store = new PrivateMediaCacheStoreClient({
    baseUrl: 'https://cache.test/', serviceToken: SERVICE_TOKEN,
    fetch: workerFetch(env), retryDelaysMs: [], timeoutMs: 2_000,
  });
  const hls = await fixture(t);
  const publication = await new SharedHlsObjectPublisher({
    objectStore: store, manifestHmacKey: MANIFEST_KEY, ttlMs: 60_000, maxEntryBytes: 1024 * 1024,
  }).publish({
    identity: identity(), sourceDirectory: hls.directory, rootPlaylist: hls.rootPlaylist, files: hls.files,
    completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
  });
  const playbackSessionId = '33333333-3333-4333-8333-333333333333';
  const ticket = await ticketModule.createMediaCacheTicket(TICKET_KEY, {
    objectKey: publication.objectKey,
    bindingId: '44444444-4444-4444-8444-444444444444',
    playbackSessionId,
    expiresAtMs: Date.now() + 60_000,
  });
  const assetUrl = `https://cache.test/v1/hls/${publication.objectKey}/segment-000.ts`;
  assert.equal((await worker.fetch(new Request(assetUrl, { headers: { authorization: `Bearer ${ticket}` } }), env)).status, 200);
  const revoke = await worker.fetch(new Request(
    `https://cache.test/internal/v1/revocations/${playbackSessionId}`,
    { method: 'PUT', headers: { authorization: `Bearer ${SERVICE_TOKEN}` } },
  ), env);
  assert.equal(revoke.status, 200);
  assert.equal((await worker.fetch(new Request(assetUrl, { headers: { authorization: `Bearer ${ticket}` } }), env)).status, 403);
  assert.equal(bucket.objects.has(publication.manifestKey), true, 'revocation never removes the immutable media object');
});

test('authorization precedes one canonical shared edge-cache lookup and exposes no-secret layer metrics', async (t) => {
  const bucket = new FakeR2Bucket();
  const cache = new FakeEdgeCache();
  const env = { ...environment(bucket), MEDIA_CACHE_EDGE_CACHE: cache };
  const { publication, ticket } = await publishedFixture(t, env);
  const assetUrl = `https://cache.test/v1/hls/${publication.objectKey}/segment-000.ts`;

  const cold = await worker.fetch(new Request(assetUrl, {
    headers: { authorization: `Bearer ${ticket}` },
  }), env);
  assert.equal(cold.status, 200);
  assert.equal(cold.headers.get('cache-control'), 'private, no-store');
  assert.equal(cold.headers.get('x-norva-cache-layer'), 'r2');
  assert.deepEqual(Buffer.from(await cold.arrayBuffer()), Buffer.from('video-segment'));
  assert.equal(cache.puts, 1);

  const hot = await worker.fetch(new Request(assetUrl, {
    headers: { authorization: `Bearer ${ticket}` },
  }), env);
  assert.equal(hot.status, 200);
  assert.equal(hot.headers.get('cache-control'), 'private, no-store');
  assert.equal(hot.headers.get('x-norva-cache-layer'), 'cdn');
  assert.deepEqual(Buffer.from(await hot.arrayBuffer()), Buffer.from('video-segment'));
  const matchesAfterAuthorizedReads = cache.matches;

  const anonymous = await worker.fetch(new Request(assetUrl), env);
  assert.equal(anonymous.status, 401);
  assert.equal(cache.matches, matchesAfterAuthorizedReads, 'ticket authorization happens before CDN lookup');

  const metrics = await worker.fetch(new Request('https://cache.test/internal/v1/metrics', {
    headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
  }), env);
  assert.equal(metrics.status, 200);
  const payload = await metrics.json();
  assert.ok(payload.layers.cdn.hits >= 1);
  assert.ok(payload.layers.cdn.misses >= 1);
  assert.ok(payload.layers.r2.hits >= 1);
  assert.equal(JSON.stringify(payload).includes(SERVICE_TOKEN), false);
  assert.equal(JSON.stringify(payload).includes(ticket), false);
});

test('corruption is quarantined, purge clears R2 and CDN, and only verified regeneration recovers service', async (t) => {
  const bucket = new FakeR2Bucket();
  const cache = new FakeEdgeCache();
  const purgeCalls = [];
  const env = {
    ...environment(bucket),
    MEDIA_CACHE_EDGE_CACHE: cache,
    MEDIA_CACHE_CLOUDFLARE_PURGE_FETCH: async (url, init) => {
      purgeCalls.push({ url, init });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  const { publication, ticket } = await publishedFixture(t, env);
  const assetUrl = `https://cache.test/v1/hls/${publication.objectKey}/segment-000.ts`;
  const segmentKey = [...bucket.objects.keys()].find((key) => (
    key.startsWith(publication.objectPrefix) && bucket.objects.get(key).customMetadata.kind === 'hls-asset'
      && bucket.objects.get(key).httpMetadata.contentType === 'video/mp2t'
  ));
  assert.ok(segmentKey);
  bucket.objects.get(segmentKey).customMetadata['norva-sha256'] = '0'.repeat(64);

  const corrupt = await worker.fetch(new Request(assetUrl, {
    headers: { authorization: `Bearer ${ticket}` },
  }), env);
  assert.equal(corrupt.status, 502);
  assert.equal((await corrupt.json()).code, 'ASSET_CORRUPT');
  assert.equal(bucket.objects.has(`media-cache-quarantine/v1/${publication.objectKey}`), true);

  bucket.objects.get(segmentKey).customMetadata['norva-sha256'] = bucket.objects.get(segmentKey).sha256;
  const blocked = await worker.fetch(new Request(assetUrl, {
    headers: { authorization: `Bearer ${ticket}` },
  }), env);
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).code, 'OBJECT_QUARANTINED');

  const purge = await worker.fetch(new Request(
    `https://cache.test/internal/v1/cache-objects/${publication.objectKey}`,
    {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'x-norva-purge-reason': 'corruption',
      },
    },
  ), env);
  assert.equal(purge.status, 200);
  assert.equal([...bucket.objects.keys()].some((key) => key.startsWith(publication.objectPrefix)), false);
  assert.equal(bucket.objects.has(`media-cache-quarantine/v1/${publication.objectKey}`), true);
  assert.equal(purgeCalls.length, 1);
  assert.deepEqual(JSON.parse(purgeCalls[0].init.body), {
    tags: [`norva-mc-${publication.objectKey}`],
  });
  assert.match(purgeCalls[0].url, /\/zones\/[0-9a-f]{32}\/purge_cache$/);

  const regenerated = await publishedFixture(t, env);
  assert.equal(regenerated.publication.objectKey, publication.objectKey);
  const stillBlocked = await worker.fetch(new Request(assetUrl, {
    headers: { authorization: `Bearer ${ticket}` },
  }), env);
  assert.equal(stillBlocked.status, 503);

  const recoveryVerification = await worker.fetch(new Request(
    `https://cache.test/internal/v1/recoveries/${publication.objectKey}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'x-norva-recovery-phase': 'verify',
      },
    },
  ), env);
  assert.equal(recoveryVerification.status, 200);
  const recoveryProof = await recoveryVerification.json();
  assert.equal(recoveryProof.status, 'verified-quarantined');
  assert.match(recoveryProof.manifestSha256, /^[0-9a-f]{64}$/);
  assert.ok(recoveryProof.totalBytes > 0);
  assert.ok(recoveryProof.expiresAtMs > Date.now());
  assert.deepEqual(Object.keys(recoveryProof.components).sort(), [
    'audio', 'content', 'duration', 'pipeline', 'segmenter', 'size', 'subtitles', 'video',
  ]);
  assert.ok(Object.values(recoveryProof.components).every((digest) => /^[0-9a-f]{64}$/.test(digest)));
  assert.equal(recoveryProof.rootPlaylist, 'index.m3u8');
  const blockedUntilCommit = await worker.fetch(new Request(assetUrl, {
    headers: { authorization: `Bearer ${ticket}` },
  }), env);
  assert.equal(blockedUntilCommit.status, 503);

  const recoveryCommit = await worker.fetch(new Request(
    `https://cache.test/internal/v1/recoveries/${publication.objectKey}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'x-norva-recovery-phase': 'commit',
      },
    },
  ), env);
  assert.equal(recoveryCommit.status, 200);
  assert.equal((await recoveryCommit.json()).status, 'ready');
  const recoveryCommitRetry = await worker.fetch(new Request(
    `https://cache.test/internal/v1/recoveries/${publication.objectKey}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'x-norva-recovery-phase': 'commit',
      },
    },
  ), env);
  assert.equal(recoveryCommitRetry.status, 200);
  assert.equal((await recoveryCommitRetry.json()).status, 'already-ready');
  const recovered = await worker.fetch(new Request(assetUrl, {
    headers: { authorization: `Bearer ${ticket}` },
  }), env);
  assert.equal(recovered.status, 200);
  assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), Buffer.from('video-segment'));
  assert.ok(cache.deletes >= 1);
});

test('critical purge stays quarantined and retains R2 bytes until global Cloudflare purge is configured', async (t) => {
  const bucket = new FakeR2Bucket();
  const env = environment(bucket);
  delete env.MEDIA_CACHE_CLOUDFLARE_ZONE_ID;
  delete env.MEDIA_CACHE_CLOUDFLARE_PURGE_TOKEN;
  delete env.MEDIA_CACHE_CLOUDFLARE_PURGE_FETCH;
  const { publication } = await publishedFixture(t, env);
  const response = await worker.fetch(new Request(
    `https://cache.test/internal/v1/cache-objects/${publication.objectKey}`,
    {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'x-norva-purge-reason': 'security',
      },
    },
  ), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'GLOBAL_EDGE_PURGE_UNAVAILABLE');
  assert.equal(bucket.objects.has(publication.manifestKey), true);
  assert.equal(bucket.objects.has(`media-cache-quarantine/v1/${publication.objectKey}`), true);
});

test('legal and security tombstones cannot be downgraded, republished or recovered', async (t) => {
  const bucket = new FakeR2Bucket();
  const env = environment(bucket);
  const { publication } = await publishedFixture(t, env);
  const endpoint = `https://cache.test/internal/v1/cache-objects/${publication.objectKey}`;
  const securityPurge = await worker.fetch(new Request(endpoint, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      'x-norva-purge-reason': 'security',
    },
  }), env);
  assert.equal(securityPurge.status, 200);
  const markerKey = `media-cache-quarantine/v1/${publication.objectKey}`;
  assert.equal(bucket.objects.get(markerKey).customMetadata.reason, 'security');

  const weakerPurge = await worker.fetch(new Request(endpoint, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      'x-norva-purge-reason': 'corruption',
    },
  }), env);
  assert.equal(weakerPurge.status, 200);
  assert.equal(bucket.objects.get(markerKey).customMetadata.reason, 'security');

  await assert.rejects(() => publishedFixture(t, env));
  const recovery = await worker.fetch(new Request(
    `https://cache.test/internal/v1/recoveries/${publication.objectKey}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'x-norva-recovery-phase': 'verify',
      },
    },
  ), env);
  assert.equal(recovery.status, 409);
  assert.equal((await recovery.json()).code, 'OBJECT_RECOVERY_FORBIDDEN');
});

test('eviction never removes a pre-existing corruption quarantine marker', async (t) => {
  const bucket = new FakeR2Bucket();
  const env = environment(bucket);
  const { publication } = await publishedFixture(t, env);
  const markerKey = `media-cache-quarantine/v1/${publication.objectKey}`;
  await bucket.put(markerKey, 'quarantined\n', { customMetadata: { kind: 'media-cache-quarantine' } });
  const response = await worker.fetch(new Request(
    `https://cache.test/internal/v1/cache-objects/${publication.objectKey}`,
    {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'x-norva-purge-reason': 'eviction',
      },
    },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(bucket.objects.has(markerKey), true);
});

test('inventory reports old manifest-less R2 prefixes as candidates but never deletes them autonomously', async () => {
  const bucket = new FakeR2Bucket();
  const env = environment(bucket);
  const objectKey = '9a'.repeat(32);
  const body = Buffer.from('orphan');
  const digest = sha256(body);
  const key = `media-cache/v1/${objectKey.slice(0, 2)}/${objectKey}/assets/${digest}`;
  await bucket.put(key, body, {
    sha256: digest,
    customMetadata: {
      kind: 'hls-asset',
      'object-key': objectKey,
      'asset-sha256': digest,
      'logical-path-sha256': sha256('orphan.ts'),
      'norva-sha256': digest,
    },
    httpMetadata: { contentType: 'video/mp2t' },
  });
  bucket.objects.get(key).uploaded = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const response = await worker.fetch(new Request(
    'https://cache.test/internal/v1/inventory?minimumAgeMs=300000',
    { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } },
  ), env);
  assert.equal(response.status, 200);
  const inventory = await response.json();
  assert.deepEqual(inventory.orphanCandidates.map((item) => item.objectKey), [objectKey]);
  assert.deepEqual(inventory.manifestCandidates, []);
  assert.equal(bucket.objects.has(key), true, 'database lease authority must approve physical orphan purge');
});

test('inventory exposes old manifest-complete prefixes for database authority reconciliation', async (t) => {
  const bucket = new FakeR2Bucket();
  const env = environment(bucket);
  const { publication } = await publishedFixture(t, env);
  for (const [key, stored] of bucket.objects) {
    if (key.startsWith(publication.objectPrefix)) stored.uploaded = new Date(Date.now() - 2 * 60 * 60 * 1000);
  }
  const response = await worker.fetch(new Request(
    'https://cache.test/internal/v1/inventory?minimumAgeMs=300000',
    { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } },
  ), env);
  assert.equal(response.status, 200);
  const inventory = await response.json();
  assert.deepEqual(inventory.orphanCandidates, []);
  assert.deepEqual(inventory.manifestCandidates.map((item) => item.objectKey), [publication.objectKey]);
});

test('tickets are exact, short-lived, object-bound and authenticated with a dedicated key', async () => {
  const now = 10_000_000;
  const payload = {
    objectKey: 'e5'.repeat(32),
    bindingId: '55555555-5555-4555-8555-555555555555',
    playbackSessionId: '66666666-6666-4666-8666-666666666666',
    expiresAtMs: now + 60_000,
  };
  const ticket = await ticketModule.createMediaCacheTicket(TICKET_KEY, payload, now);
  const verified = await ticketModule.verifyMediaCacheTicket(TICKET_KEY, ticket, now + 1);
  assert.equal(verified.objectKey, payload.objectKey);
  await assert.rejects(
    () => ticketModule.verifyMediaCacheTicket('f6'.repeat(32), ticket, now + 1),
    (error) => error.code === 'INVALID_MEDIA_CACHE_TICKET',
  );
  await assert.rejects(
    () => ticketModule.verifyMediaCacheTicket(TICKET_KEY, ticket, payload.expiresAtMs),
    (error) => error.code === 'MEDIA_CACHE_TICKET_EXPIRED',
  );
  await assert.rejects(
    () => ticketModule.createMediaCacheTicket(TICKET_KEY, { ...payload, expiresAtMs: now + 5 * 60_000 + 1 }, now),
    (error) => error.code === 'INVALID_MEDIA_CACHE_TICKET',
  );
});
