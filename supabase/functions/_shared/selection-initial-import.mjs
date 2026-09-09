// Persist the durable continuation before releasing the import transport lease.
// A failed invocation can then be resumed by the existing watchdog without
// downloading the Selection again or restarting an unbounded projection.
export async function handoffSelectionFinalization({
  db, sourceId, userId, assertCurrent, releaseTransport, invokeFinalizer,
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
      finalizeCursor: { phase: 'titles', offset: 0, afterId: '' },
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

export function initialTitleBatchLimit(isSelection, firstSliceReady) {
  return isSelection && !firstSliceReady ? 60 : 300;
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
