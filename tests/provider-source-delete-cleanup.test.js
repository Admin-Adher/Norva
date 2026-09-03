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
const GUARD_AUTHORITY_MIGRATION = fs.readFileSync(path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260903143000_source_delete_cleanup_guard_authority_v1.sql',
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

test('terminal payload deletion authority is exact and remains fail-closed', () => {
  assert.match(GUARD_AUTHORITY_MIGRATION, /tg_op = ''DELETE''/);
  assert.match(GUARD_AUTHORITY_MIGRATION, /tg_table_name in \(/);
  assert.match(GUARD_AUTHORITY_MIGRATION, /cleanup\.cleanup_kind in \(''replacement'',''source_delete''\)/);
  assert.match(GUARD_AUTHORITY_MIGRATION, /cleanup\.state = ''pending''/);
  assert.match(GUARD_AUTHORITY_MIGRATION, /cleanup\.available_at <= clock_timestamp\(\)/);
  assert.match(GUARD_AUTHORITY_MIGRATION, /lifecycle\.lifecycle_state = ''purge_pending''/);
  assert.match(GUARD_AUTHORITY_MIGRATION, /lifecycle\.catalog_visibility = ''hidden''/);
  assert.match(GUARD_AUTHORITY_MIGRATION, /source\.provider_deletion_pending/);
  assert.match(GUARD_AUTHORITY_MIGRATION, /not exists \([\s\S]*cloud_provider_account_delete_preparations preparation/);
  assert.doesNotMatch(GUARD_AUTHORITY_MIGRATION, /grant execute[\s\S]*authenticated/i);
});

test('cleanup worker publishes authority only around its bounded delete', () => {
  assert.match(
    GUARD_AUTHORITY_MIGRATION,
    /set_config\(''norva\.catalog_purge_source'',v_job\.source_id::text,true\);\\n'\s*\|\| v_delete_old/,
  );
  assert.match(
    GUARD_AUTHORITY_MIGRATION,
    /v_count:=public\.norva_replacement_cleanup_delete_rows/,
  );
  assert.match(GUARD_AUTHORITY_MIGRATION, /set_config\(''norva\.catalog_purge_source'','''',true\)/);
  assert.match(GUARD_AUTHORITY_MIGRATION, /where preparation\.user_id = job\.user_id/);
  assert.match(GUARD_AUTHORITY_MIGRATION, /where preparation\.user_id = v_job\.user_id/);
  assert.match(GUARD_AUTHORITY_MIGRATION, /accountDeleteDeferred/);
  assert.match(GUARD_AUTHORITY_MIGRATION, /for update skip locked limit 1/);
});
