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
      uploaded: new Date(),
      customMetadata: { ...stored.customMetadata },
      httpMetadata: { ...stored.httpMetadata },
      checksums: { sha256: checksum.buffer.slice(checksum.byteOffset, checksum.byteOffset + checksum.byteLength) },
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
    MEDIA_CACHE_ALLOWED_ORIGINS: 'https://norva.tv',
  };
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
