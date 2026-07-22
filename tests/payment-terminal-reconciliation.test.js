const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const migration = read('supabase/migrations/20260722121000_payment_terminal_reconciliation.sql');
const checkout = read('supabase/functions/norva-revolut/index.ts');
const webhook = read('supabase/functions/norva-revolut-webhook/index.ts');
const billing = read('supabase/functions/norva-revolut-billing/index.ts');
const rc = read('supabase/functions/norva-billing-webhook/index.ts');
const admin = read('supabase/functions/norva-admin/index.ts');
const prices = read('supabase/functions/_shared/prices.ts');
const finance = read('supabase/migrations/20260718100000_annual_upgrade_mrr_correctness.sql');

test('checkout and recurring billing share one account money lock and revalidate eligibility', () => {
  const lock = /hashtextextended\('norva:revolut:money:' \|\| p_user_id::text, 0\)/g;
  assert.ok((migration.match(lock) || []).length >= 5);
  assert.match(migration, /'billing_inflight'::text/);
  assert.match(migration, /'checkout_inflight'::text/);
  assert.match(migration, /v_projection\.status <> 'expired'/);
  assert.match(migration, /'projection_changed'::text/);
  assert.match(checkout, /const terminalStatus = projStatus === "expired"/);
  assert.match(checkout, /code: "subscription_not_terminal"/);
});

test('checkout identity is monetary and does not stage recurring terms before payment', () => {
  const key = checkout.slice(checkout.indexOf('async function checkoutIntentKey'), checkout.indexOf('async function checkoutExtRef'));
  const signature = key.slice(0, key.indexOf('): Promise<string>'));
  assert.match(key, /"v4", userId, kind, plan, period, amount, promoBase/);
  assert.doesNotMatch(signature, /returnTo|placement|surface|experiment/);
  const customerStage = checkout.slice(checkout.indexOf('const custRow:'), checkout.indexOf('if (customerStageError)'));
  assert.doesNotMatch(customerStage, /amount_cents|promo_cycles_left|pending_plan/);
  assert.doesNotMatch(checkout, /payload\.experimentKey/);
  assert.match(checkout, /paywallExperimentForPlacement\(placement\)\.experimentKey/);
});

test('COMPLETED stale or mismatched resubscriptions are reconciled or quarantined, never discarded', () => {
  assert.match(checkout, /staleCheckout && !\(journal\.kind === "resubscribe" && state === "COMPLETED"\)/);
  assert.match(webhook, /!\(anchoredKind === "resubscribe" && remoteState === "COMPLETED"\)/);
  assert.match(checkout, /String\(meta\.user_id \?\? ""\) !== user\.id[\s\S]*journal\.kind !== remoteKind/);
  assert.match(webhook, /const userId = journalUserId \?\? metadataUserId/);
  assert.match(webhook, /journal\.kind === "resubscribe" && remoteState === "COMPLETED"/);
  assert.match(checkout, /p_provider_integrity_valid: false/);
  assert.match(webhook, /p_provider_integrity_valid: false/);
  assert.match(migration, /create or replace function public\.reconcile_completed_revolut_resubscribe/);
  assert.match(migration, /'refund_required'/);
  assert.match(migration, /v_capture_amount, v_capture_currency, 'captured'/);
  assert.match(migration, /finalized_at is not null[\s\S]*finalization_result->>'result' = 'resubscribed'/);
  assert.match(migration, /return query select 'already_refunded'::text/);
});

test('full refunds are reserved, reconciled asynchronously, and completed atomically', () => {
  assert.match(migration, /create table if not exists public\.cloud_revolut_refund_attempts/);
  assert.match(migration, /create or replace function public\.claim_revolut_full_refund/);
  assert.match(migration, /only an exact full refund may be reserved/);
  assert.match(migration, /create or replace function public\.mark_revolut_full_refund_processing/);
  assert.match(migration, /create or replace function public\.complete_revolut_full_refund/);
  assert.match(migration, /p_provider_state[\s\S]*'COMPLETED'/);
  assert.match(migration, /p_related_order_id is distinct from p_order_id/);
  assert.match(migration, /delete from public\.cloud_revolut_customers/);
  assert.match(migration, /set status='expired'[\s\S]*p\.provider='revolut'/);
  assert.match(migration, /not public\.norva_is_internal_account\(p_user_id\)/);
  assert.match(migration, /p\.status not in \('revoked','refunded','fraud'\)/);
  assert.match(migration, /'refund_inflight'::text/);
  assert.match(migration, /recurring billing attempt is still in flight/);
  assert.match(admin, /claim_revolut_full_refund/);
  assert.ok(admin.indexOf('claim_revolut_full_refund') < admin.lastIndexOf('revolutRefund(orderId'));
  assert.match(admin, /"Idempotency-Key": idempotencyKey/);
  assert.match(admin, /body: JSON\.stringify\(\{ amount: amountCents, currency \}\)/);
  assert.match(admin, /revolutRefund\(orderId, amountCents, cur, claim\.refund_key\)/);
  assert.match(admin, /status: "refund_processing"/);
  assert.match(admin, /complete_revolut_full_refund/);
  assert.match(webhook, /refundRelatedOrderId/);
  assert.match(webhook, /mark_revolut_full_refund_processing/);
  assert.match(webhook, /provider refund order has no durable local reservation/);
});

test('commercial projection uses full-period MRR while reports normalize annual once', () => {
  assert.match(rc, /patch\.mrr_cents = baseCents/);
  assert.doesNotMatch(rc, /Math\.round\(baseCents \/ 12\)/);
  assert.match(rc, /patch\.billing_currency = "USD"/);
  assert.match(rc, /billing_product_id/);
  assert.match(rc, /billing_package_id/);
  assert.match(migration, /mrr_cents = v_order\.requested_amount_cents/);
  assert.match(finance, /bill_period\)='annual' then round\(coalesce\([^)]+\)\/12\.0\)/);
  assert.equal(Math.round(4199 / 12), 350);
});

test('paid RevenueCat INTRO periods fail closed without money and ledger keeps buyer currency', () => {
  assert.match(rc, /function isFreeTrialPeriod/);
  const freeTrial = rc.slice(rc.indexOf('function isFreeTrialPeriod'), rc.indexOf('function refundedMoney'));
  assert.match(freeTrial, /return periodType === "TRIAL"/);
  assert.doesNotMatch(freeTrial, /INTRO/);
  assert.match(rc, /periodType === "INTRO"[\s\S]*paidMoney\(effective\) == null[\s\S]*throw new Error\("RevenueCat paid INTRO/);
  assert.ok(rc.indexOf('RevenueCat paid INTRO event has no authoritative amount/currency') < rc.indexOf('await journalRcPayment'));
  assert.match(rc, /if \(isFreeTrialPeriod\(event\)\) return/);
  assert.match(rc, /amount: money\.cents/);
  assert.match(rc, /currency: money\.currency/);
});

test('promo, fallback price, attribution, system cleanup, and first play are bounded', () => {
  assert.match(migration, /greatest\(v_order\.promo_cycles - 1, 0\)/);
  assert.match(prices, /family:\s*\{ monthly: 899, annual: 7499 \}/);
  assert.match(migration, /amount_cents = 7499[\s\S]*amount_cents = 7599/);
  assert.match(billing, /kind === "first_charge"[\s\S]*requireExposure: true/);
  assert.match(rc, /requiredSurfaces:[\s\S]*"android_tv"/);
  assert.match(migration, /new\.provider = 'system'[\s\S]*new\.billing_terms_source := null/);
  assert.match(migration, /e\.occurred_at between new\.created_at - interval '30 days' and new\.created_at/);
  assert.match(migration, /v_projection\.status not in/);
  assert.match(migration, /e\.plan_code = v_projection\.plan_code/);
  assert.match(migration, /e\.metadata->>'provider'[\s\S]*v_projection\.provider/);
});

test('checkout creation and reuse return the complete frozen server quote', () => {
  for (const field of [
    'plan', 'period', 'cadence', 'price_amount_minor', 'requested_amount_cents',
    'currency', 'charge_mode', 'trial_days', 'first_charge_at',
  ]) assert.match(checkout, new RegExp(field));
  assert.match(checkout, /\.select\("plan,period,requested_amount_cents,currency,charge_mode,trial_days,first_charge_at"\)/);
  assert.match(checkout, /const terms = checkoutTermsFromJournal\(frozenOrder\)/);
  const frozen = checkout.slice(checkout.indexOf('function checkoutTermsFromJournal'), checkout.indexOf('async function revolut'));
  assert.doesNotMatch(frozen, /fallback|commercialTerms|remote/);
  assert.match(checkout, /checkout_terms_invalid/);
  assert.match(checkout, /reused: true[\s\S]*\.\.\.terms/);
  assert.match(checkout, /reused: false[\s\S]*\.\.\.commercialTerms/);
  assert.match(checkout, /first_charge_at: commercialTerms\.first_charge_at/);
  assert.match(migration, /add column if not exists charge_mode text/);
  assert.match(migration, /add column if not exists first_charge_at timestamptz/);
});
