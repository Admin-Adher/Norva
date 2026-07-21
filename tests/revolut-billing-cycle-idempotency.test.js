const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const billingPath = 'supabase/functions/norva-revolut-billing/index.ts';
const migrationPath = 'supabase/migrations/20260721111000_revolut_billing_cycle_claims.sql';
const pendingPlanMigrationPath = 'supabase/migrations/20260721114000_revolut_pending_plan_changes.sql';

function executableOrderClassifier(source) {
  const match = source.match(/function classifyOrderState\(state: unknown\): ChargeOutcome \{([\s\S]*?)\n\}/);
  assert.ok(match, 'classifyOrderState source must remain extractable');
  const failures = new Set(['FAILED', 'CANCELLED', 'DECLINED', 'REVERSED', 'VOIDED', 'EXPIRED']);
  const pending = new Set([
    'PENDING', 'PROCESSING', 'AUTHORISED', 'AUTHORIZED',
    'AUTHORISATION_STARTED', 'AUTHORIZATION_STARTED',
    'AUTHORISATION_PASSED', 'AUTHORIZATION_PASSED',
    'CAPTURE_STARTED', 'CAPTURED',
  ]);
  const classify = new Function('state', 'ORDER_FAILURE_STATES', 'ORDER_PENDING_STATES', match[1]);
  return (state) => classify(state, failures, pending);
}

test('only a final COMPLETED Revolut order is classified as captured', () => {
  const classify = executableOrderClassifier(read(billingPath));
  assert.equal(classify('COMPLETED'), 'captured');
  for (const state of [
    'AUTHORISED', 'AUTHORIZED', 'AUTHORISATION_PASSED', 'AUTHORIZATION_PASSED',
    'CAPTURED', 'CAPTURE_STARTED', 'PROCESSING', 'PENDING',
  ]) assert.equal(classify(state), 'pending', state);
  for (const state of ['FAILED', 'CANCELLED', 'DECLINED', 'REVERSED', 'VOIDED', 'EXPIRED']) {
    assert.equal(classify(state), 'failed', state);
  }
  assert.equal(classify('mystery'), 'unknown');
});

test('billing claims an immutable cycle before every remote charge and resumes existing payments', () => {
  const source = read(billingPath);
  const chargeUser = source.slice(source.indexOf('async function chargeUser'), source.indexOf('function addHours'));
  assert.ok(chargeUser.indexOf('claimBillingCycle(') < chargeUser.indexOf('chargeSavedCard('));
  assert.match(source, /merchant_order_ext_ref=\$\{encodeURIComponent\(extRef\)\}/);
  assert.match(source, /const recovered = await findRemoteOrderByExtRef\(extRef\)[\s\S]*const created = await revolut/);
  assert.match(source, /const afterCreate = await findRemoteOrderByExtRef\(extRef\)/);
  assert.match(source, /state !== "PENDING" \|\| paymentAlreadyStarted \|\| existingPaymentId \|\| paymentIdOf\(order\)/);
  assert.match(source, /authoritative\.paymentAttempted = true/);
  assert.match(source, /paymentWasStarted \? "payment_pending" : "unknown"/);
  const savedCard = source.slice(source.indexOf('async function chargeSavedCard'), source.indexOf('interface Row'));
  assert.ok(savedCard.indexOf('await onPaymentReady(') < savedCard.indexOf('`/api/orders/${encodeURIComponent(orderId)}/payments`'));
  assert.doesNotMatch(source, /\.update\(\{ billing_retry_count: attempt \}\)/);
  assert.match(source, /currency: "USD"/);
  assert.match(source, /cycle_key: input\.cycleKey/);
});

test('billing attempt schema provides single-flight leases, monotonic outcomes, and projection CAS', () => {
  const sql = read(migrationPath);
  assert.match(sql, /create table if not exists public\.cloud_revolut_billing_attempts/);
  assert.match(sql, /cycle_key\s+text primary key/);
  assert.match(sql, /merchant_ext_ref\s+text not null unique/);
  assert.match(sql, /uq_revolut_billing_attempts_inflight_user/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /a\.lease_token = p_lease_token/);
  assert.match(sql, /when 'completed' then p_status = 'completed'/);
  assert.match(sql, /when 'failed' then p_status = 'failed'/);
  assert.match(sql, /apply_revolut_billing_success/);
  assert.match(sql, /apply_revolut_billing_failure/);
  assert.match(sql, /p\.trial_ends_at = v_attempt\.cycle_anchor/);
  assert.match(sql, /p\.current_period_end = v_attempt\.cycle_anchor/);
  assert.match(sql, /p\.provider = 'revolut'/);
  assert.match(sql, /v_projection\.provider <> 'revolut'/);
  assert.match(sql, /v_projection\.plan_code is distinct from v_attempt\.plan_code/);
  assert.match(sql, /coalesce\(p\.billing_retry_count, 0\) = v_attempt\.retry_attempt - 1/);
  assert.match(sql, /c\.discount_next_pct = v_attempt\.discount_pct/);
  assert.match(sql, /c\.promo_cycles_left = v_attempt\.promo_cycles_before/);
  assert.match(sql, /revoke all on table public\.cloud_revolut_billing_attempts from public, anon, authenticated/);
});

test('pending plan is snapshotted at cycle claim and promoted only by a completed success application', () => {
  const sql = read(pendingPlanMigrationPath);
  assert.match(sql, /pending_plan text/);
  assert.match(sql, /before insert on public\.cloud_revolut_billing_attempts/);
  assert.match(sql, /v_customer\.pending_effective_at <= new\.cycle_anchor/);
  assert.match(sql, /new\.scheduled_plan_change := true/);
  assert.match(sql, /apply_revolut_billing_success_base/);
  assert.match(sql, /if v_applied then[\s\S]*if v_attempt\.scheduled_plan_change then/);
  assert.match(sql, /set plan = v_attempt\.plan_code/);
  assert.match(sql, /pending_order_id = case when v_pending_matches then null/);
  assert.doesNotMatch(sql, /apply_revolut_billing_failure_base/);
});

test('stale checkout reconciliation is bounded, non-destructive, and claims before cancel', () => {
  const source = read(billingPath);
  const reconcile = source.slice(source.indexOf('async function reconcileOpenCheckouts'), source.indexOf('async function run'));
  assert.match(reconcile, /\.limit\(CHECKOUT_RECONCILE_BATCH\)/);
  assert.match(reconcile, /\.lte\("expires_at", nowIso\)/);
  assert.match(reconcile, /\.order\("last_reconciled_at", \{ ascending: true, nullsFirst: true \}\)/);
  assert.match(reconcile, /remoteState === "AUTHORISED"[\s\S]*continue/);
  assert.match(reconcile, /expired_at: nowIso/);
  assert.match(reconcile, /public_id: null/);
  assert.ok(reconcile.indexOf('select("order_id")') < reconcile.indexOf('/cancel`'));
  assert.doesNotMatch(reconcile, /\.delete\(/);
});
