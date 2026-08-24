'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('title projection checks visibility before shared or global catalog writes', () => {
  const source = read('supabase/functions/_shared/vod-title-projection.ts');
  const projection = source.slice(
    source.indexOf('export async function refreshVodTitleProjection('),
    source.indexOf('type ProviderIds'),
  );
  const guard = projection.indexOf('norva_source_catalog_visible');
  const provider = projection.indexOf('loadVodInfoIds(');
  const userTitles = projection.indexOf('.from("cloud_titles")');
  const globalTitles = projection.indexOf('.from("catalog_titles")');

  assert.ok(guard >= 0 && provider > guard, 'visibility must precede provider metadata calls');
  assert.ok(userTitles > guard && globalTitles > guard, 'visibility must precede every shared projection write');
  assert.match(projection, /catalogVisible !== true[\s\S]*skipped: "source_not_catalog_visible"/);
});

test('background selectors and continuations use the centralized visible-source boundary', () => {
  const source = read('supabase/functions/norva-source-sync/index.ts');

  for (const functionName of ['cronRefreshDue', 'cronResumeStuck', 'cronFinalizeSource', 'admitHeavyImport']) {
    const start = source.indexOf(`async function ${functionName}(`);
    assert.notEqual(start, -1, `missing ${functionName}`);
    const next = source.indexOf('\nasync function ', start + 1);
    const block = source.slice(start, next < 0 ? source.length : next);
    assert.match(block, /\.from\("cloud_catalog_visible_sources"\)/, `${functionName} must select visible sources`);
  }

  const claim = source.slice(
    source.indexOf('async function runEnrichmentFleetClaim('),
    source.indexOf('async function cronEnrichmentFleet('),
  );
  assert.match(claim, /sourceCatalogVisible\(claim\.source_id, claim\.user_id, db\)/);
  assert.ok(
    claim.indexOf('sourceCatalogVisible(') < claim.indexOf('await fetch('),
    'fleet visibility must be checked before provider/playback dispatch',
  );

  const sync = source.slice(source.indexOf('async function syncCloudSource('), source.indexOf('function runInBackground('));
  assert.match(sync, /await assertCatalogVisible\(sourceId, userId, db\)/);

  const cloud = read('supabase/functions/norva-cloud/index.ts');
  for (const functionName of ['syncExistingSource', 'hardSyncSource']) {
    const start = cloud.indexOf(`async function ${functionName}(`);
    const next = cloud.indexOf('\nasync function ', start + 1);
    const block = cloud.slice(start, next < 0 ? cloud.length : next);
    assert.match(block, /await assertVisibleSource\(id, userId, db\)/);
  }
});

test('background title enrichment uses the head-aware selector and fenced writer without direct fallback', () => {
  const source = read('supabase/functions/norva-source-sync/index.ts');
  const helpers = source.slice(
    source.indexOf('type CatalogBackgroundPage'),
    source.indexOf('// Provider VOD/series lists carry no release year'),
  );
  const blocks = {
    years: source.slice(
      source.indexOf('async function cronBackfillYears('),
      source.indexOf('// Re-validate titles', source.indexOf('async function cronBackfillYears(')),
    ),
    revalidate: source.slice(
      source.indexOf('async function cronRevalidate('),
      source.indexOf('// Pre-warm the GLOBAL', source.indexOf('async function cronRevalidate(')),
    ),
    search: source.slice(
      source.indexOf('async function cronSearchMatch('),
      source.indexOf('\nasync function ', source.indexOf('async function cronSearchMatch(') + 1),
    ),
  };

  assert.match(helpers, /db\.rpc\("norva_select_catalog_title_background_page"/);
  assert.match(helpers, /db\.rpc\("norva_apply_catalog_title_background_result"/);
  for (const [name, block] of Object.entries(blocks)) {
    assert.match(block, /selectCatalogBackgroundBatch\(/, `${name} must use the head-aware RPC selector`);
    assert.match(block, /applyCatalogBackgroundOutcomes\(/, `${name} must use the fenced RPC writer`);
    assert.doesNotMatch(block, /\.from\("cloud_catalog_visible_titles"\)/);
    assert.doesNotMatch(block, /\.from\("cloud_titles"\)/);
    assert.doesNotMatch(block, /\.from\("catalog_titles"\)\.upsert/);
  }
  assert.match(helpers, /p_expected_visibility_epoch: expectedVisibilityEpoch/);
  assert.match(helpers, /p_expected_payload_updated_at: item\.payloadUpdatedAt/);
  assert.match(helpers, /p_expected_display_generation_id: item\.displayGenerationId/);
  assert.match(helpers, /if \(isCatalogBackgroundCasConflict\(error\)\) return null/);
});

test('background selector walk continues across empty pages until explicit complete and stays bounded', async () => {
  const source = read('supabase/functions/norva-source-sync/index.ts');
  const start = source.indexOf('const CATALOG_BACKGROUND_PAGE_MAX');
  const end = source.indexOf('// Provider VOD/series lists carry no release year', start);
  assert.ok(start >= 0 && end > start);
  const compiled = transformSync(
    `${source.slice(start, end)}\nmodule.exports = walkCatalogTitleBackgroundPages;`,
    { loader: 'ts', format: 'cjs', target: 'es2022' },
  ).code;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    isRecord: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  };
  vm.runInNewContext(compiled, sandbox, { filename: 'norva-source-sync/background-page-walk.ts' });
  const walk = sandbox.module.exports;

  const cursors = [];
  const pages = [
    { items: [], complete: false, nextCursor: { lastId: 'shell-only' } },
    { items: [{ id: 'effective-p' }], complete: false, nextCursor: { lastId: 'effective-p' } },
    { items: [], complete: true, nextCursor: null },
  ];
  const completed = await walk(async (cursor, remaining) => {
    cursors.push({ cursor: structuredClone(cursor), remaining });
    return pages.shift();
  }, 5, { now: () => 0 });
  assert.deepEqual(structuredClone(completed), {
    items: [{ id: 'effective-p' }], complete: true, nextCursor: null, pages: 3,
  });
  assert.deepEqual(cursors, [
    { cursor: null, remaining: 5 },
    { cursor: { lastId: 'shell-only' }, remaining: 5 },
    { cursor: { lastId: 'effective-p' }, remaining: 4 },
  ]);

  let calls = 0;
  const bounded = await walk(async (_cursor, remaining) => ({
    items: [],
    complete: false,
    nextCursor: { lastId: String(++calls), remaining },
  }), 5, { maxPages: 2, now: () => 0 });
  assert.deepEqual(structuredClone(bounded), {
    items: [], complete: false, nextCursor: { lastId: '2', remaining: 5 }, pages: 2,
  });
  assert.equal(calls, 2);

  await assert.rejects(
    walk(async () => ({ items: [], complete: false, nextCursor: { lastId: 'same' } }), 1, {
      maxPages: 2,
      now: () => 0,
    }),
    /made no cursor progress/,
  );
});

test('background RPC path rolls its own epoch, rejects an interleaved transition, and never falls back', async () => {
  const source = read('supabase/functions/norva-source-sync/index.ts');
  const start = source.indexOf('const CATALOG_BACKGROUND_PAGE_MAX');
  const end = source.indexOf('// Provider VOD/series lists carry no release year', start);
  const compiled = transformSync(
    `${source.slice(start, end)}\nmodule.exports = {
      selectCatalogBackgroundBatch,
      applyCatalogBackgroundOutcomes,
    };`,
    { loader: 'ts', format: 'cjs', target: 'es2022' },
  ).code;
  class HttpError extends Error {
    constructor(status, message, details) { super(message); this.status = status; this.details = details; }
  }
  const sandbox = {
    module: { exports: {} }, exports: {}, HttpError,
    isRecord: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    recordOrEmpty: (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {},
    stringOr: (value, fallback) => typeof value === 'string' && value ? value : fallback,
    stringOrNull: (value) => typeof value === 'string' && value ? value : null,
  };
  vm.runInNewContext(compiled, sandbox, { filename: 'norva-source-sync/background-rpc.ts' });
  const runtime = sandbox.module.exports;
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const items = [1, 2].map((n) => ({
    id: `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`,
    userId,
    itemType: 'movie',
    providerTmdbId: String(n),
    title: `Title ${n}`,
    originalTitle: null,
    releaseYear: null,
    metadata: {},
    posterUrl: null,
    backdropUrl: null,
    storageKind: 'projection',
    visibilityEpoch: '7',
    payloadUpdatedAt: '2026-08-23T00:00:00.000Z',
    bestGenerationId: generationId,
    displayGenerationId: generationId,
  }));
  const writerCalls = [];
  const db = {
    from() { throw new Error('direct table fallback is forbidden'); },
    async rpc(name, args) {
      assert.equal(name, 'norva_apply_catalog_title_background_result');
      writerCalls.push(structuredClone(args));
      if (writerCalls.length === 2) {
        return { data: null, error: { code: '40001', details: 'must stay private' } };
      }
      return {
        data: {
          contract: 'catalog-title-background-writer-v3', mode: 'year_pending',
          titleId: args.p_title_id, storageKind: 'projection', visibilityEpoch: '8',
          applied: true, matched: true, visibleChanged: true,
        },
        error: null,
      };
    },
  };
  const summary = await runtime.applyCatalogBackgroundOutcomes(
    db, 'year_pending', items, [{ releaseYear: 2020 }, { releaseYear: 2021 }], 4,
  );
  assert.deepEqual({ ...summary }, { applied: 1, matched: 1, visibleChanged: 1, stale: 1 });
  assert.equal(writerCalls[0].p_expected_visibility_epoch, '7');
  assert.equal(writerCalls[1].p_expected_visibility_epoch, '8', 'the writer-returned epoch must fence the next item');
  assert.equal(JSON.stringify(summary).includes('must stay private'), false);

  const missingDb = {
    from() { throw new Error('direct table fallback is forbidden'); },
    async rpc() { return { data: null, error: { code: 'PGRST202', details: 'private schema detail' } }; },
  };
  await assert.rejects(
    runtime.selectCatalogBackgroundBatch(
      missingDb, 'year_pending', 1, '2026-01-01T00:00:00.000Z', null,
    ),
    (error) => error && error.status === 503 && !String(error.message).includes('schema'),
  );
});

test('year enrichment runtime sends only the selected P/G payload through the CAS writer', async () => {
  const source = read('supabase/functions/norva-source-sync/index.ts');
  const start = source.indexOf('async function cronBackfillYears(');
  const end = source.indexOf('// Re-validate titles', start);
  assert.ok(start >= 0 && end > start);
  const compiled = transformSync(
    `${source.slice(start, end)}\nmodule.exports = cronBackfillYears;`,
    { loader: 'ts', format: 'cjs', target: 'es2022' },
  ).code;

  const activeA = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    itemType: 'movie',
    providerTmdbId: '42',
    visibilityEpoch: '7',
  };
  const candidateB = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    userId: activeA.userId,
    itemType: 'movie',
    providerTmdbId: '42',
    visibilityEpoch: '7',
  };
  const appliedItems = [];
  const stateUpdates = [];
  const db = {
    from(table) {
      const chain = {
        update(payload) { stateUpdates.push({ table, payload }); return chain; },
        eq() { return chain; },
        then(resolve, reject) {
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    tmdbApiKey: () => 'tmdb-key',
    fetchTmdbYear: async () => 2024,
    stringOr: (value, fallback) => typeof value === 'string' && value ? value : fallback,
    selectCatalogBackgroundBatch: async () => ({
      items: [activeA], complete: true, nextCursor: null, pages: 1,
    }),
    applyCatalogBackgroundOutcomes: async (_db, mode, items, outcomes) => {
      assert.equal(mode, 'year_pending');
      appliedItems.push(...items);
      assert.deepEqual(JSON.parse(JSON.stringify(outcomes)), [{ releaseYear: 2024 }]);
      return { applied: 1, matched: 1, visibleChanged: 1, stale: 0 };
    },
    lastIdFromCatalogBackgroundCursor: () => null,
    HttpError: class HttpError extends Error {},
  };
  vm.runInNewContext(compiled, sandbox, { filename: 'norva-source-sync/year-visible-only.ts' });
  const result = await sandbox.module.exports(db, 10, true, 2);

  assert.equal(result.scanned, 1);
  assert.equal(result.updated, 1);
  assert.deepEqual(appliedItems, [activeA]);
  assert.equal(appliedItems.some((item) => item.id === candidateB.id), false);
  assert.equal(stateUpdates.length, 1);
  assert.equal(stateUpdates[0].table, 'norva_year_backfill_state');
});

test('operator source-error reporting retains hidden and staging failures', () => {
  const source = read('supabase/functions/norva-admin/index.ts');
  const block = source.slice(
    source.indexOf('async function collectOpsSourceErrors('),
    source.indexOf('\nasync function ', source.indexOf('async function collectOpsSourceErrors(') + 1),
  );
  // This is a service-role operations signal, not a user-facing catalog read:
  // hiding staging/replaced failures here would blind the operator precisely
  // when a transition needs intervention.
  assert.match(block, /Operator health must include hidden\/staging\/replaced sources/);
  assert.match(block, /\.from\("cloud_sources"\)/);
  assert.doesNotMatch(block, /\.from\("cloud_catalog_visible_sources"\)/);
});

test('staging imports cannot enqueue user-facing import lifecycle notifications', () => {
  const source = read('supabase/functions/_shared/xtream-sync.ts');
  const enqueue = source.slice(
    source.indexOf('export async function enqueueImportNotification('),
    source.indexOf('export async function recordProviderIdentity('),
  );
  const guard = enqueue.indexOf('norva_source_catalog_visible');
  const queueWrite = enqueue.indexOf('.from("cloud_import_notifications")');
  const adminWrite = enqueue.indexOf('.from("admin_events")');

  assert.ok(guard >= 0 && queueWrite > guard && adminWrite > guard);
  assert.match(enqueue, /visibilityError \|\| catalogVisible !== true\) return/);
});
