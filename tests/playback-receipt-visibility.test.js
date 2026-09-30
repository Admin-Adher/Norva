const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let receiptModule;
async function receipt() {
  return receiptModule ??= await import('../supabase/functions/_shared/playback-receipt-visibility.mjs');
}

function request() {
  return { signal: new AbortController().signal };
}

function visibilityConflict() {
  return Response.json({ details: { code: 'CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN' } }, { status: 409 });
}

test('an exact prepared playback receipt survives one concurrent progressive publication', async () => {
  const { bindCompletedPlaybackReceipt, finalizePlaybackReceiptResponse } = await receipt();
  const req = request();
  let refreshes = 0;
  let checks = 0;
  let cleanups = 0;
  let finalizations = 0;
  await bindCompletedPlaybackReceipt(req, {
    refreshEpoch: async () => { refreshes++; },
    assertSourceCurrent: async () => { checks++; },
    cleanup: async () => { cleanups++; },
  });
  const response = await finalizePlaybackReceiptResponse(req, async () =>
    ++finalizations === 1 ? visibilityConflict() : Response.json({ ok: true }));
  assert.equal(response.status, 200);
  assert.equal(refreshes, 2);
  assert.equal(checks, 2);
  assert.equal(finalizations, 2);
  assert.equal(cleanups, 0);
});

test('a changed source or exact target stops replay and retires the prepared lane', async () => {
  const { bindCompletedPlaybackReceipt, finalizePlaybackReceiptResponse } = await receipt();
  const req = request();
  let checks = 0;
  let cleanups = 0;
  let finalizations = 0;
  await bindCompletedPlaybackReceipt(req, {
    refreshEpoch: async () => {},
    assertSourceCurrent: async () => { if (++checks === 2) throw new Error('source changed'); },
    cleanup: async () => { cleanups++; },
  });
  const response = await finalizePlaybackReceiptResponse(req, async () => {
    finalizations++;
    return visibilityConflict();
  });
  assert.equal(response.status, 409);
  assert.equal(finalizations, 1);
  assert.equal(cleanups, 1);
});

test('a non-visibility error is never retried, and a perpetual race is bounded', async () => {
  const { bindCompletedPlaybackReceipt, finalizePlaybackReceiptResponse } = await receipt();
  const req = request();
  let finalizations = 0;
  let cleanups = 0;
  await bindCompletedPlaybackReceipt(req, {
    refreshEpoch: async () => {},
    assertSourceCurrent: async () => {},
    cleanup: async () => { cleanups++; },
  });
  const response = await finalizePlaybackReceiptResponse(req, async () => {
    finalizations++;
    return visibilityConflict();
  });
  assert.equal(response.status, 409);
  assert.equal(finalizations, 4);
  assert.equal(cleanups, 1);

  const other = request();
  await bindCompletedPlaybackReceipt(other, {
    refreshEpoch: async () => {},
    assertSourceCurrent: async () => {},
    cleanup: async () => { cleanups++; },
  });
  const failure = await finalizePlaybackReceiptResponse(other, async () => {
    finalizations++;
    return Response.json({ details: { code: 'SOURCE_CATALOG_CHANGED' } }, { status: 409 });
  });
  assert.equal(failure.status, 409);
  assert.equal(finalizations, 5);
  assert.equal(cleanups, 2);
});

async function playbackHandlerFixture({ epochs, revokeOnCheck = 0 }) {
  const { bindCompletedPlaybackReceipt, finalizePlaybackReceiptResponse } = await receipt();
  const {
    bindCatalogVisibilityEpoch,
    finalizeCatalogVisibilityResponse,
  } = await import('../supabase/functions/_shared/catalog-visibility-response.mjs');
  const source = fs.readFileSync(
    path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8',
  ).replace(/\r\n/g, '\n');
  const start = source.indexOf('Deno.serve(async (req) => {');
  const end = source.indexOf('\n\nasync function handleRequest', start);
  assert.ok(start >= 0 && end > start, 'exercise the real deployed Deno.serve wiring');
  let handler;
  const observed = { dispatches: 0, bodyReads: 0, creations: 0, sourceChecks: 0, cleanups: 0, epochReads: 0 };
  const db = {
    async rpc(name) {
      assert.equal(name, 'norva_catalog_cache_epoch_v2');
      const userEpoch = String(epochs[observed.epochReads++]);
      assert.notEqual(userEpoch, 'undefined', 'unexpected extra visibility read');
      return { data: {
        contract: 'catalog-cache-epoch-v2', globalEpoch: '1', userEpoch,
        cacheEpoch: `v2.1.${userEpoch}`,
      }, error: null };
    },
  };
  const handleRequest = async (req) => {
    observed.dispatches++;
    try {
      observed.bodyReads++;
      const body = JSON.parse(await req.text());
      assert.equal(body.itemId, 'movie-1');
      await bindCatalogVisibilityEpoch(req, 'fixture-owner', db);
      observed.creations++;
      await bindCompletedPlaybackReceipt(req, {
        refreshEpoch: () => bindCatalogVisibilityEpoch(req, 'fixture-owner', db),
        assertSourceCurrent: async () => {
          observed.sourceChecks++;
          if (observed.sourceChecks === revokeOnCheck) throw new Error('source revoked');
        },
        cleanup: async () => { observed.cleanups++; },
      });
      return Response.json({ session: { id: 'same-exact-session' } }, { status: 201 });
    } catch (_) {
      // Match handleRequest's public failure envelope: a second req.text() used
      // to turn a successfully prepared lane into a 500, followed by cleanup.
      return Response.json({ error: 'Playback unavailable' }, { status: 500 });
    }
  };
  new Function('Deno', 'finalizePlaybackReceiptResponse', 'finalizeCatalogVisibilityResponse',
    'handleRequest', 'supabase', 'corsHeaders', source.slice(start, end))(
    { serve(callback) { handler = callback; } }, finalizePlaybackReceiptResponse,
    finalizeCatalogVisibilityResponse, handleRequest, db, () => ({}),
  );
  const req = new Request('https://edge.test/playback/session', {
    method: 'POST', body: JSON.stringify({ itemId: 'movie-1' }),
  });
  const response = await handler(req);
  return { response, observed, req };
}

test('real playback dispatch reads and creates once across repeated visibility finalization races', async () => {
  const { response, observed, req } = await playbackHandlerFixture({
    epochs: [10, 10, 11, 11, 12, 12, 12],
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { session: { id: 'same-exact-session' } });
  assert.equal(response.headers.get('x-norva-visibility-epoch'), 'v2.1.12');
  assert.equal(req.bodyUsed, true);
  assert.deepEqual(observed, {
    dispatches: 1, bodyReads: 1, creations: 1, sourceChecks: 3, cleanups: 0, epochReads: 7,
  });
});

test('real playback dispatch still retires the exact receipt when authority changes during finalization', async () => {
  const { response, observed } = await playbackHandlerFixture({
    epochs: [10, 10, 11, 11], revokeOnCheck: 2,
  });
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.details.code, 'CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN');
  assert.equal(payload.session, undefined);
  assert.deepEqual(observed, {
    dispatches: 1, bodyReads: 1, creations: 1, sourceChecks: 2, cleanups: 1, epochReads: 4,
  });
});
