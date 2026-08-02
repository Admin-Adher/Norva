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

  assert.match(
    configuration,
    /\('partners_revolut_api_enabled'::text, 6\)/,
  );
});

test('capability and programme mutations enforce AAL2 at the private boundary', () => {
  const boundary = section(
    migration,
    'create or replace function affiliate_private.partners_require_aal2(',
    '-- ---------------------------------------------------------------------------\n-- Payout AAL2 audit',
  );

  assert.match(boundary, /auth\.jwt\(\) ->> 'aal'/);
  assert.match(boundary, /<> 'aal2'/);
  assert.match(boundary, /using errcode = '42501'/);
  assert.match(
    boundary,
    /admin_partners_capability_set[\s\S]*Partners capability mutation/,
  );
  assert.match(
    boundary,
    /admin_partners_program_create[\s\S]*Partners program mutation/,
  );
  assert.match(
    boundary,
    /admin_partners_program_activate[\s\S]*Partners program mutation/,
  );
  assert.match(boundary, /security invoker/g);

  const privileges = migration.slice(
    migration.indexOf('-- Explicit privilege matrix.'),
  );
  assert.match(
    privileges,
    /admin_partners_capability_set_pre_aal2_20260802[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.match(
    privileges,
    /grant execute on function[\s\S]*public\.admin_partners_capability_set[\s\S]*public\.admin_partners_program_create[\s\S]*public\.admin_partners_program_activate[\s\S]*to authenticated/,
  );
});

test('live payout AAL2 guards cover create, promotion and approval without dry-run checks', () => {
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
});
