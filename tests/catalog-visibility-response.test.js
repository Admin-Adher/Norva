'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const helperPath = path.join(
  ROOT,
  'supabase/functions/_shared/catalog-visibility-response.mjs',
);
const read = (file) => fs
  .readFileSync(path.join(ROOT, file), 'utf8')
  .replace(/\r\n?/g, '\n');

let helperPromise;
function helper() {
  helperPromise ??= import(pathToFileURL(helperPath).href);
  return helperPromise;
}

function sequencedDb(...outcomes) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (outcome instanceof Error) return { data: null, error: { message: outcome.message } };
      return { data: typeof outcome === 'object' ? outcome : epoch(1, outcome), error: null };
    },
  };
}

function epoch(globalEpoch, userEpoch) {
  return {
    contract: 'catalog-cache-epoch-v2',
    globalEpoch: String(globalEpoch),
    userEpoch: String(userEpoch),
    cacheEpoch: `v2.${globalEpoch}.${userEpoch}`,
  };
}

const corsHeaders = () => ({
  'Access-Control-Allow-Origin': 'https://norva.tv',
  'Access-Control-Expose-Headers': 'x-norva-visibility-epoch, x-norva-user-visibility-epoch, x-norva-global-visibility-epoch, x-norva-catalog-cache-contract',
});

async function jsonBody(response) {
  return JSON.parse(await response.text());
}

test('deep cache scopes track the latest bound epoch without moving backwards', async () => {
  const api = await helper();
  const userId = 'user-cache-monotone';
  const first = new Request('https://edge.test/media-items?request=first');
  const newest = new Request('https://edge.test/media-items?request=newest');
  const olderRace = new Request('https://edge.test/media-items?request=older-race');

  await api.bindCatalogVisibilityEpoch(first, userId, sequencedDb(7));
  assert.equal(api.boundCatalogVisibilityEpoch(first), '7');
  assert.equal(api.boundCatalogCacheEpoch(first), 'v2.1.7');
  assert.equal(api.latestBoundCatalogVisibilityEpoch(userId), '7');
  assert.equal(api.latestBoundCatalogCacheEpoch(userId), 'v2.1.7');

  await api.bindCatalogVisibilityEpoch(newest, userId, sequencedDb(9));
  assert.equal(api.boundCatalogVisibilityEpoch(newest), '9');
  assert.equal(api.latestBoundCatalogVisibilityEpoch(userId), '9');
  assert.equal(api.latestBoundCatalogCacheEpoch(userId), 'v2.1.9');

  await api.bindCatalogVisibilityEpoch(olderRace, userId, sequencedDb(8));
  assert.equal(api.boundCatalogVisibilityEpoch(olderRace), '8');
  assert.equal(api.latestBoundCatalogVisibilityEpoch(userId), '9');
  assert.equal(api.latestBoundCatalogCacheEpoch(userId), 'v2.1.9');
});

test('stable authenticated reads are rechecked immediately and retain their cache contract', async () => {
  const api = await helper();
  const req = new Request('https://edge.test/media-items', { method: 'GET' });
  const db = sequencedDb(7, 7);
  await api.bindCatalogVisibilityEpoch(req, 'user-a', db);

  const response = await api.finalizeCatalogVisibilityResponse(
    req,
    new Response('{"items":[1]}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=30' },
    }),
    db,
    { service: 'test', corsHeaders },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-norva-visibility-epoch'), 'v2.1.7');
  assert.equal(response.headers.get('x-norva-user-visibility-epoch'), '7');
  assert.equal(response.headers.get('x-norva-global-visibility-epoch'), '1');
  assert.equal(response.headers.get('x-norva-catalog-cache-contract'), 'v2');
  assert.equal(response.headers.get('cache-control'), 'private, max-age=30');
  assert.deepEqual(await jsonBody(response), { items: [1] });
  assert.equal(db.calls.length, 2);
  assert.deepEqual(db.calls.map((call) => call.name), [
    'norva_catalog_cache_epoch_v2',
    'norva_catalog_cache_epoch_v2',
  ]);
});

test('a read spanning a cutover drops the stale body and returns a retryable current-epoch 409', async () => {
  const api = await helper();
  const req = new Request('https://edge.test/home/rails', { method: 'GET' });
  const db = sequencedDb('12', '13');
  await api.bindCatalogVisibilityEpoch(req, 'user-b', db);

  const response = await api.finalizeCatalogVisibilityResponse(
    req,
    new Response(JSON.stringify({ secretOldCatalogBody: true }), { status: 200 }),
    db,
    { service: 'test', corsHeaders },
  );
  const payload = await jsonBody(response);

  assert.equal(response.status, 409);
  assert.equal(response.headers.get('x-norva-visibility-epoch'), 'v2.1.13');
  assert.equal(response.headers.get('retry-after'), '0');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(payload.details.code, api.CATALOG_VISIBILITY_EPOCH_CHANGED);
  assert.doesNotMatch(JSON.stringify(payload), /secretOldCatalogBody/);
});

test('a global policy cutover invalidates a response even when the account epoch is unchanged', async () => {
  const api = await helper();
  const req = new Request('https://edge.test/home/rails', { method: 'GET' });
  const db = sequencedDb(epoch(4, 12), epoch(5, 12));
  await api.bindCatalogVisibilityEpoch(req, 'user-global-cutover', db);

  const response = await api.finalizeCatalogVisibilityResponse(
    req,
    new Response(JSON.stringify({ oldPolicyBody: true }), { status: 200 }),
    db,
    { service: 'test', corsHeaders },
  );
  const payload = await jsonBody(response);

  assert.equal(response.status, 409);
  assert.equal(response.headers.get('x-norva-visibility-epoch'), 'v2.5.12');
  assert.equal(payload.details.code, api.CATALOG_VISIBILITY_EPOCH_CHANGED);
  assert.doesNotMatch(JSON.stringify(payload), /oldPolicyBody/);
});

test('an unacknowledged mutation spanning a cutover reports an ambiguous outcome without retry permission', async () => {
  const api = await helper();
  const req = new Request('https://edge.test/playback/sessions', { method: 'POST' });
  const db = sequencedDb(21, 22);
  await api.bindCatalogVisibilityEpoch(req, 'user-c', db);

  let mutationExecutions = 0;
  mutationExecutions += 1;
  const response = await api.finalizeCatalogVisibilityResponse(
    req,
    new Response(JSON.stringify({ session: { id: 'already-committed' } }), { status: 201 }),
    db,
    { service: 'test', corsHeaders },
  );
  const payload = await jsonBody(response);

  assert.equal(mutationExecutions, 1, 'the response guard must never execute or retry a mutation');
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('x-norva-visibility-epoch'), 'v2.1.22');
  assert.equal(response.headers.has('retry-after'), false);
  assert.equal(payload.details.code, api.CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN);
  assert.doesNotMatch(JSON.stringify(payload), /already-committed/);
});

test('an explicitly acknowledged source visibility mutation returns once at its committed epoch', async () => {
  const api = await helper();
  const req = new Request('https://edge.test/sources/source-a/toggle', { method: 'POST' });
  const db = sequencedDb(30, 31, 31);
  await api.bindCatalogVisibilityEpoch(req, 'user-d', db);
  await api.acknowledgeCatalogVisibilityEpochMutation(req, db);

  const response = await api.finalizeCatalogVisibilityResponse(
    req,
    new Response(JSON.stringify({ success: true }), { status: 200 }),
    db,
    { service: 'test', corsHeaders },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-norva-visibility-epoch'), 'v2.1.31');
  assert.deepEqual(await jsonBody(response), { success: true });
  assert.equal(db.calls.length, 3);
});

test('a cutover after mutation acknowledgement is still rejected as an ambiguous mutation outcome', async () => {
  const api = await helper();
  const req = new Request('https://edge.test/sources/source-a', { method: 'DELETE' });
  const db = sequencedDb(40, 41, 42);
  await api.bindCatalogVisibilityEpoch(req, 'user-e', db);
  await api.acknowledgeCatalogVisibilityEpochMutation(req, db);

  const response = await api.finalizeCatalogVisibilityResponse(
    req,
    new Response(JSON.stringify({ success: true }), { status: 200 }),
    db,
    { service: 'test', corsHeaders },
  );
  const payload = await jsonBody(response);

  assert.equal(response.status, 409);
  assert.equal(response.headers.get('x-norva-visibility-epoch'), 'v2.1.42');
  assert.equal(response.headers.has('retry-after'), false);
  assert.equal(payload.details.code, api.CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN);
});

test('a plus-two jump before acknowledgement cannot be mistaken for the mutation own epoch', async () => {
  const api = await helper();
  const req = new Request('https://edge.test/sources/source-a/toggle', { method: 'POST' });
  const db = sequencedDb(80, 82, 82);
  await api.bindCatalogVisibilityEpoch(req, 'user-race', db);
  const acknowledged = await api.acknowledgeCatalogVisibilityEpochMutation(req, db);

  const response = await api.finalizeCatalogVisibilityResponse(
    req,
    new Response(JSON.stringify({ success: true, stale: true }), { status: 200 }),
    db,
    { service: 'test', corsHeaders },
  );
  const payload = await jsonBody(response);

  assert.equal(acknowledged, null);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('x-norva-visibility-epoch'), 'v2.1.82');
  assert.equal(response.headers.has('retry-after'), false);
  assert.equal(payload.details.code, api.CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN);
  assert.doesNotMatch(JSON.stringify(payload), /stale/);
});

test('a global cutover racing mutation acknowledgement is never blessed as that mutation', async () => {
  const api = await helper();
  const req = new Request('https://edge.test/sources/source-a/toggle', { method: 'POST' });
  const db = sequencedDb(epoch(2, 30), epoch(3, 31), epoch(3, 31));
  await api.bindCatalogVisibilityEpoch(req, 'user-global-mutation-race', db);
  const acknowledged = await api.acknowledgeCatalogVisibilityEpochMutation(req, db);

  const response = await api.finalizeCatalogVisibilityResponse(
    req,
    new Response(JSON.stringify({ success: true, stalePolicy: true }), { status: 200 }),
    db,
    { service: 'test', corsHeaders },
  );
  const payload = await jsonBody(response);

  assert.equal(acknowledged, null);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('x-norva-visibility-epoch'), 'v2.3.31');
  assert.equal(payload.details.code, api.CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN);
  assert.doesNotMatch(JSON.stringify(payload), /stalePolicy/);
});

test('a failed final lookup fails closed without reusing the stale bound epoch', async () => {
  const api = await helper();
  const req = new Request('https://edge.test/media-items', { method: 'GET' });
  const db = sequencedDb(50, new Error('epoch lookup failed'));
  await api.bindCatalogVisibilityEpoch(req, 'user-f', db);

  const response = await api.finalizeCatalogVisibilityResponse(
    req,
    new Response(JSON.stringify({ items: ['stale'] }), { status: 200 }),
    db,
    { service: 'test', corsHeaders },
  );
  const serialized = JSON.stringify(await jsonBody(response));

  assert.equal(response.status, 503);
  assert.equal(response.headers.has('x-norva-visibility-epoch'), false);
  assert.doesNotMatch(serialized, /epoch lookup failed|stale/);
  assert.match(serialized, /CATALOG_VISIBILITY_EPOCH_UNAVAILABLE/);
});

test('authenticated error envelopes strip provider, gateway, and database payloads at the final boundary', async () => {
  const api = await helper();
  const req = new Request('https://edge.test/playback/sessions', { method: 'POST' });
  const db = sequencedDb(60, 60);
  await api.bindCatalogVisibilityEpoch(req, 'user-g', db);

  const rawPayload = {
    error: 'database password leaked from upstream',
    code: 'TOP_LEVEL_IGNORED',
    details: {
      code: 'PROVIDER_REQUEST_FAILED',
      correlationId: 'trace-123:edge',
      password: 'provider-secret',
      username: 'provider-user',
      gateway: { body: 'raw upstream response' },
      database: { detail: 'relation cloud_sources' },
    },
  };
  const response = await api.finalizeCatalogVisibilityResponse(
    req,
    new Response(JSON.stringify(rawPayload), { status: 502 }),
    db,
    { service: 'test', corsHeaders },
  );
  const payload = await jsonBody(response);
  const serialized = JSON.stringify(payload);

  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-norva-visibility-epoch'), 'v2.1.60');
  assert.deepEqual(payload, {
    error: 'Service temporarily unavailable',
    details: {
      code: 'PROVIDER_REQUEST_FAILED',
      correlationId: 'trace-123:edge',
    },
  });
  assert.doesNotMatch(serialized, /password|provider-secret|provider-user|gateway|upstream response|relation cloud_sources/);
});

test('catalog and playback catches produce sanitized payloads and logs before finalization', async () => {
  const api = await helper();
  const error = Object.assign(new Error('gateway body includes password=provider-secret'), {
    details: {
      code: 'PROVIDER_REQUEST_FAILED',
      correlationId: 'request-123',
      username: 'provider-user',
      response: { body: 'raw provider response' },
      database: { detail: 'relation cloud_sources' },
    },
  });
  const payload = api.publicEdgeErrorPayload(error, 502, {
    unavailableMessage: 'Norva Playback is temporarily unavailable',
  });
  const log = api.publicEdgeErrorLog(error, 502, payload);

  assert.deepEqual(payload, {
    error: 'Norva Playback is temporarily unavailable',
    details: {
      code: 'PROVIDER_REQUEST_FAILED',
      correlationId: 'request-123',
    },
  });
  assert.deepEqual(log, {
    status: 502,
    name: 'Error',
    code: 'PROVIDER_REQUEST_FAILED',
    correlationId: 'request-123',
  });
  assert.doesNotMatch(
    `${JSON.stringify(payload)}\n${JSON.stringify(log)}`,
    /password|provider-secret|provider-user|raw provider response|relation cloud_sources/,
  );

  for (const file of [
    'supabase/functions/norva-catalog/index.ts',
    'supabase/functions/norva-playback/index.ts',
  ]) {
    const source = read(file);
    assert.match(source, /const payload = publicEdgeErrorPayload\(error, status,/i, file);
    assert.match(source, /console\.error\([^\n]*publicEdgeErrorLog\(error, status, payload\)\)/, file);
    assert.doesNotMatch(source, /return json\(req, \{ error: message, details \}, status\)/, file);
    assert.doesNotMatch(source, /console\.error\(\s*"\[norva-(?:catalog|playback)\]",\s*status,\s*message,\s*details/, file);
  }
});

test('non-allowlisted error codes and malformed correlation identifiers are not reflected', async () => {
  const api = await helper();
  const req = new Request('https://edge.test/history', { method: 'GET' });
  const db = sequencedDb(70, 70);
  await api.bindCatalogVisibilityEpoch(req, 'user-h', db);

  const response = await api.finalizeCatalogVisibilityResponse(
    req,
    new Response(JSON.stringify({
      error: 'Invalid request',
      details: {
        code: 'INTERNAL_PROVIDER_PASSWORD',
        correlationId: 'x'.repeat(129),
        providerResponse: { token: 'secret' },
      },
    }), { status: 400 }),
    db,
    { service: 'test', corsHeaders },
  );

  assert.deepEqual(await jsonBody(response), { error: 'Invalid request' });
});

test('public responses remain untouched and do not perform an epoch lookup', async () => {
  const api = await helper();
  const req = new Request('https://edge.test/health', { method: 'GET' });
  const db = sequencedDb(new Error('must not be called'));
  const original = new Response(JSON.stringify({ ok: true }), { status: 200 });
  const response = await api.finalizeCatalogVisibilityResponse(
    req,
    original,
    db,
    { service: 'test', corsHeaders },
  );

  assert.equal(response, original);
  assert.equal(db.calls.length, 0);
  assert.deepEqual(await jsonBody(response), { ok: true });
});

test('all three catalog surfaces route their externally returned response through the shared finalizer', () => {
  for (const file of [
    'supabase/functions/norva-catalog/index.ts',
    'supabase/functions/norva-cloud/index.ts',
    'supabase/functions/norva-playback/index.ts',
  ]) {
    const source = read(file);
    assert.match(source, /finalizeCatalogVisibilityResponse\(\s*req,\s*await handleRequest\(req\)/, file);
    assert.match(source, /bindCatalogVisibilityEpochShared\(req, userId, db\)/, file);
    assert.doesNotMatch(source, /const catalogVisibilityEpochs = new WeakMap/, file);
    assert.match(source, /Access-Control-Expose-Headers[^\n]*retry-after/, file);
  }

  const cloud = read('supabase/functions/norva-cloud/index.ts');
  assert.equal(
    (cloud.match(/await acknowledgeCatalogVisibilityEpochMutation\(req, db\);/g) || []).length,
    3,
    'only source create, toggle, and delete may acknowledge their own epoch advance',
  );
  assert.match(cloud, /if \(result\.visibilityChanged\) \{\s*await acknowledgeCatalogVisibilityEpochMutation/);
  assert.match(cloud, /\.is\("deleted_at", null\)\s*\.select\("id"\)\s*\.maybeSingle\(\)/);
});
