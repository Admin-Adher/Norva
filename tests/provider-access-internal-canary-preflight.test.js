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
  assert.match(script, /norva_catalog_background_owner_baseline_current/);
  assert.match(script, /cloud_catalog_background_owner_build_jobs/);
  assert.match(script, /cloud_catalog_background_mode_checkpoints/);
  assert.match(script, /CURRENT_OWNER_BASELINES" != "\$OWNER_POPULATION/);
  assert.match(script, /NONTERMINAL_OWNER_JOBS" != '0'/);
  assert.match(script, /DEAD_OWNER_JOBS" != '0'/);
  assert.match(script, /provider_network_crons/);
  assert.match(script, /REFUSED_INTERNAL_CANARY_PREFLIGHT/);
});

test('catalog background owner operator is read-only by default and bounded when confirmed', () => {
  const ownerWorker = fs.readFileSync(path.join(
    __dirname, '..', 'ops', 'hetzner', 'scripts',
    'run_catalog_background_owner_workflow.sh',
  ), 'utf8');
  assert.match(ownerWorker, /ACTION="\$\{1:-preflight\}"/);
  assert.match(ownerWorker, /CONFIRM_DISPOSABLE_PROOF_DB/);
  assert.match(ownerWorker, /ALLOW_NORVA_DISPOSABLE_CLONE/);
  assert.match(ownerWorker, /norva-phase123-prod-clone-\[a-z0-9-\]\+-db/);
  assert.match(ownerWorker, /status=WAIT_OWNER_WORKFLOW/);
  assert.match(ownerWorker, /DRAIN_CATALOG_BACKGROUND_OWNER_WORKFLOW/);
  assert.match(ownerWorker, /MAX_SLICES < 1 \|\| MAX_SLICES > 500/);
  assert.match(ownerWorker, /SLICE_LIMIT < 100 \|\| SLICE_LIMIT > 5000/);
  assert.match(ownerWorker, /norva_claim_catalog_background_owner_build_jobs/);
  assert.match(ownerWorker, /norva_run_catalog_background_owner_build_job_slice/);
  assert.match(ownerWorker, /norva_checkpoint_catalog_background_owner_build_job/);
  const preflightBody = ownerWorker.slice(0, ownerWorker.indexOf(
    'if [[ "${CONFIRM_CATALOG_BACKGROUND_OWNER_WORKFLOW:-}"',
  ));
  assert.doesNotMatch(preflightBody, /norva_(claim|run|checkpoint)_catalog_background_owner/);
});
