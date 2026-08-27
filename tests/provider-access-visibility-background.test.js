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

  const refreshStart = source.indexOf('async function cronRefreshDue(');
  const refreshNext = source.indexOf('\nasync function ', refreshStart + 1);
  const refresh = source.slice(refreshStart, refreshNext < 0 ? source.length : refreshNext);
  assert.match(refresh, /db\.rpc\("norva_claim_cloud_auto_refresh_sources"/);
  const refreshClaim = read('supabase/migrations/20260827033406_provider_auto_refresh_fair_claim_v1.sql');
  assert.match(refreshClaim, /public\.norva_source_catalog_visible_internal\(source\.id, source\.user_id\)/);

  for (const functionName of ['cronResumeStuck', 'cronFinalizeSource', 'admitHeavyImport']) {
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
    source.indexOf('const CATALOG_BACKGROUND_LEASE_SECONDS'),
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

  assert.match(helpers, /db\.rpc\("norva_claim_catalog_title_background_mode"/);
  assert.match(helpers, /db\.rpc\("norva_select_catalog_title_background_claim_page"/);
  assert.match(helpers, /db\.rpc\("norva_ack_catalog_title_background_claim_page"/);
  assert.match(helpers, /db\.rpc\("norva_apply_catalog_title_background_result"/);
  assert.doesNotMatch(helpers, /norva_select_catalog_title_background_page"/);
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
  assert.match(helpers, /p_processed_title_ids: processedTitleIds/);
});

test('durable background selector advances empty checkpoint transitions and stays bounded', async () => {
  const source = read('supabase/functions/norva-source-sync/index.ts');
  const start = source.indexOf('const CATALOG_BACKGROUND_LEASE_SECONDS');
  const end = source.indexOf('// Provider VOD/series lists carry no release year', start);
  assert.ok(start >= 0 && end > start);
  const compiled = transformSync(
    `${source.slice(start, end)}\nmodule.exports = selectCatalogBackgroundBatch;`,
    { loader: 'ts', format: 'cjs', target: 'es2022' },
  ).code;
  class HttpError extends Error {
    constructor(status, message, details) { super(message); this.status = status; this.details = details; }
  }
  const sandbox = {
    module: { exports: {} },
    exports: {},
    HttpError,
    isRecord: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    recordOrEmpty: (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {},
    stringOr: (value, fallback) => typeof value === 'string' && value ? value : fallback,
    stringOrNull: (value) => typeof value === 'string' && value ? value : null,
    crypto: { randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  };
  vm.runInNewContext(compiled, sandbox, { filename: 'norva-source-sync/background-claim-page.ts' });
  const select = sandbox.module.exports;
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const titleId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const worker = 'edge-year-test';
  const revisions = [];
  const pages = [
    {
      contract: 'catalog-title-background-mode-v1', mode: 'year_pending',
      items: [], returnedTitles: 0, complete: false, checkpointRevision: 2,
    },
    {
      contract: 'catalog-title-background-mode-v1', mode: 'year_pending',
      items: [{
        id: titleId, userId, itemType: 'movie', providerTmdbId: '42', title: 'Title',
        originalTitle: null, releaseYear: null, metadata: {}, posterUrl: null,
        backdropUrl: null, storageKind: 'global', visibilityEpoch: 7,
        payloadUpdatedAt: '2026-08-23T00:00:00.000Z', bestGenerationId: null,
        displayGenerationId: null,
      }],
      returnedTitles: 1, byteCount: 512, complete: false, ackRequired: true,
      pageDigest: 'a'.repeat(64), checkpointRevision: 3,
    },
  ];
  const db = { async rpc(name, args) {
    assert.equal(name, 'norva_select_catalog_title_background_claim_page');
    revisions.push(String(args.p_expected_revision));
    return { data: pages.shift(), error: null };
  } };
  const completed = await select(db, 'year_pending', 5, {
    worker, leaseSequence: 1, checkpointRevision: '1',
    retryBefore: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(completed.items.length, 1);
  assert.equal(completed.items[0].id, titleId);
  assert.equal(completed.checkpointRevision, '3');
  assert.equal(completed.emptyTransitions, 1);
  assert.deepEqual(revisions, ['1', '2']);

  let calls = 0;
  const boundedDb = { async rpc() {
    calls += 1;
    return { data: {
      contract: 'catalog-title-background-mode-v1', mode: 'year_pending',
      items: [], returnedTitles: 0, complete: false, checkpointRevision: calls + 1,
    }, error: null };
  } };
  const bounded = await select(boundedDb, 'year_pending', 5, {
    worker, leaseSequence: 1, checkpointRevision: '1',
    retryBefore: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(calls, 16);
  assert.equal(bounded.items.length, 0);
  assert.equal(bounded.complete, false);
  assert.equal(bounded.checkpointRevision, '17');
  assert.equal(bounded.emptyTransitions, 16);
});

test('background RPC path rolls its own epoch, rejects an interleaved transition, and never falls back', async () => {
  const source = read('supabase/functions/norva-source-sync/index.ts');
  const start = source.indexOf('const CATALOG_BACKGROUND_LEASE_SECONDS');
  const end = source.indexOf('// Provider VOD/series lists carry no release year', start);
  const compiled = transformSync(
    `${source.slice(start, end)}\nmodule.exports = {
      selectCatalogBackgroundBatch,
      applyCatalogBackgroundOutcomes,
      ackCatalogBackgroundBatch,
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
    isStaleDatabaseConflict: (error) => ['PT409', '40001'].includes(String(error?.code ?? '').toUpperCase()),
    crypto: { randomUUID: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
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
      if (name === 'norva_ack_catalog_title_background_claim_page') {
        assert.deepEqual([...args.p_processed_title_ids], [items[0].id]);
        return { data: {
          contract: 'catalog-title-background-mode-v1', mode: 'year_pending',
          complete: false, acknowledgedTitles: 1, remainingTitles: 1,
          checkpointRevision: 4,
        }, error: null };
      }
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
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
    applied: 1, matched: 1, visibleChanged: 1, stale: 1,
    processedTitleIds: [items[0].id],
  });
  assert.equal(writerCalls[0].p_expected_visibility_epoch, '7');
  assert.equal(writerCalls[1].p_expected_visibility_epoch, '8', 'the writer-returned epoch must fence the next item');
  assert.equal(JSON.stringify(summary).includes('must stay private'), false);
  const ack = await runtime.ackCatalogBackgroundBatch(
    db,
    'year_pending',
    { worker: 'edge-year-test', leaseSequence: 2, checkpointRevision: '2', retryBefore: '2026-01-01T00:00:00.000Z' },
    { items, complete: false, ackRequired: true, pageDigest: 'a'.repeat(64), checkpointRevision: '3', emptyTransitions: 0 },
    summary.processedTitleIds,
  );
  assert.deepEqual({ ...ack }, {
    complete: false, checkpointRevision: '4', acknowledgedTitles: 1, remainingTitles: 1,
  });

  const missingDb = {
    from() { throw new Error('direct table fallback is forbidden'); },
    async rpc() { return { data: null, error: { code: 'PGRST202', details: 'private schema detail' } }; },
  };
  await assert.rejects(
    runtime.selectCatalogBackgroundBatch(
      missingDb, 'year_pending', 1,
      { worker: 'edge-year-test', leaseSequence: 1, checkpointRevision: '1', retryBefore: '2026-01-01T00:00:00.000Z' },
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
  const activeC = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    userId: activeA.userId,
    itemType: 'movie',
    providerTmdbId: '43',
    visibilityEpoch: '8',
  };
  const appliedItems = [];
  const db = {};
  const claim = {
    worker: 'edge-year-test', leaseSequence: 1, checkpointRevision: '1',
    retryBefore: '2026-01-01T00:00:00.000Z',
  };
  let selectedCalls = 0;
  let ackCalls = 0;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    tmdbApiKey: () => 'tmdb-key',
    fetchTmdbYear: async () => 2024,
    stringOr: (value, fallback) => typeof value === 'string' && value ? value : fallback,
    claimCatalogBackgroundMode: async () => claim,
    selectCatalogBackgroundBatch: async () => {
      selectedCalls += 1;
      return {
        items: [selectedCalls === 1 ? activeA : activeC], complete: false, ackRequired: true,
        pageDigest: String(selectedCalls).repeat(64), checkpointRevision: String(selectedCalls * 2),
        emptyTransitions: 0,
      };
    },
    applyCatalogBackgroundOutcomes: async (_db, mode, items, outcomes) => {
      assert.equal(mode, 'year_pending');
      appliedItems.push(...items);
      assert.deepEqual(JSON.parse(JSON.stringify(outcomes)), [{ releaseYear: 2024 }]);
      return { applied: 1, matched: 1, visibleChanged: 1, stale: 0, processedTitleIds: [items[0].id] };
    },
    ackCatalogBackgroundBatch: async (_db, mode, actualClaim, batch, processedTitleIds) => {
      ackCalls += 1;
      assert.equal(mode, 'year_pending');
      assert.equal(actualClaim, claim);
      assert.equal(batch.checkpointRevision, String(ackCalls * 2));
      assert.deepEqual(processedTitleIds, [ackCalls === 1 ? activeA.id : activeC.id]);
      return {
        complete: ackCalls === 2,
        checkpointRevision: String(ackCalls * 2 + 1),
        acknowledgedTitles: 1,
        remainingTitles: 0,
      };
    },
    CATALOG_BACKGROUND_DRAIN_DEADLINE_MS: 45_000,
    CATALOG_BACKGROUND_PAGE_LIMIT: 100,
    HttpError: class HttpError extends Error {},
  };
  vm.runInNewContext(compiled, sandbox, { filename: 'norva-source-sync/year-visible-only.ts' });
  const result = await sandbox.module.exports(db, 2, true, 2);

  assert.equal(result.scanned, 2);
  assert.equal(result.updated, 2);
  assert.equal(result.acknowledged, 2);
  assert.equal(result.checkpointRevision, '5');
  assert.equal(result.done, true);
  assert.deepEqual(appliedItems, [activeA, activeC]);
  assert.equal(appliedItems.some((item) => item.id === candidateB.id), false);
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
