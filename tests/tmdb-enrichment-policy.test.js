const { test } = require('node:test');
const assert = require('node:assert/strict');
test('automatic matching keeps ambiguous, wrong-year and episodic movie candidates out', async () => {
  const { acceptAutomaticTmdbSearchMatch: accept } = await import('../supabase/functions/_shared/tmdb-enrichment-policy.mjs');
  const row = { itemType: 'movie', title: 'Inception', releaseYear: 2010 };
  const match = { valid: true, tmdbId: '27205', year: '2010', confidence: 1 };
  assert.equal(accept(row, match), true);
  assert.equal(accept(row, { ...match, confidence: 0.8 }), false);
  assert.equal(accept(row, { ...match, year: '2024' }), false);
  assert.equal(accept({ ...row, title: 'Inception Season 2' }, match), false);
  assert.equal(accept({ ...row, itemType: 'series', title: 'Series Season 2' }, match), true);
  assert.equal(accept(row, null), false);
  assert.equal(accept(row, { ...match, confidence: 0.5, reason: 'poster_path_confirmed' }), true);
});
test('synopses prefer the requested TMDB translation, then TMDB fallback, then provider', async () => {
  const { preferredTmdbSynopsis: synopsis } = await import('../supabase/functions/_shared/tmdb-enrichment-policy.mjs');
  assert.equal(synopsis('Résumé français', 'English summary', 'https://provider.example'), 'Résumé français');
  assert.equal(synopsis(' ', 'English summary', 'https://provider.example'), 'English summary');
  assert.equal(synopsis(null, '', 'Provider summary'), 'Provider summary');
  assert.equal(synopsis(null, null, null), null);
});
