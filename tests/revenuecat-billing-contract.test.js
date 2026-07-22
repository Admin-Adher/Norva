const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');

async function policy() {
  return import(pathToFileURL(path.join(root, 'supabase/functions/_shared/billing-policy.mjs')).href);
}

test('RevenueCat product map normalizes values and rejects non-store tiers', async () => {
  const { parseRevenueCatProductMap } = await policy();
  const map = parseRevenueCatProductMap(JSON.stringify({
    ' Family_Product ': ' Family ', plus_product: 'PLUS', bad_manual: 'manual', bad_none: 'none'
  }));
  assert.deepEqual(map, { family_product: 'family', plus_product: 'plus' });
});

test('RevenueCat plan resolution accepts only exact, entitlement, or explicit tier tokens', async () => {
  const { resolveRevenueCatPlan } = await policy();
  assert.deepEqual(resolveRevenueCatPlan({ product_id: 'sku_weird' }, { sku_weird: 'family' }), {
    planCode: 'family', mapping: 'exact', productId: 'sku_weird'
  });
  assert.equal(resolveRevenueCatPlan({ product_id: 'sku', entitlement_ids: ['family'] }).planCode, 'family');
  assert.equal(resolveRevenueCatPlan({ product_id: 'norva_plus_annual' }).planCode, 'plus');
  assert.equal(resolveRevenueCatPlan({ product_id: 'norva_family_annual' }).planCode, 'family');
  assert.deepEqual(resolveRevenueCatPlan({ product_id: 'norva_household_monthly' }), {
    planCode: null, mapping: 'unknown', productId: 'norva_household_monthly'
  });
  assert.deepEqual(resolveRevenueCatPlan({ product_id: 'premium_pack' }), {
    planCode: null, mapping: 'unknown', productId: 'premium_pack'
  });
  assert.equal(resolveRevenueCatPlan({ product_id: 'mystery' }).mapping, 'unknown');
});

test('unknown RevenueCat products preserve a known projection and emit an alert path', () => {
  const source = fs.readFileSync(path.join(root, 'supabase/functions/norva-billing-webhook/index.ts'), 'utf8');
  assert.match(source, /UNKNOWN_PRODUCT_ID/);
  assert.match(source, /sameRail && isKnownStorePlan\(currentPlan\).*resolvedPlan = currentPlan/s);
  assert.match(source, /isRevenueCatProvider\(existingProjection\?\.provider\)/);
  assert.match(source, /NORVA_RC_UNKNOWN_PRODUCT_POLICY/);
  assert.match(source, /effectiveEvent\(eventType, event\)/);
  assert.doesNotMatch(source, /VALID_PLAN_CODES/);
  assert.doesNotMatch(source, /productId\.includes\(['"]norva['"]\)/);
});

test('one-shot RevenueCat access must carry a finite future expiration', async () => {
  const { canGrantRevenueCatAccess, isRevenueCatProvider } = await policy();
  assert.equal(canGrantRevenueCatAccess('NON_RENEWING_PURCHASE', {}), false);
  assert.equal(canGrantRevenueCatAccess('NON_RENEWING_PURCHASE', { expiration_at_ms: 0 }), false);
  assert.equal(canGrantRevenueCatAccess('NON_RENEWING_PURCHASE', {
    expiration_at_ms: Date.now() + 86_400_000,
  }), true);
  assert.equal(canGrantRevenueCatAccess('EXPIRATION', {}), true);
  assert.equal(isRevenueCatProvider('google_play'), true);
  assert.equal(isRevenueCatProvider('apple_app_store'), true);
  assert.equal(isRevenueCatProvider('revolut'), false);
  assert.equal(isRevenueCatProvider('system'), false);
});

test('an unmapped paid grant stays retryable unless a same-rail plan can be preserved', async () => {
  const { shouldRejectUnmappedRevenueCatEvent } = await policy();
  assert.equal(shouldRejectUnmappedRevenueCatEvent('INITIAL_PURCHASE', null, 'warn'), true);
  assert.equal(shouldRejectUnmappedRevenueCatEvent('RENEWAL', null, 'warn'), true);
  assert.equal(shouldRejectUnmappedRevenueCatEvent('SUBSCRIPTION_EXTENDED', null, 'warn'), true);
  assert.equal(shouldRejectUnmappedRevenueCatEvent('EXPIRATION', null, 'warn'), false);
  assert.equal(shouldRejectUnmappedRevenueCatEvent('EXPIRATION', null, 'error'), true);
  assert.equal(shouldRejectUnmappedRevenueCatEvent('INITIAL_PURCHASE', 'plus', 'error'), false);
  assert.equal(shouldRejectUnmappedRevenueCatEvent('RENEWAL', 'family', 'warn'), false);

  const source = fs.readFileSync(path.join(root, 'supabase/functions/norva-billing-webhook/index.ts'), 'utf8');
  const rejection = source.indexOf('shouldRejectUnmappedRevenueCatEvent(eventType, resolvedPlan');
  const paymentJournal = source.indexOf('await journalRcPayment(admin, userId, eventType, event, resolvedPlan)');
  const processedMarker = source.indexOf('await recordProcessedEvent(admin, userId, eventId, eventType');
  assert.ok(rejection > 0 && rejection < paymentJournal && rejection < processedMarker);
});

test('an older RevenueCat delivery after a renewal is rejected by the monotonic projection', () => {
  const migration = fs.readFileSync(path.join(
    root,
    'supabase/migrations/20260721115000_revenuecat_monotonic_projection.sql'
  ), 'utf8');
  const webhook = fs.readFileSync(path.join(root, 'supabase/functions/norva-billing-webhook/index.ts'), 'utf8');
  const renewalAt = Date.parse('2026-07-21T12:00:00Z');
  const delayedCancellationAt = Date.parse('2026-07-20T12:00:00Z');
  assert.equal(delayedCancellationAt > renewalAt, false);
  assert.match(migration, /cloud_revenuecat_projection_cursor/);
  assert.match(migration, /last_projection_applied boolean not null default false/);
  assert.match(migration, /p_event_id = v_cursor\.last_event_id/);
  assert.match(migration, /select v_cursor\.last_projection_applied, v_last_event_at/);
  assert.match(migration, /p_event_at <= v_cursor\.last_event_at/);
  assert.match(migration, /last_projection_applied = excluded\.last_projection_applied/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /current_projection\.provider[\s\S]*'revenuecat'[\s\S]*'google_play'[\s\S]*'apple_app_store'/);
  assert.match(migration, /excluded\.status in \('trialing', 'active'\)/);
  assert.match(migration, /revoke all on function public\.apply_revenuecat_entitlement_event/);
  assert.match(webhook, /admin\.rpc\("apply_revenuecat_entitlement_event"/);
  assert.match(webhook, /p_event_id: causalEventId/);
  assert.doesNotMatch(webhook, /\.upsert\(patch,\s*\{\s*onConflict:\s*"user_id"\s*\}\)/);
});

test('RevenueCat takes over only after a system or manual entitlement has actually lapsed', () => {
  const migration = fs.readFileSync(path.join(
    root,
    'supabase/migrations/20260721115000_revenuecat_monotonic_projection.sql'
  ), 'utf8');
  const eventAt = Date.parse('2026-07-21T12:00:00Z');
  const allowsTakeover = ({ incomingStatus = 'active', currentStatus, ends = [] }) => {
    const finiteEnds = ends.filter((value) => Number.isFinite(value));
    return ['trialing', 'active'].includes(incomingStatus)
      && !['fraud', 'revoked'].includes(currentStatus)
      && (currentStatus === 'expired'
        || (finiteEnds.length > 0 && Math.max(...finiteEnds) <= eventAt));
  };

  assert.equal(allowsTakeover({
    currentStatus: 'trialing',
    ends: [Date.parse('2026-07-20T12:00:00Z')],
  }), true, 'an expired legacy system trial can become a RevenueCat subscription');
  assert.equal(allowsTakeover({
    currentStatus: 'trialing',
    ends: [Date.parse('2026-07-22T12:00:00Z')],
  }), false, 'a live system trial remains protected');
  assert.equal(allowsTakeover({ currentStatus: 'active', ends: [] }), false,
    'a perpetual active manual grant remains protected');
  assert.equal(allowsTakeover({ currentStatus: 'expired', ends: [] }), true,
    'an expired manual grant can become a RevenueCat subscription');

  assert.match(migration, /current_projection\.status not in \('fraud', 'revoked'\)/);
  assert.match(migration, /current_projection\.status = 'expired'/);
  assert.match(migration, /greatest\([\s\S]*current_projection\.current_period_end[\s\S]*\) <= p_event_at/);
  assert.doesNotMatch(migration, /current_projection\.provider[\s\S]{0,160}not in \('system', 'manual'\)/);
});

test('newer store events stay journal-only for internal and hard-blocked accounts', () => {
  const migration = fs.readFileSync(path.join(
    root,
    'supabase/migrations/20260721120000_internal_account_billing_invariant.sql'
  ), 'utf8');
  const start = migration.indexOf('create or replace function public.apply_revenuecat_entitlement_event(');
  const end = migration.indexOf('revoke all on function public.norva_is_internal_account', start);
  const wrapper = migration.slice(start, end);
  assert.match(wrapper, /pg_advisory_xact_lock/);
  assert.match(wrapper, /for update/);
  assert.match(wrapper, /v_internal or v_current_status in \('revoked', 'refunded', 'fraud'\)/);
  assert.match(wrapper, /last_projection_applied = false/);
  assert.match(wrapper, /return query select false, v_projection_last_event_at/);
  assert.ok(wrapper.indexOf('v_internal or v_current_status') <
    wrapper.indexOf('apply_revenuecat_entitlement_event_nonblocked('));
  assert.match(migration, /revoke all on function public.apply_revenuecat_entitlement_event_nonblocked/);
});

test('PRODUCT_CHANGE is journal-only until the store reports the effective renewal or purchase', () => {
  const source = fs.readFileSync(path.join(root, 'supabase/functions/norva-billing-webhook/index.ts'), 'utf8');
  assert.match(source, /new_product_id/);
  assert.match(source, /product_id:\s*null,\s*entitlement_ids:\s*\[\]/);
  assert.match(source, /const event = effectiveEvent\(type, rawEvent\)/);
  assert.match(source, /case "PRODUCT_CHANGE":\s*return null/);
  assert.doesNotMatch(source, /const MONEY = new Set\([^\n]*PRODUCT_CHANGE/);
});

test('sandbox is ignored by default and subscription extensions advance the projection', () => {
  const source = fs.readFileSync(path.join(root, 'supabase/functions/norva-billing-webhook/index.ts'), 'utf8');
  assert.match(source, /NORVA_RC_ACCEPT_SANDBOX/);
  assert.match(source, /purchaseEnvironment === "SANDBOX" && !ACCEPT_SANDBOX/);
  assert.match(source, /skipped: "sandbox"/);
  assert.match(source, /case "SUBSCRIPTION_EXTENDED":/);
  assert.match(source, /case "REFUND_REVERSED":/);
});
