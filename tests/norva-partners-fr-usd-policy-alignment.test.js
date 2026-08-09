'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260809190000_partners_fr_pilot_usd_policy_alignment.sql',
  ),
  'utf8',
);

test('France pilot currency alignment is scoped to the closed P0 policy', () => {
  assert.match(migration, /version_key = 'individual-global-p0-v2'/);
  assert.match(migration, /program\.threshold_reference_currency = 'USD'/);
  assert.match(migration, /program\.threshold_reference_minor = 1000/);
  assert.match(migration, /policy\.country_code = 'FR'/);
  assert.match(migration, /policy\.subdivision_code is null/);
  assert.match(migration, /if v_policy\.individual_available then/);
  assert.match(migration, /v_policy\.payout_currencies <> array\['EUR'\]::text\[\]/);
});

test('France pilot currency alignment fails closed once assigned', () => {
  assert.match(
    migration,
    /account\.country_policy_id = v_policy\.id[\s\S]*account\.status <> 'closed'/,
  );
  assert.match(
    migration,
    /requires a new version/,
  );
  assert.match(
    migration,
    /affiliate_private\.payout_currencies_covered\([\s\S]*array\['USD'\]::text\[\]/,
  );
  assert.match(migration, /currency\.currency_code = 'USD'/);
  assert.match(migration, /currency\.exponent = 2/);
  assert.match(migration, /currency\.status = 'active'/);
});

test('France pilot currency alignment is atomic and auditable', () => {
  assert.match(
    migration,
    /set[\s\S]*payout_currencies = array\['USD'\]::text\[[\s\S]*get diagnostics v_updated = row_count/,
  );
  assert.match(migration, /if v_updated <> 1 then/);
  assert.match(migration, /'country_policy_currency_aligned'/);
  assert.match(migration, /before_state/);
  assert.match(migration, /after_state/);
  assert.doesNotMatch(migration, /affiliate_release_gates[\s\S]*satisfied = true/);
  assert.doesNotMatch(migration, /admin_feature_flags[\s\S]*enabled = true/);
});
