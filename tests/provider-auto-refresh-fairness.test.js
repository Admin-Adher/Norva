'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const migration = read('supabase/migrations/20260827033406_provider_auto_refresh_fair_claim_v1.sql');
const edge = read('supabase/functions/norva-source-sync/index.ts');
const edgeDeploy = read('ops/hetzner/scripts/04-deploy-edge-functions.sh');
const integrationWorkflow = read('.github/workflows/partners-integration.yml');
const visibility = read('supabase/migrations/20260822220703_provider_access_lifecycle_foundation.sql');
const pgTapProof = read('supabase/tests/provider_auto_refresh_fair_claim.sql');

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}

test('PostgreSQL owns a short fair claim with a monotone lease fence', () => {
  const claim = between(
    migration,
    'create or replace function public.norva_claim_cloud_auto_refresh_sources(',
    '\ncreate or replace function public.norva_settle_cloud_auto_refresh_source(',
  );
  assert.match(claim, /for update of source skip locked/i);
  assert.match(claim, /auto_refresh_lease_sequence = source\.auto_refresh_lease_sequence \+ 1/i);
  assert.match(claim, /order by source\.auto_refresh_next_at nulls first, source\.id/i);
  assert.match(claim, /norva_source_catalog_visible_internal/);
  assert.match(claim, /source\.auto_refresh_state ->> 'suspended'.*is distinct from 'true'/s);
  assert.match(claim, /limit p_limit/i);
});

test('settlement is CAS-only and never lets an old worker repair a newer claim', () => {
  const settle = between(
    migration,
    'create or replace function public.norva_settle_cloud_auto_refresh_source(',
    '\n-- A real config promotion/rollback',
  );
  assert.match(settle, /auto_refresh_lease_owner is distinct from p_worker/i);
  assert.match(settle, /auto_refresh_lease_sequence is distinct from p_expected_lease_sequence/i);
  assert.match(settle, /if not found then[\s\S]*cloud auto refresh lease is stale[\s\S]*40001/i);
  assert.match(settle, /cloud auto refresh lease is stale.*40001/is);
  assert.match(settle, /where source\.id = p_source_id[\s\S]*source\.auto_refresh_lease_owner = p_worker[\s\S]*source\.auto_refresh_lease_sequence = p_expected_lease_sequence/i);
  assert.doesNotMatch(settle, /sync_error\s*=/i);
});

test('401/403/404 create bounded action-required evidence instead of expiry by assertion', () => {
  const settle = between(
    migration,
    'create or replace function public.norva_settle_cloud_auto_refresh_source(',
    '\n-- A real config promotion/rollback',
  );
  assert.match(settle, /p_http_status not in \(401, 403, 404\)/i);
  assert.match(settle, /'actionRequired', true/i);
  assert.match(settle, /v_suspended := v_terminal_count >= 2/i);
  assert.match(settle, /interval '24 hours'/i);
  assert.match(settle, /interval '30 days'/i);
  assert.doesNotMatch(settle, /update public\.cloud_source_provider_access/i);
});

test('only the existing confirmed Provider Access states hide catalogues', () => {
  const predicate = between(
    visibility,
    'create or replace function public.norva_source_catalog_visible_internal(',
    '\nrevoke all on function public.norva_source_catalog_visible_internal',
  );
  assert.match(predicate, /provider_access_status not in \(\s*'expired_confirmed', 'access_unavailable_confirmed'\s*\)/i);
  assert.doesNotMatch(predicate, /expected_expired[\s\S]*not in/i);
});

test('config changes and successful foreground recovery invalidate old leases', () => {
  const recovery = between(
    migration,
    'create or replace function public.norva_reset_cloud_auto_refresh_on_source_recovery()',
    '\ndrop trigger if exists trg_cloud_sources_reset_auto_refresh_on_recovery',
  );
  assert.match(recovery, /new\.config_ciphertext is distinct from old\.config_ciphertext/i);
  assert.match(recovery, /new\.sync_status = 'ready'/i);
  assert.match(recovery, /norva_cloud_auto_refresh_trusted_context\(\)[\s\S]*new\.sync_status = 'ready'/i);
  assert.match(recovery, /new\.auto_refresh_lease_sequence := old\.auto_refresh_lease_sequence \+ 1/i);
  assert.match(recovery, /'actionRequired'.*'suspended'/s);
});

test('an owner grant cannot mutate server scheduler authority', () => {
  const trust = between(
    migration,
    'create or replace function public.norva_cloud_auto_refresh_trusted_context()',
    '\ncreate or replace function public.norva_guard_cloud_auto_refresh_state()',
  );
  assert.match(trust, /= 'service_role'/i);
  assert.doesNotMatch(trust, /session_user|supabase_admin|postgres/i);
  const guard = between(
    migration,
    'create or replace function public.norva_guard_cloud_auto_refresh_state()',
    '\ndrop trigger if exists trg_cloud_sources_auto_refresh_insert_guard',
  );
  assert.match(guard, /norva_cloud_auto_refresh_trusted_context\(\)/i);
  assert.match(guard, /auto_refresh_lease_sequence is distinct from old\.auto_refresh_lease_sequence/i);
  assert.match(guard, /cloud auto refresh scheduler state is server managed[\s\S]*42501/i);
  assert.match(migration, /before update of auto_refresh_next_at, auto_refresh_state,[\s\S]*auto_refresh_lease_expires_at/i);
  assert.match(migration, /revoke all on function public\.norva_guard_cloud_auto_refresh_state\(\)[\s\S]*authenticated, service_role/i);
});

test('Edge scans past ineligible owners but performs only one provider refresh', () => {
  const cron = between(
    edge,
    'async function cronRefreshDue(',
    '\n// Watchdog for the resumable discovery chain',
  );
  assert.match(cron, /const SCAN_LIMIT = 8/);
  assert.match(cron, /norva_claim_cloud_auto_refresh_sources/);
  assert.match(edge, /async function settleCloudAutoRefreshClaim[\s\S]*norva_settle_cloud_auto_refresh_source/);
  assert.match(cron, /if \(!entitled\)[\s\S]*"not_entitled"[\s\S]*continue;/);
  assert.match(cron, /if \(toSync\)[\s\S]*syncCloudSource\(/);
  assert.doesNotMatch(cron, /from\("cloud_catalog_visible_sources"\)/);
  assert.doesNotMatch(cron, /\.update\(\{[\s\S]*auto_refresh_state/);
});

test('migration changes no cron activation state and RPC authority remains service-only', () => {
  assert.equal((migration.match(/cron\.schedule\s*\(/gi) || []).length, 0);
  assert.equal((migration.match(/active\s*=>/gi) || []).length, 0);
  assert.match(migration, /revoke all on function public\.norva_claim_cloud_auto_refresh_sources[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.norva_settle_cloud_auto_refresh_source[\s\S]*to service_role/i);
});

test('Edge exposes and deployment verifies the fair-claim protocol on every runtime', () => {
  assert.match(edge, /version: 13[\s\S]*cloudAutoRefreshClaimProtocol: 1/);
  assert.match(edgeDeploy, /EXPECTED_SOURCE_SYNC_VERSION=13/);
  assert.match(edgeDeploy, /EXPECTED_CLOUD_AUTO_REFRESH_CLAIM_PROTOCOL=1/);
  assert.match(edgeDeploy, /norva-source-sync source digest mismatch/);
  assert.match(edgeDeploy, /function_health_in_service "\$service" norva-source-sync/);
  assert.match(edgeDeploy, /norva-source-sync protocol marker mismatch/);
});

test('disposable Supabase CI executes the real fair-claim pgTAP suite', () => {
  const migrationStep = integrationWorkflow.indexOf(
    'Apply the focused Provider refresh migration graph',
  );
  const proofStep = integrationWorkflow.indexOf(
    'Run the Provider refresh PostgreSQL concurrency proof',
  );
  assert.ok(migrationStep >= 0 && proofStep > migrationStep);
  const focusedProof = integrationWorkflow.slice(migrationStep, proofStep + 500);
  assert.match(focusedProof, /20260822220703_provider_access_lifecycle_foundation\.sql/);
  assert.match(focusedProof, /20260824120000_provider_access_cycles_detection_v1\.sql/);
  assert.match(focusedProof, /20260827033406_provider_auto_refresh_fair_claim_v1\.sql/);
  assert.match(focusedProof, /norva\.test_dblink_password = 'postgres'/);
  assert.match(
    focusedProof,
    /supabase test db[\s\S]*supabase\/tests\/provider_auto_refresh_fair_claim\.sql[\s\S]*--local/,
  );
  assert.doesNotMatch(
    pgTapProof,
    /grant execute on all functions in schema extensions/i,
    'the proof must not request privileged dblink_connect_u authority',
  );
  assert.doesNotMatch(pgTapProof, /public\.dblink_/i);
  assert.match(pgTapProof, /alter extension dblink set schema extensions/i);
  assert.match(pgTapProof, /current_setting\('norva\.test_dblink_password', true\)/i);
  assert.doesNotMatch(pgTapProof, /password=postgres/i);
});
