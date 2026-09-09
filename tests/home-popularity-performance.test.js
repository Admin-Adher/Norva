'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations',
  '20260909124314_home_popularity_generation_index.sql'), 'utf8');

test('popularity bounds both legacy and active reads by the existing generation index', () => {
  const branches = migration.slice(migration.indexOf('join lateral ('), migration.indexOf(') v on true')).split('union all');
  assert.equal(branches.length, 2);
  for (const branch of branches) {
    assert.match(branch, /from public\.cloud_catalog_visible_title_variants v/);
    assert.match(branch, /v\.user_id = h\.user_id/);
    assert.match(branch, /v\.source_id = h\.source_id/);
    assert.match(branch, /v\.item_type = p_item_type/);
    assert.match(branch, /v\.external_id = any\(array\[h\.item_id, h\.parent_item_id\]\)/);
  }
  assert.match(branches[0], /v\.generation_id is null/);
  assert.match(branches[1], /v\.generation_id = active_head\.active_generation_id/);
  assert.match(branches[1], /offset 0/);
  assert.match(migration, /active_head\.user_id = h\.user_id/);
  assert.doesNotMatch(migration, /create\s+(?:unique\s+)?index/i);
});

test('popularity preserves distinct-viewer ranking, bounded results and service-only access', () => {
  assert.match(migration, /count\(distinct h\.user_id\)::bigint/);
  assert.match(migration, /ct\.id = v\.title_id and ct\.user_id = h\.user_id/);
  assert.match(migration, /order by views desc, ct\.provider_tmdb_id/);
  assert.match(migration, /greatest\(1, least\(p_limit, 200\)\)/);
  assert.match(migration, /revoke all on function public\.top_viewed_titles\(text, int\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.top_viewed_titles\(text, int\) to service_role/);
});
