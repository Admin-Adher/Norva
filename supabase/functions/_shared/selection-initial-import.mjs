// Persist the durable continuation before releasing the import transport lease.
// A failed invocation can then be resumed by the existing watchdog without
// downloading the Selection again or restarting an unbounded projection.
export async function handoffSelectionFinalization({
  db, sourceId, userId, generation, assertCurrent, releaseTransport, invokeFinalizer,
}) {
  const stale = () => Object.assign(new Error('Catalog generation changed during Selection handoff'), {
    code: 'CATALOG_GENERATION_SUPERSEDED',
  });
  await assertCurrent();
  const { data: source, error: readError } = await db.from('cloud_sources')
    .select('config_hint,updated_at').eq('id', sourceId).eq('user_id', userId)
    .eq('enabled', true).is('deleted_at', null).maybeSingle();
  if (readError) throw readError;
  if (!source?.updated_at) throw stale();
  const hint = source.config_hint || {};
  const progress = hint.syncProgress || {};
  if (progress.steps?.import?.status !== 'done' || !(Number(progress.counts?.total) > 0)) {
    throw new Error('Selection raw import is not complete');
  }
  await assertCurrent();
  const { data: saved, error } = await db.from('cloud_sources').update({
    sync_status: 'syncing',
    sync_error: null,
    config_hint: {
      ...hint,
      m3uFinalize: m3uFinalizeProof(generation, progress),
      finalizeCursor: { phase: Number(progress.counts?.movies || 0) + Number(progress.counts?.series || 0) > 0 ? 'titles' : 'live', offset: 0, afterId: '' },
      syncProgress: { ...progress, moviesReady: progress.moviesReady === true,
        seriesReady: progress.seriesReady === true,
        browseReady: progress.moviesReady === true || progress.seriesReady === true,
        usable: false, liveReady: false },
    },
  }).eq('id', sourceId).eq('user_id', userId).eq('enabled', true).is('deleted_at', null)
    // Revisions live in the lifecycle table, not cloud_sources. The canonical
    // generation assertion checks them before/after this write; updated_at
    // prevents overwriting a concurrent source/config/progress change.
    .eq('updated_at', source.updated_at)
    .select('id').maybeSingle();
  if (error) throw error;
  if (!saved) throw stale();
  await assertCurrent();
  await releaseTransport();
  await invokeFinalizer();
}

// Keep the old first argument for callers outside the finalizer. Every catalogue
// now gets a small first slice; identity never selects a different batch policy.
export function initialTitleBatchLimit(_isSelection, firstSliceReady, activeFinalizers) {
  if (!firstSliceReady || !Number.isSafeInteger(activeFinalizers) || activeFinalizers < 1) return 60;
  return activeFinalizers === 1 ? 150 : activeFinalizers === 2 ? 100 : 60;
}

// The lease table stays private. This service-only RPC exposes one aggregate,
// using the same database clock/expiry boundary as the durable lease claims.
export async function activeFinalizeLeaseCount(db) {
  try {
    const { data, error } = await db.rpc('norva_active_source_finalize_lease_count');
    return !error && Number.isSafeInteger(data) && data >= 1 ? data : null;
  } catch (_) {
    return null;
  }
}

// A concurrent catalogue metadata writer can advance the account-wide cache
// epoch without changing this source's authority. Revalidate the complete
// snapshot and retry one idempotent raw batch only when that epoch advanced.
// adopt() must reject any source/config/head/generation change.
export async function writeSelectionBatch({ generation, adopt, write }) {
  await adopt();
  const epoch = generation.userVisibilityEpoch;
  let result = await write();
  if (!['42501', 'PT409', '40001'].includes(result.error?.code)) return result;
  await adopt();
  if (generation.userVisibilityEpoch === epoch) return result;
  result = await write();
  return result;
}

// Seed a small, identifiable first page before walking the UUID-ordered raw
// catalogue. Otherwise thousands of un-enriched rows can precede the few titles
// whose existing shared metadata already supplies a proper Home backdrop.
export function selectionStarterRows(rows) {
  const seen = new Set();
  const counts = { movie: 0, series: 0 };
  const limits = { movie: 12, series: 4 };
  return rows.filter(row => {
    const type = row.item_type;
    const tmdbId = String(row.metadata?.providerTmdbId || '');
    if (!limits[type] || counts[type] >= limits[type] || !row.poster_url || !/^[1-9]\d*$/.test(tmdbId)) return false;
    const key = `${type}:${tmdbId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    counts[type]++;
    return true;
  });
}

// Raw rows and a projection cursor belong to one generation AND one refresh.
// A refresh can replace rows without changing the generation identity.
export function m3uFinalizeProof(generation, progress) {
  const total = Number(progress?.counts?.total);
  if (!Number.isSafeInteger(total) || total <= 0 || !progress?.startedAt) {
    throw new Error('M3U raw import is not complete');
  }
  return {
    contract: 'm3u-finalize-v2', startedAt: progress.startedAt, total,
    generationId: generation.generationId, headRevision: generation.headRevision,
    configRevision: generation.configRevision, sourceVisibilityEpoch: generation.sourceVisibilityEpoch,
  };
}

export function resolveM3uFinalizeCursor(hint, generation) {
  const progress = hint?.syncProgress || {};
  const counts = progress.counts || {};
  const proof = hint?.m3uFinalize;
  const stale = () => Object.assign(new Error('M3U finalization was superseded'), { code: 'CATALOG_GENERATION_SUPERSEDED' });
  if (proof) {
    for (const field of ['generationId', 'headRevision', 'configRevision', 'sourceVisibilityEpoch']) {
      if (String(proof[field]) !== String(generation[field])) throw stale();
    }
    if (proof.startedAt !== progress.startedAt || proof.total !== Number(counts.total)) throw stale();
  }
  if (progress.steps?.import?.status !== 'done' || !(Number(counts.total) > 0)) throw stale();
  const hasVod = Number(counts.movies || 0) + Number(counts.series || 0) > 0;
  const cursor = hint?.finalizeCursor || {};
  let phase = String(cursor.phase || (hasVod ? 'titles' : 'live'));
  let offset = Number(cursor.offset || 0);
  if (!['titles', 'live', 'live_channels', 'live_variants', 'complete'].includes(phase)
      || !Number.isSafeInteger(offset) || offset < 0) throw stale();
  if (!proof && ['live_channels', 'live_variants'].includes(phase)) { phase = 'live'; offset = 0; }
  if (['live', 'live_channels', 'live_variants'].includes(phase) && offset > Number(counts.live || 0)) throw stale();
  // Legacy handoffs did not carry a coverage checkpoint. Rebuild live once if
  // such a cursor already says complete; never publish on the cursor alone.
  if (phase === 'complete' && Number(counts.live) > 0 && Number(progress.m3uLiveCompleted) !== Number(counts.live)) {
    phase = 'live'; offset = 0;
  }
  return { phase, offset, afterId: String(cursor.afterId || '') };
}

export async function assertM3uFinalizeRunCurrent(db, sourceId, userId, expectedHint) {
  const { data, error } = await db.from('cloud_sources').select('config_hint')
    .eq('id', sourceId).eq('user_id', userId).eq('enabled', true).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  const expected = expectedHint?.syncProgress || {};
  const actual = data?.config_hint?.syncProgress || {};
  if (!data || expected.startedAt !== actual.startedAt
      || Number(expected.counts?.total) !== Number(actual.counts?.total)) {
    throw Object.assign(new Error('M3U refresh changed during finalization'), { code: 'CATALOG_GENERATION_SUPERSEDED' });
  }
}

// Browser and service step adapters cooperate with the sole CAS-owned worker.
// Untrusted phase=complete is never executed for M3U by these adapters.
export async function joinM3uFinalizer({ db, sourceId, userId, assertCurrent, invokeFinalizer }) {
  const { data, error } = await db.from('cloud_sources')
    .select('source_type,sync_status,config_hint').eq('id', sourceId).eq('user_id', userId)
    .eq('enabled', true).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data || data.source_type !== 'm3u') return null;
  await assertCurrent();
  if (data.sync_status === 'ready') return { sourceId, status: 'ready', done: true };
  const progress = data.config_hint?.syncProgress || {};
  if (progress.steps?.import?.status === 'done' && Number(progress.counts?.total) > 0) await invokeFinalizer();
  // Explicit live/0 makes older pollers stop their local walk without issuing
  // the complete call they infer from a missing nextPhase in deferred replies.
  return { sourceId, status: 'syncing', deferred: true, reason: 'finalize_in_progress',
    nextPhase: 'live', nextOffset: 0, nextAfterId: '', done: false };
}

// Full sync and diagnostic claims are registered only after winning projection
// CAS; no provider read or raw mutation may precede both claims. Token identity
// prevents a late release from deleting a successor's lease.
const projectionTransportTokens = new Set();
export async function claimM3uProjectionLease(db, sourceId, userId, leaseToken) {
  try {
    const { data, error } = await db.rpc('norva_claim_source_finalize_lease', {
      p_source_id: sourceId, p_user_id: userId, p_lease_token: leaseToken, p_ttl_seconds: 300,
    });
    if (error || data !== true) return false;
    projectionTransportTokens.add(leaseToken);
    return true;
  } catch (_) { return false; }
}
export async function renewM3uProjectionLease(db, sourceId, userId, leaseToken) {
  if (!projectionTransportTokens.has(leaseToken)) return; // token not claimed by this isolate
  const { data, error } = await db.rpc('norva_renew_source_finalize_lease', {
    p_source_id: sourceId, p_user_id: userId, p_lease_token: leaseToken, p_ttl_seconds: 300,
  });
  if (error || data !== true) throw Object.assign(new Error('M3U projection ownership changed'), { code: 'M3U_SYNC_LEASE_LOST' });
}
export async function releaseM3uProjectionLease(db, sourceId, userId, leaseToken) {
  if (!projectionTransportTokens.has(leaseToken)) return;
  try {
    await db.rpc('norva_release_source_finalize_lease', {
      p_source_id: sourceId, p_user_id: userId, p_lease_token: leaseToken,
    });
  } finally { projectionTransportTokens.delete(leaseToken); }
}


// Epoch joining is opt-in for long-lived M3U work. Request/response snapshots
// and every non-M3U authority guard retain their exact equality semantics.
const m3uEpochSnapshots = new WeakSet();
export function registerM3uEpochSnapshot(snapshot) { m3uEpochSnapshots.add(snapshot); return snapshot; }
export function mayAdoptM3uUserEpoch(snapshot) { return m3uEpochSnapshots.has(snapshot); }
export async function retryM3uEpochOperation({ generation, adopt, operation }) {
  for (let attempt = 0; ; attempt++) {
    await adopt();
    const epoch = generation.userVisibilityEpoch;
    try { return await operation(); }
    catch (error) {
      const code = String(error?.code || '');
      if (attempt >= 4 || (!['42501', 'PT409', '40001', 'CATALOG_GENERATION_SUPERSEDED'].includes(code)
          && !/row.level security|catalog.*(?:changed|stale)/i.test(String(error?.message || '')))) throw error;
      await adopt(); // rejects every generation/config/source-authority change
      if (generation.userVisibilityEpoch === epoch) throw error;
    }
  }
}
export async function writeM3uEpochBatch({ generation, adopt, write }) {
  for (let attempt = 0; ; attempt++) {
    await adopt();
    const epoch = generation.userVisibilityEpoch;
    const result = await write();
    if (attempt >= 4 || !['42501', 'PT409', '40001'].includes(result.error?.code)) return result;
    await adopt();
    if (generation.userVisibilityEpoch === epoch) return result;
  }
}
