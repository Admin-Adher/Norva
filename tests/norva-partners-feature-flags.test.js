const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migrationDir = path.join(root, 'supabase', 'migrations');
const migrations = fs.readdirSync(migrationDir)
  .filter((name) => /^\d+_norva_partners_foundation\.sql$/.test(name));

assert.equal(
  migrations.length,
  1,
  'expected exactly one generated Norva Partners foundation migration',
);

const migration = fs.readFileSync(
  path.join(migrationDir, migrations[0]),
  'utf8',
).replace(/\r\n/g, '\n');
const adminMigration = fs.readFileSync(
  path.join(
    migrationDir,
    '20260729201447_partners_tv_admin_analytics.sql',
  ),
  'utf8',
).replace(/\r\n/g, '\n');
const releaseGateAal2Migration = fs.readFileSync(
  path.join(
    migrationDir,
    '20260803204442_partners_release_gate_aal2.sql',
  ),
  'utf8',
).replace(/\r\n/g, '\n');
const revolutMigration = fs.readFileSync(
  path.join(
    migrationDir,
    '20260730173351_partners_revolut_manual_hybrid.sql',
  ),
  'utf8',
).replace(/\r\n/g, '\n');
const frictionlessMembershipMigration = fs.readFileSync(
  path.join(
    migrationDir,
    '20260804173000_partners_frictionless_membership_credits.sql',
  ),
  'utf8',
).replace(/\r\n/g, '\n');
const frictionlessReleaseMigration = fs.readFileSync(
  path.join(
    migrationDir,
    '20260804174000_partners_frictionless_release_controls.sql',
  ),
  'utf8',
).replace(/\r\n/g, '\n');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

const managedFlags = [
  'partners_enabled',
  'partners_invite_only',
  'partners_earnings_enabled',
  'partners_credit_redemptions_enabled',
  'partners_shadow_mode',
  'partners_payouts_live',
  'partners_tv_relay_enabled',
  'partners_revolut_api_enabled',
];

test('all eight managed Partners flags are installed fail-closed', () => {
  const seedSources = [
    migration,
    revolutMigration,
    frictionlessMembershipMigration,
  ];

  for (const key of managedFlags) {
    assert.ok(
      seedSources.some((source) => new RegExp(
        `'${key}'\\s*,\\s*false`,
        'i',
      ).test(source)),
      `${key} must start disabled`,
    );
  }

  const helper = section(
    frictionlessReleaseMigration,
    'create or replace function affiliate_private.is_managed_partners_flag(',
    'revoke all on function',
  );
  for (const key of managedFlags) assert.match(helper, new RegExp(`'${key}'`));
});

test('generic feature flag CRUD cannot mutate or delete managed flags', () => {
  const set = section(
    migration,
    'create or replace function public.admin_flag_set(',
    'create or replace function public.admin_flag_create(',
  );
  const create = section(
    migration,
    'create or replace function public.admin_flag_create(',
    'create or replace function public.admin_flag_delete(',
  );
  const remove = section(
    migration,
    'create or replace function public.admin_flag_delete(',
    'revoke all on function public.admin_flag_set',
  );

  for (const body of [set, create, remove]) {
    assert.match(body, /affiliate_private\.is_managed_partners_flag/);
    assert.match(body, /raise exception 'managed Partners flag/i);
    assert.match(body, /if not public\.is_admin\(\)/);
    assert.match(body, /security definer[\s\S]*set search_path = ''/i);
  }

  const guard = section(
    migration,
    'create or replace function affiliate_private.guard_managed_partners_flags()',
    'drop trigger if exists affiliate_events_append_only',
  );
  assert.match(
    guard,
    /pg_has_role\(current_user, v_table_owner, 'MEMBER'\)/,
  );
  assert.match(guard, /current_setting\('norva\.partners_control', true\)/);
  assert.match(
    migration,
    /create trigger admin_feature_flags_partners_guard[\s\S]*before insert or update or delete on public\.admin_feature_flags/,
  );
});

test('one serialized admin RPC owns flags, gates and pilot allowlist', () => {
  const rpc = section(
    migration,
    'create or replace function public.admin_partners_control(',
    'revoke all on function public.admin_partners_control(',
  );

  assert.match(rpc, /if not public\.is_admin\(\)/);
  assert.match(rpc, /auth\.uid\(\)/);
  assert.match(
    rpc,
    /affiliate_private\.partners_require_control_access\(/,
  );
  assert.match(rpc, /length\(v_justification\) not between 12 and 1000/);
  assert.match(rpc, /pg_advisory_xact_lock/);
  assert.match(rpc, /set_flag', 'set_gate', 'set_allowlist/);
  assert.match(rpc, /for update/);
  assert.match(rpc, /affiliate_private\.release_gates_satisfied/);
  assert.match(
    rpc,
    /set_config\([\s\S]*'norva\.partners_control'[\s\S]*'admin_partners_control'/,
  );
  assert.match(rpc, /exactly one active individual program is required/);
  assert.match(rpc, /the pilot allowlist is empty/);
  assert.match(rpc, /insert into affiliate_private\.affiliate_events/);
  assert.ok(
    (rpc.match(/insert into affiliate_private\.affiliate_events/g) || []).length >= 3,
    'every mutation family must append its own audit event',
  );
  assert.doesNotMatch(rpc, /raw_user_meta_data|user_metadata/i);

  const activation = section(
    rpc,
    "if p_enabled and v_key = 'partners_enabled' then",
    "elsif p_enabled and v_key = 'partners_shadow_mode' then",
  );
  for (const gate of [
    'legal_and_tax_approved',
    'privacy_approved',
    'individual_verification_coverage_confirmed',
    'individual_payout_coverage_confirmed',
    'country_policy_approved',
  ]) {
    assert.match(activation, new RegExp(`'${gate}'`), gate);
  }
  assert.match(
    activation,
    /affiliate_private\.payout_currencies_covered\([\s\S]*pv\.payout_thresholds,[\s\S]*cp\.payout_currencies/,
  );
  assert.match(
    activation,
    /an available country policy lacks payout coverage/,
  );

  const gateRevocation = section(
    rpc,
    "if v_action = 'set_gate' then",
    'if p_subject_user_id is null or p_enabled is null then',
  );
  assert.match(
    gateRevocation,
    /array\[[\s\S]*'legal_and_tax_approved',[\s\S]*'privacy_approved',[\s\S]*'individual_verification_coverage_confirmed',[\s\S]*'individual_payout_coverage_confirmed',[\s\S]*'country_policy_approved'[\s\S]*where f\.key = 'partners_enabled'/,
  );

  assert.match(
    migration,
    /revoke all on function public\.admin_partners_control\([\s\S]*\) from public, anon, authenticated;/,
  );
  assert.match(
    migration,
    /grant execute on function public\.admin_partners_control\([\s\S]*\) to authenticated;/,
  );
});

test('Partners controls use the exact delegated and server release mapping', () => {
  const mapping = section(
    adminMigration,
    'create or replace function\naffiliate_private.partners_require_control_access(',
    'create or replace function affiliate_private.partners_require_capability(',
  );
  assert.match(mapping, /partners_is_release_manager\(\)/);
  assert.match(mapping, /partners_has_capability\('support'\)/);
  assert.match(mapping, /partners_has_capability\('risk'\)/);
  assert.match(mapping, /partners_has_capability\('finance'\)/);
  assert.match(
    mapping,
    /v_key = 'partners_payouts_live'[\s\S]*v_finance and v_release/,
  );
  assert.match(
    mapping,
    /v_key = 'partners_shadow_mode'[\s\S]*v_allowed := v_finance/,
  );
  assert.match(
    mapping,
    /v_key = 'general_release_approved'[\s\S]*v_allowed := v_release/,
  );
  assert.match(
    mapping,
    /when p_enabled is true then v_risk[\s\S]*when p_enabled is false then v_support or v_risk/,
  );
  assert.match(
    mapping,
    /raise exception 'Partners control capability is required'/,
  );
  assert.doesNotMatch(mapping, /raw_user_meta_data|user_metadata/i);

  const capabilities = section(
    adminMigration,
    'create or replace function affiliate_private.admin_partners_capabilities()',
    'create or replace function affiliate_private.admin_partners_capability_set(',
  );
  assert.match(capabilities, /'can_manage_release'/);
});

test('every release-gate activation requires AAL2 without changing control ownership', () => {
  assert.match(
    releaseGateAal2Migration,
    /create or replace function\s+affiliate_private\.guard_partners_release_gate_activation_aal2\(\)/i,
  );
  assert.match(
    releaseGateAal2Migration,
    /old\.satisfied is false[\s\S]*new\.satisfied is true[\s\S]*auth\.uid\(\) is not null/i,
  );
  assert.match(
    releaseGateAal2Migration,
    /affiliate_private\.partners_require_aal2\(\s*'Partners release gate activation'\s*\)/i,
  );
  assert.match(
    releaseGateAal2Migration,
    /create trigger affiliate_release_gates_activation_aal2\s+before update of satisfied\s+on affiliate_private\.affiliate_release_gates/i,
  );
  assert.match(
    releaseGateAal2Migration,
    /revoke all on function\s+affiliate_private\.guard_partners_release_gate_activation_aal2\(\)\s+from public, anon, authenticated, service_role;/i,
  );
  assert.doesNotMatch(
    releaseGateAal2Migration,
    /partners_require_control_access|admin_feature_flags|partners_(?:enabled|invite_only|shadow_mode|payouts_live)/i,
    'the additive AAL2 guard must not redefine capabilities or feature flags',
  );
});

test('pilot allowlist is independent from admin roles and starts empty', () => {
  const table = section(
    migration,
    'create table affiliate_private.affiliate_pilot_allowlist (',
    'create index affiliate_pilot_allowlist_active_idx',
  );
  assert.match(table, /user_id\s+uuid primary key[\s\S]*references auth\.users/);
  assert.match(table, /status in \('active', 'revoked'\)/);
  assert.doesNotMatch(table, /\brole\b|app_metadata|is_admin/i);
  const inserts = migration.match(
    /insert into affiliate_private\.affiliate_pilot_allowlist/gi,
  ) || [];
  assert.equal(
    inserts.length,
    1,
    'allowlist must have no seed; its only insert belongs to the audited RPC',
  );
  const rpc = section(
    migration,
    'create or replace function public.admin_partners_control(',
    'revoke all on function public.admin_partners_control(',
  );
  assert.match(rpc, /insert into affiliate_private\.affiliate_pilot_allowlist/);
});

test('release gates are explicit, false by default and fail closed', () => {
  const table = section(
    migration,
    'create table affiliate_private.affiliate_release_gates (',
    'create table affiliate_private.affiliate_events (',
  );
  assert.match(table, /satisfied\s+boolean not null default false/);
  assert.match(table, /check \(satisfied = \(satisfied_at is not null\)\)/);

  for (const key of [
    'legal_and_tax_approved',
    'privacy_approved',
    'individual_verification_coverage_confirmed',
    'individual_payout_coverage_confirmed',
    'country_policy_approved',
    'financial_data_contract_approved',
    'shadow_reconciliation_clean',
    'backup_restore_verified',
    'tv_relay_security_verified',
    'general_release_approved',
  ]) {
    assert.match(table, new RegExp(`'${key}'`));
  }
});
