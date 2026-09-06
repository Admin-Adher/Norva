'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const read = engine => fs.readFileSync(path.join(root, `supabase/functions/${engine}/index.ts`), 'utf8').replace(/\r\n/g, '\n');
function loadFunction(source, name, next, context) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`\nasync function ${next}(`, start);
  assert.ok(start >= 0 && end > start);
  const js = transformSync(source.slice(start, end), { loader: 'ts', target: 'es2022' }).code;
  return vm.runInNewContext(`${js}\n${name}`, context);
}

const snapshot = { generationId: 'generation', headRevision: 3 };
function persistenceHarness(engine, failBatch = 0, replacedOnPrune = false) {
  const rows = new Map([['keep', { id: 'stable-id', external_id: 'keep', title: 'Old title' }], ['obsolete', { id: 'old-id', external_id: 'obsolete' }]]);
  const calls = [];
  let batches = 0;
  let epoch = 1;
  let adoptions = 0;
  const fence = { ...snapshot, userVisibilityEpoch: '1' };
  const context = {
    Date,
    assertCatalogSnapshotCurrent: async () => { assert.equal(fence.userVisibilityEpoch, String(epoch)); },
    adoptActiveCatalogUserVisibilityEpoch: async (_db, _source, _user, current) => {
      if (replacedOnPrune) throw Error('catalog generation changed');
      current.userVisibilityEpoch = String(epoch); adoptions++;
    },
    catalogGenerationRpcFence: fence => ({ p_generation_id: fence.generationId, p_head_revision: fence.headRevision, p_user_visibility_epoch: fence.userVisibilityEpoch }),
    withCatalogGenerationRows: (items, fence) => items.map(item => ({ ...item, generation_id: fence.generationId, write_head_revision: fence.headRevision })),
    throwDb: (error, message) => { throw new Error(`${message}: ${error.message}`); },
    clearCatalogGenerationMediaItems: async () => { calls.push({ op: 'clear' }); rows.clear(); },
  };
  const db = {
    from(table) {
      assert.equal(table, 'cloud_media_items');
      return { upsert(items) {
        batches++;
        calls.push({ op: 'upsert', count: items.length });
        return { async select() {
          if (batches === failBatch) return { error: { message: 'interrupted write' } };
          const saved = items.map(item => {
            const value = { ...rows.get(item.external_id), ...item, id: rows.get(item.external_id)?.id || `new-${item.external_id}` };
            rows.set(item.external_id, value);
            return value;
          });
          return { data: saved };
        } };
      } };
    },
    async rpc(name, args) {
      if (name.includes('prune')) assert.equal(args.p_user_visibility_epoch, String(epoch), 'each prune must use the newly committed cache epoch');
      calls.push({ op: name.includes('prune') ? 'prune' : 'clear', args });
      let removed = 0;
      for (const [id, row] of rows) {
        if (name.includes('delete') || row.catalog_version !== args.p_catalog_version) {
          if (removed >= args.p_limit) break;
          rows.delete(id); removed++;
        }
      }
      if (name.includes('prune') && removed) epoch++;
      return { data: removed };
    },
  };
  const persist = loadFunction(read(engine), 'replaceSourceItems', engine === 'norva-cloud' ? 'clearCatalogGenerationMediaItems' : 'getRuntimeConfig', context);
  return { rows, calls, adoptions: () => adoptions, run: (items, preserve = true) => persist('source', 'owner', items, db, fence, async () => {}, preserve) };
}

for (const engine of ['norva-source-sync', 'norva-cloud']) {
  test(`${engine}: multi-batch Selection reclassification adopts its own prune and rejects a replaced generation`, async () => {
    const h = persistenceHarness(engine);
    for (let i = 0; i < 260; i++) h.rows.set(`obsolete-${i}`, { id: `obsolete-${i}` });
    await h.run([{ external_id: 'keep', title: 'Kept film' }]);
    assert.equal(h.rows.size, 1);
    assert.equal(h.adoptions(), 3);
    const changed = persistenceHarness(engine, 0, true);
    await assert.rejects(changed.run([{ external_id: 'keep' }]), /catalog generation changed/);
  });
  test(`${engine}: Selection saves every batch before pruning and preserves retained IDs`, async () => {
    const h = persistenceHarness(engine);
    const items = [{ external_id: 'keep', title: 'Correct title' }, ...Array.from({ length: 500 }, (_, i) => ({ external_id: `item-${i}` }))];
    await h.run(items);
    assert.deepEqual(h.calls.map(c => c.op), ['upsert', 'upsert', 'prune']);
    assert.equal(h.rows.size, 501);
    assert.equal(h.rows.get('keep').id, 'stable-id');
    assert.equal(h.rows.get('keep').title, 'Correct title');
    assert.equal(h.rows.has('obsolete'), false);
    const prune = h.calls.at(-1).args;
    assert.equal(prune.p_source_id, 'source');
    assert.equal(prune.p_user_id, 'owner');
    assert.equal(prune.p_generation_id, 'generation');
    assert.equal(prune.p_head_revision, 3);
    assert.equal(prune.p_limit, 100);
    assert.equal(prune.p_catalog_version, h.rows.get('keep').catalog_version);
    assert.equal(h.rows.get('keep').write_head_revision, 3);
  });

  test(`${engine}: interrupted Selection persistence never clears or prunes the old catalogue`, async () => {
    const h = persistenceHarness(engine, 2);
    await assert.rejects(h.run(Array.from({ length: 501 }, (_, i) => ({ external_id: `item-${i}` }))), /interrupted write/);
    assert.deepEqual(h.calls.map(c => c.op), ['upsert', 'upsert']);
    assert.equal(h.rows.get('keep').id, 'stable-id');
    assert.equal(h.rows.get('obsolete').id, 'old-id');
  });

  test(`${engine}: ordinary playlists retain their existing replacement behavior`, async () => {
    const h = persistenceHarness(engine);
    await h.run([{ external_id: 'new' }], false);
    assert.deepEqual(h.calls.map(c => c.op), ['clear', 'upsert']);
    assert.equal(h.rows.size, 1);
    assert.equal(h.rows.get('new').catalog_version, undefined);
  });
}

async function runUnchangedSync(actualCount, playlistUrl = 'https://norva.tv/catalog/discovery.m3u') {
  let persisted = false;
  let preserve = null;
  let countRead = false;
  const entries = Array.from({ length: 3 }, (_, i) => ({ title: `Film ${i}`, url: `https://example.test/${i}.mp4`, tvgId: `id-${i}`, kind: 'movie' }));
  const context = {
    DISCOVERY_PLAYLIST_URL: 'https://norva.tv/catalog/discovery.m3u',
    stringOr: (value, fallback) => typeof value === 'string' ? value : fallback,
    compactRecord: value => value,
    assertCatalogSnapshotCurrent: async () => {},
    fetchDiscoverySelection: async () => ({ items: entries }),
    fetchM3uItems: async () => ({ items: entries }),
    discoveryCatalogFields: (_, item) => ({ item_type: item.kind }),
    computeContentSignature: async () => ({ same: true }),
    contentSignatureEquals: () => true,
    countRowsInTable: async () => { countRead = true; return actualCount; },
    replaceSourceItems: async (...args) => { persisted = true; preserve = args[6]; return args[2]; },
  };
  const sync = loadFunction(read('norva-source-sync'), 'syncM3uSource', 'replaceSourceItems', context);
  const result = await sync('source', 'owner', { playlistUrl }, {}, null, snapshot, async () => {}, { previousSignature: { same: true } });
  return { result, persisted, preserve, countRead };
}

test('an unchanged Selection signature cannot hide missing persisted rows', async () => {
  const h = await runUnchangedSync(1);
  assert.equal(h.result.skipped, undefined);
  assert.equal(h.result.finalizePending, true);
  assert.equal(h.persisted, true);
  assert.equal(h.preserve, true);
});

test('an intact Selection still skips redundant imports', async () => {
  const h = await runUnchangedSync(3);
  assert.equal(h.result.skipped, true);
  assert.equal(h.persisted, false);
});

test('ordinary unchanged playlists keep their existing signature shortcut', async () => {
  const h = await runUnchangedSync(1, 'https://example.test/provider.m3u');
  assert.equal(h.result.skipped, true);
  assert.equal(h.countRead, false);
});
