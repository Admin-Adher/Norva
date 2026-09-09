import { discoverySourceId, discoverySourceGeneration } from './discovery-catalog.mjs';

// Read identities only, including tombstones: choosing a later generation must
// never revive a row owned by a terminal cleanup. Pagination keeps old accounts
// correct even after many provider additions/deletions.
export async function selectionEnrollment(db, userId) {
  let latestGeneration = -1;
  let existing = null;
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from('cloud_sources')
      .select('id,enabled,deleted_at').eq('user_id', userId).eq('source_type', 'm3u')
      .order('id').range(offset, offset + 999);
    if (error) throw new Error('Unable to check Selection enrolment');
    for (const row of data || []) {
      const generation = await discoverySourceGeneration(row.id, userId);
      if (generation === null) continue;
      latestGeneration = Math.max(latestGeneration, generation);
      if (!row.deleted_at && (!existing || generation > existing.generation)) existing = { ...row, generation };
    }
    if (!data || data.length < 1000) break;
  }
  if (existing) return { sourceId: existing.id, existing };
  return { sourceId: await discoverySourceId(userId, latestGeneration + 1), existing: null };
}
