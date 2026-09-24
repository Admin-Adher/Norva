'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');

const file = path.join(__dirname, '..', 'supabase', 'functions', '_shared', 'xtream-sync.ts');
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('async function withActiveCatalogWriteRetry<');
const end = source.indexOf('// Incremental import:', start);

function loadRetry(assertCurrent) {
  assert.ok(start >= 0 && end > start, 'the production import retry must be present');
  const { code } = transformSync(
    `${source.slice(start, end)}\nmodule.exports = withActiveCatalogWriteRetry;`,
    { loader: 'ts', format: 'cjs' },
  );
  class HttpError extends Error {
    constructor(status, message, details) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }
  return new Function('assertCatalogSnapshotCurrent', 'withDbRetry', 'HttpError',
    `const module = { exports: null }; ${code}; return module.exports;`)(
    assertCurrent, (operation) => operation(), HttpError,
  );
}

test('Xtream import retries an idempotent write only after the account epoch advances', async () => {
  const snapshot = { userVisibilityEpoch: 7 };
  let checks = 0;
  let writes = 0;
  const retry = loadRetry(async () => {
    checks++;
    if (checks === 2) snapshot.userVisibilityEpoch = 8;
  });
  const result = await retry({}, 'source', 'owner', snapshot, async () => {
    writes++;
    return writes === 1 ? { error: { code: '42501' } } : { error: null, data: 'saved' };
  }, 'test write');
  assert.deepEqual(result, { error: null, data: 'saved' });
  assert.equal(writes, 2);
  assert.equal(checks, 3);
});

test('Xtream import does not retry a failed write when its epoch is unchanged', async () => {
  const snapshot = { userVisibilityEpoch: 7 };
  let writes = 0;
  const retry = loadRetry(async () => {});
  const result = await retry({}, 'source', 'owner', snapshot, async () => {
    writes++;
    return { error: { code: '42501' } };
  }, 'test write');
  assert.equal(result.error.code, '42501');
  assert.equal(writes, 1);
});

test('Xtream import stops after repeated epoch races instead of looping indefinitely', async () => {
  const snapshot = { userVisibilityEpoch: 7 };
  let checks = 0;
  let writes = 0;
  const retry = loadRetry(async () => {
    checks++;
    if (checks % 2 === 0) snapshot.userVisibilityEpoch++;
  });
  await assert.rejects(
    retry({}, 'source', 'owner', snapshot, async () => {
      writes++;
      return { error: { code: 'PT409' } };
    }, 'test write'),
    (error) => error.status === 503 && error.details?.transient === true,
  );
  assert.equal(writes, 5);
});

test('Xtream discovery yields the provider connection when a viewer starts', async () => {
  const driver = source.indexOf('export async function driveXtreamSyncToReady');
  const from = source.indexOf('const fetchCatalog = async', driver);
  const to = source.indexOf('const vodCats = await fetchCatalog', from);
  assert.ok(driver >= 0 && from > driver && to > from);
  const { code } = transformSync(
    `async function probe({db, cursor, assertCatalogSnapshotCurrent, fetchProviderMetadata, HttpError, isCatalogAccessGuardError}) {
      const sourceId = 'source', userId = 'owner', accessSnapshot = {},
        serverUrl = 'https://panel.example', username = 'qa', password = 'unused',
        runtimeConfig = {}, runDirectFallback = null;
      ${source.slice(from, to)}
      return await fetchCatalog('get_vod_categories');
    }
    module.exports = probe;`,
    { loader: 'ts', format: 'cjs' },
  );
  const probe = new Function(`const module = { exports: null }; ${code}; return module.exports;`)();
  class HttpError extends Error {
    constructor(status, message, details) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }
  let providerCalls = 0;
  const cursor = { fetchErrors: 0 };
  await assert.rejects(probe({
    db: { rpc: async () => ({ data: true, error: null }) },
    cursor,
    assertCatalogSnapshotCurrent: async () => {},
    fetchProviderMetadata: async () => { providerCalls++; return []; },
    HttpError,
    isCatalogAccessGuardError: () => false,
  }), (error) => error.status === 409 && error.details?.code === 'account_busy');
  assert.equal(providerCalls, 0);
  assert.equal(cursor.fetchErrors, 1, 'outer viewer-priority handler subsequently undoes this attempt');
});
