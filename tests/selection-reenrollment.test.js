const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const shared = name => import('../supabase/functions/_shared/' + name);

function database(rows) {
  return { reads: [], inserts: 0, from(table) {
    assert.equal(table, 'cloud_sources');
    const filters = []; let inserted, patch;
    const matching = () => rows.filter(row => filters.every(filter => filter(row)));
    const query = {
      select() { return this; },
      eq(key, value) { filters.push(row => row[key] === value); return this; },
      is(key, value) { filters.push(row => (row[key] ?? null) === value); return this; },
      order() { return this; },
      range: async (start, end) => { this.reads.push(start); return { data: matching().slice(start, end + 1), error: null }; },
      insert(row) { inserted = row; return this; },
      update(value) { patch = value; return this; },
      single: async () => {
        if (inserted) {
          this.inserts++;
          if (rows.some(row => row.id === inserted.id)) return { data: null, error: { code: '23505' } };
          rows.push({ enabled: true, deleted_at: null, ...inserted });
          return { data: { id: inserted.id }, error: null };
        }
        return { data: matching()[0] || null, error: null };
      },
      async maybeSingle() {
        const row = matching()[0];
        if (row && patch) Object.assign(row, patch);
        return { data: row ? { ...row } : null, error: null };
      },
    };
    return query;
  } };
}

async function fixture(initial = []) {
  const identity = await shared('discovery-catalog.mjs');
  const { selectionEnrollment } = await shared('selection-enrollment.mjs');
  const rows = structuredClone(initial), db = database(rows), events = [];
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const context = vm.createContext({ Request, URL, JSON, ...identity, selectionEnrollment, HttpError,
    readJson: request => request.json(), stringOr: (value, fallback) => typeof value === 'string' ? value : fallback,
    stringOrNull: value => typeof value === 'string' ? value : null,
    recordOrEmpty: value => value && typeof value === 'object' ? value : {}, compactRecord: value => value,
    buildSourceConfig: (_type, body) => ({ playlistUrl: body.url }),
    requireCloudAccess: async () => { events.push('access'); if (context.denyAccess) throw new HttpError(403, 'Access denied'); },
    requirePlanCapacity: async () => { events.push('capacity'); if (context.denyCapacity) throw new HttpError(403, 'Capacity reached'); },
    acknowledgeCatalogVisibilityEpochMutation: async () => events.push('visibility'),
    managedSourceSnapshot: async (id, owner) => {
      const row = rows.find(row => row.id === id && row.user_id === owner && !row.deleted_at);
      if (!row) throw new HttpError(404, 'Source not found');
      return { ...row };
    },
    assertOwnedSource: async (id, owner) => {
      assert.ok(rows.some(row => row.id === id && row.user_id === owner && !row.deleted_at));
    },
    summarizeSourceConnectionAttempt: async () => null, sourceAttemptClientContext: () => ({}),
    getRuntimeConfig: async () => ({}), validateCloudSource: async () => ({}),
    encryptSourceConfig: async () => 'fixture-ciphertext', buildSourceHint: () => ({}),
    sanitizeSourceValidation: value => value, scheduleSourceConnectionAttempt: () => {},
    waitUntil: promise => promise, syncCloudSource: async id => events.push('sync:' + id),
    throwDb: error => { throw Error(error.code || 'Database error'); },
  });
  const code = fs.readFileSync('supabase/functions/norva-cloud/index.ts', 'utf8');
  const extract = (start, end) => code.slice(code.indexOf(start), code.indexOf(end, code.indexOf(start)));
  const source = extract('async function createSource(', 'const SOURCE_ATTEMPT_CLIENT_WINDOW_MS')
    + extract('async function setSourceEnabled(', '// Check a source\'s connection')
    + '\nasync function routeSources(req,user,db) { const scope="sources",id=null,action=null; const url=new URL(req.url); '
    + extract('  if (scope === "sources")', '  if (scope === "media-items")') + '\n}';
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'strip' }), context);
  const click = () => context.routeSources(new Request('https://api.example.test/sources', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'm3u', name: 'Norva Selection', url: identity.DISCOVERY_PLAYLIST_URL }),
  }), { id: 'owner' }, db);
  return { rows, db, context, click, events };
}

test('Selection generations retain the legacy ID and reject other owners and forged IDs', async () => {
  const { discoverySourceId, discoverySourceGeneration, isDiscoverySourceId, retiredDiscoverySourceId } = await shared('discovery-catalog.mjs');
  const legacy = await discoverySourceId('owner');
  for (const generation of [0, 1, 2, 255, 0xffffffff]) {
    const id = await discoverySourceId('owner', generation);
    assert.equal(await discoverySourceGeneration(id, 'owner'), generation);
    assert.equal(await isDiscoverySourceId(id, 'other'), false);
    assert.equal(await isDiscoverySourceId((id[0] === 'a' ? 'b' : 'a') + id.slice(1), 'owner'), false);
    if (generation) assert.notEqual(id, legacy);
  }
  assert.equal(await isDiscoverySourceId(await retiredDiscoverySourceId('owner'), 'owner'), false);
  for (const value of [null, '', 'Norva Selection', {}, 1]) assert.equal(await isDiscoverySourceId(value, 'owner'), false);
  for (const generation of [-1, 1.5, NaN, 0x100000000]) await assert.rejects(discoverySourceId('owner', generation), /Invalid/);
});

test('real POST route creates a new incarnation after deletion and leaves the terminal row untouched', async () => {
  const { discoverySourceId } = await shared('discovery-catalog.mjs');
  const deleted = { id: await discoverySourceId('owner'), user_id: 'owner', source_type: 'm3u', enabled: true,
    deleted_at: '2026-09-08T11:34:15Z', sync_status: 'ready', config_hint: { cleanup: 'pending' } };
  const f = await fixture([deleted]);
  const result = await f.click();
  assert.equal(result.status, 201);
  assert.equal(result.body.source.id, await discoverySourceId('owner', 1));
  assert.equal(result.body.syncStarted, true);
  assert.deepEqual(f.rows[0], deleted);
  assert.deepEqual(f.events.filter(e => ['access', 'capacity', 'visibility'].includes(e)), ['access', 'capacity', 'visibility']);
  const again = await f.click();
  assert.equal(again.body.source.id, result.body.source.id);
  assert.equal(again.body.syncStarted, false);
  assert.equal(f.db.inserts, 1);
});

test('repeated delete/re-add and concurrent clicks never reuse tombstones or duplicate the current Selection', async () => {
  const { discoverySourceId } = await shared('discovery-catalog.mjs');
  const f = await fixture();
  const first = await f.click();
  assert.equal(first.body.source.id, await discoverySourceId('owner'));
  for (const generation of [1, 2, 3]) {
    f.rows.find(row => !row.deleted_at).deleted_at = '2026-09-09T10:00:00Z';
    const results = await Promise.all([f.click(), f.click()]);
    for (const result of results) assert.equal(result.body.source.id, await discoverySourceId('owner', generation));
    assert.equal(f.rows.filter(row => !row.deleted_at).length, 1);
  }
  assert.equal(f.rows.length, 4);
});

test('an explicitly requested paused Selection is reenabled once, with access and capacity still required', async () => {
  const { discoverySourceId } = await shared('discovery-catalog.mjs');
  const row = { id: await discoverySourceId('owner', 4), user_id: 'owner', source_type: 'm3u', enabled: false, deleted_at: null, sync_status: 'ready' };
  const denied = await fixture([row]); denied.context.denyCapacity = true;
  await assert.rejects(denied.click(), /Capacity/); assert.equal(denied.rows[0].enabled, false);
  const f = await fixture([row]);
  const result = await f.click();
  assert.equal(result.body.enabled, true); assert.equal(result.body.visibilityChanged, true);
  assert.equal(f.rows[0].enabled, true); assert.equal(f.db.inserts, 0);
  assert.ok(f.events.includes('capacity')); assert.ok(f.events.includes('visibility'));
  await f.click(); assert.equal(f.events.filter(event => event === 'visibility').length, 1);
  const noAccess = await fixture([row]); noAccess.context.denyAccess = true;
  await assert.rejects(noAccess.click(), /Access/); assert.equal(noAccess.rows[0].enabled, false);
});

test('enrolment scans all pages, binds to the owner and ignores names or client-shaped metadata', async () => {
  const { selectionEnrollment } = await shared('selection-enrollment.mjs');
  const { discoverySourceId } = await shared('discovery-catalog.mjs');
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: 'personal-' + i, user_id: 'owner', source_type: 'm3u', name: 'Norva Selection' }));
  rows.push({ id: await discoverySourceId('owner', 50), user_id: 'owner', source_type: 'm3u', deleted_at: 'yesterday' });
  rows.push({ id: await discoverySourceId('another', 90), user_id: 'owner', source_type: 'm3u', deleted_at: null });
  rows.push({ id: await discoverySourceId('owner', 99), user_id: 'another', source_type: 'm3u', deleted_at: null });
  const db = database(rows), result = await selectionEnrollment(db, 'owner');
  assert.equal(result.sourceId, await discoverySourceId('owner', 51));
  assert.equal(result.existing, null); assert.deepEqual(db.reads, [0, 1000]);
});

test('new Selection generations keep curated playback validation and refuse unreviewed media', async () => {
  const { discoverySourceId } = await shared('discovery-catalog.mjs');
  const { fetchDiscoverySelection, discoveryCatalogFields, resolveDiscoveryTarget } = await shared('discovery-sources.mjs');
  const { DISCOVERY_PLAYLIST_URL } = await shared('discovery-catalog.mjs');
  const { resolveSelectionLiveDelivery } = await shared('selection-live-delivery.mjs');
  const selection = await fetchDiscoverySelection({ includeVod: false });
  const row = discoveryCatalogFields(DISCOVERY_PLAYLIST_URL, selection.items[0]);
  const sourceId = await discoverySourceId('owner', 1);
  const input = { userId: 'owner', sourceId, itemType: 'live', itemId: row.external_id, ownedItem: row, metadata: row.metadata, targetUrl: row.playback_hint.targetUrl };
  assert.equal(await resolveDiscoveryTarget(input), input.targetUrl);
  assert.ok(await resolveSelectionLiveDelivery(input));
  assert.equal(await resolveSelectionLiveDelivery({ ...input, userId: 'another' }), null);
  await assert.rejects(resolveDiscoveryTarget({ ...input, targetUrl: 'https://evil.example/stream.m3u8' }), /unavailable/);
});
