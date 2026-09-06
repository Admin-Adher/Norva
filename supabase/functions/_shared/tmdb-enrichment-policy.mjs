// Search has no provider-supplied TMDB identity. Require a strong title/year
// confirmation before replacing editorial metadata; exact artwork is stronger.
export function acceptAutomaticTmdbSearchMatch(row, match) {
  if (!match?.valid || !match.tmdbId) return false;
  if (row.itemType === 'movie' && /\b(?:season|episode)\b/i.test(row.originalTitle || row.title || '')) return false;
  if (match.reason === 'poster_path_confirmed') return true;
  if (!Number.isFinite(match.confidence) || match.confidence < 0.9) return false;
  return !row.releaseYear || !match.year || Math.abs(Number(row.releaseYear) - Number(match.year)) <= 1;
}

export function preferredTmdbSynopsis(localized, fallback, provider) {
  return [localized, fallback, provider].find(value => typeof value === 'string' && value.trim())?.trim() || null;
}

export function isMissingTmdbTitle(error) {
  return error?.name === 'TmdbRequestError' && error.status === 404 && error.retryable === false;
}
