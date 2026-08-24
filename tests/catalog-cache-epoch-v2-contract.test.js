'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n?/g, '\n');
const migration = read('supabase/migrations/20260824100000_catalog_cache_epoch_v2.sql');
const observationGateMigration = read('supabase/migrations/20260824171000_catalog_cache_epoch_v2_minimum_observation_gate.sql');
const productionGate = read('ops/hetzner/scripts/run_provider_access_production_activation_gate.sh');
const manifest = read('docs/audits/provider-access-lifecycle-2026-08-22/13-catalog-cache-epoch-v2-manifest.md');
const manifestHash = crypto.createHash('sha256').update(manifest, 'utf8').digest('hex');

test('the DB rollout is immutably bound to the canonical LF manifest', () => {
  assert.equal(manifestHash, '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3');
  assert.equal((migration.match(new RegExp(manifestHash, 'g')) || []).length, 2);
  assert.match(migration, /p_contract is distinct from 'catalog-cache-epoch-v2'/);
  assert.match(migration, /phase='complete'[\s\S]*manifest_sha256=p_manifest_sha256/);
});

test('global policy and account visibility remain independent monotone authorities', () => {
  assert.match(migration, /create table public\.cloud_global_catalog_visibility_epoch/);
  assert.match(migration, /global_epoch=epoch\.global_epoch\+1/);
  assert.doesNotMatch(
    migration,
    /create or replace function public\.norva_bump_user_catalog_visibility_epoch/,
    'v2 must not serialize unrelated account mutations through the global singleton',
  );
  assert.match(migration, /'cacheEpoch','v2\.'\|\|v_global_epoch::text\|\|'\.'\|\|v_user_epoch::text/);
});

test('the composite RPC is owner-scoped and tables remain inaccessible directly', () => {
  assert.match(migration, /auth\.uid\(\) is distinct from p_user_id[\s\S]*return null/);
  assert.match(migration, /coalesce\(v_sql_role,''\) in \('','postgres','supabase_admin'\)/);
  assert.match(migration, /revoke all on table public\.cloud_global_catalog_visibility_epoch[\s\S]*service_role/);
  assert.match(migration, /grant execute on function public\.norva_catalog_cache_epoch_v2\(uuid\)[\s\S]*authenticated,service_role/);
});

test('the historical flag trigger becomes the atomic v2 guard and invalidator', () => {
  assert.match(migration, /lock table public\.admin_feature_flags in share row exclusive mode/);
  assert.match(migration, /create or replace function public\.norva_provider_access_flag_visibility_changed\(\)/);
  assert.match(migration, /reason=global_visibility_epoch_v2_required/);
  assert.match(migration, /new\.key in \('provider_access_v1_enabled','provider_access_visibility_v1_enabled'\)[\s\S]*norva_bump_global_catalog_visibility_epoch/);
  assert.doesNotMatch(migration, /create or replace trigger trg_catalog_cache_epoch_v2/);
});

test('installation is additive and leaves visibility OFF', () => {
  assert.match(migration, /phase text not null default 'installed'/);
  assert.match(migration, /coalesce\(\(select enabled from public\.admin_feature_flags[\s\S]*provider_access_visibility_v1_enabled[\s\S]*true\)/);
  assert.doesNotMatch(migration, /set enabled\s*=\s*true/i);
});

test('completion is database-gated by the full incompatible-cache lifetime', () => {
  assert.match(observationGateMigration, /installed_at \+ interval '7 days'/);
  assert.match(observationGateMigration, /clock_timestamp\(\) < v_not_before/);
  assert.match(observationGateMigration, /catalog cache epoch v2 observation window is incomplete/);
  assert.match(observationGateMigration, /errcode='55000'/);
  assert.match(observationGateMigration, /reason=observation_window;not_before=/);
  assert.match(observationGateMigration, /perform public\.norva_bump_global_catalog_visibility_epoch\(\)/);
});

test('the production operator path is read-only by default and needs exact confirmation', () => {
  assert.match(productionGate, /ACTION="\$\{1:-preflight\}"/);
  assert.match(productionGate, /DB_CONTAINER" != 'norva-db'/);
  assert.match(productionGate, /installed_at \+ interval '7 days'/);
  assert.match(productionGate, /WAIT_OBSERVATION_WINDOW/);
  assert.match(productionGate, /CONFIRM_PRODUCTION_ACTIVATION:-/);
  assert.match(productionGate, /COMPLETE_CACHE_EPOCH_V2_AFTER_7D/);
  assert.match(productionGate, new RegExp(manifestHash));
});
