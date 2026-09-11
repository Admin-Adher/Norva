// Intake only: no inference, transcription, provider URL or credential belongs
// here. The existing exact probe and strict worker remain authoritative.
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
