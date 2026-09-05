import { discoverySourceId } from './discovery-catalog.mjs';
import { fetchBoundedProviderText } from './bounded-provider-response.mjs';

// Quality canary only. These exact catalogue masters retain their media/source
// identity; only the automatic web Gateway input can use a reviewed single-video
// master. It retains ALL original audio/caption declarations and provider URLs.
// This module has no dependency on Selection's import/publication validation gate.
const CANARIES = Object.freeze([
  Object.freeze({
    feedId: 'free-tv', discoverySource: 'https://github.com/Free-TV/IPTV',
    externalId: 'norva-discovery:live:54d0f78572c3b672717ad69cd9ff985467ca01bfcfef213348ba888b6dea7275',
    targetUrlSha256: '8be45acec400e28dedc5b40f00b758818b88125cd70ca0da22230ca7c556abef',
    hosts: Object.freeze(['ott.tv5monde.com']),
    masterSha256: '414b8ad2c851ec9d1579872e77d90d24899a14dbbcdc8b972ad7b9d249f880b7',
    resolvedMasterUrlSha256: '8be45acec400e28dedc5b40f00b758818b88125cd70ca0da22230ca7c556abef',
    assetUrl: 'https://norva.tv/catalog/quality-tv5-info-720.m3u8',
    assetSha256: 'd1db551a1f1c376ae139389da45e00e20336a22245603c5475ab8f6b3736183f',
  }),
  Object.freeze({
    feedId: 'roku', discoverySource: 'https://github.com/insa-ship-it/app-m3u-generator',
    externalId: 'norva-discovery:live:01c0fc76e5315ef14a7bab81fca2db235092b9385749ac2831867507093171d1',
    targetUrlSha256: '16feaa6ebf953dc703ab36fc1defa4b47a2e8f4bb0506c7618c2077ec21668c1',
    hosts: Object.freeze(['jmp2.uk', 'aka-live1050.delivery.roku.com']),
    masterSha256: '540be0ebd7b3bddfab855fd492903b2fb226b75c84f653527faceec211b3cabb',
    resolvedMasterUrlSha256: 'ae16422c295dd994742dcfff755a21a50323de2de97454e79f463dad8924c599',
    assetUrl: 'https://norva.tv/catalog/quality-filmrise-roku-720.m3u8',
    assetSha256: '8941af5ebfda446b250c57326a945e23cd1dd14fa069e5dd55c168b14386bac8',
  }),
]);
const MAX_BYTES = 64 * 1024;
const DEADLINE_MS = 4_000;
const CACHE_MS = 15_000;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const enabled = value => value === true || value === 1 || value === '1' || value === 'true';
const token = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const explicitStreamIndex = value => value != null && value !== '' &&
  Number.isFinite(Number.parseFloat(String(value))) && Number.parseFloat(String(value)) >= 0;
const sha256 = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');

function automaticWebGateway(request, ownedHint) {
  if (!request || request.clientMode !== 'transcode' || request.body?.gatewayAutoMode !== true ||
      request.clientMetadata?.appMode !== 'cloud' ||
      !['web', 'mobile-web', 'pwa'].includes(request.clientMetadata?.clientSurface)) return false;
  for (const hint of [record(request.body), record(request.body.playbackHint),
    record(request.body.playback_hint), record(request.playbackHint), ownedHint]) {
    const mode = token(hint.gatewayMode ?? hint.gateway_mode);
    if ((mode && mode !== 'remux') ||
        ['liveForceTranscode', 'live_force_transcode', 'forceVideoTranscode', 'force_video_transcode',
          'enginePipe', 'engine_pipe', 'requiresRelay', 'requires_relay', 'nativePlayer', 'native_player']
          .some(key => enabled(hint[key]))) return false;
    // StreamIndex is the actual API/Gateway selector. A reduced master can
    // change demux indexes; keep explicit selections on their original input.
    // The API treats negative, null and nonnumeric (e.g. auto) indexes as absent.
    if (['videoStreamIndex', 'video_stream_index', 'audioStreamIndex', 'audio_stream_index',
      'subtitleStreamIndex', 'subtitle_stream_index', 'videoTrackIndex', 'video_track_index',
      'audioTrackIndex', 'audio_track_index', 'subtitleTrackIndex', 'subtitle_track_index']
      .some(key => explicitStreamIndex(hint[key]))) return false;
    if (['quality', 'resolution', 'rendition']
      .some(key => hint[key] != null && hint[key] !== '' && hint[key] !== 'auto')) return false;
  }
  return true;
}

function publicUrl(raw, hosts, base) {
  try {
    const url = new URL(raw, base);
    // Exact reviewed provider hosts, never arbitrary playlist-supplied hosts.
    // This also excludes IP literals, private addresses, ports and lookalikes.
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
        !hosts.includes(url.hostname) || /\{\$|[\r\n]/.test(raw)) return null;
    if ([...url.searchParams.keys()].some(key =>
      /(?:^|[-_.])(user(?:name)?|pass(?:word)?|token|auth(?:orization)?|jwt|signature|secret|credential|api[-_]?key)(?:$|[-_.])/i.test(key))) return null;
    return url;
  } catch { return null; }
}

export function createSelectionLiveRenditionResolver({ fetchText = fetchBoundedProviderText,
  now = Date.now, canaries = CANARIES } = {}) {
  const cache = new Map();
  return async function resolve({ sourceId, userId, itemType, itemId, ownedItem, targetUrl, request }) {
    const metadata = record(ownedItem?.metadata), hint = record(ownedItem?.playback_hint);
    const canary = canaries.find(value => value.externalId === itemId && value.feedId === metadata.discoveryFeed);
    if (!canary || !/^[a-f0-9]{64}$/.test(canary.assetSha256) || itemType !== 'live' || typeof userId !== 'string' || !userId ||
        hint.sourceType !== 'm3u' || hint.container !== 'm3u8' || hint.targetUrl !== targetUrl ||
        metadata.discoverySource !== canary.discoverySource || !automaticWebGateway(request, hint) ||
        sourceId !== await discoverySourceId(userId)) return targetUrl;
    const original = publicUrl(targetUrl, canary.hosts);
    if (!original || metadata.discoveryMediaKey !== original.href ||
        await sha256(original.href) !== canary.targetUrlSha256 ||
        `norva-discovery:live:${await sha256(`live:${original.href}`)}` !== itemId) return targetUrl;
    let cached = cache.get(itemId);
    if (cached && cached.until > now()) return cached.pending;
    const pending = (async () => {
      const deadline = now() + DEADLINE_MS;
      let requests = 0;
      async function read(raw, hosts = canary.hosts) {
        let url = publicUrl(raw, hosts);
        for (let redirects = 0; redirects <= 2; redirects++) {
          const remaining = deadline - now();
          if (!url || remaining <= 0 || ++requests > 4) throw new Error('Selection rendition unavailable');
          const { response, value } = await fetchText(url.href, {
            timeoutMs: remaining, maxBytes: MAX_BYTES, redirect: 'manual',
          });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            url = location ? publicUrl(location, hosts, url.href) : null;
            continue;
          }
          if (!response.ok || (response.url && response.url !== url.href) ||
              typeof value !== 'string' || new TextEncoder().encode(value).length > MAX_BYTES) throw new Error('Selection rendition unavailable');
          return { url: url.href, text: value };
        }
        throw new Error('Selection rendition unavailable');
      }
      const master = await read(original.href);
      if (await sha256(master.text) !== canary.masterSha256 ||
          await sha256(master.url) !== canary.resolvedMasterUrlSha256) return targetUrl;
      // The static master preserves the original AUDIO/CC groups and absolute
      // provider references, including queries. Verify it is published intact
      // before using it; an asset-first rollout or a rollback stays harmless.
      const asset = await read(canary.assetUrl, ['norva.tv']);
      if (asset.url !== canary.assetUrl || await sha256(asset.text) !== canary.assetSha256) return targetUrl;
      return canary.assetUrl;
    })().catch(() => targetUrl);
    cached = { until: now() + CACHE_MS, pending };
    cache.set(itemId, cached);
    return pending;
  };
}

export const resolveSelectionLiveRendition = createSelectionLiveRenditionResolver();
