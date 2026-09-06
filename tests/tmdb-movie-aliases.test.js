const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const Module = require('node:module');
const path = require('node:path');

test('movie search rescues indexed aliases without choosing ambiguous aliases or incompatible years', async () => {
  const fixtures = [
    [922636, '105 Minuttess', 'One Not Five Minuttess', '2024'],
    [66406, 'Aakali Rajyam', 'Varumayin Niram Sivappu', '1980'],
    [1140905, 'Baak', 'Aranmanai 4', '2024'],
    [1194915, 'Suryas Saturday', "Saripodhaa Sanivaaram", '2024'],
  ];
  const source = buildSync({ entryPoints: ['supabase/functions/_shared/vod-title-projection.ts'], bundle: true,
    write: false, platform: 'node', format: 'cjs', packages: 'external' }).outputFiles[0].text;
  const originalFetch = global.fetch, originalDeno = global.Deno;
  global.Deno = { env: { get() { return undefined; } } };
  const mod = new Module(path.resolve('tests/movie-matcher-fixture.cjs'), module);
  mod.paths = module.paths;
  mod._compile(source, path.resolve('tests/movie-matcher-fixture.cjs'));
  const { acceptAutomaticTmdbSearchMatch: accept } = await import('../supabase/functions/_shared/tmdb-enrichment-policy.mjs');
  let detailsCalls = 0;
  global.fetch = async input => {
    const url = new URL(input); let payload;
    if (url.pathname.includes('/search/')) {
      const query = url.searchParams.get('query'); const fixture = fixtures.find(f => f[1] === query);
      payload = { results: fixture ? [{ id: fixture[0], title: fixture[2], release_date: fixture[3] + '-01-01' }]
        : Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, title: 'Unrelated Movie ' + i, release_date: '2024-01-01' })) };
    } else {
      detailsCalls++; const id = Number(url.pathname.split('/').at(-1)); const fixture = fixtures.find(f => f[0] === id);
      payload = fixture ? { id, title: fixture[2], release_date: fixture[3] + '-01-01',
        alternative_titles: { titles: [{ title: fixture[1] }] }, genres: [{ name: 'Drama' }] }
        : { id, title: 'Unrelated Movie', release_date: '2024-01-01',
          alternative_titles: { titles: id < 102 ? [{ title: 'Ambiguous Alias' }] : [] } };
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    for (const [id, title, , year] of fixtures) {
      const match = await mod.exports.searchTmdbMatch('fixture-key', 'movie', title, year);
      assert.equal(match?.tmdbId, String(id), title);
      assert.equal(accept({ itemType: 'movie', title, releaseYear: Number(year) }, match), true);
    }
    const wrongYear = await mod.exports.searchTmdbMatch('fixture-key', 'movie', 'Baak', '2000');
    assert.equal(accept({ itemType: 'movie', title: 'Baak', releaseYear: 2000 }, wrongYear), false);
    let before = detailsCalls;
    assert.equal(await mod.exports.searchTmdbMatch('fixture-key', 'movie', 'Ambiguous Alias', '2024'), null);
    assert.equal(detailsCalls - before, 3);
    before = detailsCalls;
    assert.equal(await mod.exports.searchTmdbMatch('fixture-key', 'movie', 'Missing Programme', '2024'), null);
    assert.equal(detailsCalls - before, 3);
  } finally { global.fetch = originalFetch; global.Deno = originalDeno; }
});
