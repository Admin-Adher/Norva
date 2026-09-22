const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const unknown = 'CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN';
const ready = { id: sourceId, source_type: 'xtream', enabled: true, catalog_visible: true, deleted_at: null,
  config_revision: 3, visibility_epoch: 7, lifecycle_state: 'active', catalog_visibility: 'visible', sync_status: 'ready',
  config_hint: { syncProgress: { status: 'ready', startedAt: '2026-09-21T08:00:00Z', updatedAt: '2026-09-21T08:01:00Z' } } };
const syncing = { ...ready, sync_status: 'syncing', config_hint: { syncProgress: {
  status: 'syncing', stage: 'importing', startedAt: '2026-09-22T10:00:00Z', updatedAt: '2026-09-22T10:00:02Z' } } };
function response(status, body, epoch = 'v2.1.12') {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-norva-visibility-epoch': epoch } });
}
function browser(fetchImpl) {
  const values = new Map([['norva-cloud-token', 'synthetic-token']]);
  const location = { origin: 'https://norva.test', hostname: 'norva.test', search: '', pathname: '/app' };
  const window = { location, dispatchEvent() {}, addEventListener() {} };
  const context = { window, location, URL, URLSearchParams, Headers, Response, navigator: { language: 'fr', languages: ['fr'], userAgent: 'test' },
    AbortController, console, setTimeout, clearTimeout, document: { readyState: 'loading', dispatchEvent() {}, addEventListener() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }, fetch: fetchImpl };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/cloudApi.js'), 'utf8'), context);
  return window.NorvaCloud;
}
function harness({ before = [ready], after = [syncing], postCode = unknown, postEpoch = 'v2.1.12', currentEpoch = 'v2.1.13', readStatus = 200, postStatus = 409 } = {}) {
  const calls = []; let reads = 0;
  const cloud = browser(async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return response(postStatus, { details: { code: postCode } }, postEpoch);
    reads++;
    return reads === 1 ? response(200, { sources: before }) : response(readStatus, { sources: after }, currentEpoch);
  });
  return { cloud, calls };
}

test('ambiguous sync joins only the exact current durable run, bypasses warmed cache and never replays POST', async () => {
  const { cloud, calls } = harness();
  await cloud.sources.list();
  const result = await cloud.sources.sync(sourceId);
  assert.equal(result.source.id, sourceId); assert.equal(result.reconciled, true); assert.equal(result.syncStarted, true);
  assert.equal(calls.length, 3); assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  assert.equal(calls.at(-1).options.cache, 'no-store');
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer synthetic-token');
});

test('an already running exact source may join the same durable run; force does not replay a rebuild', async () => {
  const { cloud, calls } = harness({ before: [syncing] });
  assert.equal((await cloud.sources.sync(sourceId, { force: true })).reconciled, true);
  const posts = calls.filter(c => c.options.method === 'POST');
  assert.equal(posts.length, 1); assert.match(posts[0].url, /[?&]force=1/);
});

test('normal accepted sync remains server-authorized even when the prior source list differs', async () => {
  const { cloud, calls } = harness({ before: [], postStatus: 202, postCode: '' });
  await cloud.sources.sync(sourceId);
  assert.equal(calls.length, 2); assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
});

test('config, source visibility, lifecycle, replacement and global authority changes remain rejected', async () => {
  for (const changed of [
    { config_revision: 4 }, { visibility_epoch: 8 }, { lifecycle_state: 'replaced' },
    { replaced_by_source_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, { source_type: 'm3u' },
    { enabled: false }, { catalog_visible: false }, { deleted_at: '2026-09-22T10:00:01Z' },
  ]) {
    const { cloud, calls } = harness({ after: [{ ...syncing, ...changed }] });
    await assert.rejects(cloud.sources.sync(sourceId), e => e.status === 409);
    assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  }
  const { cloud } = harness({ currentEpoch: 'v2.2.13' });
  await assert.rejects(cloud.sources.sync(sourceId), e => e.status === 409);
});

test('missing, duplicate or merely similar sources cannot reconcile by name or host', async () => {
  for (const after of [[], [syncing, syncing], [{ ...syncing, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]]) {
    const { cloud, calls } = harness({ after });
    await assert.rejects(cloud.sources.sync(sourceId));
    assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  }
});

test('READY, idle, missing progress and an old run are not evidence that this sync started', async () => {
  for (const after of [ready, { ...syncing, sync_status: 'idle' }, { ...syncing, config_hint: {} },
    { ...syncing, config_hint: { syncProgress: { ...ready.config_hint.syncProgress, status: 'syncing' } } },
    { ...syncing, config_hint: { syncProgress: { ...syncing.config_hint.syncProgress, updatedAt: '2026-09-21T00:00:00Z' } } }]) {
    const { cloud, calls } = harness({ after: [after] });
    await assert.rejects(cloud.sources.sync(sourceId));
    assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  }
});

test('primary SOURCE_CATALOG_CHANGED is never reconciled, including an older response epoch', async () => {
  for (const postEpoch of ['v2.1.12', 'v2.1.10']) {
    const { cloud, calls } = harness({ postCode: 'SOURCE_CATALOG_CHANGED', postEpoch });
    await assert.rejects(cloud.sources.sync(sourceId), e => (e.payload?.details?.code || e.code) === 'SOURCE_CATALOG_CHANGED');
    assert.equal(calls.length, 2); assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  }
});

test('delayed ambiguous replies can reconcile, but failed proofs cannot fall through legacy stale UI handling', async () => {
  const good = harness({ postEpoch: 'v2.1.10' });
  assert.equal((await good.cloud.sources.sync(sourceId)).reconciled, true);
  const bad = harness({ postEpoch: 'v2.1.10', after: [ready] });
  await assert.rejects(bad.cloud.sources.sync(sourceId), e => e.code === 'SOURCE_SYNC_RECONCILIATION_FAILED');
  assert.equal(bad.calls.filter(c => c.options.method === 'POST').length, 1);
});

test('revoked or still stale reconciliation reads remain failures with no second POST', async () => {
  for (const options of [{ readStatus: 403 }, { currentEpoch: 'v2.1.10' }]) {
    const { cloud, calls } = harness(options);
    await assert.rejects(cloud.sources.sync(sourceId), e => e.status === 403 || e.code === 'SOURCE_SYNC_RECONCILIATION_FAILED');
    assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  }
});
