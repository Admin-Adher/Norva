const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only ids from the server's already-owned, hydrated response are considered.
// This records scheduling hints, never a provider request or language evidence.
export function featuredLanguageTitleIds(payload) {
  const rails = Array.isArray(payload?.rails) ? payload.rails : [{ items: payload?.items }];
  const seen = new Set(); const ids = [];
  // First screen in every category before the remaining cards of those rails.
  const lists = rails.map(rail => Array.isArray(rail?.items) ? rail.items : []);
  for (let index = 0; index < 50 && ids.length < 256; index++) {
    for (const list of lists) {
      const item = list[index];
      if (!item || !['movie', 'series'].includes(item.item_type ?? item.type ?? item.itemType)) continue;
      const id = item.title_id ?? item.titleId ?? item.id;
      if (typeof id !== 'string' || !uuid.test(id) || seen.has(id)) continue;
      seen.add(id); ids.push(id);
      if (ids.length === 256) break;
    }
  }
  return ids;
}

export function scheduleFeaturedLanguagePriority(db, userId, payload, runtime = globalThis.EdgeRuntime) {
  const ids = featuredLanguageTitleIds(payload);
  if (!ids.length || !uuid.test(userId)) return;
  // Never delay rendering or fail a catalogue request for background priority.
  const work = (async () => {
    try {
      const result = await db.rpc('record_catalog_featured_language_titles', { p_user: userId, p_titles: ids })
        .abortSignal(AbortSignal.timeout(1500));
      if (result.error) console.warn('featured_language_priority_deferred');
    } catch (_) { console.warn('featured_language_priority_deferred'); }
  })();
  if (typeof runtime?.waitUntil === 'function') runtime.waitUntil(work);
}
