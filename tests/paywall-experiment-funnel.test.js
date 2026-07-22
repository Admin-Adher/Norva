const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const migration = read('supabase/migrations/20260722120000_paywall_experiments_funnel.sql');
const terminalMigration = read('supabase/migrations/20260722121000_payment_terminal_reconciliation.sql');
const nativeCheckoutMigration = read('supabase/migrations/20260722123000_native_google_play_checkout_funnel.sql');
const cloud = read('supabase/functions/norva-cloud/index.ts');
const revolut = read('supabase/functions/norva-revolut/index.ts');
const revolutWebhook = read('supabase/functions/norva-revolut-webhook/index.ts');
const revenueCat = read('supabase/functions/norva-billing-webhook/index.ts');
const cloudClient = read('public/js/cloudApi.js');

test('paywall assignment is account-stable, server-owned, and starts as a real baseline', () => {
  assert.match(migration, /unique \(user_id, experiment_key\)/);
  assert.match(migration, /assignment_salt \|\| ':' \|\| p_user_id::text/);
  assert.doesNotMatch(migration, /assignment_salt \|\| ':' \|\| p_user_id::text \|\|[^\n]*device/i);
  assert.match(migration, /'control', 10000/);
  assert.match(migration, /'multiscreen_value', 0/);
  assert.match(migration, /admin_internal_accounts/);
  assert.match(migration, /revoke all on table public\.paywall_experiment_assignments from public, anon, authenticated/);
});

test('claim and exposure APIs work for user and paired-device auth without trusting a client variant', () => {
  assert.match(cloud, /scope === "experiments" && id === "paywall"/);
  assert.match(cloud, /id === "experiments" && action === "paywall"/);
  assert.match(cloud, /action === "exposure"/);
  assert.match(cloud, /segments\[3\] === "exposure"/);
  assert.match(cloud, /A forged `variant` or `experimentKey` property is ignored/);
  assert.doesNotMatch(cloud, /body\.variant/);
  assert.doesNotMatch(cloud, /body\.experimentKey/);
  assert.match(cloud, /paywallExperimentForPlacement/);
  assert.match(read('supabase/functions/_shared/paywall-experiments.ts'), /subscribe_plans: DEFAULT_PAYWALL_EXPERIMENT_KEY/);
  assert.doesNotMatch(cloudClient, /recordPaywallExposure:[\s\S]{0,180}experimentKey/);
  assert.match(migration, /paywall_exposed:' \|\| p_user_id::text[\s\S]*v_placement \|\| ':' \|\| v_surface/);
  assert.match(migration, /on conflict \(dedupe_key\) do nothing/);
});

test('the conversion chain separates authorization, capture, entitlement, and first frame', () => {
  for (const stage of [
    'paywall_exposed', 'checkout_started', 'order_authorized',
    'payment_captured', 'entitlement_activated', 'first_play',
  ]) assert.match(migration, new RegExp(`'${stage}'`));
  assert.match(migration, /new\.user_id, 'payment_captured', 'billing_ledger'/);
  assert.match(migration, /e\.event_type in \('payment_captured', 'order_authorized', 'paywall_exposed'\)/);
  assert.match(migration, /v_previous\.price_amount_minor, v_previous\.price_currency/);
  assert.doesNotMatch(migration, /new\.plan_code, new\.bill_period, new\.mrr_cents/);
  assert.match(migration, /entitlement_event_id = new\.id/);
  assert.match(migration, /new\.event_type <> 'first_frame'/);
});

test('Google Play checkout start is account-authenticated, server-attributed and idempotent', () => {
  assert.match(cloud, /action === "checkout-start"/);
  assert.match(cloud, /googlePlayCheckoutStarted\(req, user\.id, db\)/);
  assert.match(cloud, /claimPaywallExperiment\(db, userId, experimentKey\)/);
  assert.match(cloud, /if \(!assignment\.eligible \|\| !assignment\.variant\)/);
  assert.match(cloud, /reason: assignment\.reason \?\? "account_excluded"/);
  assert.match(cloud, /surface: "mobile_android"/);
  assert.match(cloud, /\.eq\("placement", placement\)/);
  assert.match(cloud, /reason: "no_recent_mobile_exposure"/);
  assert.match(cloud, /Date\.now\(\) - 30 \* 86_400_000/);
  assert.match(cloud, /checkout_started:google_play:\$\{userId\}:\$\{requestId\}/);
  assert.match(cloud, /onConflict: "dedupe_key", ignoreDuplicates: true/);
  assert.match(cloud, /googlePlayCatalog: Readonly<Record/);
  assert.match(cloud, /"\$rc_monthly\|norva_plus"/);
  assert.match(cloud, /"family_annual\|norva_family"/);
  assert.match(cloud, /googlePlayCatalog\[`\$\{packageId\}\|\$\{productBaseId\}`\]/);
  assert.match(cloud, /offering_id_authority: "unverified_current_offering_observation"/);
  assert.match(cloud, /Unknown or inconsistent Google Play checkout tuple/);
  assert.match(cloud, /price_amount_minor: null/);
  assert.match(cloud, /price_currency: null/);
  assert.match(cloud, /client_store_snapshot:/);
  assert.match(cloud, /authority: "unverified_native_client_observation"/);
  assert.match(cloud, /commercial_terms_authority: "pending_revenuecat_webhook"/);
  assert.match(nativeCheckoutMigration, /'native_google_play'/);
});

test('commercial terms and experiment attribution are frozen on every billing rail', () => {
  assert.match(revolut, /price_currency: "USD", price_source: "billing_prices"/);
  assert.match(revolut, /experiment_key: experimentKey, experiment_variant: experimentVariant/);
  assert.match(terminalMigration, /commercial_terms_source[\s\S]*'revolut_order_snapshot'/);
  assert.match(revenueCat, /store_product_id: stringOrNull\(event\.product_id\)/);
  assert.match(revenueCat, /store_package_id: packageIdOf\(event\)/);
  assert.match(revenueCat, /commercial_terms_source: "revenuecat_webhook"/);
  assert.match(revenueCat, /await journalRcPayment\([\s\S]*const patch = projectionPatch/);
  assert.match(migration, /billing_currency text/);
  assert.match(migration, /billing_terms_source text/);
});

test('resubscribe charges the real price and never projects active before capture', () => {
  assert.match(revolut, /const immediateCharge = kind === "resubscribe"/);
  assert.match(revolut, /capture_mode: immediateCharge \? "AUTOMATIC" : "MANUAL"/);
  assert.match(revolut, /remoteKind === "resubscribe"[\s\S]*state === "COMPLETED"/);
  assert.match(revolut, /status: remoteKind === "resubscribe" \? "payment_processing"/);
  const endpointBlock = revolut.slice(
    revolut.lastIndexOf('if (kind === "resubscribe")'),
    revolut.indexOf('// trial_setup', revolut.lastIndexOf('if (kind === "resubscribe")')),
  );
  assert.match(endpointBlock, /reconcile_completed_revolut_resubscribe/);
  assert.match(terminalMigration, /insert into public\.cloud_billing_ledger[\s\S]*update public\.cloud_entitlement_projection/);
  assert.match(terminalMigration, /mrr_cents = v_order\.requested_amount_cents/);

  const webhookBlock = revolutWebhook.slice(
    revolutWebhook.indexOf('if (kind === "resubscribe")', revolutWebhook.indexOf('async function finalizeCheckoutEntitlement')),
    revolutWebhook.indexOf('if (cur?.trial_consumed_at)', revolutWebhook.indexOf('if (kind === "resubscribe")', revolutWebhook.indexOf('async function finalizeCheckoutEntitlement'))),
  );
  assert.match(webhookBlock, /order\.state[\s\S]*!== "COMPLETED"/);
  assert.match(webhookBlock, /return "payment_processing"/);
  assert.match(webhookBlock, /reconcile_completed_revolut_resubscribe/);
  assert.doesNotMatch(webhookBlock, /replaceProjectionWithRailCas/);
});

test('trial checkout exposes truthful server timing and admin analytics avoid daily-unique sums', () => {
  assert.match(revolut, /trial_days: kind === "trial_setup" \? TRIAL_DAYS : null/);
  assert.match(revolut, /first_charge_at: null/);
  assert.match(revolut, /trial_ends_at: trialEnd, first_charge_at: trialEnd/);
  assert.match(migration, /create or replace function public\.admin_paywall_funnel_30d\(\)/);
  assert.match(migration, /v_stage_totals/);
  assert.match(migration, /v_stage_rollup/);
  assert.match(migration, /count\(distinct e\.user_id\)::integer as users/);
  assert.match(migration, /'stage_totals', v_stage_totals/);
  assert.match(migration, /'stage_rollup', v_stage_rollup/);
  assert.match(migration, /if not public\.is_admin\(\)/);
});
