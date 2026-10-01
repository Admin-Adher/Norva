import { discoverySourceIds } from './discovery-catalog.mjs';

const languages = tracks => [...new Set((tracks || []).map(t => t.lang || t.language)
  .filter(l => /^[a-z]{2,3}$/.test(l || '') && !['und', 'mul', 'zxx', 'mis'].includes(l)))].sort();

export async function attachSharedSelectionFileFacts(db, variants, userId) {
  const owned = variants.filter(v => v.user_id === userId && v.id);
  const sources = new Set(await discoverySourceIds(owned.map(v => v.source_id), userId));
  const selected = owned.filter(v => sources.has(v.source_id));
  const byId = new Map(selected.map(v => [v.id, v]));
  for (let start = 0; start < selected.length; start += 200) {
    const { data, error } = await db.rpc('norva_selection_shared_file_facts', {
      p_user_id: userId, p_variant_ids: selected.slice(start, start + 200).map(v => v.id),
    });
    if (error) throw error;
    for (const row of data || []) {
      const v = byId.get(row.variantId);
      if (!v || row.userId !== userId || row.sourceId !== v.source_id ||
        row.itemType !== v.item_type || row.externalId !== v.external_id) continue;
      if (v.item_type === 'series') {
        const s = row.seriesLanguages;
        if (s) v.__series_languages = { audio: s.audio || [], subtitles: s.subtitles || [],
          audioObserved: Boolean(s.audio?.length), subtitleObserved: Boolean(s.subtitles?.length) };
        continue; // A series union must never become ordered episode tracks.
      }
      if (v.item_type !== 'movie' || !row.urlSha256 || row.urlSha256 !== v.__selection_audio_url_sha256) continue;
      const tags = row.fileTags;
      if (!tags?.probedAt || !Array.isArray(tags.audioTracks) || !Array.isArray(tags.subtitleTracks)) continue;
      const audio = languages(tags.audioTracks);
      Object.assign(v, {
        __file_audio_tracks: tags.audioTracks, __file_subtitle_tracks: tags.subtitleTracks,
        __file_audio_languages: audio, __file_subtitle_languages: languages(tags.subtitleTracks),
        __file_audio_observed: true, __file_subtitle_observed: true,
        __file_audio_probed_at: tags.probedAt, __file_subtitle_probed_at: tags.probedAt,
        __file_audio_validation_status: tags.verified === true && audio.length ? 'verified' : audio.length ? 'probed' : 'pending',
        __file_audio_verification: { urlSha256: row.urlSha256, source: 'selection_shared_exact_file' },
        __selection_audio_observation_matched: true,
      });
      if (tags.verified === true && audio.length) v.__file_audio_verified_at = tags.probedAt;
    }
  }
}
