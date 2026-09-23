'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');
const { importTypescriptModule } = require('./helpers/import-typescript-module');

const root = path.resolve(__dirname, '..');
const shared = importTypescriptModule(path.join(root, 'supabase/functions/_shared/live-materialization.ts'));
const generationModule = importTypescriptModule(path.join(root, 'supabase/functions/_shared/catalog-generation.ts'));
const generation = {
  kind: 'active', generationId: '11111111-1111-4111-8111-111111111111',
  headRevision: '1', configRevision: '1', sourceVisibilityEpoch: '1', userVisibilityEpoch: '1',
};
const rows = (count) => Array.from({ length: count }, (_, i) => ({
  id: `item-${i}`, source_id: 'source', user_id: 'owner', item_type: 'live',
  external_id: String(i + 1), title: `FR | QA CHANNEL ${i + 1} HD`,
  available: true, metadata: {}, playback_hint: { streamId: String(i + 1) },
}));

function database({ failVariants = false } = {}) {
  const writes = [];
  return { writes,
    rpc: async () => ({ data: [], error: null }),
    from: table => ({ upsert: (values, options) => {
      writes.push({ table, values, options });
      const result = failVariants && table === 'cloud_live_variants'
        ? { error: { message: 'lost database connection' } }
        : { data: values.map(v => ({ ...v, id: `channel:${v.logical_id}` })), error: null };
      return { select: async () => result, then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
    } }),
  };
}

test('200-channel page persists every variant with a generation check per SQL write', async () => {
  const { materializeLiveChunk } = await shared;
  const db = database(); let checks = 0;
  const result = await materializeLiveChunk(db, {
    sourceId: 'source', userId: 'owner', rows: rows(200), country: 'FR', generation,
    writeBatchSize: 100, withCurrentGeneration: async operation => { checks++; return operation(); },
  });
  assert.equal(result.rawLive, 200);
  assert.equal(result.liveVariants, 200);
  assert.equal(checks, 4);
  for (const write of db.writes) {
    assert.ok(write.values.length <= 100);
    assert.ok(write.values.every(v => v.generation_id === generation.generationId && v.source_id === 'source' && v.user_id === 'owner'));
  }
  const variants = db.writes.filter(w => w.table === 'cloud_live_variants').flatMap(w => w.values);
  assert.equal(new Set(variants.map(v => v.stream_id)).size, 200);
  assert.ok(variants.every(v => v.logical_channel_id));
});

test('a failed variant write rejects the page instead of acknowledging partial completion', async () => {
  const { materializeLiveChunk } = await shared;
  await assert.rejects(materializeLiveChunk(database({ failVariants: true }), {
    sourceId: 'source', userId: 'owner', rows: rows(200), generation, writeBatchSize: 100,
  }), /lost database connection/);
});

test('generation revocation between channel and variant writes prevents the second write', async () => {
  const { materializeLiveChunk } = await shared;
  const db = database(); let calls = 0;
  await assert.rejects(materializeLiveChunk(db, {
    sourceId: 'source', userId: 'owner', rows: rows(200), generation, writeBatchSize: 100,
    withCurrentGeneration: async operation => {
      if (++calls === 2) throw Error('generation revoked');
      return operation();
    },
  }), /generation revoked/);
  assert.equal(db.writes.filter(w => w.table === 'cloud_live_variants').length, 0);
});

test('concurrent import epoch changes and each committed write preserve all 200 live variants', async () => {
  const { materializeLiveChunk } = await shared;
  const { withActiveCatalogEpochRetry } = await generationModule;
  const expected = { ...generation };
  const current = { ...generation, isCatalogVisible: true };
  const variants = new Set(); let writes = 0;
  const db = {
    rpc: async name => ({ data: name === 'norva_get_catalog_write_snapshot' ? { ...current } : [], error: null }),
    from: table => ({ upsert: values => {
      writes++;
      // Another source commits after our snapshot but before the first variant write.
      if (writes === 3) current.userVisibilityEpoch = String(Number(current.userVisibilityEpoch) + 1);
      const stale = values.some(v => v.write_user_visibility_epoch !== current.userVisibilityEpoch);
      const result = stale ? { error: { code: '40001', message: 'active catalog write proof is stale or missing' } }
        : { data: values.map(v => ({ ...v, id: `channel:${v.logical_id}` })), error: null };
      if (!stale) {
        if (table === 'cloud_live_variants') values.forEach(v => variants.add(v.stream_id));
        current.userVisibilityEpoch = String(Number(current.userVisibilityEpoch) + 1);
      }
      return { select: async () => result, then: resolve => Promise.resolve(result).then(resolve) };
    } }),
  };
  const result = await materializeLiveChunk(db, {
    sourceId: 'source', userId: 'owner', rows: rows(200), generation: expected, writeBatchSize: 100,
    withCurrentGeneration: operation => withActiveCatalogEpochRetry(db, 'source', 'owner', expected, operation),
  });
  assert.equal(result.liveVariants, 200);
  assert.equal(variants.size, 200);
  assert.equal(writes, 5, 'one conflict adds exactly one retry');
  assert.equal(expected.userVisibilityEpoch, current.userVisibilityEpoch);
});

test('epoch retry rejects changed authority, regressed epochs and hidden sources', async () => {
  const { withActiveCatalogEpochRetry } = await generationModule;
  const changes = [
    { generationId: '22222222-2222-4222-8222-222222222222' }, { headRevision: '2' },
    { configRevision: '2' }, { sourceVisibilityEpoch: '2' },
    { userVisibilityEpoch: '1' }, { isCatalogVisible: false },
  ];
  for (const change of changes) {
    let snapshots = 0, writes = 0;
    const expected = { ...generation, userVisibilityEpoch: '2' };
    const db = { rpc: async () => ({ data: {
      ...expected, isCatalogVisible: true, ...(snapshots++ ? change : {}),
    }, error: null }) };
    await assert.rejects(withActiveCatalogEpochRetry(db, 'source', 'owner', expected, async () => {
      writes++; throw Object.assign(Error('stale write'), { code: '40001' });
    }), { code: 'CATALOG_GENERATION_SUPERSEDED' });
    assert.equal(writes, 1, 'revoked authority must never be retried');
  }
});

test('epoch recovery does not retry unchanged snapshots, unrelated errors or more than once', async () => {
  const { withActiveCatalogEpochRetry } = await generationModule;
  for (const scenario of [
    { code: '40001', advance: false, attempts: 1 },
    { code: '42501', advance: true, attempts: 1 },
    { code: '08006', advance: true, attempts: 1 },
    { code: '40001', advance: true, attempts: 2 },
    { code: 'PT409', advance: true, attempts: 2 },
  ]) {
    let snapshots = 0, writes = 0;
    const expected = { ...generation };
    const db = { rpc: async () => ({ data: {
      ...generation, isCatalogVisible: true,
      userVisibilityEpoch: scenario.advance ? String(++snapshots) : '1',
    }, error: null }) };
    const failure = Object.assign(Error('write refused'), { code: scenario.code });
    await assert.rejects(withActiveCatalogEpochRetry(db, 'source', 'owner', expected, async () => {
      writes++; throw failure;
    }), error => error === failure);
    assert.equal(writes, scenario.attempts);
  }
});

// Execute the real finalizer's live branch. Its cursor must advance by committed
// raw rows, including a short last page, and remain unchanged after a failed page.
function finalizer(loadPage, materialize) {
  const file = process.env.NORVA_SOURCE_SYNC_TEST_FILE || path.join(root, 'supabase/functions/norva-source-sync/index.ts');
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('async function finalizeCloudSource(');
  const end = source.indexOf('\nfunction normalizeFinalizePhase(', start);
  assert.ok(start >= 0 && end > start);
  const script = transformSync(source.slice(start, end), { loader: 'ts', target: 'node20' }).code;
  const sourceRow = { source_type: 'xtream', config_hint: { syncProgress: {} }, config_ciphertext: null };
  const query = { select: () => query, eq: () => query, update: () => query,
    maybeSingle: async () => ({ data: sourceRow }), then: resolve => resolve({ error: null }) };
  const noOp = async () => {};
  const values = {
    assertCatalogVisible: noOp, readCatalogAccessSnapshot: async () => generation,
    registerM3uEpochSnapshot: () => {}, assertCatalogSnapshotCurrent: noOp,
    recordOrEmpty: v => v || {}, stringOr: (v, fallback) => v || fallback,
    normalizeFinalizePhase: value => value, usesLegacyLiveFirstFinalize: () => false,
    compactRecord: v => v, mergeSyncProgress: (a, b) => ({ ...a, ...b }),
    finalizePhaseStage: () => 'building_live_channels', finalizePhasePercent: () => 91,
    countSourceItems: async () => ({ total: 240, movies: 0, series: 0, live: 240, categories: { total: 1 } }),
    writeSourceSyncProgress: noOp, loadSourceItems: async (...args) => loadPage(args.at(-1)),
    materializeLiveChunk: materialize, isCatalogAccessGuardError: () => false,
    formatSourceSyncError: e => e.message, HttpError: class extends Error {},
  };
  const fn = Function(...Object.keys(values), `${script}; return finalizeCloudSource;`)(...Object.values(values));
  return options => fn('source', 'owner', { from: () => query }, options);
}

test('finalizer resumes an existing offset with 200 rows and preserves the short final page', async () => {
  const pageOptions = [];
  const run = finalizer(options => {
    pageOptions.push(options); return rows(options.offset === 10 ? 200 : 30);
  }, async (_db, input) => {
    assert.equal(input.writeBatchSize, 100);
    return { rawLive: input.rows.length, liveVariants: input.rows.length };
  });
  const first = await run({ phase: 'live', offset: 10 });
  assert.equal(first.nextOffset, 210);
  const last = await run({ phase: 'live', offset: first.nextOffset });
  assert.equal(last.nextOffset, 240);
  assert.deepEqual(pageOptions.map(p => [p.offset, p.limit]), [[10, 200], [210, 200]]);
});

test('finalizer rejects failed materialization without returning an advanced cursor', async () => {
  const run = finalizer(() => rows(200), async () => { throw Error('write failed'); });
  await assert.rejects(run({ phase: 'live', offset: 10 }), /write failed/);
});

test('an exhausted live page advances to completion only after the EOF read', async () => {
  let writes = 0;
  const run = finalizer(() => [], async () => { writes++; });
  const result = await run({ phase: 'live', offset: 240 });
  assert.equal(result.nextPhase, 'complete');
  assert.equal(writes, 0);
});
