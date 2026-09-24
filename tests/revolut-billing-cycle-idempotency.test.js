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
  assert.match(reconcile, /if \(checkout\.kind === "resubscribe"\) continue/);
  assert.match(reconcile, /!authorised && remoteState !== "PENDING" && remoteState !== "PROCESSING"/);
  assert.match(reconcile, /\.in\("state", \["PENDING", "PROCESSING", "AUTHORISED"/);
  assert.match(reconcile, /\.not\("expired_at", "is", null\)[\s\S]*\.lt\("last_reconciled_at", nowIso\)/);
  assert.match(reconcile, /for \(const checkout of \(pendingCancels \?\? \[\]\)[\s\S]*retrieveRemoteOrder\(checkout\.order_id\)[\s\S]*canCancel \? await revolut/);
  assert.match(reconcile, /\.in\("kind", \["trial_setup", "plan_change", "card_update"\]\)[\s\S]*\.contains\("finalization_result", \{ hold_released: false \}\)/);
  assert.match(reconcile, /for \(const checkout of \(finalizedHolds \?\? \[\]\)[\s\S]*retrieveRemoteOrder\(checkout\.order_id\)[\s\S]*const released = alreadyReleased \|\| cancelled\?\.ok === true/);
  assert.match(reconcile, /expired_at: nowIso/);
  assert.match(reconcile, /public_id: null/);
  assert.ok(reconcile.indexOf('select("order_id")') < reconcile.indexOf('/cancel`'));
  assert.doesNotMatch(reconcile, /\.delete\(/);
});

test('expired card holds are cancelled and failed releases are retried without cancelling paid resubscriptions', async () => {
  const { transformSync } = require('esbuild');
  const source = read(billingPath);
  const reconcile = source.slice(source.indexOf('async function reconcileOpenCheckouts'), source.indexOf('async function run'));
  const { code } = transformSync(`${reconcile}\nmodule.exports = reconcileOpenCheckouts;`, { loader: 'ts', format: 'cjs' });
  const cancelCalls = [];
  const run = new Function('CHECKOUT_RECONCILE_BATCH', 'retrieveRemoteOrder', 'revolut', 'remoteStateOf', 'errorText',
    `const module = { exports: null }; ${code}; return module.exports;`)(
    10,
    async () => ({ order: { state: 'AUTHORISED' }, response: { status: 200 } }),
    async (_method, path) => { cancelCalls.push(path); return { ok: true, body: { state: 'CANCELLED' }, status: 200 }; },
    (body) => body.state,
    () => '',
  );
  function dbFor(open, pending = [], finalized = []) {
    const batches = [open, pending, finalized];
    const updates = [];
    let batch = 0;
    return {
      updates,
      from() {
        let updating = false;
        const query = {
          select() { return updating ? Promise.resolve({ data: [{ order_id: 'order-1' }], error: null }) : query; },
          update(patch) { updates.push(patch); updating = true; return query; },
          in() { return query; }, is() { return query; }, not() { return query; },
          lte() { return query; }, lt() { return query; }, eq() { return query; },
          contains() { return query; }, order() { return query; },
          limit() { return Promise.resolve({ data: batches[batch++] ?? [], error: null }); },
          then(resolve, reject) { return Promise.resolve({ data: null, error: null }).then(resolve, reject); },
        };
        return query;
      },
    };
  }
  const expired = { order_id: 'order-1', state: 'AUTHORISED', expires_at: '2000-01-01T00:00:00Z', kind: 'trial_setup' };
  const first = dbFor([expired]);
  assert.equal((await run(first)).checkout_cancelled, 1);
  assert.equal(cancelCalls.length, 1);
  assert.ok(first.updates.some((patch) => patch.expired_at && patch.public_id === null));

  const paid = dbFor([{ ...expired, kind: 'resubscribe' }]);
  assert.equal((await run(paid)).checkout_cancelled, 0);
  assert.equal(cancelCalls.length, 1);

  const retry = dbFor([], [{ ...expired }]);
  assert.equal((await run(retry)).checkout_cancelled, 1);
  assert.equal(cancelCalls.length, 2);

  const finalized = dbFor([], [], [{ order_id: 'order-1', kind: 'trial_setup', finalization_result: { result: 'trial_started', hold_released: false } }]);
  assert.equal((await run(finalized)).checkout_cancelled, 1);
  assert.equal(cancelCalls.length, 3);
  assert.ok(finalized.updates.some((patch) => patch.finalization_result?.hold_released === true && patch.finalization_result?.result === 'trial_started'));
});
