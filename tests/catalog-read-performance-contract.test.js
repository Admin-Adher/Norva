'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const catalog = read('supabase/functions/norva-catalog/index.ts');
const migration = read('supabase/migrations/20260826090000_catalog_genre_rail_read_model_v1.sql');
const home = read('public/js/pages/HomePage.js');
const api = read('public/js/api.js');
const cloudApi = read('public/js/cloudApi.js');
const live = read('public/js/components/LiveGuideFusion.js');
const appHtml = read('public/app.html');

test('genre rails use one generation-fenced read model and never restore the per-bucket fan-out', () => {
  const start = catalog.indexOf('async function listGenreRails');
  const end = catalog.indexOf('// Full, paged list', start);
  const block = catalog.slice(start, end);

  assert.match(block, /db\.rpc\(\s*"norva_get_genre_rail_candidates"/);
  assert.match(block, /p_expected_visibility_epoch:\s*visibilityEpoch/);
  assert.match(block, /catalogTitleVisibilityEpoch\(candidatePayload\.visibilityEpoch, visibilityEpoch\)/);
  assert.doesNotMatch(block, /Promise\.all\(candidateBuckets\.map/);
  assert.doesNotMatch(block, /from\("cloud_catalog_visible_titles"\)/);
});
test('the SQL read model is bounded, service-only and visibility-epoch fenced', () => {
  assert.match(migration, /bucket_rank <= 150/);
  assert.match(migration, /with visible as materialized/);
  assert.match(migration, /genre_rail_visibility_epoch/);
  assert.match(migration, /v_end_epoch <> v_start_epoch/);
  assert.match(migration, /reason=genre_rail_read_model_stale_or_missing/);
  assert.match(migration, /revoke all on function public\.norva_get_genre_rail_candidates[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.norva_get_genre_rail_candidates[\s\S]*to service_role/);
});

test('Home timeouts abort the underlying rails fetch and route cancellation drains controllers', () => {
  assert.match(home, /this\._homeAbortControllers = new Set\(\)/);
  assert.match(home, /controller\?\.abort\(\)/);
  assert.match(home, /for \(const controller of this\._homeAbortControllers\) controller\.abort\(\)/);
  assert.match(home, /\(signal\) => window\.API\.request\([\s\S]*\{ signal \}/);
  assert.match(api, /CloudAdapter\.request\(method, endpoint, data, options\)/);
  assert.match(cloudApi, /rails: \(params = \{\}, options = \{\}\) => catalogRequest\('\/home\/rails', params, options\)/);
});

test('Live bounds first paint and defers off-screen logo decoding without hiding the lineup', () => {
  assert.match(live, /this\.BASE_ROW_LIMIT = 48/);
  assert.match(live, /this\.TV_ROW_LIMIT = 60/);
  assert.match(live, /data-action="show-more"/);
  assert.match(live, /loading="lazy" decoding="async" fetchpriority="low"/);
  assert.match(appHtml, /cloudApi\.js\?v=70/);
  assert.match(appHtml, /api\.js\?v=88/);
  assert.match(appHtml, /LiveGuideFusion\.js\?v=30/);
  assert.match(appHtml, /HomePage\.js\?v=65/);
});
