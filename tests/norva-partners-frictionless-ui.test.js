'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const pageSource = fs.readFileSync(path.join(root, 'public/js/pages/PartnersPage.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'public/css/main.css'), 'utf8');

function control({ checked = false, value = '', textContent = '' } = {}) {
  const listeners = new Map();
  return {
    checked,
    value,
    textContent,
    disabled: false,
    isConnected: true,
    listeners,
    attributes: new Map(),
    addEventListener(type, listener) { listeners.set(type, listener); },
    setAttribute(name, next) { this.attributes.set(name, String(next)); },
    removeAttribute(name) { this.attributes.delete(name); },
    focus() {},
    matches() { return false; },
  };
}

function loadPage({ partners = {} } = {}) {
  const container = {
    innerHTML: '',
    classList: { add() {}, remove() {} },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const window = {
    NorvaCloud: {
      token: 'test-token',
      partners: {
        bootstrap: async () => { throw new Error('unused'); },
        ...partners,
      },
    },
  };
  const document = {
    activeElement: null,
    body: {},
    documentElement: { lang: 'en' },
    getElementById: (id) => (id === 'page-partners' ? container : null),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  const context = vm.createContext({
    window,
    document,
    navigator: { userAgent: '', language: 'en-US', onLine: true },
    history: { back() {} },
    location: { assign() {} },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    AbortController,
    Intl,
    Date,
    Map,
    Set,
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
    requestAnimationFrame: (callback) => { callback(); return 1; },
    cancelAnimationFrame() {},
    setTimeout: () => 1,
    clearTimeout() {},
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  });
  window.window = window;
  vm.runInContext(pageSource, context, { filename: 'public/js/pages/PartnersPage.js' });
  const page = new window.PartnersPage({
    currentUser: { cloud: true, device: false },
    navigateTo() {},
  });
  page._visible = true;
  return { page, container, window, document };
}

function bootstrapV2({ membership = false, verificationStatus = 'not_started' } = {}) {
  return {
    schema_version: 2,
    flags: {
      partners_enabled: true,
      partners_invite_only: false,
      partners_earnings_enabled: true,
      partners_credit_redemptions_enabled: true,
      partners_payouts_live: false,
    },
    eligibility: { visible: true, eligible: !membership, reason: 'available' },
    membership: {
      exists: membership,
      status: membership ? 'active' : 'not_joined',
      joined_at: membership ? '2026-08-04T12:00:00Z' : null,
      verification_status: membership ? verificationStatus : null,
    },
    program: {
      commission_rate_bps: 2000,
      attribution_window_days: 30,
      maturation_days: 45,
      terms_version: 'partners-global-v1',
      disclosure_version: 'partners-global-v1',
    },
    link: membership ? {
      status: 'active',
      share_url: `https://norva.tv/r/${'A'.repeat(32)}`,
      created_at: '2026-08-04T12:00:00Z',
    } : null,
    credit_readiness: { ready: membership, reason: membership ? null : 'membership_required' },
    cash_readiness: { ready: false, reason: 'kyc_required' },
  };
}

test('confirmed users see immediate no-KYC membership before any cash setup', () => {
  const { page, container } = loadPage();
  page.renderMembershipBootstrap(bootstrapV2());

  assert.match(container.innerHTML, /Join and get my link/);
  assert.match(container.innerHTML, /No identity documents, tax details or payout destination are requested/);
  assert.match(container.innerHTML, /Use available balance for Norva access without identity verification/);
  assert.match(container.innerHTML, /How Norva Partners works/);
  assert.match(container.innerHTML, /More information about Commission on eligible payments/);
  assert.match(container.innerHTML, /Example: if the eligible amount after discounts and before tax is US\$5/);
  assert.doesNotMatch(container.innerHTML, /partners-global-v1/);
  assert.doesNotMatch(container.innerHTML, /data-partners-start-kyc|data-partners-cash-kyc-form/);
});

test('membership education uses six accessible 44px explainers instead of unexplained KYC labels', () => {
  const { page, container } = loadPage();
  page.renderMembershipBootstrap(bootstrapV2());

  assert.equal((container.innerHTML.match(/<details name="partners-program-help">/g) || []).length, 6);
  assert.equal((container.innerHTML.match(/aria-label="More information about /g) || []).length, 6);
  assert.match(container.innerHTML, /Referral tracking window/);
  assert.match(container.innerHTML, /Balance validation/);
  assert.match(container.innerHTML, /Start sharing/);
  assert.match(container.innerHTML, /Use balance for Norva/);
  assert.match(container.innerHTML, /Transfer balance to cash/);
  assert.doesNotMatch(container.innerHTML, />No KYC</);
  assert.doesNotMatch(container.innerHTML, />KYC required</);
  assert.match(
    cssSource,
    /\.partners-program-help summary\s*\{[\s\S]{0,260}width:\s*44px;[\s\S]{0,120}height:\s*44px;/,
  );
  assert.match(
    cssSource,
    /\.partners-program-help:has\(details\[open\]\)\s*\{[\s\S]{0,140}grid-column:\s*1\s*\/\s*-1;/,
  );
  assert.match(
    cssSource,
    /\.partners-program-facts--guided \.partners-program-help-popover\s*\{[\s\S]{0,120}position:\s*static;/,
  );
});

test('invite-only users see a neutral pilot state without a false KYC action', () => {
  const { page, container } = loadPage();
  const data = bootstrapV2();
  data.flags.partners_invite_only = true;
  data.eligibility = { visible: true, eligible: false, reason: 'pilot_not_allowed' };
  page.renderMembershipBootstrap(data);

  assert.match(container.innerHTML, /currently invitation-only/);
  assert.match(container.innerHTML, /No identity check or payout setup is needed now/);
  assert.doesNotMatch(container.innerHTML, /data-partners-membership-join|data-partners-cash-kyc-form/);
});

test('membership join sends only authoritative consent booleans and reloads server state', async () => {
  let joined = null;
  const { page } = loadPage({
    partners: {
      join: async (input) => { joined = input; return { data: {} }; },
    },
  });
  const terms = control({ checked: true });
  const disclosure = control({ checked: true });
  const button = control({ textContent: 'Join and get my link' });
  const form = control();
  const status = control();
  form.querySelector = (selector) => ({
    '[data-partners-terms-confirm]': terms,
    '[data-partners-disclosure-confirm]': disclosure,
    '[data-partners-membership-join]': button,
  })[selector] || null;
  page.container.querySelector = (selector) => ({
    '[data-partners-membership-form]': form,
    '[data-partners-action-status]': status,
  })[selector] || null;
  page.runPartnerAction = async (_button, _label, action) => action();
  let reloads = 0;
  page.show = async () => { reloads += 1; };

  page.bindMembershipDiscoveryActions(bootstrapV2());
  await form.listeners.get('submit')({ preventDefault() {} });

  assert.equal(joined.termsAccepted, true);
  assert.equal(joined.disclosureAccepted, true);
  assert.match(joined.idempotencyKey, /^norva\.membership-join\./);
  assert.deepEqual(Object.keys(joined).sort(), [
    'disclosureAccepted',
    'idempotencyKey',
    'termsAccepted',
  ]);
  assert.equal(reloads, 1);
});

test('active dashboard prioritises available, pending and Norva conversion', () => {
  const { page } = loadPage();
  const metrics = control();
  const content = control();
  metrics.removeAttribute = () => {};
  content.removeAttribute = () => {};
  page.container.querySelector = (selector) => ({
    '[data-partners-dashboard-metrics]': metrics,
    '[data-partners-dashboard-content]': content,
  })[selector] || null;
  page.bindDashboardActions = () => {};
  page.bindCreditActions = () => {};
  page.scheduleDashboardRefresh = () => {};
  const bootstrap = bootstrapV2({ membership: true });
  const dashboard = {
    schema_version: 2,
    ...bootstrap,
    balances: [{
      currency: 'USD',
      currency_exponent: 2,
      pending_minor: 220,
      available_minor: 1497,
      recovery_due_minor: 0,
      redeemed_minor: 499,
    }],
    next_maturation_at: '2026-09-18T12:00:00Z',
    credit_readiness: {
      ready: true,
      reason: null,
      catalog: {
        catalog_key: 'acc_plus_month_usd_v1',
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
    overlay: null,
    provider: null,
    history: { status: 'all', items: [], next_cursor: null },
  };

  page.renderMembershipDashboardData(bootstrap, dashboard);

  assert.match(metrics.innerHTML, /Available to use/);
  assert.match(metrics.innerHTML, /In validation/);
  assert.match(metrics.innerHTML, /Converted to Norva/);
  assert.match(content.innerHTML, /Convert to Norva Plus/);
  assert.match(content.innerHTML, /data-partners-credit-quote/);
  assert.match(content.innerHTML, /No KYC is required/);
  assert.doesNotMatch(content.innerHTML, /data-partners-cash-kyc-form/);
});

test('empty authoritative ledger uses honest first-earning states', () => {
  const { page } = loadPage();
  const metrics = control();
  const content = control();
  metrics.removeAttribute = () => {};
  content.removeAttribute = () => {};
  page.container.querySelector = (selector) => ({
    '[data-partners-dashboard-metrics]': metrics,
    '[data-partners-dashboard-content]': content,
  })[selector] || null;
  page.bindDashboardActions = () => {};
  page.bindCreditActions = () => {};
  page.scheduleDashboardRefresh = () => {};
  const bootstrap = bootstrapV2({ membership: true });

  page.renderMembershipDashboardData(bootstrap, {
    schema_version: 2,
    ...bootstrap,
    balances: [],
    next_maturation_at: null,
    credit_readiness: {
      ready: false,
      reason: 'credits_disabled',
      catalog: null,
    },
    cash_readiness: {
      ready: false,
      reason: 'cash_pilot_not_allowed',
    },
    history: { status: 'all', items: [], next_cursor: null },
  });

  assert.match(metrics.innerHTML, /No balance yet/);
  assert.match(metrics.innerHTML, /Nothing in validation/);
  assert.match(metrics.innerHTML, /No conversions yet/);
  assert.match(metrics.innerHTML, /Your balance will appear after the first eligible payment\./);
  assert.doesNotMatch(metrics.innerHTML, /Unavailable/);
});

test('active member does not promise earnings while the economic flag is paused', () => {
  const { page, container } = loadPage();
  const bootstrap = bootstrapV2({ membership: true });
  bootstrap.flags.partners_earnings_enabled = false;
  page.bindCommonActions = () => {};
  page.focusTitle = () => {};
  page.loadDashboard = () => {};

  page.renderMembershipActive(bootstrap);

  assert.match(container.innerHTML, /Link active · Earnings paused/);
  assert.match(container.innerHTML, /new commissions are temporarily paused/i);
  assert.doesNotMatch(container.innerHTML, /Ready to share/);
});

test('access-credit labels preserve the canonical Plus and Family prices', () => {
  const { page } = loadPage();
  assert.equal(page.creditPlanLabel('plus'), 'Norva Plus');
  assert.equal(page.creditPlanLabel('family'), 'Norva Family');
  assert.match(page.formatMinor(499, 'USD'), /4[.,]99/);
  assert.match(page.formatMinor(899, 'USD'), /8[.,]99/);
});

test('non-USD balances convert through exact server FX without a KYC prompt', () => {
  const { page } = loadPage();
  const metrics = control();
  const content = control();
  metrics.removeAttribute = () => {};
  content.removeAttribute = () => {};
  page.container.querySelector = (selector) => ({
    '[data-partners-dashboard-metrics]': metrics,
    '[data-partners-dashboard-content]': content,
  })[selector] || null;
  page.bindDashboardActions = () => {};
  page.bindCreditActions = () => {};
  page.scheduleDashboardRefresh = () => {};
  const bootstrap = bootstrapV2({ membership: true });
  page.renderMembershipDashboardData(bootstrap, {
    schema_version: 2,
    ...bootstrap,
    balances: [{
      currency: 'EUR',
      currency_exponent: 2,
      pending_minor: 750,
      available_minor: 1250,
      recovery_due_minor: 0,
      redeemed_minor: 0,
    }],
    next_maturation_at: null,
    credit_readiness: {
      ready: true,
      reason: null,
      catalog: {
        catalog_key: 'acc_p0_usd_plus_month_v1',
        plan_code: 'plus',
        currency: 'EUR',
        currency_exponent: 2,
        unit_amount_minor: 454,
        unit_duration_days: 30,
        minimum_months: 1,
        maximum_months: 12,
        reference_currency: 'USD',
        reference_currency_exponent: 2,
        reference_unit_amount_minor: 499,
        fx_rate_snapshot_key: `fxr_${'a'.repeat(24)}`,
        fx_rate_source: 'ecb_reference',
        fx_observed_at: '2026-08-05T08:00:00Z',
        fx_valid_until: '2026-08-06T08:00:00Z',
      },
    },
    history: { status: 'all', items: [], next_cursor: null },
  });

  assert.match(metrics.innerHTML, /12[.,]50/);
  assert.match(content.innerHTML, /Convert to Norva Plus/i);
  assert.match(content.innerHTML, /dated, immutable rate/i);
  assert.match(content.innerHTML, /Review conversion/i);
  assert.doesNotMatch(content.innerHTML, /data-partners-cash-kyc-form|€0[.,]00/);
});

test('credit review requests months only and waits for the server quote', async () => {
  let quoted = null;
  const { page } = loadPage({
    partners: {
      credit: {
        quote: async (input) => {
          quoted = input;
          return { data: { quote: { key: `crq_${'a'.repeat(24)}` } } };
        },
      },
    },
  });
  const form = control();
  const months = control({ value: '2' });
  const button = control({ textContent: 'Review conversion' });
  form.querySelector = (selector) => ({
    '[data-partners-credit-months]': months,
    '[data-partners-credit-quote]': button,
  })[selector] || null;
  page.container.querySelector = (selector) => (
    selector === '[data-partners-credit-form]' ? form : null
  );
  page.runPartnerAction = async (_button, _label, action) => action();
  let reviewed = null;
  page.openCreditQuoteDialog = (quote) => { reviewed = quote; };

  page.bindCreditActions(bootstrapV2({ membership: true }), {});
  await form.listeners.get('submit')({ preventDefault() {} });

  assert.equal(quoted.months, 2);
  assert.match(quoted.idempotencyKey, /^norva\.credit-quote-2\./);
  assert.deepEqual(Object.keys(quoted).sort(), ['idempotencyKey', 'months', 'signal']);
  assert.equal(quoted.signal instanceof AbortSignal, true);
  assert.equal(reviewed.key, `crq_${'a'.repeat(24)}`);
});

test('cash KYC is opened only for the cash-transfer choice', async () => {
  const { page } = loadPage();
  let kyc = 0;
  let countryDialogs = 0;
  let payoutLoads = 0;
  let payoutDialogs = 0;
  page.openCashKycDialog = () => { kyc += 1; };
  page.openCashCountryDialog = () => { countryDialogs += 1; };
  page.loadPayoutProfile = async () => {
    payoutLoads += 1;
    return { account: { country_code: null }, readiness: {} };
  };
  page.openPayoutDialog = () => { payoutDialogs += 1; };
  const opener = control();

  await page.openCashJourney({ cash_readiness: { ready: false, reason: 'kyc_required' } }, opener);
  await page.openCashJourney({ cash_readiness: { ready: false, reason: 'payout_country_required' } }, opener);
  await page.openCashJourney({ cash_readiness: { ready: false, reason: 'fiscal_profile_required' } }, opener);

  assert.equal(kyc, 1);
  assert.equal(countryDialogs, 1);
  assert.equal(payoutLoads, 2);
  assert.equal(payoutDialogs, 1);
});

test('cash KYC return shows an authoritative progress card and faster pending refresh', () => {
  const { page, container } = loadPage();
  page.loadDashboard = () => {};
  page._kycReturnPendingUntil = Date.now() + 60_000;

  page.renderMembershipActive(bootstrapV2({
    membership: true,
    verificationStatus: 'pending',
  }));

  assert.match(container.innerHTML, /data-partners-kyc-progress/);
  assert.match(container.innerHTML, /Under review/);
  assert.match(container.innerHTML, /Didit is reviewing your submission/);
  assert.match(container.innerHTML, /refreshes it automatically/);
  assert.match(container.innerHTML, /keep sharing and use balance for Norva access/);

  const waitingForWebhook = page.cashKycProgressModel(
    { verification_status: 'not_started' },
    { ready: false, reason: 'kyc_required' },
  );
  assert.equal(waitingForWebhook.badge, 'Confirmation pending');
  assert.match(waitingForWebhook.title, /checking for a signed identity result/);
  assert.match(waitingForWebhook.copy, /No provider result has been recorded yet/);
  assert.match(waitingForWebhook.copy, /without trusting the return link/);

  page._kycReturnPendingUntil = 0;
  assert.equal(
    page.cashKycProgressModel(
      { verification_status: 'not_started' },
      { ready: false, reason: 'kyc_required' },
    ),
    null,
  );
  const verified = page.cashKycProgressModel(
    { verification_status: 'verified' },
    { ready: false, reason: 'fiscal_profile_required' },
  );
  assert.equal(verified.badge, 'Identity verified');
  assert.match(verified.copy, /remaining tax and payout checks/);

  assert.match(pageSource, /KYC_PENDING_REFRESH_MS\s*=\s*10\s*\*\s*1000/);
  assert.match(pageSource, /DASHBOARD_REFRESH_MS\s*=\s*60\s*\*\s*1000/);
  assert.match(pageSource, /setTimeout\([\s\S]{0,700}refreshDelay\)/);
  assert.match(cssSource, /\.partners-kyc-progress\s*\{[\s\S]{0,500}var\(--color-bg-secondary\)/);
});

test('cash payout country is explicit, idempotent and never inferred from device data', () => {
  assert.match(pageSource, /NorvaCloud\?\.partners\?\.bindPayoutCountry/);
  assert.match(pageSource, /const envelope = await api\(\{[\s\S]{0,180}countryCode,[\s\S]{0,180}idempotencyKey:/);
  assert.match(pageSource, /Norva never infers this from your IP address, device or locale/);
  assert.match(pageSource, /payout-country-\$\{countryCode\}/);
  assert.match(pageSource, /payout_country_unavailable:/);
  const start = pageSource.indexOf('openCashCountryDialog(data, profile, opener)');
  const end = pageSource.indexOf('openCashKycDialog(data, opener)', start);
  const countryFlow = pageSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(countryFlow, /navigator\.language|navigator\.userAgent|geolocation|timeZone/);
});

test('new conversion and cash sheets retain Norva tokens, mobile safe areas and touch sizing', () => {
  assert.match(cssSource, /\.partners-credit-form select[\s\S]{0,260}min-height:\s*48px/);
  assert.match(cssSource, /\.partners-credit-dialog[\s\S]{0,360}var\(--color-bg-secondary\)/);
  assert.match(cssSource, /\.partners-credit-overlay[\s\S]{0,1200}safe-area-inset-bottom/);
  assert.match(pageSource, /isolateOverlayBackground\(overlay\)/);
  assert.match(pageSource, /trapDialogFocus\(dialog, event, close\)/);
  assert.match(pageSource, /partners-credit-overlay'[\s\S]{0,180}setAttribute\('data-region-picker'/);
  assert.match(pageSource, /partners-credit-dialog" data-region-pop role="dialog"/);
  assert.match(pageSource, /data-partners-cash-kyc-form/);
  assert.match(pageSource, /data-partners-cash-country-form/);
  assert.match(pageSource, /No KYC is required/);
});

test('conversion and cash dialogs close on keyboard or Android Back and isolate the background', () => {
  const { page, document } = loadPage();
  const dialog = {
    querySelectorAll() { return []; },
    contains() { return false; },
  };
  for (const key of ['Escape', 'GoBack', 'BrowserBack']) {
    let closed = 0;
    let prevented = 0;
    let stopped = 0;
    page.trapDialogFocus(dialog, {
      key,
      preventDefault() { prevented += 1; },
      stopPropagation() { stopped += 1; },
    }, () => { closed += 1; });
    assert.equal(closed, 1);
    assert.equal(prevented, 1);
    assert.equal(stopped, 1);
  }

  const node = (parentElement = null) => ({
    parentElement,
    children: [],
    inert: false,
    isConnected: true,
    attributes: new Map(),
    matches() { return false; },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
  });
  const wrapper = node(document.body);
  const background = node(wrapper);
  const overlay = node(wrapper);
  const globalNav = node(document.body);
  wrapper.children = [background, overlay];
  document.body.children = [wrapper, globalNav];
  const restore = page.isolateOverlayBackground(overlay);
  assert.equal(background.inert, true);
  assert.equal(background.getAttribute('aria-hidden'), 'true');
  assert.equal(globalNav.inert, true);
  restore();
  assert.equal(background.inert, false);
  assert.equal(background.getAttribute('aria-hidden'), null);
  assert.equal(globalNav.inert, false);
});

test('TV remains a private D-pad hand-off and renders no personal balance', () => {
  const start = pageSource.indexOf('renderTvRelayLoading()');
  const end = pageSource.indexOf('renderLoading()', start + 1);
  const tvSurface = pageSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(tvSurface, /Your partner account and financial details never appear on TV/);
  assert.match(tvSurface, /data-partners-tv-refresh/);
  assert.match(tvSurface, /focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(tvSurface, /Available to use|pending_minor|available_minor|redeemed_minor/);
});
