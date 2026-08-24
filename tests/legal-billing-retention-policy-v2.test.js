'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n?/g, '\n');
const migration = read('supabase/migrations/20260824172000_legal_billing_retention_policy_v2.sql');
const smoke = read('supabase/tests/account_deletion_legal_billing_retention_smoke.sql');
const race = read('ops/hetzner/scripts/run_legal_billing_policy_v2_race.sh');
const accessMigration = read('supabase/migrations/20260824173000_legal_billing_archive_audited_access_v1.sql');
const accessSmoke = read('supabase/tests/legal_billing_archive_access_smoke.sql');

test('legal retention v2 is calculated from a configured fiscal close', () => {
  assert.match(migration, /norva_legal_billing_fiscal_close/);
  assert.match(migration, /norva_legal_billing_retention_until/);
  assert.match(migration, /v_close \+ pg_catalog\.make_interval\(years=>p_retention_years\)[\s\S]*interval '1 day'/);
  assert.match(migration, /retention_basis_date/);
  assert.match(smoke, /'2026-12-31 23:59:59\+00',10,12,31[\s\S]*'2037-01-01 00:00:00\+00'/);
  assert.match(smoke, /'2027-01-01 00:00:00\+00',10,12,31[\s\S]*'2038-01-01 00:00:00\+00'/);
});

test('policy configuration is service-only, versioned, hashed and append-only', () => {
  assert.match(migration, /norva_configure_legal_billing_archive_policy/);
  assert.match(migration, /pg_advisory_xact_lock\(1770317200\)/);
  assert.match(migration, /v_policy\.revision <> p_expected_revision/);
  assert.match(migration, /errcode='40001', detail='reason=stale'/);
  assert.match(migration, /norva_legal_billing_policy_config_hash/);
  assert.match(migration, /extensions\.digest[\s\S]*'sha256'/);
  assert.match(migration, /legal_billing_archive_policy_events/);
  assert.match(migration, /legal billing policy events are append-only/);
  assert.match(migration, /revoke all on table public\.legal_billing_archive_policy_events[\s\S]*service_role/);
  assert.match(migration, /grant execute on function public\.norva_configure_legal_billing_archive_policy[\s\S]*to service_role/);
});

test('account deletion refuses missing, legacy or altered policy provenance', () => {
  assert.match(migration, /policy v2 is not configured/);
  assert.match(migration, /policy integrity check failed/);
  assert.match(migration, /legacy legal archive provenance requires reviewed remediation/);
  assert.match(migration, /retention_policy_revision/);
  assert.match(migration, /retention_policy_reference/);
  assert.match(migration, /retention_policy_config_hash/);
  assert.match(migration, /retention_calculation_version/);
  assert.match(smoke, /v_integrity_refusal/);
});

test('the real two-session proof has one CAS winner and one explicit STALE loser', () => {
  assert.match(race, /norva-phase3-proof-\*-db/);
  assert.match(race, /pid_a=\$!/);
  assert.match(race, /pid_b=\$!/);
  assert.match(race, /expected exactly one winner/);
  assert.match(race, /stale legal billing retention policy revision/);
  assert.match(race, /LEGAL_BILLING_POLICY_V2_RACE_PASS/);
});

test('archive reads require a dedicated grant, Admin, AAL2 and verified TOTP', () => {
  assert.match(accessMigration, /legal_billing_archive_access_grants/);
  assert.match(accessMigration, /not public\.is_admin\(\)/);
  assert.match(accessMigration, /auth\.jwt\(\)->>'aal',''\)<>'aal2'/);
  assert.match(accessMigration, /auth\.mfa_factors[\s\S]*factor_type='totp'[\s\S]*status='verified'/);
  assert.match(accessMigration, /legal archive reader grant required/);
  assert.match(accessSmoke, /v_aal1_denied/);
  assert.match(accessSmoke, /v_disabled_denied/);
});

test('archive access is exact, bounded, data-minimised and atomically audited', () => {
  assert.match(accessMigration, /p_lookup_kind not in \('source_ledger_id','provider_payment_id','order_id'\)/);
  assert.match(accessMigration, /limit 21/);
  assert.match(accessMigration, /filter \(where ordinal<=20\)/);
  assert.match(accessMigration, /norva-legal-billing-archive-lookup:v1:/);
  assert.match(accessMigration, /legal_billing_archive_access_events/);
  assert.match(accessMigration, /legal billing archive access audit is append-only/);
  assert.match(accessMigration, /revoke all on table public\.legal_billing_archive_access_grants[\s\S]*service_role/);
  assert.match(accessMigration, /grant execute on function public\.norva_read_legal_billing_archive[\s\S]*to authenticated/);
  assert.match(accessSmoke, /lookup_digest !~ '\^\[0-9a-f\]\{64\}\$'/);
});
