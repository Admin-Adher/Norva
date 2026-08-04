const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '20260802101512_partners_admin_p0_security.sql',
  ),
  'utf8',
);
const revolutMigration = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '20260730173351_partners_revolut_manual_hybrid.sql',
  ),
  'utf8',
);
const sensitiveMutationMigration = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '20260802135202_partners_sensitive_mutations_aal2.sql',
  ),
  'utf8',
);
const adminFoundationMigration = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '20260729201447_partners_tv_admin_analytics.sql',
  ),
  'utf8',
);
const frictionlessReleaseMigration = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '20260804174000_partners_frictionless_release_controls.sql',
  ),
  'utf8',
);

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('shared Partners reads authorize Support, Risk or Finance operators', () => {
  const overview = section(
    migration,
    'create or replace function affiliate_private.admin_partners_overview()',
    'create or replace function affiliate_private.admin_partners_configuration()',
  );
  const configuration = section(
    migration,
    'create or replace function affiliate_private.admin_partners_configuration()',
    '-- ---------------------------------------------------------------------------\n-- AAL2 boundary',
  );

  for (const source of [overview, configuration]) {
    assert.match(source, /partners_has_capability\('support'\)/);
    assert.match(source, /partners_has_capability\('risk'\)/);
    assert.match(source, /partners_has_capability\('finance'\)/);
    assert.match(source, /Partners Admin capability is required/);
    assert.doesNotMatch(source, /partners_require_capability\('support'\)/);
  }

  const authoritativeConfiguration = section(
    frictionlessReleaseMigration,
    'create or replace function affiliate_private.admin_partners_configuration()',
    'create or replace function public.admin_partners_configuration()',
  );
  [
    ['partners_enabled', 1],
    ['partners_invite_only', 2],
    ['partners_cash_pilot_allowlist_only', 3],
    ['partners_earnings_enabled', 4],
    ['partners_credit_redemptions_enabled', 5],
    ['partners_shadow_mode', 6],
    ['partners_payouts_live', 7],
    ['partners_tv_relay_enabled', 8],
    ['partners_revolut_api_enabled', 9],
  ].forEach(([key, position]) => {
    assert.match(
      authoritativeConfiguration,
      new RegExp(`\\('${key}'::text, ${position}\\)`),
    );
  });
});

test('capability and programme mutations enforce AAL2 at the private boundary', () => {
  const helper = section(
    migration,
    'create or replace function affiliate_private.partners_require_aal2(',
    'alter function affiliate_private.admin_partners_capability_set(',
  );
  const boundary = section(
    sensitiveMutationMigration,
    'create or replace function affiliate_private.admin_partners_capability_set(',
    '-- ---------------------------------------------------------------------------\n-- Version-pin the existing payout implementations',
  );

  assert.match(helper, /auth\.jwt\(\) ->> 'aal'/);
  assert.match(helper, /<> 'aal2'/);
  assert.match(helper, /using errcode = '42501'/);
  assert.match(
    boundary,
    /admin_partners_capability_set[\s\S]*partners_require_aal2\([\s\S]*Partners capability mutation/,
  );
  assert.match(
    boundary,
    /admin_partners_program_create[\s\S]*partners_require_aal2\([\s\S]*Partners program mutation/,
  );
  assert.match(
    boundary,
    /admin_partners_program_activate[\s\S]*partners_require_aal2\([\s\S]*Partners program mutation/,
  );

  const privileges = sensitiveMutationMigration.slice(
    sensitiveMutationMigration.indexOf('-- Explicit privilege matrix:'),
  );
  assert.match(
    privileges,
    /admin_partners_payout_cycle_create_pre_aal2_20260802[\s\S]*admin_partners_payout_cycle_approve_pre_aal2_20260802[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.match(
    privileges,
    /grant execute on function[\s\S]*public\.admin_partners_capability_set[\s\S]*public\.admin_partners_program_create[\s\S]*public\.admin_partners_program_activate[\s\S]*public\.admin_partners_payout_cycle_create[\s\S]*public\.admin_partners_payout_cycle_approve[\s\S]*to authenticated/,
  );
});

test('membership privacy activation patches the version-pinned implementation behind AAL2', () => {
  const activationPatch = section(
    frictionlessReleaseMigration,
    'do $partners_program_activation_membership_privacy_gate$',
    '$partners_program_activation_membership_privacy_gate$;',
  );
  const activationWrapper = section(
    sensitiveMutationMigration,
    'create or replace function affiliate_private.admin_partners_program_activate(',
    '-- ---------------------------------------------------------------------------\n-- Version-pin the existing payout implementations',
  );

  assert.match(
    activationPatch,
    /admin_partners_program_activate_pre_aal2_20260802\(text,text,text\)/,
  );
  assert.match(
    activationPatch,
    /programme activation AAL2 wrapper contract drifted/,
  );
  assert.match(
    activationPatch,
    /membership_privacy_approved/,
  );
  assert.match(
    activationWrapper,
    /partners_require_aal2\([\s\S]*admin_partners_program_activate_pre_aal2_20260802\(/,
  );
});

test('payout cycle RPCs require AAL2 before both dry and live execution', () => {
  const createWrapper = section(
    sensitiveMutationMigration,
    'create function affiliate_private.admin_partners_payout_cycle_create(',
    'alter function affiliate_private.admin_partners_payout_cycle_approve(',
  );
  const approveWrapper = section(
    sensitiveMutationMigration,
    'create function affiliate_private.admin_partners_payout_cycle_approve(',
    '-- Renaming keeps the old function OIDs.',
  );

  assert.match(
    createWrapper,
    /partners_require_aal2\([\s\S]*Partners payout cycle creation/,
  );
  assert.match(
    createWrapper,
    /admin_partners_payout_cycle_create_pre_aal2_20260802\(/,
  );
  assert.doesNotMatch(createWrapper, /if p_live_execution/);
  assert.match(
    approveWrapper,
    /partners_require_aal2\([\s\S]*Partners payout cycle approval/,
  );
  assert.match(
    approveWrapper,
    /admin_partners_payout_cycle_approve_pre_aal2_20260802\(/,
  );
});

test('payout AAL2 wrappers preserve live trigger defenses and maker-checker', () => {
  const promotion = section(
    migration,
    'affiliate_private.guard_partners_payout_live_promotion_aal2()',
    '-- ---------------------------------------------------------------------------\n-- Explicit privilege matrix.',
  );

  assert.match(
    promotion,
    /old\.live_execution is false[\s\S]*new\.live_execution is true/,
  );
  assert.match(promotion, /live payout cycle promotion requires AAL2/);
  assert.match(promotion, /before update of live_execution/);
  assert.doesNotMatch(promotion, /p_live_execution|:DRY|status = 'approved'/);

  const existingGuard = section(
    revolutMigration,
    'affiliate_private.guard_revolut_live_payout_cycle()',
    'do $revolut_manual_preflight$',
  );
  assert.match(existingGuard, /live payout cycle creation requires AAL2/);
  assert.match(existingGuard, /live payout cycle approval requires AAL2/);

  const approvalImplementation = section(
    adminFoundationMigration,
    'affiliate_private.admin_partners_payout_cycle_approve(',
    'create or replace function affiliate_private.admin_partners_risk_queue(',
  );
  assert.match(
    approvalImplementation,
    /v_actor = coalesce\([\s\S]*v_cycle\.live_promoted_by_pseudonym,[\s\S]*v_cycle\.created_by_pseudonym/,
  );
  assert.match(
    approvalImplementation,
    /live payout approval controls are incomplete/,
  );
});
