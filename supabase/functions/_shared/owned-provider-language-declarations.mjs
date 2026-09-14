// Read only the server-owned projection, never provider-controlled metadata or
// a host-only cache. Keep declarations separate from observed/verified audio.
export function useCachedAudioLanguageEvidence(variant, cacheRow) {
  // A fresh owned declaration must not be replaced by an uncertified legacy
  // cache language. A real audio certificate retains its existing priority.
  return !variant.__owned_provider_audio_languages?.length || Boolean(cacheRow.audio_lang_verified_at);
}

export async function attachOwnedProviderLanguageDeclarations(db, variants, userId) {
  const byId = new Map(variants.filter(v => v.user_id === userId && v.id).map(v => [String(v.id), v]));
  const ids = [...byId.keys()];
  const collected = new Map();
  for (let offset = 0; offset < ids.length; offset += 200) {
    const { data, error } = await db.from('cloud_catalog_owned_audio_declarations')
      .select('variant_id,source_id,item_type,language').eq('user_id', userId)
      .in('variant_id', ids.slice(offset, offset + 200));
    if (error) throw new Error('Owned language declarations unavailable');
    for (const row of data || []) {
      const v = byId.get(String(row.variant_id));
      if (!v || v.source_id !== row.source_id || v.item_type !== row.item_type
        || !/^(?:[a-z]{2}|yue)$/.test(row.language || '') || ['un', 'xx', 'zz'].includes(row.language)) continue;
      if (!collected.has(v)) collected.set(v, new Set());
      collected.get(v).add(row.language);
    }
  }
  for (const [v, codes] of collected) {
    v.__owned_provider_audio_languages = [...codes].sort();
    v.provider_audio_languages = [...codes].sort();
    v.provider_audio_language_status = 'provider_declared';
  }
}
