const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const script = fs.readFileSync(path.join(
  __dirname,
  '..',
  'ops',
  'hetzner',
  'scripts',
  'run_provider_access_rollout_gate.sh',
), 'utf8');

test('production rollout operator gate is read-only by default and binds the exact DB', () => {
  assert.match(script, /DB_CONTAINER="\$\{DB_CONTAINER:-norva-db\}"/);
  assert.match(script, /if \[\[ "\$DB_CONTAINER" != 'norva-db' \]\]/);
  assert.match(script, /ACTION="\$\{1:-preflight\}"/);
  assert.match(script, /status=READ_ONLY_PREFLIGHT/);
  assert.match(script, /provider_crons=%s/);
  assert.match(script, /active_refresh_ready=%s/);
  assert.match(script, /active_refresh_worker_cron_ready=%s/);
});

test('production rollout mutations require distinct literal confirmations', () => {
  assert.match(script, /CONFIGURE_PROVIDER_ACCESS_ROLLOUT_GATES/);
  assert.match(script, /SET_PROVIDER_ACCESS_INTERNAL_USER/);
  assert.match(script, /SET_PROVIDER_ACCESS_STAGE_\$\{ROLLOUT_STAGE\}/);
  assert.match(script, /SET_PROVIDER_ACCESS_EXTERNAL_CHANNELS/);
  assert.match(script, /ENQUEUE_PROVIDER_ACCESS_PUSH_READINESS_SMOKE/);
  assert.match(script, /INSTALL_PROVIDER_ACCESS_NOTIFICATION_CRON/);
  assert.match(script, /INSTALL_PROVIDER_ACCESS_DETECTION_CRON/);
  assert.match(script, /REMOVE_PROVIDER_ACCESS_CRONS/);
});

test('push readiness smoke is internal-only, revision-CAS and parameterized', () => {
  assert.match(script, /enqueue-push-readiness-smoke/);
  assert.match(script, /CURRENT_REVISION" != "\$EXPECTED_ROLLOUT_REVISION/);
  assert.match(script, /CURRENT_STAGE" != 'internal'/);
  assert.match(script, /norva_enqueue_provider_access_push_readiness_smoke/);
  assert.match(script, /:'user_id'::uuid,:'expected_revision'::bigint,:'readiness',:'actor'/);
});

test('cohort activation refuses incomplete cache epoch and channels refuse OFF', () => {
  assert.match(script, /ROLLOUT_STAGE" != 'off' && "\$CACHE_PHASE" != 'complete'/);
  assert.match(script, /CACHE_PHASE" != 'complete' \|\| "\$CURRENT_STAGE" == 'off'/);
  assert.match(script, /norva_assert_provider_access_rollout_safe/);
  assert.match(script, /REFUSED_ACTIVE_REFRESH_WORKER_NOT_READY/);
  assert.match(script, /REFUSED_ACTIVE_REFRESH_WORKER_CRON_NOT_READY/);
  assert.match(script, /norva_active_catalog_refresh_contract_ready/);
});

test('rollout gate approval binds the exact configured legal policy reference', () => {
  assert.match(script, /LEGAL_POLICY_REVISION" == 'UNCONFIGURED'/);
  assert.match(script, /LEGAL_POLICY_REFERENCE" != "\$CURRENT_POLICY_REFERENCE/);
  assert.match(script, /norva_configure_provider_access_rollout_gates/);
});

test('provider network crons are armed and removed only through service RPCs', () => {
  assert.match(script, /norva_install_provider_access_notification_cron/);
  assert.match(script, /norva_install_provider_access_check_cron/);
  assert.match(script, /norva_remove_provider_access_crons/);
});

test('operator values use psql variables rather than interpolated SQL', () => {
  assert.match(script, /-v expected_revision="\$EXPECTED_ROLLOUT_REVISION"/);
  assert.match(script, /:'expected_revision'::bigint/);
  assert.match(script, /:'user_id'::uuid/);
  assert.doesNotMatch(script, /select public\.norva_set_provider_access_rollout_stage\(\s*'\$ROLLOUT_STAGE'/);
});
