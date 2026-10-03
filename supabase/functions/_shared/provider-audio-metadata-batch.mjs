// Metadata only: no media download, probe or speech job can be appended here.
// Each claim rechecks capacity; the existing provider operation owns the same
// viewer/circuit/identity guards as other background requests.
export async function runProviderAudioMetadataBatch({ claim, read, finish, now = Date.now,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), maximum = 32, budgetMs = 35_000 }) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 32
      || !Number.isFinite(budgetMs) || budgetMs < 0 || budgetMs > 35_000) throw new Error('Invalid metadata budget');
  const deadline = now() + budgetMs;
  const total = { mode: 'provider-audio-metadata', processed: 0, attempted: 0,
    identified: 0, inconclusive: 0, failed: 0, deferred: 0, scanned: 0, hasMore: true };
  for (let step = 0; step < maximum && now() < deadline; step++) {
    const item = await claim();
    total.scanned += Math.max(0, Number(item.scanned) || 0);
    if (!item.variantId) {
      if (item.skipped || item.hasMore === false || !item.scanned) {
        total.hasMore = item.hasMore !== false;
        if (item.skipped) total.skipped = item.skipped;
        break;
      }
      continue;
    }
    const started = now();
    let outcome;
    try {
      const result = await read(item);
      total.attempted += Number(result?.attempted) > 0 ? 1 : 0;
      const code = safeCode(result?.stopped || result?.skipped, 'metadata-state-retry');
      if (Number(result?.persisted) > 0) outcome = { state: 'identified', code: 'declared-track-languages' };
      else if (code === 'metadata-no-language') outcome = { state: 'inconclusive', code };
      else outcome = { state: /invalid|not-found/.test(code) ? 'failed' : 'deferred', code,
        uncertain: Number(result?.attempted) > 0 && result?.transportCompleted !== true };
    } catch (error) {
      outcome = { state: 'failed', code: safeCode(error?.details?.code || error?.code, 'metadata-request-failed'), uncertain: true };
    }
    // One durable ACK. A failed ACK retains the lease; do not continue with a
    // second provider request whose first operation cannot be accounted for.
    await finish(item, outcome);
    total.processed++;
    total[outcome.state]++;
    if (outcome.state === 'deferred' || outcome.uncertain) {
      total.skipped = outcome.code;
      break;
    }
    // Empty metadata is a completed lookup, not a reason to stop this source.
    // <= 1 request/s/account, even when the supplier is unusually fast.
    const remaining = Math.max(0, 1000 - (now() - started));
    if (remaining) await pause(remaining);
  }
  return total;
}

function safeCode(value, fallback) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,100}$/.test(value) ? value : fallback;
}

export function providerMetadataFleetTurn(dispatchCount) {
  const count = Number.isSafeInteger(dispatchCount) && dispatchCount >= 0 ? dispatchCount : 0;
  return { metadata: count % 2 === 0, lane: Math.floor(count / 2) % 12 };
}
