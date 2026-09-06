import { SELECTION_CURATED_CHANNELS, SELECTION_CURATED_PROVIDERS, SELECTION_CURATED_REVISION, curatedChannelForMetadata, curatedChannelExternalId } from './selection-curated-channels.mjs';
import { DISCOVERY_FILMS, DISCOVERY_PLAYLIST_URL, DISCOVERY_SELECTION_ENABLED, assertDiscoverySelectionAvailable, discoveryMovieFields, discoverySourceId, retiredDiscoverySourceId } from './discovery-catalog.mjs';
import { fetchM3uPlaylistStream } from './m3u-playlist-stream.mjs';
import { matchesSelectionLiveQuarantine, SELECTION_LIVE_QUARANTINE } from './selection-live-quarantine.mjs';

// Public playlist references, not credentials or a promise of worldwide playback.
// Keep provider URLs intact: their advertising and territorial controls still apply.
const github = 'https://raw.githubusercontent.com/';
const fast = `${github}insa-ship-it/app-m3u-generator/main/playlists/`;
const pluto = 'https://github.com/OwnerPlugins/pluto-tv-m3u';
// Historical candidates are retained for reproducible audits; they are not active feeds.
export const DISCOVERY_REVIEW_SOURCES = Object.freeze([
  { id: 'publicdomain', name: 'PublicDomainM3U', kind: 'movie', url: `${github}OnlineM3U/publicdomainm3u/main/movies.m3u`, website: 'https://github.com/OnlineM3U/publicdomainm3u' },
  ...'AR AT BO BR CA CH CL CO CR DE DK DO EC ES FR GB GT HN IT MX NI NO PA PE PY SE SV US UY VE'.split(' ').map(region => ({
    id: `pluto-vod-${region.toLowerCase()}`, name: `Pluto VOD · ${region}`, kind: 'movie', region,
    url: `${github}OwnerPlugins/pluto-tv-m3u/main/pluto-vod-${region}.m3u`, website: pluto, refreshOnPlay: true,
  })),
  { id: 'iptv-org-movies', name: 'IPTV-org Movies', kind: 'live', url: 'https://iptv-org.github.io/iptv/categories/movies.m3u', website: 'https://github.com/iptv-org/iptv' },
  { id: 'free-tv', name: 'Free-TV', kind: 'live', url: `${github}Free-TV/IPTV/master/playlist.m3u8`, website: 'https://github.com/Free-TV/IPTV' },
  ...[['plutotv', 'Pluto TV'], ['plex', 'Plex'], ['roku', 'Roku'], ['tubi', 'Tubi']].map(([id, name]) => ({
    id, name, kind: 'live', url: `${fast}${id}_all.m3u`, website: 'https://github.com/insa-ship-it/app-m3u-generator', refreshOnPlay: id === 'plex',
  })),
  { id: 'xumo-curated', name: 'Xumo', kind: 'live', url: 'https://norva.tv/catalog/xumo-live.m3u', website: 'https://play.xumo.com/' },
].map(Object.freeze));
export const DISCOVERY_SOURCES = Object.freeze(DISCOVERY_SELECTION_ENABLED ? [...SELECTION_CURATED_PROVIDERS] : []);

// Previously researched or retired sources remain documented outside the active feeds.
export const DISCOVERY_RESEARCH = Object.freeze([
  { name: 'IPTV-org general playlist', website: 'https://github.com/iptv-org/iptv', status: 'Removed from Selection', detail: 'The general playlist was retired after playback checks. The separate Movies playlist is also withdrawn during the full review; it contains live cinema channels, not on-demand films.' },
  { name: 'Samsung TV Plus', website: 'https://github.com/insa-ship-it/app-m3u-generator', status: 'Removed from Selection', detail: 'Removed after playback checks. Samsung delivery URLs are also excluded from the aggregate playlists in Norva Selection.' },
  { name: 'm3u8-xtream-playlist', website: 'https://github.com/m3u8-xtream/m3u8-xtream-playlist', status: 'Unavailable', detail: 'The movies and series endpoint does not resolve. Its public TV links are already covered by IPTV-org.' },
  { name: 'Movies Deluxe', website: 'https://github.com/select/movies-deluxe', status: 'Requires a connector', detail: '26,700 records referencing Archive.org and YouTube pages, including clips and incorrect matches; these are not direct media URLs.' },
  { name: 'PublicDomainM3U series', website: 'https://github.com/OnlineM3U/publicdomainm3u', status: 'Requires a series adapter', detail: 'One episode in the earlier audit. Both films and series are withdrawn during the full review.' },
  { name: 'FastChannels', website: 'https://github.com/kineticman/FastChannels', status: 'Generator', detail: 'Self-hosted connectors, not an additional ready-to-play catalogue.' },
  { name: 'yt-movies-m3u', website: 'https://github.com/bplaytv/yt-movies-m3u', status: 'Requires a YouTube player', detail: 'YouTube content needs its official player integration.' },
  { name: 'm3u8_creator', website: 'https://github.com/bitsbb01/m3u8_creator', status: 'Generator', detail: 'Playlist generation tool, not a separate content provider.' },
  { name: 'Free Official YouTube Content', website: 'https://github.com/SuperAB123/Free-Official-Youtube-Content', status: 'Directory', detail: 'Official international YouTube channels; not an M3U feed.' },
  { name: 'Internet Archive', website: 'https://archive.org/details/movies', status: 'Media host', detail: 'Hosts the previously included Blender films and PublicDomainM3U media. These are withdrawn during the full review.' },
  { name: 'Sita Sings the Blues', website: 'https://www.sitasingstheblues.com/license.html', status: 'Individual film under review', detail: 'The creator specifies music exceptions alongside the film licence.' },
  { name: 'VOD-Movies-Playlist-M3U', website: 'https://github.com/vigarepo2/VOD-Movies-Playlist-M3U', status: 'No usable VOD feed', detail: 'The advertised VOD file has no entries; another file contains unidentified television streams.' },
]);

function safeMediaUrl(raw) {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(url.hostname) || /\.(local|internal)$/i.test(url.hostname)) return null;
    if ([...url.searchParams.keys()].some(key => /^(username|password)$/i.test(key))) return null;
    return url;
  } catch { return null; }
}

// The general feed used to run before Movies, so URL deduplication assigned
// cinema channels to iptv-org. Retain these persisted cinema rows until their
// next sync assigns iptv-org-movies; never infer cinema from the programme title.
export function isRetiredGeneralDiscoveryItem(metadata) {
  if (metadata?.discoveryFeed !== 'iptv-org') return false;
  const group = String(metadata.group || '');
  const categories = group.startsWith('IPTV-org · ') ? group.slice('IPTV-org · '.length).split(';') : [];
  return !categories.includes('Movies');
}

// Selection curation only: retain the same channels when another provider serves them.
// Check delivery hosts and paths, not programme names or arbitrary query parameters.
export function isSamsungTvPlusUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (!['https:', 'http:'].includes(url.protocol)) return false;
  const host = url.hostname;
  if (host === 'jmp2.uk') return /^\/stvp-/i.test(url.pathname);
  if (host === 'samsung.wurl.tv' || host.endsWith('.samsung.wurl.tv')) return true;
  return (host === 'amagi.tv' || host.endsWith('.amagi.tv'))
    && /(?:^|[./_-])samsung(?:[a-z]{2})?(?=$|[./_-])/i.test(`${host}${url.pathname}`);
}

export function discoveryMediaKey(feed, raw) {
  const url = safeMediaUrl(raw);
  if (!url || feed.id === 'samsungtvplus' || isSamsungTvPlusUrl(url)) return null;
  if (feed.id.startsWith('pluto-vod-')) {
    const episode = url.pathname.match(/^\/v2\/stitch\/hls\/episode\/([a-f0-9]{24})\/master\.m3u8$/i)?.[1];
    return url.hostname.endsWith('.pluto.tv') && episode ? `pluto-vod:${episode}` : null;
  }
  // Plex anonymous manifest tokens rotate; the provider's part id is stable.
  if (feed.id === 'plex' && url.hostname === 'epg.provider.plex.tv') url.searchParams.delete('X-Plex-Token');
  url.hash = '';
  return url.href;
}

async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function quarantinedLiveMedia(feedId, key, targetUrl) {
  if (!SELECTION_LIVE_QUARANTINE.some(entry => entry.feedId === feedId)) return false;
  const externalId = `norva-discovery:live:${await hash(`live:${key}`)}`;
  if (!SELECTION_LIVE_QUARANTINE.some(entry => entry.externalId === externalId)) return false;
  const url = safeMediaUrl(targetUrl);
  return !!url && matchesSelectionLiveQuarantine({ feedId, externalId,
    mediaKeySha256: await hash(key), targetUrlSha256: await hash(url.href) });
}

const trusted = Symbol('server-created discovery item');
function bundledFilms() {
  return DISCOVERY_FILMS.map(film => ({ title: film.title, url: film.url, tvgId: `norva-discovery:${film.id}`, logo: film.poster, group: 'Blender Open Movies', [trusted]: discoveryMovieFields(DISCOVERY_PLAYLIST_URL, film.url) }));
}

export function discoveryCatalogFields(playlistUrl, item) {
  if (playlistUrl !== DISCOVERY_PLAYLIST_URL) return {};
  if (item[trusted]) return item[trusted];
  return discoveryMovieFields(playlistUrl, item.url);
}

// Bounded batches avoid holding all 30 regional Pluto documents in memory.
// A failed feed is recorded separately and does not hide the working feeds.
export async function fetchDiscoverySelection({ heartbeat = async () => {} } = {}) {
  assertDiscoverySelectionAvailable();
  await heartbeat();
  const items = await Promise.all(SELECTION_CURATED_CHANNELS.map(async channel => {
    const group = `${channel.provider} · ${channel.group}`;
    const tvgId = `norva-selection:${channel.id}`;
    const metadata = { selectionRevision: SELECTION_CURATED_REVISION, selectionChannelId: channel.id,
      tvgId, group, categoryName: group, container: 'm3u8', containerExtension: 'm3u8',
      discoveryFeed: channel.feedId, discoveryMediaKey: channel.url, discoverySource: channel.website,
      ...(channel.country ? { country: channel.country } : {}) };
    const fields = { item_type: 'live', external_id: await curatedChannelExternalId(channel), title: channel.title,
      parent_external_id: group, subtitle: group, poster_url: null, metadata,
      playback_hint: { sourceType: 'm3u', targetUrl: channel.url, container: 'm3u8', containerExtension: 'm3u8' } };
    return { title: channel.title, url: channel.url, tvgId, group, logo: '', [trusted]: fields };
  }));
  return { items, sources: DISCOVERY_SOURCES.map(source => ({ id: source.id, status: 'loaded', discovered: source.channels, included: source.channels })),
    bytesRead: 0, headerDetected: true, truncated: false, truncationReason: null };
}

// Audit-only parser. Production imports must use the availability-checked wrapper.
export async function fetchDiscoveryCandidates({ fetchPlaylist = fetchM3uPlaylistStream, feeds = [], heartbeat = async () => {} } = {}) {
  feeds = feeds.filter(feed => feed.id !== 'iptv-org');
  const items = bundledFilms();
  const seen = new Set(DISCOVERY_FILMS.map(film => `movie:${film.url}`));
  const sources = [];
  let bytesRead = 0;
  let truncated = false;
  for (let offset = 0; offset < feeds.length; offset += 4) {
    await heartbeat();
    const results = await Promise.allSettled(feeds.slice(offset, offset + 4).map(feed => fetchPlaylist(feed.url, { timeoutMs: 12_000, maxBytes: 8 * 1024 * 1024, maxItems: 20_000 })));
    for (let i = 0; i < results.length; i++) {
      const feed = feeds[offset + i];
      const result = results[i];
      if (result.status !== 'fulfilled' || result.value.response?.ok === false || !result.value.headerDetected || !result.value.items.length) {
        sources.push({ id: feed.id, status: 'unavailable', discovered: 0, included: 0 });
        continue;
      }
      const playlist = result.value;
      bytesRead += playlist.bytesRead || 0;
      truncated ||= playlist.truncated;
      let included = 0;
      let duplicates = 0;
      let rejected = 0;
      for (const entry of playlist.items) {
        const key = discoveryMediaKey(feed, entry.url);
        if (!key) { rejected++; continue; }
        const identity = `${feed.kind}:${key}`;
        if (feed.kind === 'live' && await quarantinedLiveMedia(feed.id, key, entry.url)) { rejected++; continue; }
        if (seen.has(identity)) { duplicates++; continue; }
        if (items.length >= 60_000) { truncated = true; break; }
        seen.add(identity);
        const externalId = `norva-discovery:${feed.kind}:${await hash(identity)}`;
        const container = feed.kind === 'live' || feed.id.startsWith('pluto-vod-') ? 'm3u8' : 'mp4';
        const group = `${feed.name}${entry.group ? ` · ${entry.group}` : ''}`;
        const metadata = {
          tvgId: entry.tvgId, group, categoryName: group, container, containerExtension: container,
          discoveryFeed: feed.id, discoveryMediaKey: key, discoverySource: feed.website,
          ...(feed.region ? { country: feed.region } : {}),
          ...(feed.kind === 'movie' ? { plot: `${feed.name}\n${feed.website}\nhttps://norva.tv/catalog/credits.html`, year: entry.title.match(/\((19\d{2}|20\d{2})\)/)?.[1] } : {}),
        };
        const fields = { item_type: feed.kind, external_id: externalId, title: entry.title,
          parent_external_id: group, subtitle: group, poster_url: entry.logo || null, metadata,
          playback_hint: { sourceType: 'm3u', targetUrl: entry.url, container, containerExtension: container },
        };
        items.push({ ...entry, [trusted]: fields });
        included++;
      }
      sources.push({ id: feed.id, status: playlist.truncated ? 'truncated' : 'loaded', discovered: playlist.items.length, included, duplicates, rejected });
    }
  }
  return { items, sources, bytesRead, headerDetected: true, truncated, truncationReason: truncated ? 'selection_limit' : null };
}

const playbackFeeds = new Map();
// Only an owned Norva Selection row may refresh an expiring upstream reference.
// Never accept a feed URL or content identity from a client's playback hint.
export async function resolveDiscoveryTarget(options) {
  if (options.sourceId === await retiredDiscoverySourceId(options.userId)) throw new Error('Selection programme is temporarily unavailable');
  if (options.sourceId !== await discoverySourceId(options.userId)) return options.targetUrl;
  assertDiscoverySelectionAvailable();
  if (!curatedChannelForMetadata(options.metadata, options.targetUrl)) throw new Error('Selection programme is temporarily unavailable');
  return options.targetUrl;
}

export async function resolveDiscoveryCandidateTarget({ sourceId, userId, metadata, targetUrl, fetchPlaylist = fetchM3uPlaylistStream, now = Date.now() }) {
  if (sourceId === await discoverySourceId(userId) && isRetiredGeneralDiscoveryItem(metadata)) {
    throw new Error('Selection programme is temporarily unavailable');
  }
  if (sourceId === await discoverySourceId(userId)
      && typeof metadata?.discoveryMediaKey === 'string'
      && await quarantinedLiveMedia(metadata.discoveryFeed, metadata.discoveryMediaKey, targetUrl)) {
    throw new Error('Selection programme is temporarily unavailable');
  }
  const feed = DISCOVERY_REVIEW_SOURCES.find(source => source.id === metadata?.discoveryFeed && source.refreshOnPlay);
  if (!feed || sourceId !== await discoverySourceId(userId)) return targetUrl;
  const key = discoveryMediaKey(feed, targetUrl);
  if (!key || key !== metadata.discoveryMediaKey) throw new Error('Selection media identity mismatch');
  let cached = playbackFeeds.get(feed.id);
  if (!cached || cached.until <= now) {
    const pending = (async () => {
      const playlist = await fetchPlaylist(feed.url, { timeoutMs: 12_000, maxBytes: 8 * 1024 * 1024, maxItems: 20_000 });
      if (playlist.response?.ok === false || !playlist.headerDetected || playlist.truncated || !playlist.items.length) throw new Error('Selection feed unavailable');
      return new Map(playlist.items.map(item => [discoveryMediaKey(feed, item.url), item.url]));
    })();
    cached = { until: now + 60_000, pending };
    playbackFeeds.set(feed.id, cached);
    pending.catch(() => { if (playbackFeeds.get(feed.id) === cached) playbackFeeds.delete(feed.id); });
  }
  const refreshed = (await cached.pending).get(key);
  if (!refreshed) throw new Error('Selection programme no longer available');
  return refreshed;
}
