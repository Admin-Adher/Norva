'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260904190000_admin_dashboard_ignore_deleted_sources.sql',
  ),
  'utf8',
);

test('admin source health ignores soft-deleted sources without deleting retained catalogue data', () => {
  assert.match(
    migration,
    /s\.deleted_at is null and coalesce\(mc\.n_ms, 0\) > 0 and coalesce\(vc\.n, 0\) = 0/,
  );
  assert.match(
    migration,
    /where s\.deleted_at is null\s+and \(\s+s\.user_id in/,
  );
  assert.match(
    migration,
    /'sources_total',\(select count\(\*\) from cloud_sources where deleted_at is null\)/,
  );
  assert.match(
    migration,
    /'sources_error',\(select count\(\*\) from cloud_sources where deleted_at is null and \(sync_status = 'sync_error' or sync_error is not null\)\)/,
  );
  assert.match(
    migration,
    /where s\.deleted_at is null and coalesce\(mc\.n,0\)>0 and coalesce\(vc\.n,0\)=0/,
  );
  assert.doesNotMatch(migration, /delete\s+from\s+cloud_(?:sources|media_items|title_variants)/i);
});

test('migration guards every function-definition rewrite before execution', () => {
  assert.equal(
    (migration.match(/length\(v_definition\) - length\(replace\(v_definition, v_needle, ''\)\) <> length\(v_needle\)/g) || []).length,
    8,
  );
  assert.equal((migration.match(/execute v_definition;/g) || []).length, 2);
});
