'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const root = path.join(__dirname, '..');
const catalog = fs.readFileSync(process.env.NORVA_CATALOG_TEST_SOURCE
  || path.join(root, 'supabase/functions/norva-catalog/index.ts'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20260921153000_catalog_provider_subtitle_facets.sql'), 'utf8');
const languageCode = catalog.slice(catalog.indexOf('const FILE_LANGUAGE_ALIASES:'), catalog.indexOf('function titleVersionLanguages('));
function fixture({ failed = false } = {}) {
  const calls = [];
  const context = vm.createContext({ Intl, Map, Date, URL, recordOrEmpty: v => v || {},
    providerAudioFacet: value => /^(?:catalog|provider)-[a-z]{2}$/.test(value || '') ? value.split('-')[1] : null,
    boundCatalogCacheEpoch: () => 'epoch',
    throwDb: (_, message) => { throw Error(message); },
    db: { rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'cloud_exact_language_counts_by_source' || name === 'cloud_exact_language_counts') return { data: { audio: { fr: 8 }, subtitles: {} } };
      if (name === 'cloud_catalog_audio_language_counts' || name === 'norva_catalog_movie_audio_language_counts') return { data: { fr: 80 } };
      if (name === 'cloud_catalog_unidentified_audio_count' || name === 'norva_catalog_movie_unidentified_audio_count') return { data: 3 };
      if (name === 'cloud_catalog_subtitle_language_counts') return failed ? { error: { code: 'timeout' } } : { data: { fra: 12, eng: 8 } };
      throw Error('Unexpected RPC ' + name);
    } },
  });
  vm.runInContext(stripTypeScriptTypes(languageCode), context);
  const facetEnd = catalog.indexOf('function normalizeObservedSubtitleTracks(') >= 0
    ? catalog.indexOf('function normalizeObservedSubtitleTracks(')
    : catalog.indexOf('// Capture audio/subtitle languages observed');
  const facets = catalog.slice(catalog.indexOf('const FACET_CACHE ='), facetEnd);
  vm.runInContext(stripTypeScriptTypes(facets), context);
  return { context, calls };
}
test('declared subtitle facets are read independently of populated audio and remain source-scoped', async () => {
  const { context, calls } = fixture();
  const source = '12345678-1234-1234-1234-123456789abc';
  const data = await context.listLanguageFacets({}, new URL('https://norva.invalid/media-language-facets?source=' + source), 'owner');
  assert.deepEqual(Array.from(data.subtitles, v => [v.value, v.language, v.count]), [['catalog-fr', 'fr', 12], ['catalog-en', 'en', 8]]);
  assert.ok(data.audio.some(v => v.value === 'catalog-fr'));
  assert.ok(!calls.some(c => c[0].startsWith('cloud_exact_language_counts')), 'catalogue unions already include exact evidence');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(c => c[0] === 'cloud_catalog_subtitle_language_counts')[1])), { p_user_id: 'owner', p_item_type: 'movie', p_source_id: source });
});
test('catalogue subtitle filters and exact ISO preferences remain distinct', () => {
  const { context } = fixture();
  for (const [value, expected] of [['catalog-fr', 'catalog-fr'], ['catalog-fra', 'catalog-fr'], ['catalog-yue', 'catalog-yue'], ['yue', 'yue'], ['fra', 'fr'], ['fr', 'fr'], ['unidentified', null], ['unknown', null], ['catalog-nordic', null], ['catalog-und', null], ['catalog-xx', null], ['catalog-exyu', null]]) {
    assert.equal(context.subtitleFacetIso(value), expected, value);
  }
  assert.match(catalog, /const subIso = subtitleFacetIso\(normalizeFacet\(url.searchParams.get\("subs"\)\)\)/);
  assert.match(catalog, /String\(subIso \|\| ''\).startsWith\('catalog-'\)/);
});
test('subtitle RPC failure remains retryable instead of caching an empty menu', async () => {
  const { context, calls } = fixture({ failed: true });
  const url = new URL('https://norva.invalid/media-language-facets');
  await assert.rejects(context.listLanguageFacets({}, url, 'owner'), /subtitle facets/);
  await assert.rejects(context.listLanguageFacets({}, url, 'owner'), /subtitle facets/);
  assert.equal(calls.filter(c => c[0] === 'cloud_catalog_subtitle_language_counts').length, 2);
});
test('projection, counts and filtering preserve ownership, exact priority and same-variant composition', () => {
  assert.match(sql, /enable row level security/);
  assert.match(sql, /for share of variant/);
  assert.match(sql, /greatest\(1,least\(coalesce\(p_limit,1000\),5000\)\)/);
  assert.match(sql, /v.id=hint.variant_id and v.user_id=hint.user_id/);
  assert.match(sql, /v.title_id=hint.title_id and v.source_id=hint.source_id and v.item_type=hint.item_type/);
  assert.match(sql, /not exists\(select 1 from accepted a where a.variant_id=hint.variant_id and a.title_id=hint.title_id\)/);
  assert.match(sql, /count\(distinct title_id\)/);
  assert.match(sql, /a.variant_id=s.variant_id and a.title_id=s.title_id/);
  assert.doesNotMatch(sql, /(?:update|insert into) public\.(?:cloud_title_file_language_observations|catalog_file_tracks|catalog_owned_language_declarations)\b/i);
  assert.doesNotMatch(sql, /security definer/i);
});
