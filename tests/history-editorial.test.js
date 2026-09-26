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
    metadata: { i18n: { fr: { title: 'Titre corrigé' } } },
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
  for (const key of ['id', 'source_id', 'item_type', 'item_id', 'progress_seconds', 'duration_seconds', 'updated_at'])
    assert.equal(result[0][key], original[0][key]);
  assert.equal(result[0].data.containerExtension, 'mp4');
  assert.equal(result[0].data.titleId, 'obsolete-title');
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
