import { cleanTmdbSearchQuery } from './tmdb-search-policy.mjs';

// A number is required: "Happiest Season" and "Season of Love" are movies.
// A playlist file may contain a season or a part, not separate episode URLs.
export function selectionSeriesUnit(title) {
  const raw = String(title || '').normalize('NFKC');
  const marker = /\b(?:seasons?\s+(\d{1,2})(?!\d)|S(\d{1,2})\s*E(\d{1,3})(?!\d))/i.exec(raw);
  if (!marker || !marker.index) return null;
  const baseTitle = cleanTmdbSearchQuery(raw.slice(0, marker.index));
  if (!baseTitle) return null;
  const season = Number(marker[1] ?? marker[2]);
  if (season < 1 || season > 99) return null;
  const tail = raw.slice(marker.index + marker[0].length);
  const extra = marker[1] ? /^(?:\s*(?:[-–&,]|and)?\s*)(\d{1,2})(?!\d)/i.exec(tail) : null;
  const seasons = [season];
  if (extra && Number(extra[1]) > season && Number(extra[1]) <= 99) seasons.push(Number(extra[1]));
  const episode = Number(marker[3] || /\bepisodes?\s+(\d{1,3})(?!\d)/i.exec(tail)?.[1]) || null;
  const part = Number(/\bpart\s+(\d{1,2})(?!\d)/i.exec(tail)?.[1]) || null;
  return { baseTitle, seasons, episode, part, kind: part ? 'part' : episode ? 'episode' : 'season' };
}

export async function selectionSeriesIdentity(feedId, title, group) {
  const languageGroup = String(group || '').normalize('NFKC').replace(/\s*\/\s*(?:19|20)\d{2}\s*$/, '').trim();
  const key = [feedId, String(title).normalize('NFKC').toLowerCase(), languageGroup.toLowerCase()];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(key)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export const selectionSeriesExternalId = identity => `norva-selection:series:${identity}`;

export function isSelectionSeriesUnit(unit) {
  return !!unit && ['season', 'part', 'episode'].includes(unit.kind)
    && typeof unit.baseTitle === 'string' && unit.baseTitle.length > 0 && unit.baseTitle.length <= 512
    && Array.isArray(unit.seasons) && unit.seasons.length >= 1 && unit.seasons.length <= 2
    && unit.seasons.every(value => Number.isInteger(value) && value >= 1 && value <= 99)
    && (unit.episode === null || (Number.isInteger(unit.episode) && unit.episode >= 1 && unit.episode <= 999))
    && (unit.part === null || (Number.isInteger(unit.part) && unit.part >= 1 && unit.part <= 99));
}
