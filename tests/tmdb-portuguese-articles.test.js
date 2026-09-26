const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const Module = require('node:module');
const path = require('node:path');

test('long Portuguese translations tolerate one missing interior article without losing sequel or locale proof', async () => {
  const code = buildSync({ entryPoints: ['supabase/functions/_shared/vod-title-projection.ts'], bundle: true,
    write: false, platform: 'node', format: 'cjs', packages: 'external' }).outputFiles[0].text;
  const previousFetch = global.fetch, previousDeno = global.Deno;
  global.Deno = { env: { get: () => undefined } };
  const mod = new Module(path.resolve('tests/portuguese-fixture.cjs'), module);
  mod.paths = module.paths; mod._compile(code, path.resolve('tests/portuguese-fixture.cjs'));
  let language = 'pt';
  const titles = {
    166428: ['How to Train Your Dragon: The Hidden World', 'Como Treinar o Seu Dragão 3', '2019'],
    82702: ['How to Train Your Dragon 2', 'Como Treinar o seu Dragão 2', '2014'],
    10140: ['The Chronicles of Narnia: The Voyage of the Dawn Treader', 'As Crônicas de Nárnia: A Viagem do Peregrino da Alvorada', '2010'],
  };
  global.fetch = async input => {
    const url = new URL(input); let payload;
    if (url.pathname.includes('/search/')) payload = { results: Object.entries(titles).map(([id, v]) => ({ id: +id, title: v[0], release_date: v[2] + '-01-01' })) };
    else {
      const id = url.pathname.split('/').at(-1), v = titles[id];
      payload = { id: +id, title: v[0], release_date: v[2] + '-01-01',
        translations: { translations: [{ iso_639_1: language, data: { title: v[1], overview: 'Synopsis.' } }] } };
    }
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const p = mod.exports;
    assert.equal((await p.searchTmdbMatch('fixture', 'movie', 'Como Treinar seu Dragão 3', null))?.tmdbId, '166428');
    assert.equal((await p.searchTmdbMatch('fixture', 'movie', 'As Crônicas de Narnia - Viagem do Peregrino da Alvorada', null))?.tmdbId, '10140');
    assert.equal(await p.searchTmdbMatch('fixture', 'movie', 'Como Treinar seu Dragão 4', null), null);
    assert.equal(await p.searchTmdbMatch('fixture', 'movie', 'Como Treinar seu Dragão 3', '2000'), null);
    language = 'en';
    assert.equal(await p.searchTmdbMatch('fixture', 'movie', 'Como Treinar seu Dragão 3', null), null);
  } finally { global.fetch = previousFetch; global.Deno = previousDeno; }
});
