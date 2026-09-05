import { discoverySourceId } from './discovery-catalog.mjs';

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
const verifiedDeliveries = new WeakSet();
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const token = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const enabled = value => value === true || value === 1 || value === '1' || value === 'true';

export async function resolveSelectionLiveDelivery({ sourceId, userId, itemType, itemId, ownedItem, targetUrl }) {
  if (itemType !== 'live' || typeof userId !== 'string' || !userId || !ownedItem) return null;
  const metadata = record(ownedItem.metadata);
  const hint = record(ownedItem.playback_hint);
  const channel = typeof metadata.tvgId === 'string' && Object.hasOwn(PUBLIC_HLS_CHANNELS, metadata.tvgId)
    ? PUBLIC_HLS_CHANNELS[metadata.tvgId] : null;
  if (!channel || metadata.discoveryFeed !== 'xumo-curated' ||
      metadata.discoverySource !== 'https://play.xumo.com/' ||
      itemId !== channel.itemId || hint.sourceType !== 'm3u' ||
      hint.container !== 'm3u8' || hint.targetUrl !== targetUrl ||
      sourceId !== await discoverySourceId(userId)) return null;

  let url;
  try { url = new URL(targetUrl); } catch { return null; }
  if (url.origin !== channel.origin || url.pathname !== channel.pathname ||
      url.username || url.password || url.hash || metadata.discoveryMediaKey !== url.href) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`live:${url.href}`));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (`norva-discovery:live:${hash}` !== channel.itemId) return null;

  // This descriptor stays outside playback hints. A client/global-catalogue
  // lookalike, including a JSON copy, cannot become routing authority.
  const delivery = Object.freeze({ transport: 'public-hls-direct', channelId: metadata.tvgId, targetUrl });
  verifiedDeliveries.add(delivery);
  return delivery;
}

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
    const mode = token(hint.gatewayMode ?? hint.gateway_mode);
    if ((mode && mode !== 'remux') ||
        enabled(hint.liveForceTranscode ?? hint.live_force_transcode) ||
        enabled(hint.forceVideoTranscode ?? hint.force_video_transcode) ||
        enabled(hint.enginePipe ?? hint.engine_pipe) ||
        enabled(hint.requiresRelay ?? hint.requires_relay)) return false;
  }
  return true;
}
