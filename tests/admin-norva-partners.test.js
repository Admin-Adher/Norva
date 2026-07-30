'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'public/js/pages/AdminPage.js'),
  'utf8',
);

function loadAdminPage(documentOverride = null) {
  const window = {};
  const context = vm.createContext({
    window,
    document: documentOverride || {
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    localStorage: {
      getItem() { return null; },
      setItem() {},
    },
    location: { hash: '#admin/partners' },
    history: { state: null, replaceState() {} },
    navigator: {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    URL,
    Intl,
    Date,
    Map,
    Set,
    Promise,
  });
  window.window = window;
  vm.runInContext(source, context, { filename: 'public/js/pages/AdminPage.js' });
  return window.AdminPage;
}

test('Admin Partners has a whitelisted overview and UUID-bounded detail route', () => {
  const AdminPage = loadAdminPage();
  const id = '11111111-1111-4111-8111-111111111111';

  assert.equal(AdminPage.validRoute('partners'), 'partners');
  assert.equal(AdminPage.validRoute(`partner:${id}`), `partner:${id}`);
  assert.equal(AdminPage.validRoute('partner:not-an-id'), null);
  assert.equal(AdminPage.validRoute('partners/../../systeme'), null);
  assert.equal(AdminPage.NAV().some((item) => (
    item.key === 'partners'
    && item.label === 'Partners'
    && item.section === 'Business'
  )), true);
});

test('Admin Partners reads only dedicated sanitized RPCs', () => {
  assert.match(source, /this\._rpc\('admin_partners_overview'\)/);
  assert.match(source, /this\._rpc\('admin_partners_accounts',\s*\{/);
  assert.match(source, /this\._rpc\('admin_partners_detail',\s*\{\s*p_account_id:\s*accountId\s*\}\)/);
  assert.match(source, /this\._rpc\('admin_partners_monitoring'\)/);
  assert.match(source, /revenuecat_transfer:\s*'Transferts RevenueCat'/);
  assert.match(source, /revenuecat_transfer_dead_letter/);
  assert.match(source, /revenuecat_transfer_partial_aged/);
  assert.match(source, /revenuecat_transfer_quarantined_aged/);
  assert.match(source, /revenuecat_transfer_partner_dead_letter/);
  assert.match(source, /this\._rpc\('admin_partners_configuration'\)/);
  assert.match(source, /this\._rpc\('admin_partners_analytics',\s*\{\s*p_days:\s*30\s*\}\)/);
  assert.match(source, /else if \(route === 'partners'\) this\._pagePartners\(\)/);
  assert.match(source, /else if \(route\.startsWith\('partner:'\)\) this\._pagePartnerDetail/);

  const section = source.slice(
    source.indexOf('// ── Page: Norva Partners'),
    source.indexOf('// ── Page: Providers'),
  );
  assert.ok(section.length > 2_000);
  assert.doesNotMatch(section, /provider_reference|kyc_reference|document_number|iban|wallet_address/i);
  assert.doesNotMatch(section, /catch\s*\([^)]*\)\s*\{[\s\S]{0,220}\.message/);
  assert.match(section, /Aucune référence KYC provider, adresse e-mail ou code public/);
});

test('Admin Partners exposes capability-gated, audited operational controls', () => {
  const AdminPage = loadAdminPage();
  const section = source.slice(
    source.indexOf('// ── Page: Norva Partners'),
    source.indexOf('// ── Page: Providers'),
  );
  for (const capability of ['fraud_workbench', 'financial_ledger', 'payout_operations']) {
    assert.match(section, new RegExp(`\\['${capability}'`));
  }
  assert.match(section, /Non configuré — aucune action live exposée/);
  assert.match(section, /Aucune action n’a été exécutée/);
  for (const rpc of [
    'admin_partners_capability_set',
    'admin_partners_control',
    'admin_partners_account_action',
    'admin_partners_job_retry',
    'admin_partners_commission_reverse',
    'admin_partners_payout_cycle_create',
    'admin_partners_payout_cycle_approve',
  ]) {
    assert.match(section, new RegExp(`this\\._rpc\\('${rpc}'`));
  }
  assert.match(section, /_partnersTypedConfirmation/);
  assert.match(section, /_partnersJustification/);
  assert.match(section, /Action refusée ou indisponible/);
  assert.match(section, /capabilityEnvelope\?\.can_manage === true/);
  assert.match(section, /capabilityEnvelope\?\.can_manage_release === true/);
  assert.match(section, /this\._partnersCanManageCapabilities !== true/);
  assert.match(section, /this\._partnersCanUseReleaseControl\(kind, key, enabled\)/);
  assert.match(section, /Revolut Business reste en évaluation et aucun versement live n’est activé ici/);
  assert.match(section, /\(value\) => value\.toLowerCase\(\) === 'airwallex'/);
  assert.doesNotMatch(section, /Provider \(wise, revolut ou stripe_connect\)/);
  assert.doesNotMatch(section, /catch\s*\([^)]*\)\s*\{[\s\S]{0,220}\.message/);
  assert.match(source, /\.partners-admin-toolbar input,[\s\S]{0,180}min-height:44px/);
  assert.match(source, /\.partners-action\{[^}]*min-height:44px/);
  assert.match(source, /\.partner-row:focus-visible|\.user-row:focus-visible,[\s\S]{0,260}\.crm-nav-item:focus-visible/);

  const page = new AdminPage({});
  const capabilityState = { support: true, risk: false, finance: false };
  assert.doesNotMatch(
    page._partnersCapabilityCards(capabilityState, false),
    /data-partners-action="capability"/,
    'a regular admin must see capability state without self-service controls',
  );
  assert.match(
    page._partnersCapabilityCards(capabilityState, true),
    /data-partners-action="capability"/,
    'only a server-designated capability manager receives grant controls',
  );

  page._partnersCapabilities = { support: true, risk: false, finance: false };
  page._partnersCanManageRelease = false;
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_enabled', false), true);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_enabled', true), false);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_payouts_live', false), false);
  assert.equal(page._partnersCanUseConfigurationAction('allowlist'), true);
  assert.equal(page._partnersCanUseConfigurationAction('program-create'), false);

  page._partnersCapabilities = { support: true, risk: true, finance: true };
  page._partnersCanManageRelease = true;
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_payouts_live', true), true);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_tv_relay_enabled', true), true);
  assert.equal(page._partnersCanUseReleaseControl('gate', 'general_release_approved', true), true);
  assert.equal(page._partnersCanUseConfigurationAction('program-create'), true);
});

test('Admin Partners never renders an account UUID as the visible partner reference', () => {
  const section = source.slice(
    source.indexOf('// ── Page: Norva Partners'),
    source.indexOf('// ── Page: Providers'),
  );
  assert.match(section, /data-partner-id="\$\{AdminPage\.esc\(id\)\}"/);
  assert.match(section, /const ref = String\(row\.partner_key \|\| 'Partenaire'\)/);
  assert.doesNotMatch(section, /\$\{AdminPage\.esc\(row\.account_id\)\}/);
  assert.doesNotMatch(section, /<dd>\$\{AdminPage\.esc\(accountId\)\}/);
});

test('Admin Partners renders capability-gated analytics without inventing unavailable values', () => {
  const analytics = {
    innerHTML: '',
    removeAttribute() {},
  };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-analytics' ? analytics : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._renderPartnersAnalytics({
    schema_version: 1,
    window_days: 30,
    window: {
      timezone: 'UTC',
      start: '2026-07-01T00:00:00Z',
      end_exclusive: '2026-07-31T00:00:00Z',
    },
    daily_status: { status: 'available' },
    daily: [{
      date: '2026-07-29',
      claims: 2,
      attributions: 1,
      kyc_verified: 1,
      commission_entries: 1,
    }],
    funnel: {
      status: 'available',
      clicks: { status: 'unavailable', reason: 'referral_click_events_not_recorded' },
      claims_issued: { status: 'available', value: 2 },
      attributions_created: { status: 'available', value: 1 },
      first_paid_referrals: { status: 'available', value: 1 },
      claim_to_attribution_percent: { status: 'available', value: 50 },
      attribution_to_first_payment_percent: { status: 'available', value: 100 },
    },
    activation: {
      status: 'available',
      account_activation_events: { status: 'available', value: 1 },
      distinct_accounts_activated: { status: 'available', value: 1 },
      kyc_verified_sessions: { status: 'available', value: 1 },
    },
    risk: { status: 'unavailable', reason: 'risk_capability_required' },
    financial: { status: 'unavailable', reason: 'finance_capability_required' },
    payout_timing: { status: 'unavailable', reason: 'payout_operations_not_ready' },
    retention: {
      status: 'unavailable',
      reason: 'authoritative_entitlement_and_billing_interval_history_not_modeled',
    },
  });

  assert.match(analytics.innerHTML, /Performance Partners sur 30 jours/);
  assert.match(analytics.innerHTML, /Les clics ne sont pas encore instrumentés/);
  assert.match(analytics.innerHTML, /Accès Risque requis/);
  assert.match(analytics.innerHTML, /Accès Finance requis/);
  assert.match(analytics.innerHTML, /Versements live non activés/);
  assert.match(analytics.innerHTML, /Historique d’abonnement autoritatif non disponible/);
  assert.doesNotMatch(analytics.innerHTML, /referral_click_events_not_recorded/);
  assert.doesNotMatch(analytics.innerHTML, /<strong>0<\/strong>\s*<span>Clics/);
});

test('Admin Partners keeps financial analytics scoped to exact minor units and currency', () => {
  const analytics = {
    innerHTML: '',
    removeAttribute() {},
  };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-analytics' ? analytics : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const unavailable = { status: 'unavailable', reason: 'support_capability_required' };
  new AdminPage({})._renderPartnersAnalytics({
    schema_version: 1,
    window_days: 30,
    daily_status: unavailable,
    daily: [],
    funnel: unavailable,
    activation: unavailable,
    risk: { status: 'unavailable', reason: 'risk_capability_required' },
    financial: {
      status: 'available',
      rows: [{
        rail: 'google_play',
        currency: 'USD',
        currency_exponent: 2,
        paid_event_count: 2,
        refund_count: 1,
        chargeback_count: 0,
        net_eligible_revenue_minor: 123456,
        net_partner_commission_minor: 24691,
        contribution_after_partner_commission_minor: {
          status: 'available',
          value: 98765,
        },
      }, {
        rail: 'web',
        currency: 'USD',
        currency_exponent: 2,
        paid_event_count: 1,
        refund_count: 0,
        chargeback_count: 0,
        net_eligible_revenue_minor: Number.MAX_SAFE_INTEGER + 1,
        net_partner_commission_minor: 1,
        contribution_after_partner_commission_minor: {
          status: 'unavailable',
          reason: 'commission_processing_incomplete',
        },
      }],
      gross_margin: {
        status: 'unavailable',
        reason: 'provider_fees_fx_infrastructure_and_other_costs_not_modeled',
      },
      transfer_entitlement: {
        status: 'unavailable',
        reason: 'authoritative_transfer_entitlement_contract_not_implemented',
      },
    },
    payout_timing: { status: 'unavailable', reason: 'payout_operations_not_ready' },
    retention: {
      status: 'unavailable',
      reason: 'authoritative_entitlement_and_billing_interval_history_not_modeled',
    },
  });

  assert.match(analytics.innerHTML, /google_play · USD/);
  assert.match(analytics.innerHTML, /1 234,56 USD/);
  assert.match(analytics.innerHTML, /246,91 USD/);
  assert.match(analytics.innerHTML, /987,65 USD/);
  assert.match(analytics.innerHTML, /Traitement des commissions incomplet/);
  assert.doesNotMatch(analytics.innerHTML, /9007199254740992/);
});
