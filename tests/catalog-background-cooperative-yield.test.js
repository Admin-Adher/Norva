'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260901090000_catalog_background_cooperative_yield_v1.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

test('catalogue background cooperative yield is service-only and exact-CAS fenced', () => {
  assert.match(migration, /perform public\.norva_credential_require_service_role\(\)/);
  assert.match(migration, /from public\.cloud_catalog_background_mode_checkpoints checkpoint[\s\S]*for update/);
  assert.match(migration, /v_checkpoint\.state <> 'processing'/);
  assert.match(migration, /v_checkpoint\.lease_owner <> p_worker/);
  assert.match(migration, /v_checkpoint\.lease_sequence <> p_expected_lease_sequence/);
  assert.match(migration, /v_checkpoint\.revision <> p_expected_revision/);
  assert.match(migration, /jsonb_array_length\(v_checkpoint\.inflight_items\) <> 0/);
  assert.match(migration, /jsonb_array_length\(checkpoint\.inflight_items\) = 0/);
  assert.match(migration, /raise exception 'catalog background cooperative yield update CAS failed'[\s\S]*errcode = 'PT409'/);
  assert.doesNotMatch(migration, /40001/);
  assert.match(
    migration,
    /revoke all on function public\.norva_yield_catalog_title_background_mode\([\s\S]*from public, anon, authenticated, service_role;/,
  );
  assert.match(
    migration,
    /grant execute on function public\.norva_yield_catalog_title_background_mode\([\s\S]*to service_role;/,
  );
});

test('catalogue background cooperative yield preserves durable cursor and inflight state', () => {
  const updateStart = migration.indexOf('update public.cloud_catalog_background_mode_checkpoints checkpoint');
  const whereStart = migration.indexOf('where checkpoint.mode = p_mode', updateStart);
  assert.ok(updateStart >= 0 && whereStart > updateStart);
  const assignments = migration.slice(updateStart, whereStart);

  assert.match(assignments, /set lease_until = clock_timestamp\(\)/);
  assert.match(assignments, /revision = checkpoint\.revision \+ 1/);
  assert.match(assignments, /updated_at = clock_timestamp\(\)/);
  assert.doesNotMatch(assignments, /state\s*=/);
  assert.doesNotMatch(assignments, /lease_owner\s*=/);
  assert.doesNotMatch(assignments, /owner_user_id\s*=/);
  assert.doesNotMatch(assignments, /snapshot_id\s*=/);
  assert.doesNotMatch(assignments, /last_(?:attempted_at|title_id)\s*=/);
  assert.doesNotMatch(assignments, /inflight_[a-z_]+\s*=/);
});
