'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SHARED = path.join(ROOT, 'supabase', 'functions', '_shared');
const ONLINE_ROLLOUT_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260823180000_provider_catalog_generation_online_rollout.sql',
);
const LIVE_SUMMARY_RPC_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260825024944_live_channel_summary_rpc_v1.sql',
);
const WRITER_PATHS = [
  path.join(SHARED, 'xtream-sync.ts'),
  path.join(SHARED, 'live-materialization.ts'),
  path.join(SHARED, 'vod-title-projection.ts'),
  path.join(ROOT, 'supabase', 'functions', 'norva-cloud', 'index.ts'),
  path.join(ROOT, 'supabase', 'functions', 'norva-source-sync', 'index.ts'),
  path.join(ROOT, 'supabase', 'functions', 'norva-playback', 'index.ts'),
  path.join(ROOT, 'supabase', 'functions', 'norva-series-info', 'index.ts'),
];

function source(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
}

function opaqueGatewaySpoolToken(buildId, contentDigest, expiresAt = Date.now() + 60_000) {
  const payload = Buffer.from(JSON.stringify({
    v: 2,
    s: 'a'.repeat(48),
    p: 0,
    e: Math.floor(expiresAt / 1000),
    b: 'b'.repeat(64),
    g: buildId,
    d: contentDigest,
  }), 'utf8').toString('base64url');
  return `${payload}.test-signature`;
}

function loadXtreamModule() {
  const previousDeno = globalThis.Deno;
  globalThis.Deno = { env: { get: () => '' } };
  try {
    const output = buildSync({
      entryPoints: [path.join(SHARED, 'xtream-sync.ts')],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['npm:*', 'jsr:*'],
    }).outputFiles[0].text;
    const module = { exports: {} };
    Function('module', 'exports', 'require', '__filename', '__dirname', output)(
      module,
      module.exports,
      require,
      path.join(SHARED, 'xtream-sync.ts'),
      SHARED,
    );
    return module.exports;
  } finally {
    globalThis.Deno = previousDeno;
  }
}

function loadLiveMaterializationModule() {
  const output = buildSync({
    entryPoints: [path.join(SHARED, 'live-materialization.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['npm:*', 'jsr:*'],
  }).outputFiles[0].text;
  const module = { exports: {} };
  Function('module', 'exports', 'require', '__filename', '__dirname', output)(
    module,
    module.exports,
    require,
    path.join(SHARED, 'live-materialization.ts'),
    SHARED,
  );
  return module.exports;
}

function loadCatalogGenerationModule() {
  const file = path.join(SHARED, 'catalog-generation.ts');
  const output = buildSync({
    entryPoints: [file],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['npm:*', 'jsr:*'],
  }).outputFiles[0].text;
  const module = { exports: {} };
  Function('module', 'exports', 'require', '__filename', '__dirname', output)(
    module,
    module.exports,
    require,
    file,
    SHARED,
  );
  return module.exports;
}

class FakeQuery {
  constructor(database, table) {
    this.database = database;
    this.table = table;
    this.operation = 'select';
    this.rows = null;
    this.filters = [];
    this.head = false;
  }

  insert(rows) { this.operation = 'insert'; this.rows = rows; return this; }
  upsert(rows) { this.operation = 'upsert'; this.rows = rows; return this; }
  select(_columns, options = {}) { this.head = options.head === true; return this; }
  eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
  in(column, values) { const allowed = new Set(values); this.filters.push((row) => allowed.has(row[column])); return this; }
  range() { return this; }
  order() { return this; }
  limit() { return this; }

  then(resolve, reject) {
    try { resolve(this.execute()); } catch (error) { reject(error); }
  }

  execute() {
    const tableRows = this.database.tables[this.table] ?? (this.database.tables[this.table] = []);
    if (this.operation === 'insert' || this.operation === 'upsert') {
      this.database.writeBatches.push({ table: this.table, size: this.rows.length });
      const conflictColumns = {
        cloud_media_items: ['source_id', 'generation_id', 'item_type', 'external_id'],
        cloud_live_logical_channels: ['source_id', 'generation_id', 'logical_id'],
        cloud_live_variants: ['source_id', 'generation_id', 'logical_id', 'stream_id', 'label'],
        cloud_title_variants: ['source_id', 'generation_id', 'item_type', 'external_id'],
      }[this.table];
      const saved = this.rows.map((row) => {
        const existing = this.operation === 'upsert' && conflictColumns
          ? tableRows.find((candidate) => conflictColumns.every((column) => candidate[column] === row[column]))
          : null;
        if (existing) {
          Object.assign(existing, row);
          return existing;
        }
        const inserted = { id: row.id ?? `${this.table}-${tableRows.length + 1}`, ...row };
        tableRows.push(inserted);
        return inserted;
      });
      return { data: saved, error: null, count: saved.length };
    }
    const data = tableRows.filter((row) => this.filters.every((filter) => filter(row)));
    return { data: this.head ? null : data, error: null, count: data.length };
  }
}

class FakeDatabase {
  constructor() {
    this.tables = {
      cloud_source_catalog_generation_categories: [],
      cloud_media_items: [],
      cloud_live_logical_channels: [],
      cloud_live_variants: [],
    };
    this.rpcCalls = [];
    this.writeBatches = [];
  }

  from(table) { return new FakeQuery(this, table); }

  async rpc(name, args) {
    this.rpcCalls.push({ name, args });
    if (name === 'norva_register_credential_generation_categories') {
      const rows = this.tables.cloud_source_catalog_generation_categories;
      const categories = [...new Map(args.p_categories.map((category) => [
        category.provider_category_id,
        category,
      ])).values()].sort((left, right) =>
        left.provider_category_id.localeCompare(right.provider_category_id));
      let nextOrdinal = rows
        .filter((row) => row.generation_id === args.p_generation_id
          && row.category_kind === args.p_category_kind)
        .reduce((maximum, row) => Math.max(maximum, row.category_ordinal + 1), 0);
      for (const category of categories) {
        const existing = rows.find((row) =>
          row.generation_id === args.p_generation_id
          && row.category_kind === args.p_category_kind
          && row.provider_category_id === category.provider_category_id);
        if (existing) {
          existing.category_name = category.category_name;
          continue;
        }
        assert.equal(
          rows.some((row) => row.generation_id === args.p_generation_id
            && row.category_kind === args.p_category_kind
            && row.category_ordinal === nextOrdinal),
          false,
          'category ordinal must be unique',
        );
        rows.push({
          generation_id: args.p_generation_id,
          category_kind: args.p_category_kind,
          ...category,
          category_ordinal: nextOrdinal++,
        });
      }
    } else if (name === 'norva_get_credential_generation_categories') {
      const rows = this.tables.cloud_source_catalog_generation_categories
        .filter((row) => row.generation_id === args.p_generation_id
          && row.category_kind === args.p_category_kind)
        .sort((left, right) => left.category_ordinal - right.category_ordinal)
        .slice(args.p_offset, args.p_offset + args.p_limit)
        .map((row) => ({
          category_ordinal: row.category_ordinal,
          provider_category_id: row.provider_category_id,
          category_name: row.category_name,
        }));
      return { data: rows, error: null };
    } else if (name === 'norva_get_generation_live_channel_summaries') {
      const logicalIds = new Set(args.p_logical_ids);
      const rows = this.tables.cloud_live_logical_channels
        .filter((row) => row.source_id === args.p_source_id
          && row.user_id === args.p_user_id
          && row.generation_id === args.p_generation_id
          && logicalIds.has(row.logical_id))
        .map((row) => ({
          logical_id: row.logical_id,
          variant_preview: row.variant_preview,
        }));
      return { data: rows, error: null };
    }
    return { data: { complete: true }, error: null };
  }
}

test('active writer proof contains the exact ABA fence and every scoped conflict includes generation', () => {
  const generation = source(path.join(SHARED, 'catalog-generation.ts'));
  for (const field of [
    'generation_id',
    'write_head_revision',
    'write_config_revision',
    'write_source_visibility_epoch',
    'write_user_visibility_epoch',
  ]) assert.match(generation, new RegExp(`\\b${field}\\b`));

  const combined = WRITER_PATHS.map(source).join('\n');
  for (const conflict of [
    'source_id,generation_id,item_type,external_id',
    'source_id,generation_id,logical_id',
    'source_id,generation_id,logical_id,stream_id,label',
  ]) assert.match(combined, new RegExp(conflict.replaceAll(',', ',')));
  assert.doesNotMatch(
    combined,
    /\.from\("(?:cloud_media_items|cloud_title_variants|cloud_live_logical_channels|cloud_live_variants)"\)[\s\S]{0,100}\.delete\(/,
    'generated catalog deletes must use a fenced RPC',
  );
});

test('every literal generated-table update or upsert carries and filters its generation proof', () => {
  const generatedTable = 'cloud_(?:media_items|title_variants|live_logical_channels|live_variants)';
  for (const file of WRITER_PATHS) {
    const contents = source(file);
    for (const operation of ['update', 'upsert']) {
      const expression = new RegExp(`\\.from\\("${generatedTable}"\\)[\\s\\S]{0,160}?\\.${operation}\\(`, 'g');
      for (const match of contents.matchAll(expression)) {
        const window = contents.slice(Math.max(0, match.index - 700), match.index + 1100);
        assert.match(
          window,
          /catalogGenerationFields\(|withCatalogGeneration(?:Rows)?\(/,
          `${path.relative(ROOT, file)} ${operation} omits generation proof`,
        );
        if (operation === 'update') {
          assert.match(
            window,
            /\.eq\("generation_id", (?:generation|options\.generation|expectedSnapshot)\.generationId\)/,
            `${path.relative(ROOT, file)} update omits physical generation filter`,
          );
        } else {
          assert.match(
            window,
            /onConflict:\s*"[^"]*generation_id[^"]*"/,
            `${path.relative(ROOT, file)} upsert conflict omits generation`,
          );
        }
      }
    }
  }
});

test('active live materialization clears only through bounded resumable ABA-fenced batches', async () => {
  const { clearLiveMaterialization } = loadLiveMaterializationModule();
  const calls = [];
  const results = [
    { deletedVariants: 1000, deletedChannels: 0, deletedRows: 1000, complete: false },
    { deletedVariants: 200, deletedChannels: 800, deletedRows: 1000, complete: false },
    { deletedVariants: 0, deletedChannels: 5, deletedRows: 5, complete: true },
  ];
  const db = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: results.shift(), error: null };
    },
  };
  const generation = {
    kind: 'active',
    generationId: '11111111-1111-4111-8111-111111111111',
    headRevision: '7',
    configRevision: '8',
    sourceVisibilityEpoch: '9',
    userVisibilityEpoch: '10',
  };
  const result = await clearLiveMaterialization(
    db,
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    generation,
  );
  assert.deepEqual(result, {
    deletedRows: 2005,
    complete: true,
    callerProtocol: 'catalog-generation-writer-v2-live-clear-batch',
  });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.name, 'norva_clear_catalog_generation_live_materialization_batch');
    assert.deepEqual(call.args, {
      p_source_id: '22222222-2222-4222-8222-222222222222',
      p_user_id: '33333333-3333-4333-8333-333333333333',
      p_generation_id: generation.generationId,
      p_head_revision: '7',
      p_config_revision: '8',
      p_source_visibility_epoch: '9',
      p_user_visibility_epoch: '10',
      p_limit: 1000,
    });
  }

  await assert.rejects(
    clearLiveMaterialization({
      rpc: async () => ({
        data: { deletedVariants: 0, deletedChannels: 0, deletedRows: 0, complete: false },
        error: null,
      }),
    }, calls[0].args.p_source_id, calls[0].args.p_user_id, generation),
    /Invalid bounded live materialization clear result/,
  );
  const compatibilityCalls = [];
  const compatibility = await clearLiveMaterialization({
    async rpc(name, args) {
      compatibilityCalls.push({ name, args });
      if (name.endsWith('_batch')) return { data: null, error: { code: 'PGRST202' } };
      return { data: { deletedVariants: 12, deletedChannels: 3 }, error: null };
    },
  }, calls[0].args.p_source_id, calls[0].args.p_user_id, generation);
  assert.deepEqual(compatibility, {
    deletedRows: 15,
    complete: true,
    callerProtocol: 'catalog-generation-writer-v2-live-clear-batch',
    compatibilityFallback: 'legacy-rpc-v1',
  });
  assert.deepEqual(compatibilityCalls.map((call) => call.name), [
    'norva_clear_catalog_generation_live_materialization_batch',
    'norva_clear_catalog_generation_live_materialization',
  ]);
  const deniedCalls = [];
  await assert.rejects(
    clearLiveMaterialization({
      async rpc(name) {
        deniedCalls.push(name);
        return { data: null, error: { code: '42501', message: 'denied' } };
      },
    }, calls[0].args.p_source_id, calls[0].args.p_user_id, generation),
    /Unable to clear live materialization/,
  );
  assert.deepEqual(deniedCalls, ['norva_clear_catalog_generation_live_materialization_batch']);
  const liveSource = source(path.join(SHARED, 'live-materialization.ts'));
  const liveProtocol = liveSource.match(/LIVE_CLEAR_CALLER_PROTOCOL = "([^"]+)"/)?.[1];
  const rolloutProtocol = source(ONLINE_ROLLOUT_PATH)
    .match(/p_expected_caller_protocol\s+is\s+distinct\s+from\s*'([^']+)'/)?.[1];
  assert.equal(liveProtocol, 'catalog-generation-writer-v2-live-clear-batch');
  assert.equal(liveProtocol, rolloutProtocol, 'Edge caller protocol must equal the SQL rollout gate');
  assert.match(liveSource, /\["42883", "PGRST202"\]/);
});

test('live summary merge uses bounded RPC bodies and never a logical-id URL filter', async () => {
  const { upsertLiveChannelRows } = loadLiveMaterializationModule();
  const database = new FakeDatabase();
  const originalRpc = database.rpc.bind(database);
  database.rpc = async (name, args) => {
    if (name !== 'norva_get_generation_live_channel_summaries') {
      return originalRpc(name, args);
    }
    database.rpcCalls.push({ name, args });
    return { data: [], error: null };
  };
  const generation = {
    kind: 'active',
    generationId: '11111111-1111-4111-8111-111111111111',
    headRevision: '7',
    configRevision: '8',
    sourceVisibilityEpoch: '9',
    userVisibilityEpoch: '10',
  };
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const userId = '33333333-3333-4333-8333-333333333333';
  const rows = Array.from({ length: 1001 }, (_unused, index) => ({
    source_id: sourceId,
    user_id: userId,
    logical_id: `lc_${String(index).padStart(4, '0')}_${'x'.repeat(270)}`,
    variant_preview: [],
  }));

  const inserted = await upsertLiveChannelRows(database, rows, generation);
  assert.equal(inserted.length, 1001);
  const lookups = database.rpcCalls.filter((call) =>
    call.name === 'norva_get_generation_live_channel_summaries');
  assert.deepEqual(lookups.map((call) => call.args.p_logical_ids.length), [500, 500, 1]);
  assert.deepEqual(
    database.writeBatches
      .filter((batch) => batch.table === 'cloud_live_logical_channels')
      .map((batch) => batch.size),
    [...Array(100).fill(10), 1],
    'each bounded provider page must pay the generation trigger cost only once',
  );
  for (const call of lookups) {
    assert.equal(call.args.p_source_id, sourceId);
    assert.equal(call.args.p_user_id, userId);
    assert.equal(call.args.p_generation_id, generation.generationId);
  }
  assert.doesNotMatch(
    source(path.join(SHARED, 'live-materialization.ts')),
    /\.in\("logical_id"/,
  );
  await assert.rejects(
    upsertLiveChannelRows(database, [rows[0], { ...rows[1], source_id: crypto.randomUUID() }], generation),
    /Live materialization source_id mismatch/,
  );

  const migration = source(LIVE_SUMMARY_RPC_PATH);
  assert.match(migration, /cardinality\(p_logical_ids\),0\) not between 1 and 500/);
  assert.match(migration, /channel\.source_id = p_source_id/);
  assert.match(migration, /channel\.user_id = p_user_id/);
  assert.match(migration, /channel\.generation_id = p_generation_id/);
  assert.match(migration, /revoke all on function[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/);
  const liveWriter = source(path.join(SHARED, 'live-materialization.ts'));
  assert.equal((liveWriter.match(/chunkSize: 10/g) || []).length, 2);
  assert.match(source(path.join(ROOT, 'supabase', 'functions', 'norva-source-sync', 'index.ts')), /const LIVE_CHUNK = 10/);
  assert.match(source(path.join(ROOT, 'supabase', 'functions', 'norva-cloud', 'index.ts')), /const LIVE_CHUNK = 10/);
});

test('durable finalizer claims one CAS lease before writing and fences every handoff', () => {
  const worker = source(path.join(ROOT, 'supabase', 'functions', 'norva-source-sync', 'index.ts'));
  const cloud = source(path.join(ROOT, 'supabase', 'functions', 'norva-cloud', 'index.ts'));
  const migration = source(path.join(
    ROOT,
    'supabase',
    'migrations',
    '20260826155244_source_finalize_lease_cas_v1.sql',
  ));
  assert.match(worker, /claimFinalizeLease\([\s\S]{0,180}return;/);
  assert.match(worker, /renewFinalizeLease\([\s\S]{0,180}patchSourceConfigHint/);
  assert.match(worker, /releaseFinalizeLease\([\s\S]{0,180}selfInvokeFinalize/);
  const transientCatch = worker.match(/const transient = isTransientFinalizeError\(e\);([\s\S]*?)return;\n    }/)?.[1] || '';
  assert.doesNotMatch(transientCatch, /releaseFinalizeLease|selfInvokeFinalize/);
  assert.match(transientCatch, /Keep the durable claim until its TTL/);
  assert.match(cloud, /action === "finalize"[\s\S]{0,500}finalizeCloudSourceWithLease\(/);
  assert.match(cloud, /claimCloudFinalizeLease\([\s\S]{0,300}reason: "finalize_in_progress"/);
  assert.match(cloud, /isTransientCloudFinalizeError\(error\)[\s\S]{0,180}releaseCloudFinalizeLease/);
  const cloudLease = cloud.slice(
    cloud.indexOf('async function finalizeCloudSourceWithLease'),
    cloud.indexOf('function isTransientCloudFinalizeError'),
  );
  const cloudTransientCatch = cloudLease.match(/catch \(error\) \{([\s\S]*?)throw error;\n  \}/)?.[1] || '';
  assert.match(cloudTransientCatch, /if \(!isTransientCloudFinalizeError\(error\)\)/);
  assert.doesNotMatch(cloudTransientCatch, /if \(isTransientCloudFinalizeError\(error\)\)[\s\S]*releaseCloudFinalizeLease/);
  assert.match(migration, /on conflict \(source_id\) do update[\s\S]*lease\.lease_until <= statement_timestamp\(\)/i);
  assert.match(migration, /lease\.lease_token=p_lease_token/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table[\s\S]*service_role/i);
});

test('live row account deletion proof is cached only inside one catalog statement', () => {
  const migration = source(path.join(
    ROOT,
    'supabase',
    'migrations',
    '20260826172500_catalog_account_delete_guard_statement_cache_v1.sql',
  ));
  assert.match(migration, /current_setting\('norva\.catalog_guard_nonce', true\)/);
  assert.match(migration, /for key share nowait/i);
  assert.match(migration, /provider_account_delete_preparations/);
  assert.match(migration, /provider_deletion_pending/);
  assert.match(migration, /jsonb_build_object\('nonce', v_nonce, 'allowed', true\)/);
  assert.match(migration, /on public\.cloud_live_logical_channels/);
  assert.match(migration, /on public\.cloud_live_variants/);
  assert.match(migration, /revoke all on function[\s\S]*public, anon, authenticated, service_role/i);
});

test('active upsert reuses only its own nonce-bound validated insert proof', () => {
  const migration = source(path.join(
    ROOT,
    'supabase',
    'migrations',
    '20260826173500_active_catalog_upsert_statement_proof_v1.sql',
  ));
  assert.match(migration, /activeUpsertInsertProof/);
  assert.match(migration, /tg_op = 'UPDATE'[\s\S]*new\.write_head_revision is null/);
  assert.match(migration, /tg_op = 'INSERT'[\s\S]*set_config\(v_cache_name, v_cache::text, true\)/);
  assert.match(migration, /position\(v_old in v_definition\) = 0/);
  assert.match(migration, /definition drifted; refusing upsert proof patch/);
  assert.match(migration, /proof block is ambiguous/);
  assert.match(migration, /revoke all on function[\s\S]*public, anon, authenticated/i);
});

test('live clear budget checkpoints at live/0 and one-shot refresh writes only after a complete resume', async () => {
  const {
    clearLiveMaterialization,
    refreshMaterializedLiveCatalog,
  } = loadLiveMaterializationModule();
  const generation = {
    kind: 'active',
    generationId: '11111111-1111-4111-8111-111111111111',
    headRevision: '7',
    configRevision: '8',
    sourceVisibilityEpoch: '9',
    userVisibilityEpoch: '10',
  };
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const userId = '33333333-3333-4333-8333-333333333333';
  const database = new FakeDatabase();
  const originalRpc = database.rpc.bind(database);
  let clearComplete = false;
  let clearCalls = 0;
  database.rpc = async (name, args) => {
    if (name !== 'norva_clear_catalog_generation_live_materialization_batch') {
      return originalRpc(name, args);
    }
    database.rpcCalls.push({ name, args });
    clearCalls += 1;
    return {
      data: clearComplete
        ? { deletedVariants: 0, deletedChannels: 0, deletedRows: 0, complete: true }
        : { deletedVariants: 1000, deletedChannels: 0, deletedRows: 1000, complete: false },
      error: null,
    };
  };

  const incomplete = await clearLiveMaterialization(database, sourceId, userId, generation);
  assert.deepEqual(incomplete, {
    deletedRows: 64_000,
    complete: false,
    callerProtocol: 'catalog-generation-writer-v2-live-clear-batch',
  });
  assert.equal(clearCalls, 64, 'one invocation must stop at its bounded batch cap');

  clearCalls = 0;
  await assert.rejects(
    refreshMaterializedLiveCatalog(database, {
      sourceId,
      userId,
      rows: [{ source_id: sourceId, item_type: 'live', external_id: 'tf1-hd', title: 'TF1 HD' }],
      generation,
    }),
    (error) => {
      assert.equal(error?.code, 'LIVE_MATERIALIZATION_CLEAR_INCOMPLETE');
      assert.equal(error?.transient, true);
      assert.equal(error?.retryable, true);
      assert.equal(error?.deletedRows, 64_000);
      return true;
    },
  );
  assert.equal(clearCalls, 64);
  assert.equal(database.tables.cloud_live_logical_channels.length, 0);
  assert.equal(database.tables.cloud_live_variants.length, 0);

  clearComplete = true;
  const resumed = await refreshMaterializedLiveCatalog(database, {
    sourceId,
    userId,
    rows: [{ source_id: sourceId, item_type: 'live', external_id: 'tf1-hd', title: 'TF1 HD' }],
    generation,
  });
  assert.equal(clearCalls, 65, 'resume must clear once more before the first materialization write');
  assert.equal(resumed.rawLive, 1);
  assert.equal(database.tables.cloud_live_logical_channels.length, 1);
  assert.equal(database.tables.cloud_live_variants.length, 1);

  for (const file of [
    path.join(ROOT, 'supabase', 'functions', 'norva-cloud', 'index.ts'),
    path.join(ROOT, 'supabase', 'functions', 'norva-source-sync', 'index.ts'),
  ]) {
    const contents = source(file);
    const liveStart = contents.indexOf('if (phase === "live" || phase === "live_channels" || phase === "live_variants")');
    const titlesStart = contents.indexOf('if (phase === "titles")', liveStart);
    const liveFinalize = contents.slice(liveStart, titlesStart);
    const clearAt = liveFinalize.indexOf('const cleared = await clearLiveMaterialization');
    const checkpointAt = liveFinalize.indexOf('nextPhase: "live", nextOffset: 0', clearAt);
    const loadAt = liveFinalize.indexOf('const liveChunk = await loadSourceItems', clearAt);
    const writeAt = liveFinalize.indexOf('const mat = await materializeLiveChunk', clearAt);
    assert.ok(clearAt >= 0 && checkpointAt > clearAt, `${path.basename(path.dirname(file))} lacks clear checkpoint`);
    assert.ok(loadAt > checkpointAt && writeAt > loadAt, `${path.basename(path.dirname(file))} can write before clear completion`);
  }
});

test('legacy physical writers use exact ABA overloads and fallback only when the routine is unavailable', async () => {
  const { callActiveCatalogGenerationRpc } = loadCatalogGenerationModule();
  const generation = {
    kind: 'active',
    generationId: '11111111-1111-4111-8111-111111111111',
    headRevision: '7',
    configRevision: '8',
    sourceVisibilityEpoch: '9',
    userVisibilityEpoch: '10',
  };
  const calls = [];
  const compatibility = await callActiveCatalogGenerationRpc({
    async rpc(name, args) {
      calls.push({ name, args });
      return calls.length === 1
        ? { data: null, error: { code: '42883' } }
        : { data: { ok: true }, error: null };
    },
  }, 'record_provider_overview_outcome', { p_source_id: 'source' }, generation);
  assert.deepEqual(compatibility, { data: { ok: true }, error: null });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, {
    p_source_id: 'source',
    p_generation_id: generation.generationId,
    p_head_revision: '7',
    p_config_revision: '8',
    p_source_visibility_epoch: '9',
    p_user_visibility_epoch: '10',
  });
  assert.deepEqual(calls[1].args, { p_source_id: 'source' });

  const denied = [];
  const deniedResult = await callActiveCatalogGenerationRpc({
    async rpc(name, args) {
      denied.push({ name, args });
      return { data: null, error: { code: '42501' } };
    },
  }, 'record_catalog_file_container_observation', { p_source_id: 'source' }, generation);
  assert.equal(deniedResult.error.code, '42501');
  assert.equal(denied.length, 1, 'permission/ABA failures must never fall back to legacy');

  const overview = source(path.join(SHARED, 'provider-overview-backfill.ts'));
  assert.match(overview, /callActiveCatalogGenerationRpc\(db, "record_provider_overview_outcome"/);
  assert.match(overview, /generation: options\.generation/g);
  const sourceSync = source(path.join(ROOT, 'supabase', 'functions', 'norva-source-sync', 'index.ts'));
  assert.match(sourceSync, /backfillProviderOverviews\(\{[\s\S]{0,220}generation: accessSnapshot/);

  const playback = source(path.join(ROOT, 'supabase', 'functions', 'norva-playback', 'index.ts'));
  assert.match(playback, /callActiveCatalogGenerationRpc\(db, "record_catalog_file_container_observation"/);
  const createPlayback = playback.slice(
    playback.indexOf('async function createPlaybackSession('),
    playback.indexOf('\nasync function getPlaybackSession('),
  );
  const snapshotAt = createPlayback.indexOf('const playbackGeneration = await readActiveCatalogGenerationSnapshot(db, sourceId, userId)');
  const resolvedAt = createPlayback.indexOf('const resolved = ', snapshotAt);
  const resolutionAssertAt = createPlayback.indexOf(
    'assertActiveCatalogGenerationCurrent(db, sourceId, userId, playbackGeneration)',
    resolvedAt,
  );
  const gatewayAt = createPlayback.indexOf('createGatewaySession(', resolutionAssertAt);
  const generationPassedAt = createPlayback.indexOf('playbackGeneration,', gatewayAt);
  assert.ok(
    snapshotAt >= 0 && resolvedAt > snapshotAt && resolutionAssertAt > resolvedAt
      && gatewayAt > resolutionAssertAt && generationPassedAt > gatewayAt,
    'playback resolution must propagate its original generation proof to the Gateway writer',
  );
  const containerPersist = playback.slice(
    playback.indexOf('async function persistGatewaySourceContainerMismatch('),
    playback.indexOf('\nasync function createGatewaySession('),
  );
  assert.doesNotMatch(containerPersist, /readActiveCatalogGenerationSnapshot/);
  assert.match(containerPersist, /if \(!itemCas\) return false;[\s\S]{0,300}callActiveCatalogGenerationRpc/);
  assert.match(containerPersist, /p_expected_media_item_id: itemCas\.id[\s\S]*p_expected_media_item_updated_at: itemCas\.updatedAt[\s\S]*options\.generation/);
  assert.match(playback, /"norva_fanout_file_tracks_to_users_fenced"[\s\S]{0,300}isRollingRpcUnavailable\(error\)[\s\S]{0,200}"fanout_file_tracks_to_users"/);
});

test('active projection adopts only a monotone user visibility epoch after its own visible write', async () => {
  const { adoptActiveCatalogUserVisibilityEpoch } = loadCatalogGenerationModule();
  const expected = {
    kind: 'active',
    generationId: '11111111-1111-4111-8111-111111111111',
    headRevision: '7',
    configRevision: '8',
    sourceVisibilityEpoch: '9',
    userVisibilityEpoch: '10',
  };
  const snapshot = (overrides = {}) => ({
    generationId: expected.generationId,
    headRevision: expected.headRevision,
    configRevision: expected.configRevision,
    sourceVisibilityEpoch: expected.sourceVisibilityEpoch,
    userVisibilityEpoch: '12',
    isCatalogVisible: true,
    ...overrides,
  });
  const db = {
    async rpc() { return { data: snapshot(), error: null }; },
  };

  await adoptActiveCatalogUserVisibilityEpoch(db, 'source', 'user', expected);
  assert.equal(expected.userVisibilityEpoch, '12');

  await assert.rejects(
    adoptActiveCatalogUserVisibilityEpoch({
      async rpc() { return { data: snapshot({ sourceVisibilityEpoch: '10' }), error: null }; },
    }, 'source', 'user', { ...expected }),
    /Catalog generation changed/,
  );
  await assert.rejects(
    adoptActiveCatalogUserVisibilityEpoch({
      async rpc() { return { data: snapshot({ userVisibilityEpoch: '11' }), error: null }; },
    }, 'source', 'user', { ...expected, userVisibilityEpoch: '12' }),
    /Catalog generation changed/,
  );

  const projection = source(path.join(SHARED, 'vod-title-projection.ts'));
  const variantWrite = projection.indexOf('.from("cloud_title_variants")');
  const adopt = projection.indexOf('await adoptActiveCatalogUserVisibilityEpoch(', variantWrite);
  assert.ok(variantWrite >= 0 && adopt > variantWrite, 'visible variant upsert must adopt its post-write user epoch');
  assert.equal(
    projection.match(/await adoptActiveCatalogUserVisibilityEpoch\(/g)?.length,
    6,
    'every projection write boundary must re-prove authority while adopting only the monotone user epoch',
  );
});

test('isolated projection cannot reach active/shared metadata mutations', () => {
  const projection = source(path.join(SHARED, 'vod-title-projection.ts'));
  const start = projection.indexOf('export async function projectVodTitleGenerationIsolated');
  const end = projection.indexOf('\ntype ProviderIds', start);
  assert.ok(start >= 0 && end > start, 'isolated projection boundary must exist');
  const isolated = projection.slice(start, end);
  assert.match(isolated, /mode:\s*"building-generation"/);
  assert.match(isolated, /norva_ensure_credential_generation_titles/);
  assert.match(isolated, /source_id,generation_id,item_type,external_id/);
  for (const forbidden of [
    'catalog_titles',
    'hydrate_cloud_title_file_languages',
    'fill_user_cloud_title_global_languages',
    'propagate_cloud_title_year',
    'cloud_import_notifications',
    '.from("cloud_titles").update',
    '.from("cloud_titles").upsert',
  ]) assert.doesNotMatch(isolated, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('playback physical catalog patches carry generation plus the complete ABA proof', () => {
  const playback = source(path.join(ROOT, 'supabase', 'functions', 'norva-playback', 'index.ts'));
  const physicalWrites = [...playback.matchAll(/\.from\("cloud_(?:title_variants|media_items)"\)\s*\n\s*\.update\(/g)];
  assert.equal(physicalWrites.length, 2, 'all playback writes must remain centralized in two fenced helpers');

  for (const [startMarker, endMarker] of [
    ['async function patchActiveCatalogTitleVariants(', '\nasync function patchActiveCatalogMediaItems('],
    ['async function patchActiveCatalogMediaItems(', '\nasync function requireIdentity('],
  ]) {
    const start = playback.indexOf(startMarker);
    const end = playback.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `missing playback fence helper: ${startMarker}`);
    const helper = playback.slice(start, end);
    assert.match(helper, /readActiveCatalogGenerationSnapshot/);
    assert.match(helper, /assertActiveCatalogGenerationCurrent/);
    assert.match(helper, /\.update\(\{ \.\.\.options\.patch, \.\.\.catalogGenerationFields\(generation\) \}\)/);
    assert.match(helper, /\.eq\("user_id", options\.userId\)/);
    assert.match(helper, /\.eq\("source_id", options\.sourceId\)/);
    assert.match(helper, /\.eq\("generation_id", generation\.generationId\)/);
    assert.match(helper, /isCatalogGenerationSuperseded/);
  }

});

test('series-info episode writers use only complete generation-fenced overloads', () => {
  const seriesInfo = source(path.join(ROOT, 'supabase', 'functions', 'norva-series-info', 'index.ts'));
  assert.match(seriesInfo, /readActiveCatalogGenerationSnapshot/);
  assert.match(seriesInfo, /assertActiveCatalogGenerationCurrent/);
  for (const rpc of [
    'register_catalog_series_episodes',
    'hydrate_catalog_episode_file_tracks',
    'record_catalog_series_inventory_outcome',
  ]) {
    const matches = [...seriesInfo.matchAll(new RegExp(`rpc\\("${rpc}"`, 'g'))];
    assert.equal(matches.length, 1, `${rpc} must have one bounded caller`);
    const call = seriesInfo.slice(matches[0].index, matches[0].index + 700);
    assert.match(call, /\.\.\.catalogGenerationRpcFence\(expectedSnapshot\)/);
  }
  const register = seriesInfo.slice(
    seriesInfo.indexOf('async function registerSeriesEpisodes('),
    seriesInfo.indexOf('\n// Best-effort lookup', seriesInfo.indexOf('async function registerSeriesEpisodes(')),
  );
  assert.ok(
    (register.match(/await assertSourceSnapshotCurrent\(/g) ?? []).length >= 4,
    'generation must be checked around each inventory I/O',
  );
});

test('empty category lists do not suppress an unfiltered non-empty stream inventory', async () => {
  const { stageXtreamCredentialCatalogGeneration } = loadXtreamModule();
  const database = new FakeDatabase();
  const requests = [];
  const externalId = 'x'.repeat(256);
  const pages = new Map([
    ['get_live_categories', []],
    ['get_vod_categories', []],
    ['get_series_categories', []],
    ['get_live_streams', [{ stream_id: externalId, name: 'Orphan News', category_id: 'missing', num: 1 }]],
  ]);
  const result = await stageXtreamCredentialCatalogGeneration({
    db: database,
    userId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    transitionId: '33333333-3333-4333-8333-333333333333',
    generationId: '44444444-4444-4444-8444-444444444444',
    jobId: '55555555-5555-4555-8555-555555555555',
    leaseSequence: 37,
    leaseOwner: 'generation-writer-test',
    maxSlices: 4,
    fetchMetadataPage: async (request) => {
      requests.push(request);
      return { items: pages.get(request.action), nextCursor: null, done: true, spoolToken: null };
    },
  });

  assert.deepEqual(requests.map(({ action }) => action), [
    'get_live_categories',
    'get_vod_categories',
    'get_series_categories',
    'get_live_streams',
  ]);
  assert.ok(requests.every(({ categoryId }) => categoryId === null), 'inventory must not be category sliced');
  assert.equal(database.tables.cloud_media_items.length, 1);
  assert.equal(database.tables.cloud_media_items[0].external_id, externalId);
  const completion = database.rpcCalls.find(({ name }) => name === 'norva_mark_credential_parent_action_complete');
  assert.equal(completion.args.p_action, 'get_live_streams');
  assert.equal(completion.args.p_staged_item_count, 1);
  assert.equal(result.checkpoint.action, 'vod_streams');
  assert.equal(result.checkpoint.categoriesDone, true);
  assert.equal(result.checkpoint.processedCategories, 0);
  assert.equal(result.checkpoint.processedItems, 1);
  assert.deepEqual(Object.keys(result.checkpoint).sort(), [
    'action', 'categoriesDone', 'categoryOrdinal', 'categoryPageCursor', 'itemCursor',
    'itemOffset', 'processedCategories', 'processedItems', 'typeIndex', 'version',
  ].sort());
});

test('candidate pager fails closed on an oversized or ambiguous page', async () => {
  const { stageXtreamCredentialCatalogGeneration } = loadXtreamModule();
  const base = {
    db: new FakeDatabase(),
    userId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    transitionId: '33333333-3333-4333-8333-333333333333',
    generationId: '44444444-4444-4444-8444-444444444444',
    jobId: '55555555-5555-4555-8555-555555555555',
    leaseSequence: 1,
    leaseOwner: 'generation-writer-test',
    maxSlices: 1,
  };
  await assert.rejects(
    stageXtreamCredentialCatalogGeneration({
      ...base,
      fetchMetadataPage: async () => ({ items: [], nextCursor: null, done: false }),
    }),
    /missing a continuation cursor/,
  );
  await assert.rejects(
    stageXtreamCredentialCatalogGeneration({
      ...base,
      fetchMetadataPage: async () => ({ items: Array(101).fill({}), nextCursor: null, done: true }),
    }),
    /exceeds requested bound/,
  );
});

test('a pending gateway spool polls once and preserves an unchanged durable checkpoint', async () => {
  const { stageXtreamCredentialCatalogGeneration } = loadXtreamModule();
  const database = new FakeDatabase();
  let polls = 0;
  const base = {
    db: database,
    userId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    transitionId: '33333333-3333-4333-8333-333333333333',
    generationId: '44444444-4444-4444-8444-444444444444',
    jobId: '55555555-5555-4555-8555-555555555555',
    leaseOwner: 'generation-writer-test',
    maxSlices: 8,
    fetchMetadataPage: async () => {
      polls += 1;
      return {
        items: [], nextCursor: null, done: false, pending: true,
        retryAfterSeconds: 3, spoolToken: null,
      };
    },
  };
  const first = await stageXtreamCredentialCatalogGeneration({ ...base, leaseSequence: 4 });
  assert.equal(polls, 1);
  assert.equal(first.pending, true);
  assert.equal(first.retryAfterSeconds, 3);
  assert.equal(first.checkpoint.action, 'live_categories');
  assert.equal(database.rpcCalls.length, 0);
  assert.ok(Object.values(database.tables).every((rows) => rows.length === 0));

  const second = await stageXtreamCredentialCatalogGeneration({
    ...base,
    leaseSequence: 5,
    cursor: first.checkpoint,
  });
  assert.equal(polls, 2, 'one fresh claim performs exactly one pending poll');
  assert.deepEqual(second.checkpoint, first.checkpoint);
  assert.deepEqual(second.nextCursor, first.nextCursor);
});

test('bounded gateway cursor and spool token round-trip through the strict SQL checkpoint', async () => {
  const { stageXtreamCredentialCatalogGeneration } = loadXtreamModule();
  const base = {
    db: new FakeDatabase(),
    userId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    transitionId: '33333333-3333-4333-8333-333333333333',
    generationId: '44444444-4444-4444-8444-444444444444',
    jobId: '55555555-5555-4555-8555-555555555555',
    leaseSequence: 2,
    leaseOwner: 'generation-writer-test',
    maxSlices: 1,
  };
  const contentDigest = 'c'.repeat(64);
  const firstSpoolToken = opaqueGatewaySpoolToken('d'.repeat(32), contentDigest);
  const rebuiltSameContentToken = opaqueGatewaySpoolToken('e'.repeat(32), contentDigest, Date.now() + 120_000);
  const first = await stageXtreamCredentialCatalogGeneration({
    ...base,
    fetchMetadataPage: async () => ({
      items: [], nextCursor: 'category-page-2', done: false, spoolToken: firstSpoolToken,
    }),
  });
  assert.equal(first.checkpoint.action, 'live_categories');
  assert.match(first.checkpoint.categoryPageCursor, /^[A-Za-z0-9_.-]+$/);
  assert.doesNotMatch(first.checkpoint.categoryPageCursor, /password|username|access_token|api_key|:\/\/|@/i);
  await assert.rejects(
    stageXtreamCredentialCatalogGeneration({
      ...base,
      leaseSequence: 3,
      cursor: first.checkpoint,
      fetchMetadataPage: async () => ({
        items: [],
        nextCursor: 'category-page-3',
        done: false,
        spoolToken: opaqueGatewaySpoolToken('f'.repeat(32), '0'.repeat(64)),
      }),
    }),
    /spool identity changed/,
  );
  const rotated = await stageXtreamCredentialCatalogGeneration({
    ...base,
    leaseSequence: 3,
    cursor: first.checkpoint,
    fetchMetadataPage: async () => ({
      items: [], nextCursor: 'category-page-3', done: false, spoolToken: rebuiltSameContentToken,
    }),
  });
  let resumedRequest;
  await stageXtreamCredentialCatalogGeneration({
    ...base,
    leaseSequence: 4,
    cursor: rotated.checkpoint,
    fetchMetadataPage: async (request) => {
      resumedRequest = request;
      return { items: [], nextCursor: null, done: true, spoolToken: rebuiltSameContentToken };
    },
  });
  assert.equal(resumedRequest.cursor, 'category-page-3');
  assert.equal(resumedRequest.spoolToken, rebuiltSameContentToken);
});

test('episode cache copying is DB-stateful and advances only by copyRevision CAS', async () => {
  const { stageXtreamCredentialCatalogGeneration } = loadXtreamModule();
  const database = new FakeDatabase();
  let complete = false;
  database.rpc = async function rpc(name, args) {
    this.rpcCalls.push({ name, args });
    if (name === 'norva_copy_credential_generation_episode_state') {
      return { data: { copyRevision: args.p_expected_copy_revision + 1, complete }, error: null };
    }
    return { data: {}, error: null };
  };
  const base = {
    db: database,
    userId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    transitionId: '33333333-3333-4333-8333-333333333333',
    generationId: '44444444-4444-4444-8444-444444444444',
    jobId: '55555555-5555-4555-8555-555555555555',
    leaseOwner: 'generation-writer-test',
    maxSlices: 1,
    fetchMetadataPage: async () => assert.fail('provider paging must already be complete'),
  };
  const copyProgress = {
    action: 'episode_state_copy', version: 1, typeIndex: 6,
    categoryOrdinal: 0, itemOffset: 0, categoryPageCursor: '',
    categoriesDone: true, itemCursor: '', processedCategories: 0, processedItems: 0,
  };
  const first = await stageXtreamCredentialCatalogGeneration({ ...base, leaseSequence: 9, cursor: copyProgress });
  assert.equal(first.done, false);
  assert.equal(first.checkpoint.action, 'episode_state_copy');
  assert.equal(first.checkpoint.itemOffset, 1);
  complete = true;
  const second = await stageXtreamCredentialCatalogGeneration({
    ...base, leaseSequence: 10, cursor: first.checkpoint,
  });
  assert.equal(second.done, true);
  assert.equal(second.checkpoint.action, 'complete');
  assert.deepEqual(
    database.rpcCalls
      .filter(({ name }) => name === 'norva_copy_credential_generation_episode_state')
      .map(({ args }) => args.p_expected_copy_revision),
    [0, 1],
  );
});

test('a category repeated on the next page keeps its original ordinal without creating a gap', async () => {
  const { stageXtreamCredentialCatalogGeneration } = loadXtreamModule();
  const database = new FakeDatabase();
  const base = {
    db: database,
    userId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    transitionId: '33333333-3333-4333-8333-333333333333',
    generationId: '44444444-4444-4444-8444-444444444444',
    jobId: '55555555-5555-4555-8555-555555555555',
    leaseOwner: 'generation-writer-test',
    maxSlices: 1,
  };
  const first = await stageXtreamCredentialCatalogGeneration({
    ...base,
    leaseSequence: 11,
    fetchMetadataPage: async () => ({
      items: [
        { category_id: 'alpha', category_name: 'Alpha' },
        { category_id: 'beta', category_name: 'Beta' },
      ],
      nextCursor: 'page-2', done: false, spoolToken: 'spool-categories',
    }),
  });
  await stageXtreamCredentialCatalogGeneration({
    ...base,
    leaseSequence: 12,
    cursor: first.checkpoint,
    fetchMetadataPage: async () => ({
      items: [
        { category_id: 'beta', category_name: 'Beta renamed' },
        { category_id: 'gamma', category_name: 'Gamma' },
      ],
      nextCursor: null, done: true, spoolToken: null,
    }),
  });
  const rows = database.tables.cloud_source_catalog_generation_categories
    .sort((left, right) => left.category_ordinal - right.category_ordinal);
  assert.deepEqual(rows.map((row) => [
    row.provider_category_id, row.category_name, row.category_ordinal,
  ]), [
    ['alpha', 'Alpha', 0],
    ['beta', 'Beta renamed', 1],
    ['gamma', 'Gamma', 2],
  ]);
  const registerCalls = database.rpcCalls
    .filter(({ name }) => name === 'norva_register_credential_generation_categories');
  // Caller ordinals are only an input-shape compatibility field. The fenced
  // SQL writer retains beta=1 and allocates gamma=2 atomically.
  assert.deepEqual(registerCalls[1].args.p_categories.map((row) => [
    row.provider_category_id, row.category_ordinal,
  ]), [['beta', 2], ['gamma', 3]]);
  assert.ok(database.rpcCalls.some(({ name }) =>
    name === 'norva_get_credential_generation_categories'));
  assert.deepEqual(
    database.rpcCalls
      .filter(({ name }) => name === 'norva_get_credential_generation_categories')
      .map(({ args }) => args.p_offset),
    [0, 2],
    'crash-safe count resumes at the committed checkpoint prefix instead of rescanning it',
  );
});

test('candidate staging reads categories only through the service-definer RPC', async () => {
  const contents = source(path.join(SHARED, 'xtream-sync.ts'));
  assert.doesNotMatch(contents, /\.from\("cloud_source_catalog_generation_categories"\)/);
  assert.match(contents, /\.rpc\("norva_get_credential_generation_categories"/);

  const { stageXtreamCredentialCatalogGeneration } = loadXtreamModule();
  const database = new FakeDatabase();
  const originalFrom = database.from.bind(database);
  database.from = (table) => {
    if (table === 'cloud_source_catalog_generation_categories') {
      throw new Error('permission denied for raw generation categories');
    }
    return originalFrom(table);
  };
  const first = await stageXtreamCredentialCatalogGeneration({
    db: database,
    userId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    transitionId: '33333333-3333-4333-8333-333333333333',
    generationId: '44444444-4444-4444-8444-444444444444',
    jobId: '55555555-5555-4555-8555-555555555555',
    leaseOwner: 'generation-category-rpc-test',
    leaseSequence: 31,
    maxSlices: 1,
    fetchMetadataPage: async () => ({
      items: [{ category_id: 'news', category_name: 'News' }],
      nextCursor: null,
      done: true,
      spoolToken: null,
    }),
  });
  assert.equal(first.done, false);
  assert.equal(first.checkpoint.action, 'vod_categories');
  assert.equal(database.tables.cloud_source_catalog_generation_categories.length, 1);
  assert.ok(database.rpcCalls.some(({ name, args }) =>
    name === 'norva_get_credential_generation_categories'
      && args.p_transition_id === '33333333-3333-4333-8333-333333333333'
      && args.p_user_id === '11111111-1111-4111-8111-111111111111'
      && args.p_generation_id === '44444444-4444-4444-8444-444444444444'));
});

test('service-definer category paging resolves a late category without raw-table privilege', async () => {
  const { stageXtreamCredentialCatalogGeneration } = loadXtreamModule();
  const database = new FakeDatabase();
  const generationId = '44444444-4444-4444-8444-444444444444';
  database.tables.cloud_source_catalog_generation_categories = Array.from(
    { length: 501 },
    (_, index) => ({
      generation_id: generationId,
      category_kind: 'live',
      category_ordinal: index,
      provider_category_id: `category-${index}`,
      category_name: `Category ${index}`,
    }),
  );
  const originalFrom = database.from.bind(database);
  database.from = (table) => {
    if (table === 'cloud_source_catalog_generation_categories') {
      throw new Error('permission denied for raw generation categories');
    }
    return originalFrom(table);
  };
  const result = await stageXtreamCredentialCatalogGeneration({
    db: database,
    userId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    transitionId: '33333333-3333-4333-8333-333333333333',
    generationId,
    jobId: '55555555-5555-4555-8555-555555555555',
    leaseOwner: 'generation-category-page-test',
    leaseSequence: 32,
    maxSlices: 1,
    cursor: {
      action: 'live_streams', version: 1, typeIndex: 3,
      categoryOrdinal: 0, itemOffset: 0, categoryPageCursor: '',
      categoriesDone: true, itemCursor: '', processedCategories: 501, processedItems: 0,
    },
    fetchMetadataPage: async () => ({
      items: [{ stream_id: 'late-channel', name: 'Late Channel', category_id: 'category-500' }],
      nextCursor: null,
      done: true,
      spoolToken: null,
    }),
  });
  assert.equal(result.done, false);
  assert.equal(database.tables.cloud_media_items[0].subtitle, 'Category 500');
  assert.deepEqual(
    database.rpcCalls
      .filter(({ name }) => name === 'norva_get_credential_generation_categories')
      .map(({ args }) => args.p_offset),
    [0, 500],
  );
});

test('one logical live channel split across pages keeps its exact merged variant summary', async () => {
  const { stageXtreamCredentialCatalogGeneration } = loadXtreamModule();
  const database = new FakeDatabase();
  const base = {
    db: database,
    userId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    transitionId: '33333333-3333-4333-8333-333333333333',
    generationId: '44444444-4444-4444-8444-444444444444',
    jobId: '55555555-5555-4555-8555-555555555555',
    leaseOwner: 'generation-writer-test',
    maxSlices: 1,
  };
  const liveProgress = {
    action: 'live_streams', version: 1, typeIndex: 3,
    categoryOrdinal: 0, itemOffset: 0, categoryPageCursor: '',
    categoriesDone: true, itemCursor: '', processedCategories: 0, processedItems: 0,
  };
  const first = await stageXtreamCredentialCatalogGeneration({
    ...base,
    leaseSequence: 13,
    cursor: liveProgress,
    fetchMetadataPage: async () => ({
      items: [{ stream_id: 'tf1-hd', name: 'TF1 HD', category_id: 'orphan' }],
      nextCursor: 'live-page-2', done: false, spoolToken: 'spool-live',
    }),
  });
  await stageXtreamCredentialCatalogGeneration({
    ...base,
    leaseSequence: 14,
    cursor: first.checkpoint,
    fetchMetadataPage: async () => ({
      items: [{ stream_id: 'tf1-fhd', name: 'TF1 FHD', category_id: 'orphan' }],
      nextCursor: null, done: true, spoolToken: null,
    }),
  });
  assert.equal(database.tables.cloud_live_logical_channels.length, 1);
  assert.equal(database.tables.cloud_live_variants.length, 2);
  const channel = database.tables.cloud_live_logical_channels[0];
  assert.equal(channel.variant_count, 2);
  assert.deepEqual(channel.variant_preview.map((variant) => variant.label), ['FHD', 'HD']);
  assert.equal(channel.default_variant.stream_id, 'tf1-hd');
  assert.equal(channel.default_stream_id, 'tf1-hd');
});
