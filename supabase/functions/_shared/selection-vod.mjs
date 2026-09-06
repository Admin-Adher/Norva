import { fetchM3uPlaylistStream } from './m3u-playlist-stream.mjs';
import { selectionSeriesUnit, selectionSeriesIdentity, selectionSeriesExternalId } from './selection-series.mjs';

export const SELECTION_VOD_REVISION = 'selection-vod-20260906-v1';
export const SELECTION_VOD_FEEDS = Object.freeze([
  { id: 'babuperumana-vod', name: 'Babuperumana', kind: 'movie',
    url: 'https://raw.githubusercontent.com/Babuperumana/movies_m3u/main/playlist.m3u',
    website: 'https://github.com/Babuperumana/movies_m3u' },
  { id: 'sulthanpamenan-vod', name: 'Sulthanpamenan', kind: 'movie',
    url: 'https://sulthanpamenan.github.io/vod-playlist/playlist.m3u',
    website: 'https://github.com/sulthanpamenan/vod-playlist' },
].map(Object.freeze));

const feeds = new Map(SELECTION_VOD_FEEDS.map(feed => [feed.id, feed]));
const verifiedDeliveries = new WeakSet();
const playbackCaches = new WeakMap();
const clean = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
const unavailable = () => new Error('Selection programme is temporarily unavailable');

function httpsUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = ''; // Player-only fragments are never sent to the media server.
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

// Pin the actual tested media service, including the target inside its proxy.
// YouTube pages, parked domains and arbitrary Worker targets are not VOD feeds.
export function selectionVodUrlAllowed(feedId, raw) {
  const url = httpsUrl(raw);
  if (!url || typeof raw !== 'string' || raw.length > 12_000) return false;
  if (feedId === 'babuperumana-vod') {
    if (url.origin !== 'https://movierulz.babuperumana.workers.dev' || url.pathname !== '/proxy') return false;
    const keys = [...url.searchParams.keys()];
    if (keys.some(key => !['url', 'ext'].includes(key)) || url.searchParams.getAll('url').length !== 1
      || url.searchParams.getAll('ext').length > 1) return false;
    const upstream = httpsUrl(url.searchParams.get('url'));
    return !!upstream && upstream.origin === 'https://hls2.vcdnx.com'
      && /^\/hls\/[A-Za-z0-9_+=.-]{8,512}\/[A-Za-z0-9!_+=.-]{1,100}$/.test(upstream.pathname)
      && ![...upstream.searchParams.keys()].some(key => /^(url|host|username|password)$/i.test(key));
  }
  return feedId === 'sulthanpamenan-vod' && url.hostname === 'vod3.cf.dmcdn.net'
    && /^\/sec2\([^/]+\)\//.test(url.pathname) && /\.m3u8$/i.test(url.pathname);
}

export async function selectionVodIdentity(feedId, item) {
  const title = clean(item?.title), group = clean(item?.group), tvgId = clean(item?.tvgId) || title;
  if (!feeds.has(feedId) || !title || title.length > 512 || tvgId.length > 512 || group.length > 512) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([feedId, title, tvgId, group])));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function selectionVodExternalId(identity) { return `norva-selection:movie:${identity}`; }

async function loadFeed(feed, fetchPlaylist) {
  const playlist = await fetchPlaylist(feed.url, { timeoutMs: 20_000, maxBytes: 16 * 1024 * 1024, maxItems: 20_000 });
  if (playlist.response?.ok === false || !playlist.headerDetected || playlist.truncated || !playlist.items?.length) throw unavailable();
  const entries = new Map();
  let rejected = 0, duplicates = 0;
  // Hash in bounded batches, avoiding thousands of simultaneous crypto jobs.
  for (let offset = 0; offset < playlist.items.length; offset += 250) {
    const batch = await Promise.all(playlist.items.slice(offset, offset + 250).map(async item => {
      if (!selectionVodUrlAllowed(feed.id, item.url)) return null;
      const identity = await selectionVodIdentity(feed.id, item);
      return identity ? { ...item, url: httpsUrl(item.url).href, title: clean(item.title), group: clean(item.group), identity } : null;
    }));
    for (const item of batch) {
      if (!item) { rejected++; continue; }
      if (entries.has(item.identity)) { duplicates++; continue; }
      entries.set(item.identity, item);
    }
  }
  if (!entries.size) throw unavailable();
  return { entries, discovered: playlist.items.length, rejected, duplicates, bytesRead: playlist.bytesRead || 0 };
}

export async function fetchSelectionVod({ fetchPlaylist = fetchM3uPlaylistStream, heartbeat = async () => {} } = {}) {
  const items = [], sources = [];
  const parents = new Map();
  let bytesRead = 0;
  for (const feed of SELECTION_VOD_FEEDS) {
    await heartbeat();
    let loaded;
    try { loaded = await loadFeed(feed, fetchPlaylist); }
    catch { sources.push({ id: feed.id, status: 'unavailable', discovered: 0, included: 0 }); continue; }
    bytesRead += loaded.bytesRead;
    for (const item of loaded.entries.values()) {
      const group = `${feed.name} · ${item.group || 'Films'}`;
      const year = (item.group.match(/(?:^|\/\s*)(19\d{2}|20\d{2})$/) || item.title.match(/\((19\d{2}|20\d{2})\)/))?.[1];
      const poster = httpsUrl(item.logo)?.href || null;
      const fields = { item_type: 'movie', external_id: selectionVodExternalId(item.identity),
        title: item.title, parent_external_id: group, subtitle: group, poster_url: poster,
        metadata: { selectionRevision: SELECTION_VOD_REVISION, selectionVodId: item.identity,
          selectionVodTitle: item.title, selectionVodGroup: item.group, selectionVodTvgId: clean(item.tvgId),
          discoveryFeed: feed.id, discoverySource: feed.website,
          tvgId: item.tvgId, group, categoryName: group, container: 'm3u8', containerExtension: 'm3u8',
          ...(year ? { year: Number(year) } : {}),
          plot: `${feed.name}\n${feed.website}\nhttps://norva.tv/catalog/credits.html` },
        playback_hint: { sourceType: 'm3u', targetUrl: item.url, container: 'm3u8', containerExtension: 'm3u8' } };
      const unit = selectionSeriesUnit(item.title);
      if (unit) {
        const seriesId = selectionSeriesExternalId(await selectionSeriesIdentity(feed.id, unit.baseTitle, item.group));
        fields.item_type = 'episode';
        fields.parent_external_id = seriesId;
        fields.metadata.selectionUnit = unit;
        fields.metadata.selectionParentId = seriesId;
        if (!parents.has(seriesId)) {
          const parent = { item: { ...item, title: unit.baseTitle, url: '', tvgId: seriesId }, fields: {
            item_type: 'series', external_id: seriesId, title: unit.baseTitle,
            parent_external_id: `${feed.name} · Séries`, subtitle: group, poster_url: poster,
            // A season release year is not the series' first-air year.
            metadata: { selectionRevision: SELECTION_VOD_REVISION, selectionSeriesTitle: unit.baseTitle,
              selectionVodGroup: item.group, discoveryFeed: feed.id, discoverySource: feed.website,
              seriesDelivery: 'selection', group, categoryName: `${feed.name} · Séries`, plot: fields.metadata.plot },
            playback_hint: { sourceType: 'm3u' },
          } };
          parents.set(seriesId, parent);
          items.push(parent);
        }
      }
      items.push({ item, fields });
    }
    sources.push({ id: feed.id, status: 'loaded', discovered: loaded.discovered, included: loaded.entries.size,
      rejected: loaded.rejected, duplicates: loaded.duplicates });
  }
  return { items, sources, bytesRead };
}

async function ownedIdentity(metadata, itemId) {
  const feed = feeds.get(metadata?.discoveryFeed);
  if (!feed || metadata.selectionRevision !== SELECTION_VOD_REVISION || metadata.discoverySource !== feed.website) throw unavailable();
  const identity = await selectionVodIdentity(feed.id, { title: metadata.selectionVodTitle,
    group: metadata.selectionVodGroup, tvgId: metadata.selectionVodTvgId });
  if (!identity || identity !== metadata.selectionVodId || itemId !== selectionVodExternalId(identity)) throw unavailable();
  return { feed, identity };
}

// Call only after matching the owned canonical Selection source. The client never
// supplies the feed URL. Signed upstream addresses are resolved afresh by stable ID.
export async function resolveSelectionVodTarget({ metadata, itemId, targetUrl,
  fetchPlaylist = fetchM3uPlaylistStream, now = Date.now() }) {
  const { feed, identity } = await ownedIdentity(metadata, itemId);
  if (!selectionVodUrlAllowed(feed.id, targetUrl)) throw unavailable();
  let cache = playbackCaches.get(fetchPlaylist);
  if (!cache) { cache = new Map(); playbackCaches.set(fetchPlaylist, cache); }
  let entry = cache.get(feed.id);
  if (!entry || entry.until <= now) {
    entry = { until: now + 60_000, pending: loadFeed(feed, fetchPlaylist) };
    cache.set(feed.id, entry);
    entry.pending.catch(() => { if (cache.get(feed.id) === entry) cache.delete(feed.id); });
  }
  const item = (await entry.pending).entries.get(identity);
  if (!item) throw unavailable();
  return item.url;
}

export async function resolveSelectionVodDelivery({ sourceId, expectedSourceId, itemType, itemId, ownedItem, targetUrl }) {
  if (sourceId !== expectedSourceId || !['movie', 'series'].includes(itemType) || !ownedItem) return null;
  if (itemType === 'series' && (!selectionSeriesUnit(ownedItem.metadata?.selectionVodTitle)
    || ownedItem.metadata?.selectionParentId !== ownedItem.parent_external_id)) return null;
  try {
    const { feed, identity } = await ownedIdentity(ownedItem.metadata, itemId);
    const hint = ownedItem.playback_hint;
    if (hint?.sourceType !== 'm3u' || hint.container !== 'm3u8'
      || !selectionVodUrlAllowed(feed.id, hint.targetUrl) || !selectionVodUrlAllowed(feed.id, targetUrl)) return null;
    const delivery = Object.freeze({ targetUrl, providerAccountScopeSuffix: `public-vod:${identity}` });
    verifiedDeliveries.add(delivery);
    return delivery;
  } catch { return null; }
}

export function shouldUseSelectionVodRelay({ delivery, targetUrl, itemType, clientMode, body }) {
  if (!verifiedDeliveries.has(delivery) || delivery.targetUrl !== targetUrl || !['movie', 'series'].includes(itemType)) return false;
  // A requested conversion remains a conversion. Only the normal automatic
  // playback route uses byte-preserving HLS with the existing revocable relay.
  if (body.enginePipe === true || body.engine_pipe === true) return false;
  return clientMode === 'relay' || clientMode === 'direct'
    || (clientMode === 'transcode' && body.gatewayAutoMode === true
      && body.forceVideoTranscode !== true && body.force_video_transcode !== true);
}
