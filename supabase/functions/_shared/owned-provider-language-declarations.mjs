// Read only the server-owned projection, never provider-controlled metadata or
// a host-only cache. Keep declarations separate from observed/verified audio.
export function useCachedAudioLanguageEvidence(variant, cacheRow) {
  // A fresh owned declaration must not be replaced by an uncertified legacy
  // cache language. A real audio certificate retains its existing priority.
  return !variant.__owned_provider_audio_languages?.length || Boolean(cacheRow.audio_lang_verified_at);
}

export async function attachOwnedProviderLanguageDeclarations(db, variants, userId) {
  const byId = new Map(variants.filter(v => v.user_id === userId && v.id).map(v => [String(v.id), v]));
  const scopes = new Map();
  for (const [id, variant] of byId) {
    if (!variant.source_id || !['movie', 'series'].includes(variant.item_type)) continue;
    const key = JSON.stringify([variant.source_id, variant.item_type]);
    if (!scopes.has(key)) scopes.set(key, { source: variant.source_id, type: variant.item_type, ids: [] });
    scopes.get(key).ids.push(id);
  }
  const collected = new Map();
  for (const { source, type, ids } of scopes.values()) {
    for (let offset = 0; offset < ids.length; offset += 200) {
      const batchIds = ids.slice(offset, offset + 200);
      const { data, error } = await (type === 'movie'
        ? db.rpc('cloud_catalog_owned_movie_audio_declarations_batch', {
          p_user_id: userId, p_source_id: source, p_variant_ids: batchIds,
        })
        : db.rpc('cloud_catalog_owned_audio_declarations_scoped', {
        p_user_id: userId, p_source_id: source, p_item_type: type,
      })
        .in('variant_id', batchIds));
      if (error) throw new Error('Owned language declarations unavailable');
      for (const row of data || []) {
        const v = byId.get(String(row.variant_id));
        if (!v || v.source_id !== row.source_id || v.item_type !== row.item_type
          || !/^(?:[a-z]{2}|yue)$/.test(row.language || '') || ['un', 'xx', 'zz'].includes(row.language)) continue;
        if (!collected.has(v)) collected.set(v, new Set());
        collected.get(v).add(row.language);
      }
    }
  }
  for (const [v, codes] of collected) {
    v.__owned_provider_audio_languages = [...codes].sort();
    v.provider_audio_languages = [...codes].sort();
    v.provider_audio_language_status = 'provider_declared';
  }
}
