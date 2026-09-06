const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const Module = require('node:module');
const path = require('node:path');

test('TV matching uses indexed aliases while keeping the strong title/year gate and bounded detail requests', async () => {
  const fixtures = [
    [248065, 'Big Girls Dont Cry Bgdc', "Big Girls Don't Cry", "Big Girls Don't Cry (BGDC)", '2024'],
    [293160, 'Devika And Danny', 'Devika & Danny', 'Devika and Danny', '2025'],
    [236058, 'Master Peace', 'Masterpeace', 'Master Peace', '2023'],
    [205505, 'Tamil Rockerz', 'TamilRockerz', 'Tamil Rockerz', '2022'],
    [247043, 'The Bads Of Bollywood', 'The Ba***ds of Bollywood', 'The Bads of Bollywood', '2025'],
    [213895, 'The Railway Men', 'The Railway Men - The Untold Story of Bhopal 1984', 'The Railway Men', '2023'],
  ];
  const bundled = buildSync({ entryPoints: ['supabase/functions/_shared/vod-title-projection.ts'], bundle: true,
    write: false, platform: 'node', format: 'cjs', packages: 'external' }).outputFiles[0].text;
  const originalFetch = global.fetch, originalDeno = global.Deno;
  global.Deno = { env: { get() { return undefined; } } };
  const mod = new Module(path.resolve('tests/series-matcher-fixture.cjs'), module);
  mod.paths = module.paths;
  mod._compile(bundled, path.resolve('tests/series-matcher-fixture.cjs'));
  const { acceptAutomaticTmdbSearchMatch: accept } = await import('../supabase/functions/_shared/tmdb-enrichment-policy.mjs');
  const requests = [];
  global.fetch = async input => {
    const url = new URL(input); requests.push(url);
    let payload;
    if (url.pathname.includes('/search/')) {
      const query = url.searchParams.get('query');
      const fixture = fixtures.find(f => f[1] === query);
      payload = { results: fixture ? [{ id: fixture[0], name: fixture[2], first_air_date: fixture[4] + '-01-01' }]
        : Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, name: 'Unrelated Show ' + i, first_air_date: '2025-01-01' })) };
    } else {
      const id = Number(url.pathname.split('/').at(-1));
      const fixture = fixtures.find(f => f[0] === id);
      payload = fixture ? { id, name: fixture[2], first_air_date: fixture[4] + '-01-01',
        alternative_titles: { results: [{ title: fixture[3], iso_3166_1: 'IN' }] }, genres: [{ name: 'Drama' }] }
        : { id, name: 'Unrelated Show', first_air_date: '2025-01-01', alternative_titles: { results: [] } };
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    for (const [id, title] of fixtures) {
      const match = await mod.exports.searchTmdbMatch('fixture-key', 'series', title, null);
      assert.equal(match?.tmdbId, String(id), title);
      assert.equal(accept({ itemType: 'series', title }, match), true, title);
      assert.deepEqual(match.details.genres, ['Drama']);
    }
    const before = requests.length;
    const miss = await mod.exports.searchTmdbMatch('fixture-key', 'series', 'Unknown Different Programme', null);
    assert.equal(miss, null);
    assert.equal(requests.slice(before).filter(url => !url.pathname.includes('/search/')).length, 3);
    const wrongYear = await mod.exports.searchTmdbMatch('fixture-key', 'series', 'Master Peace', '2000');
    assert.equal(accept({ itemType: 'series', title: 'Master Peace', releaseYear: 2000 }, wrongYear), false);
    const exactAlias = { valid: true, tmdbId: '30785', confidence: 0.923, year: '2009' };
    const reviewed = { itemType: 'series', title: 'Tere Mere Beech Mein', metadata: {
      tmdbSearchReview: { rejectedTmdbIds: ['30785'] },
    } };
    assert.equal(accept(reviewed, exactAlias), false, 'a reviewed homonym stays rejected on retry');
    assert.equal(accept(reviewed, { ...exactAlias, tmdbId: '42' }), true, 'another candidate can still be recognized');
  } finally { global.fetch = originalFetch; global.Deno = originalDeno; }
});
