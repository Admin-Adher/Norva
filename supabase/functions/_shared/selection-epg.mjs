import { SELECTION_CURATED_CHANNELS } from './selection-curated-channels.mjs';
import { fetchBoundedProviderJson } from './bounded-provider-response.mjs';

// Public broadcaster data only. Owner/source visibility stays in norva-cloud.
// Exact feed identities prevent a similarly named regional channel supplying
// programmes for a different stream. No provider credentials leave Norva.
const RAKUTEN_ACTION = {
  id: 'rakuten-action-fr', slug: 'action-rakuten-tv', numericalId: 6068,
};
const DW_ENGLISH_URL = 'https://www.dw.com/graph-api/en/livestream/english';
export const SELECTION_EPG_TTL_MS = 120_000;
const publicCache = new Map();
const pending = new Map();

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, limit = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function programme(channelId, item, windowStartMs, windowEndMs) {
  const start = Date.parse(item.start);
  const stop = Date.parse(item.stop);
  const title = text(item.title, 300);
  // Require an explicit timezone; never interpret provider-local wall time as
  // server time or manufacture a daily recurrence from expired listings.
  const zoned = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  if (!zoned(item.start) || !zoned(item.stop) || !title || !Number.isFinite(start) ||
      !Number.isFinite(stop) || stop <= start || stop - start > 24 * 3600_000 ||
      stop <= windowStartMs || start >= windowEndMs) return null;
  return {
    channelId: `norva-selection:${channelId}`,
    title, start: new Date(start).toISOString(), stop: new Date(stop).toISOString(),
    subtitle: text(item.subtitle, 300) || null,
    description: text(item.description),
    category: Array.isArray(item.category) ? item.category.map(v => text(v, 100)).filter(Boolean) : [],
    icon: typeof item.icon === 'string' && item.icon.startsWith('https://') ? item.icon : null,
  };
}

export function parseRakutenSelectionEpg(payload, window) {
  const channel = record(record(payload).data);
  if (channel.id !== RAKUTEN_ACTION.slug || Number(channel.numerical_id) !== RAKUTEN_ACTION.numericalId) {
    throw new Error('Selection guide feed identity mismatch');
  }
  return (Array.isArray(channel.live_programs) ? channel.live_programs : []).slice(0, 300)
    .map(raw => {
      const item = record(raw);
      return programme(RAKUTEN_ACTION.id, {
        title: item.title, start: item.starts_at, stop: item.ends_at,
        subtitle: item.subtitle, description: item.description,
        category: Array.isArray(item.genres) ? item.genres.map(v => record(v).name) : [],
        icon: record(item.images).snapshot_webp || record(item.images).snapshot,
      }, window.windowStartMs, window.windowEndMs);
    }).filter(Boolean);
}

export function parseDwSelectionEpg(payload, window) {
  const channels = record(record(payload).data).livestreamChannels;
  const channel = (Array.isArray(channels) ? channels : []).find(raw => {
    const item = record(raw);
    return Number(item.id) === 35555991 && item.name === 'DW English' &&
      item.hlsVideoSrc === 'https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/master.m3u8';
  });
  if (!channel) throw new Error('Selection guide feed identity mismatch');
  return (Array.isArray(channel.nextTimeSlots) ? channel.nextTimeSlots : []).slice(0, 300)
    .map(raw => {
      const item = record(raw), show = record(item.program), episode = record(item.programElement);
      return programme('dw-news', {
        title: show.name, start: item.startDate, stop: item.endDate,
        subtitle: episode.name, description: episode.teaser, icon: show.posterImageUrl,
      }, window.windowStartMs, window.windowEndMs);
    }).filter(Boolean);
}

async function publicJson(url) {
  const { response, value } = await fetchBoundedProviderJson(url, {
    timeoutMs: 8000, maxBytes: 2 * 1024 * 1024, redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok || !value) throw new Error('Selection guide unavailable');
  return value;
}

export async function fetchSelectionEpg({ windowStartMs, windowEndMs, refresh = false, fetchJson = publicJson }) {
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowEndMs <= windowStartMs ||
      windowEndMs - windowStartMs > 72 * 3600_000) throw new Error('Invalid Selection guide window');
  // Rakuten requires complete UTC hours. Always round outwards to cover now.
  const start = Math.floor(windowStartMs / 3600_000) * 3600_000;
  const end = Math.ceil(windowEndMs / 3600_000) * 3600_000;
  const key = `${start}:${end}`;
  const useCache = fetchJson === publicJson;
  const cached = useCache && publicCache.get(key);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.data;
  if (useCache && pending.has(key)) return await pending.get(key);
  const work = (async () => {
    const url = new URL(`https://gizmo.rakuten.tv/v3/live_channels/${RAKUTEN_ACTION.slug}`);
    for (const [name, value] of Object.entries({ classification_id: '5', device_identifier: 'web', locale: 'fr',
      market_code: 'fr', epg_starts_at: new Date(start).toISOString(), epg_ends_at: new Date(end).toISOString() })) {
      url.searchParams.set(name, value);
    }
    const window = { windowStartMs: start, windowEndMs: end };
    const results = await Promise.allSettled([
      fetchJson(url.href).then(data => parseRakutenSelectionEpg(data, window)),
      fetchJson(DW_ENGLISH_URL).then(data => parseDwSelectionEpg(data, window)),
    ]);
    const programmes = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    programmes.sort((a, b) => a.channelId.localeCompare(b.channelId) || Date.parse(a.start) - Date.parse(b.start));
    const available = new Set(programmes.map(item => item.channelId));
    const supported = new Set(['norva-selection:rakuten-action-fr', 'norva-selection:dw-news']);
    const data = {
      channels: SELECTION_CURATED_CHANNELS.map(channel => ({
        id: `norva-selection:${channel.id}`, name: channel.title, icon: null, url: channel.website,
        guideStatus: available.has(`norva-selection:${channel.id}`) ? 'available'
          : supported.has(`norva-selection:${channel.id}`) ? 'unavailable' : 'not_provided',
      })),
      programmes,
      provenance: [
        { channelId: 'norva-selection:rakuten-action-fr', url: 'https://www.rakuten.tv/fr/live_channels/action-rakuten-tv' },
        { channelId: 'norva-selection:dw-news', url: 'https://www.dw.com/en/live-tv/channel-english' },
      ],
    };
    if (useCache) {
      for (const [cacheKey, entry] of publicCache) if (entry.expiresAt <= Date.now()) publicCache.delete(cacheKey);
      if (publicCache.size >= 12) publicCache.delete(publicCache.keys().next().value);
      publicCache.set(key, { data, expiresAt: Date.now() + SELECTION_EPG_TTL_MS });
    }
    return data;
  })();
  if (useCache) pending.set(key, work);
  try { return await work; } finally { if (useCache) pending.delete(key); }
}
