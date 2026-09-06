import { discoverySourceId } from './discovery-catalog.mjs';
import { SELECTION_LIVE_DIRECT_CANARIES } from './selection-live-direct-canaries.mjs';

// Reviewed public H.264/AAC HLS with browser CORS, 2026-09-05. The complete
// imported media identity pins the provider's advertising parameters as well as
// the asset. A feed/URL change must be reviewed before it can use this lane.
const PUBLIC_HLS_CHANNELS = Object.freeze({
  '99951251': Object.freeze({
    origin: 'https://d10xbgdha1yz8s.cloudfront.net',
    pathname: '/10001/99951251/hls/playlist.m3u8',
    itemId: 'norva-discovery:live:a8b253951350b12b699d671ad39b7fc87c6c52b6d1e74db167ad1ad37be67052',
  }),
  '99991638': Object.freeze({
    origin: 'https://dbrb49pjoymg4.cloudfront.net',
    pathname: '/10001/99991638/hls/playlist.m3u8',
    itemId: 'norva-discovery:live:b9dd1102ab7b431fe392cb4e49f7471eff4e714945547c1c300c42bf96610199',
  }),
});
// Reviewed programmes after Web, Android phone and TV playback checks. Plex refreshes its anonymous
// token before playback; bind the full regional provider part and every non-token
// URL component to the owned row. The second part identifies the reviewed channel.
// The browser keeps long nested HLS URLs intact, unlike FFmpeg 5.1's URL buffer.
const PLEX_REVIEWED_CHANNELS = Object.freeze([
  '66be944f8711311880995280', // Action Hollywood Movies
  '68a799722895f21006e758e4', // TV5MONDE Info
  '6245f06793b402a3d1097787', // Euronews Francais
]);
const verifiedDeliveries = new WeakSet();
const canaryDeliveries = new WeakSet();
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const token = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const enabled = value => value === true || value === 1 || value === '1' || value === 'true';
const digestPattern = /^[a-f0-9]{64}$/;
const canaryFields = ['feedId', 'discoverySource', 'tvgId', 'externalId', 'targetUrlSha256',
  'origin', 'pathname', 'ownerUserIdSha256'];
const streamSelectionFields = ['videoStreamIndex', 'video_stream_index', 'audioStreamIndex', 'audio_stream_index',
  'subtitleStreamIndex', 'subtitle_stream_index', 'videoTrackIndex', 'video_track_index',
  'audioTrackIndex', 'audio_track_index', 'subtitleTrackIndex', 'subtitle_track_index'];

function hasExplicitCanarySelection(hint) {
  if (streamSelectionFields.some(key => {
    const index = Number.parseFloat(String(hint[key]));
    return Number.isFinite(index) && index >= 0;
  })) return true;
  return ['quality', 'resolution', 'rendition', 'preferredQuality', 'preferred_quality'].some(key => {
    const value = hint[key];
    return value != null && !['', 'auto', '-1'].includes(String(value).trim().toLowerCase());
  });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function exactPlexPart(raw, part) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    const keys = [...url.searchParams.keys()];
    if (url.href !== raw || url.origin !== 'https://epg.provider.plex.tv' || url.username || url.password || url.hash
      || url.pathname !== `/library/parts/${part}/` || keys.length !== 1 || keys[0] !== 'X-Plex-Token'
      || !/^[A-Za-z0-9_-]{1,256}$/.test(url.searchParams.get('X-Plex-Token'))) return null;
    url.search = '';
    return url.href;
  } catch { return null; }
}

function canarySnapshot(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > 16) return [];
  const entries = manifest.entries.filter(value => {
    const entry = record(value);
    if (Object.keys(entry).length !== canaryFields.length || !canaryFields.every(key => Object.hasOwn(entry, key))
      || !canaryFields.every(key => typeof entry[key] === 'string')
      || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(entry.feedId)
      || typeof entry.tvgId !== 'string' || !entry.tvgId.trim() || entry.tvgId.length > 160
      || !/^norva-discovery:live:[a-f0-9]{64}$/.test(entry.externalId)
      || !digestPattern.test(entry.targetUrlSha256) || !digestPattern.test(entry.ownerUserIdSha256)
      || typeof entry.pathname !== 'string' || !entry.pathname.startsWith('/') || !entry.pathname.endsWith('.m3u8')) return false;
    try {
      const source = new URL(entry.discoverySource), origin = new URL(entry.origin);
      return source.protocol === 'https:' && !source.username && !source.password && !source.hash
        && typeof entry.discoverySource === 'string' && source.href === entry.discoverySource
        && origin.protocol === 'https:' && origin.origin === entry.origin;
    } catch { return false; }
  }).map(entry => Object.freeze(Object.fromEntries(canaryFields.map(key => [key, entry[key]]))));
  // Repeated owner/item coordinates are ambiguous, even if their pins differ.
  const key = entry => `${entry.ownerUserIdSha256}:${entry.externalId}`;
  return Object.freeze(entries.filter(entry => entries.filter(other => key(other) === key(entry)).length === 1));
}

// Injection is for server wiring and isolated tests, never a request field.
// Snapshot the manifest once: mutating a caller's object cannot grant a lane.
export function createSelectionLiveDeliveryResolver({ canaryManifest = SELECTION_LIVE_DIRECT_CANARIES } = {}) {
  const canaries = canarySnapshot(canaryManifest);
  return async function resolveSelectionLiveDelivery({ sourceId, userId, itemType, itemId, ownedItem, targetUrl }) {
    if (itemType !== 'live' || typeof userId !== 'string' || !userId || !ownedItem) return null;
    const metadata = record(ownedItem.metadata);
    const hint = record(ownedItem.playback_hint);
    if (metadata.discoveryFeed === 'plex') {
      const part = metadata.tvgId;
      const channelId = typeof part === 'string' ? part.match(/^[a-f0-9]{24}-([a-f0-9]{24})$/)?.[1] : null;
      if (!channelId || !PLEX_REVIEWED_CHANNELS.includes(channelId)
        || metadata.discoverySource !== 'https://github.com/insa-ship-it/app-m3u-generator'
        || hint.sourceType !== 'm3u' || hint.container !== 'm3u8' || hasExplicitCanarySelection(hint)
        || sourceId !== await discoverySourceId(userId)) return null;
      const key = exactPlexPart(targetUrl, part);
      if (!key || exactPlexPart(hint.targetUrl, part) !== key || metadata.discoveryMediaKey !== key
        || itemId !== `norva-discovery:live:${await sha256(`live:${key}`)}`) return null;
      const delivery = Object.freeze({ transport: 'public-hls-direct', channelId: part, targetUrl,
        providerAccountScopeSuffix: `public-media:${itemId.slice('norva-discovery:live:'.length)}` });
      verifiedDeliveries.add(delivery);
      canaryDeliveries.add(delivery);
      return delivery;
    }
    const channel = typeof metadata.tvgId === 'string' && Object.hasOwn(PUBLIC_HLS_CHANNELS, metadata.tvgId)
      ? PUBLIC_HLS_CHANNELS[metadata.tvgId] : null;
    if (!channel && !canaries.length) return null;
    if (hint.sourceType !== 'm3u' ||
        hint.container !== 'm3u8' || hint.targetUrl !== targetUrl ||
        sourceId !== await discoverySourceId(userId)) return null;

    let url;
    try { url = new URL(targetUrl); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || metadata.discoveryMediaKey !== url.href) return null;
    const externalId = `norva-discovery:live:${await sha256(`live:${url.href}`)}`;
    const reviewedXumo = channel && metadata.discoveryFeed === 'xumo-curated'
      && metadata.discoverySource === 'https://play.xumo.com/' && itemId === channel.itemId
      && url.origin === channel.origin && url.pathname === channel.pathname && externalId === channel.itemId;
    if (!reviewedXumo) {
      if (!canaries.length || targetUrl !== url.href || externalId !== itemId || hasExplicitCanarySelection(hint)) return null;
      const [ownerHash, urlHash] = await Promise.all([sha256(userId), sha256(url.href)]);
      if (!canaries.some(entry => entry.ownerUserIdSha256 === ownerHash && entry.externalId === itemId
        && entry.targetUrlSha256 === urlHash && entry.origin === url.origin && entry.pathname === url.pathname
        && entry.feedId === metadata.discoveryFeed && entry.discoverySource === metadata.discoverySource
        && entry.tvgId === metadata.tvgId)) return null;
    }

    // This descriptor stays outside playback hints. A client/global-catalogue
    // lookalike, including a JSON copy, cannot become routing authority.
    const delivery = Object.freeze({ transport: 'public-hls-direct', channelId: metadata.tvgId, targetUrl,
      providerAccountScopeSuffix: reviewedXumo ? 'public-feed:xumo-curated'
        : `public-media:${externalId.slice('norva-discovery:live:'.length)}` });
    verifiedDeliveries.add(delivery);
    if (!reviewedXumo) canaryDeliveries.add(delivery);
    return delivery;
  };
}

export const resolveSelectionLiveDelivery = createSelectionLiveDeliveryResolver();

export function shouldUseSelectionLiveDirect({ delivery, targetUrl, itemType, clientMode, body, clientMetadata, playbackHint }) {
  if (!verifiedDeliveries.has(delivery) || delivery.targetUrl !== targetUrl ||
      itemType !== 'live' || clientMode !== 'transcode' ||
      body.gatewayAutoMode !== true || body.publicHlsDirectSessionGuard !== true ||
      !['web', 'mobile-web', 'pwa'].includes(clientMetadata.clientSurface) ||
      clientMetadata.appMode !== 'cloud') return false;

  // Automatic gateway requests carry requiresTranscode=true, so that flag is
  // not an explicit conversion request. Preserve explicit modes and all force
  // conversion hints (including either client alias) instead.
  for (const hint of [body, record(body.playbackHint), record(body.playback_hint), record(playbackHint)]) {
    // A direct canary must not silently ignore a requested track or quality.
    // Keep its scope private so request hints cannot impersonate a canary.
    if (canaryDeliveries.has(delivery) && hasExplicitCanarySelection(hint)) return false;
    const mode = token(hint.gatewayMode ?? hint.gateway_mode);
    if ((mode && mode !== 'remux') ||
        enabled(hint.liveForceTranscode ?? hint.live_force_transcode) ||
        enabled(hint.forceVideoTranscode ?? hint.force_video_transcode) ||
        enabled(hint.enginePipe ?? hint.engine_pipe) ||
        enabled(hint.requiresRelay ?? hint.requires_relay)) return false;
  }
  return true;
}
