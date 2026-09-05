const visibleUiMarkup = require('./helpers/visible-ui-markup.cjs');
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const { TextDecoder, TextEncoder } = require('node:util');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'public/js/pages/AdminPage.js'),
  'utf8',
);
const appSource = fs.readFileSync(
  path.join(root, 'public/js/app.js'),
  'utf8',
);

function loadAdminPage(documentOverride = null, fetchOverride = null, windowOverride = {}) {
  const sessionStorage = windowOverride.sessionStorage || {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  };
  const window = { crypto: webcrypto, ...windowOverride, sessionStorage };
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
    sessionStorage,
    location: { hash: '#admin/partners' },
    history: { state: null, replaceState() {} },
    navigator: {},
    fetch: fetchOverride || (async () => ({
      ok: true,
      json: async () => ({}),
    })),
    console: { log() {}, warn() {}, error() {} },
    setTimeout: windowOverride.setTimeout || setTimeout,
    clearTimeout: windowOverride.clearTimeout || clearTimeout,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    URL,
    Intl,
    Date: windowOverride.Date || Date,
    Map,
    Set,
    Promise,
    TextEncoder,
    TextDecoder,
    AbortController,
    DOMException,
  });
  window.window = window;
  vm.runInContext(source, context, { filename: 'public/js/pages/AdminPage.js' });
  return window.AdminPage;
}

function revolutIncident(overrides = {}) {
  return {
    key: 'rri_0123456789abcdef01234567',
    status: 'open',
    priority: 1,
    kind: 'amount_mismatch',
    source_reference: 'NORVA-A1B2C3D4E5F6',
    source_transaction_fingerprint: '0123456789ab',
    source_state: 'COMPLETED',
    source_amount_minor: 123456,
    source_currency: 'EUR',
    source_currency_exponent: 2,
    expected_reference: 'NORVA-A1B2C3D4E5F6',
    expected_amount_minor: 1000,
    expected_currency: 'EUR',
    expected_currency_exponent: 2,
    value_date: '2026-07-30',
    observed_at: '2026-07-30T10:00:00Z',
    pending_review: null,
    resolution: null,
    resolved_at: null,
    transaction_alias: null,
    eligible_actions: ['quarantine'],
    ...overrides,
  };
}

test('Admin Partners has whitelisted UUID and sanitized public-key detail routes', () => {
  const AdminPage = loadAdminPage();
  const id = '11111111-1111-4111-8111-111111111111';
  const partnerKey = `prt_${'a'.repeat(24)}`;

  assert.equal(AdminPage.validRoute('partners'), 'partners');
  assert.equal(AdminPage.validRoute(`partner:${id}`), `partner:${id}`);
  assert.equal(
    AdminPage.validRoute(`partner-public:${partnerKey}`),
    `partner-public:${partnerKey}`,
  );
  assert.equal(AdminPage.validRoute('partner:not-an-id'), null);
  assert.equal(AdminPage.validRoute('partner-public:prt_not-safe'), null);
  assert.equal(AdminPage.validRoute('partners/../../systeme'), null);
  assert.equal(AdminPage.NAV().some((item) => (
    item.key === 'partners'
    && item.label === 'Partners'
    && item.section === 'Business'
  )), true);
});

test('Admin Partners reads only dedicated sanitized RPCs', () => {
  assert.match(source, /_partnersLoadModule\('overview', 'admin_partners_overview'/);
  assert.match(source, /_partnersLoadModule\('accounts', 'admin_partners_accounts'/);
  assert.match(source, /'admin_partners_access_requests'/);
  assert.match(source, /admin_partners_access_request_decide/);
  assert.match(source, /this\._rpc\('admin_partners_detail',\s*\{\s*p_account_id:\s*accountId\s*\}\)/);
  assert.match(source, /this\._rpc\('admin_partners_detail_by_public_id',\s*\{/);
  assert.match(source, /'admin_partners_payout_onboarding_requests'/);
  assert.match(source, /'admin_partners_payout_onboarding_request_decide'/);
  assert.match(source, /'monitoring', 'admin_partners_monitoring'/);
  assert.match(source, /revenuecat_transfer:\s*[^\n]*NorvaI18n[^\n]*'Transferts RevenueCat'/);
  assert.match(source, /revenuecat_transfer_dead_letter/);
  assert.match(source, /revenuecat_transfer_partial_aged/);
  assert.match(source, /revenuecat_transfer_quarantined_aged/);
  assert.match(source, /revenuecat_transfer_partner_dead_letter/);
  for (const rpc of [
    'admin_partners_configuration',
    'admin_partners_analytics',
    'admin_partners_revolut_payout_status',
    'admin_partners_revolut_manual_batches',
    'admin_partners_revolut_reconciliation_queue',
    'admin_partners_revolut_reconciliation_incidents',
    'admin_partners_revolut_return_queue',
    'admin_partners_revolut_manual_controls_queue',
    'admin_partners_revolut_late_completion_queue',
  ]) assert.match(source, new RegExp(`['"]${rpc}['"]`));
  assert.match(source, /this\._rpc\('admin_partners_revolut_profile_status',\s*\{/);
  assert.match(source, /norva-partners-revolut-payout\/manual\/beneficiaries\/propose/);
  assert.match(source, /PROPOSE-BENEFICIARY:/);
  assert.match(source, /admin_partners_revolut_manual_batch_export/);
  assert.match(source, /ACCESS-EXPORT:/);
  assert.match(source, /manual_batch_export_hash_mismatch/);
  assert.match(source, /else if \(route === 'partners'\) this\._pagePartners\(\)/);
  assert.match(source, /else if \(route\.startsWith\('partner-public:'\)\) this\._pagePartnerDetailByPublicId/);
  assert.match(source, /else if \(route\.startsWith\('partner:'\)\) this\._pagePartnerDetail/);

  const section = source.slice(
    source.indexOf('// ── Page: Norva Partners'),
    source.indexOf('// ── Page: Providers'),
  );
  assert.ok(section.length > 2_000);
  assert.doesNotMatch(section, /provider_reference|kyc_reference|document_number|iban|wallet_address/i);
  assert.doesNotMatch(section, /catch\s*\([^)]*\)\s*\{[\s\S]{0,220}\.message/);
  assert.match(section, /Aucune référence KYC provider, adresse e-mail, donnée bancaire ou identifiant interne/);
  assert.match(section, /référence partenaire affichée est publique et pseudonymisée/);
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
    'admin_partners_capability_set_by_operator_key',
    'admin_partners_control',
    'admin_partners_account_action',
    'admin_partners_job_retry',
    'admin_partners_commission_reverse',
    'admin_partners_payout_cycle_create',
    'admin_partners_payout_cycle_approve',
    'admin_partners_revolut_manual_batch_prepare',
    'admin_partners_revolut_manual_batch_export',
    'admin_partners_revolut_manual_batch_mark_submitted',
    'admin_partners_revolut_reconciliation_review',
    'admin_partners_revolut_reconciliation_decide',
    'admin_partners_revolut_reconciliation_incident_review',
    'admin_partners_revolut_reconciliation_incident_decide',
    'admin_partners_revolut_return_review',
    'admin_partners_revolut_return_decide',
    'admin_partners_revolut_manual_batch_cancel',
    'admin_partners_revolut_manual_batch_release_unmapped',
    'admin_partners_revolut_manual_control_reject',
    'admin_partners_revolut_late_completion_review',
    'admin_partners_revolut_late_completion_decide',
  ]) {
    assert.match(section, new RegExp(`this\\._rpc\\(\\s*'${rpc}'`));
  }
  assert.doesNotMatch(
    section,
    /this\._rpc\(\s*'admin_partners_revolut_manual_batch_(?:payload|mark_exported)'/,
  );
  assert.match(section, /'admin_partners_revolut_beneficiary_binding_verify'/);
  assert.match(section, /'admin_partners_revolut_beneficiary_binding_reject'/);
  assert.match(
    section,
    /this\._rpc\(\s*'admin_partners_revolut_beneficiary_binding_revoke'/,
  );
  assert.match(section, /_partnersTypedConfirmation/);
  assert.match(section, /_partnersJustification/);
  assert.match(section, /Action refusée ou indisponible/);
  assert.match(section, /data\?\.can_manage === true/);
  assert.match(section, /data\?\.can_manage_release === true/);
  assert.match(section, /this\._partnersCanManageCapabilities !== true/);
  assert.match(section, /this\._partnersCanUseReleaseControl\(kind, key, enabled\)/);
  assert.match(section, /Production en mode manuel/);
  assert.match(section, /Aucun virement n’est déclenché automatiquement/);
  assert.match(section, /p_provider:\s*'revolut'/);
  assert.match(section, /p_status:\s*routeStatus/);
  assert.match(section, /partners_revolut_api_enabled/);
  assert.match(section, /norva-partners-revolut-payout\/manual\/statements/);
  assert.match(section, /body:\s*JSON\.stringify\(\{\s*csv\s*\}\)/);
  assert.match(section, /\.csv,\.tsv,text\/csv,text\/tab-separated-values/);
  assert.doesNotMatch(section, /currencyExponents/);
  assert.doesNotMatch(section, /Provider \(wise, revolut ou stripe_connect\)/);
  assert.doesNotMatch(section, /catch\s*\([^)]*\)\s*\{[\s\S]{0,220}\.message/);
  assert.match(source, /\.partners-admin-toolbar input,[\s\S]{0,180}min-height:44px/);
  assert.match(source, /\.partners-action\{[^}]*min-height:44px/);
  assert.match(source, /\.partner-row:focus-visible|\.user-row:focus-visible,[\s\S]{0,260}\.crm-nav-item:focus-visible/);
  assert.match(source, /Référence mondiale : 10,00 USD = \{"USD":1000\}/);
  assert.doesNotMatch(source, /\{"EUR":5000,"USD":5000\}/);
  assert.match(source, /parsed\.USD === 1000/);
  assert.match(source, /chaque devise de règlement doit avoir un entier positif explicite/);

  const page = new AdminPage({});
  const capabilityState = { support: true, risk: false, finance: false };
  assert.doesNotMatch(
    page._partnersCapabilityCards(capabilityState, false),
    /data-partners-action="capability"/,
    'a regular admin must see capability state without self-service controls',
  );
  assert.doesNotMatch(
    page._partnersCapabilityCards(capabilityState, true),
    /data-partners-action="capability"/,
    'personal readiness cards never send an Auth user id for self-service mutation',
  );
  const operatorMarkup = page._partnersCapabilityCards(capabilityState, true, [{
    operator_key: `op_${'a'.repeat(64)}`,
    email: 'finance@example.test',
    is_admin: true,
    account_active: true,
    email_confirmed: true,
    totp_verified: false,
    capabilities: { support: false, risk: true, finance: false },
  }]);
  assert.match(operatorMarkup, /Équipe opératrice et maker-checker/);
  assert.match(operatorMarkup, new RegExp(`data-partners-operator-key="op_${'a'.repeat(64)}"`));
  assert.doesNotMatch(operatorMarkup, /11111111-1111-4111-8111-111111111111|data-partners-operator-id/);
  assert.match(operatorMarkup, /data-partners-operator-email="finance@example\.test"/);
  assert.match(operatorMarkup, /Retirer Risque/);
  assert.match(operatorMarkup, /disabled title="Un TOTP vérifié est obligatoire pour Finance\.[\s\S]*Activer Finance/);
  const validOperator = {
    operator_key: `op_${'c'.repeat(64)}`,
    email: 'risk@example.test',
    is_admin: true,
    account_active: true,
    email_confirmed: true,
    totp_verified: true,
    capabilities: { support: true, risk: true, finance: false },
  };
  assert.equal(page._partnersValidCapabilityOperator(validOperator), true);
  assert.equal(page._partnersValidCapabilityOperator({
    ...validOperator,
    user_id: '11111111-1111-4111-8111-111111111111',
  }), false, 'an Auth UUID field invalidates the operator envelope');
  const suspendedMarkup = page._partnersCapabilityCards(capabilityState, true, [{
    ...validOperator,
    account_active: false,
    capabilities: { support: true, risk: false, finance: false },
  }]);
  assert.match(suspendedMarkup, /Compte suspendu/);
  assert.match(suspendedMarkup, /Retirer Support/);
  assert.match(suspendedMarkup, /disabled title="Le compte est supprimé, suspendu ou banni\.[\s\S]*Activer Finance/);

  page._partnersCapabilities = { support: true, risk: false, finance: false };
  page._partnersCanManageRelease = false;
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_enabled', false), true);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_enabled', true), false);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_cash_pilot_allowlist_only', true), true);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_cash_pilot_allowlist_only', false), false);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_earnings_enabled', false), true);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_earnings_enabled', true), false);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_credit_redemptions_enabled', false), true);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_credit_redemptions_enabled', true), false);
  assert.equal(page._partnersCanUseReleaseControl('gate', 'membership_privacy_approved', true), false);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_payouts_live', false), false);
  assert.equal(page._partnersCanUseConfigurationAction('allowlist'), true);
  assert.equal(page._partnersCanUseConfigurationAction('program-create'), false);

  page._partnersCapabilities = { support: true, risk: true, finance: true };
  page._partnersCanManageRelease = true;
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_cash_pilot_allowlist_only', true), true);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_cash_pilot_allowlist_only', false), true);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_earnings_enabled', true), true);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_credit_redemptions_enabled', true), true);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_payouts_live', true), true);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_revolut_api_enabled', true), true);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_tv_relay_enabled', true), true);
  assert.equal(page._partnersCanUseReleaseControl('gate', 'membership_privacy_approved', true), true);
  assert.equal(page._partnersCanUseReleaseControl('gate', 'general_release_approved', true), true);
  assert.equal(page._partnersCanUseReleaseControl('gate', 'manual_payout_workflow_verified', true), true);
  assert.equal(page._partnersCanUseReleaseControl('gate', 'revolut_api_adapter_verified', true), true);
  assert.equal(page._partnersCanUseConfigurationAction('program-create'), true);
});

test('membership Privacy uses a distinct Risk AAL2 evidence contract', () => {
  const AdminPage = loadAdminPage({ getElementById() { return null; } });
  const page = Object.create(AdminPage.prototype);
  page._partnersCapabilities = { support: false, risk: true, finance: false };
  page._partnersCanManageRelease = false;
  assert.equal(
    page._partnersCanUseReleaseControl(
      'gate',
      'membership_privacy_approved',
      true,
    ),
    true,
  );
  assert.deepEqual(
    Array.from(page._partnersApprovalRequiredDocuments(
      'membership_privacy_approved',
    )),
    [
      'approval_record',
      'deployment_proof',
      'membership_privacy_notice',
      'membership_records_of_processing',
      'membership_minimization_review',
    ],
  );
  const cashPrivacy = Array.from(
    page._partnersApprovalRequiredDocuments('privacy_approved'),
  );
  assert.ok(cashPrivacy.includes('dpia'));
  assert.ok(cashPrivacy.includes('biometric_consent'));
  assert.ok(!cashPrivacy.includes('membership_minimization_review'));
  assert.match(source, /Privacy de l’adhésion publique/);
  assert.match(source, /AIPD Privacy du virement cash/);
});

test('Admin Partners renders Revolut Basic manual as production and keeps the API separate', () => {
  const revolut = {
    innerHTML: '',
    removeAttribute() {},
  };
  const routes = {
    innerHTML: '',
    removeAttribute() {},
  };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return {
        'partners-admin-revolut': revolut,
        'partners-admin-routes': routes,
      }[id] || null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._renderPartnersRevolutStatus({
    schema_version: 1,
    provider: 'revolut_business',
    production_mode: 'revolut_manual',
    plan: 'basic',
    api_enabled: false,
    api_adapter_verified: false,
    routes: [{
      country_code: 'FR',
      currency: 'EUR',
      status: 'active',
      execution_adapter: 'revolut_manual',
      updated_at: '2026-07-30T10:00:00Z',
    }],
    counts: {
      manual_batches_open: 2,
      manual_batches_exception: 0,
      reconciliation_pending: 1,
      manual_statement_pending: 1,
      statement_matched_review_pending: 0,
      api_jobs_ready: 0,
      api_dead_letter: 0,
    },
  });

  assert.match(visibleUiMarkup(revolut.innerHTML), /Revolut Business · Basic/);
  assert.match(visibleUiMarkup(revolut.innerHTML), /Production · manuel/);
  assert.match(visibleUiMarkup(revolut.innerHTML), /Flag DB API désactivé/);
  assert.match(visibleUiMarkup(revolut.innerHTML), /Gate adaptateur API non validé/);
  assert.match(visibleUiMarkup(revolut.innerHTML), /saisies en attente de relevé/);
  assert.match(visibleUiMarkup(revolut.innerHTML), /relevés à valider/);
  assert.match(visibleUiMarkup(routes.innerHTML), /FR · EUR/);
  assert.match(visibleUiMarkup(routes.innerHTML), />1<\/strong><span>corridors configurés/);
  assert.match(visibleUiMarkup(revolut.innerHTML), /Aucun virement n’est déclenché automatiquement/);
  assert.doesNotMatch(source, /data\.routes\.slice\(0,\s*50\)/);
});

test('Admin partner detail renders only sanitized Revolut profile status', () => {
  const detail = {
    innerHTML: '',
    removeAttribute() {},
  };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-detail' ? detail : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: false, finance: true };
  page._renderPartnerDetail({
    account: {
      account_id: '11111111-1111-4111-8111-111111111111',
      partner_key: 'partner-01',
      status: 'active',
      verification_status: 'verified',
      contract_status: 'accepted',
      country_code: 'FR',
    },
    readiness: {},
    activity: [],
  }, {
    schema_version: 1,
    profiles: [{
      provider: 'revolut',
      currency: 'EUR',
      status: 'active',
      display_masked: 'J. H. · FR76••••1234',
      payment_method_configured: false,
      binding_verified: true,
      binding_version: 1,
      beneficiary_token_ref: 'must-never-render',
    }],
    bindings: [{
      key: 'rbb_0123456789abcdef01234567',
      currency: 'EUR',
      version: 2,
      fingerprint_key_version: 1,
      status: 'pending',
      display_masked: 'J. H. · FR76••••1234',
      payment_method_configured: false,
      beneficiary_fingerprint_hmac: 'must-never-render-hmac',
      mapping_evidence_hash: 'must-never-render-evidence',
    }, {
      key: 'rbb_1123456789abcdef01234567',
      currency: 'USD',
      version: 1,
      fingerprint_key_version: 1,
      status: 'active',
      display_masked: 'J. H. · ****5678',
      payment_method_configured: false,
      revocation: null,
    }, {
      key: 'rbb_2123456789abcdef01234567',
      currency: 'GBP',
      version: 1,
      fingerprint_key_version: 1,
      status: 'active',
      display_masked: 'J. H. · ****9012',
      payment_method_configured: false,
      revocation: {
        key: 'rbr_0123456789abcdef01234567',
        status: 'pending',
      },
    }],
  });

  assert.match(visibleUiMarkup(detail.innerHTML), /Bénéficiaire Revolut/);
  assert.match(visibleUiMarkup(detail.innerHTML), /J\. H\. · FR76••••1234/);
  assert.match(visibleUiMarkup(detail.innerHTML), /Mode manuel uniquement/);
  assert.doesNotMatch(visibleUiMarkup(detail.innerHTML), /data-partners-action="revolut-binding-propose"/);
  assert.match(visibleUiMarkup(detail.innerHTML), /data-partners-action="revolut-binding-verify"/);
  assert.match(visibleUiMarkup(detail.innerHTML), /data-partners-action="revolut-binding-reject"/);
  assert.match(visibleUiMarkup(detail.innerHTML), /data-partners-action="revolut-binding-revoke-request"/);
  assert.match(visibleUiMarkup(detail.innerHTML), /data-partners-action="revolut-binding-revoke-confirm"/);
  assert.doesNotMatch(visibleUiMarkup(detail.innerHTML), /must-never-render/);
});

test('Admin beneficiary proposal uses only the trusted Edge binding route', async () => {
  let request = null;
  const AdminPage = loadAdminPage(null, async (url, init) => {
    request = { url, init };
    return {
      ok: true,
      json: async () => ({
        data: {
          schema_version: 1,
          action: 'revolut_beneficiary_binding_proposed',
          binding: {
            key: 'rbb_0123456789abcdef01234567',
            currency: 'EUR',
            version: 1,
            fingerprint_key_version: 1,
            status: 'pending',
            display_masked: 'J. H. · ****1234',
            payment_method_configured: false,
          },
        },
      }),
    };
  });
  const page = new AdminPage({});
  page._sbUrl = () => 'https://example.supabase.co';
  page._token = () => 'user-access-token';
  const proposal = {
    request_key: `por_${'1'.repeat(24)}`,
    beneficiary_token_ref: '22222222-2222-4222-8222-222222222222',
    beneficiary_payment_method_ref: null,
    display_masked: 'J. H. · ****1234',
    mapping_evidence_hash: 'a'.repeat(64),
    justification: 'Registre Finance vérifié.',
  };
  const binding = await page._partnersProposeRevolutBeneficiary(proposal);

  assert.equal(binding.status, 'pending');
  assert.equal(
    request.url,
    'https://example.supabase.co/functions/v1/norva-partners-revolut-payout/manual/beneficiaries/propose',
  );
  assert.equal(request.init.headers.Authorization, 'Bearer user-access-token');
  assert.deepEqual(JSON.parse(request.init.body), proposal);
  assert.doesNotMatch(
    request.init.body,
    /fingerprint_hmac|attestation_hmac|fingerprint_key_version/,
  );
});

test('Admin Partners renders unique Norva references and dual-control reconciliation actions', () => {
  const settlement = {
    innerHTML: '',
    removeAttribute() {},
  };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-settlements' ? settlement : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: false, finance: true };
  page._renderPartnersRevolutReconciliation({
    schema_version: 1,
    total: 2,
    items: [{
      statement_row_key: 'rsr_0123456789abcdef01234567',
      reference: 'NORVA-A1B2C3D4E5F6',
      amount_minor: 1999,
      currency: 'EUR',
      destination_masked: 'FR76••••1234',
      value_date: '2026-07-30',
      match_status: 'matched',
      discrepancy_code: null,
      effective_status: 'matched',
      review_key: null,
      decision: null,
      observed_at: '2026-07-30T10:00:00Z',
    }, {
      statement_row_key: 'rsr_89abcdef0123456701234567',
      reference: 'NORVA-ABCDEF123456',
      amount_minor: 2500,
      currency: 'EUR',
      destination_masked: 'FR14••••9876',
      value_date: '2026-07-30',
      match_status: 'matched',
      discrepancy_code: null,
      effective_status: 'reviewed',
      review_key: 'rmr_0123456789abcdef01234567',
      decision: null,
      observed_at: '2026-07-30T10:00:00Z',
    }],
  });

  assert.match(visibleUiMarkup(settlement.innerHTML), /NORVA-A1B2C3D4E5F6/);
  assert.match(visibleUiMarkup(settlement.innerHTML), /data-partners-action="revolut-reconciliation-review"/);
  assert.match(visibleUiMarkup(settlement.innerHTML), /data-partners-action="revolut-reconciliation-confirm"/);
  assert.match(visibleUiMarkup(settlement.innerHTML), /data-partners-action="revolut-reconciliation-quarantine"/);
  assert.match(visibleUiMarkup(settlement.innerHTML), /destination attendue FR76••••1234/);
  assert.match(visibleUiMarkup(settlement.innerHTML), /à comparer dans Revolut/);
  assert.match(source, /provider_not_completed/);
  assert.match(visibleUiMarkup(settlement.innerHTML), /Importer un relevé CSV/);
  assert.doesNotMatch(visibleUiMarkup(settlement.innerHTML), /provider_transaction_id|beneficiary_token_ref/i);
});

test('Admin Partners renders paginated sanitized Revolut incidents with maker-checker actions', () => {
  const incidents = {
    innerHTML: '',
    removeAttribute() {},
  };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return id === 'partners-admin-reconciliation-incidents'
        ? incidents
        : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: false, finance: true };
  page._renderPartnersRevolutIncidents({
    schema_version: 1,
    filter: 'action_required',
    total: 3,
    action_required: 3,
    limit: 25,
    offset: 0,
    items: [{
      key: 'rri_0123456789abcdef01234567',
      status: 'open',
      priority: 1,
      kind: 'amount_mismatch',
      source_reference: 'NORVA-A1B2C3D4E5F6',
      source_transaction_fingerprint: '0123456789ab',
      source_state: 'COMPLETED',
      source_amount_minor: 1999,
      source_currency: 'EUR',
      expected_reference: 'NORVA-A1B2C3D4E5F6',
      expected_amount_minor: 2499,
      expected_currency: 'EUR',
      value_date: '2026-07-30',
      observed_at: '2026-07-30T10:00:00Z',
      pending_review: null,
      resolution: null,
      resolved_at: null,
      transaction_alias: null,
      eligible_actions: ['quarantine'],
    }, {
      key: 'rri_89abcdef0123456701234567',
      status: 'quarantined',
      priority: 3,
      kind: 'unknown_reference',
      source_reference: 'NORVA-ABCDEF123456',
      source_transaction_fingerprint: 'abcdef012345',
      source_state: 'COMPLETED',
      source_amount_minor: 2500,
      source_currency: 'EUR',
      expected_reference: null,
      expected_amount_minor: null,
      expected_currency: null,
      value_date: '2026-07-30',
      observed_at: '2026-07-30T10:05:00Z',
      pending_review: {
        key: 'rir_0123456789abcdef01234567',
        proposed_action: 'remap_exact_and_settle',
        target_reference: 'NORVA-111111111111',
        requested_at: '2026-07-30T10:06:00Z',
      },
      resolution: null,
      resolved_at: null,
      transaction_alias: null,
      eligible_actions: ['remap_exact_and_settle', 'quarantine'],
    }, {
      key: 'rri_fedcba987654321001234567',
      status: 'resolved',
      priority: 2,
      kind: 'transaction_mismatch',
      source_reference: 'NORVA-222222222222',
      source_transaction_fingerprint: 'fedcba987654',
      source_state: 'COMPLETED',
      source_amount_minor: 3000,
      source_currency: 'USD',
      expected_reference: 'NORVA-222222222222',
      expected_amount_minor: 3000,
      expected_currency: 'USD',
      value_date: '2026-07-30',
      observed_at: '2026-07-30T10:10:00Z',
      pending_review: null,
      resolution: 'remap_exact_and_settle',
      resolved_at: '2026-07-30T10:20:00Z',
      transaction_alias: {
        key: 'rta_0123456789abcdef01234567',
        superseded_transaction_fingerprint: '001122334455',
        authoritative_transaction_fingerprint: 'fedcba987654',
      },
      eligible_actions: [],
    }],
  });

  assert.equal(page._partnersReconciliationIncidents.size, 3);
  assert.match(visibleUiMarkup(incidents.innerHTML), /3 action\(s\) requise\(s\)/);
  assert.match(visibleUiMarkup(incidents.innerHTML), /data-partners-action="revolut-incident-review"/);
  assert.match(visibleUiMarkup(incidents.innerHTML), /data-partners-resolution="quarantine"/);
  assert.match(visibleUiMarkup(incidents.innerHTML), /data-partners-action="revolut-incident-decide-approve"/);
  assert.match(visibleUiMarkup(incidents.innerHTML), /data-partners-action="revolut-incident-decide-quarantine"/);
  assert.match(visibleUiMarkup(incidents.innerHTML), /Contrôle 1\/2 enregistré/);
  assert.match(visibleUiMarkup(incidents.innerHTML), /empreinte 0123456789ab/);
  assert.match(visibleUiMarkup(incidents.innerHTML), /Alias append-only · empreinte autoritaire/);
  assert.doesNotMatch(visibleUiMarkup(incidents.innerHTML), /rta_0123456789abcdef01234567/);
  assert.match(visibleUiMarkup(incidents.innerHTML), /data-partners-action="revolut-incident-page"/);
  assert.doesNotMatch(
    visibleUiMarkup(incidents.innerHTML),
    /source_provider_transaction_hash|source_evidence_hash|statement_row_key|beneficiary_token_ref/i,
  );
});

test('Admin Partners formats authoritative currency exponents and never guesses a missing exponent', () => {
  const incidents = {
    innerHTML: '',
    removeAttribute() {},
  };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return id === 'partners-admin-reconciliation-incidents'
        ? incidents
        : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: false, finance: true };
  page._renderPartnersRevolutIncidents({
    schema_version: 1,
    filter: 'action_required',
    total: 2,
    action_required: 2,
    limit: 25,
    offset: 0,
    items: [
      revolutIncident(),
      revolutIncident({
        key: 'rri_89abcdef0123456701234567',
        source_reference: 'NORVA-ABCDEF123456',
        source_transaction_fingerprint: 'abcdef012345',
        source_amount_minor: 1234,
        source_currency_exponent: null,
        expected_reference: null,
        expected_amount_minor: null,
        expected_currency: null,
        expected_currency_exponent: null,
      }),
    ],
  });

  assert.equal(page._partnersReconciliationIncidents.size, 2);
  assert.match(visibleUiMarkup(incidents.innerHTML), /P1 · Montant différent/);
  assert.match(visibleUiMarkup(incidents.innerHTML), /1\u202f234,56\u00a0€/);
  assert.match(visibleUiMarkup(incidents.innerHTML), /10,00\u00a0€/);
  assert.match(visibleUiMarkup(incidents.innerHTML), /1\u202f234 EUR en unités mineures/);
});

test('Admin Partners rejects internally inconsistent Revolut incident envelopes', () => {
  const incidents = {
    innerHTML: '',
    removeAttribute() {},
  };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return id === 'partners-admin-reconciliation-incidents'
        ? incidents
        : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: false, finance: true };
  const render = (item) => page._renderPartnersRevolutIncidents({
    schema_version: 1,
    filter: 'action_required',
    total: 1,
    action_required: 1,
    limit: 25,
    offset: 0,
    items: [item],
  });

  render(revolutIncident({
    pending_review: {
      key: 'rir_0123456789abcdef01234567',
      proposed_action: 'quarantine',
      target_reference: 'NORVA-111111111111',
      requested_at: '2026-07-30T10:01:00Z',
    },
  }));
  assert.equal(page._partnersReconciliationIncidents.size, 0);
  assert.match(visibleUiMarkup(incidents.innerHTML), /Observation autoritative indisponible/);

  render(revolutIncident({
    status: 'resolved',
    resolution: 'remap_exact_and_settle',
    resolved_at: '2026-07-30T10:05:00Z',
    eligible_actions: [],
    transaction_alias: null,
  }));
  assert.equal(page._partnersReconciliationIncidents.size, 0);
  assert.match(visibleUiMarkup(incidents.innerHTML), /Observation autoritative indisponible/);
});

test('Admin Partners binds incident evidence to exact maker-checker confirmations', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: false, finance: true };
  page._partnersEnsureAal2 = async () => true;
  const incidentKey = 'rri_0123456789abcdef01234567';
  const reviewKey = 'rir_0123456789abcdef01234567';
  const evidenceHash = 'a'.repeat(64);
  const secondEvidenceHash = 'b'.repeat(64);
  const firstObservedAt = '2026-07-30T10:00:00.000Z';
  const secondObservedAt = '2026-07-30T10:01:00.000Z';
  const incident = {
    key: incidentKey,
    status: 'open',
    kind: 'transaction_mismatch',
    reference: 'NORVA-A1B2C3D4E5F6',
    fingerprint: '0123456789ab',
    sourceState: 'COMPLETED',
    amount: 1999,
    currency: 'EUR',
    exponent: 2,
    expectedReference: 'NORVA-A1B2C3D4E5F6',
    expectedAmount: 1999,
    expectedCurrency: 'EUR',
    expectedExponent: 2,
    observedAt: '2026-07-30T09:00:00Z',
    eligibleActions: ['settle_exact', 'quarantine'],
    pendingReview: null,
    transactionAlias: null,
    resolution: null,
    resolvedAt: null,
  };
  page._partnersReconciliationIncidents = new Map([[incidentKey, incident]]);
  page._partnersJustification = async () => 'Contrôle Finance indépendant documenté';
  page._confirm = async () => true;
  const prompts = [];
  page._partnersPrompt = async (message, initial, validate) => {
    const expected = message.split('Saisissez exactement :\n')[1];
    assert.equal(validate(expected), true);
    prompts.push(expected);
    return expected;
  };
  page._partnersPickEvidenceHash = async () => ({
    hash: evidenceHash,
    observedAt: firstObservedAt,
  });
  const calls = [];
  page._rpc = async (name, args) => {
    calls.push({ name, args });
    return {
      schema_version: 1,
      action: 'revolut_reconciliation_incident_reviewed',
      replayed: false,
      review: {
        key: reviewKey,
        incident_key: incidentKey,
        proposed_action: 'settle_exact',
        target_reference: 'NORVA-A1B2C3D4E5F6',
      },
    };
  };

  const reviewed = await page._runPartnersAdminAction({
    dataset: {
      partnersAction: 'revolut-incident-review',
      partnersIncident: incidentKey,
      partnersResolution: 'settle_exact',
    },
  });
  const reviewEpoch = Math.floor(Date.parse(firstObservedAt) / 1000);
  assert.equal(
    prompts[0],
    `REVIEW-RECON:${incidentKey}:SETTLE_EXACT:NORVA-A1B2C3D4E5F6:0123456789ab:1999:EUR:${reviewEpoch}`,
  );
  assert.match(reviewed, /Contrôle 1\/2 enregistré/);
  assert.equal(
    calls[0].name,
    'admin_partners_revolut_reconciliation_incident_review',
  );
  assert.equal(calls[0].args.p_provider_search_evidence_hash, evidenceHash);
  assert.doesNotMatch(JSON.stringify(calls[0].args), /source_provider_transaction_hash/);

  incident.status = 'quarantined';
  incident.pendingReview = {
    key: reviewKey,
    proposedAction: 'settle_exact',
    targetReference: 'NORVA-A1B2C3D4E5F6',
    requestedAt: firstObservedAt,
  };
  page._partnersPickEvidenceHash = async () => ({
    hash: secondEvidenceHash,
    observedAt: secondObservedAt,
  });
  page._rpc = async (name, args) => {
    calls.push({ name, args });
    return {
      schema_version: 1,
      action: 'revolut_reconciliation_incident_decided',
      replayed: false,
      decision: {
        key: 'rid_0123456789abcdef01234567',
        incident_key: incidentKey,
        status: 'resolved',
        verdict: 'approved',
        resolution: 'settle_exact',
        target_reference: 'NORVA-A1B2C3D4E5F6',
      },
    };
  };
  const decided = await page._runPartnersAdminAction({
    dataset: {
      partnersAction: 'revolut-incident-decide-approve',
      partnersIncident: incidentKey,
    },
  });
  const decisionEpoch = Math.floor(Date.parse(secondObservedAt) / 1000);
  assert.equal(
    prompts[1],
    `DECIDE-RECON:${reviewKey}:APPROVE:SETTLE_EXACT:NORVA-A1B2C3D4E5F6:0123456789ab:1999:EUR:${decisionEpoch}`,
  );
  assert.match(decided, /Contrôle 2\/2 approuvé/);
  assert.equal(
    calls[1].name,
    'admin_partners_revolut_reconciliation_incident_decide',
  );
  assert.equal(calls[1].args.p_decision, 'approved');
  assert.equal(
    calls[1].args.p_provider_search_evidence_hash,
    secondEvidenceHash,
  );
});

test('Admin Partners checker quarantine uses an exact typed decision and validates the append-only response', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: false, finance: true };
  page._partnersEnsureAal2 = async () => true;
  const incidentKey = 'rri_0123456789abcdef01234567';
  const reviewKey = 'rir_0123456789abcdef01234567';
  const observedAt = '2026-07-30T10:02:03.000Z';
  page._partnersReconciliationIncidents = new Map([[
    incidentKey,
    {
      key: incidentKey,
      status: 'quarantined',
      kind: 'transaction_mismatch',
      reference: 'NORVA-A1B2C3D4E5F6',
      fingerprint: '0123456789ab',
      sourceState: 'COMPLETED',
      amount: 1999,
      currency: 'EUR',
      exponent: 2,
      expectedReference: 'NORVA-A1B2C3D4E5F6',
      expectedAmount: 1999,
      expectedCurrency: 'EUR',
      expectedExponent: 2,
      observedAt: '2026-07-30T09:00:00Z',
      eligibleActions: ['settle_exact', 'quarantine'],
      pendingReview: {
        key: reviewKey,
        proposedAction: 'settle_exact',
        targetReference: 'NORVA-A1B2C3D4E5F6',
        requestedAt: '2026-07-30T10:00:00Z',
      },
      transactionAlias: null,
      resolution: null,
      resolvedAt: null,
    },
  ]]);
  page._partnersJustification = async () => 'Refus Finance indépendant documenté';
  page._confirm = async () => true;
  page._partnersPickEvidenceHash = async () => ({
    hash: 'c'.repeat(64),
    observedAt,
  });
  let typedConfirmation = null;
  page._partnersPrompt = async (message, initial, validate) => {
    typedConfirmation = message.split('Saisissez exactement :\n')[1];
    assert.equal(validate(typedConfirmation), true);
    return typedConfirmation;
  };
  let call = null;
  page._rpc = async (name, args) => {
    call = { name, args };
    return {
      schema_version: 1,
      action: 'revolut_reconciliation_incident_decided',
      replayed: false,
      decision: {
        key: 'rid_0123456789abcdef01234567',
        incident_key: incidentKey,
        status: 'quarantined',
        verdict: 'quarantined',
        resolution: 'quarantine',
        target_reference: 'NORVA-A1B2C3D4E5F6',
      },
    };
  };

  const result = await page._runPartnersAdminAction({
    dataset: {
      partnersAction: 'revolut-incident-decide-quarantine',
      partnersIncident: incidentKey,
    },
  });
  const epoch = Math.floor(Date.parse(observedAt) / 1000);
  assert.equal(
    typedConfirmation,
    `DECIDE-RECON:${reviewKey}:QUARANTINE:SETTLE_EXACT:NORVA-A1B2C3D4E5F6:0123456789ab:1999:EUR:${epoch}`,
  );
  assert.equal(
    call.name,
    'admin_partners_revolut_reconciliation_incident_decide',
  );
  assert.equal(call.args.p_decision, 'quarantined');
  assert.match(result, /placée en quarantaine sans écriture financière/);
});

test('Admin Partners renders append-only Revolut returns with maker-checker actions', () => {
  const returns = {
    innerHTML: '',
    removeAttribute() {},
  };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-returns' ? returns : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: false, finance: true };
  page._renderPartnersRevolutReturns({
    schema_version: 1,
    total: 2,
    items: [{
      observation_key: 'rro_0123456789abcdef01234567',
      execution_key: 'rpe_0123456789abcdef01234567',
      reference: 'NORVA-A1B2C3D4E5F6',
      adapter: 'revolut_manual',
      destination_masked: 'FR76••••1234',
      return_kind: 'pre_settlement_release',
      provider_state: 'FAILED',
      amount_minor: 1999,
      currency: 'EUR',
      observed_at: '2026-07-30T10:00:00Z',
      status: 'pending',
      review_key: null,
      review_conclusion: null,
    }, {
      observation_key: 'rro_89abcdef0123456701234567',
      execution_key: 'rpe_89abcdef0123456701234567',
      reference: 'NORVA-ABCDEF123456',
      adapter: 'revolut_manual',
      destination_masked: 'FR14••••9876',
      return_kind: 'post_settlement_return',
      provider_state: 'REVERTED',
      amount_minor: 2500,
      currency: 'EUR',
      observed_at: '2026-07-30T11:00:00Z',
      status: 'reviewed',
      review_key: 'rrv_0123456789abcdef01234567',
      review_conclusion: 'eligible',
    }],
  });

  assert.match(visibleUiMarkup(returns.innerHTML), /NORVA-A1B2C3D4E5F6/);
  assert.match(visibleUiMarkup(returns.innerHTML), /Déblocage avant règlement/);
  assert.match(visibleUiMarkup(returns.innerHTML), /Retour après règlement/);
  assert.match(visibleUiMarkup(returns.innerHTML), /data-partners-action="revolut-return-review-eligible"/);
  assert.match(visibleUiMarkup(returns.innerHTML), /data-partners-action="revolut-return-review-quarantine"/);
  assert.match(visibleUiMarkup(returns.innerHTML), /data-partners-action="revolut-return-decide-confirm"/);
  assert.match(visibleUiMarkup(returns.innerHTML), /aucun paiement déjà confirmé n’est réécrit/);
  assert.doesNotMatch(
    visibleUiMarkup(returns.innerHTML),
    /provider_transaction_id|beneficiary_token_ref|source_evidence_hash/i,
  );
});

test('Admin Partners renders dual-control manual releases and late recovery', () => {
  const controls = { innerHTML: '', removeAttribute() {} };
  const late = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return {
        'partners-admin-manual-controls': controls,
        'partners-admin-late-completions': late,
      }[id] || null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: false, finance: true };
  page._renderPartnersRevolutManualControls({
    schema_version: 1,
    total: 1,
    items: [{
      key: 'rmc_0123456789abcdef01234567',
      type: 'batch_cancellation',
      status: 'pending',
      batch_key: 'rmb_0123456789abcdef01234567',
      reference_set_hash: 'a'.repeat(64),
      references: [{
        reference: 'NORVA-A1B2C3D4E5F6',
        amount_minor: 1999,
        currency: 'EUR',
        currency_exponent: 2,
      }],
      requested_at: '2026-07-30T12:00:00Z',
      eligible_at: '2026-08-06T12:00:00Z',
    }],
  });
  page._renderPartnersRevolutLateCompletions({
    schema_version: 1,
    total: 2,
    items: [{
      observation_key: 'rlc_0123456789abcdef01234567',
      execution_key: 'rpe_0123456789abcdef01234567',
      reference: 'NORVA-A1B2C3D4E5F6',
      adapter: 'revolut_manual',
      destination_masked: 'FR76****1234',
      amount_minor: 1999,
      currency: 'EUR',
      observed_at: '2026-07-30T12:00:00Z',
      status: 'pending',
      review_key: null,
      review_conclusion: null,
    }, {
      observation_key: 'rlc_89abcdef0123456701234567',
      execution_key: 'rpe_89abcdef0123456701234567',
      reference: 'NORVA-ABCDEF123456',
      adapter: 'revolut_manual',
      destination_masked: 'FR14****9876',
      amount_minor: 2500,
      currency: 'EUR',
      observed_at: '2026-07-30T13:00:00Z',
      status: 'reviewed',
      review_key: 'rlv_0123456789abcdef01234567',
      review_conclusion: 'eligible',
    }],
  });

  assert.match(
    visibleUiMarkup(controls.innerHTML),
    /data-partners-action="revolut-manual-control-confirm"/,
  );
  assert.match(
    visibleUiMarkup(controls.innerHTML),
    /data-partners-action="revolut-manual-control-reject"/,
  );
  assert.match(visibleUiMarkup(controls.innerHTML), /Annulation intégrale du lot/);
  assert.doesNotMatch(visibleUiMarkup(controls.innerHTML), new RegExp('a'.repeat(64)));
  assert.doesNotMatch(
    visibleUiMarkup(controls.innerHTML),
    /provider_search_evidence_hash|requested_by_pseudonym/i,
  );
  assert.match(
    visibleUiMarkup(late.innerHTML),
    /data-partners-action="revolut-late-review-eligible"/,
  );
  assert.match(
    visibleUiMarkup(late.innerHTML),
    /data-partners-action="revolut-late-decide-confirm"/,
  );
  assert.match(visibleUiMarkup(late.innerHTML), /NORVA-A1B2C3D4E5F6/);
  assert.doesNotMatch(
    visibleUiMarkup(late.innerHTML),
    /provider_transaction_id|source_evidence_hash|beneficiary_token_ref/i,
  );
});

test('Admin Partners verifies statement-first exports without manually copied bank IDs', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  const batchKey = 'rmb_0123456789abcdef01234567';
  const header = 'norva_reference\tbeneficiary_token_ref\tdestination_masked\tamount_minor\tcurrency\tcurrency_exponent\tentered_in_revolut';
  const firstRow = 'NORVA-A1B2C3D4E5F6\t11111111-1111-4111-8111-111111111111\tFR76****1234\t1999\tEUR\t2\t';
  const tsv = `${header}\r\n${firstRow}\r\n`;
  const exportHash = await page._partnersSha256Hex(tsv);
  const payload = {
    schema_version: 1,
    action: 'revolut_manual_batch_export',
    replayed: false,
    batch: {
      key: batchKey,
      status: 'exported',
      item_count: 1,
      total_minor: 1999,
      currency: 'EUR',
      currency_exponent: 2,
      canonical_manifest_hash: 'a'.repeat(64),
      export_file_hash: exportHash,
      file_name: `norva-revolut-${batchKey}.tsv`,
      progress_file_hash: null,
      progress_file_name: null,
    },
    items: [{
      execution_key: 'rpe_0123456789abcdef01234567',
      reference: 'NORVA-A1B2C3D4E5F6',
      destination_masked: 'FR76****1234',
      amount_minor: 1999,
      currency: 'EUR',
      currency_exponent: 2,
      entered_in_revolut: false,
      statement_matched: false,
      state: 'prepared',
    }],
    tsv,
    progress_tsv: null,
  };

  const validated = await page._partnersValidateRevolutBatchExport(
    payload,
    batchKey,
  );
  assert.equal(validated.canonicalTsv, tsv);
  assert.equal(validated.progressTsv, null);

  const completed = tsv.replace(/\t\r\n$/, '\tYES\r\n');
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      page._partnersParseRevolutSubmissionTsv(completed, validated),
    )),
    [{ reference: 'NORVA-A1B2C3D4E5F6' }],
  );
  assert.throws(
    () => page._partnersParseRevolutSubmissionTsv(tsv, validated),
    /empty_submission_file/,
  );
  assert.throws(
    () => page._partnersParseRevolutSubmissionTsv(
      completed.replace('\tYES\r\n', '\tyes\r\n'),
      validated,
    ),
    /invalid_submission_record/,
  );
  assert.throws(
    () => page._partnersParseRevolutSubmissionTsv(
      completed.replace('\t1999\tEUR\t', '\t2999\tEUR\t'),
      validated,
    ),
    /invalid_submission_record/,
  );
  await assert.rejects(
    page._partnersValidateRevolutBatchExport(
      { ...payload, tsv: tsv.replace('1999', '2999') },
      batchKey,
    ),
    /invalid_manual_batch_item|manual_batch_export_hash_mismatch/,
  );

  const secondRow = 'NORVA-ABCDEF123456\t22222222-2222-4222-8222-222222222222\tFR14****9876\t2500\tEUR\t2\t';
  const partialTsv = `${header}\r\n${firstRow}\r\n${secondRow}\r\n`;
  const progressHeader = 'norva_reference\tentered_in_revolut\tstatement_matched\tstate\treconciliation_status';
  const progressTsv = `${progressHeader}\r\n`
    + 'NORVA-A1B2C3D4E5F6\tYES\t\tsubmitted\tpending\r\n'
    + 'NORVA-ABCDEF123456\t\t\texported\tnot_ready\r\n';
  const partialPayload = {
    schema_version: 1,
    action: 'revolut_manual_batch_export',
    replayed: true,
    batch: {
      ...payload.batch,
      status: 'partially_submitted',
      item_count: 2,
      total_minor: 4499,
      export_file_hash: await page._partnersSha256Hex(partialTsv),
      progress_file_hash: await page._partnersSha256Hex(progressTsv),
      progress_file_name: `norva-revolut-progress-${batchKey}.tsv`,
    },
    items: [{
      ...payload.items[0],
      entered_in_revolut: true,
      statement_matched: false,
      state: 'submitted',
    }, {
      execution_key: 'rpe_89abcdef0123456701234567',
      reference: 'NORVA-ABCDEF123456',
      destination_masked: 'FR14****9876',
      amount_minor: 2500,
      currency: 'EUR',
      currency_exponent: 2,
      entered_in_revolut: false,
      statement_matched: false,
      state: 'exported',
    }],
    tsv: partialTsv,
    progress_tsv: progressTsv,
  };
  const partial = await page._partnersValidateRevolutBatchExport(
    partialPayload,
    batchKey,
  );
  assert.equal(partial.canonicalTsv, partialTsv);
  assert.equal(partial.progressTsv, progressTsv);

  const progressed = partialTsv
    .replace(
      /(NORVA-A1B2C3D4E5F6[^\r\n]*)\t\r\n/,
      '$1\tYES\r\n',
    )
    .replace(
      /(NORVA-ABCDEF123456[^\r\n]*)\t\r\n$/,
      '$1\tYES\r\n',
    );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      page._partnersParseRevolutSubmissionTsv(progressed, partial),
    )),
    [
      { reference: 'NORVA-A1B2C3D4E5F6' },
      { reference: 'NORVA-ABCDEF123456' },
    ],
  );
  assert.throws(
    () => page._partnersParseRevolutSubmissionTsv(
      progressed.replace(
        'NORVA-A1B2C3D4E5F6',
        'NORVA-FFFFFFFFFFFF',
      ),
      partial,
    ),
    /invalid_submission_record/,
  );
});

test('Admin Partners never renders an account UUID as the visible partner reference', () => {
  const section = source.slice(
    source.indexOf('// ── Page: Norva Partners'),
    source.indexOf('// ── Page: Providers'),
  );
  assert.match(section, /data-partner-id="\$\{AdminPage\.esc\(row\.id\)\}"/);
  assert.match(section, /const ref = String\(row\.partner_key \|\| [^\n]*'Partenaire'/);
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

  assert.match(visibleUiMarkup(analytics.innerHTML), /Performance Partners sur 30 jours/);
  assert.match(visibleUiMarkup(analytics.innerHTML), /Les clics ne sont pas encore instrumentés/);
  assert.match(visibleUiMarkup(analytics.innerHTML), /Accès Risque requis/);
  assert.match(visibleUiMarkup(analytics.innerHTML), /Accès Finance requis/);
  assert.match(visibleUiMarkup(analytics.innerHTML), /Versements live non activés/);
  assert.match(visibleUiMarkup(analytics.innerHTML), /Historique d’abonnement autoritatif non disponible/);
  assert.doesNotMatch(visibleUiMarkup(analytics.innerHTML), /referral_click_events_not_recorded/);
  assert.doesNotMatch(visibleUiMarkup(analytics.innerHTML), /<strong>0<\/strong>\s*<span>Clics/);
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

  assert.match(visibleUiMarkup(analytics.innerHTML), /google_play · USD/);
  assert.match(visibleUiMarkup(analytics.innerHTML), /1 234,56 USD/);
  assert.match(visibleUiMarkup(analytics.innerHTML), /246,91 USD/);
  assert.match(visibleUiMarkup(analytics.innerHTML), /987,65 USD/);
  assert.match(visibleUiMarkup(analytics.innerHTML), /Traitement des commissions incomplet/);
  assert.doesNotMatch(visibleUiMarkup(analytics.innerHTML), /9007199254740992/);
});

test('Admin Partners exposes five persistent internal views in the required order', () => {
  const section = source.slice(
    source.indexOf('// ── Page: Norva Partners'),
    source.indexOf('// ── Page: Providers'),
  );
  const labels = [
    'Vue d’ensemble',
    'Partenaires',
    'Risque/KYC',
    'Finance/Revolut',
    'Configuration',
  ];
  let cursor = -1;
  for (const label of labels) {
    const next = section.indexOf(`'${label}'`);
    assert.ok(next > cursor, `${label} must keep its requested position`);
    cursor = next;
  }
  assert.match(section, /role="tablist" aria-orientation="horizontal" aria-label="Vues Norva Partners"/);
  assert.match(section, /role="tabpanel"/);
  assert.match(source, /\.partners-workspace-nav\{position:sticky/);
  assert.match(source, /overscroll-behavior-inline:contain/);
  assert.match(source, /env\(safe-area-inset-bottom,0px\)/);
  assert.match(source, /\.partners-routes-toolbar input:focus-visible/);
  assert.match(source, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
});

test('Admin dialogs stay above global navigation and isolate every background layer', () => {
  assert.match(source, /\.crm-modal-back\{[^}]*z-index:10050/);
  for (const inset of ['top', 'right', 'bottom', 'left']) {
    assert.match(source, new RegExp(`safe-area-inset-${inset}`));
  }

  const node = (parentElement = null) => ({
    parentElement,
    children: [],
    isConnected: true,
    attributes: new Map(),
    matches() { return false; },
    hasAttribute(name) { return this.attributes.has(name); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
  });
  const body = node();
  const navbar = node(body);
  const main = node(body);
  const bottomNav = node(body);
  const pageRoot = node(main);
  const shell = node(pageRoot);
  const overlay = node(pageRoot);
  body.children = [navbar, main, bottomNav];
  main.children = [pageRoot];
  pageRoot.children = [shell, overlay];

  const AdminPage = loadAdminPage({
    body,
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  const restore = page._isolateModalBackground(overlay);
  for (const background of [shell, navbar, bottomNav]) {
    assert.equal(background.hasAttribute('inert'), true);
    assert.equal(background.getAttribute('aria-hidden'), 'true');
  }
  assert.equal(overlay.hasAttribute('inert'), false);

  restore();
  for (const background of [shell, navbar, bottomNav]) {
    assert.equal(background.hasAttribute('inert'), false);
    assert.equal(background.getAttribute('aria-hidden'), null);
  }
});

test('Admin guided Didit dialog opens at its title without scrolling past the prerequisites', () => {
  assert.match(source, /<h3 id="\$\{uid\}-title" tabindex="-1">/);
  assert.match(source, /const title = back\.querySelector\(`#\$\{uid\}-title`\);/);
  assert.match(source, /modal\?\.scrollTo\?\.\(\{ top: 0, behavior: 'auto' \}\);/);
  assert.match(source, /title\?\.focus\?\.\(\{ preventScroll: true \}\);/);
  assert.match(source, /event\.shiftKey && \(document\.activeElement === title/);
  assert.match(source, /class="partners-open-configuration"/);
  assert.match(source, /navigateToConfiguration: true/);
  assert.match(source, /this\._partnersSelectView\('configuration'/);
  assert.doesNotMatch(
    source,
    /\(formAvailable \? \(consent \|\| factorSelect \|\| totp\) : cancelButton\)\?\.focus/,
  );
});

test('Admin lazy-loader cache key tracks the exact AdminPage contents', () => {
  const version = appSource.match(
    /s\.src = '\/js\/pages\/AdminPage\.js\?v=([0-9a-f]{10})';/,
  )?.[1];
  assert.ok(version, 'AdminPage must use a ten-character content hash cache key');
  assert.equal(
    version,
    createHash('sha256')
      .update(source.replace(/\r\n/g, '\n'))
      .digest('hex')
      .slice(0, 10),
    'changing AdminPage must also invalidate its immutable lazy-load URL',
  );
});

test('Admin Partners module coordinator rejects stale responses', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  page._route = 'partners';
  page._partnersPageGeneration = 1;
  const pending = [];
  const signals = [];
  page._rpc = (_fn, _params, options = {}) => {
    signals.push(options.signal);
    return new Promise((resolve) => pending.push(resolve));
  };
  const rendered = [];

  const first = page._partnersLoadModule(
    'accounts',
    'admin_partners_accounts',
    {},
    (value) => rendered.push(value.version),
    { force: true, timeoutMs: 500 },
  );
  const second = page._partnersLoadModule(
    'accounts',
    'admin_partners_accounts',
    {},
    (value) => rendered.push(value.version),
    { force: true, timeoutMs: 500 },
  );
  pending[1]({ version: 'new' });
  await second;
  pending[0]({ version: 'old' });
  await first;

  assert.deepEqual(rendered, ['new']);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
});

test('Admin Partners capability refresh revokes stale operator responses', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  page._route = 'partners';
  page._partnersPageGeneration = 1;
  page._partnersRerenderCapabilityDependentModules = () => {};
  const renders = [];
  page._partnersRenderCapabilitiesArea = (data) => renders.push({
    canManage: data?.can_manage === true,
    operators: Array.isArray(page._partnersCapabilityOperators)
      ? page._partnersCapabilityOperators.map((operator) => operator.email)
      : page._partnersCapabilityOperators,
  });
  const pending = [];
  page._rpc = (fn, _params, options = {}) => new Promise((resolve, reject) => {
    pending.push({ fn, resolve, reject, signal: options.signal });
  });
  const manager = {
    schema_version: 1,
    can_manage: true,
    can_manage_release: false,
    capabilities: { support: true, risk: true, finance: false },
  };
  const revoked = {
    schema_version: 1,
    can_manage: false,
    can_manage_release: false,
    capabilities: { support: false, risk: false, finance: false },
  };
  const oldOperators = {
    schema_version: 1,
    operators: [{
      operator_key: `op_${'a'.repeat(64)}`,
      email: 'stale@example.test',
      is_admin: true,
      account_active: true,
      email_confirmed: true,
      totp_verified: true,
      capabilities: { support: true, risk: true, finance: true },
    }],
    requirements: {
      confirmed_admin: true,
      active_admin: true,
      finance_totp: true,
      maker_checker_distinct_operators: 2,
    },
  };

  const first = page._partnersLoadCapabilities({ force: true });
  pending[0].resolve(manager);
  while (pending.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending[1].fn, 'admin_partners_capability_operators');

  const second = page._partnersLoadCapabilities({ force: true });
  assert.equal(pending[1].signal.aborted, true);
  pending[2].resolve(revoked);
  await second;
  const renderedAfterRevocation = renders.length;

  // Simulate a transport that ignores AbortSignal and eventually resolves.
  pending[1].resolve(oldOperators);
  assert.equal(await first, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(renders.length, renderedAfterRevocation);
  assert.equal(Array.isArray(page._partnersCapabilityOperators), true);
  assert.equal(page._partnersCapabilityOperators.length, 0);
  assert.equal(page._partnersCanManageCapabilities, false);
  assert.equal(renders.at(-1).canManage, false);
  assert.doesNotMatch(JSON.stringify(renders), /stale@example\.test/);
});

test('Admin Partners renders capabilities independently when overview is unavailable', async () => {
  const attributes = new Map([['aria-busy', 'true']]);
  const readiness = {
    innerHTML: '<div>Chargement des capacités…</div>',
    removeAttribute(name) { attributes.delete(name); },
  };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-readiness' ? readiness : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  const envelope = {
    schema_version: 1,
    can_manage: false,
    can_manage_release: false,
    capabilities: { support: false, risk: false, finance: true },
  };
  page._partnersLoadModule = (_key, _fn, _params, render) => {
    render(envelope);
    return Promise.resolve(envelope);
  };

  await page._partnersLoadCapabilities();

  assert.equal(attributes.has('aria-busy'), false);
  assert.match(visibleUiMarkup(readiness.innerHTML), /Finance/);
  assert.match(visibleUiMarkup(readiness.innerHTML), /Capacité serveur disponible/);
  assert.doesNotMatch(visibleUiMarkup(readiness.innerHTML), /Chargement/);
});

test('Admin Partners module timeout is isolated and exposes a sanitized retry', async () => {
  const attributes = new Map();
  const host = {
    innerHTML: '',
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
  };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-monitoring' ? host : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._route = 'partners';
  page._partnersPageGeneration = 1;
  page._rpc = (_fn, _params, options = {}) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('provider payload must never be rendered');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  const result = await page._partnersLoadModule(
    'monitoring',
    'admin_partners_monitoring',
    {},
    () => assert.fail('a timed-out module must not render data'),
    {
      force: true,
      timeoutMs: 5,
      targetId: 'partners-admin-monitoring',
      title: 'Supervision',
    },
  );

  assert.equal(result, null);
  assert.equal(attributes.has('aria-busy'), false);
  assert.match(visibleUiMarkup(host.innerHTML), /Supervision : indisponible/);
  assert.match(visibleUiMarkup(host.innerHTML), /data-partners-retry="monitoring"/);
  assert.doesNotMatch(visibleUiMarkup(host.innerHTML), /provider payload/);
});

test('Admin Partners renders all Revolut corridors with local filtering and pagination', () => {
  const revolut = { innerHTML: '', removeAttribute() {} };
  const routes = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return {
        'partners-admin-revolut': revolut,
        'partners-admin-routes': routes,
      }[id] || null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  const configured = Array.from({ length: 66 }, (_, index) => ({
    country_code: String.fromCharCode(65 + Math.floor(index / 26))
      + String.fromCharCode(65 + (index % 26)),
    currency: 'USD',
    status: index === 65 ? 'active' : 'disabled',
    execution_adapter: 'revolut_manual',
    updated_at: '2026-08-01T10:00:00Z',
  }));
  page._renderPartnersRevolutStatus({
    schema_version: 1,
    provider: 'revolut_business',
    production_mode: 'revolut_manual',
    plan: 'basic',
    api_enabled: false,
    api_adapter_verified: false,
    routes: configured,
    counts: {
      manual_batches_open: 0,
      manual_batches_exception: 0,
      reconciliation_pending: 0,
      manual_statement_pending: 0,
      statement_matched_review_pending: 0,
      api_dead_letter: 0,
    },
  });

  assert.match(visibleUiMarkup(routes.innerHTML), />66<\/strong><span>corridors configurés/);
  assert.match(visibleUiMarkup(routes.innerHTML), />1<\/strong><span>actifs/);
  assert.match(visibleUiMarkup(routes.innerHTML), />65<\/strong><span>désactivés/);
  assert.equal((routes.innerHTML.match(/<li class="partners-control-item">/g) || []).length, 12);
  assert.match(visibleUiMarkup(routes.innerHTML), /CN · USD/,
    'the single active route must be promoted to the first page');

  const seen = new Set();
  for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
    page._partnersRoutePage = pageIndex;
    page._renderPartnersRoutes();
    for (const match of routes.innerHTML.matchAll(/<strong>([A-Z]{2}) · USD<\/strong>/g)) {
      seen.add(match[1]);
    }
  }
  assert.equal(seen.size, 66);
  page._partnersRouteStatus = 'active';
  page._partnersRoutePage = 0;
  page._renderPartnersRoutes();
  assert.equal((routes.innerHTML.match(/<li class="partners-control-item">/g) || []).length, 1);
  assert.doesNotMatch(visibleUiMarkup(routes.innerHTML), /Route désactivée/);
});

test('Admin Partners uses a semantic desktop table and explicit mobile cards', () => {
  const list = { innerHTML: '', removeAttribute() {} };
  const preview = { innerHTML: '', removeAttribute() {} };
  const count = { textContent: '' };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return {
        'partners-admin-list': list,
        'partners-admin-list-preview': preview,
        'partners-admin-count': count,
      }[id] || null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  new AdminPage({})._renderPartnersAdminAccounts([{
    account_id: '11111111-1111-4111-8111-111111111111',
    partner_key: 'partner-01',
    status: 'active',
    verification_status: 'verified',
    contract_status: 'accepted',
    link_status: 'active',
    created_at: '2026-08-01T10:00:00Z',
  }], 1);

  assert.match(visibleUiMarkup(list.innerHTML), /<table class="partners-table">/);
  assert.match(visibleUiMarkup(list.innerHTML), /<caption[^>]*>Comptes partenaires correspondant aux filtres<\/caption>/);
  assert.match(visibleUiMarkup(list.innerHTML), /<th scope="col">Partenaire<\/th>/);
  assert.match(visibleUiMarkup(list.innerHTML), /<th scope="col">KYC cash<\/th>/);
  assert.match(visibleUiMarkup(list.innerHTML), /KYC cash vérifié/);
  assert.doesNotMatch(visibleUiMarkup(list.innerHTML), /<th scope="col">Identité<\/th>/);
  assert.match(visibleUiMarkup(list.innerHTML), /<button type="button" class="partner-open"/);
  assert.match(visibleUiMarkup(list.innerHTML), /<ul id="partners-account-cards" class="partners-account-cards" role="list">/);
  assert.match(visibleUiMarkup(list.innerHTML), /<dl class="partners-account-facts">/);
  assert.doesNotMatch(visibleUiMarkup(list.innerHTML), /role="button" tabindex="0"/);
  assert.match(source, /@media\(max-width:700px\)[\s\S]*\.partners-account-cards\{display:grid/);
});

test('Admin Partners keeps not-started cash KYC distinct from pending cash KYC', () => {
  const summary = {
    innerHTML: '',
    removeAttribute() {},
    classList: { remove() {} },
  };
  const readiness = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return {
        'partners-admin-summary': summary,
        'partners-admin-readiness': readiness,
      }[id] || null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilityCards = () => '';
  page._renderPartnersAdminSummary({
    accounts_total: 7,
    account_statuses: { active: 7, held: 0, suspended: 0 },
    verification_statuses: {
      not_started: 5,
      pending: 1,
      verified: 1,
      failed: 0,
      expired: 0,
    },
    link_statuses: { active: 2 },
    readiness: {},
  });

  assert.match(visibleUiMarkup(summary.innerHTML), />5<\/div><div class="cs-l">KYC cash non commencé/);
  assert.match(visibleUiMarkup(summary.innerHTML), />1<\/div><div class="cs-l">KYC cash en cours/);
  assert.match(visibleUiMarkup(summary.innerHTML), />1<\/div><div class="cs-l">KYC cash vérifié/);
  assert.doesNotMatch(visibleUiMarkup(summary.innerHTML), /KYC en attente/);
});

test('Admin Partners renders a sanitized access-request queue with Risk-only decisions', () => {
  const list = { innerHTML: '', removeAttribute() {} };
  const count = { textContent: '' };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return {
        'partners-admin-access-requests': list,
        'partners-access-request-count': count,
      }[id] || null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  const envelope = {
    schema_version: 1,
    total: 1,
    limit: 12,
    offset: 0,
    items: [{
      request_id: '11111111-1111-4111-8111-111111111111',
      subject_key: '0123456789ab',
      email_masked: 'ad***@example.com',
      status: 'requested',
      country_code: 'FR',
      subdivision_code: 'FR-IDF',
      requested_at: '2026-08-02T12:00:00Z',
      reviewed_at: null,
    }],
  };

  page._renderPartnersAccessRequests(envelope);
  assert.equal(count.textContent, '1 demande');
  assert.match(visibleUiMarkup(list.innerHTML), /Demande 0123456789ab/);
  assert.match(visibleUiMarkup(list.innerHTML), /ad\*\*\*@example\.com/);
  assert.match(visibleUiMarkup(list.innerHTML), /FR · FR-IDF/);
  assert.doesNotMatch(visibleUiMarkup(list.innerHTML), /access-request-approve/);

  page._partnersCapabilities.risk = true;
  page._renderPartnersAccessRequests(envelope);
  assert.match(visibleUiMarkup(list.innerHTML), /data-partners-action="access-request-approve"/);
  assert.match(visibleUiMarkup(list.innerHTML), /data-partners-action="access-request-decline"/);
  assert.match(visibleUiMarkup(list.innerHTML), /data-partners-access-request-page="prev"/);
});

test('Admin Partners access decisions require AAL2 Risk and preserve operational gates', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  page._partnersCapabilities.risk = true;
  page._partnersEnsureAal2 = async () => true;
  page._confirm = async () => true;
  page._partnersPrompt = async () => '';
  page._partnersJustification = async () => 'Pilot review completed with documented evidence.';
  let call = null;
  page._rpc = async (fn, params) => {
    call = { fn, params };
    return {
      schema_version: 1,
      action: 'access_request_decided',
      status: 'approved',
      changed: true,
      allowlist_included: true,
    };
  };

  const result = await page._runPartnersAdminAction({
    dataset: {
      partnersAction: 'access-request-approve',
      partnersRequestId: '11111111-1111-4111-8111-111111111111',
      partnersRequestKey: '0123456789ab',
    },
  });

  assert.equal(result, 'Demande approuvée, invitation pilote enregistrée et notification transactionnelle mise en file.');
  assert.equal(call.fn, 'admin_partners_access_request_decide');
  assert.deepEqual(JSON.parse(JSON.stringify(call.params)), {
    p_request_id: '11111111-1111-4111-8111-111111111111',
    p_decision: 'approve',
    p_expires_at: null,
    p_justification: 'Pilot review completed with documented evidence.',
  });
  assert.doesNotMatch(JSON.stringify(call.params), /partners_enabled|payouts_live|shadow_mode/);

  page._partnersCapabilities.risk = false;
  call = null;
  assert.equal(await page._runPartnersAdminAction({
    dataset: {
      partnersAction: 'access-request-approve',
      partnersRequestId: '11111111-1111-4111-8111-111111111111',
      partnersRequestKey: '0123456789ab',
    },
  }), false);
  assert.equal(call, null);
});

test('Admin Partners filters and actions refresh modules without rebuilding the page', () => {
  const section = source.slice(
    source.indexOf('// ── Page: Norva Partners'),
    source.indexOf('// ── Page: Providers'),
  );
  assert.doesNotMatch(section, /if \(this\._route === 'partners'\) this\._pagePartners\(\)/);
  assert.match(source, /this\._partnersLoadAccounts\(\{ force: true, preserveFocus: 'search' \}\)/);
  assert.match(source, /await this\._partnersRefreshVisibleView\(\{ focusDescriptor: focus \}\)/);
  assert.match(section, /this\._partnersRequests\.get\(key\)\?\.token === token/);
  assert.match(section, /controller\.abort\?\.\(\)/);
});

test('Admin Partners starts Finance modules without waiting for capabilities', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  const started = [];
  let releaseCapabilities;
  page._partnersLoadCapabilities = () => new Promise((resolve) => {
    releaseCapabilities = resolve;
  });
  page._partnersLoadModule = (key) => {
    started.push(key);
    return Promise.resolve(key);
  };

  const loading = page._partnersLoadFinanceView();
  assert.ok(started.includes('finance'));
  assert.ok(started.includes('revolut'));
  assert.ok(started.includes('incidents'));
  releaseCapabilities();
  await loading;
});

test('Admin Partners focus descriptors ignore transient action state', () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  const descriptor = page._partnersCaptureFocus({
    id: '',
    dataset: {
      partnersAction: 'capability',
      partnersCapability: 'finance',
      partnersEnabled: 'true',
      partnersBusy: 'true',
    },
  });

  assert.equal(JSON.stringify(descriptor), JSON.stringify({
    id: '',
    data: {
      partnersAction: 'capability',
      partnersCapability: 'finance',
    },
  }));
});

test('Admin Partners restores focus to the originating module when an action disappears', () => {
  const attributes = new Map();
  let focused = false;
  const module = {
    id: 'partners-admin-payouts',
    tagName: 'SECTION',
    disabled: false,
    closest() { return null; },
    hasAttribute(name) { return attributes.has(name); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    focus() { focused = true; },
  };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === module.id ? module : null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  const descriptor = page._partnersCaptureFocus({
    id: '',
    dataset: {
      partnersAction: 'payout-approve',
      partnersKey: 'pay_0123456789abcdef01234567',
      partnersBusy: 'true',
    },
    closest() { return module; },
  });

  assert.equal(descriptor.fallbackId, module.id);
  assert.equal(page._partnersRestoreFocus(descriptor), true);
  assert.equal(focused, true);
  assert.equal(attributes.get('tabindex'), '-1');
});

test('Admin Partners keeps the selected mobile workspace tab visible and restores its scroll', async () => {
  const main = { scrollTop: 120 };
  const status = { textContent: '' };
  let financeFocused = false;
  let financeScrolled = false;
  const tabs = ['overview', 'partners', 'risk', 'finance', 'configuration'].map((view) => ({
    id: `partners-tab-${view}`,
    tagName: 'BUTTON',
    dataset: { partnersView: view },
    tabIndex: view === 'overview' ? 0 : -1,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    closest() { return null; },
    focus() { if (view === 'finance') financeFocused = true; },
    scrollIntoView(options) {
      if (view === 'finance'
        && options.block === 'nearest'
        && options.inline === 'nearest') financeScrolled = true;
    },
    get textContent() { return view; },
  }));
  const panes = ['overview', 'partners', 'risk', 'finance', 'configuration'].map((view) => ({
    id: `partners-pane-${view}`,
    hidden: view !== 'overview',
  }));
  const AdminPage = loadAdminPage({
    getElementById(id) {
      if (id === 'partners-view-status') return status;
      return tabs.find((tab) => tab.id === id) || null;
    },
    querySelector(selector) {
      return selector === '#page-admin .crm-main' ? main : null;
    },
    querySelectorAll(selector) {
      if (selector === '#page-admin .partners-workspace-tab') return tabs;
      if (selector === '#page-admin .partners-pane') return panes;
      return [];
    },
  });
  const page = new AdminPage({});
  page._partnersView = 'overview';
  page._partnersScrollByView.set('finance', 44);
  page._partnersLoadView = () => Promise.resolve();

  page._partnersSelectView('finance', { focusTab: true });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(main.scrollTop, 44);
  assert.equal(financeFocused, true);
  assert.equal(financeScrolled, true);
  assert.equal(tabs[3].attributes.get('aria-selected'), 'true');
  assert.equal(tabs[3].tabIndex, 0);
  assert.equal(panes[3].hidden, false);
});

test('Admin Partners distinguishes malformed and pending payout modules', () => {
  const attributes = new Map();
  const payouts = {
    innerHTML: '',
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
  };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-payouts' ? payouts : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersRequests.set('manualBatches', {});

  page._renderPartnersPayouts({ schema_version: 1, total: -1, items: [] }, null);
  assert.equal(attributes.get('aria-busy'), 'true');
  assert.match(visibleUiMarkup(payouts.innerHTML), /data-partners-retry="payoutCycles"/);
  assert.match(visibleUiMarkup(payouts.innerHTML), /Chargement des lots manuels/);

  page._partnersRequests.clear();
  page._renderPartnersPayouts({ schema_version: 1, total: 0, items: [] }, {
    schema_version: 1,
    total: 1,
    items: null,
  });
  assert.equal(attributes.has('aria-busy'), false);
  assert.match(visibleUiMarkup(payouts.innerHTML), /data-partners-retry="manualBatches"/);
  assert.equal(page._partnersIsPagedEnvelope({ schema_version: 1, total: 0, items: [] }), true);
  assert.equal(page._partnersIsPagedEnvelope({ schema_version: 1, total: -1, items: [] }), false);
});

test('Admin Partners timeout settles even when the transport ignores AbortSignal', async () => {
  const attributes = new Map();
  const host = {
    innerHTML: '',
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
  };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-monitoring' ? host : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._route = 'partners';
  page._partnersPageGeneration = 1;
  page._rpc = () => new Promise(() => {});

  const result = await page._partnersLoadModule(
    'monitoring',
    'admin_partners_monitoring',
    {},
    () => assert.fail('an ignored abort must not render stale data'),
    {
      force: true,
      timeoutMs: 5,
      targetId: 'partners-admin-monitoring',
      title: 'Supervision',
    },
  );

  assert.equal(result, null);
  assert.equal(attributes.has('aria-busy'), false);
  assert.match(visibleUiMarkup(host.innerHTML), /Supervision : indisponible/);
  assert.doesNotMatch(visibleUiMarkup(host.innerHTML), /partners_module_timeout/);
});

test('Admin Partners cancellation settles immediately and never paints an error', async () => {
  const host = {
    innerHTML: '<div>Chargement</div>',
    setAttribute() {},
    removeAttribute() {},
  };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-monitoring' ? host : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._route = 'partners';
  page._partnersPageGeneration = 1;
  let signal;
  page._rpc = (_fn, _params, options) => {
    signal = options.signal;
    return new Promise(() => {});
  };

  const pending = page._partnersLoadModule(
    'monitoring',
    'admin_partners_monitoring',
    {},
    () => assert.fail('a cancelled module must not render'),
    {
      force: true,
      timeoutMs: 10_000,
      targetId: 'partners-admin-monitoring',
      title: 'Supervision',
    },
  );
  page._partnersAbortAll();

  assert.equal(signal.aborted, true);
  assert.equal(await pending, null);
  assert.equal(host.innerHTML, '<div>Chargement</div>');
  assert.equal(page._partnersRequests.size, 0);
});

test('Admin Partners operational actions are hidden and rejected without exact capabilities', async () => {
  const risk = { innerHTML: '', removeAttribute() {} };
  const finance = { innerHTML: '', removeAttribute() {} };
  const detail = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return {
        'partners-admin-risk': risk,
        'partners-admin-finance': finance,
        'partners-admin-detail': detail,
      }[id] || null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  const riskEnvelope = {
    schema_version: 1,
    total: 1,
    items: [{
      account_id: 'prt_0123456789abcdef01234567',
      status: 'held',
      reason: 'risk_hold',
      dead_letter_jobs: 0,
    }],
  };
  const financeEnvelope = {
    schema_version: 1,
    queues: {},
    reconciliation: { last_run_at: null, last_status: 'clean', mismatches: 0 },
    currencies: [],
  };
  const detailEnvelope = {
    account: {
      account_id: '11111111-1111-4111-8111-111111111111',
      partner_key: `prt_${'1'.repeat(24)}`,
      status: 'active',
      verification_status: 'verified',
      contract_status: 'accepted',
      country_code: 'FR',
    },
    policy: {},
    link: { status: 'active' },
    fiscal: {
      status: 'pending',
      country_code: 'FR',
      submitted_at: '2026-08-02T10:00:00Z',
      reviewed_at: null,
    },
    activity: [],
    readiness: {},
  };

  page._renderPartnersRisk(riskEnvelope);
  page._renderPartnersFinance(financeEnvelope);
  page._renderPartnerDetail(detailEnvelope);
  assert.doesNotMatch(visibleUiMarkup(risk.innerHTML), /data-partners-action="account-action"/);
  assert.doesNotMatch(visibleUiMarkup(finance.innerHTML), /data-partners-action="job-retry"/);
  assert.doesNotMatch(visibleUiMarkup(finance.innerHTML), /data-partners-action="commission-reverse"/);
  assert.doesNotMatch(visibleUiMarkup(detail.innerHTML), /data-partners-action="fiscal-review-public"/);

  page._partnersCapabilities = { support: true, risk: true, finance: true };
  page._renderPartnersRisk(riskEnvelope);
  page._renderPartnersFinance(financeEnvelope);
  page._renderPartnerDetail(detailEnvelope);
  assert.match(visibleUiMarkup(risk.innerHTML), /data-partners-action="account-action"/);
  assert.match(visibleUiMarkup(finance.innerHTML), /data-partners-action="job-retry"/);
  assert.match(visibleUiMarkup(finance.innerHTML), /data-partners-action="commission-reverse"/);
  assert.doesNotMatch(visibleUiMarkup(detail.innerHTML), /data-partners-action="fiscal-review-public"/);
  assert.doesNotMatch(visibleUiMarkup(detail.innerHTML), /data-partners-account=/);

  page._partnersCapabilities = { support: false, risk: false, finance: false };
  page._partnersPrompt = () => assert.fail('permission denial must happen before prompting');
  page._rpc = () => assert.fail('permission denial must happen before RPC');
  assert.equal(await page._runPartnersAdminAction({
    dataset: { partnersAction: 'job-retry' },
  }), false);
});

test('Admin Partners paginates jurisdiction configuration without truncating it', () => {
  const configuration = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-configuration' ? configuration : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: true, risk: true, finance: true };
  const countries = Array.from({ length: 30 }, (_, index) => (
    String.fromCharCode(65 + Math.floor(index / 26))
    + String.fromCharCode(65 + (index % 26))
  ));
  const envelope = {
    schema_version: 1,
    programs: [{
      version_key: 'individual-global-v1',
      status: 'active',
      attribution_window_days: 30,
      maturation_days: 45,
      terms_version: 'v1',
    }],
    policies: countries.map((country) => ({
      program_version_key: 'individual-global-v1',
      country_code: country,
      subdivision_code: null,
      individual_available: false,
      minimum_age: 18,
      payout_currencies: ['USD'],
      kyc_attempt_policy: { status: 'active' },
    })),
    configuration_counts: {
      active_country_mappings: 0,
      active_currencies: 1,
      active_payout_providers: 0,
      active_allowlist_entries: 0,
    },
    release_flags: [],
    release_gates: [],
  };

  page._renderPartnersConfiguration(envelope);
  assert.equal((configuration.innerHTML.match(/data-partners-action="kyc-policy"/g) || []).length, 12);
  assert.match(visibleUiMarkup(configuration.innerHTML), /1–12 sur 30/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /aria-controls="partners-policy-list"/);
  page._partnersPolicyPage = 2;
  page._renderPartnersConfiguration(envelope);
  assert.equal((configuration.innerHTML.match(/data-partners-action="kyc-policy"/g) || []).length, 6);
  assert.match(visibleUiMarkup(configuration.innerHTML), /25–30 sur 30/);
});

test('Admin Partners exposes programme activation only after both legal gates', () => {
  const configuration = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-configuration' ? configuration : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: true, risk: true, finance: true };
  const envelope = {
    schema_version: 1,
    programs: [{
      version_key: 'individual-global-v1',
      status: 'draft',
      attribution_window_days: 30,
      maturation_days: 45,
      terms_version: 'v1',
      effective_from: '2026-01-01T00:00:00Z',
    }],
    policies: [],
    configuration_counts: {
      active_country_mappings: 0,
      active_currencies: 0,
      active_payout_providers: 0,
      active_allowlist_entries: 0,
    },
    release_flags: [],
    release_gates: [
      { key: 'legal_and_tax_approved', satisfied: false },
      { key: 'membership_privacy_approved', satisfied: false },
    ],
  };

  page._renderPartnersConfiguration(envelope);
  assert.doesNotMatch(visibleUiMarkup(configuration.innerHTML), /data-partners-action="program-activate"/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /Activation bloqu/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /validation juridique et fiscale/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /validation Privacy de l’adhésion/);

  envelope.release_gates.forEach((gate) => { gate.satisfied = true; });
  page._renderPartnersConfiguration(envelope);
  assert.match(visibleUiMarkup(configuration.innerHTML), /data-partners-action="program-activate"/);
  assert.doesNotMatch(visibleUiMarkup(configuration.innerHTML), /Activation bloqu/);
});

test('Admin Partners explains incomplete country opening prerequisites before exposing Open', () => {
  const configuration = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-configuration' ? configuration : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: true, risk: true, finance: true };
  const program = {
    version_key: 'individual-global-v1',
    status: 'active',
    attribution_window_days: 30,
    maturation_days: 45,
    terms_version: 'v1',
    effective_from: '2099-01-01T00:00:00Z',
  };
  const policy = {
    program_version_key: 'individual-global-v1',
    country_code: 'FR',
    subdivision_code: null,
    individual_available: false,
    minimum_age: 18,
    payout_currencies: ['USD', 'EUR'],
    kyc_attempt_policy: { status: 'disabled' },
  };
  const envelope = {
    schema_version: 1,
    programs: [program],
    policies: [policy],
    configuration_counts: {
      active_country_mappings: 0,
      active_currencies: 1,
      active_payout_providers: 0,
      active_allowlist_entries: 0,
    },
    release_flags: [],
    release_gates: [],
  };

  page._renderPartnersConfiguration(envelope);
  assert.doesNotMatch(visibleUiMarkup(configuration.innerHTML), /data-partners-action="country-availability"/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /Ouverture bloqu/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /date d’effet du programme atteinte/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /politique KYC active/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /mapping pays actif/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /couverture des devises actives/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /couverture payout active/);

  program.effective_from = '2026-01-01T00:00:00Z';
  policy.kyc_attempt_policy.status = 'active';
  envelope.configuration_counts.active_country_mappings = 1;
  envelope.configuration_counts.active_currencies = 2;
  envelope.configuration_counts.active_payout_providers = 2;
  page._renderPartnersConfiguration(envelope);
  assert.match(visibleUiMarkup(configuration.innerHTML), /data-partners-action="country-availability"/);
  assert.match(visibleUiMarkup(configuration.innerHTML), />Ouvrir<\/button>/);

  policy.individual_available = true;
  envelope.configuration_counts.active_country_mappings = 0;
  envelope.configuration_counts.active_currencies = 0;
  envelope.configuration_counts.active_payout_providers = 0;
  page._renderPartnersConfiguration(envelope);
  assert.match(visibleUiMarkup(configuration.innerHTML), /data-partners-enabled="false">Fermer<\/button>/);
});

test('Admin Partners country form mirrors subdivision and payout currency database limits', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  page._partnersCapabilities = { support: true, risk: true, finance: false };
  page._partnersEnsureAal2 = async () => true;
  page._partnersConfiguration = {
    programs: [{ version_key: 'individual-global-v1', status: 'active' }],
  };
  const values = [
    'individual-global-v1',
    'fr',
    'fr-idf',
    '18',
    ' usd, , eur ',
    '2099-01-01T00:00:00Z',
  ];
  let promptIndex = 0;
  page._partnersPrompt = async (message, initial, validate) => {
    const value = values[promptIndex];
    if (promptIndex === 2) {
      assert.equal(validate('FR-IDF'), true);
      assert.equal(validate('US-CA'), false);
      assert.equal(validate('FR-ABCDEFGHIJ'), false);
      assert.equal(validate('ABCDEFGHIJKL'), true);
    }
    if (promptIndex === 4) {
      const elevenCurrencies = 'USD,EUR,GBP,CHF,CAD,AUD,NZD,JPY,CNY,INR,BRL';
      assert.equal(validate(elevenCurrencies), false);
      assert.equal(validate(elevenCurrencies.split(',').slice(0, 10).join(',')), true);
      assert.equal(validate('USD,USD'), false);
    }
    assert.equal(validate(value), true);
    promptIndex += 1;
    return value;
  };
  page._partnersJustification = async () => 'Création pilote France contrôlée';
  let call = null;
  page._rpc = async (name, args) => { call = { name, args }; return {}; };

  const result = await page._runPartnersAdminAction({
    dataset: { partnersAction: 'country-create' },
  });

  assert.match(result, /Juridiction FR/);
  assert.equal(promptIndex, values.length);
  assert.deepEqual(JSON.parse(JSON.stringify(call)), {
    name: 'admin_partners_country_policy_create',
    args: {
      p_program_version_key: 'individual-global-v1',
      p_country_code: 'FR',
      p_subdivision_code: 'FR-IDF',
      p_minimum_age: 18,
      p_payout_currencies: ['USD', 'EUR'],
      p_effective_from: '2099-01-01T00:00:00.000Z',
      p_justification: 'Création pilote France contrôlée',
    },
  });
});

test('Admin Partners keeps payout observations independent and retryable', () => {
  const payouts = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-payouts' ? payouts : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._renderPartnersPayouts({
    schema_version: 1,
    total: 1,
    items: [{
      key: 'pay_0123456789abcdef01234567',
      status: 'draft',
      currency: 'USD',
      live_execution: false,
      total_minor: 1000,
      item_count: 1,
    }],
  }, null);

  assert.match(visibleUiMarkup(payouts.innerHTML), /pay_0123456789abcdef01234567/);
  assert.match(visibleUiMarkup(payouts.innerHTML), /data-partners-retry="manualBatches"/);
  assert.doesNotMatch(visibleUiMarkup(payouts.innerHTML), /data-partners-retry="payoutCycles"/);
});

test('Admin Partners never presents malformed payout counters as zero', () => {
  const payouts = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-payouts' ? payouts : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._renderPartnersPayouts({
    schema_version: 1,
    total: 1,
    items: [{
      key: 'pay_0123456789abcdef01234567',
      status: 'draft',
      currency: 'USD',
      live_execution: false,
      total_minor: 'invalid',
      item_count: null,
    }],
  }, {
    schema_version: 1,
    total: 1,
    items: [{
      key: 'rmb_0123456789abcdef01234567',
      cycle_key: 'pay_0123456789abcdef01234567',
      status: 'prepared',
      currency: 'USD',
      currency_exponent: 2,
      total_minor: 1000,
      submitted_count: 'invalid',
      item_count: null,
      settled_count: -1,
    }],
  });

  assert.match(visibleUiMarkup(payouts.innerHTML), /— unités mineures · — item\(s\)/);
  assert.match(visibleUiMarkup(payouts.innerHTML), /—\/— saisi\(s\) · — rapproché\(s\)/);
  assert.doesNotMatch(visibleUiMarkup(payouts.innerHTML), /0 unités mineures/);
  assert.doesNotMatch(visibleUiMarkup(payouts.innerHTML), /0\/0 saisi\(s\)/);
});

test('Admin Partners rejects malformed route status instead of inferring disabled', () => {
  const revolut = { innerHTML: '', removeAttribute() {} };
  const routes = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return {
        'partners-admin-revolut': revolut,
        'partners-admin-routes': routes,
      }[id] || null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  new AdminPage({})._renderPartnersRevolutStatus({
    schema_version: 1,
    provider: 'revolut_business',
    production_mode: 'revolut_manual',
    plan: 'basic',
    api_enabled: false,
    api_adapter_verified: false,
    routes: [{
      country_code: 'FR',
      currency: 'USD',
      status: 'paused',
      execution_adapter: 'revolut_manual',
      updated_at: '2026-08-01T10:00:00Z',
    }],
    counts: {},
  });

  assert.match(visibleUiMarkup(routes.innerHTML), /Observation autoritative indisponible/);
  assert.doesNotMatch(visibleUiMarkup(routes.innerHTML), /Route désactivée/);
});

test('Admin Partners incident pagination exposes direction, controlled content and live range', () => {
  assert.match(source, /data-partners-page-direction="prev"/);
  assert.match(source, /data-partners-page-direction="next"/);
  assert.match(source, /aria-controls="partners-revolut-incidents-list"/);
  assert.match(source, /preserveFocus: direction/);
});

test('Admin Partners identifies only explicit AAL2 authorization failures', () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  assert.equal(page._partnersIsAal2Error({
    status: 403,
    message: 'manual payout batch list requires AAL2',
  }), true);
  assert.equal(page._partnersIsAal2Error({
    status: 400,
    message: 'AAL2 required for this operation',
  }), true);
  assert.equal(page._partnersIsAal2Error({
    status: 403,
    message: 'finance capability required',
  }), false);
  assert.equal(page._partnersIsAal2Error({
    status: 500,
    message: 'requires AAL2',
  }), false);
});

test('Admin Partners presents AAL2 as a generic sensitive-action gate', () => {
  const gate = { hidden: true, innerHTML: '' };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-aal2' ? gate : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersAal2Required = true;

  page._partnersRenderAal2Gate();

  assert.equal(gate.hidden, false);
  assert.match(visibleUiMarkup(gate.innerHTML), /Validation renforcée requise/);
  assert.match(visibleUiMarkup(gate.innerHTML), /actions sensibles Partners/);
  assert.doesNotMatch(visibleUiMarkup(gate.innerHTML), /Validation Finance requise|données Finance/);
});

test('Admin Partners elevates sensitive actions through verified TOTP without exposing factor ids', async () => {
  const calls = [];
  const authRuntime = {
    NorvaAuth: {
      async getMfaStatus() {
        return {
          currentLevel: 'aal1',
          nextLevel: 'aal2',
          factors: [{ id: 'private-factor-id', type: 'totp' }],
        };
      },
      async challengeAndVerifyMfa(input) { calls.push(input); },
    },
  };
  const AdminPage = loadAdminPage(null, null, authRuntime);
  const page = new AdminPage({});
  page._partnersAal2Required = true;
  page._partnersAal2FailedKeys.add('manualBatches');
  page._modal = async (options) => {
    assert.equal(options.autocomplete, 'one-time-code');
    assert.equal(options.inputMode, 'numeric');
    assert.equal(options.maxLength, 6);
    assert.doesNotMatch(options.message, /private-factor-id/);
    return '012345';
  };
  page._toast = () => {};
  page._partnersRenderAal2Gate = () => {};

  const result = await page._partnersElevateAal2();
  assert.match(result, /AAL2/);
  assert.match(result, /actions sensibles Partners/);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { code: '012345', factorId: 'private-factor-id' },
  ]);
  assert.equal(page._partnersAal2Required, false);
  assert.equal(page._partnersAal2FailedKeys.size, 0);
});

test('Admin Partners chooses among sanitized TOTP labels without rendering factor ids', async () => {
  const calls = [];
  const authRuntime = {
    NorvaAuth: {
      async getMfaStatus() {
        return {
          currentLevel: 'aal1',
          nextLevel: 'aal2',
          factors: [
            { id: 'private-first-id', type: 'totp', label: 'Téléphone' },
            { id: 'private-second-id', type: 'totp', label: 'Clé Finance' },
          ],
        };
      },
      async challengeAndVerifyMfa(input) { calls.push(input); },
    },
  };
  const AdminPage = loadAdminPage(null, null, authRuntime);
  const page = new AdminPage({});
  const prompts = [];
  page._modal = async (options) => {
    prompts.push(options);
    return prompts.length === 1 ? '2' : '654321';
  };
  page._toast = () => {};
  page._partnersRenderAal2Gate = () => {};

  assert.equal(await page._partnersEnsureAal2(), true);
  assert.match(prompts[0].message, /1 — Téléphone/);
  assert.match(prompts[0].message, /2 — Clé Finance/);
  assert.doesNotMatch(prompts[0].message, /private-(?:first|second)-id/);
  assert.equal(prompts[1].autocomplete, 'one-time-code');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { code: '654321', factorId: 'private-second-id' },
  ]);
});

test('Admin Partners preflights AAL2 before a sensitive action and then resumes it', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  const order = [];
  page._partnersCanManageCapabilities = true;
  page._meId = () => '11111111-1111-4111-8111-111111111111';
  page._partnersEnsureAal2 = async () => { order.push('aal2'); return true; };
  page._confirm = async () => { order.push('confirm'); return true; };
  page._partnersJustification = async () => { order.push('justification'); return 'Contrôle approuvé'; };
  let mutation;
  page._rpc = async (fn, args) => {
    order.push(fn);
    mutation = { fn, args };
    return {
      schema_version: 1,
      action: 'admin_capability_set',
      capability: 'finance',
      enabled: true,
    };
  };

  const result = await page._runPartnersAdminAction({
    dataset: {
      partnersAction: 'capability',
      partnersCapability: 'finance',
      partnersEnabled: 'true',
      partnersOperatorKey: `op_${'b'.repeat(64)}`,
      partnersOperatorEmail: 'second.finance@example.test',
    },
  });

  assert.deepEqual(order, [
    'aal2',
    'confirm',
    'justification',
    'admin_partners_capability_set_by_operator_key',
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(mutation)), {
    fn: 'admin_partners_capability_set_by_operator_key',
    args: {
      p_operator_key: `op_${'b'.repeat(64)}`,
      p_capability: 'finance',
      p_enabled: true,
      p_justification: 'Contrôle approuvé',
    },
  });
  assert.match(result, /Capacité finance activée/);
  assert.match(result, /second\.finance@example\.test/);
});

test('Admin Partners maps MFA failures into distinct sanitized user guidance', () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  assert.match(page._partnersMfaFailureMessage({ status: 401 }), /session a expiré/);
  assert.match(page._partnersMfaFailureMessage({ status: 429 }), /Trop de tentatives/);
  assert.match(page._partnersMfaFailureMessage({
    status: 400,
    payload: { error_code: 'mfa_factor_not_found' },
  }), /configuration de sécurité/);
  assert.match(page._partnersMfaFailureMessage({ status: 503 }), /indisponible/);
  assert.match(page._partnersMfaFailureMessage({
    status: 422,
    payload: { error_code: 'otp_expired' },
  }), /incorrect ou expiré/);
});

test('Admin Partners payout onboarding queue exposes controlled Finance actions only', () => {
  const queue = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return id === 'partners-admin-payout-onboarding' ? queue : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: true, risk: false, finance: true };
  const base = {
    partner_key: `prt_${'a'.repeat(24)}`,
    country_code: 'FR',
    currency: 'USD',
    revision: 1,
    execution_adapter: 'revolut_manual',
    reason_code: null,
    requested_at: '2026-08-02T10:00:00Z',
    updated_at: '2026-08-02T10:01:00Z',
    rejected_at: null,
    completed_at: null,
    reconfiguration_required: false,
  };
  page._renderPartnersPayoutOnboardingRequests({
    schema_version: 1,
    total: 5,
    limit: 20,
    offset: 0,
    items: [
      {
        ...base,
        request_key: `por_${'1'.repeat(24)}`,
        status: 'pending',
        started_at: null,
        binding_ready: false,
        profile_ready: false,
      },
      {
        ...base,
        request_key: `por_${'2'.repeat(24)}`,
        status: 'in_progress',
        started_at: '2026-08-02T10:02:00Z',
        binding_ready: true,
        profile_ready: true,
      },
      {
        ...base,
        request_key: `por_${'3'.repeat(24)}`,
        status: 'in_progress',
        started_at: '2026-08-02T10:02:00Z',
        binding_ready: false,
        profile_ready: true,
      },
      {
        ...base,
        request_key: `por_${'4'.repeat(24)}`,
        status: 'completed',
        started_at: '2026-08-02T10:02:00Z',
        completed_at: '2026-08-02T10:05:00Z',
        binding_ready: false,
        profile_ready: true,
        reconfiguration_required: true,
      },
      {
        ...base,
        request_key: `por_${'5'.repeat(24)}`,
        status: 'completed',
        started_at: '2026-08-02T10:02:00Z',
        completed_at: '2026-08-02T10:05:00Z',
        binding_ready: true,
        profile_ready: true,
        reconfiguration_required: true,
      },
    ],
  });

  assert.match(visibleUiMarkup(queue.innerHTML), /data-partners-decision="start"/);
  assert.match(visibleUiMarkup(queue.innerHTML), /data-partners-decision="reject"/);
  assert.match(visibleUiMarkup(queue.innerHTML), /data-partners-decision="complete"/);
  assert.match(visibleUiMarkup(queue.innerHTML), /Finalisation verrouillée/);
  assert.match(
    visibleUiMarkup(queue.innerHTML),
    /data-partners-request-key="por_333333333333333333333333"[\s\S]*?data-partners-decision="complete"[\s\S]*?disabled/,
  );
  assert.match(visibleUiMarkup(queue.innerHTML), /data-partners-onboarding-open-partner="prt_/);
  assert.match(visibleUiMarkup(queue.innerHTML), /data-partners-action="payout-onboarding-contact"/);
  assert.match(visibleUiMarkup(queue.innerHTML), /data-partners-action="revolut-binding-propose-request"/);
  assert.match(visibleUiMarkup(queue.innerHTML), /Reconfiguration requise/);
  assert.match(visibleUiMarkup(queue.innerHTML), /ne satisfait plus tous les contrôles actuels/);
  assert.doesNotMatch(visibleUiMarkup(queue.innerHTML), /account_id|user_id|provider_reference|bank|tax identifier/i);
});

test('Admin Partners payout onboarding decisions are Finance+AAL2 gated and typed', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  const requestKey = `por_${'4'.repeat(24)}`;
  const partnerKey = `prt_${'b'.repeat(24)}`;
  const calls = [];
  page._partnersCapabilities = { support: false, risk: false, finance: true };
  page._partnersEnsureAal2 = async () => true;
  page._confirm = async () => true;
  page._partnersPrompt = async () => '5';
  page._partnersJustification = async () => 'Contrôle Finance supervisé';
  page._toast = () => {};
  page._rpc = async (fn, args) => {
    calls.push({ fn, args });
    const status = {
      start: 'in_progress',
      reject: 'rejected',
      complete: 'completed',
    }[args.p_action];
    return {
      schema_version: 1,
      action: 'payout_onboarding_decided',
      changed: true,
      request_key: requestKey,
      partner_key: partnerKey,
      status,
    };
  };

  for (const decision of ['start', 'reject', 'complete']) {
    const result = await page._runPartnersAdminAction({
      dataset: {
        partnersAction: 'payout-onboarding-decide',
        partnersRequestKey: requestKey,
        partnersDecision: decision,
        partnersBindingReady: decision === 'complete' ? 'true' : 'false',
        partnersProfileReady: decision === 'complete' ? 'true' : 'false',
      },
    });
    assert.equal(typeof result, 'string');
  }

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {
      fn: 'admin_partners_payout_onboarding_request_decide',
      args: {
        p_request_key: requestKey,
        p_action: 'start',
        p_reason_code: null,
        p_justification: 'Contrôle Finance supervisé',
      },
    },
    {
      fn: 'admin_partners_payout_onboarding_request_decide',
      args: {
        p_request_key: requestKey,
        p_action: 'reject',
        p_reason_code: 'compliance_review',
        p_justification: 'Contrôle Finance supervisé',
      },
    },
    {
      fn: 'admin_partners_payout_onboarding_request_decide',
      args: {
        p_request_key: requestKey,
        p_action: 'complete',
        p_reason_code: null,
        p_justification: 'Contrôle Finance supervisé',
      },
    },
  ]);

  page._rpc = () => assert.fail('locked completion must not call the decision RPC');
  assert.equal(await page._runPartnersAdminAction({
    dataset: {
      partnersAction: 'payout-onboarding-decide',
      partnersRequestKey: requestKey,
      partnersDecision: 'complete',
      partnersBindingReady: 'false',
      partnersProfileReady: 'true',
    },
  }), false);
});

test('Admin Partners public-key fiche uses only the sanitized Finance RPC', async () => {
  const view = { innerHTML: '' };
  const detail = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return { 'crm-view': view, 'partners-admin-detail': detail }[id] || null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  const partnerKey = `prt_${'c'.repeat(24)}`;
  const calls = [];
  let rendered = null;
  page._route = `partner-public:${partnerKey}`;
  page._nav = 9;
  page._partnersEnsureAal2 = async () => true;
  page._renderPartnerDetail = (data) => { rendered = data; };
  page._rpc = async (fn, args) => {
    calls.push({ fn, args: args || null });
    if (fn === 'admin_partners_capabilities') {
      return {
        schema_version: 1,
        can_manage: false,
        can_manage_release: false,
        capabilities: { support: false, risk: false, finance: true },
      };
    }
    return {
      schema_version: 1,
      account: {
        account_public_id: partnerKey,
        partner_key: partnerKey,
        status: 'active',
      },
      policy: null,
      link: null,
      activity: [],
    };
  };

  await page._pagePartnerDetailByPublicId(partnerKey);
  assert.equal(rendered.account.account_public_id, partnerKey);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { fn: 'admin_partners_capabilities', args: null },
    {
      fn: 'admin_partners_detail_by_public_id',
      args: { p_account_public_id: partnerKey },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(rendered), /[0-9a-f]{8}-[0-9a-f-]{27}/i);
});

test('Admin Partners fiscal queue is public-keyed, reviewable and privacy-minimized', () => {
  const queue = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return id === 'partners-admin-fiscal-profiles' ? queue : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: true, risk: false, finance: true };
  const partnerKey = `prt_${'d'.repeat(24)}`;
  page._renderPartnersFiscalProfiles({
    schema_version: 1,
    total: 1,
    limit: 20,
    offset: 0,
    items: [{
      partner_key: partnerKey,
      country_code: 'US',
      status: 'pending',
      submitted_at: '2026-08-02T11:00:00Z',
      reviewed_at: null,
    }],
  });

  assert.match(visibleUiMarkup(queue.innerHTML), new RegExp(partnerKey));
  assert.match(visibleUiMarkup(queue.innerHTML), /data-partners-action="fiscal-review-public"/);
  assert.match(visibleUiMarkup(queue.innerHTML), /data-partners-partner-key="prt_/);
  assert.doesNotMatch(
    visibleUiMarkup(queue.innerHTML),
    /account_id|user_id|email|tax_form|reference_hash|document_number/i,
  );
  assert.throws(() => page._renderPartnersFiscalProfiles({
    schema_version: 1,
    total: 1,
    limit: 20,
    offset: 0,
    items: [{
      partner_key: partnerKey,
      country_code: 'US',
      status: 'pending',
      submitted_at: '2026-08-02T11:00:00Z',
      reviewed_at: null,
      email: 'must-not-cross-boundary@example.com',
    }],
  }), /invalid_partners_fiscal_profiles_items/);
});

test('Admin Partners fiscal review resolves only the public partner key', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  const partnerKey = `prt_${'e'.repeat(24)}`;
  const calls = [];
  const prompts = ['manual_review', 'a'.repeat(64), ''];
  page._partnersCapabilities = { support: true, risk: false, finance: true };
  page._partnersEnsureAal2 = async () => true;
  page._partnersPrompt = async () => prompts.shift();
  page._partnersJustification = async () => 'Revue fiscale manuelle contrôlée';
  page._rpc = async (fn, args) => {
    calls.push({ fn, args });
    return {
      schema_version: 1,
      action: 'fiscal_profile_reviewed',
      status: 'verified',
      partner_key: partnerKey,
      country_code: 'US',
    };
  };

  const result = await page._runPartnersAdminAction({
    dataset: {
      partnersAction: 'fiscal-review-public',
      partnersPartnerKey: partnerKey,
      partnersCountry: 'US',
      partnersStatus: 'verified',
    },
  });
  assert.match(result, /validé/);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    fn: 'admin_partners_fiscal_review_by_public_id',
    args: {
      p_account_public_id: partnerKey,
      p_status: 'verified',
      p_provider: 'manual_review',
      p_reference_hash: 'a'.repeat(64),
      p_tax_form_type: null,
      p_justification: 'Revue fiscale manuelle contrôlée',
    },
  }]);
  assert.doesNotMatch(JSON.stringify(calls), /account_id|p_account_id/);
});

test('Admin payout contact replays the same opaque idempotency key after an unknown result', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  const requestKey = `por_${'5'.repeat(24)}`;
  const partnerKey = `prt_${'f'.repeat(24)}`;
  const idempotencyKey = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  let promptCalls = 0;
  page._partnersCapabilities = { support: true, risk: false, finance: true };
  page._partnersEnsureAal2 = async () => true;
  page._partnersPrompt = async () => { promptCalls += 1; return '1'; };
  page._confirm = async () => true;
  page._partnersRandomUuid = () => idempotencyKey;
  page._rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (calls.length === 1) throw new DOMException('timeout', 'AbortError');
    return {
      schema_version: 1,
      action: 'payout_onboarding_contact_sent',
      changed: false,
      contact_key: `poc_${'1'.repeat(24)}`,
      request_key: requestKey,
      partner_key: partnerKey,
      template_key: 'secure_setup_invitation',
      channel: 'verified_account_email',
      delivery_state: 'ready',
    };
  };
  const button = {
    dataset: {
      partnersAction: 'payout-onboarding-contact',
      partnersRequestKey: requestKey,
    },
  };

  await assert.rejects(() => page._runPartnersAdminAction(button), /timeout/);
  const result = await page._runPartnersAdminAction(button);
  assert.match(result, /aucun doublon/);
  assert.equal(promptCalls, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, calls[1].args);
  assert.equal(calls[1].args.p_idempotency_key, idempotencyKey);
  assert.equal(page._partnersContactKeys.has(requestKey), false);
});

test('Admin beneficiary proposal is bound to the sanitized payout request key', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  const requestKey = `por_${'6'.repeat(24)}`;
  const prompts = [
    '22222222-2222-4222-8222-222222222222',
    '',
    'J. H. · ****1234',
    'b'.repeat(64),
  ];
  let proposal = null;
  page._partnersCapabilities = { support: false, risk: false, finance: true };
  page._partnersEnsureAal2 = async () => true;
  page._partnersPrompt = async () => prompts.shift();
  page._partnersTypedConfirmation = async (expected) => {
    assert.equal(expected, `PROPOSE-BENEFICIARY:${requestKey}`);
    return expected;
  };
  page._partnersJustification = async () => 'Registre Finance vérifié manuellement';
  page._partnersProposeRevolutBeneficiary = async (value) => {
    proposal = value;
    return { key: `rbb_${'7'.repeat(24)}` };
  };

  const result = await page._runPartnersAdminAction({
    dataset: {
      partnersAction: 'revolut-binding-propose-request',
      partnersRequestKey: requestKey,
    },
  });
  assert.match(result, /Proposition rbb_/);
  assert.equal(proposal.request_key, requestKey);
  assert.equal(proposal.beneficiary_payment_method_ref, null);
  assert.doesNotMatch(JSON.stringify(proposal), /account_id|currency/);
});

test('Admin Partners exposes guided Didit certification only to Risk operators', () => {
  const kyc = { innerHTML: '', removeAttribute() {} };
  const certification = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      if (id === 'partners-admin-kyc') return kyc;
      if (id === 'partners-admin-kyc-certification') return certification;
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  const quota = {
    schema_version: 1,
    used: 0,
    informational_limit: 500,
    remaining: 500,
    utilization_percent: 0,
    blocking: false,
    window_days: 30,
  };

  page._partnersCapabilities = { support: false, risk: false, finance: false };
  page._renderPartnersKycQuota(quota);
  page._renderPartnersKycCertification({
    schema_version: 1,
    action: 'kyc_certification_status',
    certification: null,
  });
  assert.doesNotMatch(visibleUiMarkup(certification.innerHTML), /data-partners-action="kyc-certification-start"/);
  assert.match(visibleUiMarkup(certification.innerHTML), /Lecture seule/);
  assert.doesNotMatch(visibleUiMarkup(kyc.innerHTML), /Certification pré-gate Didit/);

  page._partnersCapabilities.risk = true;
  page._renderPartnersKycCertification({
    schema_version: 1,
    action: 'kyc_certification_status',
    certification: null,
  });
  assert.match(visibleUiMarkup(certification.innerHTML), /data-partners-action="kyc-certification-start"/);
  assert.match(visibleUiMarkup(certification.innerHTML), /ne crée aucun compte et n’ouvre aucun paiement/);
  assert.match(visibleUiMarkup(certification.innerHTML), /séparée du KYC cash des membres/);
  assert.match(visibleUiMarkup(certification.innerHTML), /verification-privacy-notice/);
  assert.match(visibleUiMarkup(certification.innerHTML), /identity-verification/);
});

test('Admin Partners renders authoritative, sandbox and quarantined Didit proof states', () => {
  const certification = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return id === 'partners-admin-kyc-certification' ? certification : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: true, finance: false };
  const base = {
    expires_at: '2026-08-03T18:00:00Z',
    observed_at: '2026-08-03T17:00:00Z',
    reason: null,
  };

  page._renderPartnersKycCertification({
    schema_version: 1,
    action: 'kyc_certification_status',
    certification: {
      ...base,
      environment: 'live',
      status: 'pending',
      verified: false,
    },
  });
  assert.match(visibleUiMarkup(certification.innerHTML), /data-partners-action="kyc-certification-resume"/);
  assert.match(visibleUiMarkup(certification.innerHTML), /Reprendre sur Didit/);
  assert.doesNotMatch(visibleUiMarkup(certification.innerHTML), /kyc-certification-start/);

  page._renderPartnersKycCertification({
    schema_version: 1,
    action: 'kyc_certification_status',
    certification: {
      ...base,
      environment: 'live',
      status: 'approved',
      verified: true,
    },
  });
  assert.match(visibleUiMarkup(certification.innerHTML), /Certification technique live vérifiée/);
  assert.match(visibleUiMarkup(certification.innerHTML), /Environnement live/);
  assert.doesNotMatch(visibleUiMarkup(certification.innerHTML), /kyc-certification-start/);

  page._renderPartnersKycCertification({
    schema_version: 1,
    action: 'kyc_certification_status',
    certification: {
      ...base,
      environment: 'sandbox',
      status: 'approved',
      verified: false,
    },
  });
  assert.match(visibleUiMarkup(certification.innerHTML), /approuvée non autoritaire/);
  assert.match(visibleUiMarkup(certification.innerHTML), /sandbox · non autoritaire/);
  assert.match(visibleUiMarkup(certification.innerHTML), /kyc-certification-start/);

  page._renderPartnersKycCertification({
    schema_version: 1,
    action: 'kyc_certification_status',
    certification: {
      ...base,
      environment: 'live',
      status: 'quarantined',
      verified: false,
      reason: 'provider_config_mismatch',
    },
  });
  assert.match(visibleUiMarkup(certification.innerHTML), /mise en quarantaine/);
  assert.match(visibleUiMarkup(certification.innerHTML), /configuration fournisseur incohérente/);
});

test('Admin Partners renders only sanitized Didit history without promoting cash KYC', () => {
  const certification = { innerHTML: '', removeAttribute() {}, dataset: {} };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return id === 'partners-admin-kyc-certification' ? certification : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: true, finance: false };
  page._renderPartnersKycCertification({
    schema_version: 2,
    action: 'kyc_certification_status',
    certification: {
      status: 'approved',
      environment: 'live',
      expires_at: '2026-08-10T18:00:00Z',
      observed_at: '2026-08-10T17:00:00Z',
      verified: true,
      reason: null,
    },
    technical_history: {
      sessions_total: 3,
      sessions_with_events: 2,
      sessions_without_events: 1,
      verified_live_sessions: 1,
      quarantined_sessions: 1,
      last_event_observed_at: '2026-08-10T17:00:00Z',
    },
  });

  assert.match(visibleUiMarkup(certification.innerHTML), /Historique technique sanitisé/);
  assert.match(visibleUiMarkup(certification.innerHTML), /3 session\(s\)/);
  assert.match(visibleUiMarkup(certification.innerHTML), /1 session\(s\) liée\(s\) à Didit sans événement local/);
  assert.match(visibleUiMarkup(certification.innerHTML), /jamais convertible en KYC cash/);
  assert.match(visibleUiMarkup(certification.innerHTML), /1 en quarantaine/);
  assert.doesNotMatch(visibleUiMarkup(certification.innerHTML), /provider_session|account_id|user_id/);
});

function validCertificationPreflight() {
  return {
    schema_version: 1,
    action: 'kyc_certification_preflight',
    ready: true,
    requirements: {
      privacy_approved: true,
      coverage_open: true,
      partners_membership_closed: true,
      cash_payouts_closed: true,
      tv_relay_closed: true,
      revolut_api_closed: true,
      aal2: true,
      fresh_aal2: true,
      provider_configured: true,
      certification_window_open: true,
    },
  };
}

test('Admin Partners accepts only an exact boolean Didit preflight and identifies hard blockers', () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  const data = validCertificationPreflight();
  const envelope = {
    version: '2026-07-29',
    correlationId: 'prt_0123456789abcdef01234567',
    data,
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(page._partnersSanitizeKycCertificationPreflight(envelope))),
    data,
  );
  assert.throws(() => page._partnersSanitizeKycCertificationPreflight({
    ...envelope,
    data: { ...data, ready: false },
  }));
  assert.throws(() => page._partnersSanitizeKycCertificationPreflight({
    ...envelope,
    data: {
      ...data,
      requirements: { ...data.requirements, operator_id: 'forbidden' },
    },
  }));

  const blocked = validCertificationPreflight();
  blocked.ready = false;
  blocked.requirements.privacy_approved = false;
  blocked.requirements.partners_membership_closed = false;
  const rows = page._partnersKycCertificationRequirementRows(blocked, true);
  assert.equal(rows.find((row) => row.key === 'privacy_approved').ready, false);
  assert.match(
    rows.find((row) => row.key === 'privacy_approved').detail,
    /manifeste preproduction/,
  );
  assert.match(
    rows.find((row) => row.key === 'privacy_approved').detail,
    /renouvelez la gate/,
  );
  assert.equal(rows.find((row) => row.key === 'partners_membership_closed').ready, false);
  assert.equal(rows.find((row) => row.key === 'factor_available').ready, true);
  assert.doesNotMatch(JSON.stringify(rows), /operator_id|factorId|provider_session/);
});

test('Admin Partners starts Didit certification after one guided preflight without provider token exposure', async () => {
  const stored = new Map();
  let assigned = '';
  let observedRequest = null;
  const sessionStorage = {
    getItem(key) { return stored.get(key) || null; },
    setItem(key, value) { stored.set(key, value); },
    removeItem(key) { stored.delete(key); },
  };
  const fetchOverride = async (url, options) => {
    observedRequest = { url, options };
    return {
      ok: true,
      json: async () => ({
        version: '2026-07-29',
        correlationId: 'prt_0123456789abcdef01234567',
        data: {
          schema_version: 1,
          action: 'kyc_certification_session_created',
          replayed: false,
          verification: {
            provider: 'didit',
            status: 'not_started',
            url: 'https://verify.didit.me/session/opaque-hosted-link',
            expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
          },
        },
      }),
    };
  };
  const AdminPage = loadAdminPage(null, fetchOverride, {
    sessionStorage,
    location: { assign(value) { assigned = value; } },
  });
  const page = new AdminPage({});
  page._route = 'partners';
  page._partnersView = 'risk';
  page._partnersCapabilities = { support: false, risk: true, finance: false };
  page._partnersFetchKycCertificationPreflight = async () => validCertificationPreflight();
  page._partnersKycCertificationDialog = async ({ preflight, resuming }) => {
    assert.equal(preflight.ready, true);
    assert.equal(resuming, false);
    return {
      confirmation: 'CERTIFIER DIDIT',
      justification: 'Certification live contrôlée du workflow Didit v1.',
    };
  };
  page._sbUrl = () => 'https://api.norva.tv';
  page._sbKey = () => 'public-anon-key';
  page._token = () => 'user-aal2-jwt';
  page._partnersRandomUuid = () => '11111111-1111-4111-8111-111111111111';

  const result = await page._runPartnersAdminAction({
    dataset: { partnersAction: 'kyc-certification-start' },
  });
  assert.equal(result, false, 'navigation owns completion instead of refreshing Admin');
  assert.equal(
    observedRequest.url,
    'https://api.norva.tv/functions/v1/norva-partners/kyc/certification',
  );
  assert.equal(observedRequest.options.headers.Authorization, 'Bearer user-aal2-jwt');
  assert.equal(
    observedRequest.options.headers['Idempotency-Key'],
    'didit-certification:11111111-1111-4111-8111-111111111111',
  );
  assert.deepEqual(JSON.parse(observedRequest.options.body), {
    language: 'fr',
    consentVersion: 'partners-didit-certification-v1',
    consentGranted: true,
    capacityConfirmed: true,
    confirmation: 'CERTIFIER DIDIT',
    justification: 'Certification live contrôlée du workflow Didit v1.',
  });
  assert.match(stored.get('norva-partners-kyc-certification-v1'), /^\d{13}$/);
  assert.deepEqual(
    JSON.parse(stored.get('norva-partners-kyc-certification-context-v1')),
    {
      version: 1,
      view: 'risk',
      scrollTop: 0,
      focus: 'kyc_certification_card',
    },
  );
  assert.equal(assigned, 'https://verify.didit.me/session/opaque-hosted-link');
  assert.doesNotMatch(JSON.stringify(observedRequest), /session_token|provider_session_id/);
});

test('Admin Partners resumes an unknown Didit result without persisting provider data or repeating consent', async () => {
  const stored = new Map();
  let assigned = '';
  let observedRequest = null;
  const sessionStorage = {
    getItem(key) { return stored.get(key) || null; },
    setItem(key, value) { stored.set(key, value); },
    removeItem(key) { stored.delete(key); },
  };
  const AdminPage = loadAdminPage(null, async (url, options) => {
    observedRequest = { url, options };
    return {
      ok: true,
      json: async () => ({
        version: '2026-07-29',
        correlationId: 'prt_0123456789abcdef01234567',
        data: {
          schema_version: 1,
          action: 'kyc_certification_session_created',
          replayed: true,
          verification: {
            provider: 'didit',
            status: 'in_progress',
            url: 'https://verify.didit.me/session/recovered-hosted-link',
            expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
          },
        },
      }),
    };
  }, {
    sessionStorage,
    location: { assign(value) { assigned = value; } },
  });
  const page = new AdminPage({});
  page._route = 'partners';
  page._partnersView = 'risk';
  page._partnersCapabilities = { support: false, risk: true, finance: false };
  page._partnersFetchKycCertificationPreflight = async () => validCertificationPreflight();
  page._partnersKycCertificationDialog = async ({ preflight, resuming }) => {
    assert.equal(preflight.ready, true);
    assert.equal(resuming, true);
    return { confirmation: '', justification: '' };
  };
  page._partnersRandomUuid = () => {
    throw new Error('resume must be derived by the server');
  };
  page._sbUrl = () => 'https://api.norva.tv';
  page._sbKey = () => 'public-anon-key';
  page._token = () => 'user-aal2-jwt';

  const result = await page._runPartnersAdminAction({
    dataset: { partnersAction: 'kyc-certification-resume' },
  });
  assert.equal(result, false);
  assert.equal(
    observedRequest.url,
    'https://api.norva.tv/functions/v1/norva-partners/kyc/certification/resume',
  );
  assert.equal(observedRequest.options.headers['Idempotency-Key'], undefined);
  assert.deepEqual(JSON.parse(observedRequest.options.body), {});
  assert.match(stored.get('norva-partners-kyc-certification-v1'), /^\d{13}$/);
  assert.equal(assigned, 'https://verify.didit.me/session/recovered-hosted-link');
  assert.doesNotMatch(
    JSON.stringify(observedRequest),
    /session_token|provider_session_id|workflow_id|justification|confirmation/,
  );
});

test('Admin Partners restores only bounded focus and scroll context after Didit', () => {
  const stored = new Map();
  const sessionStorage = {
    getItem(key) { return stored.get(key) || null; },
    setItem(key, value) { stored.set(key, value); },
    removeItem(key) { stored.delete(key); },
  };
  const documentOverride = {
    getElementById() { return null; },
    querySelector(selector) {
      return selector === '#page-admin .crm-main' ? { scrollTop: 428 } : null;
    },
    querySelectorAll() { return []; },
  };
  const AdminPage = loadAdminPage(documentOverride, null, { sessionStorage });
  const page = new AdminPage({});

  page._partnersPersistKycCertificationReturnContext();
  const persisted = JSON.parse(stored.get(
    'norva-partners-kyc-certification-context-v1',
  ));
  assert.deepEqual(persisted, {
    version: 1,
    view: 'risk',
    scrollTop: 428,
    focus: 'kyc_certification_card',
  });
  assert.doesNotMatch(JSON.stringify(persisted), /email|uuid|provider|session|partner/i);

  const restored = page._partnersConsumeKycCertificationReturnContext();
  assert.equal(restored.view, 'risk');
  assert.equal(restored.scrollTop, 428);
  assert.equal(restored.focus.id, 'partners-admin-kyc-certification');
  assert.equal(
    stored.has('norva-partners-kyc-certification-context-v1'),
    false,
  );

  stored.set(
    'norva-partners-kyc-certification-context-v1',
    JSON.stringify({
      version: 1,
      view: 'risk',
      scrollTop: 428,
      focus: 'kyc_certification_card',
      email: 'must-not-be-restored@example.test',
    }),
  );
  assert.equal(page._partnersConsumeKycCertificationReturnContext(), null);
});

test('Admin Partners polls null certification state through the complete recovery window', async () => {
  let now = 1_000_000;
  let nextTimer = 1;
  const timers = new Map();
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() { return now; }
  }
  const fakeSetTimeout = (callback, delay = 0) => {
    const id = nextTimer++;
    timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback });
    return id;
  };
  const fakeClearTimeout = (id) => timers.delete(id);
  const advance = async (milliseconds) => {
    const target = now + milliseconds;
    while (true) {
      const due = Array.from(timers.entries())
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      now = timer.at;
      timer.callback();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
    await Promise.resolve();
  };
  const sessionStorage = {
    setItem() {},
    removeItem() {},
  };
  const certification = {
    innerHTML: '',
    dataset: {},
    removeAttribute() {},
    contains() { return false; },
  };
  const documentOverride = {
    getElementById(id) {
      return id === 'partners-admin-kyc-certification' ? certification : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    activeElement: null,
  };
  const AdminPage = loadAdminPage(documentOverride, async () => {
    throw new Error('network_unknown');
  }, {
    sessionStorage,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    Date: FakeDate,
  });
  const page = new AdminPage({});
  page._route = 'partners';
  page._partnersView = 'risk';
  page._partnersPageGeneration = 1;
  page._partnersCapabilities = { support: false, risk: true, finance: false };
  page._partnersFetchKycCertificationPreflight = async () => (
    validCertificationPreflight()
  );
  page._partnersKycCertificationDialog = async () => ({
    confirmation: 'CERTIFIER DIDIT',
    justification: 'Certification live contrôlée du workflow Didit v1.',
  });
  page._partnersRandomUuid = () => '11111111-1111-4111-8111-111111111111';
  page._sbUrl = () => 'https://api.norva.tv';
  page._sbKey = () => 'public-anon-key';
  page._token = () => 'user-aal2-jwt';
  let refreshes = 0;
  page._partnersLoadKycCertification = async ({ force }) => {
    assert.equal(force, true);
    refreshes += 1;
    page._renderPartnersKycCertification({
      schema_version: 1,
      action: 'kyc_certification_status',
      certification: null,
    });
  };

  await assert.rejects(
    page._runPartnersAdminAction({
      dataset: { partnersAction: 'kyc-certification-start' },
    }),
    /didit_certification_result_uncertain/,
  );
  await advance(0);
  assert.equal(refreshes, 1, 'the uncertain result triggers an immediate read');
  assert.ok(page._partnersKycCertificationPollTimer !== null);
  await advance(9_000);
  assert.equal(refreshes, 4, 'null states keep polling every three seconds');
  await advance(51_000);
  assert.equal(
    refreshes,
    21,
    'the 60-second boundary performs one final authoritative read',
  );
  assert.equal(page._partnersKycCertificationPollUntil, 0);
  assert.equal(page._partnersKycCertificationPollTimer, null);
  assert.equal(timers.size, 0, 'no timer survives the bounded recovery window');
  assert.match(
    visibleUiMarkup(certification.innerHTML),
    /data-partners-action="kyc-certification-start"/,
    'the final read leaves the safe Start action available again',
  );
  page.hide();
});

function validCertificationEnvelope(overrides = {}) {
  return {
    version: '2026-07-29',
    correlationId: 'prt_0123456789abcdef01234567',
    data: {
      schema_version: 1,
      action: 'kyc_certification_session_created',
      replayed: false,
      verification: {
        provider: 'didit',
        status: 'not_started',
        url: 'https://verify.didit.me/session/opaque-hosted-link',
        expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      },
    },
    ...overrides,
  };
}

function configureCertificationActionPage(page) {
  page._route = 'partners';
  page._partnersView = 'risk';
  page._partnersCapabilities = { support: false, risk: true, finance: false };
  page._partnersFetchKycCertificationPreflight = async () => (
    validCertificationPreflight()
  );
  page._partnersKycCertificationDialog = async () => ({
    confirmation: 'CERTIFIER DIDIT',
    justification: 'Certification live contrôlée du workflow Didit v1.',
  });
  page._partnersRandomUuid = () => '11111111-1111-4111-8111-111111111111';
  page._sbUrl = () => 'https://api.norva.tv';
  page._sbKey = () => 'public-anon-key';
  page._token = () => 'user-aal2-jwt';
  page._partnersLoadKycCertification = async () => null;
}

test('Admin Partners bounds a slow Didit body until AbortSignal settles it', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  const controller = new AbortController();
  let released = false;
  const response = {
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          read() { return new Promise(() => {}); },
          async cancel() {},
          releaseLock() { released = true; },
        };
      },
    },
  };
  const reading = page._partnersReadBoundedJsonResponse(
    response,
    controller.signal,
  );
  setImmediate(() => controller.abort());
  await assert.rejects(reading, (error) => error?.name === 'AbortError');
  assert.equal(released, true);
});

test('Admin Partners rejects extra provider fields and enters uncertain recovery', async () => {
  let assigned = '';
  const envelope = validCertificationEnvelope();
  envelope.data.verification.provider_session_id = 'must-never-enter-browser-state';
  const AdminPage = loadAdminPage(null, async () => ({
    ok: true,
    json: async () => envelope,
  }), {
    location: { assign(value) { assigned = value; } },
  });
  const page = new AdminPage({});
  configureCertificationActionPage(page);
  await assert.rejects(
    page._runPartnersAdminAction({
      dataset: { partnersAction: 'kyc-certification-start' },
    }),
    /didit_certification_result_uncertain/,
  );
  assert.equal(assigned, '');
  page._partnersKycCertificationPollUntil = 0;
  page.hide();
});

test('Admin Partners rejects non-canonical or stale Didit hosted sessions', async () => {
  const cases = [
    {
      label: 'custom HTTPS port',
      url: 'https://verify.didit.me:444/session/not-canonical',
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    },
    {
      label: 'expired session',
      url: 'https://verify.didit.me/session/expired',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    },
    {
      label: 'TTL beyond the local two-hour reservation',
      url: 'https://verify.didit.me/session/too-long',
      expiresAt: new Date(Date.now() + (2 * 60 * 60 * 1_000) + 60_000).toISOString(),
    },
  ];
  for (const value of cases) {
    let assigned = '';
    const envelope = validCertificationEnvelope();
    envelope.data.verification.url = value.url;
    envelope.data.verification.expires_at = value.expiresAt;
    const AdminPage = loadAdminPage(null, async () => ({
      ok: true,
      json: async () => envelope,
    }), {
      location: { assign(url) { assigned = url; } },
    });
    const page = new AdminPage({});
    configureCertificationActionPage(page);
    await assert.rejects(
      page._runPartnersAdminAction({
        dataset: { partnersAction: 'kyc-certification-start' },
      }),
      /didit_certification_result_uncertain/,
      value.label,
    );
    assert.equal(assigned, '', value.label);
    page._partnersKycCertificationPollUntil = 0;
    page.hide();
  }
});

test('Admin Partners polling never replaces a busy certification action', () => {
  let writes = 0;
  let markup = '<button data-partners-action="kyc-certification-resume">Traitementâ€¦</button>';
  const certification = {
    dataset: {},
    get innerHTML() { return markup; },
    set innerHTML(value) { writes += 1; markup = value; },
    removeAttribute() {},
  };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return id === 'partners-admin-kyc-certification' ? certification : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._route = 'partners';
  page._partnersView = 'risk';
  page._partnersCapabilities = { support: false, risk: true, finance: false };
  page._partnersRequests.set('kycCertificationMutation', {
    token: 1,
    controller: { abort() {} },
  });

  page._renderPartnersKycCertification({
    schema_version: 1,
    action: 'kyc_certification_status',
    certification: null,
  });
  assert.equal(writes, 0);
  assert.match(markup, /Traitement/);
  page._partnersRequests.delete('kycCertificationMutation');
  page.hide();
});

test('Admin Partners treats final callback-marker failure as an uncertain result', async () => {
  let writes = 0;
  let assigned = '';
  const sessionStorage = {
    setItem() {
      writes += 1;
      if (writes === 2) throw new Error('storage_revoked');
    },
    removeItem() {},
  };
  const AdminPage = loadAdminPage(null, async () => ({
    ok: true,
    json: async () => validCertificationEnvelope(),
  }), {
    sessionStorage,
    location: { assign(value) { assigned = value; } },
  });
  const page = new AdminPage({});
  configureCertificationActionPage(page);
  await assert.rejects(
    page._runPartnersAdminAction({
      dataset: { partnersAction: 'kyc-certification-start' },
    }),
    /didit_certification_result_uncertain/,
  );
  assert.equal(writes, 2);
  assert.equal(assigned, '');
  page._partnersKycCertificationPollUntil = 0;
  page.hide();
});

test('Admin Partners never redirects a late Didit response after route change', async () => {
  let resolveFetch;
  let assigned = '';
  const fetchResult = new Promise((resolve) => { resolveFetch = resolve; });
  const AdminPage = loadAdminPage(null, async () => fetchResult, {
    location: { assign(value) { assigned = value; } },
  });
  const page = new AdminPage({});
  configureCertificationActionPage(page);
  const action = page._runPartnersAdminAction({
    dataset: { partnersAction: 'kyc-certification-start' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  page._route = 'cockpit';
  page._partnersAbortAll();
  resolveFetch({
    ok: true,
    json: async () => validCertificationEnvelope(),
  });
  await assert.rejects(action, /didit_certification_result_uncertain/);
  assert.equal(assigned, '');
  page._partnersKycCertificationPollUntil = 0;
  page.hide();
});

test('Admin Partners hides Start while an unknown Didit result is reconciling', () => {
  const certification = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) {
      return id === 'partners-admin-kyc-certification' ? certification : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._route = 'partners';
  page._partnersView = 'risk';
  page._partnersCapabilities = { support: false, risk: true, finance: false };
  page._partnersKycCertificationPollUntil = Date.now() + 60_000;
  page._renderPartnersKycCertification({
    schema_version: 1,
    action: 'kyc_certification_status',
    certification: null,
  });
  assert.doesNotMatch(
    visibleUiMarkup(certification.innerHTML),
    /data-partners-action="kyc-certification-start"/,
  );
  assert.match(visibleUiMarkup(certification.innerHTML), /Norva v&eacute;rifie/);
  page._partnersKycCertificationPollUntil = 0;
  page.hide();
});

test('Admin Partners renders approval registry schema v2 and immutable provenance', () => {
  const configuration = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-configuration' ? configuration : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: true, finance: false };
  page._partnersCanManageRelease = true;
  page._renderPartnersConfiguration({
    schema_version: 2,
    programs: [{
      version_key: 'individual-global-p0-v2',
      status: 'active',
      attribution_window_days: 30,
      maturation_days: 45,
      terms_version: 'partners-terms-v1',
    }],
    policies: [],
    configuration_counts: {
      active_country_mappings: 0,
      active_currencies: 0,
      active_payout_providers: 0,
      active_allowlist_entries: 0,
    },
    release_flags: [],
    release_gates: [{
      key: 'privacy_approved',
      satisfied: false,
      preproduction_satisfied: true,
      recorded_satisfied: true,
      approval_status: 'current_preproduction',
      approval_provenance: {
        package_version: 3,
        deployment_environment: 'preproduction',
        source_commit_sha: 'a'.repeat(40),
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    }],
    deployment_manifests: [{
      deployment_environment: 'preproduction',
      manifest_version: 2,
      manifest_sha256: 'b'.repeat(64),
      source_commit_sha: 'a'.repeat(40),
      deployment_key: 'hetzner-preproduction-a',
      deployment_evidence_sha256: 'c'.repeat(64),
      document_keys: ['deployment_proof', 'privacy_notice'],
      registered_at: '2026-08-04T00:00:00.000Z',
    }],
  });
  assert.match(visibleUiMarkup(configuration.innerHTML), /manifeste #2/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /préproduction uniquement/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /aucune autorité live/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /package #3/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /Approuver avec preuves/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /data-partners-action="release-manifest"/);
});

test('Admin Partners can renew a production gate into preproduction without disabling it first', () => {
  const configuration = { innerHTML: '', removeAttribute() {} };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-configuration' ? configuration : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: true, finance: false };
  page._partnersCanManageRelease = true;
  page._renderPartnersConfiguration({
    schema_version: 2,
    programs: [{
      version_key: 'individual-global-p0-v2',
      status: 'active',
      attribution_window_days: 30,
      maturation_days: 45,
      terms_version: 'partners-terms-v1',
    }],
    policies: [],
    configuration_counts: {
      active_country_mappings: 0,
      active_currencies: 0,
      active_payout_providers: 0,
      active_allowlist_entries: 0,
    },
    release_flags: [],
    release_gates: [{
      key: 'privacy_approved',
      satisfied: true,
      preproduction_satisfied: false,
      recorded_satisfied: true,
      approval_status: 'current',
      approval_provenance: {
        package_version: 4,
        deployment_environment: 'production',
        source_commit_sha: 'a'.repeat(40),
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    }],
    deployment_manifests: [{
      deployment_environment: 'production',
      manifest_version: 4,
      manifest_sha256: 'b'.repeat(64),
      source_commit_sha: 'a'.repeat(40),
      deployment_key: 'hetzner-production-a',
      deployment_evidence_sha256: 'c'.repeat(64),
      document_keys: ['deployment_proof', 'privacy_notice'],
      registered_at: '2026-08-04T00:00:00.000Z',
    }],
  });
  assert.match(visibleUiMarkup(configuration.innerHTML), /data-partners-action="release-gate-approve"/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /Renouveler avec preuves/);
  assert.match(visibleUiMarkup(configuration.innerHTML), /data-partners-action="release-gate"/);
  assert.match(visibleUiMarkup(configuration.innerHTML), />Désactiver<\/button>/);
});

test('Admin Partners approves a gate through the immutable package RPC', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: true, finance: false };
  page._partnersEnsureAal2 = async () => true;
  const commit = 'a'.repeat(40);
  const deploymentHash = 'b'.repeat(64);
  const evidence = {
    approval_record: '1'.repeat(64),
    deployment_proof: deploymentHash,
    biometric_consent: '3'.repeat(64),
    dpia: '4'.repeat(64),
    gdpr_self_assessment: '5'.repeat(64),
    privacy_notice: '6'.repeat(64),
    records_of_processing: '7'.repeat(64),
  };
  page._partnersConfiguration = {
    schema_version: 2,
    programs: [{ version_key: 'individual-global-p0-v2', status: 'active' }],
    policies: [{
      program_version_key: 'individual-global-p0-v2',
      country_code: 'FR',
      subdivision_code: null,
    }],
    deployment_manifests: [{
      deployment_environment: 'preproduction',
      source_commit_sha: commit,
      deployment_key: 'hetzner-preproduction-a',
      deployment_evidence_sha256: deploymentHash,
    }],
  };
  const prompts = [
    'preproduction',
    'individual-global-p0-v2',
    '2099-01-01T00:00:00.000Z',
  ];
  page._partnersPrompt = async () => prompts.shift();
  const jsonPrompts = [[{ country_code: 'FR', subdivision_code: null }], evidence];
  page._partnersPromptJson = async () => jsonPrompts.shift();
  page._partnersJustification = async () => 'Approbation Privacy documentée pour le pilote France.';
  page._partnersTypedConfirmation = async () => 'confirmed';
  const calls = [];
  page._rpc = async (name, args) => {
    calls.push({ name, args });
    return {
      schema_version: 1,
      action: 'release_gate_approved',
      gate_key: 'privacy_approved',
      satisfied: true,
      effective: true,
      recorded_satisfied: true,
      approval: {
        package_sha256: 'f'.repeat(64),
        source_commit_sha: commit,
        deployment_environment: 'preproduction',
      },
    };
  };
  const result = await page._runPartnersAdminAction({
    dataset: {
      partnersAction: 'release-gate-approve',
      partnersKey: 'privacy_approved',
      partnersEnabled: 'true',
    },
  });
  assert.match(result, /préproduction/);
  assert.match(result, /autorité live reste fermée/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'admin_partners_release_gate_approve');
  assert.equal(calls[0].args.p_source_commit_sha, commit);
  assert.deepEqual(calls[0].args.p_jurisdictions, [
    { country_code: 'FR', subdivision_code: null },
  ]);
  assert.equal(calls.some((call) => call.name === 'admin_partners_control'), false);
});
