import { m3uDurationSeconds } from './m3u-duration.mjs';

const SERIES_ID = /^norva-m3u:series:[a-f0-9]{64}$/;
const EPISODE_ID = /^norva-m3u:episode:[a-f0-9]{64}$/;
const CONTAINERS = new Set(['mp4', 'mkv', 'ts', 'm3u8', 'webm', 'avi', 'mov', 'm4v']);
const PAGE_SIZE = 500;
const MAX_EPISODES = 10_000;

export const isM3uSeriesId = value => typeof value === 'string' && SERIES_ID.test(value);
export const isM3uEpisodeId = value => typeof value === 'string' && EPISODE_ID.test(value);

function validMedia(row, kind) {
  const media = row?.metadata?.m3uMedia;
  return !!media && media.version === 1 && media.kind === kind
    && typeof media.seriesTitle === 'string' && media.seriesTitle.trim().length > 0
    && media.seriesTitle.length <= 1024
    && (kind !== 'episode' || (
      Number.isSafeInteger(media.season) && media.season >= 0 && media.season <= 999
      && Number.isSafeInteger(media.episode) && media.episode >= 1 && media.episode <= 99_999
    ));
}

function containerFor(row) {
  const value = String(row?.metadata?.container_extension || row?.metadata?.containerExtension || row?.metadata?.container || '').toLowerCase();
  return CONTAINERS.has(value) ? value : 'mp4';
}

// Xtream-compatible public display field. Exact fractional seconds remain in
// duration_seconds and the playback hint; labels never become timing proof.
function durationLabel(seconds) {
  const whole = Math.floor(seconds);
  return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
}

async function visibleM3uSource(db, userId, sourceId) {
  const { data, error } = await db.from('cloud_catalog_visible_sources').select('source_type')
    .eq('id', sourceId).eq('user_id', userId).eq('source_type', 'm3u').maybeSingle();
  if (error) throw new Error('Unable to verify M3U source');
  return data?.source_type === 'm3u';
}

function mediaQuery(db, userId, sourceId, generationId, columns) {
  return db.from('cloud_catalog_visible_media_items').select(columns)
    .eq('user_id', userId).eq('source_id', sourceId).eq('generation_id', generationId)
    .eq('available', true);
}

// The caller holds the active-generation fence and checks it again before
// returning this public payload. Imported URLs never leave this helper.
export async function loadM3uSeriesInfo({ db, userId, sourceId, seriesId, generationId }) {
  if (!isM3uSeriesId(seriesId) || !generationId || !await visibleM3uSource(db, userId, sourceId)) return null;
  const columns = 'external_id,title,parent_external_id,poster_url,metadata';
  const { data: parent, error: parentError } = await mediaQuery(db, userId, sourceId, generationId, columns)
    .eq('item_type', 'series').eq('external_id', seriesId).maybeSingle();
  if (parentError) throw new Error('Unable to load M3U series');
  if (!validMedia(parent, 'series')) return null;

  const episodes = {};
  let afterId = '';
  let count = 0;
  while (true) {
    const remaining = MAX_EPISODES - count;
    let query = mediaQuery(db, userId, sourceId, generationId, columns)
      .eq('item_type', 'episode').eq('parent_external_id', seriesId).order('external_id')
      .limit(remaining > 0 ? Math.min(PAGE_SIZE, remaining) : 1);
    if (afterId) query = query.gt('external_id', afterId);
    const { data: rows, error } = await query;
    if (error || !Array.isArray(rows)) throw new Error('Unable to load M3U episodes');
    if (!remaining && rows.length) throw new Error('M3U series exceeds the episode limit');
    if (!rows.length) break;
    for (const row of rows) {
      if (!isM3uEpisodeId(row.external_id) || !validMedia(row, 'episode')
        || row.parent_external_id !== seriesId) throw new Error('M3U episode metadata is incomplete');
      const media = row.metadata.m3uMedia;
      const container = containerFor(row);
      const durationSeconds = row.metadata.durationSource === 'm3u-extinf'
        ? m3uDurationSeconds(row.metadata.duration_seconds) : null;
      const duration = durationSeconds === null ? {} : { duration: durationLabel(durationSeconds), duration_seconds: durationSeconds };
      const durationHint = durationSeconds === null ? {} : { durationSeconds, durationSource: 'm3u-extinf' };
      (episodes[String(media.season)] ||= []).push({
        id: row.external_id, title: row.title,
        season: media.season, episode_num: media.episode, container_extension: container,
        ...duration,
        info: { movie_image: row.poster_url || parent.poster_url || null, ...duration },
        playbackHint: { container, containerExtension: container, streamType: 'series', audioSeriesId: seriesId, ...durationHint },
      });
    }
    count += rows.length;
    const next = rows.at(-1).external_id;
    if (next <= afterId) throw new Error('M3U episode pagination did not advance');
    afterId = next;
    if (rows.length < Math.min(PAGE_SIZE, remaining)) break;
  }
  for (const files of Object.values(episodes)) files.sort((a, b) =>
    a.episode_num - b.episode_num || String(a.title).localeCompare(String(b.title)) || a.id.localeCompare(b.id));
  return { info: { name: parent.title, cover: parent.poster_url, seriesDelivery: 'm3u' }, episodes, seriesDelivery: 'm3u' };
}

// Only an exact, current, owned raw episode can supply a playback URL. The
// parent is resolved in the same generation; client hints are never targets.
export async function resolveOwnedM3uEpisode({ db, userId, sourceId, itemId, parentId = null }) {
  if (!isM3uEpisodeId(itemId) || (parentId && !isM3uSeriesId(parentId))
    || !await visibleM3uSource(db, userId, sourceId)) return null;
  const { data: row, error } = await db.from('cloud_catalog_visible_media_items')
    .select('id,updated_at,generation_id,parent_external_id,playback_hint,metadata')
    .eq('user_id', userId).eq('source_id', sourceId).eq('item_type', 'episode')
    .eq('external_id', itemId).eq('available', true).maybeSingle();
  if (error) throw new Error('Unable to resolve M3U episode');
  if (!validMedia(row, 'episode') || !row.generation_id || !isM3uSeriesId(row.parent_external_id)
    || (parentId && row.parent_external_id !== parentId)) return null;
  const { data: parent, error: parentError } = await mediaQuery(db, userId, sourceId, row.generation_id, 'metadata')
    .eq('item_type', 'series').eq('external_id', row.parent_external_id).maybeSingle();
  if (parentError) throw new Error('Unable to resolve M3U series');
  if (!validMedia(parent, 'series') || row.playback_hint?.sourceType !== 'm3u'
    || typeof row.playback_hint?.targetUrl !== 'string') return null;
  const targetUrl = row.playback_hint.targetUrl;
  try { if (!['http:', 'https:'].includes(new URL(targetUrl).protocol)) return null; } catch { return null; }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(targetUrl));
  const id = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return itemId === `norva-m3u:episode:${id}` ? row : null;
}
