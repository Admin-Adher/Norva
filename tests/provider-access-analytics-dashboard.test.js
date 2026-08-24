'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const migration = read('supabase/migrations/20260824150000_provider_access_analytics_dashboard_v1.sql');
const adminEdge = read('supabase/functions/norva-admin/index.ts');
const adminPage = read('public/js/pages/AdminPage.js');
const app = read('public/js/app.js');

test('Phase 15 dashboard contains every required aggregate metric', () => {
  for (const metric of [
    'sources_with_access_date', 'provider_reported_expiry', 'user_entered_expiry',
    'expected_expired', 'confirmed_expired', 'access_restored',
    'current_access_extended', 'new_credentials_submitted', 'same_catalog_detected',
    'different_catalog_detected', 'ambiguous_catalog', 'credential_swaps_completed',
    'credential_swaps_rolled_back', 'replacements_started', 'completed', 'failed',
    'cancelled', 'staging_visibility_violation', 'cleanup_pending', '7d_sent',
    '1d_sent', 'today_sent', 'superseded', 'dead_letter', 'push_delivered',
    'email_delivered',
  ]) assert.match(migration, new RegExp(`'${metric}'`));
});

test('analytics are aggregate-only and browser roles cannot execute the RPC', () => {
  assert.match(migration, /revoke all on function public\.norva_provider_access_analytics_dashboard\(integer\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.norva_provider_access_analytics_dashboard\(integer\)[\s\S]*to service_role/);
  const returnedDashboard = migration.slice(migration.indexOf("return jsonb_build_object("), migration.indexOf("end\n$function$;"));
  for (const forbidden of ['user_id', 'source_id', 'transition_id', 'email', 'token', 'ciphertext', 'username', 'password']) {
    assert.doesNotMatch(returnedDashboard, new RegExp(`'${forbidden}'`, 'i'));
  }
});

test('a staging visibility violation is an unsuppressible P0 rollout gate', () => {
  assert.match(migration, /STAGING_VISIBILITY_VIOLATION/);
  assert.match(migration, /'severity',[\s\S]*then 'P0'/);
  assert.match(migration, /norva_assert_provider_access_rollout_safe/);
  assert.match(migration, /raise exception 'provider access rollout blocked by staging visibility violation'/);
  assert.match(migration, /errcode = 'P0001'/);
});

test('the internal dashboard is admin-JWT-gated and renders P0 distinctly', () => {
  const adminGate = adminEdge.indexOf('actorRole !== "admin"');
  const route = adminEdge.indexOf('provider-access-analytics');
  assert.ok(adminGate >= 0 && route > adminGate);
  assert.match(adminEdge, /norva_provider_access_analytics_dashboard/);
  assert.match(adminPage, /Provider Access · rollout 30 jours/);
  assert.match(adminPage, /p0Active[\s\S]*P0 · staging visible/);
  assert.match(adminPage, /agrégats uniquement, aucun identifiant utilisateur ou credential/);
  assert.match(app, /AdminPage\.js\?v=892adb93ca/);
});
