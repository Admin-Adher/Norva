// A prepared playback lane is a receipt, not a catalogue result assembled
// across a long provider read. Refresh its cache binding only after startup,
// then require the original source authority snapshot to remain current.
const completedReceipts = new WeakMap();

export async function bindCompletedPlaybackReceipt(req, {
  refreshEpoch,
  assertSourceCurrent,
  cleanup,
}) {
  try {
    await refreshEpoch();
    await assertSourceCurrent();
    if (req.signal.aborted) throw new DOMException('Playback cancelled', 'AbortError');
    completedReceipts.set(req, { refreshEpoch, assertSourceCurrent, cleanup });
  } catch (error) {
    await cleanup().catch(() => null);
    throw error;
  }
}

async function isVisibilityRace(response) {
  if (response.status !== 409) return false;
  try {
    const body = await response.clone().json();
    return body?.details?.code === 'CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN';
  } catch (_) {
    return false;
  }
}

// An active progressive import can publish another title between the receipt
// check and the final response fence. Rebind only the same exact playback
// receipt, then retry the final fence a bounded number of times.
export async function finalizePlaybackReceiptResponse(req, finalize) {
  try {
    let response = await finalize();
    for (let attempt = 0; attempt < 3 && await isVisibilityRace(response); attempt++) {
      const receipt = completedReceipts.get(req);
      if (!receipt) break;
      try {
        await receipt.refreshEpoch();
        await receipt.assertSourceCurrent();
        if (req.signal.aborted) break;
      } catch (_) {
        break;
      }
      response = await finalize();
    }
    if (response.status >= 400) {
      await completedReceipts.get(req)?.cleanup().catch(() => null);
    }
    return response;
  } catch (error) {
    await completedReceipts.get(req)?.cleanup().catch(() => null);
    throw error;
  } finally {
    completedReceipts.delete(req);
  }
}
