'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

function assertSnapshotContract(source) {
  const shared = source.includes('catalog-generation.ts')
    ? read('supabase/functions/_shared/catalog-generation.ts')
    : '';
  const contract = `${source}\n${shared}`;
  assert.match(contract, /\.from\("cloud_catalog_visible_sources"\)|norva_get_catalog_write_snapshot/);
  assert.match(contract, /\.select\("config_revision,visibility_epoch,user_visibility_epoch"\)|sourceVisibilityEpoch/);
  assert.match(contract, /current\.configRevision !== expected\.configRevision/);
  assert.match(contract, /current\.sourceVisibilityEpoch !== expected\.sourceVisibilityEpoch/);
  assert.match(contract, /current\.userVisibilityEpoch !== expected\.userVisibilityEpoch/);
}

function loadPublicErrorCode(source, allowlistName) {
  const block = section(source, `const ${allowlistName}`, '\n\nasync function ');
  const compiled = esbuild.transformSync(
    `${block}\nglobalThis.publicErrorCode = publicErrorCode;`,
    { loader: 'ts', format: 'iife', target: 'es2022' },
  ).code;
  class HttpError extends Error {
    constructor(status, message, details) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }
  const context = {
    HttpError,
    isRecord: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
  };
  vm.runInNewContext(compiled, context);
  return { publicErrorCode: context.publicErrorCode, HttpError };
}

test('series-info fences fresh cache, stale fallback, provider response, cache write, and final epoch header', () => {
  const source = read('supabase/functions/norva-series-info/index.ts');
  assertSnapshotContract(source);

  const lookup = section(source, 'async function getXtreamSeriesInfo(', '\nfunction providerAccountKey(');
  assert.match(
    lookup,
    /if \(cached &&[\s\S]*await assertSourceSnapshotCurrent\(sourceId, userId, expectedSnapshot, db\);[\s\S]*return \{ payload: cached\.payload/,
  );
  assert.match(lookup, /if \(isCatalogAccessGuardError\(error\)\) throw error;/);
  assert.match(
    lookup,
    /payload = await fetchSeriesInfoFromProvider[\s\S]*await assertSourceSnapshotCurrent\(sourceId, userId, expectedSnapshot, db\);[\s\S]*writeSeriesInfoCache/,
  );
  assert.match(lookup, /discardSeriesInfoCacheWrite\(db, serverHost, seriesId, writeMarker\)/);

  const provider = section(source, 'async function fetchSeriesInfoFromProvider(', '\nasync function requestSeriesInfoOnce(');
  const dispatch = provider.indexOf('requestSeriesInfoOnce(db');
  assert.ok(provider.lastIndexOf('assertSourceSnapshotCurrent(', dispatch) < dispatch);
  assert.ok(provider.indexOf('assertSourceSnapshotCurrent(', dispatch) > dispatch);

  const route = section(source, 'segments[2] === "series-info"', 'throw new HttpError(404');
  const finalGuard = route.lastIndexOf('await assertSourceSnapshotCurrent(');
  const bind = route.lastIndexOf('catalogVisibilityEpochs.set(req, sourceSnapshot.userVisibilityEpoch)');
  const response = route.lastIndexOf('return json(req');
  assert.ok(finalGuard >= 0 && bind > finalGuard && response > bind);
  assert.match(source, /"X-Norva-Visibility-Epoch": epoch/);
  assert.match(source, /"Access-Control-Expose-Headers": "x-norva-visibility-epoch"/);
});

test('series prewarm and account probe stop on a changed snapshot before cache or response', () => {
  const source = read('supabase/functions/norva-series-prewarm/index.ts');
  assertSnapshotContract(source);

  const prewarm = section(source, 'async function prewarm(', '\nasync function accountInfo(');
  const fetchAt = prewarm.indexOf('gatewaySeriesInfo(');
  const upsertAt = prewarm.indexOf('.from("cloud_series_info_cache").upsert');
  assert.ok(fetchAt > 0 && upsertAt > fetchAt);
  assert.ok(prewarm.lastIndexOf('assertSourceSnapshotCurrent(', fetchAt) < fetchAt);
  assert.ok(prewarm.lastIndexOf('assertSourceSnapshotCurrent(', upsertAt) > fetchAt);
  assert.match(prewarm, /discardSeriesInfoCacheWrite\(serverHost, seriesId, nowIso\)/);
  assert.match(prewarm, /if \(err instanceof CatalogAccessError\) throw err;/);
  assert.match(prewarm, /catalogVisibilityEpochs\.set\(req, sourceSnapshot\.userVisibilityEpoch\)/);

  const account = section(source, 'async function accountInfo(', '\nasync function uncachedSeriesIds(');
  assert.match(account, /assertSourceSnapshotCurrent[\s\S]*fetchBoundedProviderJson\(url[\s\S]*assertSourceSnapshotCurrent/);
  assert.match(account, /catalogVisibilityEpochs\.set\(req, sourceSnapshot\.userVisibilityEpoch\)/);
});

test('series prewarm never returns raw provider, database, or transport errors', () => {
  const source = read('supabase/functions/norva-series-prewarm/index.ts');
  const handler = section(source, 'Deno.serve(async (req) => {', '\nasync function prewarm(');
  const prewarm = section(source, 'async function prewarm(', '\nasync function accountInfo(');
  const account = section(source, 'async function accountInfo(', '\nasync function uncachedSeriesIds(');
  const gateway = section(source, 'async function gatewaySeriesInfo(', '\nasync function discardSeriesInfoCacheWrite(');

  assert.match(handler, /\{ error: "PREWARM_FAILED" \}/);
  assert.match(prewarm, /lastError = "CACHE_WRITE_FAILED"/);
  assert.match(prewarm, /lastError = "PROVIDER_THROTTLED"/);
  assert.match(account, /note: ui \? undefined : "PROVIDER_ACCOUNT_STATUS_UNAVAILABLE"/);
  assert.match(account, /error: "PROVIDER_ACCOUNT_PROBE_FAILED"/);
  assert.doesNotMatch(account, /note:[^\n]*\? data/);
  assert.match(gateway, /fetchBoundedProviderJson/);
  assert.match(gateway, /timeoutMs: 20_000/);
  assert.match(gateway, /maxBytes: 8 \* 1024 \* 1024/);
  assert.doesNotMatch(gateway, /\.json\s*\(/);
  assert.doesNotMatch(gateway, /JSON\.stringify\(payload\)/);
});

test('series inventory and provider overview revalidate after provider work before writes', () => {
  const source = read('supabase/functions/norva-source-sync/index.ts');
  assertSnapshotContract(source);

  const inventory = section(source, 'async function runSeriesInventoryFleetLane(', '\nasync function runEnrichmentFleetClaim(');
  const fetchAt = inventory.indexOf('fetchSeriesInventoryMetadata(');
  const registryAt = inventory.indexOf('"register_catalog_series_episodes"');
  const cacheAt = inventory.indexOf('.from("cloud_series_info_cache").upsert');
  assert.ok(fetchAt > 0 && registryAt > fetchAt && cacheAt > registryAt);
  assert.ok(inventory.lastIndexOf('assertCatalogSnapshotCurrent(', registryAt) > fetchAt);
  assert.ok(inventory.lastIndexOf('assertCatalogSnapshotCurrent(', cacheAt) > registryAt);
  assert.match(inventory, /discardEnrichmentSeriesInfoCacheWrite\(db, serverHost, parentSeriesId, nowIso\)/);
  assert.match(inventory, /if \(isCatalogAccessGuardError\(error\)\)[\s\S]*skipped = "source-catalog-changed"/);

  const overview = section(source, 'async function runProviderOverviewFleetLane(', '\nasync function recordSeriesInventoryOutcome(');
  assert.match(overview, /assertSourceCurrent: \(\) => assertCatalogSnapshotCurrent/);
  assert.match(overview, /fetchVodInfo: async[\s\S]*assertCatalogSnapshotCurrent[\s\S]*fetchProviderMetadata[\s\S]*assertCatalogSnapshotCurrent/);

  const overviewWorker = read('supabase/functions/_shared/provider-overview-backfill.ts');
  assert.match(overviewWorker, /await options\.assertSourceCurrent\?\.\(\);[\s\S]*await options\.fetchVodInfo\(externalId\)[\s\S]*await options\.assertSourceCurrent\?\.\(\);/);
});

test('resumable Xtream and M3U continuations cannot keep dispatching or writing with A snapshot', () => {
  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  const xtream = read('supabase/functions/_shared/xtream-sync.ts');
  assertSnapshotContract(xtream);

  const detect = section(xtream, 'export async function detectXtreamChange(', '\n// Drive one isolate');
  assert.match(detect, /const accessSnapshot = await readCatalogAccessSnapshot/);
  assert.match(detect, /const fetchCatalog = async[\s\S]*assertCatalogSnapshotCurrent[\s\S]*fetchProviderMetadata[\s\S]*assertCatalogSnapshotCurrent/);
  assert.match(detect, /assertCatalogSnapshotCurrent[\s\S]*recordProviderIdentity[\s\S]*assertCatalogSnapshotCurrent/);

  const drive = section(xtream, 'export async function driveXtreamSyncToReady(', '\n// Plain-language');
  assert.match(drive, /const persist = async[\s\S]*assertCatalogSnapshotCurrent[\s\S]*\.update\([\s\S]*assertCatalogSnapshotCurrent/);
  assert.match(drive, /assertCatalogSnapshotCurrent[\s\S]*appendSourceItems[\s\S]*assertCatalogSnapshotCurrent/);
  assert.match(drive, /if \(isCatalogAccessGuardError\(err\)\) return;[\s\S]*sync driver failed/);

  const m3u = section(sourceSync, 'async function syncM3uSource(', '\nasync function replaceSourceItems(');
  assert.match(m3u, /assertCatalogSnapshotCurrent[\s\S]*fetchText\([\s\S]*assertCatalogSnapshotCurrent/);
  assert.match(m3u, /assertCatalogSnapshotCurrent[\s\S]*replaceSourceItems[\s\S]*assertCatalogSnapshotCurrent[\s\S]*refreshMaterializedLiveCatalog[\s\S]*assertCatalogSnapshotCurrent/);
  assert.doesNotMatch(`${sourceSync}\n${xtream}`, /allowHidden|allowStaging|bypassVisibility/);
});

test('title projection continuation callback fences provider and shared/user writes', () => {
  const projection = read('supabase/functions/_shared/vod-title-projection.ts');
  assert.match(projection, /assertSourceCurrent\?: \(\) => Promise<void>/);
  assert.match(projection, /loadVodInfoIds\([\s\S]*options\.assertSourceCurrent/);
  assert.match(projection, /await assertSourceCurrent\?\.\(\);[\s\S]*fetchVodInfo\([\s\S]*await assertSourceCurrent\?\.\(\);/);

  for (const table of ['cloud_titles', 'cloud_title_variants', 'catalog_titles']) {
    const writeAt = projection.indexOf(`.from("${table}")`);
    assert.notEqual(writeAt, -1, `missing ${table} write`);
    assert.ok(projection.lastIndexOf('assertSourceCurrent?.()', writeAt) < writeAt);
  }
});

test('long source-sync responses bind the same guarded epoch emitted in the header', () => {
  const source = read('supabase/functions/norva-source-sync/index.ts');
  const userRoutes = section(source, 'segments[0] === "sources" && segments[2] === "sync"', '\n    // Admin/service re-sync');
  assert.match(userRoutes, /const responseSnapshot = await readCatalogAccessSnapshot/);
  assert.match(userRoutes, /await assertCatalogSnapshotCurrent[\s\S]*catalogVisibilityEpochs\.set\(req, responseSnapshot\.userVisibilityEpoch\)[\s\S]*return json\(req, result\)/);
  assert.match(source, /"X-Norva-Visibility-Epoch": epoch/);
  assert.match(source, /"Access-Control-Expose-Headers": "x-norva-visibility-epoch"/);
});

test('series and source-sync response boundaries strip arbitrary provider and database details', () => {
  for (const [file, allowlistName] of [
    ['supabase/functions/norva-series-info/index.ts', 'SERIES_INFO_PUBLIC_ERROR_CODES'],
    ['supabase/functions/norva-source-sync/index.ts', 'SOURCE_SYNC_PUBLIC_ERROR_CODES'],
  ]) {
    const source = read(file);
    const handler = section(source, 'Deno.serve(async (req) => {', '\nfunction publicErrorCode(');
    const sanitizer = section(source, 'function publicErrorCode(', '\nasync function ');
    assert.match(handler, /const code = publicErrorCode\(error\)/, file);
    assert.match(handler, /status >= 500/, file);
    assert.doesNotMatch(handler, /\{ error: message, details \}/, file);
    assert.doesNotMatch(handler, /console\.error\([^\n]*details/, file);
    assert.match(sanitizer, new RegExp(`${allowlistName}\\.has\\(code\\)`), file);
    assert.doesNotMatch(sanitizer, /\^\[A-Z\]\[A-Z0-9_\]\{2,63\}\$/, file);

    const { publicErrorCode, HttpError } = loadPublicErrorCode(source, allowlistName);
    assert.equal(
      publicErrorCode(new HttpError(409, 'changed', { code: 'SOURCE_CATALOG_CHANGED' })),
      'SOURCE_CATALOG_CHANGED',
      file,
    );
    const attackerPayload = {
      code: 'RAW_PROVIDER_SECRET',
      username: 'provider-user',
      password: 'provider-password',
      url: 'https://provider.invalid/player_api.php?username=provider-user&password=provider-password',
      response: { arbitrary: 'provider-body' },
    };
    const code = publicErrorCode(new HttpError(502, 'upstream failed', attackerPayload));
    assert.equal(code, null, file);
    assert.deepEqual({ error: 'temporarily unavailable', ...(code ? { code } : {}) }, {
      error: 'temporarily unavailable',
    }, file);
  }
});
