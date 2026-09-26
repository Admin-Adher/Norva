const test = require('node:test');
const assert = require('node:assert/strict');
const attribution = 'Sandro · Sélection\nhttps://github.com/example/playlist\nhttps://norva.tv/catalog/credits.html';

test('legacy source attribution never survives catalogue detail or nested metadata serialization', async () => {
  const { sanitizeCatalogMediaItem } = await import('../supabase/functions/_shared/catalog-public-view.mjs');
  const { sanitizeMediaMetadata } = await import('../supabase/functions/_shared/cloud-public-view.mjs');
  const fields = { overview: attribution, description: attribution, plot: attribution };
  const before = { title: 'Film', ...fields, metadata: fields, data: fields, tmdb: fields,
    variants: [{ id: 'variant', metadata: fields }] };
  const after = sanitizeCatalogMediaItem(before);
  assert.equal(JSON.stringify(after).includes('github.com'), false);
  assert.equal(JSON.stringify(sanitizeMediaMetadata(fields)).includes('github.com'), false);
  assert.equal(before.overview, attribution, 'serialization does not erase stored provenance');
  assert.equal(after.title, 'Film');
});

test('real synopses and legitimate URL mentions survive; TMDB fallback skips old credits', async () => {
  const { sanitizeCatalogMediaItem } = await import('../supabase/functions/_shared/catalog-public-view.mjs');
  const { preferredTmdbSynopsis } = await import('../supabase/functions/_shared/tmdb-enrichment-policy.mjs');
  const synopsis = 'Un documentaire sur GitHub et ses communautés. Voir https://github.com/example/project.';
  assert.equal(sanitizeCatalogMediaItem({ overview: synopsis }).overview, synopsis);
  assert.equal(preferredTmdbSynopsis(attribution, 'Synopsis TMDB français.', synopsis), 'Synopsis TMDB français.');
  assert.equal(preferredTmdbSynopsis(null, null, attribution), null);
});
