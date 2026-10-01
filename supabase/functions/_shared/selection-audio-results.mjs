import { isDiscoverySourceId } from './discovery-catalog.mjs';

// Re-imports reuse an exact public-file result, with the same catalogue fences
// as ordinary metadata writes. Ordered audio tracks never cross file identities.
export async function hydrateSelectionAudioResults({ db, userId, sourceId, rows, generationFence,
  getGenerationFence = () => generationFence, assertSourceCurrent = async () => {} }) {
  if (!await isDiscoverySourceId(sourceId, userId)) return 0;
  const ids = [...new Set(rows.filter(r => r.item_type === 'movie').map(r => r.external_id))];
  let count = 0;
  // The RPC already accepts 250 exact files. Reusing that bound avoids five
  // repeated visibility scans while retaining a fresh fence for every call.
  for (let offset = 0; offset < ids.length; offset += 250) {
    await assertSourceCurrent();
    const { data, error } = await db.rpc('hydrate_selection_audio_results', {
      p_user_id: userId, p_source_id: sourceId, ...getGenerationFence(),
      p_external_ids: ids.slice(offset, offset + 250),
    });
    if (error) throw error;
    count += Number(data) || 0;
  }
  return count;
}
