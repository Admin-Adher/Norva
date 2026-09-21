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
    completedReceipts.set(req, cleanup);
  } catch (error) {
    await cleanup().catch(() => null);
    throw error;
  }
}

// The final cache fence still runs. If it rejects a prepared receipt, retire
// the exact lane that the client never received instead of leaking its lease.
export async function finalizePlaybackReceiptResponse(req, finalize) {
  try {
    const response = await finalize();
    if (response.status >= 400) {
      await completedReceipts.get(req)?.().catch(() => null);
    }
    return response;
  } catch (error) {
    await completedReceipts.get(req)?.().catch(() => null);
    throw error;
  } finally {
    completedReceipts.delete(req);
  }
}
