'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(process.env.NORVA_CATALOG_TEST_SOURCE
  || path.join(root, 'supabase/functions/norva-catalog/index.ts'), 'utf8');
const start = source.indexOf('async function loadCatalogAudioFacetCount(');
const end = source.indexOf('\nfunction normalizeObservedSubtitleTracks(', start) >= 0
  ? source.indexOf('\nfunction normalizeObservedSubtitleTracks(', start)
  : source.indexOf('// Capture audio/subtitle languages observed', start);
assert.ok(start >= 0 && end > start);
const compiled = stripTypeScriptTypes(source.slice(start, end) + '\nmodule.exports = loadCatalogAudioFacetCount;');

function fixture(responses = {}) {
  const calls = [];
  const sandbox = {
    module: { exports: null },
    db: { async rpc(name, args) {
      calls.push({ name, args });
      const response = responses[name];
      if (Array.isArray(response)) return response.shift() || { data: name.includes('unidentified') ? 4 : { fr: 9 } };
      if (response) return response;
      return { data: name.includes('unidentified') ? 4 : { fr: 9 } };
    } },
  };
  vm.runInNewContext(compiled, sandbox);
  return { calls, run: (args, facet) => sandbox.module.exports(args, facet) };
}
const movie = { p_user_id: 'owner', p_item_type: 'movie', p_source_id: 'source' };
const series = { p_user_id: 'owner', p_item_type: 'series', p_source_id: 'source' };

test('movies dispatch to the private helper signature without p_item_type', async () => {
  const f = fixture();
  await f.run(movie, 'audio'); await f.run(movie, 'unidentified');
  assert.deepEqual(f.calls.map(call => call.name), [
    'norva_catalog_movie_audio_language_counts',
    'norva_catalog_movie_unidentified_audio_count',
  ]);
  for (const call of f.calls) assert.equal(JSON.stringify(call.args), JSON.stringify({ p_user_id: 'owner', p_source_id: 'source' }));
});

test('series continue using the historical RPCs and retain the three argument scope', async () => {
  const f = fixture();
  await f.run(series, 'audio'); await f.run(series, 'unidentified');
  assert.deepEqual(f.calls.map(call => call.name), [
    'cloud_catalog_audio_language_counts', 'cloud_catalog_unidentified_audio_count',
  ]);
  for (const call of f.calls) assert.equal(JSON.stringify(call.args), JSON.stringify(series));
});

test('movie helper fallback is limited to missing-function errors', async () => {
  const f = fixture({ norva_catalog_movie_audio_language_counts: [{ error: { code: 'PGRST202' } }] });
  await f.run(movie, 'audio');
  assert.deepEqual(f.calls.map(call => call.name), [
    'norva_catalog_movie_audio_language_counts', 'cloud_catalog_audio_language_counts',
  ]);
  const timeout = fixture({ norva_catalog_movie_unidentified_audio_count: [{ error: { code: '57014' } }] });
  const result = await timeout.run(movie, 'unidentified');
  assert.equal(result.error.code, '57014');
  assert.deepEqual(timeout.calls.map(call => call.name), ['norva_catalog_movie_unidentified_audio_count']);
});
