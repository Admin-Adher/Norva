const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const policy = require('../supabase/functions/_shared/tmdb-search-policy.mjs');

function harness(details) {
  const source = fs.readFileSync('supabase/functions/_shared/vod-title-projection.ts', 'utf8');
  const module = { exports: {} };
  const dependencies = { ...policy, fetchBoundedProviderJson: async () => ({ response: { ok: true }, value: details }) };
  vm.runInNewContext(transformSync(source + '\nexport {matchCatalogValidationCandidate};',
    { loader: 'ts', format: 'cjs', target: 'node22' }).code, {
    module, exports: module.exports, require: () => dependencies, TextEncoder, URL,
    Deno: { env: { get: () => '' } }, setTimeout: fn => queueMicrotask(fn),
  });
  return module.exports;
}

for (const [provider, cached] of [
  ['A Bailarina', 'A Valsa da Bailarina'], ['A Baleia', 'A Baleia Mágica'],
  ['A Hora do Pesadelo', 'A Hora do Pesadelo Podcast - Especial'],
]) test(`provider ID and legacy valid flag cannot bless the partial homonym ${provider}`, async () => {
  const details = { id: 101, title: cached, release_date: '2022-01-01' };
  const api = harness(details);
  const candidate = { itemType: 'movie', tmdbId: '101', title: provider, year: null };
  assert.equal((await api.validateTmdbCandidate('fixture', candidate)).valid, false);
  assert.equal(api.matchCatalogValidationCandidate(candidate, { title: cached },
    { tmdb: details }, { valid: true, title: cached, year: '2022' }), null);
});

test('exact Portuguese translation still validates and reuses a localized provider ID', async () => {
  const details = { id: 101, title: 'The Whale', release_date: '2022-12-09',
    translations: { translations: [{ iso_639_1: 'pt', data: { title: 'A Baleia' } }] } };
  const api = harness(details);
  const candidate = { itemType: 'movie', tmdbId: '101', title: 'A Baleia', year: null };
  const match = await api.validateTmdbCandidate('fixture', candidate);
  assert.equal(match.valid, true); assert.equal(match.confidence, 0.923);
  assert.ok(api.matchCatalogValidationCandidate(candidate, { title: 'The Whale' },
    { tmdb: details, i18n: match.i18n }, { valid: true, title: 'The Whale', year: '2022' }));
});

test('an incompatible explicit year vetoes even confirmed poster evidence', async () => {
  const api = harness({ id: 101, title: 'Example', release_date: '2022-01-01' });
  const candidate = { itemType: 'movie', tmdbId: '101', title: 'Example', year: '1984' };
  assert.equal((await api.validateTmdbCandidate('fixture', candidate, true)).valid, false);
});

test('poster-confirmed aliases retain the proof reason even with a high title score', async () => {
  const api = harness({ id: 101, title: 'Example', release_date: '2022-01-01' });
  const match = await api.validateTmdbCandidate('fixture',
    { itemType: 'movie', tmdbId: '101', title: 'Example', year: '2022' }, true);
  assert.equal(match.valid, true); assert.equal(match.reason, 'poster_path_confirmed');
});
