const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260825050000_catalog_background_owner_row_count.sql',
), 'utf8');

test('owner row counts are maintained by aggregated transition-table triggers', () => {
  assert.match(migration, /create or replace trigger trg_catalog_background_owner_rows_insert_count[\s\S]*after insert[\s\S]*referencing new table as inserted_owner_rows[\s\S]*for each statement/i);
  assert.match(migration, /create or replace trigger trg_catalog_background_owner_rows_update_count[\s\S]*after update[\s\S]*referencing old table as replaced_owner_rows new table as updated_owner_rows[\s\S]*for each statement/i);
  assert.match(migration, /create or replace trigger trg_catalog_background_owner_rows_delete_count[\s\S]*after delete[\s\S]*referencing old table as deleted_owner_rows[\s\S]*for each statement/i);
  assert.doesNotMatch(migration, /for each row/i);
  assert.doesNotMatch(migration, /drop trigger/i);
});

test('building snapshots remain builder-owned while live snapshots receive deltas', () => {
  const liveStateFence = /snapshot\.state in \('ready','active','retained'\)/gi;
  assert.equal([...migration.matchAll(liveStateFence)].length, 5);
  assert.match(migration, /row_count = snapshot\.row_count \+ delta\.present_delta/i);
  assert.match(migration, /row_count = snapshot\.row_count - delta\.present_delta/i);
});

test('the migration repairs and then verifies exact present-row counts', () => {
  assert.match(migration, /count\(owner_row\.title_id\) filter \(where owner_row\.is_present\)/i);
  assert.match(migration, /row_count = exact_counts\.present_count/i);
  assert.match(migration, /raise exception 'catalog background owner row_count repair is incomplete'/i);
});

test('counter helpers are not callable through API roles', () => {
  for (const suffix of ['insert', 'update', 'delete']) {
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.norva_catalog_background_owner_rows_${suffix}_count\\(\\)\\s+from public, anon, authenticated, service_role`, 'i'),
    );
  }
});
