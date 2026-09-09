const test = require('node:test');
const assert = require('node:assert/strict');
const shared = () => import('../supabase/functions/_shared/source-public-view.mjs');

test('committed ready status settles a late heartbeat for both management and catalogue readers', async () => {
  const { sanitizeSource, sanitizeCatalogSource } = await shared();
  const source = { id: 'owned-source', sync_status: 'ready', config_hint: {
    syncProgress: { status: 'syncing', stage: 'building_titles', percent: 90,
      counts: { movies: 7404, series: 272, live: 21 },
      steps: { import: { status: 'done', count: 7697 }, finalize: { status: 'running', password: 'private' } },
      password: 'private' },
    finalizeCursor: { phase: 'complete', offset: 0 }, providerSecret: 'private',
  } };
  const original = structuredClone(source);
  for (const sanitize of [sanitizeSource, sanitizeCatalogSource]) {
    const result = sanitize(source), progress = result.config_hint.syncProgress;
    assert.equal(progress.status, 'ready');
    assert.equal(progress.stage, 'ready');
    assert.equal(progress.percent, 100);
    assert.equal(progress.steps.finalize.status, 'done');
    assert.equal(progress.steps.import.count, 7697);
    assert.deepEqual(progress.counts, { movies: 7404, series: 272, live: 21 });
    assert.equal(progress.liveReady, true);
    assert.equal('finalizeCursor' in result.config_hint, false);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
  assert.deepEqual(source, original);
});

test('pending and failed sources never gain completion from progress normalization', async () => {
  const { sanitizeSource, sanitizeCatalogSource, sanitizeSourceConfigHint } = await shared();
  const hint = { syncProgress: { status: 'syncing', stage: 'building_titles', percent: 86,
    steps: { finalize: { status: 'running' } } }, finalizeCursor: { phase: 'titles', offset: 300 } };
  for (const status of ['syncing', 'error', 'idle', undefined]) {
    for (const sanitize of [sanitizeSource, sanitizeCatalogSource]) {
      const result = sanitize({ sync_status: status, config_hint: hint });
      assert.equal(result.config_hint.syncProgress.percent, 86);
      assert.equal(result.config_hint.syncProgress.steps.finalize.status, 'running');
      assert.equal(result.config_hint.finalizeCursor.offset, 300);
      assert.equal(result.config_hint.syncProgress.usable, undefined);
    }
  }
  assert.equal(sanitizeSourceConfigHint({ ...hint, sync_status: 'ready' }).syncProgress.percent, 86);
});

test('legacy ready sources without a heartbeat expose completed progress without invented counts', async () => {
  const { sanitizeSource } = await shared();
  const progress = sanitizeSource({ sync_status: 'ready' }).config_hint.syncProgress;
  assert.equal(progress.percent, 100);
  assert.equal(progress.counts, undefined);
  assert.equal(progress.steps.finalize.status, 'done');
});
