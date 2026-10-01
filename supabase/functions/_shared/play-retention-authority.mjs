import { fetchGooglePlayOrder, googlePlayAccessToken, googlePlayOrdersConfiguration } from './google-play-orders.mjs';

// Only called for a signed store event and a matching server-side claim.
// Raw Orders/Subscriptions responses (tokens, addresses) never leave this module.
export function validateScheduledPlayOffer(event, claim, order, subscription) {
  const [product, plan] = String(claim.product_id).split(':');
  const bought = Number(event.purchased_at_ms), claimed = Date.parse(claim.claimed_at);
  if (!['PRODUCTION', 'SANDBOX'].includes(event.environment)
    || !Number.isFinite(bought) || !Number.isFinite(claimed)
    || bought < claimed - 300000 || bought > Date.parse(claim.expires_at)
    || event.product_id !== claim.product_id || order.orderId !== event.transaction_id
    || order.state !== 'PROCESSED'
    || (subscription.testPurchase != null) !== (event.environment === 'SANDBOX')
    || subscription.subscriptionState !== 'SUBSCRIPTION_STATE_ACTIVE') return null;
  const details = order.lineItems?.filter(x => x.productId === product
    && x.subscriptionDetails?.basePlanId === plan
    && x.subscriptionDetails?.offerId === claim.offer_id);
  const lines = subscription.lineItems?.filter(x => x.productId === product
    && x.offerDetails?.basePlanId === plan && x.offerDetails?.offerId === claim.offer_id
    && x.autoRenewingPlan?.autoRenewEnabled === true);
  if (details?.length !== 1 || lines?.length !== 1) return null;
  const start = Date.parse(details[0].subscriptionDetails.servicePeriodStartTime);
  const end = Date.parse(details[0].subscriptionDetails.servicePeriodEndTime);
  if (!Number.isFinite(start) || Math.abs(start - bought) > 300000
    || !Number.isFinite(end) || end < Date.parse(claim.access_until)
    || !(Date.parse(lines[0].expiryTime) >= end)) return null;
  return { source: 'google_play_api', offerId: claim.offer_id, claimId: claim.claim_id,
    accessUntil: new Date(end).toISOString(), environment: event.environment };
}

export async function scheduledPlayOffer(db, userId, event, config, dependencies = {}) {
  if (event.type !== 'INITIAL_PURCHASE' || event.store !== 'PLAY_STORE'
    || event.offer_code || !event.transaction_id) return null;
  const { data: claim, error } = await db.from('cloud_play_retention_offers')
    .select('product_id,offer_id,claim_id,claimed_at,expires_at,access_until')
    .eq('user_id', userId).eq('state', 'offered').eq('product_id', event.product_id)
    .not('claimed_at', 'is', null).order('claimed_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error('play_retention_claim_unavailable');
  if (!claim) return null;
  const configuration = googlePlayOrdersConfiguration(config);
  if (!configuration) throw new Error('play_retention_authority_unconfigured');
  const order = await (dependencies.order || fetchGooglePlayOrder)(configuration, event.transaction_id);
  if (typeof order.purchaseToken !== 'string' || !order.purchaseToken) return null;
  const token = await (dependencies.token || googlePlayAccessToken)(configuration);
  let response;
  try {
    response = await (dependencies.fetch || fetch)(
      'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/'
      + encodeURIComponent(configuration.packageName) + '/purchases/subscriptionsv2/tokens/'
      + encodeURIComponent(order.purchaseToken), {
        headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(10000),
      });
    if (!response.ok) throw new Error('unavailable');
    const raw = await response.text();
    if (raw.length > 1000000) throw new Error('oversize');
    return validateScheduledPlayOffer(event, claim, order, JSON.parse(raw));
  } catch { throw new Error('play_retention_store_verification_unavailable'); }
}
