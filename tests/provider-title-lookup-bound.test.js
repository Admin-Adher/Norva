const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSync } = require('esbuild');

const code = buildSync({
  entryPoints: [path.join(__dirname, '../supabase/functions/_shared/vod-title-projection.ts')],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['npm:*', 'jsr:*'],
}).outputFiles[0].text;
const loaded = { exports: {} };
const previousDeno = globalThis.Deno;
globalThis.Deno = { env: { get: () => '' } };
try { Function('module', 'exports', 'require', code)(loaded, loaded.exports, require); }
finally { globalThis.Deno = previousDeno; }
const { projectVodTitleGenerationIsolated, boundedTitleIdentityBatches } = loaded.exports;

test('long Unicode catalogue titles project every variant through bounded GETs', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const generation = { kind: 'building', generationId: '33333333-3333-4333-8333-333333333333',
    transitionId: '44444444-4444-4444-8444-444444444444', jobId: '55555555-5555-4555-8555-555555555555',
    attempt: 45, leaseOwner: 'test-worker' };
  const titles = [], saved = [], lengths = [];
  const db = {
    async rpc(name, args) {
      assert.equal(name, 'norva_ensure_credential_generation_titles');
      assert.equal(args.p_expected_attempt, 45);
      titles.push(...args.p_titles.map((row, i) => ({ ...row, id: `title-${titles.length + i}` })));
      return { error: null };
    },
    from(table) {
      const filters = [];
      const query = {
        select() { return this; },
        eq(column, value) { filters.push(row => row[column] === value); return this; },
        in(column, values) {
          filters.push(row => values.includes(row[column]));
          if (column === 'identity_key') {
            const url = '/rest/v1/cloud_titles?' + new URLSearchParams({
              select: 'id,item_type,identity_key', user_id: `eq.${userId}`,
              item_type: 'in.(movie,series)', identity_key: `in.(${values.join(',')})`,
            });
            lengths.push(url.length);
            assert.ok(url.length < 8192, 'Kong rejects oversized request lines');
          }
          return this;
        },
        async upsert(rows) { assert.equal(table, 'cloud_title_variants'); saved.push(...rows); return { error: null }; },
        then(resolve) { assert.equal(table, 'cloud_titles'); resolve({ data: titles.filter(row => filters.every(f => f(row))), error: null }); },
      };
      return query;
    },
  };
  const rows = Array.from({ length: 250 }, (_, i) => ({ id: `media-${i}`, user_id: userId,
    source_id: sourceId, generation_id: generation.generationId, item_type: 'movie', external_id: `${i}`,
    title: `映画の長い題名 العربية ${'Long catalogue title '.repeat(5)} ${i}`, metadata: {}, playback_hint: {} }));
  const result = await projectVodTitleGenerationIsolated({ mode: 'building-generation', userId,
    sourceId, transitionId: generation.transitionId, generation, rows, db });
  assert.equal(result.variants, 250);
  assert.equal(new Set(saved.map(row => row.media_item_id)).size, 250);
  assert.ok(saved.every(row => row.generation_id === generation.generationId && row.ingest_attempt === 45));
  assert.ok(lengths.length > 2, 'long titles must split into more than fixed 200-row batches');
});

test('identity batching retains punctuation, order and boundaries without truncating keys', () => {
  const keys = Array.from({ length: 201 }, (_, i) => `norm:movie:名,"(${i})`);
  assert.deepEqual(boundedTitleIdentityBatches(keys).flat(), keys);
  assert.deepEqual(boundedTitleIdentityBatches([]), []);
  assert.throws(() => boundedTitleIdentityBatches(['名'.repeat(1000)]), /exceeds lookup URL bound/);
});
