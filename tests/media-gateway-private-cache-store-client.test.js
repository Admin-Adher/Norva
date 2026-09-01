'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const {
  PrivateMediaCacheStoreClient,
} = require('../services/media-gateway/src/privateMediaCacheStoreClient');

const SERVICE_TOKEN = 'gateway-service-token-'.padEnd(48, 'x');
const digest = (body) => crypto.createHash('sha256').update(body).digest('hex');

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function startStoreServer(t, options = {}) {
  const objects = new Map();
  const requests = [];
  let unavailable = Number(options.unavailable || 0);
  const server = http.createServer(async (request, response) => {
    const match = /^\/cache\/internal\/v1\/objects\/([A-Za-z0-9_-]+)$/.exec(request.url || '');
    if (!match) {
      response.writeHead(404).end();
      return;
    }
    const key = Buffer.from(match[1], 'base64url').toString('utf8');
    requests.push({ method: request.method, key, headers: { ...request.headers } });
    if (request.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    if (unavailable > 0) {
      unavailable -= 1;
      response.writeHead(503).end('temporary');
      return;
    }
    if (request.method === 'PUT') {
      const body = await readRequest(request);
      const sha256 = request.headers['x-norva-content-sha256'];
      const metadata = request.headers['x-norva-object-metadata'];
      if (request.headers['if-none-match'] !== '*' || digest(body) !== sha256) {
        response.writeHead(422).end();
        return;
      }
      const existing = objects.get(key);
      if (existing && (existing.sha256 !== sha256 || !existing.body.equals(body) || existing.metadata !== metadata)) {
        response.writeHead(409).end();
        return;
      }
      const status = existing ? 'already-exists' : 'created';
      objects.set(key, { body, sha256, metadata, contentType: request.headers['content-type'] });
      const payload = Buffer.from(JSON.stringify({ ok: true, status, key, sha256, size: body.length }));
      response.writeHead(existing ? 200 : 201, {
        'content-type': 'application/json',
        'content-length': String(payload.length),
      }).end(payload);
      return;
    }
    if (request.method === 'GET') {
      const object = objects.get(key);
      if (!object) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-type': object.contentType,
        'content-length': String(object.body.length),
        'x-norva-content-sha256': object.sha256,
        'x-norva-object-metadata': object.metadata,
      }).end(object.body);
      return;
    }
    response.writeHead(405).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/cache/`,
    objects,
    requests,
  };
}

function client(baseUrl, overrides = {}) {
  return new PrivateMediaCacheStoreClient({
    baseUrl,
    serviceToken: SERVICE_TOKEN,
    retryDelaysMs: [0, 0],
    timeoutMs: 2_000,
    ...overrides,
  });
}

test('private Worker transport binds every immutable PUT and GET to auth, key, bytes and metadata', async (t) => {
  const server = await startStoreServer(t);
  const store = client(server.baseUrl);
  const key = 'media-cache/v1/aa/'.concat('a'.repeat(64), '/assets/', 'b'.repeat(64));
  const body = Buffer.from('private-hls-segment');
  const options = {
    sha256: digest(body),
    contentType: 'video/iso.segment',
    metadata: { kind: 'hls-asset', 'object-key': 'a'.repeat(64) },
  };
  assert.equal((await store.put(key, body, options)).status, 'created');
  assert.equal((await store.put(key, body, options)).status, 'already-exists');
  const restored = await store.get(key);
  assert.deepEqual(restored.body, body);
  assert.equal(restored.sha256, digest(body));
  assert.deepEqual(restored.metadata, options.metadata);
  assert.deepEqual(server.requests.map((request) => request.method), ['PUT', 'PUT', 'GET']);
  assert.equal(server.requests.every((request) => request.headers.authorization === `Bearer ${SERVICE_TOKEN}`), true);
  assert.equal(server.requests[0].headers['if-none-match'], '*');
});

test('private Worker transport retries bounded 5xx responses with the identical body', async (t) => {
  const server = await startStoreServer(t, { unavailable: 2 });
  const store = client(server.baseUrl);
  const key = 'media-cache/v1/cc/'.concat('c'.repeat(64), '/manifest.auth.json');
  const body = Buffer.from('{"manifest":true}\n');
  const result = await store.put(key, body, {
    sha256: digest(body),
    contentType: 'application/json',
    metadata: { kind: 'hls-manifest' },
  });
  assert.equal(result.status, 'created');
  assert.equal(server.requests.length, 3);
  assert.equal(server.objects.get(key).body.equals(body), true);
});

test('private Worker transport fails closed on immutable conflict, wrong auth and response digest drift', async (t) => {
  const server = await startStoreServer(t);
  const key = 'media-cache/v1/dd/'.concat('d'.repeat(64), '/assets/', 'e'.repeat(64));
  const first = Buffer.from('first');
  const store = client(server.baseUrl);
  await store.put(key, first, { sha256: digest(first), metadata: { kind: 'hls-asset' } });
  const changed = Buffer.from('changed');
  await assert.rejects(
    () => store.put(key, changed, { sha256: digest(changed), metadata: { kind: 'hls-asset' } }),
    (error) => error.code === 'MEDIA_CACHE_IMMUTABLE_CONFLICT' && error.status === 409,
  );
  await assert.rejects(
    () => client(server.baseUrl, { serviceToken: 'wrong-token-'.padEnd(40, 'x') }).get(key),
    (error) => error.code === 'MEDIA_CACHE_WORKER_AUTH_FAILED' && error.status === 401,
  );
  server.objects.get(key).sha256 = 'f'.repeat(64);
  await assert.rejects(
    () => store.get(key),
    (error) => error.code === 'MEDIA_CACHE_DIGEST_MISMATCH',
  );
});

test('private Worker transport rejects unsafe endpoints, paths, metadata and local digest mismatch before I/O', async () => {
  assert.throws(
    () => client('http://media-cache.example/'),
    (error) => error.code === 'MEDIA_CACHE_CLIENT_CONFIG_INVALID',
  );
  const store = client('http://127.0.0.1:9/cache/');
  await assert.rejects(
    () => store.put('../escape', Buffer.from('x'), { sha256: digest(Buffer.from('x')) }),
    (error) => error.code === 'MEDIA_CACHE_OBJECT_KEY_INVALID',
  );
  await assert.rejects(
    () => store.put('safe/key', Buffer.from('x'), { sha256: '0'.repeat(64) }),
    (error) => error.code === 'MEDIA_CACHE_DIGEST_MISMATCH',
  );
  await assert.rejects(
    () => store.put('safe/key', Buffer.from('x'), { metadata: { Bad_Key: 'x' } }),
    (error) => error.code === 'MEDIA_CACHE_METADATA_INVALID',
  );
});
