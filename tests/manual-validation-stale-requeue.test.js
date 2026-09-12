'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260912160500_manual_validation_stale_requeue.sql'), 'utf8');
test('manual requeue retires only obsolete, due work without removing cache or quarantine evidence', () => {
  const block = sql.match(/\$new\$([\s\S]*?)\$new\$/)[1];
  assert.match(block, /set state = 'failed'/);
  assert.match(block, /error_code = 'PROFILE_CHANGED'/);
  assert.match(block, /job\.requested_by = p_requested_by/);
  assert.match(block, /job\.request_origin <> 'automatic'/);
  assert.match(block, /job\.lease_expires_at is null or job\.lease_expires_at <= v_now/);
  assert.match(block, /cache\.observed_profile_fingerprint is not null/);
  for (const field of ['profile_fingerprint', 'profile_probed_at', 'profile_snapshot', 'file_size_bytes']) assert.match(block, new RegExp(`job\\.${field} is distinct from`));
  assert.doesNotMatch(block, /DELETE|UPDATE public\.catalog_file_tracks|SET profile_snapshot/i);
  assert.match(sql, /EXECUTE replace\(definition, old_block, new_block\)/);
  assert.match(sql, /Manual validation requeue guard drifted/);
});
