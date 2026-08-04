const test = require('node:test');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const hour = 3_600_000;
const now = Date.parse('2026-07-21T12:00:00Z');
const iso = (delta) => new Date(now + delta).toISOString();

async function modules() {
  const evaluator = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/entitlement-evaluator.mjs')).href);
  const billing = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/billing-policy.mjs')).href);
  return { ...evaluator, ...billing };
}

function loadEntitlements() {
  const source = fs.readFileSync(
    path.join(root, 'supabase/functions/_shared/entitlements.ts'),
    'utf8',
  );
  const compiled = esbuild.transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2022',
  }).code;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier.endsWith('billing-policy.mjs')) {
        return { shouldAdminBypass: () => false };
      }
      if (specifier.endsWith('entitlement-evaluator.mjs')) {
        return {
          evaluateEntitlementProjection(projection) {
            const status = String(projection?.status || 'none');
            if (['revoked', 'refunded', 'fraud'].includes(status)) {
              return { kind: 'block', reason: status, failOpen: false };
            }
            if (status === 'active') {
              return { kind: 'allow', reason: 'active', failOpen: false };
            }
            return {
              kind: 'soft',
              reason: 'subscription_required',
              failOpen: false,
            };
          },
        };
      }
      throw new Error(`unexpected module ${specifier}`);
    },
    Deno: {
      env: {
        get(name) {
          if (name === 'NORVA_BILLING_MODE') return 'revenuecat';
          if (name === 'NORVA_ENTITLEMENTS_MODE') return 'enforce';
          return undefined;
        },
      },
    },
    Date,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Set,
    Map,
    RegExp,
    Math,
  });
  return module.exports;
}

function entitlementDb(projection, reconciliation) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push({ kind: 'from', table });
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: projection, error: null }; },
      };
    },
    async rpc(name, args) {
      calls.push({ kind: 'rpc', name, args });
      return typeof reconciliation === 'function'
        ? reconciliation()
        : { data: reconciliation, error: null };
    },
  };
}

function accessReconciliation({
  providerName,
  providerStatus = null,
  providerActive = false,
  hardBlock = false,
  providerReason,
  providerFailOpen = false,
  currentPeriodEnd = null,
  trialEndsAt = null,
  failOpenUntil = null,
  lastVerifiedAt = null,
  overlayStatus = 'active',
  activeGrant = {
    key: `cag_${'a'.repeat(24)}`,
    status: 'active',
    plan_code: 'plus',
    remaining_seconds: 2_592_000,
    active_from: '2026-08-04T10:00:00Z',
    active_until: '2026-09-03T10:00:00Z',
  },
  queuedGrants = 0,
  remainingSeconds = 2_592_000,
} = {}) {
  const resolvedProviderName = providerName === undefined
    ? (providerStatus === null ? null : 'google_play')
    : providerName;
  const resolvedProviderReason = providerReason === undefined
    ? (providerStatus === null
      ? 'subscription_required'
      : hardBlock
        ? providerStatus
        : providerActive
          ? (providerStatus === 'trialing'
            ? 'trialing'
            : providerStatus === 'cancelled_at_period_end'
              ? 'cancelled_at_period_end'
              : 'active')
          : providerStatus === 'expired'
            ? 'subscription_expired'
            : 'billing_unverified')
    : providerReason;
  return {
    schema_version: 1,
    action: 'access_grants_reconciled',
    provider: {
      provider: resolvedProviderName,
      status: providerStatus,
      active: providerActive,
      hard_block: hardBlock,
      reason: resolvedProviderReason,
      fail_open: providerFailOpen,
      current_period_end: currentPeriodEnd,
      trial_ends_at: trialEndsAt,
      fail_open_until: failOpenUntil,
      last_verified_at: lastVerifiedAt,
    },
    overlay: {
      status: overlayStatus,
      active_grant: activeGrant,
      queued_grants: queuedGrants,
      remaining_seconds: remainingSeconds,
    },
  };
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

test('Partners access grant overlays provider access without writing the provider projection', async () => {
  const { getEntitlementDecision } = loadEntitlements();
  const db = entitlementDb(null, accessReconciliation());
  const decision = await getEntitlementDecision(db, '11111111-1111-4111-8111-111111111111');

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'partners_access_credit');
  assert.equal(decision.planCode, 'plus');
  assert.deepEqual(
    db.calls.map((call) => call.kind === 'rpc' ? call.name : call.table),
    ['cloud_entitlement_projection', 'partners_service_access_grants_reconcile'],
  );
  assert.equal(db.calls.some((call) => call.kind === 'from' && call.table === 'cloud_access_grants'), false);
});

test('provider hard blocks win and an unavailable or malformed grant overlay fails closed', async () => {
  const { getEntitlementDecision } = loadEntitlements();
  const fraudDb = entitlementDb({ status: 'fraud', plan_code: 'family' }, accessReconciliation());
  const fraud = await getEntitlementDecision(
    fraudDb,
    '11111111-1111-4111-8111-111111111111',
  );
  assert.equal(fraud.allowed, false);
  assert.equal(fraud.reason, 'fraud');
  assert.equal(fraudDb.calls.some((call) => call.kind === 'rpc'), false);

  for (const reconciliation of [
    () => ({ data: null, error: { code: '503' } }),
    { schema_version: 1, action: 'access_grants_reconciled' },
  ]) {
    const db = entitlementDb(null, reconciliation);
    const decision = await getEntitlementDecision(
      db,
      '11111111-1111-4111-8111-111111111111',
    );
    assert.equal(decision.planCode, 'free');
    assert.equal(decision.reason, 'free_subscription_required');
  }
});

test('active provider access remains authoritative without an overlay RPC on the hot path', async () => {
  const { getEntitlementDecision } = loadEntitlements();
  const projection = {
    user_id: '11111111-1111-4111-8111-111111111111',
    provider: 'google_play',
    plan_code: 'plus',
    status: 'active',
    limits: {},
  };
  const reconciliation = accessReconciliation({
    providerStatus: 'active',
    providerActive: true,
    overlayStatus: 'paused_provider',
    activeGrant: null,
    queuedGrants: 1,
    remainingSeconds: 0,
  });
  const db = entitlementDb(projection, reconciliation);
  const decision = await getEntitlementDecision(
    db,
    '11111111-1111-4111-8111-111111111111',
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'active');
  assert.equal(decision.planCode, 'plus');
  assert.deepEqual(
    db.calls.map((call) => call.kind === 'rpc' ? call.name : call.table),
    ['cloud_entitlement_projection'],
  );
});
