const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const code = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-catalog/index.ts'), 'utf8');
const start = code.indexOf('async function attachOwnedMediaEditorialMetadata(');
const block = code.slice(start, code.indexOf('\nasync function attachMediaLanguages(', start));
const compiled = transformSync(block + '\nmodule.exports = attachOwnedMediaEditorialMetadata;', { loader: 'ts', format: 'cjs' }).code;
const mediaId = '11111111-1111-4111-a111-111111111111';
const titleId = '22222222-2222-4222-a222-222222222222';
function fixture({ foreign = false, stale = false, ambiguous = false, progressive = false, published = false, otherGeneration = false,
  groupedEditorial = false, trusted = true, wrongTmdb = false, singleSource = false,
  itemType = 'movie', localized = true, editorialTitle = 'Inception' } = {}) {
  const generation = progressive || published ? 'active-generation' : null;
  const row = { id: mediaId, source_id: 'owned-source', generation_id: generation,
    metadata: { plot: 'Provider credits' }, audio_languages: ['hi'], playback_hint: { streamId: 'provider-file' } };
  const variant = { id: 'variant', media_item_id: mediaId, title_id: titleId, item_type: itemType,
    source_id: foreign ? 'foreign-source' : row.source_id, generation_id: generation };
  const title = { id: titleId, provider_tmdb_id: '27205', match_status: 'provider_verified',
    visible_source_ids: ['owned-source'], display_generation_id: otherGeneration ? 'other-provider-generation' : generation,
    overlay_generation_id: progressive ? (otherGeneration ? 'other-provider-generation' : generation) : null };
  if (groupedEditorial) {
    title.visible_source_ids = singleSource ? ['owned-source'] : ['owned-source', 'other-owned-source'];
    title.overlay_catalog_metadata = { tmdbValidation:{ valid:trusted },
      tmdb:{ id:wrongTmdb ? '999' : 27205, title:'Inception', overview:'English overview', audioTracks:[{index:9,lang:'en'}] },
      i18n:localized ? {fr:{title:'Titre français',overview:'Synopsis français'}} : {} };
  }
  const calls = [];
  const query = { select() { return this; }, eq(k, v) { calls.push([k, v]); return this; },
    in() { return this; }, async limit(n) { assert.equal(n, 4); return { data: ambiguous ? [variant, variant] : [variant] }; } };
  const sandbox = { module: { exports: null }, db: { from(table) {
    assert.equal(table, 'cloud_catalog_visible_title_variants');
    return query;
  } },
    requiredCatalogTitleVisibilityEpoch: () => '42',
    async hydrateVisibleCatalogTitlesByIds(user, ids, epoch) {
      assert.equal(user, 'owner'); assert.equal(ids[0], titleId); assert.equal(epoch, '42');
      if (stale) throw new Error('visibility epoch changed'); return [title];
    },
    async applyCatalogOverlay(rows, type, language) {
      assert.equal(type, itemType); assert.equal(language, 'fr');
      for (const row of rows) { delete row.display_generation_id; delete row.visible_source_ids; }
    },
    catalogTextStatusEligible: status => status === 'provider_verified',
    catalogTitleUsesGenerationPayload: item => Boolean(item.overlay_generation_id && item.overlay_generation_id === item.display_generation_id),
    flatMediaGenerationId: item => item.generation_id,
    flatMediaBlocksGlobalTitleOverlay: item => Boolean(item.generation_id),
    flatMediaGlobalLocalizedTitle: new WeakSet(),
    flatMediaGenerationTitleProof: new WeakMap(),
    stringOrNull: value => value || null, recordOrEmpty: value => value || {},
    titleRailItem: () => ({ title: editorialTitle, name: editorialTitle, overview: 'Résumé TMDB',
      genres: ['Action'], tmdb: { title: 'English base title', overview: 'Résumé TMDB' }, audio_languages: ['en'], id: 'must-not-copy' }),
  };
  vm.runInNewContext(compiled, sandbox);
  return { row, calls, run: () => sandbox.module.exports([row], 'owner', itemType, 'fr') };
}
test('an M3U row without provider TMDB ID receives its owned title synopsis and genres', async () => {
  const f = fixture(); const owned = await f.run();
  assert.equal(f.row.title, 'Inception'); assert.equal(f.row.overview, 'Résumé TMDB');
  assert.equal(f.row.metadata.providerTmdbId, '27205'); assert.deepEqual([...f.row.genres], ['Action']);
  assert.equal(f.row.id, mediaId); assert.deepEqual(f.row.audio_languages, ['hi']);
  assert.deepEqual(f.row.playback_hint, { streamId: 'provider-file' });
  assert.ok(f.calls.some(([key, value]) => key === 'user_id' && value === 'owner'));
  assert.equal(owned.length, 1);
  assert.equal(owned[0].display_generation_id, null);
  assert.deepEqual([...owned[0].visible_source_ids], ['owned-source']);
});
test('progressive media keeps the owned title proof without applying a second full overlay', async () => {
  const f = fixture({ progressive: true });
  const owned = await f.run();
  assert.equal(owned.length, 1);
  assert.equal(owned[0].display_generation_id, 'active-generation');
  assert.equal(f.row.metadata.providerTmdbId, '27205');
  assert.equal(f.row.runtime, undefined);
  assert.equal(f.row.title, undefined);
});

test('published flat movie and series titles agree with localized rail and restored fiches', async () => {
  for (const itemType of ['movie', 'series']) {
    const f = fixture({ published: true, itemType, editorialTitle: 'Titre français' });
    await f.run();
    assert.equal(f.row.title, 'Titre français');
    assert.equal(f.row.tmdb.title, 'Titre français');
    assert.equal(f.row.metadata.tmdb.title, 'Titre français');
    assert.equal(f.row.id, mediaId);
    assert.deepEqual(f.row.audio_languages, ['hi']);
  }
});
test('foreign, ambiguous and stale title ownership never replaces provider metadata', async () => {
  for (const options of [{ foreign: true }, { ambiguous: true }, { stale: true }, { progressive: true, otherGeneration: true }]) {
    const f = fixture(options); const before = structuredClone(f.row);
    assert.equal((await f.run()).length, 0);
    assert.deepEqual(f.row, before);
  }
});

test('published titles enrich exact active media even when another source supplies the display generation', async () => {
  for (const otherGeneration of [false, true]) {
    const f = fixture({ published: true, otherGeneration });
    const owned = await f.run();
    assert.equal(owned.length, 1);
    assert.equal(f.row.title, 'Inception');
    assert.equal(f.row.overview, 'Résumé TMDB');
    assert.equal(f.row.metadata.providerTmdbId, '27205');
    assert.equal(f.row.generation_id, 'active-generation');
    assert.deepEqual(f.row.playback_hint, { streamId: 'provider-file' });
    assert.deepEqual(f.row.audio_languages, ['hi']);
  }
});

test('flat media hydration reuses the bounded owned-title proof', () => {
  const end = code.indexOf('\nasync function listMediaCategories(', code.indexOf('async function attachMediaLanguages('));
  const attach = code.slice(code.indexOf('async function attachMediaLanguages('), end);
  assert.match(attach, /const ownedTitles = await attachOwnedMediaEditorialMetadata\(/);
  assert.match(attach, /for \(const row of ownedTitles\)/);
  assert.match(attach, /bindFlatMediaGenerationTitles\(items, userId, itemType, visibleTitles, lang, ownedTitles\)/);
  assert.doesNotMatch(attach, /from\("cloud_catalog_visible_titles"\)/);
});

test('a verified multi-source generation projection supplies text without becoming a file-language proof', async () => {
  const f = fixture({ progressive:true,otherGeneration:true,groupedEditorial:true });
  const before = structuredClone(f.row);
  assert.equal((await f.run()).length,0,'must not feed the other generation to the language binder');
  assert.equal(f.row.title,'Titre français');
  assert.equal(f.row.name,'Titre français');
  assert.equal(f.row.overview,'Synopsis français');
  assert.equal(f.row.description,'Synopsis français');
  assert.equal(f.row.plot,'Synopsis français');
  for (const field of ['id','source_id','generation_id','metadata','audio_languages','playback_hint']) {
    assert.deepEqual(f.row[field],before[field],field);
  }
  assert.equal(f.row.audio_tracks,undefined);
  assert.deepEqual(Object.keys(f.row.tmdb).sort(),['overview','title'],'no wholesale metadata copy');
  assert.equal(f.row.tmdb.title,'Titre français');
  assert.equal(f.row.tmdb.overview,'Synopsis français');
});

test('cross-source text still rejects stale, foreign, ambiguous or unvalidated associations', async () => {
  for (const extra of [{foreign:true},{stale:true},{ambiguous:true},{trusted:false},{wrongTmdb:true},{singleSource:true}]) {
    const f=fixture({progressive:true,otherGeneration:true,groupedEditorial:true,...extra});
    const before=structuredClone(f.row);
    assert.equal((await f.run()).length,0);
    assert.deepEqual(f.row,before);
  }
});

test('movie and series text use the validated default only when translation is absent', async () => {
  for (const itemType of ['movie','series']) {
    const f=fixture({progressive:true,otherGeneration:true,groupedEditorial:true,itemType,localized:false});
    await f.run();
    assert.equal(f.row.title,'Inception');
    assert.equal(f.row.tmdb.title,'Inception');
    assert.equal(f.row.overview,'English overview');
    assert.deepEqual(f.row.audio_languages,['hi']);
  }
});
