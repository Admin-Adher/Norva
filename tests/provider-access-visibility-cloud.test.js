const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { transformSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const CLOUD = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/norva-cloud/index.ts'),
  'utf8',
).replace(/\r\n/g, '\n');
const SOURCE_PUBLIC_PATH = path.join(ROOT, 'supabase/functions/_shared/source-public-view.mjs');
const SOURCE_PUBLIC = fs.readFileSync(SOURCE_PUBLIC_PATH, 'utf8').replace(/\r\n/g, '\n');
const CLOUD_PUBLIC_PATH = path.join(ROOT, 'supabase/functions/_shared/cloud-public-view.mjs');
const CLOUD_PUBLIC = fs.readFileSync(CLOUD_PUBLIC_PATH, 'utf8').replace(/\r\n/g, '\n');
const LIFECYCLE_MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260822220703_provider_access_lifecycle_foundation.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

function sectionOf(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

function section(start, end) {
  return sectionOf(CLOUD, start, end);
}

function compileCloudFunction(start, end, globals) {
  const compiled = transformSync(`module.exports = ${section(start, end)}`, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2022',
  }).code;
  const sandbox = { module: { exports: {} }, exports: {}, URL, ...globals };
  vm.runInNewContext(compiled, sandbox, { filename: 'supabase/functions/norva-cloud/index.ts' });
  return sandbox.module.exports;
}

test('catalog reads use the server-visible media projection', () => {
  const list = section('async function listMediaItems(', 'async function getXtreamSeriesInfo(');
  assert.match(list, /\.from\("cloud_catalog_visible_media_items"\)/);
  assert.doesNotMatch(list, /\.from\("cloud_media_items"\)/);

  const playback = section('async function resolvePlaybackTarget(', 'async function loadSourceConfig(');
  assert.match(playback, /await assertVisibleSource\(sourceId, userId, db\)/);
  assert.match(playback, /\.from\("cloud_catalog_visible_media_items"\)/);
  assert.doesNotMatch(playback, /\.from\("cloud_media_items"\)/);
});

test('EPG and series metadata check visibility before provider or cache access', () => {
  const series = section('async function getXtreamSeriesInfo(', 'async function getXtreamShortEpg(');
  const shortEpg = section('async function getXtreamShortEpg(', 'function epgPayloadHasListings(');
  const epg = section('async function getSourceEpg(', 'function parseXmltvWindow(');

  assert.match(series, /const visibleSource = await visibleSourceSnapshot\(sourceId, userId, db\)/);
  assert.match(shortEpg, /const visibleSource = await visibleSourceSnapshot\(sourceId, userId, db\)/);
  const guard = epg.indexOf('await visibleSourceSnapshot(sourceId, userId, db)');
  const cache = epg.indexOf('epgCache.get(cacheKey)');
  assert.ok(guard >= 0 && cache > guard, 'EPG visibility must be checked before a cached payload is returned');
  assert.match(epg, /sourceSnapshotConfigRevision\(visibleSource\)/);
  assert.match(epg, /cacheKey = `\$\{userId\}:\$\{sourceId\}:config:\$\{configRevision\}:/);

  assert.match(series, /requestGatewaySeriesInfo[\s\S]*await assertVisibleSourceSnapshotCurrent[\s\S]*return info/);
  assert.match(series, /async \(\) => \{[\s\S]*fetchJson\([\s\S]*await assertVisibleSourceSnapshotCurrent[\s\S]*return payload/);
  assert.match(series, /withExistingXtreamDirectFallback[\s\S]*await assertVisibleSourceSnapshotCurrent[\s\S]*return info/);
  assert.match(shortEpg, /const directEpg[\s\S]*fetchJson\([\s\S]*await assertVisibleSourceSnapshotCurrent/);
  assert.match(shortEpg, /epgPayloadHasCurrentOrFuture[\s\S]*await assertVisibleSourceSnapshotCurrent[\s\S]*return shortEpg/);
  assert.match(shortEpg, /const result =[\s\S]*await assertVisibleSourceSnapshotCurrent[\s\S]*return result/);
  assert.match(epg, /epgCache\.get\(cacheKey\)[\s\S]*await assertVisibleSourceSnapshotCurrent[\s\S]*return cached\.data/);
  assert.match(epg, /cloud-xmltv-epg[\s\S]*fetchEpgXml\(\)[\s\S]*await assertVisibleSourceSnapshotCurrent/);
  assert.match(epg, /parseXmltvWindow[\s\S]*await assertVisibleSourceSnapshotCurrent[\s\S]*epgCache\.set\(cacheKey/);
});

test('delayed gateway and direct series reads reject A after an interleaved transition', async () => {
  class HttpError extends Error {
    constructor(status, message, details) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }

  for (const transport of ['gateway', 'direct']) {
    let currentRevision = '7';
    let releaseProvider;
    let providerStartedResolve;
    const providerStarted = new Promise((resolve) => { providerStartedResolve = resolve; });
    const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
    let directFetches = 0;
    let gatewayFetches = 0;
    let leaseHeld = false;
    let guardedWhileLease = false;
    let releases = 0;

    const assertCurrent = async (_sourceId, _userId, expected) => {
      if (leaseHeld) guardedWhileLease = true;
      if (String(expected.config_revision) !== currentRevision) {
        throw new HttpError(409, 'catalog changed', { code: 'SOURCE_CATALOG_CHANGED' });
      }
    };
    const delayedPayload = async (kind) => {
      if (kind === 'gateway') gatewayFetches += 1;
      else directFetches += 1;
      providerStartedResolve();
      await providerGate;
      return { info: { name: 'A' }, episodes: [] };
    };

    const getXtreamSeriesInfo = compileCloudFunction(
      'async function getXtreamSeriesInfo(',
      'async function getXtreamShortEpg(',
      {
        HttpError,
        console: { warn() {} },
        visibleSourceSnapshot: async () => ({ config_revision: '7' }),
        sourceSnapshotConfigRevision: (snapshot) => String(snapshot.config_revision),
        loadSourceConfigEnvelope: async () => ({
          config: { serverUrl: 'https://provider.example', username: 'user-a', password: 'password-a' },
          configCiphertext: 'ciphertext-a',
        }),
        normalizeBaseUrl: (value) => value,
        stringOr: (value, fallback) => typeof value === 'string' && value ? value : fallback,
        getRuntimeConfig: async () => transport === 'gateway'
          ? { mediaGatewayUrl: 'https://gateway.invalid', mediaGatewayToken: 'token' }
          : { mediaGatewayUrl: '', mediaGatewayToken: '' },
        requestGatewaySeriesInfo: async () => delayedPayload('gateway'),
        sanitizeXtreamSeriesInfo: (value) => value,
        assertVisibleSourceSnapshotCurrent: assertCurrent,
        buildProviderDirectFallbackSnapshot: async () => ({
          expectedProviderAccountAffinityHash: 'a'.repeat(64),
          expectedConfigRevision: '7',
          expectedConfigCiphertextHash: 'b'.repeat(64),
        }),
        withExistingXtreamDirectFallback: async (_context, _owner, _timeout, operation) => {
          leaseHeld = true;
          try {
            return await operation();
          } finally {
            leaseHeld = false;
            releases += 1;
          }
        },
        fetchJson: async () => delayedPayload('direct'),
        xtreamApiUrl: () => 'https://provider.example/player_api.php',
      },
    );

    const pending = getXtreamSeriesInfo(
      new URL('https://norva.invalid/series?series_id=42'),
      'source-a',
      'user-a',
      {},
    );
    await providerStarted;
    currentRevision = '8';
    releaseProvider();
    await assert.rejects(
      pending,
      (error) => error instanceof HttpError && error.status === 409 &&
        error.details?.code === 'SOURCE_CATALOG_CHANGED',
      transport,
    );
    assert.equal(gatewayFetches, transport === 'gateway' ? 1 : 0, transport);
    assert.equal(directFetches, transport === 'direct' ? 1 : 0, transport);
    assert.equal(releases, transport === 'direct' ? 1 : 0, transport);
    if (transport === 'direct') assert.equal(guardedWhileLease, true, transport);
  }
});

test('cloud exposes a changed catalog snapshot only as a stable retryable code', async () => {
  const cloudPublic = await import(pathToFileURL(CLOUD_PUBLIC_PATH).href);
  assert.deepEqual(cloudPublic.sanitizeCloudErrorDetails({
    code: 'SOURCE_CATALOG_CHANGED',
    reason: 'source_config_snapshot_changed',
    username: 'provider-user',
    password: 'provider-password',
  }), {
    code: 'SOURCE_CATALOG_CHANGED',
    retryable: true,
  });
});

test('favorites and history use database visibility projections without source-id TOCTOU reads', () => {
  const favoriteSelect = sectionOf(CLOUD_PUBLIC, 'const FAVORITE_FIELDS =', 'export const FAVORITE_PUBLIC_SELECT');
  const historySelect = sectionOf(CLOUD_PUBLIC, 'const WATCH_HISTORY_FIELDS =', 'export const WATCH_HISTORY_PUBLIC_SELECT');
  assert.doesNotMatch(favoriteSelect, /user_id/);
  assert.doesNotMatch(historySelect, /user_id/);

  const favorites = section('async function listFavorites(', 'async function addFavorite(');
  assert.match(favorites, /\.from\("cloud_catalog_visible_favorites"\)/);
  assert.match(favorites, /\.select\(FAVORITE_PUBLIC_SELECT\)/);
  assert.doesNotMatch(favorites, /listVisibleSourceIds|\.from\("cloud_favorites"\)|\.in\("source_id"/);

  const addFavorite = section('async function addFavorite(', 'async function deleteFavoriteByKeys(');
  assert.match(addFavorite, /\.rpc\("upsert_cloud_favorite_visible", \{/);
  for (const argument of [
    'p_user_id: userId',
    'p_profile_id: profileId',
    'p_source_id: sourceId',
    'p_item_type: itemType',
    'p_item_id: itemId',
  ]) assert.match(addFavorite, new RegExp(argument));
  assert.match(addFavorite, /\.select\(FAVORITE_PUBLIC_SELECT\)[\s\S]*\.single\(\)/);
  assert.match(addFavorite, /error\?\.code === "55000"[\s\S]*SOURCE_CATALOG_NOT_VISIBLE/);
  assert.doesNotMatch(addFavorite, /assertVisibleSource|\.from\("cloud_favorites"\)|\.upsert\(/);

  const historyItem = section('async function getHistoryItem(', 'async function listHistory(');
  assert.match(historyItem, /\.rpc\("get_cloud_watch_history_item_visible", \{/);
  for (const argument of [
    'p_user_id: userId',
    'p_profile_id: profileId',
    'p_source_id: sourceId',
    'p_item_type: itemType',
    'p_item_id: itemId',
  ]) assert.match(historyItem, new RegExp(argument));
  assert.match(historyItem, /UUID_PATTERN\.test\(sourceId\)/);
  assert.match(historyItem, /\.select\(cols\)[\s\S]*\.maybeSingle\(\)/);
  assert.doesNotMatch(historyItem, /sourceCatalogVisible|\.from\("cloud_watch_history"\)|\.from\("cloud_catalog_visible_watch_history"\)/);

  const history = section('async function listHistory(', 'async function listHistorySources(');
  assert.match(history, /\.from\("cloud_catalog_visible_watch_history"\)/);
  assert.match(history, /\.select\(WATCH_HISTORY_PUBLIC_SELECT\)/);
  assert.doesNotMatch(history, /\.from\("cloud_watch_history"\)|\.in\("source_id"/);

  const historySources = section('async function listHistorySources(', 'async function pruneUnavailableHistory(');
  assert.match(historySources, /\.from\("cloud_catalog_visible_sources"\)/);

  const saveHistory = section('async function saveHistory(', 'async function recordPlaybackEvent(');
  assert.match(saveHistory, /\.rpc\("upsert_cloud_watch_history_causal"/);
  assert.match(saveHistory, /\.select\(WATCH_HISTORY_PUBLIC_SELECT\)[\s\S]*\.single\(\)/);
});

test('targeted history RPC rejects a hidden requested source before considering legacy fallback', () => {
  const rpc = sectionOf(
    LIFECYCLE_MIGRATION,
    'create or replace function public.get_cloud_watch_history_item_visible(',
    '\ncreate or replace function public.cloud_catalog_visible_title_ids_by_source_languages(',
  );
  assert.match(rpc, /security definer/);
  assert.match(rpc, /from public\.cloud_catalog_visible_watch_history history/);
  assert.match(rpc, /public\.norva_source_catalog_visible\(p_source_id, p_user_id\)[\s\S]*history\.source_id = p_source_id or history\.source_id is null/);
  assert.match(rpc, /when p_source_id is not null and history\.source_id = p_source_id then 0[\s\S]*history\.updated_at desc[\s\S]*limit 1/);
  assert.match(rpc, /revoke all on function public\.get_cloud_watch_history_item_visible\([\s\S]*from public, anon, authenticated/);
  assert.match(rpc, /grant execute on function public\.get_cloud_watch_history_item_visible\([\s\S]*to service_role/);
});

test('visibility helper fails closed with a stable public code', () => {
  const helper = section('async function sourceCatalogVisible(', 'async function assertOwnedSource(');
  assert.match(helper, /db\.rpc\("norva_source_catalog_visible"/);
  assert.match(helper, /p_source_id:\s*sourceId/);
  assert.match(helper, /p_user_id:\s*userId/);
  assert.match(helper, /if \(error\) throwDb/);
  assert.match(helper, /SOURCE_CATALOG_NOT_VISIBLE/);
  assert.match(helper, /async function visibleSourceSnapshot[\s\S]*cloud_catalog_visible_sources[\s\S]*\.select\("id,config_revision"\)/);
});

test('management reads exclude staging in DB while retaining provider-hidden Settings rows', () => {
  const publicSelect = sectionOf(
    SOURCE_PUBLIC,
    'export const SOURCE_MANAGEMENT_PUBLIC_FIELDS = Object.freeze([',
    '\nexport const SOURCE_MANAGEMENT_PUBLIC_SELECT',
  );
  assert.match(publicSelect, /"catalog_visible"/);
  assert.match(publicSelect, /"user_visibility_epoch"/);
  assert.match(publicSelect, /"provider_access_status"/);
  assert.doesNotMatch(publicSelect, /"user_id"/);
  assert.doesNotMatch(publicSelect, /config_ciphertext/);

  const listSources = section('async function listSources(', 'async function listVisibleSources(');
  assert.match(listSources, /\.from\("cloud_source_management_sources"\)/);
  assert.match(listSources, /\.select\(SOURCE_MANAGEMENT_PUBLIC_SELECT\)/);
  assert.match(listSources, /\.is\("deleted_at", null\)/);
  assert.match(listSources, /\.map\(sanitizeSource\)/);
  assert.doesNotMatch(listSources, /\.from\("cloud_sources"\)|cloud_catalog_visible_sources|\.eq\("catalog_visible", true\)/);

  const statuses = section('async function listSourceStatuses(', '// Count the items a playlist would import');
  assert.match(statuses, /\.from\("cloud_source_management_sources"\)/);
  assert.match(statuses, /\.select\("id,sync_status,sync_error,catalog_visible,user_visibility_epoch"\)/);
  assert.match(statuses, /\.is\("deleted_at", null\)/);
  assert.match(statuses, /catalog_visible:/);
  assert.match(statuses, /user_visibility_epoch:/);
  assert.match(statuses, /publicSourceSyncError/);
  assert.match(statuses, /error_code:/);
  assert.doesNotMatch(statuses, /\.from\("cloud_sources"\)|\.eq\("catalog_visible", true\)/);
});

test('source plan capacity counts only commercially visible logical sources', () => {
  const route = section('if (scope === "sources") {', 'if (scope === "media-items") {');
  assert.match(
    route,
    /requirePlanCapacity\(user\.id, db, "sources", "cloud_catalog_visible_sources"\)/,
  );
  assert.doesNotMatch(
    route,
    /requirePlanCapacity\(user\.id, db, "sources", "cloud_sources"/,
  );
});

test('source payload sanitizer exposes only host-level connection hints and bounded progress', async () => {
  const {
    sanitizeSource,
    sanitizeSourceValidation,
  } = await import(pathToFileURL(SOURCE_PUBLIC_PATH).href);

  const source = sanitizeSource({
    id: '10000000-0000-4000-8000-000000000001',
    user_id: '20000000-0000-4000-8000-000000000002',
    display_name: 'Family TV',
    catalog_visible: false,
    user_visibility_epoch: '42',
    config_ciphertext: 'ciphertext-secret',
    username: 'alice',
    serverUrl: 'https://alice:secret@provider.example/player_api.php',
    sync_error: '[502] request failed (https://alice:secret@provider.example/player_api.php?username=alice&token=secret timeout)',
    config_hint: {
      serverHost: 'https://alice:secret@provider.example:8443/player_api.php?username=alice&password=secret',
      playlistHost: 'https://playlist.example/private/list.m3u?token=secret',
      username: 'alice',
      password: 'secret',
      targetUrl: 'https://provider.example/private',
      tokenRef: 'vault://secret',
      hasPassword: true,
      estimatedItems: 99_000_000,
      syncCursor: { url: 'https://provider.example/private', token: 'secret' },
      finalizeLease: { owner: 'internal-worker', until: '2099-01-01T00:00:00Z' },
      finalizeCursor: {
        phase: 'titles',
        offset: 99_000_000,
        afterId: '30000000-0000-4000-8000-000000000003',
        secretRef: 'vault://secret',
      },
      lastSync: {
        live: -7,
        movies: 99_000_000,
        series: 12,
        syncedAt: '2026-08-22T18:30:00Z',
        providerUrl: 'https://provider.example/private',
      },
      syncProgress: {
        status: 'syncing',
        stage: 'building_titles',
        percent: 450,
        counts: { live: 12, movies: 99_000_000, internalRows: 77 },
        error: 'raw provider exploded token=secret',
        detail: { username: 'alice' },
        steps: {
          import: { status: 'running', count: 99_000_000, url: 'https://provider.example' },
        },
      },
    },
  });

  assert.equal(source.catalog_visible, false, 'Settings must retain a provider-hidden source');
  assert.equal(source.user_visibility_epoch, '42');
  assert.equal(Object.hasOwn(source, 'user_id'), false, 'account identifiers are not source payload data');
  assert.equal(source.config_hint.serverHost, 'provider.example:8443');
  assert.equal(source.config_hint.playlistHost, 'playlist.example');
  assert.equal(source.config_hint.hasPassword, true);
  assert.equal(source.config_hint.estimatedItems, 10_000_000);
  assert.equal(source.config_hint.syncProgress.percent, 100);
  assert.equal(source.config_hint.syncProgress.counts.movies, 10_000_000);
  assert.equal(source.config_hint.finalizeCursor.offset, 1_000_000);
  assert.equal(source.config_hint.finalizeCursor.afterId, '30000000-0000-4000-8000-000000000003');
  assert.equal(source.sync_error_code, 'PROVIDER_TEMPORARILY_UNAVAILABLE');
  assert.equal(source.sync_error, 'The TV service is temporarily unavailable.');

  const serialized = JSON.stringify(source);
  for (const forbidden of [
    'config_ciphertext',
    'ciphertext-secret',
    '20000000-0000-4000-8000-000000000002',
    'alice',
    'https://',
    'player_api.php',
    'syncCursor',
    'finalizeLease',
    'tokenRef',
    'raw provider exploded',
  ]) assert.equal(serialized.includes(forbidden), false, `public source leaked ${forbidden}`);

  const validation = sanitizeSourceValidation({
    serverUrl: 'https://alice:secret@provider.example/player_api.php?username=alice',
    playlistUrl: 'https://playlist.example/private.m3u?token=secret',
    username: 'alice',
    estimatedItems: 99_000_000,
  });
  assert.deepEqual(validation, {
    serverHost: 'provider.example',
    playlistHost: 'playlist.example',
    estimatedItems: 10_000_000,
  });
});

test('boot and user reads keep management scope while paired devices receive only visible sources', () => {
  const boot = section('if (scope === "boot" && req.method === "GET") {', '\n  if (scope === "entitlements"');
  assert.match(boot, /listSources\(user\.id, db\)/);

  const paired = section('if (scope === "device") {', '\n  const user = await requireUser');
  assert.match(paired, /req\.method === "GET" && id === "sources" && !action[\s\S]*listVisibleSources\(device\.user_id, db\)/);
  assert.match(paired, /segments\[3\] === "test"[\s\S]*assertVisibleSource\(action, device\.user_id, db\)[\s\S]*testSourceConnection/);

  const userSources = section('if (scope === "sources") {', '\n  if (scope === "media-items")');
  assert.match(userSources, /req\.method === "GET" && !id[\s\S]*listSources\(user\.id, db\)/);
  assert.match(userSources, /id === "status"[\s\S]*listSourceStatuses\(user\.id, db\)/);

  const visible = section('async function listVisibleSources(', 'async function listVisibleSourceIds(');
  assert.match(visible, /\.from\("cloud_catalog_visible_sources"\)/);
  assert.match(visible, /\.select\(SOURCE_CATALOG_PUBLIC_SELECT\)/);
  assert.match(visible, /\.map\(sanitizeCatalogSource\)/);
  assert.doesNotMatch(visible, /cloud_source_management_sources|cloud_sources/);
});
