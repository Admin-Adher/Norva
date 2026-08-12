'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(
  path.join(root, relativePath),
  'utf8',
).replace(/\r\n/g, '\n');
const helperSource = read('supabase/functions/_shared/partners-api.ts');
const edgeSource = read('supabase/functions/norva-partners/index.ts');
const entitlementSource = read('supabase/functions/_shared/entitlements.ts');
const cloudSource = read('public/js/cloudApi.js');
const migrationSource = read(
  'supabase/migrations/20260804173000_partners_frictionless_membership_credits.sql',
);
const payoutMigrationSource = read(
  'supabase/migrations/20260804173500_partners_payout_country_and_member_link_v2.sql',
);
const releaseMigrationSource = read(
  'supabase/migrations/20260804174000_partners_frictionless_release_controls.sql',
);
const bootstrapBooleanMigrationSource = read(
  'supabase/migrations/20260809090000_partners_bootstrap_nonmember_boolean.sql',
);
const referralVisibilityMigrationSource = read(
  'supabase/migrations/20260811130059_partners_referral_visibility.sql',
);
const deletedReferralVisibilityMigrationSource = read(
  'supabase/migrations/20260812002500_partners_referral_visibility_deleted_accounts.sql',
);
const visibleReferralNumberingMigrationSource = read(
  'supabase/migrations/20260812082001_partners_referral_visible_numbering.sql',
);
const privacySource = read('public/privacy.html');

function helpers() {
  const compiled = esbuild.transformSync(helperSource, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2022',
  }).code;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    URL,
    URLSearchParams,
    Date,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Set,
    RegExp,
    Math,
  });
  return module.exports;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function envelope(data) {
  return {
    version: '2026-07-29',
    correlationId: 'partners-frictionless-contract',
    data,
  };
}

function activeOverlay() {
  return {
    status: 'active',
    active_grant: {
      key: `cag_${'a'.repeat(24)}`,
      status: 'active',
      plan_code: 'plus',
      remaining_seconds: 2_592_000,
      active_from: '2026-08-04T10:00:00Z',
      active_until: '2026-09-03T10:00:00Z',
    },
    queued_grants: 0,
    remaining_seconds: 2_592_000,
  };
}

function validJoin() {
  return {
    schema_version: 2,
    action: 'membership_joined',
    replayed: false,
    membership: {
      status: 'active',
      joined_at: '2026-08-04T10:00:00Z',
      verification_status: 'not_started',
    },
    program: {
      commission_rate_bps: 2000,
      attribution_window_days: 30,
      maturation_days: 45,
      terms_version: 'partners-global-v1',
      disclosure_version: 'partners-global-v1',
    },
    link: {
      status: 'active',
      share_url: `https://norva.tv/r/${'A'.repeat(32)}`,
      created_at: '2026-08-04T10:00:00Z',
    },
    cash_readiness: { ready: false, reason: 'payout_country_required' },
    next_action: 'share_link',
  };
}

function validLinkV2() {
  return {
    schema_version: 2,
    action: 'link_rotated',
    replayed: false,
    membership: {
      status: 'active',
      joined_at: '2026-08-04T10:00:00Z',
      verification_status: 'not_started',
    },
    link: {
      status: 'active',
      share_url: `https://norva.tv/r/${'B'.repeat(32)}`,
      rotated_at: '2026-08-04T10:01:00Z',
    },
    next_action: 'share_link',
  };
}

function validPayoutCountry() {
  return {
    schema_version: 1,
    action: 'payout_country_bound',
    replayed: false,
    account: {
      id: `prt_${'e'.repeat(24)}`,
      status: 'pending_verification',
      country_code: 'FR',
    },
    cash_readiness: { ready: false, reason: 'kyc_required' },
  };
}

function validQuote() {
  return {
    schema_version: 2,
    action: 'access_credit_quoted',
    replayed: false,
    quote: {
      key: `crq_${'b'.repeat(24)}`,
      status: 'open',
      currency: 'USD',
      currency_exponent: 2,
      plan_code: 'plus',
      months: 2,
      unit_amount_minor: 499,
      total_amount_minor: 998,
      reference_currency: 'USD',
      reference_currency_exponent: 2,
      reference_unit_amount_minor: 499,
      reference_total_amount_minor: 998,
      fx_rate_snapshot_key: null,
      fx_rate_source: null,
      fx_observed_at: null,
      fx_valid_until: null,
      duration_days: 60,
      expires_at: '2026-08-04T10:15:00Z',
    },
    balance: {
      currency: 'USD',
      currency_exponent: 2,
      available_minor: 1200,
    },
  };
}

function validRedemption() {
  return {
    schema_version: 2,
    action: 'access_credit_redeemed',
    replayed: false,
    redemption: {
      key: `crd_${'c'.repeat(24)}`,
      status: 'granted',
      currency: 'USD',
      currency_exponent: 2,
      amount_minor: 499,
      reference_currency: 'USD',
      reference_currency_exponent: 2,
      reference_amount_minor: 499,
      fx_rate_snapshot_key: null,
      fx_rate_source: null,
      fx_observed_at: null,
      months: 1,
    },
    grant: {
      key: `cag_${'a'.repeat(24)}`,
      status: 'active',
      plan_code: 'plus',
      duration_days: 30,
      remaining_seconds: 2_592_000,
      active_from: '2026-08-04T10:00:00Z',
      active_until: '2026-09-03T10:00:00Z',
    },
    balance: {
      currency: 'USD',
      currency_exponent: 2,
      available_minor: 701,
    },
    overlay: activeOverlay(),
  };
}

function validStatus() {
  return {
    schema_version: 2,
    action: 'access_credit_status',
    balance: {
      currency: 'USD',
      currency_exponent: 2,
      pending_minor: 500,
      available_minor: 701,
      recovery_due_minor: 0,
      redeemed_minor: 499,
    },
    catalog: {
      catalog_key: 'acc_p0_usd_plus_month_v1',
      plan_code: 'plus',
      currency: 'USD',
      currency_exponent: 2,
      unit_amount_minor: 499,
      unit_duration_days: 30,
      minimum_months: 1,
      maximum_months: 12,
      reference_currency: 'USD',
      reference_currency_exponent: 2,
      reference_unit_amount_minor: 499,
      fx_rate_snapshot_key: null,
      fx_rate_source: null,
      fx_observed_at: null,
      fx_valid_until: null,
    },
    next_maturation_at: null,
    credit_readiness: { ready: true, reason: null },
    cash_readiness: { ready: false, reason: 'kyc_required' },
    overlay: activeOverlay(),
    provider: {
      provider: null,
      status: null,
      active: false,
      hard_block: false,
      reason: 'subscription_required',
      fail_open: false,
      current_period_end: null,
      trial_ends_at: null,
      fail_open_until: null,
      last_verified_at: null,
    },
  };
}

function validBootstrapV2() {
  return {
    schema_version: 2,
    flags: {
      partners_enabled: true,
      partners_invite_only: false,
      partners_cash_pilot_allowlist_only: true,
      partners_earnings_enabled: true,
      partners_credit_redemptions_enabled: true,
      partners_payouts_live: false,
    },
    eligibility: { visible: true, eligible: true, reason: 'available' },
    membership: {
      exists: true,
      status: 'active',
      joined_at: '2026-08-04T10:00:00Z',
      verification_status: 'not_started',
    },
    program: {
      commission_rate_bps: 2000,
      attribution_window_days: 30,
      maturation_days: 45,
      terms_version: 'partners-global-v1',
      disclosure_version: 'partners-global-v1',
    },
    link: {
      status: 'active',
      share_url: `https://norva.tv/r/${'A'.repeat(32)}`,
      created_at: '2026-08-04T10:00:00Z',
    },
    credit_readiness: { ready: true, reason: null },
    cash_readiness: { ready: false, reason: 'payout_country_required' },
  };
}

function validDashboardV2() {
  const bootstrap = validBootstrapV2();
  return {
    schema_version: 2,
    membership: bootstrap.membership,
    link: bootstrap.link,
    program: bootstrap.program,
    flags: bootstrap.flags,
    balances: [{
      currency: 'USD',
      currency_exponent: 2,
      pending_minor: 499,
      available_minor: 1200,
      recovery_due_minor: 0,
      redeemed_minor: 499,
    }],
    next_maturation_at: '2026-09-18T10:00:00Z',
    credit_readiness: {
      ready: true,
      reason: null,
      catalog: {
        catalog_key: 'acc_p0_usd_plus_month_v1',
        plan_code: 'plus',
        currency: 'USD',
        currency_exponent: 2,
        unit_amount_minor: 499,
        unit_duration_days: 30,
        minimum_months: 1,
        maximum_months: 12,
        reference_currency: 'USD',
        reference_currency_exponent: 2,
        reference_unit_amount_minor: 499,
        fx_rate_snapshot_key: null,
        fx_rate_source: null,
        fx_observed_at: null,
        fx_valid_until: null,
      },
    },
    cash_readiness: bootstrap.cash_readiness,
    overlay: activeOverlay(),
    provider: {
      provider: null,
      status: null,
      active: false,
      hard_block: false,
      reason: 'subscription_required',
      fail_open: false,
      current_period_end: null,
      trial_ends_at: null,
      fail_open_until: null,
      last_verified_at: null,
    },
    referrals: {
      total: 2,
      items: [{
        key: `ref_${'a'.repeat(24)}`,
        label_number: 2,
        masked_email: 'he••••54@ca••••ey.com',
        status: 'commission_pending',
        attributed_at: '2026-08-04T11:00:00Z',
        first_eligible_payment_at: '2026-08-04T12:00:00Z',
        next_maturation_at: '2026-09-18T12:00:00Z',
      }, {
        key: `ref_${'b'.repeat(24)}`,
        label_number: 1,
        masked_email: null,
        status: 'signed_up',
        attributed_at: '2026-08-04T10:00:00Z',
        first_eligible_payment_at: null,
        next_maturation_at: null,
      }],
      next_cursor: null,
    },
    history: {
      status: 'all',
      items: [{
        key: `led_${'d'.repeat(24)}`,
        type: 'access_credit_redemption',
        status: 'redeemed',
        currency: 'USD',
        currency_exponent: 2,
        amount_minor: 499,
        occurred_at: '2026-08-04T10:00:00Z',
        matures_at: null,
      }],
      next_cursor: null,
    },
  };
}

function loadCloudApi(responder) {
  const requests = [];
  const values = new Map([['norva-cloud-token', 'confirmed-user-token']]);
  const localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const window = {
    NORVA_PARTNERS_API_URL:
      'https://api.norva.tv/functions/v1/norva-partners',
    location: { origin: 'https://norva.tv', search: '', replace() {} },
  };
  const context = vm.createContext({
    window,
    localStorage,
    navigator: {
      userAgent: 'Norva Partners contract test',
      language: 'en-US',
      languages: ['en-US'],
    },
    document: { readyState: 'loading', addEventListener() {} },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => name.toLowerCase() === 'content-type'
            ? 'application/json'
            : null,
        },
        json: async () => clone(responder(url, options, requests.length)),
        text: async () => '',
      };
    },
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    Intl,
    Date,
    Map,
    Set,
    WeakMap,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    JSON,
    Math,
    console: { log() {}, warn() {}, debug() {}, error() {} },
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
  });
  window.window = window;
  vm.runInContext(cloudSource, context, { filename: 'public/js/cloudApi.js' });
  return { cloud: window.NorvaCloud, requests };
}

test('closed request parsers accept only consent, months, opaque quote key and payout country', () => {
  const {
    parseJoinInput,
    parseAccessCreditQuoteInput,
    parseAccessCreditRedemptionInput,
    parsePayoutCountryInput,
  } = helpers();

  assert.deepEqual(clone(parseJoinInput({
    termsAccepted: true,
    disclosureAccepted: true,
  })), { termsAccepted: true, disclosureAccepted: true });
  assert.deepEqual(clone(parseAccessCreditQuoteInput({ months: 12 })), {
    months: 12,
  });
  assert.deepEqual(clone(parseAccessCreditRedemptionInput({
    quoteKey: `crq_${'b'.repeat(24)}`,
  })), { quoteKey: `crq_${'b'.repeat(24)}` });
  assert.deepEqual(clone(parsePayoutCountryInput({ countryCode: 'fr' })), {
    countryCode: 'FR',
  });

  for (const invalid of [
    { termsAccepted: true, disclosureAccepted: true, countryCode: 'FR' },
    { termsAccepted: true, disclosureAccepted: false },
  ]) assert.throws(() => parseJoinInput(invalid));
  for (const invalid of [
    { months: 0 },
    { months: 13 },
    { months: 1, amountMinor: 499 },
    { months: 1, currency: 'USD' },
  ]) assert.throws(() => parseAccessCreditQuoteInput(invalid));
  assert.throws(() => parseAccessCreditRedemptionInput({
    quoteKey: `crq_${'b'.repeat(24)}`,
    amountMinor: 499,
  }));
  for (const invalid of [
    { countryCode: 'FRA' },
    { countryCode: 'FR', currency: 'EUR' },
    { countryCode: 33 },
  ]) assert.throws(() => parsePayoutCountryInput(invalid));
});

test('Edge sanitizers fail closed on price, state and provider contract drift', () => {
  const {
    sanitizeJoinData,
    sanitizeAccessCreditQuoteData,
    sanitizeAccessCreditRedemptionData,
    sanitizeAccessCreditStatusData,
    sanitizeLinkMutationData,
    sanitizePayoutCountryMutationData,
  } = helpers();
  const rawJoin = { ...validJoin(), changed: true };
  assert.equal(
    JSON.stringify(sanitizeJoinData(rawJoin)),
    JSON.stringify(validJoin()),
  );
  const missingChanged = validJoin();
  assert.throws(() => sanitizeJoinData(missingChanged));
  const invalidChanged = { ...validJoin(), changed: 'true' };
  assert.throws(() => sanitizeJoinData(invalidChanged));
  assert.doesNotThrow(() => sanitizeAccessCreditQuoteData(validQuote()));
  assert.doesNotThrow(() => sanitizeAccessCreditRedemptionData(validRedemption()));
  assert.doesNotThrow(() => sanitizeAccessCreditStatusData(validStatus()));
  const unsupportedCurrencyStatus = validStatus();
  unsupportedCurrencyStatus.catalog = null;
  unsupportedCurrencyStatus.credit_readiness = {
    ready: false,
    reason: 'fx_rate_unavailable',
  };
  unsupportedCurrencyStatus.balance = {
    currency: 'USD',
    currency_exponent: 2,
    pending_minor: 0,
    available_minor: 0,
    recovery_due_minor: 0,
    redeemed_minor: 0,
  };
  assert.doesNotThrow(() => sanitizeAccessCreditStatusData(
    unsupportedCurrencyStatus,
  ));
  assert.doesNotThrow(() => sanitizeLinkMutationData(validLinkV2()));
  assert.doesNotThrow(() => sanitizePayoutCountryMutationData(
    validPayoutCountry(),
  ));

  const clientPriced = validQuote();
  clientPriced.quote.reference_unit_amount_minor = 500;
  assert.throws(() => sanitizeAccessCreditQuoteData(clientPriced));
  const extra = validRedemption();
  extra.grant.provider_payload = { raw: true };
  assert.throws(() => sanitizeAccessCreditRedemptionData(extra));
  const hardBlockDrift = validStatus();
  hardBlockDrift.provider.hard_block = true;
  hardBlockDrift.provider.status = 'active';
  assert.throws(() => sanitizeAccessCreditStatusData(hardBlockDrift));
  const paidProvider = validStatus();
  paidProvider.provider = {
    provider: 'google_play',
    status: 'active',
    active: true,
    hard_block: false,
    reason: 'active',
    fail_open: false,
    current_period_end: '2026-09-04T10:00:00Z',
    trial_ends_at: null,
    fail_open_until: null,
    last_verified_at: '2026-08-04T10:00:00Z',
  };
  paidProvider.overlay = {
    status: 'paused_provider',
    active_grant: null,
    queued_grants: 1,
    remaining_seconds: 0,
  };
  assert.doesNotThrow(() => sanitizeAccessCreditStatusData(paidProvider));
  const impossiblePaidProvider = clone(paidProvider);
  impossiblePaidProvider.provider.current_period_end = null;
  assert.throws(() => sanitizeAccessCreditStatusData(impossiblePaidProvider));
  const linkKycGateDrift = validLinkV2();
  linkKycGateDrift.next_action = 'start_kyc';
  assert.throws(() => sanitizeLinkMutationData(linkKycGateDrift));
  const payoutCountryDrift = validPayoutCountry();
  payoutCountryDrift.cash_readiness.reason = 'payout_country_required';
  assert.throws(() => sanitizePayoutCountryMutationData(payoutCountryDrift));
  const payoutStateDrift = validPayoutCountry();
  payoutStateDrift.account.status = 'active';
  assert.throws(() => sanitizePayoutCountryMutationData(payoutStateDrift));
});

test('bootstrap and dashboard v2 stay exact across Edge and Web validators', async () => {
  const { sanitizeBootstrapData, sanitizeDashboardData } = helpers();
  const bootstrap = validBootstrapV2();
  const dashboard = validDashboardV2();
  const bootstrapQuery = { countryCode: null, subdivisionCode: null };
  const dashboardQuery = {
    historyLimit: 25,
    historyCursor: null,
    historyStatus: 'all',
  };

  assert.doesNotThrow(() => sanitizeBootstrapData(bootstrap, bootstrapQuery));
  assert.doesNotThrow(() => sanitizeDashboardData(dashboard, dashboardQuery));

  const nonUsdDashboard = clone(dashboard);
  nonUsdDashboard.balances = [{
    currency: 'EUR',
    currency_exponent: 2,
    pending_minor: 750,
    available_minor: 1250,
    recovery_due_minor: 0,
    redeemed_minor: 0,
  }];
  nonUsdDashboard.credit_readiness = {
    ready: false,
    reason: 'fx_rate_unavailable',
    catalog: null,
  };
  assert.doesNotThrow(() => sanitizeDashboardData(
    nonUsdDashboard,
    dashboardQuery,
  ));

  const multiCurrencyDashboard = clone(dashboard);
  multiCurrencyDashboard.balances.unshift({
    currency: 'EUR',
    currency_exponent: 2,
    pending_minor: 750,
    available_minor: 1250,
    recovery_due_minor: 0,
    redeemed_minor: 0,
  });
  assert.doesNotThrow(() => sanitizeDashboardData(
    multiCurrencyDashboard,
    dashboardQuery,
  ));

  const cashPilotBootstrap = clone(bootstrap);
  cashPilotBootstrap.cash_readiness = {
    ready: false,
    reason: 'cash_pilot_not_allowed',
  };
  assert.doesNotThrow(() => sanitizeBootstrapData(
    cashPilotBootstrap,
    bootstrapQuery,
  ));
  const cashPilotDashboard = clone(dashboard);
  cashPilotDashboard.cash_readiness = clone(cashPilotBootstrap.cash_readiness);
  assert.doesNotThrow(() => sanitizeDashboardData(
    cashPilotDashboard,
    dashboardQuery,
  ));

  const inviteOnly = clone(bootstrap);
  inviteOnly.flags.partners_invite_only = true;
  assert.doesNotThrow(() => sanitizeBootstrapData(inviteOnly, bootstrapQuery));

  const bootstrapDrift = clone(bootstrap);
  bootstrapDrift.flags.partners_credit_redemptions_enabled = false;
  assert.throws(() => sanitizeBootstrapData(bootstrapDrift, bootstrapQuery));
  const cashPilotFlagDrift = clone(cashPilotBootstrap);
  cashPilotFlagDrift.flags.partners_cash_pilot_allowlist_only = false;
  assert.throws(() => sanitizeBootstrapData(cashPilotFlagDrift, bootstrapQuery));
  const legacyPilotEligibilityDrift = clone(inviteOnly);
  legacyPilotEligibilityDrift.eligibility = {
    visible: true,
    eligible: false,
    reason: 'pilot_not_allowed',
  };
  assert.throws(() => sanitizeBootstrapData(
    legacyPilotEligibilityDrift,
    bootstrapQuery,
  ));
  const dashboardDrift = clone(dashboard);
  dashboardDrift.history.items[0].provider_payload = { raw: true };
  assert.throws(() => sanitizeDashboardData(dashboardDrift, dashboardQuery));
  const unsortedBalances = clone(multiCurrencyDashboard);
  unsortedBalances.balances.reverse();
  assert.throws(() => sanitizeDashboardData(unsortedBalances, dashboardQuery));
  const implicitFxDrift = clone(nonUsdDashboard);
  implicitFxDrift.credit_readiness = clone(dashboard.credit_readiness);
  assert.throws(() => sanitizeDashboardData(implicitFxDrift, dashboardQuery));
  const referralPiiDrift = clone(dashboard);
  referralPiiDrift.referrals.items[0].email = 'private@example.test';
  assert.throws(() => sanitizeDashboardData(referralPiiDrift, dashboardQuery));
  const duplicateReferral = clone(dashboard);
  duplicateReferral.referrals.items[1].key = duplicateReferral.referrals.items[0].key;
  assert.throws(() => sanitizeDashboardData(duplicateReferral, dashboardQuery));
  const inconsistentReferralTotal = clone(dashboard);
  inconsistentReferralTotal.referrals.next_cursor =
    'referral_00000000000000000001';
  assert.throws(() => sanitizeDashboardData(
    inconsistentReferralTotal,
    dashboardQuery,
  ));

  const { cloud, requests } = loadCloudApi((url) => {
    if (url.includes('/bootstrap')) return envelope(bootstrap);
    if (url.includes('/dashboard')) return envelope(dashboard);
    throw new Error(`unexpected request ${url}`);
  });
  const webBootstrap = await cloud.partners.bootstrap();
  const webDashboard = await cloud.partners.dashboard();
  assert.equal(webBootstrap.data.schema_version, 2);
  assert.equal(webDashboard.data.schema_version, 2);
  assert.ok(Object.isFrozen(webBootstrap.data));
  assert.ok(Object.isFrozen(webDashboard.data));
  assert.equal(requests.length, 2);

  const rollingDeployDashboard = clone(dashboard);
  delete rollingDeployDashboard.referrals;
  const rollingDeployClient = loadCloudApi(() => envelope(rollingDeployDashboard));
  const compatibleDashboard = await rollingDeployClient.cloud.partners.dashboard();
  assert.equal(compatibleDashboard.data.referrals, null);
  assert.deepEqual(
    clone(compatibleDashboard.data.balances),
    rollingDeployDashboard.balances,
  );
  const unsafeRollingDeployDashboard = clone(rollingDeployDashboard);
  unsafeRollingDeployDashboard.untrusted = true;
  const unsafeRollingDeployClient = loadCloudApi(
    () => envelope(unsafeRollingDeployDashboard),
  );
  await assert.rejects(
    () => unsafeRollingDeployClient.cloud.partners.dashboard(),
    (error) => error?.code === 'partners_contract_invalid',
  );

  const firstReferralPage = {
    total: 2,
    items: [clone(dashboard.referrals.items[0])],
    next_cursor: 'referral_00000000000000000002',
  };
  const finalReferralPage = {
    total: 2,
    items: [clone(dashboard.referrals.items[1])],
    next_cursor: null,
  };
  const referralClient = loadCloudApi((url) => (
    url.includes('cursor=referral_00000000000000000002')
      ? envelope(finalReferralPage)
      : envelope(firstReferralPage)
  ));
  const referralPageOne = await referralClient.cloud.partners.referrals({ limit: 1 });
  const referralPageTwo = await referralClient.cloud.partners.referrals({
    limit: 1,
    cursor: referralPageOne.data.next_cursor,
  });
  assert.deepEqual(clone(referralPageOne.data), firstReferralPage);
  assert.deepEqual(clone(referralPageTwo.data), finalReferralPage);
  assert.match(referralClient.requests[0].url, /\/referrals\?limit=1$/);
  assert.match(
    referralClient.requests[1].url,
    /\/referrals\?limit=1&cursor=referral_00000000000000000002$/,
  );
  assert.doesNotMatch(
    JSON.stringify(referralPageOne),
    /hefex15454@careney\.com|user_id|payment_reference|provider_payload/i,
  );

  const cashPilotClient = loadCloudApi((url) => url.includes('/bootstrap')
    ? envelope(cashPilotBootstrap)
    : envelope(cashPilotDashboard));
  assert.equal(
    (await cashPilotClient.cloud.partners.bootstrap()).data.cash_readiness.reason,
    'cash_pilot_not_allowed',
  );
  assert.equal(
    (await cashPilotClient.cloud.partners.dashboard()).data.cash_readiness.reason,
    'cash_pilot_not_allowed',
  );
  const cashPilotFlagDriftClient = loadCloudApi(() => envelope(
    cashPilotFlagDrift,
  ));
  await assert.rejects(
    () => cashPilotFlagDriftClient.cloud.partners.bootstrap(),
    (error) => error?.code === 'partners_contract_invalid',
  );

  const nonUsdClient = loadCloudApi(() => envelope(nonUsdDashboard));
  const webNonUsd = await nonUsdClient.cloud.partners.dashboard();
  assert.equal(webNonUsd.data.balances[0].currency, 'EUR');
  assert.equal(
    webNonUsd.data.credit_readiness.reason,
    'fx_rate_unavailable',
  );
});

test('access-credit SQLSTATEs map to one controlled public matrix', () => {
  const { mapDatabaseError } = helpers();
  const expected = {
    P1001: [409, 'membership_required'],
    P1002: [409, 'credits_disabled'],
    P1003: [409, 'quote_expired'],
    P1004: [409, 'insufficient_balance'],
    P1005: [503, 'catalog_unavailable'],
    P1006: [409, 'quote_conflict'],
    P1007: [422, 'payout_country_unavailable'],
  };
  for (const [sqlstate, [status, code]] of Object.entries(expected)) {
    const mapped = mapDatabaseError({
      code: sqlstate,
      message: 'private SQL detail must never cross the boundary',
    }, 'guarded_action');
    assert.equal(mapped.status, status);
    assert.equal(mapped.code, code);
    assert.doesNotMatch(mapped.message, /private|sql/i);
    assert.match(
      sqlstate === 'P1007' ? payoutMigrationSource : migrationSource,
      new RegExp(`errcode = '${sqlstate}'`),
    );
    assert.match(cloudSource, new RegExp(`'${code}'`));
  }
  assert.equal(
    mapDatabaseError({ code: '55000', message: 'private invariant' }).code,
    'partners_temporarily_unavailable',
  );
});

test('Web client sends exact routes and reuses caller idempotency keys', async () => {
  let quoteCalls = 0;
  const responder = (url) => {
    if (url.endsWith('/join')) return envelope(validJoin());
    if (url.endsWith('/links')) return envelope(validLinkV2());
    if (url.endsWith('/payout-country')) return envelope(validPayoutCountry());
    if (url.endsWith('/credit/quotes')) {
      const quoted = validQuote();
      quoteCalls += 1;
      quoted.replayed = quoteCalls > 1;
      return envelope(quoted);
    }
    if (url.endsWith('/credit/redemptions')) return envelope(validRedemption());
    if (url.endsWith('/credit/status')) return envelope(validStatus());
    throw new Error(`unexpected request ${url}`);
  };
  const { cloud, requests } = loadCloudApi(responder);
  const joinKey = 'partners.join.1234567890abcdef';
  const linkKey = 'partners.link.1234567890abcdef';
  const payoutCountryKey = 'partners.country.1234567890abcdef';
  const quoteKey = 'partners.quote.1234567890abcdef';
  const redeemKey = 'partners.redeem.1234567890abcdef';
  await cloud.partners.join({
    termsAccepted: true,
    disclosureAccepted: true,
    idempotencyKey: joinKey,
  });
  const link = await cloud.partners.rotateLink({ idempotencyKey: linkKey });
  await cloud.partners.bindPayoutCountry({
    countryCode: 'fr',
    idempotencyKey: payoutCountryKey,
  });
  await cloud.partners.credit.quote({ months: 2, idempotencyKey: quoteKey });
  const replay = await cloud.partners.credit.quote({
    months: 2,
    idempotencyKey: quoteKey,
  });
  await cloud.partners.credit.redeem({
    quoteKey: `crq_${'b'.repeat(24)}`,
    idempotencyKey: redeemKey,
  });
  await cloud.partners.credit.status();

  assert.equal(link.data.membership.verification_status, 'not_started');
  assert.equal(replay.data.replayed, true);
  assert.equal(requests.length, 7);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    termsAccepted: true,
    disclosureAccepted: true,
  });
  assert.deepEqual(JSON.parse(requests[1].options.body), {});
  assert.equal(requests[1].options.headers['Idempotency-Key'], linkKey);
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    countryCode: 'FR',
  });
  assert.equal(
    requests[2].options.headers['Idempotency-Key'],
    payoutCountryKey,
  );
  assert.deepEqual(JSON.parse(requests[3].options.body), { months: 2 });
  assert.deepEqual(JSON.parse(requests[4].options.body), { months: 2 });
  assert.equal(requests[3].options.headers['Idempotency-Key'], quoteKey);
  assert.equal(requests[4].options.headers['Idempotency-Key'], quoteKey);
  assert.deepEqual(JSON.parse(requests[5].options.body), {
    quoteKey: `crq_${'b'.repeat(24)}`,
  });
  assert.equal(requests[6].options.method, 'GET');
  assert.equal(requests[6].url,
    'https://api.norva.tv/functions/v1/norva-partners/credit/status');
  for (const request of requests) {
    assert.equal(request.options.headers['x-norva-profile-id'], undefined);
  }
});

test('join replays never reintroduce KYC as a membership prerequisite', async () => {
  for (const reason of [
    'payout_country_required',
    'kyc_required',
    'fiscal_profile_required',
    'corridor_required',
  ]) {
    const joined = validJoin();
    joined.cash_readiness = { ready: false, reason };
    const { cloud } = loadCloudApi(() => envelope(joined));
    const response = await cloud.partners.join({
      termsAccepted: true,
      disclosureAccepted: true,
      idempotencyKey: `partners.join.${reason}.1234567890`,
    });
    assert.equal(response.data.next_action, 'share_link');
    assert.equal(response.data.membership.status, 'active');
  }
});

test('membership is public while the cash pilot remains independently allowlisted', () => {
  const joinStart = migrationSource.indexOf(
    'affiliate_private.partners_service_join_v2(',
  );
  const joinEnd = migrationSource.indexOf(
    'affiliate_private.partners_service_access_grants_reconcile(',
    joinStart,
  );
  const join = migrationSource.slice(joinStart, joinEnd);
  assert.ok(joinStart > 0 && joinEnd > joinStart);
  assert.match(join, /email_confirmed_at is not null/);
  assert.match(join, /member_status,\s*[\s\S]*?'active'/);
  assert.doesNotMatch(join, /partners_invite_only|affiliate_pilot_allowlist/);

  const bootstrapStart = migrationSource.indexOf(
    'affiliate_private.partners_service_bootstrap_v2(',
  );
  const bootstrapEnd = migrationSource.indexOf(
    'affiliate_private.partners_service_dashboard_v2(',
    bootstrapStart,
  );
  const bootstrap = migrationSource.slice(bootstrapStart, bootstrapEnd);
  assert.match(bootstrap, /'partners_cash_pilot_allowlist_only'/);
  assert.doesNotMatch(bootstrap, /pilot_not_allowed/);
  assert.match(
    payoutMigrationSource,
    /flag\.key = 'partners_cash_pilot_allowlist_only'[\s\S]*?'cash_pilot_not_allowed'/,
  );
  assert.match(
    bootstrapBooleanMigrationSource,
    /'ready',\s*coalesce\([\s\S]*?v_account\.member_status = 'active'[\s\S]*?and v_credits_enabled,[\s\S]*?false[\s\S]*?\)/,
  );
});

test('referral visibility uses a server-masked recognition hint and remains service-role only', () => {
  const helperStart = referralVisibilityMigrationSource.indexOf(
    'affiliate_private.partners_service_referral_visibility(',
  );
  const helperEnd = referralVisibilityMigrationSource.indexOf(
    'revoke all on function\n  affiliate_private.partners_service_referral_visibility(',
    helperStart,
  );
  const helper = referralVisibilityMigrationSource.slice(helperStart, helperEnd);
  assert.ok(helperStart > 0 && helperEnd > helperStart);
  assert.match(helper, /stable\s+security definer\s+set search_path = ''/);
  assert.match(helper, /p_limit > 50/);
  assert.match(helper, /limit p_limit \+ 1/);
  assert.match(helper, /\^referral_\[0-9\]\{20\}\$/);
  assert.match(helper, /'ref_' \|\| left\([\s\S]*?extensions\.digest/);
  assert.match(helper, /'label_number'/);
  assert.match(helper, /left join auth\.users referred_user/);
  assert.match(helper, /'masked_email', projected\.masked_email/);
  assert.match(helper, /repeat\('•', 4\)/);
  assert.match(helper, /'next_cursor'/);
  assert.doesNotMatch(helper, /'referred_user_id'|'payment_identifier'/i);
  assert.match(
    privacySource,
    /partially hidden email recognition hint[\s\S]*full address is never displayed[\s\S]*not stored as a separate contact record/i,
  );
  assert.match(
    referralVisibilityMigrationSource,
    /revoke all on function\s+affiliate_private\.partners_service_referral_visibility\(uuid, integer, text\)[\s\S]*?from public, anon, authenticated, service_role/,
  );
  assert.match(
    referralVisibilityMigrationSource,
    /grant execute on function\s+affiliate_private\.partners_service_referral_visibility\(uuid, integer, text\)[\s\S]*?to service_role/,
  );
  assert.match(
    referralVisibilityMigrationSource,
    /create or replace function public\.partners_service_referral_visibility\([\s\S]*?security invoker[\s\S]*?p_limit,[\s\S]*?p_cursor/,
  );
  assert.match(
    referralVisibilityMigrationSource,
    /public\.partners_service_dashboard_v2\([\s\S]*?'referrals',[\s\S]*?partners_service_referral_visibility\([\s\S]*?p_user_id,[\s\S]*?20,[\s\S]*?null/,
  );
});

test('deleted referral accounts remain in audit but disappear from member visibility', () => {
  assert.match(
    deletedReferralVisibilityMigrationSource,
    /and attribution\.referred_user_id is not null/,
  );
  assert.match(
    deletedReferralVisibilityMigrationSource,
    /select\\n\s+attribution\.referred_user_id,\\n\s+row_number\(\) over/,
  );
  assert.match(
    deletedReferralVisibilityMigrationSource,
    /where numbered\.referred_user_id is not null[\s\S]*?numbered\.referral_number < v_cursor_number/,
  );
  assert.match(
    deletedReferralVisibilityMigrationSource,
    /revoke all on function\s+affiliate_private\.partners_service_referral_visibility\(uuid, integer, text\)[\s\S]*?from public, anon, authenticated, service_role/,
  );
  assert.match(
    deletedReferralVisibilityMigrationSource,
    /grant execute on function\s+affiliate_private\.partners_service_referral_visibility\(uuid, integer, text\)[\s\S]*?to service_role/,
  );
});

test('member-facing referral labels are contiguous after account deletion', () => {
  assert.match(
    visibleReferralNumberingMigrationSource,
    /where attribution\.referrer_account_id = v_account_id\\n\s+and attribution\.referred_user_id is not null\\n\s+\),/,
  );
  assert.match(
    visibleReferralNumberingMigrationSource,
    /v_occurrences <> 2[\s\S]*?referral numbering source contract drifted/,
  );
  assert.match(
    visibleReferralNumberingMigrationSource,
    /regexp_count\([\s\S]*?and attribution\\\.referred_user_id is not null[\s\S]*?\) <> 3/,
  );
  assert.match(
    visibleReferralNumberingMigrationSource,
    /position\([\s\S]*?where numbered\.referred_user_id is not null[\s\S]*?\) > 0/,
  );
  assert.match(
    visibleReferralNumberingMigrationSource,
    /revoke all on function\s+affiliate_private\.partners_service_referral_visibility\(uuid, integer, text\)[\s\S]*?from public, anon, authenticated, service_role/,
  );
  assert.match(
    visibleReferralNumberingMigrationSource,
    /grant execute on function\s+affiliate_private\.partners_service_referral_visibility\(uuid, integer, text\)[\s\S]*?to service_role/,
  );
});

test('referral visibility migrations preserve their creator or pre-existing owner', () => {
  const migrations = [
    referralVisibilityMigrationSource,
    deletedReferralVisibilityMigrationSource,
    visibleReferralNumberingMigrationSource,
  ];

  for (const migration of migrations) {
    assert.doesNotMatch(
      migration,
      /owner to supabase_admin/i,
      'blank-database replays must not require cross-role SET ROLE authority',
    );
  }
  assert.match(
    deletedReferralVisibilityMigrationSource,
    /select proowner[\s\S]*?into v_original_owner[\s\S]*?execute v_rewritten;[\s\S]*?proowner from pg_proc where oid = v_oid\)[\s\S]*?<> v_original_owner/,
  );
  assert.match(
    visibleReferralNumberingMigrationSource,
    /select proowner[\s\S]*?into v_original_owner[\s\S]*?execute v_rewritten;[\s\S]*?proowner from pg_proc where oid = v_oid\)[\s\S]*?<> v_original_owner/,
  );
});

test('sharing remains bound to membership while legacy cash status can change independently', () => {
  assert.match(
    migrationSource,
    /create trigger affiliate_accounts_member_active_link_guard[\s\S]*?drop trigger if exists affiliate_accounts_active_link_guard\s+on affiliate_private\.affiliate_accounts/,
  );
});

test('restored financial gates accept whitespace drift but fail closed on semantic drift', () => {
  const rewriteStart = migrationSource.indexOf(
    'do $partners_member_predicate_upgrade$',
  );
  const rewriteEnd = migrationSource.indexOf(
    '$partners_member_predicate_upgrade$;',
    rewriteStart + 1,
  );
  const rewrite = migrationSource.slice(rewriteStart, rewriteEnd);
  const exactReplacementMatrix = rewrite.slice(
    rewrite.indexOf('from (values'),
    rewrite.indexOf(') as changes(signature, old_fragment, new_fragment)'),
  );

  assert.ok(rewriteStart > 0 && rewriteEnd > rewriteStart);
  assert.match(rewrite, /v_financial_gate_pattern constant text/);
  assert.match(rewrite, /and\[\[:space:\]\]\*\\\(/);
  assert.match(rewrite, /regexp_count\(v_definition, v_financial_gate_pattern\) <> 1/);
  assert.match(
    rewrite,
    /regexp_replace\([\s\S]*?v_financial_gate_pattern,[\s\S]*?v_financial_gate_replacement/,
  );
  assert.match(rewrite, /where f\\\.key = 'partners_shadow_mode'/);
  assert.match(rewrite, /where f\\\.key = 'partners_payouts_live'/);
  assert.match(rewrite, /where flag\.key = ''partners_earnings_enabled''/);
  assert.doesNotMatch(exactReplacementMatrix, /partners_shadow_mode|partners_payouts_live/);
});

test('every restored routine rewrite normalizes CRLF before exact contract checks', () => {
  for (const [source, expectedDefinitions] of [
    [migrationSource, 4],
    [payoutMigrationSource, 4],
    [releaseMigrationSource, 3],
  ]) {
    const definitions = source.match(/pg_get_functiondef\([^\n]+\)/g) || [];
    const normalizations = source.match(
      /replace\(\s*pg_get_functiondef\([^)]*\),\s*chr\(13\) \|\| chr\(10\),\s*chr\(10\)\s*\)/g,
    ) || [];
    assert.equal(definitions.length, expectedDefinitions);
    assert.equal(normalizations.length, expectedDefinitions);
  }
});

test('frictionless idempotency extends every legacy operation without narrowing it', () => {
  const requiredOperations = [
    'application',
    'terms_acceptance',
    'link_rotation',
    'kyc_prepare',
    'kyc_session_record',
    'referral_claim',
    'payout_profile',
    'tv_relay_consume',
    'access_request',
    'fiscal_profile_self_attestation',
    'payout_onboarding',
    'membership_join',
    'access_credit_quote',
    'access_credit_redeem',
  ];
  const membershipConstraint = migrationSource.slice(
    migrationSource.indexOf(
      'add constraint affiliate_service_idempotency_operation',
    ),
    migrationSource.indexOf(
      '-- The Edge boundary reserves a durable slot',
    ),
  );
  const payoutConstraint = payoutMigrationSource.slice(
    payoutMigrationSource.indexOf(
      'add constraint affiliate_service_idempotency_operation_v4',
    ),
    payoutMigrationSource.indexOf(
      'create index if not exists affiliate_service_idempotency_country_bind_idx',
    ),
  );

  for (const operation of requiredOperations) {
    assert.match(membershipConstraint, new RegExp(`'${operation}'`));
    assert.match(payoutConstraint, new RegExp(`'${operation}'`));
  }
  assert.match(payoutConstraint, /'payout_country_bind'/);
});

test('Didit KYC is locked to the explicit cash journey before every prepare branch', () => {
  const guardStart = payoutMigrationSource.indexOf(
    'affiliate_private.partners_assert_kyc_cash_eligibility(p_user_id uuid)',
  );
  const rewriteStart = payoutMigrationSource.indexOf(
    'do $partners_kyc_cash_only_guard$',
  );
  const guard = payoutMigrationSource.slice(guardStart, rewriteStart);
  assert.ok(guardStart > 0 && rewriteStart > guardStart);
  assert.match(guard, /volatile\s+security definer/);
  assert.match(guard, /pg_advisory_xact_lock\([\s\S]*norva:partners:user:/);
  assert.match(guard, /member_status <> 'active'[\s\S]*errcode = 'P1001'/);
  assert.match(guard, /country_code is null[\s\S]*country_policy_id is null/);
  assert.match(guard, /execution_adapter = 'revolut_manual'/);
  assert.match(guard, /for update/);
  const rewrite = payoutMigrationSource.slice(rewriteStart);
  const consentValidation = rewrite.indexOf(
    "raise exception 'invalid versioned biometric consent'",
  );
  const cashGuard = rewrite.indexOf(
    'perform affiliate_private.partners_assert_kyc_cash_eligibility(p_user_id);',
  );
  const accountRead = rewrite.indexOf('select account.id', cashGuard);
  assert.ok(
    consentValidation > 0 && cashGuard > consentValidation && accountRead > cashGuard,
    'the canonical KYC rewrite must validate biometric consent, then prove cash eligibility, then read the account',
  );
  assert.match(
    rewrite.slice(consentValidation, cashGuard),
    /using errcode = '22023'/,
  );
  assert.match(
    payoutMigrationSource,
    /revoke all on function\s+affiliate_private\.partners_assert_kyc_cash_eligibility\(uuid\)[\s\S]*?from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(
    payoutMigrationSource,
    /grant execute on function\s+affiliate_private\.partners_assert_kyc_cash_eligibility\(uuid\)/,
  );
});

test('Edge boundary requires confirmed auth, bounded timeouts and service-only RPCs', () => {
  for (const route of [
    '/join',
    '/credit/quotes',
    '/credit/redemptions',
    '/credit/status',
    '/payout-country',
  ]) assert.match(edgeSource, new RegExp(`route === "${route.replaceAll('/', '\\/')}"`));
  assert.match(edgeSource, /email_confirmed_at/);
  assert.match(edgeSource, /"guarded_action",\s*8_000/);
  assert.match(edgeSource, /AbortSignal\.timeout\(timeoutMs\)/);
  assert.match(entitlementSource,
    /db\.rpc\(\s*"partners_service_access_grants_reconcile"/);
  assert.doesNotMatch(
    entitlementSource.slice(
      entitlementSource.indexOf('async function reconcileAccessGrantOverlay'),
      entitlementSource.indexOf('function sanitizeAccessGrantReconciliation'),
    ),
    /cloud_entitlement_projection|\.from\(/,
  );

  for (const signature of [
    'public.partners_service_join_v2(uuid,boolean,boolean,text)',
    'public.partners_service_access_credit_quote(uuid,integer,text)',
    'public.partners_service_access_credit_redeem(uuid,text,text)',
    'public.partners_service_access_grants_reconcile(uuid)',
    'public.partners_service_access_credit_status(uuid)',
  ]) {
    assert.match(migrationSource, new RegExp(
      `revoke all on function\\s+${signature.replace(/[().]/g, '\\$&')}[\\s\\S]*?from public, anon, authenticated, service_role`,
    ));
    assert.match(migrationSource, new RegExp(
      `grant execute on function\\s+${signature.replace(/[().]/g, '\\$&')}[\\s\\S]*?to service_role`,
    ));
  }
  for (const signature of [
    'public.partners_service_payout_country_bind(uuid,text,text)',
    'public.partners_service_rotate_link(uuid,text)',
  ]) {
    const signaturePattern = signature
      .replace(/[().]/g, '\\$&')
      .replaceAll(',', ',\\s*');
    assert.match(payoutMigrationSource, new RegExp(
      `revoke all on function\\s+${signaturePattern}[\\s\\S]*?from public, anon, authenticated`,
    ));
    assert.match(payoutMigrationSource, new RegExp(
      `grant execute on function\\s+${signaturePattern}[\\s\\S]*?to service_role`,
    ));
  }
});
