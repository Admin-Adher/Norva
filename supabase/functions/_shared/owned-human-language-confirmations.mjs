// Listening confirmations are owned, exact-file testimony. They never mutate
// the provider declarations, technical track tags or automated LID evidence.
const languageCode = value => typeof value === 'string'
  && /^(?:[a-z]{2}|yue)$/.test(value) && !['un', 'xx', 'zz'].includes(value);

function boundedTracks(value) {
  if (!Array.isArray(value)) return [];
  const tracks = new Map();
  for (const row of value.slice(0, 32)) {
    if (!row || !Number.isInteger(row.index) || row.index < 0 || row.index > 255
      || !languageCode(row.language)) continue;
    const prior = tracks.get(row.index);
    // Conflicting testimony cannot safely label this track.
    tracks.set(row.index, prior && prior !== row.language ? null : prior === null ? null : row.language);
  }
  return [...tracks].filter(([, language]) => language)
    .sort(([a], [b]) => a - b).map(([index, language]) => ({ index, language }));
}

export function humanAudioFields(item = {}) {
  const owned = Array.isArray(item.__owned_human_audio_tracks);
  const status = item.human_audio_language_status ?? item.humanAudioLanguageStatus;
  const scope = item.human_audio_language_scope ?? item.humanAudioLanguageScope;
  if (!owned && (status !== 'human_confirmed' || scope !== 'file')) return {};
  const tracks = boundedTracks(owned ? item.__owned_human_audio_tracks
    : item.human_audio_track_languages ?? item.humanAudioTrackLanguages);
  if (!tracks.length) return {};
  const languages = [...new Set(tracks.map(row => row.language))].sort();
  return {
    human_audio_languages: languages, humanAudioLanguages: languages,
    human_audio_language_status: 'human_confirmed', humanAudioLanguageStatus: 'human_confirmed',
    human_audio_language_scope: 'file', humanAudioLanguageScope: 'file',
    human_audio_track_languages: tracks, humanAudioTrackLanguages: tracks,
  };
}

export async function attachOwnedHumanLanguageConfirmations(db, variants, userId) {
  const owned = variants.filter(v => v.user_id === userId && v.id && v.source_id && v.item_type === 'movie');
  const byId = new Map(owned.map(v => [String(v.id), v]));
  const scopes = new Map();
  for (const variant of owned) {
    if (!scopes.has(variant.source_id)) scopes.set(variant.source_id, []);
    scopes.get(variant.source_id).push(String(variant.id));
  }
  const collected = new Map();
  for (const [sourceId, ids] of scopes) {
    for (let offset = 0; offset < ids.length; offset += 200) {
      const requested = new Set(ids.slice(offset, offset + 200));
      const { data, error } = await db.rpc('cloud_catalog_owned_movie_human_audio_confirmations_batch', {
        p_user_id: userId, p_source_id: sourceId, p_variant_ids: [...requested],
      });
      if (error) throw new Error('Owned listening confirmations unavailable');
      for (const row of data || []) {
        const id = String(row.variant_id);
        const variant = byId.get(id);
        if (!requested.has(id) || !variant || row.user_id !== userId
          || row.source_id !== sourceId || variant.source_id !== row.source_id
          || row.item_type !== 'movie' || row.method !== 'owner-listening-v1'
          || !languageCode(row.language) || !Number.isInteger(row.track_index)
          || row.track_index < 0 || row.track_index > 255) continue;
        if (!collected.has(variant)) collected.set(variant, []);
        collected.get(variant).push({ index: row.track_index, language: row.language });
      }
    }
  }
  for (const [variant, tracks] of collected) variant.__owned_human_audio_tracks = boundedTracks(tracks);
}

// Continue Watching is hydrated at read time from the same owned file lookup.
// History writes cannot introduce testimony or preserve it after a file change.
export async function attachOwnedHumanHistoryLanguages(db, history, userId) {
  const scopes = new Map();
  for (const row of history) {
    if (row.item_type !== 'movie' || !row.source_id || !row.item_id) continue;
    if (!scopes.has(row.source_id)) scopes.set(row.source_id, []);
    scopes.get(row.source_id).push(row);
  }
  for (const [sourceId, rows] of scopes) {
    for (let offset = 0; offset < rows.length; offset += 200) {
      const batch = rows.slice(offset, offset + 200);
      const { data, error } = await db.from('cloud_catalog_visible_title_variants')
        .select('id,user_id,source_id,item_type,external_id')
        .eq('user_id', userId).eq('source_id', sourceId).eq('item_type', 'movie')
        .in('external_id', [...new Set(batch.map(row => String(row.item_id)))]);
      if (error) throw new Error('Owned listening history unavailable');
      const variants = data || [];
      await attachOwnedHumanLanguageConfirmations(db, variants, userId);
      const byFile = new Map();
      for (const variant of variants) {
        if (variant.user_id !== userId || variant.source_id !== sourceId || variant.item_type !== 'movie') continue;
        const key = String(variant.external_id);
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key).push(...(variant.__owned_human_audio_tracks || []));
      }
      for (const row of batch) {
        const tracks = boundedTracks(byFile.get(String(row.item_id)));
        if (tracks.length) row.data = { ...(row.data || {}), __owned_human_audio_tracks: tracks };
      }
    }
  }
}

export async function attachOwnedHumanPlaybackLanguages(db, result, userId) {
  if (!result?.playback || typeof result.playback !== 'object') return;
  // Always replace a resume snapshot, including on a lookup failure or after a
  // profile change. Only the server-created session supplies the coordinates.
  let fields = {
    human_audio_languages: [], humanAudioLanguages: [],
    human_audio_language_status: null, humanAudioLanguageStatus: null,
    human_audio_language_scope: null, humanAudioLanguageScope: null,
    human_audio_track_languages: [], humanAudioTrackLanguages: [],
  };
  const session = result.session || {};
  const row = { source_id: session.source_id, item_type: session.item_type, item_id: session.item_id, data: {} };
  try {
    await attachOwnedHumanHistoryLanguages(db, [row], userId);
    fields = { ...fields, ...humanAudioFields({ __owned_human_audio_tracks: row.data.__owned_human_audio_tracks }) };
  } catch (_) { /* Reading a display fact must never block a ready playback. */ }
  Object.assign(result.playback, fields);
}
