'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs
  .readFileSync(path.join(ROOT, file), 'utf8')
  .replace(/\r\n?/g, '\n');

const migration = read('supabase/migrations/20260822220703_provider_access_lifecycle_foundation.sql');
const catalog = read('supabase/functions/norva-catalog/index.ts');
const cloud = read('supabase/functions/norva-cloud/index.ts');
const playback = read('supabase/functions/norva-playback/index.ts');
const seriesInfo = read('supabase/functions/norva-series-info/index.ts');
const responseGuard = read('supabase/functions/_shared/catalog-visibility-response.mjs');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

function assertEpochBinding(source, nextFunction) {
  const binding = section(
    source,
    'async function bindCatalogVisibilityEpoch(',
    nextFunction,
  );
  assert.match(binding, /await bindCatalogVisibilityEpochShared\(req, userId, db\)/);
  assert.match(binding, /catch \(_\)[\s\S]*throw new HttpError\(503, "Catalog visibility is temporarily unavailable"\)/);
}

function assertResponseHeaderContract(source, hasCachedJson) {
  const json = section(source, 'function json(', hasCachedJson ? '\n// ' : '\nfunction boundedInt(');
  assert.match(json, /\.\.\.catalogVisibilityEpochHeaders\(req\)/);

  if (hasCachedJson) {
    const cached = section(source, 'function jsonCached(', '\nfunction corsHeaders(');
    assert.match(cached, /\.\.\.catalogVisibilityEpochHeaders\(req\)/);
  }

  assert.match(source, /catalogVisibilityEpochHeaders,[\s\S]*finalizeCatalogVisibilityResponse,/);
  assert.match(source, /finalizeCatalogVisibilityResponse\(\s*req,\s*await handleRequest\(req\)/);
  assert.match(source, /"Access-Control-Expose-Headers":[^\n]*x-norva-visibility-epoch/);
}

test('the database exposes one ownership-checked account visibility epoch RPC', () => {
  const rpc = section(
    migration,
    'create or replace function public.norva_user_catalog_visibility_epoch(',
    '\n-- Composite tenant foreign keys',
  );
  assert.match(rpc, /p_user_id uuid[\s\S]*returns bigint/);
  assert.match(rpc, /auth\.uid\(\) is distinct from p_user_id/);
  assert.match(rpc, /from public\.cloud_user_catalog_visibility_epochs/);
  assert.match(rpc, /grant execute on function public\.norva_user_catalog_visibility_epoch\(uuid\)[\s\S]*to authenticated, service_role/);
});

test('the shared response guard owns the request binding and final recheck', () => {
  assert.match(responseGuard, /const bindings = new WeakMap\(\)/);
  assert.match(responseGuard, /const PUBLIC_EDGE_ERROR_CODES = new Set\(\[/);
  assert.match(responseGuard, /PUBLIC_EDGE_ERROR_CODES\.has\(code\)/);
  assert.match(responseGuard, /db\.rpc\("norva_catalog_cache_epoch_v2",\s*\{/);
  assert.match(responseGuard, /cacheEpoch !== `v2\.\$\{globalEpoch\}\.\$\{userEpoch\}`/);
  assert.match(responseGuard, /boundCatalogCacheEpoch/);
  assert.match(responseGuard, /p_user_id: userId/);
  assert.match(responseGuard, /String\(record\?\.globalEpoch \?\? ""\)\.trim\(\)/);
  assert.match(responseGuard, /!\/\^\[1-9\]\\d\*\$\/\.test\(globalEpoch\)/);
  assert.match(responseGuard, /!\/\^\[1-9\]\\d\*\$\/\.test\(userEpoch\)/);
  assert.match(
    responseGuard,
    /const publicResponse = await sanitizeAuthenticatedErrorResponse\(response\);[\s\S]*currentEpoch = await readCatalogVisibilityEpoch/,
  );
  assert.match(responseGuard, /currentEpoch\.cacheEpoch !== binding\.cacheEpoch/);
  assert.match(responseGuard, /status,\s*payload,\s*epoch = null,\s*retryable = false/);
});

test('norva-catalog binds the epoch for JWT and device identities before returning JSON', () => {
  assertEpochBinding(catalog, '\nasync function requireDeviceUserId(');
  const auth = section(catalog, 'async function requireUserId(', '\nasync function bindCatalogVisibilityEpoch(');
  assert.ok(
    (auth.match(/bindCatalogVisibilityEpoch\(req,/g) || []).length >= 3,
    'every JWT/device resolution branch must bind the epoch',
  );
  assertResponseHeaderContract(catalog, true);
});

test('norva-cloud binds both user and paired-device identities to the response epoch', () => {
  assertEpochBinding(cloud, '\nasync function requireCloudAccess(');
  const userAuth = section(cloud, 'async function requireUser(', '\nasync function requireDevice(');
  const deviceAuth = section(cloud, 'async function requireDevice(', '\nasync function bindCatalogVisibilityEpoch(');
  assert.match(userAuth, /bindCatalogVisibilityEpoch\(req, local\.id, db\)/);
  assert.match(userAuth, /bindCatalogVisibilityEpoch\(req, data\.user\.id, db\)/);
  assert.match(deviceAuth, /bindCatalogVisibilityEpoch\(req, data\.user_id, db\)/);
  assertResponseHeaderContract(cloud, true);
});

test('norva-playback binds user and device identities and keeps service routes unlabelled', () => {
  assertEpochBinding(playback, '\nasync function requirePlaybackCapacity(');
  const auth = section(playback, 'async function requireIdentity(', '\nasync function bindCatalogVisibilityEpoch(');
  assert.match(auth, /bindCatalogVisibilityEpoch\(req, local\.id, db\)/);
  assert.match(auth, /bindCatalogVisibilityEpoch\(req, data\.user\.id, db\)/);
  assert.match(auth, /bindCatalogVisibilityEpoch\(req, device\.user_id, db\)/);

  const serviceRoutes = section(
    playback,
    'if (req.method === "POST" && segments[0] === "audio-backfill")',
    '\n    throw new HttpError(404, "Route not found")',
  );
  assert.doesNotMatch(serviceRoutes, /bindCatalogVisibilityEpoch/);
  assertResponseHeaderContract(playback, false);
});

test('norva-series-info emits the same canonical v2 cache epoch as the catalog', () => {
  assert.match(seriesInfo, /bindCatalogVisibilityEpoch as bindCatalogVisibilityEpochShared/);
  assert.match(seriesInfo, /await bindCatalogVisibilityEpoch\(req, identity\.userId, supabase\)/);
  assert.match(seriesInfo, /finalizeCatalogVisibilityResponse\(\s*req,\s*await handleRequest\(req\)/);
  assert.match(seriesInfo, /\.\.\.catalogVisibilityEpochHeaders\(req\)/);
  assert.doesNotMatch(seriesInfo, /const catalogVisibilityEpochs = new WeakMap/);
  assert.doesNotMatch(seriesInfo, /sourceSnapshot\.userVisibilityEpoch\);\s*\n\s*return json/);
  assert.match(
    seriesInfo,
    /"Access-Control-Expose-Headers": "x-norva-visibility-epoch, x-norva-user-visibility-epoch, x-norva-global-visibility-epoch, x-norva-catalog-cache-contract"/,
  );
});

test('unauthenticated health responses cannot acquire a visibility epoch header', () => {
  for (const [source, start, end] of [
    [catalog, 'if (req.method === "GET" && segments[0] === "health")', '\n    // Background catalog-enrichment progress'],
    [cloud, 'if (req.method === "GET" && scope === "health")', '\n  // Service-authed continuation'],
    [playback, 'if (req.method === "GET" && segments[0] === "health")', '\n    if (req.method === "GET" && segments[0] === "telemetry"'],
  ]) {
    const health = section(source, start, end);
    assert.doesNotMatch(health, /bindCatalogVisibilityEpoch/);
  }
});
