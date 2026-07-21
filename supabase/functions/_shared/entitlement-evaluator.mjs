/** Pure subscription state machine. No database, clock, or environment access. */

const HARD_BLOCKS = new Set(['revoked', 'refunded', 'fraud']);

function ms(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function soft(reason, billingMode) {
  return { kind: billingMode === 'revenuecat' ? 'soft' : 'block', reason, failOpen: false };
}

export function evaluateEntitlementProjection(projection, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const billingMode = options.billingMode === 'revenuecat' ? 'revenuecat' : 'legacy';
  const failOpenHours = Number.isFinite(options.failOpenHours) ? Number(options.failOpenHours) : 72;
  if (!projection) return soft('subscription_required', billingMode);

  const status = String(projection.status || 'unknown');
  const provider = String(projection.provider || '').toLowerCase();
  const perpetualProvider = provider === 'system' || provider === 'manual';
  const periodEnd = ms(projection.current_period_end);
  const trialEnd = ms(projection.trial_ends_at);
  const failOpenUntil = ms(projection.fail_open_until);
  const lastVerifiedAt = ms(projection.last_verified_at);
  const recentlyVerified = lastVerifiedAt && lastVerifiedAt + failOpenHours * 3_600_000 > now;

  if (HARD_BLOCKS.has(status)) return { kind: 'block', reason: status, failOpen: false };
  if (status === 'trialing') {
    const end = trialEnd || periodEnd;
    return end > now
      ? { kind: 'allow', reason: 'trialing', failOpen: false }
      : soft(end ? 'trial_expired' : 'billing_unverified', billingMode);
  }
  if (status === 'active') {
    if (periodEnd > now || (!periodEnd && perpetualProvider)) {
      return { kind: 'allow', reason: 'active', failOpen: false };
    }
    if (failOpenUntil > now) return { kind: 'allow', reason: 'billing_grace', failOpen: true };
    if (recentlyVerified) return { kind: 'allow', reason: 'billing_recently_verified', failOpen: true };
    return soft(periodEnd ? 'subscription_expired' : 'billing_unverified', billingMode);
  }
  if (status === 'cancelled_at_period_end') {
    return periodEnd > now
      ? { kind: 'allow', reason: 'cancelled_at_period_end', failOpen: false }
      : soft(periodEnd ? 'subscription_expired' : 'billing_unverified', billingMode);
  }
  if (status === 'grace' || status === 'past_due' || status === 'unknown') {
    if (periodEnd > now || failOpenUntil > now) return { kind: 'allow', reason: 'billing_grace', failOpen: true };
    if (recentlyVerified) return { kind: 'allow', reason: 'billing_recently_verified', failOpen: true };
    return { kind: 'block', reason: 'billing_unverified', failOpen: false };
  }
  if (status === 'expired') return soft('subscription_expired', billingMode);
  return soft('subscription_required', billingMode);
}
