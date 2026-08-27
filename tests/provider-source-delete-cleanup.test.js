import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = fs.readFileSync(path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260827111500_source_delete_cleanup_recovery_v1.sql',
), 'utf8');
const BACKOFF_MIGRATION = fs.readFileSync(path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260827122000_source_delete_cleanup_wait_backoff_v1.sql',
), 'utf8');

test('ordinary source removal reuses the fenced durable cleanup lane', () => {
  assert.match(MIGRATION, /cleanup_kind in \('replacement','source_delete'\)/);
  assert.match(MIGRATION, /trg_zz_cloud_sources_schedule_delete_cleanup/);
  assert.match(MIGRATION, /norva_source_delete_cleanup_eligible/);
  assert.match(MIGRATION, /transition\.state not in \('completed','failed','cancelled'\)/);
  assert.match(MIGRATION, /job\.state in \('pending','processing'\)/);
  assert.match(MIGRATION, /on conflict do nothing/);
  assert.match(MIGRATION, /or v_replacement_source_purge/);
  assert.match(MIGRATION, /norva_catalog_generation_row_changed/);
  assert.match(MIGRATION, /old\.enabled and not new\.enabled/);
});

test('crash recovery is PostgreSQL-owned and remains bounded', () => {
  assert.match(MIGRATION, /norva_recover_source_delete_cleanups\(100\)/);
  assert.match(MIGRATION, /p_limit not between 1 and 1000/);
  assert.match(MIGRATION, /order by source\.deleted_at,source\.id\s+limit p_limit/);
  assert.match(MIGRATION, /norva_run_replacement_cleanup_batch\(''source-reaper'',200\)/);
  assert.doesNotMatch(MIGRATION, /commit;[\s\S]*commit;/i);
  assert.match(BACKOFF_MIGRATION, /v_occurrences <> 2/i);
  assert.match(BACKOFF_MIGRATION, /interval ''10 minutes''/i);
  assert.doesNotMatch(BACKOFF_MIGRATION, /grant execute[\s\S]*authenticated/i);
});

test('operator path does not broaden client authority', () => {
  assert.match(MIGRATION, /session_user not in \(''postgres'',''supabase_admin''\)/);
  assert.match(MIGRATION, /norva_credential_require_service_role/);
  assert.match(MIGRATION, /revoke all on function[\s\S]*from public,anon,authenticated,service_role/i);
  assert.match(MIGRATION, /enable row level security|cloud_source_replacement_cleanup_jobs/i);
  assert.doesNotMatch(MIGRATION, /grant execute[\s\S]*authenticated/i);
});
