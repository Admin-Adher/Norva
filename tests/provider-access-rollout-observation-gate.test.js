'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const migration = read(
  'supabase/migrations/20260825012308_provider_access_rollout_observation_gate_v1.sql',
);
const analyticsFix = read(
  'supabase/migrations/20260825012611_provider_access_analytics_delivered_state_fix_v1.sql',
);
const observationV2 = read(
  'supabase/migrations/20260825195500_provider_access_rollout_observation_contract_v2.sql',
);
const operator = read('ops/hetzner/scripts/run_provider_access_rollout_gate.sh');
const race = read('ops/hetzner/scripts/run_provider_access_rollout_observation_race.sh');
const installer = read(
  'ops/hetzner/scripts/run_provider_access_rollout_observation_install.sh',
);

test('every active rollout revision has a durable versioned observation contract', () => {
  assert.match(migration, /create table public\.cloud_provider_access_rollout_observations/);
  assert.match(migration, /threshold_contract = 'provider-access-rollout-observation:v1'/);
  assert.match(migration, /rollout_revision bigint not null/);
  assert.match(migration, /'collecting','accepted','rejected','stale'/);
  assert.match(migration, /where state = 'collecting'/);
  assert.match(migration, /where state = 'accepted'/);
  assert.match(
    migration,
    /revoke insert, update, delete on table[\s\S]*cloud_provider_access_rollout_channel_events[\s\S]*from service_role/,
  );
});

test('observation windows and thresholds are server-owned and conservative', () => {
  for (const seconds of [3600, 21600, 43200, 86400, 172800, 259200]) {
    assert.match(migration, new RegExp(`then ${seconds}`));
  }
  assert.match(migration, /minimumQualifyingActivity', 1/);
  assert.match(migration, /maximumReplacementFailureRate', 0\.02/);
  assert.match(migration, /maximumCredentialRollbackRate', 0\.05/);
  assert.match(migration, /maximumNotificationDeadLetterRate', 0\.01/);
  assert.match(migration, /maximumStagingVisibilityViolation', 0/);
  assert.match(migration, /clock_timestamp\(\) < v_observation\.not_before/);
  assert.equal(
    (migration.match(/norva_provider_access_rollout_eligible_internal\(/g) || []).length,
    3,
  );
  assert.match(
    migration,
    /norva_provider_access_rollout_observation_metrics\([\s\S]*?language plpgsql\s+volatile\s+security definer/,
  );
});

test('promotion requires an accepted observation for the exact current revision', () => {
  assert.match(migration, /cloud_provider_access_rollout_00_observation_guard/);
  assert.match(migration, /observation\.rollout_revision = old\.revision/);
  assert.match(migration, /observation\.stage = old\.stage/);
  assert.match(migration, /observation\.state = 'accepted'/);
  assert.match(migration, /rollout stage lacks an accepted observation/);
  assert.match(migration, /new\.revision <> old\.revision[\s\S]*state = 'stale'/);
  assert.match(migration, /old\.stage <> 'off'/);
});

test('observation decisions are service-only, CAS-bound and explicit', () => {
  assert.match(migration, /norva_provider_access_service_role_required\(\)/);
  assert.match(migration, /v_rollout\.revision <> p_expected_revision/);
  assert.match(migration, /rollout observation already collecting/);
  assert.match(migration, /stale rollout observation/);
  assert.match(migration, /p_evidence_reference/);
  assert.match(migration, /p_approval_note/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/);
});

test('observation v2 counts the canonical access-cycle start without rewriting v1', () => {
  assert.match(observationV2, /provider-access-rollout-observation:v1/);
  assert.match(observationV2, /provider-access-rollout-observation:v2/);
  assert.match(observationV2, /event\.event_kind = 'provider_access_cycle_started'/);
  assert.match(observationV2, /norva_provider_access_rollout_observation_metrics_v2/);
  assert.match(observationV2, /'\{schemaVersion\}', '2'::jsonb/);
  assert.doesNotMatch(
    observationV2,
    /create or replace function public\.norva_provider_access_rollout_observation_metrics\(/,
  );
});

test('v2 restart preserves old evidence and starts a fresh full observation window', () => {
  assert.match(observationV2, /activity_started_at timestamptz/);
  assert.match(observationV2, /supersedes_observation_id uuid/);
  assert.match(observationV2, /activity_started_at <= started_at/);
  assert.match(
    observationV2,
    /not_before >= started_at \+ make_interval\(secs => minimum_window_seconds\)/,
  );
  assert.match(observationV2, /v_predecessor\.activity_started_at/);
  assert.match(observationV2, /THRESHOLD_CONTRACT_SUPERSEDED/);
  assert.match(observationV2, /set state = 'stale'/);
  assert.doesNotMatch(observationV2, /delete from public\.cloud_provider_access_rollout_observations/);
});

test('v2 completion and promotion fail closed on superseded contracts', () => {
  assert.match(observationV2, /reason=threshold_contract_superseded/);
  assert.match(
    observationV2,
    /v_snapshot := public\.norva_provider_access_rollout_observation_metrics_v2\([\s\S]*v_observation\.activity_started_at/,
  );
  assert.match(
    observationV2,
    /observation\.state = 'accepted'[\s\S]*observation\.threshold_contract = 'provider-access-rollout-observation:v2'/,
  );
  assert.match(
    observationV2,
    /revoke all on function[\s\S]*norva_restart_provider_access_rollout_observation_v2[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.match(
    observationV2,
    /grant execute on function[\s\S]*norva_restart_provider_access_rollout_observation_v2[\s\S]*to service_role/,
  );
});

test('notification analytics use the canonical delivered terminal state', () => {
  assert.doesNotMatch(analyticsFix, /notification\.state = 'completed'/);
  assert.equal((analyticsFix.match(/notification\.state = 'delivered'/g) || []).length, 5);
});

test('operator gate exposes read-only status plus explicit observation mutations', () => {
  assert.match(operator, /observation-status/);
  assert.match(operator, /start-observation/);
  assert.match(operator, /complete-observation/);
  assert.match(operator, /restart-observation-v2/);
  assert.match(operator, /START_PROVIDER_ACCESS_ROLLOUT_OBSERVATION/);
  assert.match(operator, /COMPLETE_PROVIDER_ACCESS_ROLLOUT_OBSERVATION/);
  assert.match(operator, /RESTART_PROVIDER_ACCESS_ROLLOUT_OBSERVATION_V2/);
});

test('real PostgreSQL concurrency proof races start, completion and promotion', () => {
  assert.match(race, /start_sql 'observation-start-race-a'[\s\S]*start_sql 'observation-start-race-b'/);
  assert.match(race, /complete_sql 'observation-complete-race-a'[\s\S]*complete_sql 'observation-complete-race-b'/);
  assert.match(race, /promote_sql 'observation-promotion-race-a'[\s\S]*promote_sql 'observation-promotion-race-b'/);
  assert.match(race, /rollout observation already collecting/);
  assert.match(race, /stale rollout observation/);
  assert.match(race, /stale rollout revision/);
  assert.match(race, /1_percent:4:1:1/);
});

test('production installer is exact, backed up and dormant', () => {
  assert.match(installer, /DB_CONTAINER="\$\{DB_CONTAINER:-norva-db\}"/);
  assert.match(installer, /preinstall-schema\.dump/);
  assert.match(installer, /preinstall-control-data\.dump/);
  assert.match(installer, /20260825012308_provider_access_rollout_observation_gate_v1\.sql/);
  assert.match(installer, /20260825012611_provider_access_analytics_delivered_state_fix_v1\.sql/);
  assert.match(installer, /rollout\\toff\\t2\\t0/);
  assert.match(installer, /flags\\t9\\t0/);
  assert.match(installer, /observation_rows\\t0/);
  assert.match(installer, /permission denied for table cloud_provider_access_rollout/);
  assert.match(installer, /RESUME_POSTINSTALL_VALIDATION/);
  assert.match(installer, /resume-current-state\.tsv/);
  assert.match(installer, /sha256sum -c/);
  assert.match(installer, /env DB_CONTAINER="\$DB_CONTAINER" bash/);
  assert.match(installer, /status=INSTALLED_DORMANT/);
  assert.match(installer, /INSTALL_PROVIDER_ACCESS_OBSERVATION_GATE_DORMANT/);
  assert.doesNotMatch(installer, /SET_PROVIDER_ACCESS_STAGE_internal/);
});
