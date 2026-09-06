import { discoverySourceId } from './discovery-catalog.mjs';
import { SELECTION_VOD_FEEDS, SELECTION_VOD_REVISION } from './selection-vod.mjs';
import { isSelectionSeriesUnit, selectionSeriesIdentity, selectionSeriesExternalId } from './selection-series.mjs';
import { selectionProviderAudioLanguages } from './selection-provider-languages.mjs';

export async function ownedSelectionSeries(row, seriesId) {
  const metadata = row?.metadata;
  const feed = SELECTION_VOD_FEEDS.find(candidate => candidate.id === metadata?.discoveryFeed);
  if (!feed || metadata.selectionRevision !== SELECTION_VOD_REVISION || metadata.discoverySource !== feed.website
    || metadata.seriesDelivery !== 'selection' || !metadata.selectionSeriesTitle) return false;
  return seriesId === selectionSeriesExternalId(await selectionSeriesIdentity(feed.id,
    metadata.selectionSeriesTitle, metadata.selectionVodGroup));
}

// Called inside the same source/generation visibility fence as Xtream details.
// Nothing here reads a provider account, emits media URLs or fabricates episodes.
export async function loadSelectionSeriesInfo({ db, userId, sourceId, seriesId, generationId }) {
  if (sourceId !== await discoverySourceId(userId)) return null;
  const base = () => db.from('cloud_catalog_visible_media_items')
    .select('external_id,title,parent_external_id,poster_url,metadata')
    .eq('user_id', userId).eq('source_id', sourceId).eq('generation_id', generationId);
  const { data: parent, error: parentError } = await base().eq('item_type', 'series').eq('external_id', seriesId).maybeSingle();
  if (parentError) throw new Error('Unable to load Selection series');
  if (!await ownedSelectionSeries(parent, seriesId)) throw new Error('Selection series is unavailable');
  const { data: rows, error } = await base().eq('item_type', 'episode')
    .eq('parent_external_id', seriesId).eq('available', true).order('external_id').limit(1001);
  if (error || !Array.isArray(rows) || rows.length > 1000) throw new Error('Unable to load Selection series files');
  const episodes = {};
  for (const row of rows) {
    const unit = row.metadata?.selectionUnit;
    if (!isSelectionSeriesUnit(unit) || row.metadata.selectionParentId !== seriesId
      || row.metadata.discoveryFeed !== parent.metadata.discoveryFeed
      || !/^norva-selection:movie:[a-f0-9]{64}$/.test(row.external_id)) continue;
    const season = String(unit.seasons[0]);
    const providerAudioLanguages = selectionProviderAudioLanguages(row);
    (episodes[season] ||= []).push({ id: row.external_id, title: row.title,
      season: unit.seasons[0], episode_num: unit.kind === 'episode' ? unit.episode : null,
      container_extension: 'm3u8', selectionUnit: unit,
      ...(providerAudioLanguages.length ? { providerAudioLanguages, providerAudioLanguageStatus: 'provider_declared' } : {}),
      info: { movie_image: row.poster_url || parent.poster_url || null },
      playbackHint: { container: 'm3u8', streamType: 'series', audioSeriesId: seriesId } });
  }
  for (const files of Object.values(episodes)) files.sort((a, b) =>
    (a.selectionUnit.episode || 0) - (b.selectionUnit.episode || 0)
    || (a.selectionUnit.part || 0) - (b.selectionUnit.part || 0) || a.title.localeCompare(b.title));
  return { info: { name: parent.title, cover: parent.poster_url, seriesDelivery: 'selection' }, episodes, seriesDelivery: 'selection' };
}

export async function resolveOwnedSelectionEpisode({ db, userId, sourceId, itemId, parentId = null }) {
  if (sourceId !== await discoverySourceId(userId) || !/^norva-selection:movie:[a-f0-9]{64}$/.test(itemId)) return null;
  const { data: row, error } = await db.from('cloud_catalog_visible_media_items')
    .select('id,updated_at,generation_id,parent_external_id,playback_hint,metadata')
    .eq('user_id', userId).eq('source_id', sourceId).eq('item_type', 'episode')
    .eq('external_id', itemId).eq('available', true).maybeSingle();
  if (error) throw new Error('Unable to resolve Selection file');
  if (!row || !isSelectionSeriesUnit(row.metadata?.selectionUnit)
    || row.metadata.selectionParentId !== row.parent_external_id
    || (parentId && parentId !== row.parent_external_id)) return null;
  const { data: parent, error: parentError } = await db.from('cloud_catalog_visible_media_items')
    .select('metadata').eq('user_id', userId).eq('source_id', sourceId)
    .eq('generation_id', row.generation_id).eq('item_type', 'series')
    .eq('external_id', row.parent_external_id).eq('available', true).maybeSingle();
  if (parentError) throw new Error('Unable to resolve Selection series');
  return await ownedSelectionSeries(parent, row.parent_external_id) ? row : null;
}
