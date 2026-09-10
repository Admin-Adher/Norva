'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');
const projectionSource = read('supabase/functions/_shared/vod-title-projection.ts');
const syncSource = read('supabase/functions/_shared/xtream-sync.ts');

function projectionHarness(overrides = {}) {
  const output = { exports: {} };
  let externalRequests = 0;
  const dependencies = {
    ...require('../supabase/functions/_shared/tmdb-search-policy.mjs'),
    ...require('../supabase/functions/_shared/tmdb-enrichment-policy.mjs'),
    adoptActiveCatalogUserVisibilityEpoch: async () => {},
    isRollingRpcUnavailable: (error) => ['42883', 'PGRST202'].includes(error?.code),
    readActiveCatalogGenerationSnapshot: async () => ({ kind: 'active', generationId: 'generation-a', userVisibilityEpoch: '4' }),
    assertActiveCatalogGenerationCurrent: async () => {},
    catalogGenerationRpcFence: (generation) => ({ p_generation_id: generation.generationId }),
    withCatalogGenerationRows: (rows, generation) => rows.map((row) => ({ ...row, generation_id: generation.generationId })),
    hydrateSelectionSnapshotMovieTracks: async () => {},
    hydrateSelectionSnapshotSeriesTracks: async () => {},
    hydrateSelectionAudioResults: async () => {},
    ...overrides,
  };
  const code = transformSync(`${projectionSource}\nexport { resolveProjectionCacheKey, loadVodInfoIds, validateProviderTmdbIds, collectProviderIds, reuseExactFileTitleMatches };`, {
    loader: 'ts', format: 'cjs', target: 'node22',
  }).code;
  vm.runInNewContext(code, {
    module: output,
    exports: output.exports,
    require: () => dependencies,
    TextEncoder,
    URL,
    crypto: webcrypto,
    console,
    Deno: { env: { get: () => '' } },
    fetch: async () => { externalRequests += 1; throw new Error('External requests forbidden in early projection'); },
    setTimeout: () => { throw new Error('Unexpected retry/timer in cache-only projection'); },
  });
  return { api: output.exports, externalRequests: () => externalRequests };
}

function database({ identity = 'verified-provider', identityError = null, visible = true, tracks = [], titles = [], peers = [], peerError = null,
  media = [], variants = [], heads = [] } = {}) {
  const calls = [];
  const writes = [];
  const tables = {
    catalog_source_provider_identities: identity ? [{ source_id: 'source-a', user_id: 'owner-a', identity_id: identity }] : [],
    catalog_file_tracks: tracks,
    catalog_titles: titles,
    cloud_media_items: media,
    cloud_title_variants: variants,
    cloud_source_catalog_heads: heads,
  };
  const db = {
    calls, writes,
    from(table) {
      const filters = [];
      let payload;
      let limit = Infinity;
      const result = () => {
        calls.push({ table, filters: filters.slice(), write: Boolean(payload) });
        if (payload) {
          writes.push({ table, rows: payload });
          return { data: table === 'cloud_titles' ? payload.map((row, index) => ({ id: `title-${index}`, item_type: row.item_type, identity_key: row.identity_key })) : null, error: null };
        }
        const rows = (tables[table] || []).filter((row) => filters.every(([kind, key, value]) =>
          kind === 'eq' ? row[key] === value : kind === 'in' ? value.includes(row[key]) : row[key] != null)).slice(0, limit);
        return { data: rows, error: table === 'catalog_source_provider_identities' ? identityError : null };
      };
      const query = {
        select() { return query; },
        eq(key, value) { filters.push(['eq', key, value]); return query; },
        in(key, value) { filters.push(['in', key, value]); return query; },
        not(key, _op, _value) { filters.push(['not-null', key]); return query; },
        order() { return query; },
        limit(value) { limit = value; return query; },
        upsert(rows) { payload = rows; return query; },
        async maybeSingle() { const response = result(); return { ...response, data: response.data?.[0] || null }; },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      if (name === 'norva_public_catalog_title_candidates') return { data: [], error: null };
      if (name === 'norva_exact_file_title_candidates') return { data: peers.filter((peer) =>
        (!peer.item_type || peer.item_type === args.p_item_type) && args.p_external_ids.includes(peer.external_id)), error: peerError };
      return { data: name === 'norva_source_catalog_visible' ? visible : 0, error: null };
    },
  };
  return db;
}

const row = (externalId, title = 'Example Film (2020)') => ({
  id: `media-${externalId}`, source_id: 'source-a', user_id: 'owner-a', generation_id: 'generation-a',
  item_type: 'movie', external_id: externalId, title, metadata: {}, playback_hint: {},
});
const cachedFile = (externalId, tmdbId = '101', serverHost = 'verified-provider') => ({
  server_host: serverHost, item_type: 'movie', external_id: externalId,
  ids_resolved_at: '2026-09-10T00:00:00Z', provider_tmdb_id: tmdbId, provider_imdb_id: null,
});
const cachedTitle = (tmdbId = '101', { title = 'Example Film', year = 2020, valid = true } = {}) => ({
  item_type: 'movie', provider_tmdb_id: tmdbId, title, release_year: year,
  metadata: { tmdbValidation: { valid, title, year: String(year) }, tmdb: { title, release_date: `${year}-01-01`, genres: [{ id: 12, name: 'Adventure' }] } },
});

test('early cinema passes cache-capable config with zero external budgets and preserves its fence', async () => {
  const begin = syncSource.indexOf('const projectFirstCinemaBatch = async');
  const end = syncSource.indexOf('\n    const importDiscoveryTarget = async', begin);
  assert.ok(begin >= 0 && end > begin);
  const code = transformSync(`${syncSource.slice(begin, end)}\nmodule.exports = projectFirstCinemaBatch;`, {
    loader: 'ts', format: 'cjs', target: 'node22',
  }).code;
  let projection;
  let fenced = 0;
  const testRow = row('1');
  const query = { select() { return query; }, eq() { return query; }, async in() { return { data: [testRow], error: null }; } };
  const output = { exports: {} };
  vm.runInNewContext(code, {
    module: output, exports: output.exports,
    sourceId: 'source-a', userId: 'owner-a', progress: {}, IMPORT_BATCH_SIZE: 250,
    accessSnapshot: { generationId: 'generation-a' },
    serverUrl: 'https://provider.example', username: 'fixture', password: 'fixture',
    stringOr: (value, fallback) => typeof value === 'string' ? value : fallback,
    db: { from() { return query; } },
    refreshVodTitleProjection: async (options) => { projection = options; await options.assertSourceCurrent(); },
    assertCatalogSnapshotCurrent: async () => { fenced += 1; },
    persist: async () => {},
  });
  await output.exports('movie', [testRow]);
  assert.equal(projection.xtreamConfig.serverUrl, 'https://provider.example');
  assert.equal(projection.vodInfoLimit, 0);
  assert.equal(projection.tmdbValidateLimit, 0);
  assert.equal(projection.mediaGatewayUrl, null);
  assert.equal(projection.mediaGatewayToken, null);
  assert.equal(fenced, 1);
  assert.doesNotMatch(syncSource.slice(begin, end), /norva_resolve_provider_identity|catalog_provider_identities|config_hint/);
});

test('cache authority is the server-owned source and owner link, never its host', async () => {
  const { api } = projectionHarness();
  const db = database();
  assert.equal(await api.resolveProjectionCacheKey(db, 'source-a', 'owner-a', 'https://ignored.example'), 'verified-provider');
  assert.equal(await api.resolveProjectionCacheKey(db, 'source-a', 'wrong-owner', 'https://ignored.example'), 'source:source-a');
  assert.equal(await api.resolveProjectionCacheKey(database({ identity: null }), 'source-a', 'owner-a', ''), 'source:source-a');
  assert.equal(await api.resolveProjectionCacheKey(database({ identityError: new Error('unavailable') }), 'source-a', 'owner-a', ''), 'source:source-a');
});

test('known verified source reuses exact-file IDs and trusted tags with zero provider or TMDB calls', async () => {
  const harness = projectionHarness();
  const db = database({ tracks: [cachedFile('1')], titles: [cachedTitle()] });
  const key = await harness.api.resolveProjectionCacheKey(db, 'source-a', 'owner-a', 'https://provider.example');
  const ids = await harness.api.loadVodInfoIds({}, [row('1')], 0, null, db, key);
  const validation = await harness.api.validateProviderTmdbIds([row('1')], harness.api.collectProviderIds([row('1')], ids), 0, db);
  assert.equal(ids.get('1').tmdbId, '101');
  const accepted = [...validation.values()][0];
  assert.equal(accepted.valid, true);
  assert.equal(accepted.year, '2020');
  assert.equal(accepted.details.genres[0].name, 'Adventure');
  assert.equal(harness.externalRequests(), 0);
});

test('provisional source cannot borrow an identical external ID from another provider', async () => {
  const harness = projectionHarness();
  const db = database({ identity: null, tracks: [cachedFile('1')], titles: [cachedTitle()] });
  const key = await harness.api.resolveProjectionCacheKey(db, 'source-a', 'owner-a', 'https://provider.example');
  const ids = await harness.api.loadVodInfoIds({}, [row('1')], 0, null, db, key);
  assert.equal(ids.size, 0);
  assert.equal(harness.externalRequests(), 0);
  assert.equal(db.writes.length, 0);
});

test('real early projection writes trusted title tags and hydrates only exact movie files', async () => {
  const harness = projectionHarness();
  const db = database({ tracks: [cachedFile('1')], titles: [cachedTitle()] });
  let fences = 0;
  await harness.api.refreshVodTitleProjection({
    sourceId: 'source-a', userId: 'owner-a', generation: { generationId: 'generation-a', kind: 'active' },
    rows: [row('1'), row('missing', 'Another Film')], db,
    xtreamConfig: { serverUrl: 'https://provider.example', username: 'fixture', password: 'fixture' },
    vodInfoLimit: 0, tmdbValidateLimit: 0, mediaGatewayUrl: null, mediaGatewayToken: null,
    assertSourceCurrent: async () => { fences += 1; },
  });
  const titles = db.writes.find((write) => write.table === 'cloud_titles').rows;
  const trusted = titles.find((title) => title.provider_tmdb_id === '101');
  const missing = titles.find((title) => title.original_title === 'Another Film');
  assert.equal(trusted.match_status, 'provider_verified');
  assert.equal(trusted.release_year, 2020);
  assert.equal(trusted.metadata.tmdb.genres[0].name, 'Adventure');
  assert.equal(missing.match_status, 'unmatched');
  assert.equal(missing.metadata.tmdb, undefined);
  const hydration = db.calls.find((call) => call.rpc === 'hydrate_cloud_title_file_languages');
  assert.equal(hydration.args.p_user_id, 'owner-a');
  assert.equal(hydration.args.p_source_id, 'source-a');
  assert.equal(hydration.args.p_generation_id, 'generation-a');
  assert.equal(hydration.args.p_server_key, 'verified-provider');
  assert.equal(hydration.args.p_item_type, 'movie');
  assert.ok(fences > 5, 'retain visibility/generation fences around all cache and write stages');
  assert.equal(harness.externalRequests(), 0);
});

test('partial and negative cache entries do not trigger provider fetches or fill unmatched siblings', async () => {
  const harness = projectionHarness();
  const db = database({ tracks: [cachedFile('1'), cachedFile('2', null), cachedFile('3', '303', 'other-provider')] });
  const ids = await harness.api.loadVodInfoIds({}, [row('1'), row('2'), row('3'), row('4')], 0, null, db, 'verified-provider');
  assert.deepEqual([...ids.keys()], ['1']);
  assert.equal(harness.externalRequests(), 0);
  assert.equal(db.writes.length, 0);
});

test('file-language hydration is bounded to fifty exact files per fenced transaction', async () => {
  const harness = projectionHarness();
  const db = database();
  await harness.api.refreshVodTitleProjection({
    sourceId: 'source-a', userId: 'owner-a', generation: { generationId: 'generation-a', kind: 'active' },
    rows: Array.from({ length: 121 }, (_, i) => row(String(i), `Example ${i}`)), db,
    xtreamConfig: { serverUrl: 'https://provider.example', username: 'fixture', password: 'fixture' },
    vodInfoLimit: 0, tmdbValidateLimit: 0, assertSourceCurrent: async () => {},
  });
  const calls = db.calls.filter(call => call.rpc === 'hydrate_cloud_title_file_languages');
  assert.deepEqual(calls.map(call => call.args.p_external_ids.length), [50, 50, 21]);
  assert.equal(new Set(calls.flatMap(call => call.args.p_external_ids)).size, 121);
  assert.ok(calls.every(call => call.args.p_server_key === 'verified-provider' && call.args.p_generation_id === 'generation-a'));
  assert.equal(harness.externalRequests(), 0);
});

test('a resolved hydration RPC error fails the projection so its sync cursor can retry', async () => {
  const harness = projectionHarness();
  const db = database();
  const rpc = db.rpc.bind(db);
  const failure = { code: 'PT409', message: 'Catalogue changed' };
  db.rpc = async (name, args) => name === 'hydrate_cloud_title_file_languages'
    ? { data: null, error: failure } : rpc(name, args);
  await assert.rejects(harness.api.refreshVodTitleProjection({
    sourceId: 'source-a', userId: 'owner-a', generation: { generationId: 'generation-a', kind: 'active' },
    rows: [row('1')], db, vodInfoLimit: 0, tmdbValidateLimit: 0,
    xtreamConfig: { serverUrl: 'https://provider.example', username: 'fixture', password: 'fixture' },
    assertSourceCurrent: async () => {},
  }), error => error === failure);
  assert.equal(harness.externalRequests(), 0);
  assert.equal(db.writes.some(write => write.table === 'catalog_titles'), false,
    'failed hydration cannot silently continue and acknowledge the projection');
});

test('a generation change before hydration prevents the cache write', async () => {
  let adopts = 0;
  const failure = new Error('Generation superseded');
  const harness = projectionHarness({ adoptActiveCatalogUserVisibilityEpoch: async () => {
    if (++adopts === 3) throw failure;
  }});
  const db = database();
  await assert.rejects(harness.api.refreshVodTitleProjection({
    sourceId: 'source-a', userId: 'owner-a', generation: { generationId: 'generation-a', kind: 'active' },
    rows: [row('1')], db, vodInfoLimit: 0, tmdbValidateLimit: 0,
    xtreamConfig: { serverUrl: 'https://provider.example', username: 'fixture', password: 'fixture' },
    assertSourceCurrent: async () => {},
  }), error => error === failure);
  assert.equal(db.calls.some(call => call.rpc === 'hydrate_cloud_title_file_languages'), false);
});

test('cached metadata still requires validation and compatible title/year', async () => {
  const harness = projectionHarness();
  for (const bad of [cachedTitle('101', { year: 1990 }), cachedTitle('101', { valid: false }), cachedTitle('101', { title: 'Completely Different Work' })]) {
    const db = database({ titles: [bad] });
    const result = await harness.api.validateProviderTmdbIds([row('1')], new Map([['movie:1', { tmdbId: '101', imdbId: null }]]), 0, db);
    assert.equal(result.size, 0);
  }
  assert.equal(harness.externalRequests(), 0);
});

const peer = (externalId, tmdbId = '101', title = 'Example Film', year = 2020) => ({
  external_id: externalId, provider_tmdb_id: tmdbId,
  metadata: { ...cachedTitle(tmdbId, { title, year }).metadata,
    tmdb: { id: Number(tmdbId), title, release_date: `${year}-01-01`, genres: [{ id: 12, name: 'Adventure' }] } },
});
const options = (db, rows = [row('1')]) => ({
  sourceId: 'source-a', userId: 'owner-a', generation: { generationId: 'generation-a', kind: 'active' }, rows, db,
  xtreamConfig: { serverUrl: 'https://provider.example', username: 'fixture', password: 'fixture' },
  vodInfoLimit: 0, tmdbValidateLimit: 0,
});

test('missing exact-file mapping reuses a validated peer, without provider or TMDB access', async () => {
  const harness = projectionHarness();
  const db = database({ peers: [peer('1')] });
  const result = await harness.api.refreshVodTitleProjection(options(db));
  const title = db.writes.find((write) => write.table === 'cloud_titles').rows[0];
  assert.equal(result.exactFileTitlesReused, 1);
  assert.equal(title.provider_tmdb_id, '101');
  assert.equal(title.match_status, 'provider_verified');
  assert.equal(title.metadata.tmdb.genres[0].name, 'Adventure');
  assert.equal(title.metadata.tmdbValidation.reason, 'reused_from_verified_exact_file');
  assert.equal(harness.externalRequests(), 0);
  assert.equal(db.calls.some((call) => call.rpc === 'upsert_catalog_file_ids'), false);
});

test('negative ID cache does not hide a subsequently validated peer mapping', async () => {
  const harness = projectionHarness();
  const db = database({ tracks: [cachedFile('1', null)], peers: [peer('1')] });
  assert.equal((await harness.api.refreshVodTitleProjection(options(db))).exactFileTitlesReused, 1);
  assert.equal(harness.externalRequests(), 0);
});

test('recovered validation is per file: wrong sibling and incompatible remake stay unmatched', async () => {
  const harness = projectionHarness();
  const db = database({ peers: [peer('1'), peer('2'), peer('3')] });
  await harness.api.refreshVodTitleProjection(options(db, [row('1'), row('2', 'Completely Unrelated Story'), row('3', 'Example Film (1990)')]));
  const titles = db.writes.find((write) => write.table === 'cloud_titles').rows;
  assert.equal(titles.filter((title) => title.match_status === 'provider_verified').length, 1);
  assert.equal(titles.filter((title) => title.match_status === 'unmatched').length, 2);
  assert.equal(harness.externalRequests(), 0);
});

test('unvalidated, malformed, duplicate or contradictory RPC evidence cannot bind an identity', async () => {
  for (const peers of [
    [{ ...peer('1'), metadata: { ...peer('1').metadata, tmdbValidation: { valid: false } } }],
    [{ ...peer('1'), provider_tmdb_id: '999' }],
    [peer('1'), peer('1', '202')], [peer('1'), peer('1')],
  ]) {
    const harness = projectionHarness();
    const db = database({ peers });
    assert.equal((await harness.api.refreshVodTitleProjection(options(db))).exactFileTitlesReused, 0);
    assert.equal(db.writes.find((write) => write.table === 'cloud_titles').rows[0].provider_tmdb_id, null);
  }
});

test('recovery never overrides a provider-declared ID or borrows a movie ID for a series', async () => {
  const harness = projectionHarness();
  const rows = [row('1'), { ...row('1', 'Example Series'), item_type: 'series', metadata: { providerTmdbId: '202' } }];
  const db = database({ tracks: [cachedFile('1')], titles: [cachedTitle()] });
  await harness.api.refreshVodTitleProjection(options(db, rows));
  const titles = db.writes.find((write) => write.table === 'cloud_titles').rows;
  assert.equal(titles.find((title) => title.item_type === 'movie').provider_tmdb_id, '101');
  assert.equal(titles.find((title) => title.item_type === 'series').provider_tmdb_id, '202');
  assert.equal(db.calls.some((call) => call.rpc === 'norva_exact_file_title_candidates'), false);
  const collected = harness.api.collectProviderIds([row('1'), { ...row('1'), item_type: 'series' }], new Map([['1', { tmdbId: '101', imdbId: null }]]));
  assert.equal(collected.get('series:1').tmdbId, null);
});

test('equal TMDB numeric IDs keep separate movie/series logical titles and variant foreign keys', async () => {
  const harness = projectionHarness();
  const db = database();
  await harness.api.refreshVodTitleProjection(options(db, [
    { ...row('1'), metadata: { providerTmdbId: '101' } },
    { ...row('1', 'Example Series'), item_type: 'series', metadata: { providerTmdbId: '101' } },
  ]));
  const titles = db.writes.find((write) => write.table === 'cloud_titles').rows;
  const variants = db.writes.find((write) => write.table === 'cloud_title_variants').rows;
  assert.equal(titles.length, 2);
  assert.equal(variants.length, 2);
  assert.notEqual(variants[0].title_id, variants[1].title_id);
  assert.deepEqual(Array.from(titles, (title) => title.item_type), ['movie', 'series']);
});

test('provisional sources skip shared recovery; cache misses stay quiet with zero external calls', async () => {
  const harness = projectionHarness();
  const db = database({ identity: null, peers: [peer('1')] });
  const result = await harness.api.refreshVodTitleProjection(options(db));
  assert.equal(result.exactFileTitlesReused, 0);
  assert.equal(db.calls.some((call) => call.rpc === 'norva_exact_file_title_candidates'), false);
  assert.equal(harness.externalRequests(), 0);
});

test('all eight reported regional prefixes can recover the same validated public title without inventing audio', async () => {
  const harness = projectionHarness();
  const prefixes = ['AR','DE','GR','HU','NL','PL','RU','SO'];
  const rows = prefixes.map((prefix, index) => row(String(index), `${prefix} ▎ The Squad: Home Run`));
  const db = database({ peers: rows.map(item => peer(item.external_id, '12345', 'The Squad: Home Run', 2023)) });
  const result = await harness.api.refreshVodTitleProjection(options(db, rows));
  assert.equal(result.exactFileTitlesReused, 8);
  const titles = db.writes.find((write) => write.table === 'cloud_titles').rows;
  assert.equal(titles.length, 1);
  assert.equal(titles[0].metadata.tmdb.title, 'The Squad: Home Run');
  assert.equal(harness.externalRequests(), 0);
});

test('recovery batches at 200 and fences before each chunk', async () => {
  const harness = projectionHarness();
  const db = database();
  const opts = options(db, Array.from({ length: 401 }, (_, index) => row(String(index))));
  let fences = 0;
  opts.assertSourceCurrent = async () => { fences += 1; };
  await harness.api.reuseExactFileTitleMatches(opts, new Map());
  const calls = db.calls.filter((call) => call.rpc === 'norva_exact_file_title_candidates');
  assert.deepEqual(calls.map((call) => call.args.p_external_ids.length), [200, 200, 1]);
  assert.equal(fences, 3);
  for (const call of calls) {
    assert.equal(call.args.p_source_id, 'source-a');
    assert.equal(call.args.p_user_id, 'owner-a');
    assert.equal(call.args.p_generation_id, 'generation-a');
  }
});

test('rolling missing RPC may degrade; stale, permission and database failures prevent writes', async () => {
  for (const code of ['42883', 'PGRST202', 'PT409', '42501', '57014']) {
    const harness = projectionHarness();
    const db = database({ peerError: { code } });
    if (['42883', 'PGRST202'].includes(code)) {
      assert.equal((await harness.api.refreshVodTitleProjection(options(db))).exactFileTitlesReused, 0);
    } else {
      await assert.rejects(harness.api.refreshVodTitleProjection(options(db)), (error) => error.code === code);
      assert.equal(db.writes.length, 0);
    }
  }
});

test('provider cache validation never blesses an unrelated file sharing the same declared ID', async () => {
  const harness = projectionHarness();
  const db = database({ tracks: [cachedFile('1'), cachedFile('2')], titles: [cachedTitle()] });
  await harness.api.refreshVodTitleProjection(options(db, [row('1'), row('2', 'Completely Unrelated Story')]));
  const variants = db.writes.find((write) => write.table === 'cloud_title_variants').rows;
  assert.equal(variants.find((variant) => variant.external_id === '1').playback_hint.trustedTmdbId, '101');
  assert.equal(variants.find((variant) => variant.external_id === '2').playback_hint.trustedTmdbId, undefined);
});

test('an invalid first sibling cannot hide a valid later file in the shared cache', async () => {
  const harness = projectionHarness();
  const db = database({ tracks: [cachedFile('1'), cachedFile('2')], titles: [cachedTitle()] });
  await harness.api.refreshVodTitleProjection(options(db, [row('1', 'Completely Unrelated Story'), row('2')]));
  const variants = db.writes.find((write) => write.table === 'cloud_title_variants').rows;
  assert.equal(variants.find((variant) => variant.external_id === '1').playback_hint.trustedTmdbId, undefined);
  assert.equal(variants.find((variant) => variant.external_id === '2').playback_hint.trustedTmdbId, '101');
  assert.equal(db.writes.find((write) => write.table === 'cloud_titles').rows[0].match_status, 'provider_verified');
});

const backgroundCandidate = {
  id: 'existing-title', userId: 'owner-a', itemType: 'movie', title: 'Example Film', originalTitle: 'Example Film (2020)',
  releaseYear: 2020, visibilityEpoch: '4', displayGenerationId: 'generation-a',
};
const backgroundDb = (overrides = {}) => database({
  heads: [{ source_id: 'source-a', user_id: 'owner-a', active_generation_id: 'generation-a' }],
  variants: [{ ...row('1'), title_id: 'existing-title' }], media: [{ ...row('1'), available: true }], peers: [peer('1')],
  ...overrides,
});

test('already-imported titles can use the same read-only exact-file recovery before durable search', async () => {
  const harness = projectionHarness();
  const db = backgroundDb();
  const result = await harness.api.reuseBackgroundTitleMatch(db, backgroundCandidate);
  assert.equal(result.tmdbId, '101');
  assert.equal(result.valid, true);
  assert.equal(result.reason, 'reused_from_verified_exact_file');
  assert.equal(harness.externalRequests(), 0);
  assert.equal(db.writes.length, 0);
  for (const table of ['cloud_title_variants','cloud_media_items']) {
    const call = db.calls.find((entry) => entry.table === table);
    for (const [key,value] of [['user_id','owner-a'],['source_id','source-a'],['generation_id','generation-a'],['item_type','movie']]) {
      assert.ok(call.filters.some(([kind, field, filter]) => kind === 'eq' && field === key && filter === value));
    }
  }
});

test('background recovery refuses stale selector or changed source proof before a commit', async () => {
  const harness = projectionHarness();
  await assert.rejects(harness.api.reuseBackgroundTitleMatch(backgroundDb(), { ...backgroundCandidate, visibilityEpoch: 'old' }), /snapshot changed/);
  const changed = projectionHarness({ assertActiveCatalogGenerationCurrent: async () => { throw new Error('source changed'); } });
  await assert.rejects(changed.api.reuseBackgroundTitleMatch(backgroundDb(), backgroundCandidate), /source changed/);
});

test('background recovery does not guess with missing ownership, too many variants or a different title', async () => {
  const harness = projectionHarness();
  assert.equal(await harness.api.reuseBackgroundTitleMatch(backgroundDb(), { ...backgroundCandidate, displayGenerationId: null }), null);
  assert.equal(await harness.api.reuseBackgroundTitleMatch(backgroundDb({ heads: [] }), backgroundCandidate), null);
  assert.equal(await harness.api.reuseBackgroundTitleMatch(backgroundDb({
    variants: Array.from({ length: 33 }, (_, index) => ({ ...row(String(index)), title_id: 'existing-title' })),
  }), backgroundCandidate), null);
  assert.equal(await harness.api.reuseBackgroundTitleMatch(backgroundDb(), { ...backgroundCandidate, originalTitle: 'Completely Unrelated Work' }), null);
  assert.equal(harness.externalRequests(), 0);
});

test('background recovery excludes conflicting versions and never consumes a network budget', async () => {
  const harness = projectionHarness();
  const db = backgroundDb({ peers: [peer('1'),peer('2','202')],
    media: [1,2].map(id => ({ ...row(String(id)), available: true })),
    variants: [1,2].map(id => ({ ...row(String(id)), title_id: 'existing-title' })),
  });
  assert.equal(await harness.api.reuseBackgroundTitleMatch(db, backgroundCandidate), null);
  assert.equal(harness.externalRequests(), 0);
  const source = read('supabase/functions/norva-source-sync/index.ts');
  assert.match(source, /const exactMatch = await reuseBackgroundTitleMatch\(db, row\);/);
  assert.match(source, /const cachedMatch = exactMatch \?\? publicMatch/);
  assert.match(source, /const reused = cachedMatch && acceptAutomaticTmdbSearchMatch\(row, cachedMatch\)/);
  assert.match(source, /const match = reused \? cachedMatch : await searchTmdbMatch/);
  assert.match(source, /applyCatalogBackgroundOutcomes\(\s*db, "search_pending", rows, outcomes, concurrency/);
});

test('hidden source and stale row generation fail before any cache lookup or write', async () => {
  const harness = projectionHarness();
  const db = database({ visible: false });
  const options = { sourceId: 'source-a', userId: 'owner-a', generation: { generationId: 'generation-a' }, rows: [row('1')], db };
  const result = await harness.api.refreshVodTitleProjection(options);
  assert.equal(result.skipped, 'source_not_catalog_visible');
  assert.equal(db.calls.length, 1);
  assert.equal(db.writes.length, 0);
  await assert.rejects(harness.api.refreshVodTitleProjection({ ...options, rows: [{ ...row('1'), generation_id: 'stale' }] }), /snapshotted catalog generation/);
  assert.equal(db.calls.length, 1);
  assert.equal(harness.externalRequests(), 0);
});
