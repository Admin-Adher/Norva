const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260721113000_billing_funnel_observability.sql'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public/js/pages/AdminPage.js'), 'utf8');

test('the server funnel separates order authorization from entitlement activation', () => {
  assert.match(migration, /'order_authorized'/);
  assert.match(migration, /'entitlement_active'/);
  assert.match(migration, /from auth\.users/);
  assert.match(migration, /finalized_at is not null/);
  assert.match(migration, /_norva,projection_applied/);
  assert.doesNotMatch(migration, /coalesce\(trial_consumed_at, last_event_at/);
});

test('conversion, renewal and win-back include the live Revolut rail', () => {
  assert.match(migration, /cloud_revolut_billing_attempts[\s\S]*kind = 'first_charge'[\s\S]*applied_at is not null/);
  assert.match(migration, /cloud_revolut_billing_attempts[\s\S]*kind = 'renewal'[\s\S]*applied_at is not null/);
  assert.match(migration, /kind = 'resubscribe'[\s\S]*finalized_at is not null/);
  assert.match(migration, /cloud_billing_ledger[\s\S]*google_play[\s\S]*apple_app_store/);
});

test('the first captured store renewal after a trial is conversion-only', () => {
  assert.match(migration, /post_trial_captured_payments/);
  assert.match(migration, /row_number\(\) over \([\s\S]*partition by l\.user_id/);
  assert.match(migration, /first_post_trial_capture[\s\S]*capture_rank = 1/);
  assert.match(migration, /trial_conversion_events[\s\S]*first_capture\.pi_id = l\.pi_id/);
  assert.match(migration, /from public\.cloud_billing_ledger ledger[\s\S]*not exists \([\s\S]*first_post_trial_capture/);

  const captures = [
    { id: 'trial-conversion', kind: 'renewal', at: 1 },
    { id: 'real-renewal', kind: 'renewal', at: 2 },
  ];
  const firstCapture = [...captures].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))[0];
  const conversions = captures.filter((capture) => capture.id === firstCapture.id);
  const renewals = captures.filter((capture) => capture.kind === 'renewal' && capture.id !== firstCapture.id);
  assert.deepEqual(conversions.map((capture) => capture.id), ['trial-conversion']);
  assert.deepEqual(renewals.map((capture) => capture.id), ['real-renewal']);

  const crossRailCaptures = [
    { id: 'web-conversion', provider: 'revolut', kind: 'first_charge', at: 1 },
    { id: 'later-store-renewal', provider: 'apple_app_store', kind: 'renewal', at: 2 },
  ];
  const firstCrossRailCapture = [...crossRailCaptures]
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))[0];
  assert.equal(firstCrossRailCapture.id, 'web-conversion');
  assert.equal(crossRailCaptures[1].id, 'later-store-renewal');
});

test('internal accounts are excluded and the obsolete save-offer stage is gone', () => {
  assert.match(migration, /admin_internal_accounts/);
  assert.doesNotMatch(migration, /'save'/);
  assert.match(migration, /select user_id, 'checkout_open', min\(at\)/);
  assert.match(migration, /revoke all on public\.norva_funnel_daily from public, anon, authenticated/);
  assert.match(migration, /grant select on public\.norva_funnel_daily to service_role/);
});

test('Admin displays the authoritative conversion stages in journey order', () => {
  const order = admin.match(/const FUNNEL_ORDER = \[([^\]]+)\]/)?.[1] || '';
  for (const stage of ['account_created', 'checkout_open', 'order_authorized', 'entitlement_active', 'first_play']) {
    assert.match(order, new RegExp(`'${stage}'`));
  }
  assert.ok(order.indexOf('checkout_open') < order.indexOf('order_authorized'));
  assert.ok(order.indexOf('order_authorized') < order.indexOf('entitlement_active'));
});
