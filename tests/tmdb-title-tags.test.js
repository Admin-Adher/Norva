const test = require('node:test');
const assert = require('node:assert/strict');

test('title cleanup retains real parentheticals and strips release tags', async () => {
  const { cleanTmdbSearchQuery: clean, tmdbSearchYear: year } = await import('../supabase/functions/_shared/tmdb-search-policy.mjs');
  for (const [raw, expected] of [
    ['Normal (2026) HDRip [Malayalam]', 'Normal'],
    ['1920 Horrors Of The Heart 2023 Hindi', '1920 Horrors Of The Heart'],
    ['14 Days (Girlfriend Intlo)', '14 Days Girlfriend Intlo'],
    ['2012 2009 Telugu Dubbed', '2012'],
    ['[REC]', 'REC'], ['2012', '2012'], ['Happiest Season', 'Happiest Season'],
  ]) assert.equal(clean(raw), expected);
  assert.equal(year('2012 2009 Telugu Dubbed', 2012), 2009);
  assert.equal(year('2012'), null);
  assert.equal(year('Normal (2026) HDRip [Malayalam]', 2025), 2026);
});

test('actual movies containing Season pass the strong gate; numbered seasons do not', async () => {
  const { acceptAutomaticTmdbSearchMatch: accept } = await import('../supabase/functions/_shared/tmdb-enrichment-policy.mjs');
  const match = { valid: true, tmdbId: '520172', year: '2020', confidence: 1 };
  assert.equal(accept({ itemType: 'movie', title: 'Happiest Season', releaseYear: 2020 }, match), true);
  assert.equal(accept({ itemType: 'movie', title: 'Example Season 1', releaseYear: 2020 }, match), false);
  assert.equal(accept({ itemType: 'movie', title: 'Example', releaseYear: 2020 }, { ...match, confidence: 0.86 }), false);
  assert.equal(accept({ itemType: 'movie', title: '2012 2009 Telugu Dubbed', releaseYear: 2012 }, { ...match, year: '2009' }), true);
});

test('the real matcher checks another locale after a weak prefix match and confirms retained title words', async () => {
  const { buildSync } = require('esbuild');
  const Module = require('node:module');
  const path = require('node:path');
  const bundled = buildSync({ entryPoints: ['supabase/functions/_shared/vod-title-projection.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external' }).outputFiles[0].text;
  const mod = new Module(path.resolve('tests/matcher-fixture.cjs'), module);
  mod.paths = module.paths;
  const originalFetch = global.fetch, originalDeno = global.Deno;
  global.Deno = { env: { get() { return undefined; } } };
  mod._compile(bundled, path.resolve('tests/matcher-fixture.cjs'));
  const requested = [];
  global.fetch = async input => {
    const url = new URL(input); requested.push(url);
    let payload;
    if (url.pathname.includes('/search/')) {
      const title = url.searchParams.get('query');
      const result = title === 'Aattam' && url.searchParams.get('language') === 'fr-FR'
        ? { id: 99, title: 'Thespians of Aattam', release_date: '2024-01-01' }
        : title === 'Aattam' ? { id: 42, title: 'Aattam', release_date: '2023-01-01' }
        : { id: 43, title: '14 Days (Girlfriend Intlo)', release_date: '2025-01-01' };
      payload = { results: [result] };
    } else payload = url.pathname.endsWith('/42')
      ? { id: 42, title: 'Aattam', release_date: '2023-01-01' }
      : { id: 43, title: '14 Days (Girlfriend Intlo)', release_date: '2025-01-01' };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const first = await mod.exports.searchTmdbMatch('fixture-key', 'movie', 'Aattam', '2024');
    assert.equal(first.tmdbId, '42');
    assert.equal(first.confidence, 1);
    assert.ok(requested.some(url => url.searchParams.get('language') === 'en-US'));
    const second = await mod.exports.searchTmdbMatch('fixture-key', 'movie', '14 Days Girlfriend Intlo', '2025');
    assert.equal(second.confidence, 1);
  } finally { global.fetch = originalFetch; global.Deno = originalDeno; }
});
