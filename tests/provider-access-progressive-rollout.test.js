const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const migration = read('supabase/migrations/20260824160000_provider_access_progressive_rollout_v1.sql');
const edge = read('supabase/functions/norva-provider-access/index.ts');
const notifyEdge = read('supabase/functions/norva-provider-access-notify/index.ts');
const app = read('public/js/app.js');
const api = read('public/js/api.js');
const cloudApi = read('public/js/cloudApi.js');

test('phase16 rollout installs OFF with the exact explicit stage ladder', () => {
  assert.match(migration, /default 'off'/);
  assert.match(migration, /'off','internal','1_percent','5_percent','20_percent','50_percent','100_percent'/);
  assert.match(migration, /cohort_basis_points in \(0,100,500,2000,5000,10000\)/);
  assert.match(migration, /update public\.admin_feature_flags[\s\S]*set enabled = false/);
});

test('phase16 upward movement is approval, P0 and sequentially gated', () => {
  assert.match(migration, /legal_policy_approved_at is null or v_rollout\.operational_approved_at is null/);
  assert.match(migration, /perform public\.norva_assert_provider_access_rollout_safe\(\)/);
  assert.match(migration, /if v_next_rank > v_current_rank \+ 1 then/);
  assert.match(migration, /rollout stage cannot be skipped/);
  assert.match(migration, /where singleton and revision=p_expected_revision/);
});

test('phase16 cohort assignment is durable, deterministic and server-only', () => {
  assert.match(migration, /provider-access-rollout:v1:/);
  assert.match(migration, /extensions\.digest\([\s\S]*'sha256'/);
  assert.match(migration, /cloud_provider_access_rollout_internal_users/);
  assert.match(migration, /revoke all on function public\.norva_provider_access_rollout_eligible_internal\(uuid\)[\s\S]*authenticated/);
  assert.match(migration, /auth\.uid\(\) = p_user_id/);
});

test('phase16 guards new scheduler and notification work and cohort-scopes access hiding', () => {
  assert.match(migration, /trg_provider_access_check_rollout_guard/);
  assert.match(migration, /trg_provider_access_notification_rollout_guard/);
  assert.match(migration, /gate\.access_enabled and gate\.visibility_enabled and rollout\.eligible/);
  assert.match(migration, /lifecycle\.lifecycle_state='active' and lifecycle\.catalog_visibility='visible'/);
});

test('provider Edge exposes sanitized status and fences every user route by eligibility', () => {
  assert.match(edge, /segments\.join\("\/"\) === "v1\/rollout"/);
  assert.match(edge, /const user = await requireUserJwt\(req\);[\s\S]*providerAccessRolloutStatus\(user\.id\)/);
  assert.match(edge, /await requireProviderAccessRolloutEligibility\(user\.id\);/);
  assert.match(edge, /norva_provider_access_rollout_status/);
  assert.match(edge, /rollout\.eligible !== true\)[\s\S]*rollout_ineligible/);
  assert.match(notifyEdge, /rolloutEligible\(claimed\.user_id\)/);
  assert.match(notifyEdge, /ROLLOUT_INELIGIBLE/);
});

test('web UI derives Provider Access visibility from server rollout status', () => {
  assert.match(cloudApi, /rolloutStatus:[\s\S]*'GET', '\/v1\/rollout'/);
  assert.match(api, /rolloutStatus: async/);
  assert.match(app, /window\.NORVA_PROVIDER_ACCESS_UI_V1 = false/);
  assert.match(app, /status\?\.eligible === true/);
  assert.match(app, /norva:provider-access-rollout/);
});
