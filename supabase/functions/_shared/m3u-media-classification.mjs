import { m3uDurationSeconds } from './m3u-duration.mjs';

// Extended M3U has no universal VOD schema. Only explicit media metadata or
// the complete Xtream media path is evidence of VOD; extension/group/duration
// alone never move a television channel into the film catalogue.
const TYPES = new Map([
  ['live', 'live'], ['tv', 'live'], ['channel', 'live'],
  ['movie', 'movie'], ['film', 'movie'], ['vod', 'movie'],
  ['series', 'episode'], ['episode', 'episode'],
]);
const CONTAINERS = new Set(['mp4', 'mkv', 'ts', 'm3u8', 'webm', 'avi', 'mov', 'm4v']);
const clean = value => typeof value === 'string' ? value.trim() : '';
const normalized = value => clean(value).normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
const integer = (value, minimum, maximum) => /^\d{1,5}$/.test(clean(value))
  && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : null;

function pathEvidence(url) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return {};
    const match = parsed.pathname.match(/^\/(live|movie|series)\/[^/]+\/[^/]+\/[^/]+\/?$/i);
    const extension = parsed.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
    return { kind: match ? TYPES.get(match[1].toLowerCase()) : null,
      container: CONTAINERS.has(extension) ? extension : null };
  } catch (_) { return {}; }
}

function episodeIdentity(item) {
  const media = item.media || {};
  let seriesTitle = clean(media.seriesName);
  let season = integer(media.season, 0, 999);
  let episode = integer(media.episode, 1, 99999);
  if ((clean(media.season) && season === null) || (clean(media.episode) && episode === null)) return null;
  // A filename-like episode marker is used only AFTER series evidence exists.
  const match = clean(item.title).match(/^(.+?)\s+(?:S(\d{1,3})[ ._-]*E(\d{1,4})|(\d{1,3})x(\d{1,4}))(?:\b|_)/i);
  if (match) {
    if (!seriesTitle) seriesTitle = match[1].replace(/[\s._-]+$/, '').trim();
    if (season === null) season = Number(match[2] || match[4]);
    if (episode === null) episode = Number(match[3] || match[5]);
  }
  if (!seriesTitle || seriesTitle.length > 1024 || season === null || episode === null || episode < 1) return null;
  return { seriesTitle, season, episode, seriesId: clean(media.seriesId) };
}

export function classifyM3uItem(item) {
  const media = item.media || {};
  const explicit = [media.mediaType, media.tvgType].map(normalized).filter(Boolean);
  const kinds = new Set(explicit.map(value => TYPES.get(value)).filter(Boolean));
  const path = pathEvidence(item.url);
  // Contradictory or unsupported explicit declarations are not permission to
  // infer VOD from a lower-precedence URL. Preserve the safe historical route.
  const conflict = kinds.size > 1 || explicit.some(value => !TYPES.has(value));
  const kind = conflict ? 'live' : [...kinds][0] || path.kind || 'live';
  const evidence = conflict ? 'ambiguous_metadata' : explicit.length ? 'explicit' : path.kind ? 'xtream_path' : 'default_live';
  const identity = kind === 'episode' ? episodeIdentity(item) : null;
  return { kind: kind === 'episode' && !identity ? 'movie' : kind,
    evidence, container: path.container || null, identity,
    unresolvedEpisode: kind === 'episode' && !identity };
}

export async function buildM3uCatalogRows(items, { userId, sourceId, hash, heartbeat = async () => {} }) {
  const rowsByKey = new Map();
  const liveUrlsById = new Map();
  const episodeClaims = new Map();
  for (const item of items) {
    const classified = classifyM3uItem(item);
    if (classified.kind === 'episode' || classified.unresolvedEpisode) {
      if (!episodeClaims.has(item.url)) episodeClaims.set(item.url, new Set());
      const identity = classified.identity;
      episodeClaims.get(item.url).add(identity ? JSON.stringify([
        identity.seriesId ? ['provider-series-id', identity.seriesId]
          : ['series-title', normalized(identity.seriesTitle), normalized(item.group)],
        identity.season, identity.episode,
      ]) : 'unresolved');
    }
    if (item.tvgId && classified.kind === 'live') {
      if (!liveUrlsById.has(item.tvgId)) liveUrlsById.set(item.tvgId, new Set());
      liveUrlsById.get(item.tvgId).add(item.url);
    }
  }
  for (let index = 0; index < items.length; index += 500) {
    await heartbeat();
    const batch = await Promise.all(items.slice(index, index + 500).map(async item => {
      let classification = classifyM3uItem(item);
      if (episodeClaims.get(item.url)?.size > 1 && (classification.kind === 'episode' || classification.unresolvedEpisode)) classification = {
        ...classification, kind: 'movie', identity: null, unresolvedEpisode: true,
        evidence: 'ambiguous_episode_metadata',
      };
      const { kind, identity, evidence, container, unresolvedEpisode } = classification;
      const common = { user_id: userId, source_id: sourceId,
        title: item.title, subtitle: item.group || null, poster_url: item.logo || null,
        backdrop_url: null, available: true };
      // Preserve historical unique TV IDs. A provider reusing one EPG ID for
      // multiple playable URLs needs URL identities, otherwise one upsert batch
      // fails or silently replaces another channel. Identical rows deduplicate.
      if (kind === 'live') return [{ ...common, item_type: 'live',
        external_id: liveUrlsById.get(item.tvgId)?.size > 1
          ? `norva-m3u:live:${await hash(item.url)}` : item.tvgId || await hash(item.url),
        parent_external_id: item.group || null,
        metadata: { tvgId: item.tvgId || '', group: item.group || '' },
        playback_hint: { sourceType: 'm3u', targetUrl: item.url } }];
      const fileId = `norva-m3u:${kind}:${await hash(item.url)}`;
      const durationSeconds = m3uDurationSeconds(item.durationSeconds);
      const durationMetadata = durationSeconds === null ? {} : {
        duration_seconds: durationSeconds, durationSource: 'm3u-extinf',
      };
      const durationHint = durationSeconds === null ? {} : {
        durationSeconds, durationSource: 'm3u-extinf',
      };
      const m3uMedia = { version: 1, kind, evidence,
        ...(unresolvedEpisode ? { unresolvedEpisode: true } : {}),
        ...(identity ? { seriesTitle: identity.seriesTitle, season: identity.season, episode: identity.episode } : {}) };
      const file = { ...common, item_type: kind, external_id: fileId,
        parent_external_id: item.group || null,
        metadata: { tvgId: item.tvgId || '', group: item.group || '', m3uMedia, ...durationMetadata,
          ...(container ? { container_extension: container } : {}) },
        playback_hint: { sourceType: 'm3u', streamType: kind === 'episode' ? 'series' : 'movie', ...durationHint,
          targetUrl: item.url, ...(container ? { container } : {}) } };
      if (!identity) return [file];
      const parentKey = identity.seriesId ? ['provider-series-id', identity.seriesId]
        : ['series-title', normalized(identity.seriesTitle), normalized(item.group)];
      const parentId = `norva-m3u:series:${await hash(JSON.stringify(parentKey))}`;
      file.parent_external_id = parentId;
      return [{ ...common, title: identity.seriesTitle, item_type: 'series', external_id: parentId,
        parent_external_id: item.group || null,
        metadata: { group: item.group || '', m3uMedia: { version: 1, kind: 'series', seriesTitle: identity.seriesTitle } },
        playback_hint: { sourceType: 'm3u', streamType: 'series' } }, file];
    }));
    for (const group of batch) {
      for (const row of group) {
        const key = `${row.item_type}:${row.external_id}`;
        const previous = rowsByKey.get(key);
        // Duplicate display metadata must not make a reordered playlist appear
        // changed. Conflicting episode authority was downgraded above; the
        // remaining descriptive duplicates have a deterministic representative.
        if (!previous || JSON.stringify(canonical(row)) < JSON.stringify(canonical(previous))) rowsByKey.set(key, row);
      }
    }
  }
  return [...rowsByKey.values()];
}

export function m3uCatalogCounts(rows) {
  const counts = { live: 0, movies: 0, series: 0, episodes: 0, total: rows.length };
  const groups = { live: new Set(), movies: new Set(), series: new Set() };
  for (const row of rows) {
    const key = { live: 'live', movie: 'movies', series: 'series', episode: 'episodes' }[row.item_type];
    if (key) counts[key]++;
    if (groups[key] && row.parent_external_id) groups[key].add(row.parent_external_id);
  }
  const categories = Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, value.size]));
  categories.total = categories.live + categories.movies + categories.series;
  return { counts, categories };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]),
  );
  return value;
}

// URLs identify playable files, but a provider can correct an episode number,
// series label or poster without replacing that URL. Include the semantics in
// the M3U-only change signature while keeping every persisted file ID stable.
// Fixed-length digests bound sorting memory; hashing/lease renewal stays batched.
export async function m3uSemanticSignature(rows, { hash, heartbeat = async () => {} }) {
  const digests = [];
  for (let index = 0; index < rows.length; index += 500) {
    await heartbeat();
    digests.push(...await Promise.all(rows.slice(index, index + 500).map(row => hash(JSON.stringify(canonical({
      type: row.item_type, id: row.external_id, parent: row.parent_external_id,
      title: row.title, subtitle: row.subtitle, poster: row.poster_url, backdrop: row.backdrop_url,
      metadata: row.metadata, playback: row.playback_hint, available: row.available,
    }))))));
  }
  digests.sort();
  return { count: rows.length, idsHash: await hash(JSON.stringify(['norva-m3u-semantics-v1', digests])) };
}
