import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const edge = fs.readFileSync(new URL('../supabase/functions/norva-provider-access/index.ts', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../supabase/migrations/20260824120000_provider_access_cycles_detection_v1.sql', import.meta.url), 'utf8');
const scheduler = fs.readFileSync(new URL('../supabase/migrations/20260824120100_provider_access_detection_scheduler_v1.sql', import.meta.url), 'utf8');
const foundation = fs.readFileSync(new URL('../supabase/migrations/20260822220703_provider_access_lifecycle_foundation.sql', import.meta.url), 'utf8');

function section(start, end) {
  const from = edge.indexOf(start);
  const to = edge.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} section exists`);
  return edge.slice(from, to);
}

test('Provider Access has a dedicated service-mediated REST surface', () => {
  assert.match(edge, /parts\[3\] === "access"/);
  assert.match(edge, /kind: "access-cycles"/);
  assert.match(edge, /kind: "access-cycle"/);
  assert.match(edge, /req\.method === "GET" && match\.kind === "access"/);
  assert.match(edge, /req\.method === "POST" && match\.kind === "access-cycles"/);
  assert.match(edge, /req\.method === "PATCH" && match\.kind === "access-cycle"/);
  assert.match(edge, /req\.method === "DELETE" && match\.kind === "access-cycle"/);
});

test('Provider Access routes fail closed on their independent capability flag', () => {
  assert.match(edge, /ACCESS_FEATURE_FLAG = "provider_access_v1_enabled"/);
  assert.match(edge, /match\.resource === "access"[\s\S]*await requireAccessFeatureFlag\(\)/);
  assert.match(edge, /if \(req\.method !== "GET"\) requireContractVersion\(req\)/);
  assert.match(edge, /return !error && data === true/);
});

test('cycle create, update and end use only the durable PostgreSQL RPCs', () => {
  const block = section('async function getProviderAccess', '\nfunction normalizeAccessCycleBody');
  for (const rpc of [
    'norva_get_provider_access',
    'norva_create_provider_access_cycle',
    'norva_update_provider_access_cycle',
    'norva_end_provider_access_cycle',
  ]) assert.match(block, new RegExp(rpc));
  assert.doesNotMatch(block, /\.from\("cloud_source_access_cycles"\)|\.from\("cloud_source_provider_access"\)/);
  assert.doesNotMatch(block, /sync_status|catalog_version|auto_refresh/);
});

test('date updates require an access ETag and idempotency key', () => {
  const update = section('async function updateProviderAccessCycle', '\nasync function endProviderAccessCycle');
  assert.match(update, /requireIdempotencyKey\(req\)/);
  assert.match(update, /parseEntityTag\(req, "provider-access"\)/);
  assert.match(update, /p_expected_revision: expectedRevision/);
  assert.match(edge, /provider-access-rev-/);
});

test('cycle input is calendar-strict and cannot express a partial ambiguous edit', () => {
  const normalize = section('function normalizeAccessCycleBody', '\nfunction sanitizeProviderAccess');
  assert.match(normalize, /Object\.hasOwn\(body, field\)/);
  assert.match(normalize, /expiresOn < startedOn/);
  assert.match(edge, /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/);
  assert.match(edge, /parsed\.toISOString\(\)\.slice\(0, 10\) !== text/);
  assert.match(normalize, /DAY", "WEEK", "MONTH", "YEAR/);
});

test('public projection is allowlisted and excludes raw Xtream evidence', () => {
  const sanitize = section('function sanitizeProviderAccess', '\nfunction providerAccessTag');
  for (const field of ['sourceId', 'revision', 'status', 'startedOn', 'expiresOn', 'activeCycle', 'cycles']) {
    assert.match(sanitize, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(sanitize, /user_info|exp_date|active_cons|max_connections|password|username|config_ciphertext/);
});

test('automatic check is worker-only and drains the durable PostgreSQL queue', () => {
  const check = section('async function handleProviderAccessCheckDrain', '\nfunction canonicalJson');
  assert.match(check, /requireWorkerAuthorization\(req\)/);
  assert.match(check, /accessFeatureFlagEnabled\(\).*accessDetectionFeatureFlagEnabled\(\)/s);
  assert.match(check, /extractProviderAccessState\(await gatewayAccountInfo/);
  for (const rpc of [
    'norva_schedule_provider_access_checks',
    'norva_claim_provider_access_check_jobs',
    'norva_apply_claimed_provider_access_detection',
    'norva_fail_provider_access_check_job',
  ]) assert.equal((check.match(new RegExp(rpc, 'g')) ?? []).length, 1);
  assert.match(check, /p_expected_lease_sequence: job\.leaseSequence/);
  assert.doesNotMatch(check, /norva_apply_provider_access_detection/);
  assert.doesNotMatch(check, /console\.|JSON\.stringify\(.*account|user_info|exp_date|active_cons|max_connections/);
});

test('temporary provider errors persist a visible retryable decision, never a hide decision', () => {
  const check = section('async function handleProviderAccessCheckDrain', '\nfunction canonicalJson');
  assert.match(check, /status: "check_failed_temporary"/);
  assert.match(check, /hideEligible: false/);
  assert.match(check, /PROVIDER_CHECK_TEMPORARY_FAILURE/);
  assert.match(check, /p_retry_after_seconds: retryable \? retryDelaySeconds/);
});

test('scheduler fences every claim and commit and never installs cron implicitly', () => {
  assert.match(scheduler, /for update skip locked/i);
  assert.match(scheduler, /lease_sequence = job\.lease_sequence \+ 1/);
  assert.match(scheduler, /job\.lease_sequence is distinct from p_expected_lease_sequence/);
  assert.match(scheduler, /v_job\.id::text \|\| ':lease:' \|\| p_expected_lease_sequence::text/);
  assert.match(scheduler, /create or replace function public\.norva_install_provider_access_check_cron/);
  assert.equal((scheduler.match(/select public\.norva_install_provider_access_check_cron\s*\(/gi) ?? []).length, 0);
});

test('database cycle mutations are CAS/idempotent and never touch source sync state', () => {
  for (const fn of [
    'norva_create_provider_access_cycle',
    'norva_update_provider_access_cycle',
    'norva_end_provider_access_cycle',
  ]) assert.match(migration, new RegExp(`create or replace function public\\.${fn}`));
  assert.match(foundation, /cloud_source_access_cycles_one_active_uidx/);
  assert.match(migration, /provider access revision CAS failed/);
  assert.match(migration, /provider access idempotency key reused/);
  assert.doesNotMatch(migration, /update public\.cloud_sources[\s\S]*sync_status/i);
});

test('database visibility policy hides only confirmed states and preserves hidden authority on ambiguity', () => {
  const applyStart = migration.indexOf('create or replace function public.norva_apply_provider_access_detection');
  assert.ok(applyStart >= 0);
  const apply = migration.slice(applyStart);
  assert.match(apply, /v_hide_eligible and v_status not in \('expired_confirmed','access_unavailable_confirmed'\)/);
  assert.match(apply, /A timeout, contradiction, unknown response or user-entered date is not/);
  assert.match(apply, /v_new_hidden_at := null/);
  assert.match(apply, /provider_access_hidden/);
  assert.match(apply, /provider_access_restored/);
});

test('new RPCs remain service-role only', () => {
  assert.match(migration, /revoke all on function public\.norva_get_provider_access\(uuid, uuid\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.norva_apply_provider_access_detection[\s\S]*to service_role/);
  assert.doesNotMatch(migration, /grant execute on function public\.norva_(?:create|update|end|apply)_provider_access[^;]+to authenticated/i);
});
