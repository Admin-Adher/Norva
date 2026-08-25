const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const script = fs.readFileSync(path.join(
  __dirname, '..', 'ops', 'hetzner', 'scripts',
  'run_provider_access_internal_canary_preflight.sh',
), 'utf8');

test('internal canary preflight is read-only, exact-production-bound and cache-gated', () => {
  assert.match(script, /DB_CONTAINER="\$\{DB_CONTAINER:-norva-db\}"/);
  assert.match(script, /if \[\[ "\$DB_CONTAINER" != 'norva-db' \]\]/);
  assert.match(script, /status=WAIT_CACHE_EPOCH_V2/);
  assert.match(script, /CACHE_COMPLETED" != 'true'/);
  assert.match(script, /status=READY_FOR_EXPLICIT_INTERNAL_CANARY/);
  assert.doesNotMatch(script, /\b(insert|update|delete|commit|set local role)\b/i);
});

test('internal canary preflight binds runtime, source, legal and durable-work invariants', () => {
  assert.match(script, /norva_active_catalog_refresh_contract_ready/);
  assert.match(script, /norva-active-catalog-refresh-worker/);
  assert.match(script, /HEARTBEAT_AGE_SECONDS" -gt 120/);
  assert.match(script, /ACTIVE_REFRESH_READY" != 'true'/);
  assert.match(script, /source\.sync_status='ready'/);
  assert.match(script, /norva_source_catalog_visible_internal/);
  assert.match(script, /legal_policy_reference=policy\.policy_reference/);
  assert.match(script, /cloud_source_credential_transition_jobs/);
  assert.match(script, /cloud_source_transitions/);
  assert.match(script, /provider_network_crons/);
  assert.match(script, /REFUSED_INTERNAL_CANARY_PREFLIGHT/);
});
