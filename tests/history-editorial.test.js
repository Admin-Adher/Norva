const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture(options = {}) {
  const { refreshHistoryEditorial } = await import('../supabase/functions/_shared/history-editorial.mjs');
  const rows = [{ id: 'history', source_id: 'source', item_type: 'movie', item_id: 'file',
    progress_seconds: 152, duration_seconds: 600, updated_at: '2026-09-26T07:00:00Z',
    data: { title: 'Old title', poster: 'old.jpg', titleId: 'obsolete-title', containerExtension: 'mp4' } }];
  const original = structuredClone(rows);
  const variant = { title_id: 'title', source_id: 'source', item_type: 'movie', external_id: 'file', generation_id: 'generation' };
  const title = { id: 'title', user_id: options.foreign ? 'other-owner' : 'owner',
    visible_source_ids: options.hidden ? [] : ['source'], match_status: 'matched',
    title: 'Current title', poster_url: 'https://norva.tv/new.jpg',
    release_year: 1997, rating_num: 4.75,
    metadata: { i18n: { fr: { title: 'Titre corrigé', overview: 'Synopsis actuel en français' } },
      tmdb: { overview: 'English fallback', genres: [{ id: 28, name: 'Action' }] } },
    ...(options.generation ? { overlay_generation_id: 'generation', display_generation_id: 'generation',
      overlay_catalog_metadata: { tmdbValidation:{valid:!options.untrustedGeneration},
        i18n:{fr:{overview:'Synopsis de la génération active'}} } } : {}),
    ...(options.progressive ? { overlay_generation_id: 'other', display_generation_id: 'other' } : {}) };
  const query = { select() { return this; }, eq(k, v) { if (k === 'user_id') assert.equal(v, 'owner'); return this; },
    async in() { return { data: options.ambiguous ? [variant, variant] : [variant] }; } };
  const db = { from(table) { assert.equal(table, 'cloud_catalog_visible_title_variants'); return query; },
    async rpc(name, args) {
      assert.equal(args.p_expected_visibility_epoch, '42');
      if (options.failure) throw Error('unavailable');
      return { data: { contract: 'catalog-title-hydration-v3', visibilityEpoch: options.stale ? '43' : '42', items: [title] } };
    } };
  const result = await refreshHistoryEditorial(rows, { db, userId: 'owner', epoch: '42', lang: 'fr' });
  return { rows, original, result };
}

test('history refreshes current owned artwork and localized title without rewriting progress or routing', async () => {
  const { rows, original, result } = await fixture();
  assert.deepEqual(rows, original);
  assert.equal(result[0].data.title, 'Titre corrigé');
  assert.equal(result[0].data.poster, 'https://norva.tv/new.jpg');
  assert.equal(result[0].data.description, 'Synopsis actuel en français');
  assert.equal(result[0].data.year, 1997);
  assert.equal(result[0].data.rating, 4.75);
  assert.deepEqual(result[0].data.genres, [{ id: 28, name: 'Action' }]);
  assert.equal(result[0].data.audioLanguages, undefined);
  const { sanitizeWatchHistory, sanitizeHistoryData } = await import('../supabase/functions/_shared/cloud-public-view.mjs');
  const publicHistory = sanitizeWatchHistory(result[0]);
  assert.equal(publicHistory.data.description, 'Synopsis actuel en français');
  assert.equal(publicHistory.data.year, 1997);
  assert.equal(publicHistory.data.rating, 4.75);
  assert.deepEqual(publicHistory.data.genres, ['Action']);
  assert.equal(sanitizeHistoryData(result[0].data).description, undefined, 'progress writes remain lean');
  for (const key of ['id', 'source_id', 'item_type', 'item_id', 'progress_seconds', 'duration_seconds', 'updated_at'])
    assert.equal(result[0][key], original[0][key]);
  assert.equal(result[0].data.containerExtension, 'mp4');
  assert.equal(result[0].data.titleId, 'obsolete-title');
});

test('public history exposes only bounded editorial fields and keeps private nested genre values out', async () => {
  const { sanitizeWatchHistory } = await import('../supabase/functions/_shared/cloud-public-view.mjs');
  const result = sanitizeWatchHistory({ data: { title:'Film', description:'x'.repeat(20001),year:-1,rating:99,
    genres:[{name:'Action',credentials:'must not escape'},null,'Drama'],token:'secret' } });
  assert.equal(result.data.description,undefined); assert.equal(result.data.year,undefined);
  assert.equal(result.data.rating,undefined); assert.equal(result.data.token,undefined);
  assert.deepEqual(result.data.genres,['Action','Drama']);
});

test('history prefers only the trusted exact generation synopsis', async () => {
  assert.equal((await fixture({generation:true})).result[0].data.description, 'Synopsis de la génération active');
  assert.equal((await fixture({generation:true,untrustedGeneration:true})).result[0].data.description, 'Synopsis actuel en français');
});
for (const option of ['foreign', 'hidden', 'ambiguous', 'stale', 'progressive', 'failure']) {
  test(`history preserves its snapshot for ${option} metadata`, async () => {
    const { original, result } = await fixture({ [option]: true });
    assert.deepEqual(result, original);
  });
}

test('O Retorno uses attributed festival facts without inventing TMDB values or overwriting known translations', async () => {
  const { supplementSelectionEditorial, supplementSelectionExtras, RETORNO_EDITORIAL } = await import('../supabase/functions/_shared/selection-editorial-supplements.mjs');
  const input = { provider_tmdb_id: '1745971', match_status: 'matched', metadata: { tmdb: {}, i18n: { en: { overview: 'Existing' } } } };
  const result = supplementSelectionEditorial(input);
  assert.equal(result.metadata.runtime, 15);
  assert.equal(result.metadata.i18n.en.overview, 'Existing');
  assert.match(result.metadata.i18n.fr.overview, /Yanomami/);
  assert.deepEqual(result.metadata.tmdb, {});
  assert.equal(result.metadata.editorialSupplement.source, 'https://www.falasaochico.com.br/filme.php?id=11961');
  assert.equal(input.metadata.runtime, undefined);
  const other = { ...input, provider_tmdb_id: '123' };
  assert.equal(supplementSelectionEditorial(other), other);
  const extras = supplementSelectionExtras({ cast: [], directors: [] }, new URL('https://norva.tv/?type=movie&tmdbId=1745971&lang=fr'));
  assert.deepEqual(extras.directors, RETORNO_EDITORIAL.directors);
  assert.equal(extras.cast[0].name, 'Mario Gianni');
});
