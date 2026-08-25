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
});

test('production rollout mutations require distinct literal confirmations', () => {
  assert.match(script, /CONFIGURE_PROVIDER_ACCESS_ROLLOUT_GATES/);
  assert.match(script, /SET_PROVIDER_ACCESS_INTERNAL_USER/);
  assert.match(script, /SET_PROVIDER_ACCESS_STAGE_\$\{ROLLOUT_STAGE\}/);
  assert.match(script, /SET_PROVIDER_ACCESS_EXTERNAL_CHANNELS/);
});

test('cohort activation refuses incomplete cache epoch and channels refuse OFF', () => {
  assert.match(script, /ROLLOUT_STAGE" != 'off' && "\$CACHE_PHASE" != 'complete'/);
  assert.match(script, /CACHE_PHASE" != 'complete' \|\| "\$CURRENT_STAGE" == 'off'/);
  assert.match(script, /norva_assert_provider_access_rollout_safe/);
});

test('rollout gate approval binds the exact configured legal policy reference', () => {
  assert.match(script, /LEGAL_POLICY_REVISION" == 'UNCONFIGURED'/);
  assert.match(script, /LEGAL_POLICY_REFERENCE" != "\$CURRENT_POLICY_REFERENCE/);
  assert.match(script, /norva_configure_provider_access_rollout_gates/);
});

test('operator values use psql variables rather than interpolated SQL', () => {
  assert.match(script, /-v expected_revision="\$EXPECTED_ROLLOUT_REVISION"/);
  assert.match(script, /:'expected_revision'::bigint/);
  assert.match(script, /:'user_id'::uuid/);
  assert.doesNotMatch(script, /select public\.norva_set_provider_access_rollout_stage\(\s*'\$ROLLOUT_STAGE'/);
});
