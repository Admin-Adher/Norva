import { discoverySourceIds } from './discovery-catalog.mjs';

// These are language sets for the available episodes of ONE owned series
// version. They must never become a parent series' ordered stream map.
export function selectionSeriesLanguageFields(summary) {
  if (!summary) return {};
  const result = {};
  if (summary.audioObserved) {
    Object.assign(result, {
      audio_languages: summary.audio, audioLanguages: summary.audio,
      audio_languages_scope: 'series', audioLanguagesScope: 'series',
      audio_languages_observed: true, audioLanguagesObserved: true,
      audio_language_validation_status: summary.audio.length ? 'probed_union' : 'pending',
      audioLanguageValidationStatus: summary.audio.length ? 'probed_union' : 'pending',
    });
  }
  if (summary.subtitleObserved) {
    Object.assign(result, {
      subtitle_languages: summary.subtitles, subtitleLanguages: summary.subtitles,
      subtitle_languages_scope: 'series', subtitleLanguagesScope: 'series',
      subtitle_languages_observed: true, subtitleLanguagesObserved: true,
    });
  }
  return result;
}

async function allRows(query) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await query.range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

export async function attachSelectionSeriesLanguages(db, variants, userId) {
  const sourceIds = await discoverySourceIds(variants.filter(v => v.user_id === userId).map(v => v.source_id), userId);
  for (const sourceId of sourceIds) {
    await attachSelectionSourceSeriesLanguages(db, variants, userId, sourceId);
  }
}

async function attachSelectionSourceSeriesLanguages(db, variants, userId, sourceId) {
  const parents = variants.filter(v => v.user_id === userId && v.source_id === sourceId &&
    v.item_type === 'series' && v.metadata?.seriesDelivery === 'selection');
  for (let start = 0; start < parents.length; start += 25) {
    const batch = parents.slice(start, start + 25);
    const episodes = await allRows(db.from('cloud_catalog_visible_media_items')
      .select('external_id,parent_external_id').eq('user_id', userId).eq('source_id', sourceId)
      .eq('item_type', 'episode').eq('available', true)
      .in('parent_external_id', batch.map(v => v.external_id)).order('id'));
    const filesByParent = new Map();
    for (const row of episodes) {
      if (!filesByParent.has(row.parent_external_id)) filesByParent.set(row.parent_external_id, new Set());
      filesByParent.get(row.parent_external_id).add(row.external_id);
    }
    const observations = await allRows(db.from('cloud_title_file_language_observations')
      .select('variant_id,file_external_id,audio_languages,subtitle_languages,audio_observed,subtitle_observed')
      .eq('user_id', userId).in('variant_id', batch.map(v => v.id))
      .order('variant_id').order('file_external_id'));
    const byVariant = new Map(batch.map(v => [v.id, v]));
    for (const row of observations) {
      const parent = byVariant.get(row.variant_id);
      if (!parent || !filesByParent.get(parent.external_id)?.has(row.file_external_id)) continue;
      const summary = parent.__series_languages ||= { audio: [], subtitles: [], audioObserved: false, subtitleObserved: false };
      for (const [flag, field, output] of [['audio_observed', 'audio_languages', 'audio'], ['subtitle_observed', 'subtitle_languages', 'subtitles']]) {
        if (row[flag] !== true) continue;
        summary[output === 'audio' ? 'audioObserved' : 'subtitleObserved'] = true;
        for (const language of row[field] || []) {
          // Observation rows already contain canonical ISO codes. Unknown tags
          // cannot turn into an advertised catalogue language.
          if (/^[a-z]{2,3}$/.test(language) && !['und', 'mul', 'zxx', 'mis'].includes(language) && !summary[output].includes(language)) summary[output].push(language);
        }
        summary[output].sort();
      }
    }
  }
}
