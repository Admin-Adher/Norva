const test = require('node:test');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const hour = 3_600_000;
const now = Date.parse('2026-07-21T12:00:00Z');
const iso = (delta) => new Date(now + delta).toISOString();

async function modules() {
  const evaluator = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/entitlement-evaluator.mjs')).href);
  const billing = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/billing-policy.mjs')).href);
  return { ...evaluator, ...billing };
}

test('subscription state machine covers trial, active, grace, cancellation and expiry', async () => {
  const { evaluateEntitlementProjection: evaluate } = await modules();
  const opts = { now, billingMode: 'revenuecat', failOpenHours: 72 };
  assert.deepEqual(evaluate(null, opts), { kind: 'soft', reason: 'subscription_required', failOpen: false });
  assert.equal(evaluate({ status: 'trialing', trial_ends_at: iso(hour) }, opts).kind, 'allow');
  assert.equal(evaluate({ status: 'trialing', trial_ends_at: iso(-hour) }, opts).reason, 'trial_expired');
  assert.deepEqual(evaluate({ status: 'trialing' }, opts), {
    kind: 'soft', reason: 'billing_unverified', failOpen: false
  });
  assert.equal(evaluate({ status: 'active', current_period_end: iso(hour) }, opts).reason, 'active');
  assert.equal(evaluate({ status: 'active', current_period_end: iso(-hour), fail_open_until: iso(hour) }, opts).reason, 'billing_grace');
  assert.equal(evaluate({ status: 'active', current_period_end: iso(-hour), last_verified_at: iso(-hour) }, opts).reason, 'billing_recently_verified');
  assert.equal(evaluate({ status: 'active', current_period_end: iso(-100 * hour), last_verified_at: iso(-100 * hour) }, opts).kind, 'soft');
  assert.equal(evaluate({ status: 'cancelled_at_period_end', current_period_end: iso(hour) }, opts).kind, 'allow');
  assert.equal(evaluate({ status: 'cancelled_at_period_end', current_period_end: iso(-hour) }, opts).kind, 'soft');
  assert.equal(evaluate({ status: 'cancelled_at_period_end' }, opts).reason, 'billing_unverified');
  assert.equal(evaluate({ status: 'active' }, opts).reason, 'billing_unverified');
  assert.equal(evaluate({ status: 'active', provider: 'system' }, opts).kind, 'allow');
  assert.equal(evaluate({ status: 'past_due', fail_open_until: iso(hour) }, opts).kind, 'allow');
  assert.equal(evaluate({ status: 'past_due', fail_open_until: iso(-hour), last_verified_at: iso(-100 * hour) }, opts).reason, 'billing_unverified');
  assert.equal(evaluate({ status: 'expired' }, opts).kind, 'soft');
});

test('legacy mode hard-blocks soft expiry and hard blocks stay hard in every mode', async () => {
  const { evaluateEntitlementProjection: evaluate } = await modules();
  assert.equal(evaluate(null, { now, billingMode: 'legacy' }).kind, 'block');
  for (const status of ['revoked', 'refunded', 'fraud']) {
    assert.deepEqual(evaluate({ status }, { now, billingMode: 'revenuecat' }), {
      kind: 'block', reason: status, failOpen: false
    });
  }
});

test('admin bypass applies to free browse but never to fraud/refund/revocation', async () => {
  const { shouldAdminBypass } = await modules();
  assert.equal(shouldAdminBypass({ allowed: true, planCode: 'free', reason: 'free_subscription_required' }), true);
  assert.equal(shouldAdminBypass({ allowed: false, planCode: 'none', reason: 'subscription_required' }), true);
  for (const reason of ['revoked', 'refunded', 'fraud']) {
    assert.equal(shouldAdminBypass({ allowed: false, planCode: 'none', reason }), false);
  }
});

test('free browse cannot retain premium features through the projection plan code', () => {
  const source = fs.readFileSync(
    path.join(root, 'supabase/functions/_shared/entitlements.ts'),
    'utf8',
  );
  const start = source.indexOf('export function realPlanCode');
  const end = source.indexOf('export function planFeatureEntitled', start);
  const block = source.slice(start, end);
  assert.match(block, /decision\.planCode === "free"/);
  assert.match(block, /replace\(\/\^free_\//);
  assert.match(source, /return \{ \.\.\.record, \.\.\.planDefaults \}/);
});
