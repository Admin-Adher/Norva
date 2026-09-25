const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
let bindCommittedSourceCreationReceipt, finalizeSourceCreationReceiptResponse;
let bindCatalogVisibilityEpoch, acknowledgeCatalogVisibilityEpochMutation, finalizeCatalogVisibilityResponse;
test.before(async () => {
  ({ bindCommittedSourceCreationReceipt, finalizeSourceCreationReceiptResponse } = await import('../supabase/functions/_shared/source-creation-receipt.mjs'));
  ({ bindCatalogVisibilityEpoch, acknowledgeCatalogVisibilityEpochMutation, finalizeCatalogVisibilityResponse } = await import('../supabase/functions/_shared/catalog-visibility-response.mjs'));
});

const { transformSync } = require('esbuild');
const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const source = { id: sourceId, display_name: 'Same provider', enabled: true, catalog_visible: true, deleted_at: null, sync_status: 'syncing', config_revision: 3 };
const code = 'CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN';
const receipt = { contract: 'source-creation-receipt-v1', sourceId };
function response(status, body, epoch = 'v2.1.12') {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-norva-visibility-epoch': epoch, 'cache-control': 'no-store' } });
}
function ambiguous(sourceCreationReceipt = receipt) {
  return response(409, { error: 'Mutation outcome must be reconciled before another attempt', details: { code, sourceCreationReceipt } });
}
function browser(fetchImpl) {
  const values = new Map([['norva-cloud-token', 'test-user-token']]);
  const location = { origin: 'https://norva.test', hostname: 'norva.test', search: '', pathname: '/app' };
  const window = { location, dispatchEvent() {}, addEventListener() {} };
  const context = { window, location, URL, URLSearchParams, Headers, Response, navigator: { language: 'fr', languages: ['fr'], userAgent: 'test' },
    AbortController, console, setTimeout, clearTimeout,
    document: { readyState: 'loading', dispatchEvent() {}, addEventListener() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }, fetch: fetchImpl,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/cloudApi.js'), 'utf8'), context);
  return window.NorvaCloud;
}
function epochDb(epochs) {
  return { async rpc(name) {
    assert.equal(name, 'norva_catalog_cache_epoch_v2');
    const [globalEpoch, userEpoch] = epochs.shift();
    return { data: { contract: 'catalog-cache-epoch-v2', globalEpoch: String(globalEpoch), userEpoch: String(userEpoch), cacheEpoch: `v2.${globalEpoch}.${userEpoch}` }, error: null };
  } };
}

test('real visibility finalizer still rejects concurrent user/global cutovers; receipt contains identity only', async () => {
  for (const epochs of [[[1, 10], [1, 12], [1, 12]], [[1, 10], [2, 11], [2, 11]]]) {
    const req = new Request('https://edge.test/sources', { method: 'POST' });
    const db = epochDb(epochs);
    await bindCatalogVisibilityEpoch(req, 'test-owner', db);
    bindCommittedSourceCreationReceipt(req, sourceId);
    await acknowledgeCatalogVisibilityEpochMutation(req, db);
    const result = await finalizeSourceCreationReceiptResponse(req, () => finalizeCatalogVisibilityResponse(req, response(201, { source }), db));
    assert.equal(result.status, 409);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const body = await result.json();
    assert.deepEqual(body.details.sourceCreationReceipt, receipt);
    assert.equal(body.details.code, code);
    assert.equal(body.source, undefined);
    const reused = await finalizeSourceCreationReceiptResponse(req, () => response(409, { details: { code } }));
    assert.equal((await reused.json()).details.sourceCreationReceipt, undefined);
  }
});

test('normal acknowledged insert retains its 201 response and strict original finalizer', async () => {
  const req = new Request('https://edge.test/sources', { method: 'POST' });
  const db = epochDb([[1, 10], [1, 11], [1, 11]]);
  await bindCatalogVisibilityEpoch(req, 'test-owner', db);
  bindCommittedSourceCreationReceipt(req, sourceId);
  await acknowledgeCatalogVisibilityEpochMutation(req, db);
  const result = await finalizeSourceCreationReceiptResponse(req, () => finalizeCatalogVisibilityResponse(req, response(201, { source }), db));
  assert.equal(result.status, 201);
  assert.deepEqual(await result.json(), { source });
});

test('receipts are request-local, absent without commit, and cleared on thrown finalizer', async () => {
  const first = new Request('https://edge.test/sources', { method: 'POST' });
  const second = new Request('https://edge.test/sources', { method: 'POST' });
  bindCommittedSourceCreationReceipt(first, sourceId);
  const other = await finalizeSourceCreationReceiptResponse(second, () => response(409, { details: { code } }));
  assert.equal((await other.json()).details.sourceCreationReceipt, undefined);
  await assert.rejects(finalizeSourceCreationReceiptResponse(first, async () => { throw new Error('database unavailable'); }));
  const again = await finalizeSourceCreationReceiptResponse(first, () => response(409, { details: { code } }));
  assert.equal((await again.json()).details.sourceCreationReceipt, undefined);
});

test('a committed receipt never changes authentication, config/source revocation or unavailable responses', async () => {
  for (const [status, errorCode] of [[403, 'SOURCE_CATALOG_NOT_VISIBLE'], [409, 'SOURCE_CONFIG_REVISION_CHANGED'], [503, 'CATALOG_VISIBILITY_EPOCH_UNAVAILABLE']]) {
    const req = new Request('https://edge.test/sources', { method: 'POST' });
    bindCommittedSourceCreationReceipt(req, sourceId);
    const original = response(status, { error: 'Original rejection', details: { code: errorCode } });
    const result = await finalizeSourceCreationReceiptResponse(req, () => original);
    assert.equal(result, original);
    assert.equal((await result.json()).details.sourceCreationReceipt, undefined);
  }
});

test('client reconciles once by exact UUID using a fresh authenticated read, bypassing warmed source cache', async () => {
  const calls = [];
  let getCount = 0;
  const cloud = browser(async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return ambiguous();
    getCount++;
    return response(200, { sources: getCount === 1 ? [] : [{ ...source, id: otherId }, source] });
  });
  await cloud.sources.list();
  const result = await cloud.sources.create({ displayName: 'Same provider' });
  assert.equal(result.source.id, sourceId);
  assert.equal(result.source.config_revision, 3);
  assert.equal(result.syncStarted, true);
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  assert.equal(getCount, 2);
  assert.equal(calls.at(-1).options.cache, 'no-store');
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer test-user-token');
});

test('delayed 201 and 409 receipts re-read current state without returning the stale source or replaying POST', async () => {
  for (const status of [201, 409]) {
    const calls = [];
    const cloud = browser(async (url, options) => {
      calls.push(options);
      if (options.method === 'POST') return status === 201
        ? response(201, { source: { ...source, display_name: 'Old value' } }, 'v2.1.10')
        : response(409, { details: { code, sourceCreationReceipt: receipt } }, 'v2.1.10');
      return response(200, { sources: [{ ...source, display_name: 'Current value' }] }, 'v2.1.12');
    });
    cloud.catalogVisibility.invalidate('v2.1.11');
    const result = await cloud.sources.create({});
    assert.equal(result.source.display_name, 'Current value');
    assert.equal(cloud.catalogVisibility.epoch(), 'v2.1.12');
    assert.equal(calls.length, 2);
    assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  }
});

test('deleted, hidden, disabled, ambiguous duplicate and merely similar sources do not reconcile', async () => {
  for (const sources of [[], [{ ...source, id: otherId }], [{ ...source, catalog_visible: false }], [{ ...source, enabled: false }], [{ ...source, deleted_at: '2026-09-22T09:00:00Z' }], [source, source]]) {
    let posts = 0;
    const cloud = browser(async (url, options) => {
      if (options.method === 'POST') { posts++; return ambiguous(); }
      return response(200, { sources });
    });
    await assert.rejects(cloud.sources.create({}), err => err.status === 409);
    assert.equal(posts, 1);
  }
});

test('receipt re-read continues to fail closed on stale epochs or a revoked authenticated read', async () => {
  for (const failure of ['stale', 'revoked']) {
    const calls = [];
    const cloud = browser(async (url, options) => {
      calls.push(options);
      if (options.method === 'POST') return ambiguous();
      return failure === 'stale' ? response(200, { sources: [source] }, 'v2.1.10') : response(403, { error: 'Source access revoked' });
    });
    await assert.rejects(cloud.sources.create({}), err => failure === 'stale' ? err.code === 'STALE_CATALOG_VISIBILITY_EPOCH' : err.status === 403);
    assert.equal(calls.filter(c => c.method === 'POST').length, 1);
    assert.equal(calls.filter(c => c.method === 'GET').length, failure === 'stale' ? 2 : 1);
  }
});

test('absent/malformed receipts and other errors cannot trigger reconciliation or a retry', async () => {
  for (const fail of [
    response(409, { error: 'Catalog update in progress', details: { code: 'SOURCE_CATALOG_BUSY' } }),
    response(409, { details: { code } }),
    ambiguous({ contract: 'other', sourceId }),
    ambiguous({ contract: receipt.contract, sourceId: 'Same provider' }),
    response(403, { details: { code, sourceCreationReceipt: receipt } }),
    response(409, { details: { code: 'SOURCE_CONFIG_REVISION_CHANGED', sourceCreationReceipt: receipt } }),
  ]) {
    let calls = 0;
    const cloud = browser(async () => { calls++; return fail; });
    await assert.rejects(cloud.sources.create({}));
    assert.equal(calls, 1);
  }
});

test('real createSource binds only a successful insert and preserves Selection idempotence', async () => {
  const server = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-cloud/index.ts'), 'utf8');
  const body = server.slice(server.indexOf('async function createSource('), server.indexOf('\nconst SOURCE_ATTEMPT_CLIENT_WINDOW_MS'));
  const compiled = transformSync(body, { loader: 'ts', target: 'es2022' }).code;
  for (const mode of ['success', 'failed', 'existing-selection']) {
    const calls = [];
    const selection = mode === 'existing-selection';
    const context = {
      readJson: async () => ({ sourceType: selection ? 'm3u' : 'xtream', displayName: 'Fixture', syncNow: true }),
      stringOr: (value, fallback) => typeof value === 'string' ? value : fallback,
      stringOrNull: value => value || null, recordOrEmpty: value => value || {}, compactRecord: value => value,
      buildSourceConfig: () => selection ? { playlistUrl: 'https://fixture.test/selection' } : { serverUrl: 'https://fixture.test' },
      summarizeSourceConnectionAttempt: async () => ({}), sourceAttemptClientContext: () => ({}), getRuntimeConfig: async () => ({}),
      validateCloudSource: async () => ({}), encryptSourceConfig: async () => 'encrypted-test-config', buildSourceHint: () => ({}),
      DISCOVERY_PLAYLIST_URL: 'https://fixture.test/selection', discoverySourceId: async () => sourceId,
      bindCommittedSourceCreationReceipt: (...args) => { calls.push('bind'); bindCommittedSourceCreationReceipt(...args); },
      waitUntil: () => calls.push('background'), syncCloudSource: async () => {},
      managedSourceSnapshot: async () => { calls.push('snapshot'); return source; },
      sanitizeSourceValidation: value => value, scheduleSourceConnectionAttempt() {},
      throwDb: () => { throw new Error('insert failed'); }, HttpError: Error,
    };
    const req = new Request('https://edge.test/sources', { method: 'POST' });
    const db = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: mode === 'success' ? { id: sourceId } : null, error: mode === 'success' ? null : { code: selection ? '23505' : 'other' } }) }) }) }) };
    const create = vm.runInNewContext(`${compiled}\ncreateSource`, context);
    if (mode === 'failed') await assert.rejects(create(req, 'test-owner', db));
    else await create(req, 'test-owner', db);
    assert.equal(calls.includes('bind'), mode === 'success');
    if (mode === 'success') assert.ok(calls.indexOf('bind') < calls.indexOf('background'));
    const result = await finalizeSourceCreationReceiptResponse(req, () => response(409, { details: { code } }));
    assert.equal(Boolean((await result.json()).details.sourceCreationReceipt), mode === 'success');
  }
});
