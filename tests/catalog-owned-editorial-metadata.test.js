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
function fixture({ foreign = false, stale = false, ambiguous = false } = {}) {
  const row = { id: mediaId, source_id: 'owned-source', generation_id: 'active-generation',
    metadata: { plot: 'Provider credits' }, audio_languages: ['hi'], playback_hint: { streamId: 'provider-file' } };
  const variant = { id: 'variant', media_item_id: mediaId, title_id: titleId, item_type: 'movie',
    source_id: foreign ? 'foreign-source' : row.source_id, generation_id: row.generation_id };
  const title = { id: titleId, provider_tmdb_id: '27205', match_status: 'provider_verified',
    visible_source_ids: ['owned-source'], display_generation_id: row.generation_id };
  const calls = [];
  const query = { select() { return this; }, eq(k, v) { calls.push([k, v]); return this; },
    in() { return this; }, async limit(n) { assert.equal(n, 4); return { data: ambiguous ? [variant, variant] : [variant] }; } };
  const sandbox = { module: { exports: null }, db: { from: () => query },
    requiredCatalogTitleVisibilityEpoch: () => '42',
    async hydrateVisibleCatalogTitlesByIds(user, ids, epoch) {
      assert.equal(user, 'owner'); assert.equal(ids[0], titleId); assert.equal(epoch, '42');
      if (stale) throw new Error('visibility epoch changed'); return [title];
    },
    async applyCatalogOverlay(rows, type, language) {
      assert.equal(type, 'movie'); assert.equal(language, 'fr');
      for (const row of rows) { delete row.display_generation_id; delete row.visible_source_ids; }
    },
    catalogTextStatusEligible: status => status === 'provider_verified',
    flatMediaGenerationId: item => item.generation_id,
    stringOrNull: value => value || null, recordOrEmpty: value => value || {},
    titleRailItem: () => ({ title: 'Inception', name: 'Inception', overview: 'Résumé TMDB',
      genres: ['Action'], tmdb: { overview: 'Résumé TMDB' }, audio_languages: ['en'], id: 'must-not-copy' }),
  };
  vm.runInNewContext(compiled, sandbox);
  return { row, calls, run: () => sandbox.module.exports([row], 'owner', 'movie', 'fr') };
}
test('an M3U row without provider TMDB ID receives its owned title synopsis and genres', async () => {
  const f = fixture(); await f.run();
  assert.equal(f.row.title, 'Inception'); assert.equal(f.row.overview, 'Résumé TMDB');
  assert.equal(f.row.metadata.providerTmdbId, '27205'); assert.deepEqual([...f.row.genres], ['Action']);
  assert.equal(f.row.id, mediaId); assert.deepEqual(f.row.audio_languages, ['hi']);
  assert.deepEqual(f.row.playback_hint, { streamId: 'provider-file' });
  assert.ok(f.calls.some(([key, value]) => key === 'user_id' && value === 'owner'));
});
test('foreign, ambiguous and stale title ownership never replaces provider metadata', async () => {
  for (const options of [{ foreign: true }, { ambiguous: true }, { stale: true }]) {
    const f = fixture(options); const before = structuredClone(f.row); await f.run(); assert.deepEqual(f.row, before);
  }
});
