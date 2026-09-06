import { selectionSeriesUnit } from './selection-series.mjs';
import { tmdbSearchYear } from './tmdb-search-policy.mjs';
// Search has no provider-supplied TMDB identity. Require a strong title/year
// confirmation before replacing editorial metadata; exact artwork is stronger.
export function acceptAutomaticTmdbSearchMatch(row, match) {
  if (!match?.valid || !match.tmdbId) return false;
  // Keep an editorial rejection attached to the catalogue row: a later retry
  // must not restore a known homonym just because its alias is an exact match.
  const rejectedIds = row.metadata?.tmdbSearchReview?.rejectedTmdbIds;
  if (Array.isArray(rejectedIds) && rejectedIds.some(id => String(id) === String(match.tmdbId))) return false;
  if (row.itemType === 'movie' && selectionSeriesUnit(row.originalTitle || row.title || '')) return false;
  if (match.reason === 'poster_path_confirmed') return true;
  if (!Number.isFinite(match.confidence) || match.confidence < 0.9) return false;
  const year = tmdbSearchYear(row.originalTitle || row.title, row.releaseYear);
  return !year || !match.year || Math.abs(Number(year) - Number(match.year)) <= 1;
}

export function preferredTmdbSynopsis(localized, fallback, provider) {
  return [localized, fallback, provider].find(value => typeof value === 'string' && value.trim())?.trim() || null;
}

export function isMissingTmdbTitle(error) {
  return error?.name === 'TmdbRequestError' && error.status === 404 && error.retryable === false;
}
