// The durable owner snapshots are a prerequisite for every TMDB mode. Drive
// their existing claim/slice/checkpoint protocol independently of viewer visits.
export async function maintainCatalogBackgroundOwners(db, {
  maxSlices = 16, sliceLimit = 2000, deadlineMs = 20_000,
  now = Date.now, worker = `edge-catalog-owners-${crypto.randomUUID()}`,
} = {}) {
  if (!Number.isInteger(maxSlices) || maxSlices < 1 || maxSlices > 32 ||
      !Number.isInteger(sliceLimit) || sliceLimit < 100 || sliceLimit > 5000 ||
      !Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > 40_000) {
    throw new Error('Invalid catalog owner maintenance bounds');
  }
  const startedAt = now();
  const summary = { claimed: 0, slices: 0, completed: 0, deferred: 0, idle: false };
  const call = async (name, args) => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw error;
    return data;
  };
  while (summary.slices < maxSlices && now() - startedAt < deadlineMs) {
    const rows = await call('norva_claim_catalog_background_owner_build_jobs', {
      p_worker: worker, p_limit: 1, p_lease_seconds: 120,
    });
    if (!Array.isArray(rows) || rows.length > 1) throw new Error('Invalid catalog owner claim');
    if (!rows.length) { summary.idle = true; break; }
    const claim = rows[0];
    if (!claim.job_id || !Number.isSafeInteger(Number(claim.lease_sequence)) ||
        !/^\d+$/.test(String(claim.checkpoint_revision))) throw new Error('Invalid catalog owner proof');
    summary.claimed += 1;
    let revision = claim.checkpoint_revision;
    let complete = false;
    try {
      while (summary.slices < maxSlices && now() - startedAt < deadlineMs) {
        const result = await call('norva_run_catalog_background_owner_build_job_slice', {
          p_job_id: claim.job_id, p_worker: worker,
          p_expected_lease_sequence: claim.lease_sequence,
          p_expected_checkpoint_revision: revision, p_limit: sliceLimit,
        });
        if (result?.contract !== 'catalog-background-owner-workflow-v1' ||
            result.jobId !== claim.job_id || typeof result.complete !== 'boolean' ||
            !/^\d+$/.test(String(result.checkpointRevision))) {
          throw new Error('Invalid catalog owner slice');
        }
        revision = result.checkpointRevision;
        summary.slices += 1;
        complete = result.complete;
        if (complete) { summary.completed += 1; break; }
      }
    } finally {
      // A timed-out RPC may have committed: checkpoint CAS then fails closed,
      // and the short existing lease makes the job recoverable on the next tick.
      if (!complete) {
        await call('norva_checkpoint_catalog_background_owner_build_job', {
          p_job_id: claim.job_id, p_worker: worker,
          p_expected_lease_sequence: claim.lease_sequence,
          p_expected_checkpoint_revision: revision, p_retry_after_seconds: 5,
        });
        summary.deferred += 1;
      }
    }
  }
  return summary;
}
