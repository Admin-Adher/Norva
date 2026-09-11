// Intake only: no inference, transcription, provider URL or credential belongs
// here. The existing exact probe and strict worker remain authoritative.
// No timer or detached recursion: an ordinary fleet tick can consume a small
// batch while its existing lifetime has room. Each item still obtains fresh
// access, capacity and distributed source/account claims. A blocked provider
// ends this batch; the fleet dispatcher remains responsible for other sources.
export async function processAutomaticVodLanguageBatch({ runOne, now = Date.now, maximum = 4, budgetMs = 60_000 }) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 4 || !Number.isFinite(budgetMs)
    || budgetMs < 0 || budgetMs > 60_000) throw new Error('Invalid metadata batch budget');
  const deadline = now() + budgetMs;
  const totals = { protocol: 1, mode: 'automatic-language', processed: 0, attempted: 0,
    queued: 0, identified: 0, verified: 0, deferred: 0, failed: 0, scanned: 0, steps: 0, hasMore: true };
  for (let index = 0; index < maximum; index++) {
    // Do not begin a second provider operation with less than one ordinary
    // bounded probe + cleanup allowance left. This is a dispatch bound; the
    // existing probe itself retains its own request and provider-drain budgets.
    if (index > 0 && now() + 30_000 > deadline) break;
    const result = await runOne();
    totals.steps++;
    for (const key of ['processed', 'attempted', 'queued', 'identified', 'verified', 'deferred', 'failed', 'scanned']) {
      if (Number.isSafeInteger(result[key]) && result[key] > 0) totals[key] += result[key];
    }
    for (const key of ['outcome', 'code', 'skipped', 'exhausted', 'hasMore']) {
      if (result[key] !== undefined) totals[key] = result[key];
      else if (['outcome', 'code', 'skipped', 'exhausted'].includes(key)) delete totals[key];
    }
    if (result.skipped || result.exhausted || result.hasMore === false || result.deferred > 0 || result.failed > 0) break;
    if (!(result.processed > 0) && !(result.scanned > 0)) break;
  }
  return totals;
}

export async function processAutomaticVodLanguageFile({ claim, inspect, probe, enqueue, finish }) {
  let attempted = false;
  let outcome;
  try {
    let file = await inspect();
    if (!file.current) outcome = { state: 'deferred', code: 'source-changed' };
    else {
      if (file.needsProbe) {
        const result = await probe();
        attempted = Number(result.attempted) > 0;
        const blocked = result.skipped || result.stopped;
        if (blocked) outcome = { state: 'deferred', code: safeCode(blocked, 'provider-busy') };
        else if (!(Number(result.persisted) > 0)) outcome = { state: 'failed', code: 'profile-not-persisted' };
        else file = await inspect();
      }
      if (!outcome) {
        if (!file.current) outcome = { state: 'deferred', code: 'source-changed' };
        else if (file.verified) outcome = { state: 'verified', code: 'exact-certificate-reused' };
        else if (file.identified) outcome = { state: 'identified', code: 'declared-track-languages' };
        else if (!file.ready) outcome = { state: 'unsupported', code: 'strict-profile-insufficient' };
        else outcome = await enqueue(file)
          ? { state: 'queued', code: 'strict-analysis-queued' }
          : { state: 'deferred', code: 'strict-analysis-deferred' };
      }
    }
  } catch (error) {
    // Failed transport cannot prove that no provider operation started. Spend
    // one of the three intake attempts and keep the ordinary provider lease.
    const code = safeCode(error?.code ?? error?.details?.code, 'intake-request-failed');
    const deferred = /busy|circuit|quota|limited|revoked|changed|retry/.test(code);
    outcome = { state: deferred ? 'deferred' : 'failed', code };
    if (!deferred) attempted = true;
  }
  // Exactly one acknowledgement. A failed ACK leaves the durable 20m lease
  // intact; it must not become a second attempt in this process.
  await finish({ ...outcome, attempted });
  return {
    protocol: 1, mode: 'automatic-language', processed: 1,
    attempted: attempted ? 1 : 0,
    queued: outcome.state === 'queued' ? 1 : 0,
    identified: outcome.state === 'identified' ? 1 : 0,
    verified: outcome.state === 'verified' ? 1 : 0,
    deferred: outcome.state === 'deferred' ? 1 : 0,
    failed: outcome.state === 'failed' || outcome.state === 'unsupported' ? 1 : 0,
    outcome: outcome.state, code: outcome.code, hasMore: true,
    scanned: Number(claim.scanned) || 0,
  };
}

function safeCode(value, fallback) {
  const code = typeof value === 'string' ? value.toLowerCase() : '';
  return /^[a-z0-9_-]{1,100}$/.test(code) ? code : fallback;
}
