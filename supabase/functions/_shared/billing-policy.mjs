/** Pure billing decisions shared by Deno Edge functions and Node tests. */

const STORE_PLANS = new Set(['plus', 'family']);
const REVENUECAT_GRANT_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
  'SUBSCRIPTION_EXTENDED',
  'REFUND_REVERSED',
]);
const REVENUECAT_PROVIDERS = new Set([
  'revenuecat', 'google_play', 'apple_app_store', 'stripe', 'web',
]);

function explicitPlanToken(value) {
  const tokens = String(value ?? '')
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.includes('family')) return 'family';
  if (tokens.includes('plus')) return 'plus';
  return null;
}

export function parseRevenueCatProductMap(raw, defaults = {}) {
  const out = {};
  for (const [key, value] of Object.entries(defaults || {})) {
    const plan = String(value ?? '').trim().toLowerCase();
    if (STORE_PLANS.has(plan)) out[String(key).trim().toLowerCase()] = plan;
  }
  if (!raw) return out;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (_) { return out; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed)) {
    const plan = String(value ?? '').trim().toLowerCase();
    if (STORE_PLANS.has(plan)) out[String(key).trim().toLowerCase()] = plan;
  }
  return out;
}

export function resolveRevenueCatPlan(event, productMap = {}) {
  const productId = typeof event?.product_id === 'string' ? event.product_id.trim().toLowerCase() : '';
  const mapped = productId ? productMap[productId] : undefined;
  if (STORE_PLANS.has(mapped)) return { planCode: mapped, mapping: 'exact', productId };

  const entitlements = Array.isArray(event?.entitlement_ids)
    ? event.entitlement_ids.map((value) => String(value).trim().toLowerCase())
    : [];
  const entitlementPlan = entitlements.map(explicitPlanToken).find((plan) => plan === 'family')
    ?? entitlements.map(explicitPlanToken).find((plan) => plan === 'plus')
    ?? null;
  if (entitlementPlan) return { planCode: entitlementPlan, mapping: 'entitlement', productId };

  // A product name is only usable when it contains an explicit plan token.
  // In particular, a generic `norva_*` prefix says nothing about the tier:
  // silently treating it as Plus used to downgrade Family subscriptions.
  const explicitProductPlan = explicitPlanToken(productId);
  if (explicitProductPlan) return { planCode: explicitProductPlan, mapping: 'explicit_product', productId };
  return { planCode: null, mapping: 'unknown', productId };
}

export function canGrantRevenueCatAccess(eventType, event) {
  const type = String(eventType ?? '').trim().toUpperCase();
  if (!REVENUECAT_GRANT_EVENTS.has(type)) return true;
  const expirationMs = Number(event?.expiration_at_ms);
  return Number.isFinite(expirationMs) && expirationMs > Date.now();
}

export function shouldRejectUnmappedRevenueCatEvent(eventType, resolvedPlan, policy = 'warn') {
  // A retryable failure is mandatory for every event that can grant paid access:
  // acknowledging it without a tier would permanently record the charge while
  // leaving the customer without an entitlement.  Non-grant events may retain the
  // warn policy, while an explicit strict policy rejects every unresolved mapping.
  // A known Plus/Family projection from the same RevenueCat rail is resolved before
  // this helper is called and is therefore safe to preserve.
  if (isKnownStorePlan(resolvedPlan)) return false;
  const type = String(eventType ?? '').trim().toUpperCase();
  return String(policy ?? '').trim().toLowerCase() === 'error'
    || REVENUECAT_GRANT_EVENTS.has(type);
}

export function isKnownStorePlan(value) {
  return STORE_PLANS.has(String(value ?? '').trim().toLowerCase());
}

export function isRevenueCatProvider(value) {
  return REVENUECAT_PROVIDERS.has(String(value ?? '').trim().toLowerCase());
}

export function shouldAdminBypass(decision) {
  if (!decision || ['revoked', 'refunded', 'fraud'].includes(String(decision.reason || ''))) return false;
  return decision.allowed === false || decision.planCode === 'free' || String(decision.reason || '').startsWith('free_');
}
