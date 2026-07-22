const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const webhook = read('supabase/functions/norva-billing-webhook/index.ts');
const migration = read('supabase/migrations/20260722005200_revenuecat_billing_email_producers.sql');
const lifecycleBase = read('supabase/migrations/20260722003500_lifecycle_billing_event_intents.sql');

test('captured RevenueCat payments carry authoritative confirmation context', () => {
  assert.match(webhook, /journalRcPayment\(admin, userId, eventType, event, resolvedPlan\)/);
  assert.match(webhook, /plan_code:\s*isKnownStorePlan\(resolvedPlan\)/);
  assert.match(webhook, /bill_period:\s*billPeriodForEvent\(event\)/);
  assert.match(webhook, /billing_period_end:\s*msToIso\(event\.expiration_at_ms\)/);
  assert.match(webhook, /periodType === "TRIAL" \|\| periodType === "INTRO"/);
  assert.match(webhook, /if \(periodType === "TRIAL" \|\| periodType === "INTRO"\) return/);
});

test('the ledger trigger produces one confirmation for each captured cross-rail payment', () => {
  assert.match(migration, /v_provider not in \([\s\S]*'revolut'[\s\S]*'google_play'[\s\S]*'apple_app_store'[\s\S]*'web'[\s\S]*'stripe'/);
  assert.match(migration, /lower\(coalesce\(new\.status, ''\)\) <> 'captured'/);
  assert.match(migration, /admin_internal_accounts/);
  assert.match(migration, /cloud_email_suppressions[\s\S]*s\.email = v_email and s\.active/);
  assert.match(migration, /digest\(new\.pi_id, 'sha256'\)/);
  assert.match(migration, /on conflict \(ledger_pi_id\) do nothing/);
  assert.doesNotMatch(migration, /provider_payment_id/);
});

test('RevenueCat customer-support refunds do not masquerade as cancellations', () => {
  assert.match(webhook, /case "CANCELLATION":[\s\S]*if \(isRefundCancellation\(event\)\) return null/);
  assert.match(webhook, /cancel_reason[\s\S]*CUSTOMER_SUPPORT/);
  assert.match(webhook, /kind:\s*"refund"/);
  assert.match(webhook, /status:\s*"refunded"/);
  assert.match(webhook, /const refund = refundedMoney\(event\)/);

  const refundBranch = migration.indexOf("v_raw_type = 'CANCELLATION' and v_cancel_reason = 'CUSTOMER_SUPPORT'");
  const cancellationBranch = migration.indexOf("v_raw_type in ('CANCELLATION','SUBSCRIPTION_PAUSED')");
  assert.ok(refundBranch > 0 && refundBranch < cancellationBranch);
  const refundBlock = migration.slice(refundBranch, cancellationBranch);
  assert.match(refundBlock, /'refund_confirmed'/);
  assert.match(refundBlock, /return new/);
  assert.match(refundBlock, /price_in_purchased_currency/);
  assert.match(refundBlock, /v_refund_usd_raw/);
  assert.match(refundBlock, /v_currency := 'USD'/);
  assert.match(refundBlock, /v_refund_cents not between 1 and 9999999/);
  assert.doesNotMatch(refundBlock, /transaction_id|original_transaction_id|provider_payment_id/);
});

test('unknown buyer currency never mislabels a local amount as USD', () => {
  assert.match(webhook, /function paidMoney\(event: JsonRecord\): RcMoney \| null/);
  assert.match(webhook, /local > 0 && localCurrency/);
  assert.match(webhook, /const usd = Number\(event\.price\)/);
  assert.match(webhook, /currency: "usd"/);
  assert.match(webhook, /function refundedMoney\(event: JsonRecord\): RcMoney \| null/);
  assert.doesNotMatch(webhook, /price_in_purchased_currency \?\? event\.price/);
});

test('refund, payment and lifecycle delivery remain independently idempotent', () => {
  assert.match(webhook, /pi_id:\s*`rc_refund_\$\{refundIdentity\}`/);
  assert.match(webhook, /onConflict:\s*"pi_id", ignoreDuplicates:\s*true/);
  assert.match(lifecycleBase, /unique \(source_provider, source_event_id, event_type\)/);
  assert.match(migration, /norva_insert_lifecycle_billing_intent\([\s\S]*'refund_confirmed'/);
});

test('RevenueCat fraud and revocation are not inferred from an ambiguous refund event', () => {
  const statusStart = webhook.indexOf('function statusForEvent(');
  const statusEnd = webhook.indexOf('function isRefundCancellation(', statusStart);
  const statusMapper = webhook.slice(statusStart, statusEnd);
  assert.doesNotMatch(statusMapper, /"fraud"|"revoked"|"refunded"/);
  assert.match(statusMapper, /case "EXPIRATION":\s*return "expired"/);
  assert.match(migration, /EXPIRATION[\s\S]*'access_expired'/);
});
