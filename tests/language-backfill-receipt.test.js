const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

async function fixture({ epochs = [1, 2, 2], revokeAt = 0, accessRevoked = false, failBatch = false, token = 'test-only', lane = 'providerMetadataOnly' } = {}) {
  const visibility = await import('../supabase/functions/_shared/catalog-visibility-response.mjs');
  const receipts = await import('../supabase/functions/_shared/playback-receipt-visibility.mjs');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
  const start = source.indexOf('async function runAudioBackfill(');
  const end = source.indexOf('\nasync function claimProviderFileProbeStrict(', start);
  const counts = { batches: 0, fences: 0, epochs: 0 };
  const db = { async rpc(name) {
    if (name === 'feature_flag') return { data: false };
    assert.equal(name, 'norva_catalog_cache_epoch_v2');
    const epoch = String(epochs[counts.epochs++]);
    assert.notEqual(epoch, 'undefined');
    return { data: { contract: 'catalog-cache-epoch-v2', userEpoch: epoch, globalEpoch: '1', cacheEpoch: `v2.1.${epoch}` }, error: null };
  }};
  const context = vm.createContext({
    Deno: { env: { get: () => 'test-only' } },
    HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
    recordOrEmpty: v => v && typeof v === 'object' ? v : {},
    stringOr: (v, f) => typeof v === 'string' ? v : f,
    sourceCatalogVisible: async () => true,
    bindCatalogVisibilityEpochShared: visibility.bindCatalogVisibilityEpoch,
    bindCompletedPlaybackReceipt: receipts.bindCompletedPlaybackReceipt,
    readActiveCatalogGenerationSnapshot: async () => ({ generation: 'original' }),
    assertSourceCatalogVisible: async () => {},
    assertActiveCatalogGenerationCurrent: async (_db, sourceId, userId, snapshot) => {
      assert.equal(sourceId, 'source'); assert.equal(userId, 'owner'); assert.equal(snapshot.generation, 'original');
      if (++counts.fences === revokeAt) throw new Error('source changed');
    },
    requireAutomaticLanguageEnrichmentAccess: async () => { if (accessRevoked) throw new Error('access revoked'); },
    runOneDimension: async () => { counts.batches++; if (failBatch) throw new Error('batch failed'); return { processed: 32, identified: 10 }; },
  });
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
  const req = new Request('https://edge.test/audio-backfill', { method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId: 'owner', sourceId: 'source', type: 'movie', [lane]: true }) });
  let prepared;
  try { prepared = Response.json(await context.runAudioBackfill(req, db)); }
  catch (e) { return { failure: e.message, counts }; }
  const response = await receipts.finalizePlaybackReceiptResponse(req, () => visibility.finalizeCatalogVisibilityResponse(req, prepared.clone(), db));
  return { response, counts };
}

for (const lane of ['providerMetadataOnly', 'automaticUnknowns']) {
  test(`${lane}: completed work survives its own cache publication and is executed once`, async () => {
    const r = await fixture({ lane, epochs: [1, 2, 3, 3, 3] });
    assert.equal(r.response.status, 200); assert.equal(r.counts.batches, 1); assert.equal(r.counts.fences, 2);
    assert.equal((await r.response.json()).processed, 32);
  });
}
test('a source cutover after work prevents receipt confirmation', async () => {
  const r = await fixture({ revokeAt: 1 });
  assert.equal(r.failure, 'source changed'); assert.equal(r.counts.batches, 1);
});
test('a source cutover during finalization is rejected without rerunning provider work', async () => {
  const r = await fixture({ epochs: [1, 2, 3, 3], revokeAt: 2 });
  assert.equal(r.response.status, 409); assert.equal(r.counts.batches, 1);
});
test('revocation, failed work and invalid token cannot obtain a completed receipt', async () => {
  assert.equal((await fixture({ accessRevoked: true })).failure, 'access revoked');
  assert.equal((await fixture({ failBatch: true })).failure, 'batch failed');
  const invalid = await fixture({ token: 'invalid' });
  assert.equal(invalid.failure, 'Unauthorized'); assert.equal(invalid.counts.batches, 0);
});
