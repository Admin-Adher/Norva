'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-cloud/index.ts'), 'utf8');
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const code = transformSync([
  part('class HttpError extends Error', '\nconst encoder'),
  part('function throwDb(', '\n}').concat('\n}'),
  part('function publicErrorPayload(', '\nfunction publicErrorLog'),
].join('\n'), { loader: 'ts', target: 'es2022' }).code;

async function apiFailure(error) {
  const { sanitizeCloudErrorDetails } = await import('../supabase/functions/_shared/cloud-public-view.mjs');
  const { bindCatalogVisibilityEpoch, finalizeCatalogVisibilityResponse } = await import('../supabase/functions/_shared/catalog-visibility-response.mjs');
  const context = {
    sanitizeCloudErrorDetails,
    recordOrEmpty: value => value && typeof value === 'object' ? value : {},
    compactRecord: value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)),
  };
  const map = vm.runInNewContext(`${code}\n(error) => { try { throwDb(error, 'Unable to create source'); } catch (e) { return { status: e.status, payload: publicErrorPayload(e, e.status) }; } }`, context);
  const result = map(error);
  const req = new Request('https://edge.test/sources', { method: 'POST' });
  const db = { rpc: async () => ({ data: { contract: 'catalog-cache-epoch-v2', globalEpoch: '1', userEpoch: '12', cacheEpoch: 'v2.1.12' }, error: null }) };
  await bindCatalogVisibilityEpoch(req, 'test-owner', db);
  return finalizeCatalogVisibilityResponse(req,
    new Response(JSON.stringify(result.payload), { status: result.status }), db);
}

test('both exact database topology guards survive the public response finalizer as safe conflicts', async () => {
  for (const [code, message] of [
    ['PT409', 'user catalog topology is fenced during credential cutover'],
    ['55P03', 'provider account already has a non-terminal transition'],
  ]) {
    const response = await apiFailure({ code, message, details: 'private owner and provider credentials' });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.deepEqual(body.details, { code: 'SOURCE_CATALOG_BUSY' });
    assert.match(body.error, /Catalog update in progress/);
    assert.doesNotMatch(JSON.stringify(body), /private|PT409|55P03|credential|non-terminal/);
  }
});

test('unrelated database conflicts and unexpected errors keep the private generic failure', async () => {
  for (const error of [
    { code: 'PT409', message: 'revision changed', details: 'secret' },
    { code: '55P03', message: 'canceling statement due to lock timeout' },
    { code: '23505', message: 'provider account already has a non-terminal transition' },
    { code: 'PT409', message: 'user catalog topology is fenced during credential cutover plus private data' },
  ]) {
    const response = await apiFailure(error);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Service temporarily unavailable' });
  }
});
