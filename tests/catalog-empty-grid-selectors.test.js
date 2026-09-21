'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const source = fs.readFileSync(process.env.NORVA_CATALOG_TEST_SOURCE
  || path.join(__dirname, '../supabase/functions/norva-catalog/index.ts'), 'utf8');
function section(start, end) {
  const index = source.indexOf(start);
  assert.ok(index >= 0);
  const stop = source.indexOf(end, index + start.length);
  assert.ok(stop > index);
  return source.slice(index, stop);
}
const compiled = transformSync([
  section('async function listMediaItems(', '// Flat media rows come directly'),
  section('function stringOrNull(', 'function isMissingMaterialization('),
  'module.exports = listMediaItems;',
].join('\n'), { loader: 'ts', format: 'cjs' }).code;

function fixture() {
  const calls = [];
  const sandbox = {
    module: { exports: null }, URL,
    railLang: () => 'en',
    boundedInt: (value, fallback) => value == null ? fallback : Number(value),
    decadeRange: () => null, paramNumber: () => null,
    mediaReadFromCatalog: () => false,
    prepareProviderMediaRow: row => row,
    sanitizeCatalogMediaItem: row => row,
    attachMediaLanguages: async () => {}, localizeMediaTitles: async () => {},
    throwDb: error => { throw error; },
    db: {
      async rpc(name, args) {
        calls.push({ name, args });
        assert.equal(args.p_user, 'owner');
        if (args.p_source === '') return { error: new Error('invalid UUID input') };
        const rows = [{ id: args.p_source || 'all-owned-items' }];
        return { data: name === 'search_media_items' ? rows : { items: rows, total: 1, films: 1 } };
      },
    },
  };
  vm.runInNewContext(compiled, sandbox);
  return { calls, run: query => sandbox.module.exports(new URL(`https://norva.test/media-items?type=movie&${query}`), 'owner') };
}

test('empty all-source and all-category selectors produce the same owned catalogue as omitted selectors', async () => {
  const f = fixture();
  const expected = await f.run('');
  for (const query of ['sourceId=', 'categoryId=', 'sourceId=&categoryId=', 'sourceId=%20&categoryId=%20']) {
    assert.deepEqual(await f.run(query), expected);
    const { args } = f.calls.at(-1);
    assert.equal(args.p_source, null);
    assert.equal(args.p_category, null);
  }
});

test('nonempty source and category selectors retain their exact scope and invalid identifiers never widen it', async () => {
  for (const sourceId of ['11111111-1111-4111-a111-111111111111', 'invalid-source']) {
    const f = fixture();
    await f.run(`sourceId=${sourceId}&categoryId=provider-category`);
    assert.equal(f.calls[0].args.p_source, sourceId);
    assert.equal(f.calls[0].args.p_category, 'provider-category');
  }
});

test('all-source search retains the fuzzy-search route when empty selectors are serialized', async () => {
  const f = fixture();
  const result = await f.run('sourceId=&categoryId=&q=lion&dedup=1');
  assert.equal(f.calls[0].name, 'search_media_items');
  assert.equal(f.calls[0].args.p_q, 'lion');
  assert.equal(f.calls[0].args.p_dedup, true);
  assert.equal(result.items.length, 1);
});
