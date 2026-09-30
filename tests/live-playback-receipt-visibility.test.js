'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');
const { importTypescriptModule } = require('./helpers/import-typescript-module');

const root = path.resolve(__dirname, '..');
const edge = fs.readFileSync(path.join(root, 'supabase/functions/norva-playback/index.ts'), 'utf8').replace(/\r\n/g, '\n');
const generationModule = importTypescriptModule(path.join(root, 'supabase/functions/_shared/catalog-generation.ts'));
const OWNER = 'fixture-owner';
const SOURCE = 'fixture-source';
const ITEM = '985192';
const ROW = 'exact-visible-live-row';
const SESSION = 'same-prepared-live-session';
const TARGET = 'https://provider.invalid/live-fixture';

function between(start, end) {
  const from = edge.indexOf(start);
  const to = edge.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `real production block exists: ${start}`);
  return edge.slice(from, to);
}

const receiptBinding = between('  const bindPreparedPlaybackReceipt = async (', '\n  if (mode === "direct")');
const dispatch = between('Deno.serve(async (req) => {', '\n\nasync function handleRequest');
const sourceAndDeviceChecks = between('async function sourceCatalogVisible(', '\nasync function getRuntimeConfig(');

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

// Keep the real per-item receipt binding, generation checks and both response
// finalizers together. Only database storage and the already-prepared transport
// are simulated: this fixture never contacts a provider or opens a video.
async function liveFixture({
  epochs = [10, 10, 11, 11, 12, 12, 12],
  mutateOnRebind,
  ownedItemId = ROW,
} = {}) {
  const receipt = await import('../supabase/functions/_shared/playback-receipt-visibility.mjs');
  const visibility = await import('../supabase/functions/_shared/catalog-visibility-response.mjs');
  const { adoptActiveCatalogUserVisibilityEpoch } = await generationModule;
  const initialGeneration = {
    kind: 'active', generationId: '11111111-1111-4111-8111-111111111111',
    headRevision: '1', configRevision: '1', sourceVisibilityEpoch: '1', userVisibilityEpoch: '10',
  };
  const state = {
    globalEpoch: '1', userEpoch: '10', generation: { ...initialGeneration },
    sourceVisible: true, rowVisible: true, deviceValid: true, target: TARGET,
    row: { id: ROW, user_id: OWNER, source_id: SOURCE, item_type: 'live', external_id: ITEM },
  };
  const observed = { dispatches: 0, bodyReads: 0, creations: 0, epochReads: 0,
    generationChecks: 0, itemChecks: 0, targetChecks: 0, deviceChecks: 0, cleanups: [] };
  const db = {
    async rpc(name, args) {
      if (name === 'norva_catalog_cache_epoch_v2') {
        assert.equal(args.p_user_id, OWNER);
        observed.epochReads++;
        if (observed.epochReads === 4) mutateOnRebind?.(state);
        state.userEpoch = String(epochs[Math.min(observed.epochReads - 1, epochs.length - 1)]);
        return { data: { contract: 'catalog-cache-epoch-v2', globalEpoch: state.globalEpoch,
          userEpoch: state.userEpoch, cacheEpoch: `v2.${state.globalEpoch}.${state.userEpoch}` }, error: null };
      }
      assert.equal(args.p_user_id, OWNER);
      assert.equal(args.p_source_id, SOURCE);
      if (name === 'norva_get_catalog_write_snapshot') {
        observed.generationChecks++;
        return { data: { ...state.generation, userVisibilityEpoch: state.userEpoch,
          isCatalogVisible: state.sourceVisible }, error: null };
      }
      assert.equal(name, 'norva_source_catalog_visible');
      return { data: state.sourceVisible, error: null };
    },
    from(table) {
      const filters = {};
      const query = {
        select(columns) { assert.equal(columns, 'id'); return query; },
        eq(key, value) { filters[key] = value; return query; },
        async maybeSingle() {
          if (table === 'cloud_devices') {
            observed.deviceChecks++;
            assert.deepEqual(filters, { id: 'fixture-device', user_id: OWNER, revoked: false });
            return { data: state.deviceValid ? { id: 'fixture-device' } : null, error: null };
          }
          assert.equal(table, 'cloud_catalog_visible_media_items');
          observed.itemChecks++;
          assert.deepEqual(filters, { id: ROW, user_id: OWNER, source_id: SOURCE,
            item_type: 'live', external_id: ITEM });
          const matches = state.rowVisible && Object.entries(filters).every(([k, v]) => state.row[k] === v);
          return { data: matches ? { id: ROW } : null, error: null };
        },
      };
      return query;
    },
  };
  const sha256Hex = async value => createHash('sha256').update(value).digest('hex');
  const req = new Request('https://edge.invalid/playback/session', {
    method: 'POST', body: JSON.stringify({ sourceId: SOURCE, itemType: 'live', itemId: ITEM }),
  });
  const context = vm.createContext({
    req, db, resolved: { itemCas: ownedItemId ? { id: ownedItemId } : null },
    itemType: 'live', episodeCoordinates: null, parentSeriesId: null, sourceId: SOURCE, userId: OWNER,
    itemId: ITEM, deviceId: 'fixture-device', playbackGeneration: { ...initialGeneration },
    requestedPlaybackHint: {}, targetUrlHash: await sha256Hex(TARGET),
    HttpError, sourceConfigCache: new Map(),
    recordOrEmpty: value => value && typeof value === 'object' ? value : {},
    stringOrNull: value => typeof value === 'string' && value.trim() ? value : null,
    throwDb: error => { throw error; },
    ...receipt,
    catalogVisibilityEpochHeaders: visibility.catalogVisibilityEpochHeaders,
    bindCatalogVisibilityEpochShared: visibility.bindCatalogVisibilityEpoch,
    adoptActiveCatalogUserVisibilityEpoch,
    sha256Hex,
    async hasVisibleSeriesEpisodeReceiptProof() { assert.fail('Live must use its exact channel row'); },
    async resolveCatalogSeriesEpisodeCoordinates() { assert.fail('Live is not an episode'); },
    async resolveExactEpisodePlaybackTarget() { assert.fail('Live is not an episode'); },
    async resolvePlaybackTarget(source, type, item, owner, client) {
      observed.targetChecks++;
      assert.deepEqual([source, type, item, owner], [SOURCE, 'live', ITEM, OWNER]);
      assert.equal(client, db);
      return { targetUrl: state.target };
    },
  });
  const bind = vm.runInContext(stripTypeScriptTypes(sourceAndDeviceChecks + '\n' + receiptBinding)
    + '\nbindPreparedPlaybackReceipt;', context);
  const handleRequest = async request => {
    observed.dispatches++;
    try {
      observed.bodyReads++;
      const body = JSON.parse(await request.text());
      assert.equal(body.itemType, 'live');
      await visibility.bindCatalogVisibilityEpoch(request, OWNER, db);
      observed.creations++;
      await bind(async () => { observed.cleanups.push(SESSION); });
      return Response.json({ session: { id: SESSION }, playback: { mode: 'transcode', url: 'https://gateway.invalid/fixture.m3u8' } }, { status: 201 });
    } catch (error) {
      return Response.json({ error: error.message }, { status: error.status || 500 });
    }
  };
  let handler;
  new Function('Deno', 'finalizePlaybackReceiptResponse', 'finalizeCatalogVisibilityResponse',
    'handleRequest', 'supabase', 'corsHeaders', dispatch)(
    { serve(callback) { handler = callback; } }, receipt.finalizePlaybackReceiptResponse,
    visibility.finalizeCatalogVisibilityResponse, handleRequest, db, () => ({}),
  );
  return { response: await handler(req), observed, req };
}

test('real Live receipt survives unrelated publications without recreating or abandoning the prepared HLS lane', async () => {
  const { response, observed, req } = await liveFixture();
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-norva-visibility-epoch'), 'v2.1.12');
  assert.equal((await response.json()).session.id, SESSION);
  assert.equal(req.bodyUsed, true);
  assert.deepEqual(observed, { dispatches: 1, bodyReads: 1, creations: 1, epochReads: 7,
    generationChecks: 6, itemChecks: 3, targetChecks: 3, deviceChecks: 3, cleanups: [] });
});

for (const [name, mutate] of [
  ['source removal', state => { state.sourceVisible = false; }],
  ['configuration revision change', state => { state.generation.configRevision = '2'; }],
  ['active generation replacement', state => { state.generation.generationId = '22222222-2222-4222-8222-222222222222'; }],
  ['channel removal', state => { state.rowVisible = false; }],
  ['channel reassigned to another owner', state => { state.row.user_id = 'another-owner'; }],
  ['channel URL change', state => { state.target = 'https://provider.invalid/changed'; }],
  ['device revocation', state => { state.deviceValid = false; }],
  ['global policy change', state => { state.globalEpoch = '2'; }],
]) {
  test(`Live authority change during finalization fails closed and cleans its exact receipt: ${name}`, async () => {
    const { response, observed } = await liveFixture({ mutateOnRebind: mutate });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.details.code, 'CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN');
    assert.equal(payload.session, undefined);
    assert.equal(payload.playback, undefined);
    assert.equal(observed.creations, 1);
    assert.equal(observed.bodyReads, 1);
    assert.deepEqual(observed.cleanups, [SESSION]);
  });
}

test('Live without an exact owned channel receipt fails closed and retires its prepared session', async () => {
  const { response, observed } = await liveFixture({ ownedItemId: null, epochs: [10, 10] });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).session, undefined);
  assert.equal(observed.creations, 1);
  assert.deepEqual(observed.cleanups, [SESSION]);
});

test('perpetual unrelated publication is bounded and retires the Live receipt without another session creation', async () => {
  const { response, observed } = await liveFixture({ epochs: [10, 10, 11, 11, 12, 12, 13, 13, 14] });
  assert.equal(response.status, 409);
  assert.equal(observed.epochReads, 9);
  assert.equal(observed.creations, 1);
  assert.deepEqual(observed.cleanups, [SESSION]);
});
