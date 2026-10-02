'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const source = fs.readFileSync('supabase/functions/norva-catalog/index.ts', 'utf8');
const exact = source.slice(source.indexOf('async function listExactCatalogMediaItems('), source.indexOf('async function listMediaItems('));
const sourceId = '11111111-1111-4111-8111-111111111111';
const foreignSource = '22222222-2222-4222-8222-222222222222';
const url = (type = 'movie') => new URL(`https://example.invalid/media-items?sourceId=${sourceId}&externalId=provider-file&type=${type}&lang=fr`);

function fixture({ matches = [{ title_id: 'current-title' }], title = { id: 'current-title', item_type: 'movie' },
  variants = [{ source_id: sourceId, external_id: 'provider-file' }], error = null } = {}) {
  const filters = {}, reads = [];
  const moduleFixture = { exports: {} };
  const query = { select: () => query, eq: (key, value) => { filters[key] = value; return query; },
    limit: async count => { assert.equal(count, 2); return { data: matches, error }; } };
  vm.runInNewContext(transformSync(exact + '\nexport { listExactCatalogMediaItems };', { loader: 'ts', format: 'cjs' }).code, {
    module: moduleFixture, exports: moduleFixture.exports,
    stringOrNull: value => typeof value === 'string' && value.trim() ? value.trim() : null,
    HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
    db: { from: table => { reads.push(table); return query; } },
    throwDb: err => { throw new Error(err.message); },
    loadTitleById: async (owner, id) => { assert.equal(owner, 'owner'); assert.equal(id, 'current-title'); reads.push('hydrate'); return title; },
    listVariantsByTitleIds: async (ids, owner) => { assert.equal(owner, 'owner'); return new Map([['current-title', variants]]); },
    railLang: value => value.searchParams.get('lang'),
    applyCatalogOverlay: async (titles, type, lang) => { assert.equal(type, title.item_type); assert.equal(lang, 'fr'); titles[0].overview = 'Synopsis actuel'; },
    titleRailItem: (row, files, lang) => ({ ...row, variants: files, lang }),
  });
  return { run: moduleFixture.exports.listExactCatalogMediaItems, filters, reads };
}

test('exact fiche lookup is owner/source/file scoped and hydrates the current localized title', async () => {
  const f = fixture();
  const result = await f.run(url(), 'owner');
  assert.deepEqual(f.filters, { user_id: 'owner', source_id: sourceId, item_type: 'movie', external_id: 'provider-file' });
  assert.equal(f.reads[0], 'cloud_catalog_visible_title_variants');
  assert.equal(result.catalogTitleItems[0].overview, 'Synopsis actuel');
  assert.equal(result.count, 1);
  assert.equal(result.hasMore, false);
});
test('series lookup uses the parent series identity and the same localized projection', async () => {
  const f = fixture({ title: { id: 'current-title', item_type: 'series' } });
  assert.equal((await f.run(url('series'), 'owner')).catalogTitleItems[0].item_type, 'series');
});
test('missing or ambiguous file identity never guesses a homonym', async () => {
  for (const matches of [[], [{ title_id: 'a' }, { title_id: 'b' }]]) {
    const f = fixture({ matches });
    assert.equal((await f.run(url(), 'owner')).catalogTitleItems.length, 0);
    assert.equal(f.reads.includes('hydrate'), false);
  }
});
test('visibility changes and cross-source provider-ID collisions fail closed', async () => {
  for (const values of [{ title: null }, { title: { item_type: 'series' } },
    { variants: [{ source_id: foreignSource, external_id: 'provider-file' }] }]) {
    const f = fixture(values);
    assert.equal((await f.run(url(), 'owner')).catalogTitleItems.length, 0);
  }
});
test('invalid or incomplete identity is rejected before database access', async () => {
  const f = fixture();
  for (const query of ['externalId=1&type=movie', `sourceId=${sourceId}&externalId=1&type=live`,
    `sourceId=${sourceId}&externalId=${'x'.repeat(257)}&type=movie`]) {
    await assert.rejects(f.run(new URL('https://example.invalid/media-items?' + query), 'owner'), err => err.status === 400);
  }
  assert.equal(f.reads.length, 0);
});
test('database failures remain failures, without fabricated title data', async () => {
  await assert.rejects(fixture({ error: { message: 'unavailable' } }).run(url(), 'owner'), /unavailable/);
});

test('cloud adapter preserves localized editorial data and exact-file language scope for every owned version', async () => {
  const requests = [], storage = new Map([['norva-cloud-session', JSON.stringify({ access_token: 'fixture', user: { id: 'owner' } })]]);
  const NorvaCloud = { contentLanguage: () => 'fr', mediaItems: { list: async params => {
    requests.push(params);
    return { catalogTitleItems: [{ id: 'current-title', item_type: 'movie', title: 'Titre traduit',
      poster_url: 'https://example.invalid/current.jpg', year: 2022,
      metadata: { tmdb: { title: 'English title', overview: 'English synopsis' } },
      data: { overview: 'Synopsis actuel', genres: ['Drama'] },
      variants: [sourceId, foreignSource].map((id, index) => ({ id: 'variant-' + index, source_id: id,
        external_id: params.externalId, container_extension: 'mkv', audio_languages: [index ? 'fr' : 'en'],
        audio_languages_scope: 'file', audio_language_validation_status: 'verified' }))
    }], count: 1, films: 1, limit: 1, offset: 0, hasMore: false };
  } } };
  const context = vm.createContext({ window: { NorvaCloud, location: { hostname: 'norva.tv', origin: 'https://norva.tv' } },
    NorvaCloud, URL, URLSearchParams, AbortController, Headers, navigator: { userAgent: 'fixture' },
    console, setTimeout, clearTimeout, localStorage: { getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value) } });
  vm.runInContext(fs.readFileSync('public/js/api.js', 'utf8') + '\nthis.adapter = CloudAdapter;', context);
  for (const fileId of ['file-a', 'file-b']) {
    const page = await context.adapter.request('GET', `/media/page?sourceId=${sourceId}&type=movie&externalId=${fileId}&limit=1`);
    assert.equal(page.items.length, 2);
    for (const item of page.items) {
      assert.equal(item.stream_id, fileId);
      assert.equal(item.title, 'Titre traduit');
      assert.equal(item.data.overview, 'Synopsis actuel');
      assert.equal(item.poster_url, 'https://example.invalid/current.jpg');
      assert.equal(item.year, 2022);
      assert.equal(item.container_extension, 'mkv');
      assert.equal(item.audioLanguagesScope, 'file');
    }
    assert.deepEqual(Array.from(page.items[0].audioLanguages), ['en']);
    assert.deepEqual(Array.from(page.items[1].audioLanguages), ['fr']);
    assert.notEqual(page.items[0].sourceId, page.items[1].sourceId);
  }
  assert.equal(requests.length, 2, 'exact file identities must have separate cache keys');
  assert.deepEqual(requests.map(request => request.externalId), ['file-a', 'file-b']);
});
