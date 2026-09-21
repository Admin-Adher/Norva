'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');
const migration = read('supabase/migrations/20260921160000_catalog_title_runtime_variant_spool.sql');
const original = read('supabase/migrations/20260823122010_catalog_visible_titles_index_first_overlay.sql')
  .split('create or replace function public.norva_visible_catalog_title_runtime(')[1]
  .split('$function$;')[0];

test('runtime spool reuses the exact scoped membership without altering any consumer predicate', () => {
  const reference = 'from public.cloud_catalog_visible_title_variants variant';
  assert.equal(original.split(reference).length, 7);
  const scoped = migration.match(/v_scope text := \$scope\$([\s\S]*?)\$scope\$;/)[1];
  assert.match(scoped, /from public\.cloud_catalog_visible_title_variants variant/);
  assert.match(scoped, /where variant\.title_id = p_title_id and variant\.user_id = p_user_id/);
  assert.doesNotMatch(scoped, /cloud_title_variants\b|limit\s+\d+|generation_id is null/i);
  const referenceOnlyChange = original.replaceAll(reference, 'from visible_variants variant');
  assert.equal(referenceOnlyChange.replaceAll('from visible_variants variant', reference), original);
  assert.match(migration, /replace\(v_definition, v_reference, 'from visible_variants variant'\)/);
  assert.match(migration, /replace\(v_definition, v_anchor, v_scope \|\| v_anchor\)/);
  assert.equal((migration.match(/replace\(v_definition/g) || []).length, 2);
});

test('runtime migration fails on definition drift and preserves the invoker privilege contract', () => {
  assert.match(migration, /cardinality\(string_to_array\(v_definition, v_reference\)\) <> 7/);
  assert.match(migration, /v_function\.provolatile <> 's' or v_function\.prosecdef/);
  assert.match(migration, /v_function\.prorows <> 1 or v_function\.lanname <> 'sql'/);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.ok(migration.includes(`has_function_privilege('${role}'`));
  }
  assert.doesNotMatch(migration, /alter role|alter database|security definer|create trigger|drop trigger/i);
  assert.match(migration, /begin;[\s\S]*commit;\s*$/);
});
