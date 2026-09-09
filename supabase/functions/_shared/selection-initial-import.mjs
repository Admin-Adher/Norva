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
    .select('config_hint').eq('id', sourceId).eq('user_id', userId)
    .eq('enabled', true).is('deleted_at', null).maybeSingle();
  if (readError) throw readError;
  if (!source) throw stale();
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
      finalizeCursor: { phase: 'titles', offset: 0, afterId: '' },
      syncProgress: { ...progress, moviesReady: false, seriesReady: false,
        browseReady: false, usable: false, liveReady: false },
    },
  }).eq('id', sourceId).eq('user_id', userId).eq('enabled', true).is('deleted_at', null)
    .eq('config_revision', generation.configRevision)
    .eq('visibility_epoch', generation.sourceVisibilityEpoch)
    .select('id').maybeSingle();
  if (error) throw error;
  if (!saved) throw stale();
  await assertCurrent();
  await releaseTransport();
  await invokeFinalizer();
}

export function initialTitleBatchLimit(isSelection, firstSliceReady) {
  return isSelection && !firstSliceReady ? 60 : 300;
}
