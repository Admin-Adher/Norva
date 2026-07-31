'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'public/js/pages/AdminPage.js'),
  'utf8',
);

function loadAdminPage(documentOverride = null, fetchOverride = null) {
  const window = { crypto: webcrypto };
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
    fetch: fetchOverride || (async () => ({
      ok: true,
      json: async () => ({}),
    })),
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    URL,
    Intl,
    Date,
    Map,
    Set,
    Promise,
    TextEncoder,
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
  assert.match(source, /this\._rpc\('admin_partners_revolut_payout_status'\)/);
  assert.match(source, /this\._rpc\('admin_partners_revolut_manual_batches',\s*\{/);
  assert.match(source, /this\._rpc\('admin_partners_revolut_reconciliation_queue',\s*\{/);
  assert.match(source, /this\._rpc\('admin_partners_revolut_reconciliation_incidents',\s*\{/);
  assert.match(source, /this\._rpc\('admin_partners_revolut_return_queue',\s*\{/);
  assert.match(source, /this\._rpc\('admin_partners_revolut_manual_controls_queue',\s*\{/);
  assert.match(source, /this\._rpc\('admin_partners_revolut_late_completion_queue',\s*\{/);
  assert.match(source, /this\._rpc\('admin_partners_revolut_profile_status',\s*\{/);
  assert.match(source, /norva-partners-revolut-payout\/manual\/beneficiaries\/propose/);
  assert.match(source, /PROPOSE-BENEFICIARY:/);
  assert.match(source, /admin_partners_revolut_manual_batch_export/);
  assert.match(source, /ACCESS-EXPORT:/);
  assert.match(source, /manual_batch_export_hash_mismatch/);
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
  assert.match(section, /capabilityEnvelope\?\.can_manage === true/);
  assert.match(section, /capabilityEnvelope\?\.can_manage_release === true/);
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
  assert.doesNotMatch(section, /airwallex/i);
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
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_revolut_api_enabled', true), true);
  assert.equal(page._partnersCanUseReleaseControl('flag', 'partners_tv_relay_enabled', true), true);
  assert.equal(page._partnersCanUseReleaseControl('gate', 'general_release_approved', true), true);
  assert.equal(page._partnersCanUseReleaseControl('gate', 'manual_payout_workflow_verified', true), true);
  assert.equal(page._partnersCanUseReleaseControl('gate', 'revolut_api_adapter_verified', true), true);
  assert.equal(page._partnersCanUseConfigurationAction('program-create'), true);
});

test('Admin Partners renders Revolut Basic manual as production and keeps the API separate', () => {
  const revolut = {
    innerHTML: '',
    removeAttribute() {},
  };
  const AdminPage = loadAdminPage({
    getElementById(id) { return id === 'partners-admin-revolut' ? revolut : null; },
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

  assert.match(revolut.innerHTML, /Revolut Business · Basic/);
  assert.match(revolut.innerHTML, /Production · manuel/);
  assert.match(revolut.innerHTML, /Flag DB API désactivé/);
  assert.match(revolut.innerHTML, /Gate adaptateur API non validé/);
  assert.match(revolut.innerHTML, /saisies en attente de relevé/);
  assert.match(revolut.innerHTML, /relevés à valider/);
  assert.match(revolut.innerHTML, /FR · EUR/);
  assert.match(revolut.innerHTML, /Aucun virement n’est déclenché automatiquement/);
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

  assert.match(detail.innerHTML, /Bénéficiaire Revolut/);
  assert.match(detail.innerHTML, /J\. H\. · FR76••••1234/);
  assert.match(detail.innerHTML, /Mode manuel uniquement/);
  assert.match(detail.innerHTML, /data-partners-action="revolut-binding-propose"/);
  assert.match(detail.innerHTML, /data-partners-action="revolut-binding-verify"/);
  assert.match(detail.innerHTML, /data-partners-action="revolut-binding-reject"/);
  assert.match(detail.innerHTML, /data-partners-action="revolut-binding-revoke-request"/);
  assert.match(detail.innerHTML, /data-partners-action="revolut-binding-revoke-confirm"/);
  assert.doesNotMatch(detail.innerHTML, /must-never-render/);
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
    account_id: '11111111-1111-4111-8111-111111111111',
    currency: 'EUR',
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

  assert.match(settlement.innerHTML, /NORVA-A1B2C3D4E5F6/);
  assert.match(settlement.innerHTML, /data-partners-action="revolut-reconciliation-review"/);
  assert.match(settlement.innerHTML, /data-partners-action="revolut-reconciliation-confirm"/);
  assert.match(settlement.innerHTML, /data-partners-action="revolut-reconciliation-quarantine"/);
  assert.match(settlement.innerHTML, /destination attendue FR76••••1234/);
  assert.match(settlement.innerHTML, /à comparer dans Revolut/);
  assert.match(source, /provider_not_completed/);
  assert.match(settlement.innerHTML, /Importer un relevé CSV/);
  assert.doesNotMatch(settlement.innerHTML, /provider_transaction_id|beneficiary_token_ref/i);
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
  assert.match(incidents.innerHTML, /3 action\(s\) requise\(s\)/);
  assert.match(incidents.innerHTML, /data-partners-action="revolut-incident-review"/);
  assert.match(incidents.innerHTML, /data-partners-resolution="quarantine"/);
  assert.match(incidents.innerHTML, /data-partners-action="revolut-incident-decide-approve"/);
  assert.match(incidents.innerHTML, /data-partners-action="revolut-incident-decide-quarantine"/);
  assert.match(incidents.innerHTML, /Contrôle 1\/2 enregistré/);
  assert.match(incidents.innerHTML, /empreinte 0123456789ab/);
  assert.match(incidents.innerHTML, /Alias append-only · empreinte autoritaire/);
  assert.doesNotMatch(incidents.innerHTML, /rta_0123456789abcdef01234567/);
  assert.match(incidents.innerHTML, /data-partners-action="revolut-incident-page"/);
  assert.doesNotMatch(
    incidents.innerHTML,
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
  assert.match(incidents.innerHTML, /P1 · Montant différent/);
  assert.match(incidents.innerHTML, /1\u202f234,56\u00a0€/);
  assert.match(incidents.innerHTML, /10,00\u00a0€/);
  assert.match(incidents.innerHTML, /1\u202f234 EUR en unités mineures/);
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
  assert.match(incidents.innerHTML, /Observation autoritative indisponible/);

  render(revolutIncident({
    status: 'resolved',
    resolution: 'remap_exact_and_settle',
    resolved_at: '2026-07-30T10:05:00Z',
    eligible_actions: [],
    transaction_alias: null,
  }));
  assert.equal(page._partnersReconciliationIncidents.size, 0);
  assert.match(incidents.innerHTML, /Observation autoritative indisponible/);
});

test('Admin Partners binds incident evidence to exact maker-checker confirmations', async () => {
  const AdminPage = loadAdminPage();
  const page = new AdminPage({});
  page._partnersCapabilities = { support: false, risk: false, finance: true };
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

  assert.match(returns.innerHTML, /NORVA-A1B2C3D4E5F6/);
  assert.match(returns.innerHTML, /Déblocage avant règlement/);
  assert.match(returns.innerHTML, /Retour après règlement/);
  assert.match(returns.innerHTML, /data-partners-action="revolut-return-review-eligible"/);
  assert.match(returns.innerHTML, /data-partners-action="revolut-return-review-quarantine"/);
  assert.match(returns.innerHTML, /data-partners-action="revolut-return-decide-confirm"/);
  assert.match(returns.innerHTML, /aucun paiement déjà confirmé n’est réécrit/);
  assert.doesNotMatch(
    returns.innerHTML,
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
    controls.innerHTML,
    /data-partners-action="revolut-manual-control-confirm"/,
  );
  assert.match(
    controls.innerHTML,
    /data-partners-action="revolut-manual-control-reject"/,
  );
  assert.match(controls.innerHTML, /Annulation intégrale du lot/);
  assert.doesNotMatch(controls.innerHTML, new RegExp('a'.repeat(64)));
  assert.doesNotMatch(
    controls.innerHTML,
    /provider_search_evidence_hash|requested_by_pseudonym/i,
  );
  assert.match(
    late.innerHTML,
    /data-partners-action="revolut-late-review-eligible"/,
  );
  assert.match(
    late.innerHTML,
    /data-partners-action="revolut-late-decide-confirm"/,
  );
  assert.match(late.innerHTML, /NORVA-A1B2C3D4E5F6/);
  assert.doesNotMatch(
    late.innerHTML,
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
