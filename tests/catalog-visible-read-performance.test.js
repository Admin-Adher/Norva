'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(
    root,
    'supabase/migrations/20260828081328_catalog_visible_read_performance_v1.sql',
  ),
  'utf8',
);

function routine(name, nextName) {
  const start = migration.indexOf(`create or replace function public.${name}`);
  const end = nextName
    ? migration.indexOf(`create or replace function public.${nextName}`, start + 1)
    : migration.indexOf("notify pgrst, 'reload schema'", start + 1);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing end marker for ${name}`);
  return migration.slice(start, end);
}

const search = routine('search_media_items', 'norva_visible_catalog_exceeds');
const threshold = routine(
  'norva_visible_catalog_exceeds',
  'list_media_items_deduped',
);
const list = routine('list_media_items_deduped');

test('catalog reads snapshot lifecycle-visible sources before scanning media rows', () => {
  for (const [name, source] of [
    ['search_media_items', search],
    ['norva_visible_catalog_exceeds', threshold],
    ['list_media_items_deduped', list],
  ]) {
    assert.match(source, /visible_sources as materialized/);
    assert.match(source, /from public\.cloud_catalog_visible_sources source/);
    assert.match(source, /join visible_sources visible_source/);
    assert.match(source, /public\.cloud_source_catalog_heads/);
    assert.match(source, /head\.active_generation_id = (?:item|media)\.generation_id/);
    assert.doesNotMatch(source, /public\.cloud_catalog_visible_media_items/);
    assert.match(
      source,
      /revoke all on function[\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute on function[\s\S]*to service_role;/,
      `${name} must remain service-only`,
    );
  }
});

test('the grid keeps visible-sibling deduplication and every sort contract', () => {
  assert.match(list, /representative_source\.id = representative\.source_id/);
  assert.match(list, /representative_head\.active_generation_id = representative\.generation_id/);
  assert.match(list, /representative\.dedup_key = media\.dedup_key/);
  assert.doesNotMatch(list, /\.is_dedup_primary/);

  assert.match(list, /if p_item_type = 'series' then/);
  assert.match(list, /visible_source_ids as materialized/);
  assert.match(list, /media\.source_id = any\(visible_source_ids\.ids\)/);
  assert.match(list, /eligible as materialized/);
  assert.match(list, /select distinct on \(_dedup_group\)/);
  assert.match(list, /join public\.cloud_media_items media using \(id\)/);

  for (const order of [
    'added_at desc nulls last',
    'rating_num desc nulls last',
    'release_year desc nulls last',
    'release_year asc nulls last',
    'title asc',
  ]) {
    assert.ok(list.includes(order), `missing ${order} sort`);
  }
});

test('the fix does not mask timeouts or relax the authenticated role', () => {
  assert.doesNotMatch(migration, /alter (?:role|database)[\s\S]*statement_timeout/i);
  assert.equal(
    (migration.match(/set local statement_timeout = '30s';/g) || []).length,
    1,
  );
  assert.doesNotMatch(migration, /set_config\([^)]*statement_timeout/i);
  assert.doesNotMatch(migration, /exception when others/i);
  assert.match(migration, /notify pgrst, 'reload schema'/);
  assert.match(migration, /begin;[\s\S]*commit;\s*$/);
});
