'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const playback = fs.readFileSync(
  process.env.NORVA_TEST_PLAYBACK_SOURCE || path.join(__dirname, '../supabase/functions/norva-playback/index.ts'),
  'utf8',
);
const start = playback.indexOf('async function getStoryboard(');
const end = playback.indexOf('async function checkStoryboardAdmission(', start);
assert.ok(start >= 0 && end > start);
const source = stripTypeScriptTypes(playback.slice(start, end));

function harness(syncStatus, storyboardRow = null) {
  const calls = { catalogRead: 0, sourceRead: 0, runtime: 0, writes: 0 };
  const context = {
    URL, Date, PUBLIC_ORIGIN: 'https://norva.tv', STORYBOARD_BUCKET: 'norva-storyboards',
    resolveSubtitleTarget: async () => ({
      sourceId: '22222222-2222-4222-8222-222222222222', externalId: 'movie-1', itemType: 'movie',
    }),
    resolveSourceIdentity: async () => ({ key: 'opaque-provider-key' }),
    stringOr: (value, fallback) => typeof value === 'string' ? value : fallback,
    stringOrNull: value => typeof value === 'string' ? value : null,
    throwDb: error => { throw error; },
    getRuntimeConfig: async () => {
      calls.runtime++;
      return { mediaGatewayUrl: '', mediaGatewayToken: '' };
    },
  };
  vm.runInNewContext(`${source}\nglobalThis.getStoryboardForTest = getStoryboard;`, context);
  const db = {
    from(table) {
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() {
          if (table === 'catalog_storyboards') {
            calls.catalogRead++;
            return { data: storyboardRow, error: null };
          }
          assert.equal(table, 'cloud_sources');
          calls.sourceRead++;
          return { data: syncStatus == null ? null : { sync_status: syncStatus }, error: null };
        },
        upsert() { calls.writes++; throw new Error('storyboard must not be enqueued'); },
      };
    },
  };
  const request = { url: 'https://norva.tv/storyboard?titleId=opaque-title&enqueue=1' };
  return { calls, run: () => context.getStoryboardForTest(request, 'owner-1', db) };
}

test('a syncing source defers a new storyboard before provider or Gateway work', async () => {
  const h = harness('syncing');
  const result = await h.run();
  assert.equal(result.status, 'none');
  assert.equal(result.why, 'catalog-syncing');
  assert.deepEqual(h.calls, { catalogRead: 1, sourceRead: 1, runtime: 0, writes: 0 });
});

test('a ready source can enqueue while a cached sprite remains readable during sync', async () => {
  const ready = harness('ready');
  assert.equal((await ready.run()).why, 'gateway-not-configured');
  assert.equal(ready.calls.runtime, 1);

  const sprite = harness('syncing', {
    status: 'ready', sprite_path: 'opaque/sprite.jpg', tile_cols: 10,
    tile_rows: 2, tile_count: 20, interval_sec: 60,
  });
  const result = await sprite.run();
  assert.equal(result.status, 'ready');
  assert.equal(sprite.calls.sourceRead, 0);
  assert.equal(sprite.calls.runtime, 0);
});
