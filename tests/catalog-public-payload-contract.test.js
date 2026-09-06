'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { transformSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'supabase/functions/norva-catalog/index.ts');
const PUBLIC_VIEW_PATH = path.join(ROOT, 'supabase/functions/_shared/catalog-public-view.mjs');
const CLIENT_PATH = path.join(ROOT, 'public/js/cloudApi.js');
const CATALOG = fs.readFileSync(CATALOG_PATH, 'utf8').replace(/\r\n?/g, '\n');
const CLIENT = fs.readFileSync(CLIENT_PATH, 'utf8').replace(/\r\n?/g, '\n');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('catalog media/search/title payloads are explicit and strip tenant and M3U target data', async () => {
  const { sanitizeCatalogMediaPayload } = await import(pathToFileURL(PUBLIC_VIEW_PATH).href);
  const payload = sanitizeCatalogMediaPayload({
    contract: 'norva.home.rails.v1',
    user_id: 'account-private-id',
    items: [{
      id: 'media-1',
      user_id: 'account-private-id',
      source_id: 'source-1',
      item_type: 'movie',
      external_id: 'provider-item-42',
      title: 'Public title',
      raw_title: 'Public.Title.MULTI.1080p',
      poster_url: 'https://provider.example/live/provider-user/provider-password/42.ts',
      backdrop_url: '//provider.example/live/provider-user/provider-password/42.ts',
      playback_hint: {
        sourceType: 'm3u',
        streamId: 'provider-item-42',
        container: 'mkv',
        targetUrl: 'https://provider.example/live/provider-user/provider-password/42.ts',
        target_url: 'https://provider.example/private/provider-token',
        providerUrl: 'https://provider.example/player_api.php?token=provider-token',
        token: 'provider-token',
      },
      metadata: {
        categoryName: 'Drama',
        overview: 'Public overview',
        targetUrl: 'https://provider.example/private/provider-token',
        user_id: 'account-private-id',
        username: 'provider-user',
        error: 'raw-provider-error',
        rawProviderResponse: { password: 'provider-password' },
      },
      default_variant: {
        id: 'variant-1',
        user_id: 'account-private-id',
        source_id: 'source-1',
        external_id: 'provider-item-42',
        playback_hint: {
          sourceType: 'm3u',
          streamId: 'provider-item-42',
          targetUrl: 'https://provider.example/live/provider-user/provider-password/42.ts',
        },
        metadata: { error: 'raw-provider-error' },
      },
      variants: [{
        id: 'variant-1',
        user_id: 'account-private-id',
        source_id: 'source-1',
        external_id: 'provider-item-42',
        playback_hint: {
          sourceType: 'm3u',
          streamId: 'provider-item-42',
          targetUrl: 'https://provider.example/live/provider-user/provider-password/42.ts',
        },
      }],
    }],
  });

  assert.equal(payload.items.length, 1);
  const item = payload.items[0];
  assert.equal(item.source_id, 'source-1');
  assert.equal(item.external_id, 'provider-item-42');
  assert.equal(item.raw_title, 'Public.Title.MULTI.1080p');
  assert.deepEqual(item.playback_hint, {
    sourceType: 'm3u',
    streamId: 'provider-item-42',
    container: 'mkv',
  });
  assert.equal(item.metadata.categoryName, 'Drama');
  assert.equal(item.metadata.overview, 'Public overview');
  assert.equal(item.poster_url, undefined, 'a stream target disguised as artwork must be removed');
  assert.equal(item.backdrop_url, undefined, 'a protocol-relative provider target must be removed');
  assert.equal(item.default_variant.source_id, 'source-1');
  assert.equal(item.variants[0].external_id, 'provider-item-42');

  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    'user_id',
    'account-private-id',
    'targetUrl',
    'target_url',
    'providerUrl',
    'provider-user',
    'provider-password',
    'provider-token',
    'raw-provider-error',
    'rawProviderResponse',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `catalog payload leaked ${forbidden}`);
  }
});

test('durable generation title payload bypasses both global overlays and strips every internal proof', async () => {
  const source = section(
    CATALOG,
    'const CATALOG_TITLE_INTERNAL_PROOF_FIELDS',
    '\nfunction titleRailItem(',
  );
  const compiled = transformSync(`${source}\nmodule.exports = {
    applyCatalogOverlay,
    catalogTitleUsesGenerationPayload,
    stripCatalogTitleInternalProof,
  };`, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;

  const queriedIds = [];
  const textOverlayRows = [];
  let catalogFlag = true;
  const db = {
    from(table) {
      assert.equal(table, 'catalog_titles');
      const query = {
        select() { return query; },
        eq() { return query; },
        in(_field, ids) { queriedIds.push(...ids); return query; },
        then(resolve, reject) {
          return Promise.resolve({
            data: [{
              provider_tmdb_id: '200',
              title: 'Global title',
              original_title: 'Global original',
              release_year: 2020,
              poster_url: 'https://images.example/global.jpg',
              backdrop_url: 'https://images.example/global-bg.jpg',
              metadata: { tmdb: { runtime: 200 } },
            }],
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    db,
    catalogReadEnabled: () => catalogFlag,
    applyCatalogTextOverlay: async (rows) => {
      textOverlayRows.push(...rows.map((row) => row.id));
      for (const row of rows) {
        row.__catalog_base_overview = 'Global base overview';
        row.metadata = {
          ...(row.metadata || {}),
          i18n: {
            ...((row.metadata && row.metadata.i18n) || {}),
            fr: { title: 'Global localized title', overview: 'Global localized overview' },
          },
        };
      }
    },
    stringOrNull: (value) => typeof value === 'string' && value ? value : null,
    isRecord: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    recordOrEmpty: (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {},
    catalogTextStatusEligible: (value) => ['provider_verified', 'matched', 'manual'].includes(String(value || '')),
  };
  vm.runInNewContext(compiled, sandbox, { filename: 'catalog-generation-overlay.ts' });
  const runtime = sandbox.module.exports;

  assert.equal(runtime.catalogTitleUsesGenerationPayload({
    metadata: {
      overlayGenerationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      displayGenerationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  }), false, 'provider metadata cannot forge the top-level SQL marker');
  assert.equal(runtime.catalogTitleUsesGenerationPayload({
    overlayGenerationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayGenerationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  }), false, 'a mismatched SQL proof must not bypass global handling');

  const pRow = {
    id: 'p-title',
    provider_tmdb_id: '100',
    title: 'Generation title',
    metadata: { tmdb: { runtime: 1 } },
    overlay_catalog_metadata: { tmdb: { runtime: 121, vote_average: 8.2 }, tmdbValidation: { valid: true } },
    overlay_generation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    display_generation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    best_generation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    bestGenerationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    projection_generation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectionGenerationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    payload_generation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    payloadGenerationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    best_variant_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    bestVariantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    base_updated_at: '2026-08-23T00:00:00.000Z',
    baseUpdatedAt: '2026-08-23T00:00:00.000Z',
    payload_updated_at: '2026-08-23T00:00:00.000Z',
    payloadUpdatedAt: '2026-08-23T00:00:00.000Z',
    storage_kind: 'projection',
    storageKind: 'projection',
    visibility_epoch: 9,
    visibilityEpoch: 9,
  };
  const gRow = {
    id: 'g-title',
    provider_tmdb_id: '200',
    title: 'Base title',
    metadata: { tmdb: { runtime: 2 } },
    overlayGenerationId: null,
    displayGenerationId: null,
    payloadUpdatedAt: '2026-08-23T00:00:00.000Z',
  };
  await runtime.applyCatalogOverlay([pRow, gRow], 'movie', 'fr');
  assert.deepEqual(queriedIds, ['200'], 'the global lookup must exclude generation-owned P');
  assert.equal(pRow.title, 'Generation title');
  assert.deepEqual(pRow.metadata, {
    tmdb: { runtime: 121, vote_average: 8.2 },
    tmdbValidation: { valid: true },
  });
  assert.equal(gRow.title, 'Global title');

  for (const row of [pRow, gRow]) {
    const serialized = JSON.stringify(row);
    for (const proof of [
      'best_generation_id', 'bestGenerationId',
      'display_generation_id', 'displayGenerationId',
      'overlay_generation_id', 'overlayGenerationId',
      'overlay_catalog_metadata', 'overlayCatalogMetadata',
      'projection_generation_id', 'projectionGenerationId',
      'payload_generation_id', 'payloadGenerationId',
      'best_variant_id', 'bestVariantId',
      'base_updated_at', 'baseUpdatedAt',
      'payload_updated_at', 'payloadUpdatedAt',
      'storage_kind', 'storageKind',
      'visibility_epoch', 'visibilityEpoch',
    ]) assert.equal(serialized.includes(proof), false, `catalog row leaked ${proof}`);
  }

  catalogFlag = false;
  queriedIds.length = 0;
  const pOff = {
    id: 'p-off', provider_tmdb_id: '100', title: 'P off', match_status: 'provider_verified',
    metadata: { categoryName: 'Provider category' },
    overlayCatalogMetadata: {
      tmdb: {
        runtime: 99,
        vote_average: 7.9,
        overview: 'Projection base overview',
        genres: [{ id: 1, name: 'Projection genre' }],
      },
      tmdbValidation: { valid: true },
      i18n: { fr: { title: 'Projection localized title', overview: 'Projection localized overview' } },
    },
    overlayGenerationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    displayGenerationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  };
  const gOff = {
    id: 'g-off', provider_tmdb_id: '200', title: 'G off', match_status: 'provider_verified',
    metadata: { categoryName: 'Provider category' },
  };
  await runtime.applyCatalogOverlay([pOff, gOff], 'movie', 'fr');
  assert.deepEqual(textOverlayRows, ['g-off']);
  assert.equal(pOff.title, 'P off');
  assert.deepEqual(JSON.parse(JSON.stringify(pOff.metadata)), {
    categoryName: 'Provider category',
    i18n: { fr: { title: 'Projection localized title', overview: 'Projection localized overview' } },
  }, 'flag OFF keeps P thin and restores only its trusted fill-only localized text');
  assert.equal(pOff.__catalog_base_overview, 'Projection base overview');
  assert.equal(JSON.stringify(pOff).includes('runtime'), false);
  assert.equal(JSON.stringify(pOff).includes('vote_average'), false);
  assert.equal(JSON.stringify(pOff).includes('Projection genre'), false);
  assert.deepEqual(gOff.metadata, {
    categoryName: 'Provider category',
    i18n: { fr: { title: 'Global localized title', overview: 'Global localized overview' } },
  });
  assert.equal(gOff.__catalog_base_overview, 'Global base overview');
  assert.equal(pOff.overlayGenerationId, undefined);
  assert.equal(pOff.displayGenerationId, undefined);
});

test('flat media grid and search keep P display data isolated from global A under both read flags', async () => {
  const flatSource = section(
    CATALOG,
    'const flatMediaGenerationTitleProof',
    '\n// Attach the title\'s REAL detected languages',
  );
  const boundedSource = section(
    CATALOG,
    'function boundedProviderOverview(',
    '\nasync function attachMediaLanguages(',
  );
  const attachSource = section(
    CATALOG,
    'async function attachMediaLanguages(',
    '\nasync function listMediaCategories(',
  );
  const generationSource = section(
    CATALOG,
    'const CATALOG_TITLE_INTERNAL_PROOF_FIELDS',
    '\n// Full display overlay remains guarded',
  );
  const compiled = transformSync(`${boundedSource}\n${generationSource}\n${flatSource}\n${attachSource}\nmodule.exports = {
    attachMediaLanguages,
    localizeMediaTitles,
    flatMediaBlocksGlobalTitleOverlay,
  };`, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;

  const generationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const pTitleId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const gTitleId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const globalCalls = [];
  let catalogFlag = true;
  let hydrationFails = false;
  const visibleRows = [{
    id: pTitleId,
    provider_tmdb_id: '100',
    audio_languages: ['ja'],
    version_languages: ['ja'],
    audio_tracks: [{ index: 0, lang: 'ja' }],
    poster_url: 'https://images.example/b-visible.jpg',
    backdrop_url: 'https://images.example/b-visible-bg.jpg',
    match_status: 'provider_verified',
    visible_source_ids: ['source-b'],
  }, {
    id: gTitleId,
    provider_tmdb_id: '200',
    audio_languages: ['en'],
    version_languages: ['en'],
    audio_tracks: [],
    poster_url: 'https://images.example/g-visible.jpg',
    backdrop_url: 'https://images.example/g-visible-bg.jpg',
    match_status: 'provider_verified',
    visible_source_ids: ['source-g'],
  }];
  const hydratedP = {
    id: pTitleId,
    user_id: 'user-1',
    provider_tmdb_id: '100',
    match_status: 'provider_verified',
    title: 'B title',
    release_year: 2026,
    poster_url: 'https://images.example/b.jpg',
    backdrop_url: 'https://images.example/b-bg.jpg',
    rating_num: 8.8,
    metadata: { categoryName: 'B provider category' },
    overlay_catalog_metadata: {
      tmdbValidation: { valid: true },
      tmdb: {
        overview: 'B catalog overview',
        runtime: 123,
        vote_average: 8.8,
        original_language: 'ja',
      },
      i18n: { fr: { title: 'Titre B', overview: 'Synopsis B' } },
    },
    overlay_generation_id: generationId,
    display_generation_id: generationId,
    visible_source_ids: ['source-b'],
    variant_count: 1,
  };

  function queryFor(table) {
    const state = { table, select: '', ids: [] };
    const query = {
      select(value) { state.select = String(value); return query; },
      eq() { return query; },
      in(_field, ids) { state.ids = [...ids]; return query; },
      then(resolve, reject) {
        let data;
        if (table === 'cloud_catalog_visible_titles') {
          data = state.select.includes('audio_languages')
            ? visibleRows.filter((row) => state.ids.includes(row.provider_tmdb_id))
            : [{ provider_tmdb_id: '200', loc: 'Titre G visible' }];
        } else {
          assert.equal(table, 'catalog_titles');
          globalCalls.push({ select: state.select, ids: [...state.ids] });
          data = state.select.includes('original_language')
            ? [{
              provider_tmdb_id: '200', original_language: 'en', trusted: 'true',
              loc_title: 'Global A/G title', loc_overview: 'Global A/G overview',
              tmdb_runtime: '96',
              poster_url: 'https://images.example/global-a.jpg',
              backdrop_url: 'https://images.example/global-a-bg.jpg',
            }]
            : [{ provider_tmdb_id: '200', loc: 'Global A/G title' }];
        }
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return query;
  }

  const sandbox = {
    module: { exports: {} },
    exports: {},
    db: { from: queryFor },
    preferredTmdbSynopsis: (await import('../supabase/functions/_shared/tmdb-enrichment-policy.mjs')).preferredTmdbSynopsis,
    catalogReadEnabled: () => catalogFlag,
    attachFlatMediaFileLanguages: async () => {},
    requiredCatalogTitleVisibilityEpoch: () => '7',
    hydrateVisibleCatalogTitlesByIds: async () => {
      if (hydrationFails) throw new Error('visibility epoch moved');
      return [structuredClone(hydratedP)];
    },
    titleAudioLanguages: (row) => Array.isArray(row.audio_languages) ? row.audio_languages : [],
    titleVersionLanguages: (row) => Array.isArray(row.version_languages) ? row.version_languages : [],
    titleAudioTracks: (row) => Array.isArray(row.audio_tracks) ? row.audio_tracks : [],
    stringOrNull: (value) => typeof value === 'string' && value.length ? value : null,
    numberOrNull: (value) => Number.isFinite(Number(value)) ? Number(value) : null,
    isRecord: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    recordOrEmpty: (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {},
  };
  vm.runInNewContext(compiled, sandbox, { filename: 'flat-media-generation-overlay.ts' });
  const runtime = sandbox.module.exports;
  const { sanitizeCatalogMediaItem } = await import(pathToFileURL(PUBLIC_VIEW_PATH).href);

  const run = async (flag) => {
    catalogFlag = flag;
    globalCalls.length = 0;
    const p = {
      id: 'media-b', source_id: 'source-b', item_type: 'movie', external_id: 'stream-100',
      generation_id: generationId,
      title: 'Provider B raw', poster_url: 'https://images.example/provider-b.jpg',
      overview: 'Provider B overview', metadata: { providerTmdbId: '100', categoryName: 'Provider B' },
    };
    const g = {
      id: 'media-g', source_id: 'source-g', item_type: 'movie', external_id: 'stream-200',
      title: 'Provider G raw', metadata: { providerTmdbId: '200' },
    };
    await runtime.attachMediaLanguages([p, g], 'user-1', 'movie', 'fr');
    await runtime.localizeMediaTitles([p, g], 'user-1', 'fr', 'movie');
    return { p, g, publicP: sanitizeCatalogMediaItem(p) };
  };

  const on = await run(true);
  assert.equal(on.p.title, 'Titre B');
  assert.equal(on.p.overview, 'Synopsis B');
  assert.equal(on.p.poster_url, 'https://images.example/b.jpg');
  assert.equal(on.p.runtime, 123);
  assert.equal(on.p.rating, 8.8);
  assert.equal(on.p.metadata.categoryName, 'Provider B');
  assert.equal(on.p.metadata.tmdb.runtime, 123);
  assert.equal(on.g.title, 'Global A/G title');
  assert.equal(on.g.runtime, 96);
  assert.equal(on.g.runtimeMinutes, 96);
  assert.equal(on.g.tmdb.runtime, 96);
  assert.ok(globalCalls.length >= 1, 'G still uses the established global lookup');
  for (const call of globalCalls) assert.deepEqual(call.ids, ['200'], 'P TMDB id must never reach global A');
  const serialized = JSON.stringify(on.publicP);
  for (const forbidden of [
    'generation_id', 'display_generation_id', 'overlay_generation_id',
    'overlay_catalog_metadata', generationId,
  ]) assert.equal(serialized.includes(forbidden), false, `flat P leaked ${forbidden}`);

  const off = await run(false);
  assert.equal(off.p.title, 'Titre B');
  assert.equal(off.p.overview, 'Synopsis B');
  assert.equal(off.p.poster_url, 'https://images.example/b.jpg');
  assert.equal(off.p.metadata.categoryName, 'B provider category');
  assert.equal(off.p.runtime, undefined, 'missing thinned P fields must not be manufactured as zero');
  assert.equal(JSON.stringify(off.p.metadata).includes('runtime'), false);
  assert.equal(JSON.stringify(off.p.metadata).includes('vote_average'), false);
  assert.equal(off.g.title, 'Global A/G title', 'reordered proof binding preserves the legacy G winner');
  assert.equal(off.g.runtime, 96, 'trusted global TMDB runtime remains available with the full overlay disabled');
  assert.equal(off.g.tmdb.runtime, 96);
  assert.equal(globalCalls.length, 1, 'flag OFF keeps only the legacy G text/art lookup');
  assert.deepEqual(globalCalls[0].ids, ['200']);

  hydrationFails = true;
  const failedHydration = await run(true);
  assert.equal(failedHydration.p.title, 'Provider B raw');
  assert.equal(failedHydration.p.poster_url, 'https://images.example/provider-b.jpg');
  assert.equal(failedHydration.p.overview, 'Provider B overview');
  for (const call of globalCalls) assert.deepEqual(call.ids, ['200'],
    'an epoch failure must degrade P to provider B without consulting global A');
  hydrationFails = false;

  const forged = { metadata: { generationId, overlayGenerationId: generationId } };
  assert.equal(runtime.flatMediaBlocksGlobalTitleOverlay(forged), false,
    'provider metadata cannot forge the physical generation fence');

  const listMedia = section(CATALOG, 'async function listMediaItems(', '\n// Flat media rows come directly');
  assert.equal((listMedia.match(/await attachMediaLanguages\(items, userId, itemType, lang\);\s*await localizeMediaTitles\(items, userId, lang, itemType\);/g) || []).length, 2,
    'both fuzzy search and paged grid must bind P before any localization lookup');
});

test('catalog title selector crosses invisible raw pages, hydrates under one epoch, and has no DB-old fallback', async () => {
  const source = section(
    CATALOG,
    'type CatalogTitleSelectorMode',
    '\nasync function listTitleRail(',
  );
  const compiled = transformSync(`${source}\nmodule.exports = {
    selectOrderedCatalogTitleIds,
    hydrateVisibleCatalogTitlesByIds,
  };`, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ids = Array.from({ length: 300 }, (_, index) =>
    `bbbbbbbb-bbbb-4bbb-8bbb-${(index + 1).toString(16).padStart(12, '0')}`);
  const calls = [];
  let selectorPage = 0;
  let missing = false;
  const db = {
    async rpc(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (missing) return { data: null, error: { code: 'PGRST202', message: 'missing RPC' } };
      if (name === 'norva_select_catalog_title_ordered_page') {
        selectorPage += 1;
        if (selectorPage === 1) {
          return {
            data: {
              contract: 'catalog-title-selector-v2', mode: 'home_verified', visibilityEpoch: 7,
              items: [], returnedTitles: 0, inspectedTitles: 900, scanLimit: 900,
              complete: false, nextCursor: { visibilityEpoch: 7, page: 1 },
            },
            error: null,
          };
        }
        return {
          data: {
            contract: 'catalog-title-selector-v2', mode: 'home_verified', visibilityEpoch: 7,
            items: ids.map((id) => ({ id })), returnedTitles: ids.length,
            inspectedTitles: ids.length, scanLimit: 900, complete: true, nextCursor: null,
          },
          error: null,
        };
      }
      assert.equal(name, 'norva_get_visible_catalog_titles_by_ids');
      return {
        data: {
          contract: 'catalog-title-hydration-v3', visibilityEpoch: '7',
          items: args.p_title_ids.map((id) => ({
            id, user_id: userId, variant_count: 1,
            overlay_generation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            display_generation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          })),
        },
        error: null,
      };
    },
  };
  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const sandbox = {
    module: { exports: {} }, exports: {}, db, HttpError,
    latestBoundCatalogVisibilityEpoch: () => '7',
    isRecord: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  };
  vm.runInNewContext(compiled, sandbox, { filename: 'catalog-title-selector.ts' });
  const runtime = sandbox.module.exports;

  const selected = await runtime.selectOrderedCatalogTitleIds(userId, 'movie', 'home_verified', 300);
  assert.deepEqual([...selected], ids);
  const hydrated = await runtime.hydrateVisibleCatalogTitlesByIds(userId, selected);
  assert.equal(hydrated.length, 300);
  assert.deepEqual(calls.map((call) => call.name), [
    'norva_select_catalog_title_ordered_page',
    'norva_select_catalog_title_ordered_page',
    'norva_get_visible_catalog_titles_by_ids',
  ]);
  assert.equal(calls[0].args.p_expected_visibility_epoch, '7');
  assert.equal(calls[2].args.p_expected_visibility_epoch, '7');

  missing = true;
  await assert.rejects(
    runtime.hydrateVisibleCatalogTitlesByIds(userId, [ids[0]]),
    (error) => error && error.status === 503,
  );
  assert.equal(calls.at(-1).name, 'norva_get_visible_catalog_titles_by_ids');
});

test('logical live channels sanitize default, preview, and full variants identically', async () => {
  const { sanitizeLiveCatalogPayload } = await import(pathToFileURL(PUBLIC_VIEW_PATH).href);
  const privateVariant = {
    id: 'source-1:stream-7',
    user_id: 'account-private-id',
    source_id: 'source-1',
    stream_id: 'stream-7',
    external_id: 'stream-7',
    item_type: 'live',
    label: 'HD',
    playback_hint: {
      sourceType: 'm3u',
      streamId: 'stream-7',
      container: 'ts',
      targetUrl: 'https://provider.example/live/provider-user/provider-password/stream-7.ts',
      token: 'provider-token',
    },
    metadata: {
      country: 'FR',
      playbackMode: 'directHls',
      error: 'raw-provider-error',
      providerResponse: { token: 'provider-token' },
    },
  };
  const payload = sanitizeLiveCatalogPayload({
    contract: 'norva.live.logical.v1',
    country: 'FR',
    channels: [{
      id: 'logical-1',
      user_id: 'account-private-id',
      source_id: 'source-1',
      title: 'Channel',
      default_variant: privateVariant,
      variant_preview: [privateVariant],
      variants: [privateVariant],
      playback_hint: privateVariant.playback_hint,
      metadata: { logical: true, error: 'raw-provider-error' },
    }],
    variants: [privateVariant],
  });

  const channel = payload.channels[0];
  assert.equal(channel.source_id, 'source-1');
  assert.equal(channel.default_variant.stream_id, 'stream-7');
  assert.equal(channel.variant_preview[0].stream_id, 'stream-7');
  assert.equal(channel.variants[0].stream_id, 'stream-7');
  assert.deepEqual(channel.default_variant.playback_hint, {
    sourceType: 'm3u',
    streamId: 'stream-7',
    container: 'ts',
  });

  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    'user_id',
    'account-private-id',
    'targetUrl',
    'provider-user',
    'provider-password',
    'provider-token',
    'raw-provider-error',
    'providerResponse',
    'playbackMode',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `live payload leaked ${forbidden}`);
  }
});

test('user and paired-device catalog routes share the same success projection', () => {
  assert.match(CATALOG, /sanitizeCatalogMediaPayload,[\s\S]*sanitizeLiveCatalogPayload/);
  assert.match(
    CATALOG,
    /segments\[0\] === "media-items" \|\| \(segments\[0\] === "device"[\s\S]{0,300}sanitizeCatalogMediaPayload\(await listMediaItems/,
  );
  assert.match(
    CATALOG,
    /isLiveLogicalChannelsRoute\(segments\)[\s\S]{0,220}sanitizeLiveCatalogPayload\(await listLiveLogicalChannels/,
  );
  assert.match(
    CATALOG,
    /isLiveChannelVariantsRoute\(segments\)[\s\S]{0,300}sanitizeLiveCatalogPayload\([\s\S]*listLiveChannelVariants/,
  );
});

test('authenticated catalog HTTP responses cannot remain browser-fresh across an idle cutover', () => {
  const cached = section(CATALOG, 'function jsonCached(', '\nfunction corsHeaders(');
  assert.match(cached, /"Cache-Control": "private, no-store, max-age=0"/);
  assert.match(cached, /"Pragma": "no-cache"/);
  assert.doesNotMatch(cached, /stale-while-revalidate|private, max-age=/);

  const catalogRequest = section(CLIENT, 'async function catalogRequest(', '\n    async function catalogMutate(');
  assert.match(catalogRequest, /_visibilityForceNoStore: true/);
  assert.match(catalogRequest, /requestToBase\(catalogBase\(\), 'GET', route, null, catalogOptions\)/);
  assert.match(catalogRequest, /request\('GET', route, null, catalogOptions\)/);

  const facets = section(CATALOG, 'async function listLanguageFacets(', '\nasync function recordObservedLanguages(');
  assert.match(facets, /boundCatalogCacheEpoch\(req\)/);
  assert.match(facets, /`\$\{userId\}:\$\{cacheEpoch\}:\$\{itemType\}:\$\{sourceId \|\| "all"\}`/);

  const progress = section(CATALOG, 'async function getEnrichmentProgress(', '\n// ==================== TMDB extras');
  assert.match(progress, /boundCatalogCacheEpoch\(req\)/);
  assert.match(progress, /`\$\{userId\}:\$\{cacheEpoch\}`/);

  const sourceContext = section(CATALOG, 'async function sourceCatalogContextFor(', '\nasync function sourceHealthFor(');
  assert.match(sourceContext, /latestBoundCatalogCacheEpoch\(userId\)/);
  assert.match(sourceContext, /`\$\{userId\}:\$\{cacheEpoch\}`/);
  assert.match(sourceContext, /key\.startsWith\(`\$\{userId\}:`\)/);
  assert.match(sourceContext, /SOURCE_CATALOG_CONTEXT_CACHE_MAX/);
});
