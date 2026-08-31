'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(
  ROOT,
  'supabase/migrations/20260831110958_cloud_genre_summary_source_index_first_v1.sql',
), 'utf8').replace(/\r\n?/g, '\n');

function sourceBranch() {
  const start = migration.indexOf('return query\n    with requested_source as materialized');
  assert.notEqual(start, -1, 'source-scoped branch must exist');
  const end = migration.indexOf('\nend\n$function$;', start);
  assert.notEqual(end, -1, 'source-scoped branch must be complete');
  return migration.slice(start, end);
}

test('source genre counts resolve visibility once and use generation-head indexes in bulk', () => {
  const branch = sourceBranch();

  assert.match(migration, /if not public\.norva_source_catalog_visible\(p_source_id, p_user_id\) then\s+return;/);
  assert.match(branch, /from public\.cloud_catalog_visible_sources source/);
  assert.match(branch, /requested_source as materialized/);
  assert.match(branch, /visible_sources as materialized/);
  assert.match(branch, /from requested_source source[\s\S]*join public\.cloud_title_variants variant/);
  assert.match(branch, /left join public\.cloud_source_catalog_heads head/);
  assert.match(branch, /head\.active_generation_id = variant\.generation_id/);
  assert.doesNotMatch(branch, /cloud_catalog_visible_titles/);
  assert.doesNotMatch(branch, /norva_visible_catalog_title_runtime/);
});

test('source genre counts reproduce the title-grid display owner and include Other', () => {
  const branch = sourceBranch();

  assert.match(branch, /display_owners as materialized/);
  assert.match(branch, /order by[\s\S]*variant\.source_id,[\s\S]*variant\.generation_id nulls first,[\s\S]*variant\.id/);
  assert.match(branch, /cloud_source_catalog_generation_candidate_titles projection/);
  assert.match(branch, /projection\.generation_id = owner\.generation_id/);
  assert.match(branch, /coalesce\([\s\S]*projection\.genre_buckets,[\s\S]*title\.genre_buckets,[\s\S]*array\['autres'\]/);
  assert.doesNotMatch(branch, /genre_bucket <> 'autres'/);
});

test('source genre count RPC remains service-only and search-path fenced', () => {
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /revoke all on function public\.cloud_genre_bucket_counts\(uuid, text, uuid\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.cloud_genre_bucket_counts\(uuid, text, uuid\)[\s\S]*to service_role/);
  assert.match(migration, /has_function_privilege\([\s\S]*'anon'/);
  assert.match(migration, /has_function_privilege\([\s\S]*'authenticated'/);
  assert.match(migration, /has_function_privilege\([\s\S]*'service_role'/);
});
