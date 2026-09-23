const test = require('node:test');
const assert = require('node:assert/strict');

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
