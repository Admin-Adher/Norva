'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const cloudSource = read('public/js/cloudApi.js');
const pageSource = read('public/js/pages/PartnersPage.js');
const settingsSource = read('public/js/pages/Settings.js');
const appSource = read('public/js/app.js');
const htmlSource = read('public/app.html');
const cssSource = read('public/css/main.css');
const serviceWorkerSource = read('public/sw.js');
const standaloneSource = read('public/js/utils/standalone.js');

function validEnvelope() {
  return {
    version: '2026-07-29',
    correlationId: 'client-contract-test',
    data: {
      schema_version: 1,
      flags: {
        partners_enabled: true,
        partners_invite_only: true,
        partners_shadow_mode: true,
        partners_payouts_live: false,
        partners_tv_relay_enabled: false,
      },
      visibility: { visible: true, reason: 'available' },
      eligibility: { eligible: true, reason: 'eligible' },
      program: {
        version_key: 'p0-2026-07',
        commission_rate_bps: 2000,
        attribution_window_days: 30,
        maturation_days: 45,
        payout_thresholds: { EUR: 5000 },
        effective_from: '2026-07-29T00:00:00Z',
        effective_until: null,
      },
      policy: {
        country_code: 'FR',
        subdivision_code: 'FR-IDF',
        individual_available: true,
        minimum_age: 18,
        capacity_required: true,
        kyc_level: 'identity_age_country_capacity',
        payout_currencies: ['EUR'],
        terms_version: 'partners-fr-v1',
        disclosure_version: 'partners-fr-v1',
      },
      allowlist: { required: true, included: true },
      account: {
        exists: false,
        status: null,
        account_type: null,
        verification_status: null,
        contract_status: null,
        link_status: null,
      },
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validActionEnvelope(action, nextAction, link) {
  return {
    version: '2026-07-29',
    correlationId: `action-${action}`,
    data: {
      schema_version: 1,
      action,
      replayed: false,
      account: {
        exists: true,
        status: link ? 'active' : 'pending_verification',
        verification_status: link ? 'verified' : 'pending',
        contract_status: link || action === 'terms_accepted' ? 'accepted' : 'not_accepted',
        link_status: link ? 'active' : 'none',
      },
      next_action: nextAction,
      ...(link ? { link } : {}),
    },
  };
}

function validDashboardEnvelope() {
  return {
    version: '2026-07-29',
    correlationId: 'dashboard-contract-test',
    data: {
      schema_version: 1,
      account: {
        exists: true,
        status: 'active',
        verification_status: 'verified',
        contract_status: 'accepted',
        link_status: 'active',
        country_code: 'FR',
        subdivision_code: 'FR-IDF',
        created_at: '2026-07-29T10:00:00Z',
        updated_at: '2026-07-29T11:00:00Z',
      },
      link: {
        status: 'active',
        share_url: `https://norva.tv/r/${'A'.repeat(32)}`,
        created_at: '2026-07-29T11:00:00Z',
      },
      reporting: {
        available: true,
        reason: 'available',
        currency: 'EUR',
        clicks: 3,
        referrals: 1,
        pending_minor: 500,
        available_minor: 250,
        paid_minor: 1000,
        currencies: [{
          currency: 'EUR',
          pending_minor: 500,
          available_minor: 250,
          paid_minor: 1000,
          payout_destination_ready: false,
        }],
      },
      history: {
        status: 'all',
        items: [
          { type: 'commission_pending', occurred_at: '2026-07-29T10:00:00Z' },
          { type: 'commission_available', occurred_at: '2026-07-29T11:00:00Z' },
        ],
        next_cursor: `history_${'1'.repeat(20)}`,
      },
    },
  };
}

function loadCloudApi(payload) {
  const requests = [];
  const values = new Map([
    ['norva-cloud-token', 'user-access-token'],
    ['norva-active-profile-id', 'viewer-profile-id'],
  ]);
  const localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const window = {
    NORVA_PARTNERS_API_URL: 'https://api.norva.tv/functions/v1/norva-partners',
    location: {
      origin: 'https://norva.tv',
      search: '',
      replace() {},
    },
  };
  const context = vm.createContext({
    window,
    localStorage,
    navigator: {
      userAgent: 'Norva client contract test',
      language: 'en-US',
      languages: ['en-US'],
    },
    document: {
      readyState: 'loading',
      addEventListener() {},
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name.toLowerCase() === 'content-type' ? 'application/json' : null;
          },
        },
        json: async () => clone(
          typeof payload === 'function' ? payload(url, options) : payload,
        ),
        text: async () => '',
      };
    },
    URL,
    URLSearchParams,
    AbortController,
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
  return { cloud: window.NorvaCloud, requests, values };
}

test('Partners bootstrap uses the exact account-scoped GET without profile leakage', async () => {
  const { cloud, requests } = loadCloudApi(validEnvelope());
  const controller = new AbortController();
  const result = await cloud.partners.bootstrap({
    countryCode: 'fr',
    subdivisionCode: 'fr-idf',
    signal: controller.signal,
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://api.norva.tv/functions/v1/norva-partners/bootstrap?countryCode=FR&subdivisionCode=FR-IDF',
  );
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.body, undefined);
  assert.equal(requests[0].options.signal, controller.signal);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer user-access-token');
  assert.equal(requests[0].options.headers['x-norva-profile-id'], undefined);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.data.account), true);
  assert.deepEqual(Object.keys(cloud.device.partners), []);
  assert.equal(cloud.device.partners.bootstrap, undefined);
});

test('Partners user actions use exact routes, idempotency and validated server-issued data', async () => {
  const shareUrl = `https://norva.tv/r/${'A'.repeat(32)}`;
  const responder = (url) => {
    if (url.endsWith('/applications')) {
      return validActionEnvelope('application_submitted', 'start_verification');
    }
    if (url.endsWith('/activate')) {
      return validActionEnvelope('terms_accepted', 'await_verification');
    }
    if (url.endsWith('/links')) {
      return validActionEnvelope('link_rotated', 'share_link', {
        status: 'active',
        share_url: shareUrl,
        rotated_at: '2026-07-29T12:00:00Z',
      });
    }
    if (url.includes('/dashboard?')) return validDashboardEnvelope();
    throw new Error(`unexpected request ${url}`);
  };
  const { cloud, requests } = loadCloudApi(responder);
  const applyKey = 'norva.application.1234567890abcdef';
  const termsKey = 'norva.terms.1234567890abcdef';
  const linkKey = 'norva.link.1234567890abcdef';

  const applied = await cloud.partners.apply({
    accountType: 'individual',
    countryCode: 'fr',
    subdivisionCode: 'fr-idf',
    idempotencyKey: applyKey,
  });
  const accepted = await cloud.partners.acceptTerms({
    termsVersion: 'partners-fr-v1',
    disclosureVersion: 'partners-fr-v1',
    idempotencyKey: termsKey,
  });
  const rotated = await cloud.partners.rotateLink({ idempotencyKey: linkKey });
  const dashboard = await cloud.partners.dashboard({ limit: 25, status: 'all' });

  assert.equal(applied.data.action, 'application_submitted');
  assert.equal(accepted.data.action, 'terms_accepted');
  assert.equal(rotated.data.link.share_url, shareUrl);
  assert.equal(dashboard.data.reporting.available, true);
  assert.equal(Object.isFrozen(dashboard.data.history), true);
  assert.equal(requests.length, 4);

  assert.equal(requests[0].url, 'https://api.norva.tv/functions/v1/norva-partners/applications');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['Idempotency-Key'], applyKey);
  assert.equal(requests[0].options.headers['x-norva-profile-id'], undefined);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    accountType: 'individual',
    countryCode: 'FR',
    subdivisionCode: 'FR-IDF',
  });
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    termsVersion: 'partners-fr-v1',
    disclosureVersion: 'partners-fr-v1',
  });
  assert.deepEqual(JSON.parse(requests[2].options.body), {});
  assert.equal(
    requests[3].url,
    'https://api.norva.tv/functions/v1/norva-partners/dashboard?limit=25&status=all',
  );
  assert.equal(requests[3].options.method, 'GET');
  assert.equal(requests[3].options.headers['x-norva-profile-id'], undefined);
});

test('Partners KYC starts only from explicit versioned consent and trusts only Didit hosted URLs', async () => {
  const payload = {
    version: '2026-07-29',
    correlationId: 'prt_0123456789abcdef01234567',
    data: {
      schema_version: 1,
      action: 'kyc_session_created',
      replayed: false,
      verification: {
        provider: 'didit',
        status: 'pending',
        url: 'https://verify.didit.me/session/opaque-result',
        expires_at: null,
      },
    },
  };
  const { cloud, requests } = loadCloudApi(payload);
  const result = await cloud.partners.startKyc({
    language: 'FR',
    consentVersion: 'partners-fr-v1',
    capacityConfirmed: true,
    idempotencyKey: 'kyc:0123456789abcdef',
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://api.norva.tv/functions/v1/norva-partners/kyc/sessions',
  );
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    language: 'fr',
    consentVersion: 'partners-fr-v1',
    consentGranted: true,
    capacityConfirmed: true,
  });
  assert.equal(requests[0].options.headers['Idempotency-Key'], 'kyc:0123456789abcdef');
  assert.equal(requests[0].options.headers['x-norva-profile-id'], undefined);
  assert.equal(Object.isFrozen(result.data.verification), true);

  assert.throws(
    () => cloud.partners.startKyc({
      language: 'fr',
      consentVersion: 'partners-fr-v1',
      capacityConfirmed: false,
      idempotencyKey: 'kyc:0123456789abcdef',
    }),
    (error) => error?.code === 'partners_kyc_consent_invalid',
  );

  const invalid = loadCloudApi({
    ...payload,
    data: {
      ...payload.data,
      verification: {
        ...payload.data.verification,
        url: 'https://evil.example/collect',
      },
    },
  });
  await assert.rejects(
    invalid.cloud.partners.startKyc({
      language: 'fr',
      consentVersion: 'partners-fr-v1',
      capacityConfirmed: true,
      idempotencyKey: 'kyc:fedcba9876543210',
    }),
    (error) => error?.code === 'partners_contract_invalid',
  );
});

test('Partners consumes referrals only through the same-origin HttpOnly cookie boundary', async () => {
  const { cloud, requests } = loadCloudApi({
    version: 1,
    claimed: true,
    state: 'attributed',
  });
  const result = await cloud.partners.claimReferral();

  assert.deepEqual(clone(result), {
    version: 1,
    claimed: true,
    state: 'attributed',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://norva.tv/api/partners/claim');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), {});
  assert.equal(requests[0].options.headers.Authorization, 'Bearer user-access-token');
  assert.equal(requests[0].options.headers['Idempotency-Key'], undefined);
  assert.equal(requests[0].options.headers['x-norva-profile-id'], undefined);
  assert.equal(
    /document\.cookie|__Host-norva_referral/.test(
      String(cloud.partners.claimReferral),
    ),
    false,
  );

  const inconsistent = loadCloudApi({
    version: 1,
    claimed: false,
    state: 'attributed',
  });
  await assert.rejects(
    inconsistent.cloud.partners.claimReferral(),
    (error) => error?.code === 'partners_contract_invalid',
  );
});

test('Partners payout profile stays tokenized, masked and fail-closed', async () => {
  const getPayload = {
    version: '2026-07-29',
    correlationId: 'prt_0123456789abcdef01234567',
    data: {
      schema_version: 1,
      account: { id: `prt_${'a'.repeat(24)}`, status: 'active' },
      fiscal: { status: 'verified', country_code: 'FR' },
      profile: {
        provider: 'wise',
        display_masked: 'Wise ·•• 8421',
        currency: 'EUR',
        status: 'active',
      },
      profiles: [{
        provider: 'wise',
        display_masked: 'Wise ·•• 8421',
        currency: 'EUR',
        status: 'active',
      }],
      readiness: { ready: false, payouts_live: false, reason: 'payouts_not_live' },
    },
  };
  const get = loadCloudApi(getPayload);
  const profile = await get.cloud.partners.payoutProfile();
  assert.equal(
    get.requests[0].url,
    'https://api.norva.tv/functions/v1/norva-partners/payout-profile',
  );
  assert.equal(get.requests[0].options.method, 'GET');
  assert.equal(profile.data.profile.display_masked, 'Wise ·•• 8421');
  assert.equal(JSON.stringify(profile).includes('beneficiaryTokenRef'), false);

  const savedPayload = {
    version: '2026-07-29',
    correlationId: 'prt_fedcba9876543210fedcba98',
    data: {
      schema_version: 1,
      action: 'payout_profile_saved',
      replayed: false,
      profile: {
        provider: 'wise',
        display_masked: 'Wise ·•• 8421',
        currency: 'EUR',
        status: 'active',
      },
    },
  };
  const saved = loadCloudApi(savedPayload);
  const result = await saved.cloud.partners.saveTokenizedPayoutProfile({
    provider: 'wise',
    beneficiaryTokenRef: 'ben_tok_opaque_0123456789',
    displayMasked: 'Wise ·•• 8421',
    currency: 'eur',
    idempotencyKey: 'payout:0123456789abcdef',
  });
  assert.deepEqual(JSON.parse(saved.requests[0].options.body), {
    provider: 'wise',
    beneficiaryTokenRef: 'ben_tok_opaque_0123456789',
    displayMasked: 'Wise ·•• 8421',
    currency: 'EUR',
  });
  assert.equal(JSON.stringify(result).includes('ben_tok_opaque'), false);
  assert.throws(
    () => saved.cloud.partners.saveTokenizedPayoutProfile({
      provider: 'wise',
      beneficiaryTokenRef: 'FR1420041010050500013M02606',
      displayMasked: 'FR1420041010050500013M02606',
      currency: 'EUR',
      idempotencyKey: 'payout:fedcba9876543210',
    }),
    (error) => error?.code === 'partners_payout_profile_invalid',
  );

  const airwallexPayload = structuredClone(getPayload);
  airwallexPayload.data.profile.provider = 'airwallex';
  airwallexPayload.data.profile.display_masked = 'Airwallex ·•• 8421';
  airwallexPayload.data.profiles[0].provider = 'airwallex';
  airwallexPayload.data.profiles[0].display_masked = 'Airwallex ·•• 8421';
  const airwallex = loadCloudApi(airwallexPayload);
  const airwallexProfile = await airwallex.cloud.partners.payoutProfile();
  assert.equal(airwallexProfile.data.profile.provider, 'airwallex');

  assert.throws(
    () => saved.cloud.partners.saveTokenizedPayoutProfile({
      provider: 'airwallex',
      beneficiaryTokenRef: 'ben_tok_opaque_0123456789',
      displayMasked: 'Airwallex ·•• 8421',
      currency: 'EUR',
      idempotencyKey: 'payout:airwallex0123456789',
    }),
    (error) => error?.code === 'partners_payout_profile_invalid',
  );
});

test('Partners user actions reject local business flows, weak idempotency and dashboard drift', async () => {
  const { cloud, requests } = loadCloudApi(validActionEnvelope(
    'application_submitted',
    'start_verification',
  ));
  await assert.rejects(
    cloud.partners.apply({
      accountType: 'business',
      countryCode: 'FR',
      idempotencyKey: 'norva.application.1234567890abcdef',
    }),
    (error) => error?.code === 'business_accounts_not_supported',
  );
  await assert.rejects(
    cloud.partners.apply({
      accountType: 'individual',
      countryCode: 'FR',
      idempotencyKey: 'short',
    }),
    (error) => error?.code === 'partners_idempotency_key_invalid',
  );
  assert.equal(requests.length, 0);

  for (const mutate of [
    (value) => { value.data.extra = true; },
    (value) => { value.data.link.share_url = 'https://evil.example/r/' + 'A'.repeat(32); },
    (value) => { value.data.reporting.referrals = null; },
    (value) => { value.data.history.items[0].type = 'raw_provider_payload'; },
    (value) => { value.data.history.next_cursor = 'short'; },
  ]) {
    const payload = validDashboardEnvelope();
    mutate(payload);
    const loaded = loadCloudApi(payload);
    await assert.rejects(
      loaded.cloud.partners.dashboard({ limit: 25, status: 'all' }),
      (error) => error?.code === 'partners_contract_invalid',
    );
  }

  const mismatchedFilter = validDashboardEnvelope();
  mismatchedFilter.data.history.status = 'pending';
  mismatchedFilter.data.history.items = [{
    type: 'commission_paid',
    occurred_at: '2026-07-29T10:00:00Z',
  }];
  mismatchedFilter.data.history.next_cursor = null;
  const filtered = loadCloudApi(mismatchedFilter);
  await assert.rejects(
    filtered.cloud.partners.dashboard({ limit: 25, status: 'pending' }),
    (error) => error?.code === 'partners_contract_invalid',
  );
});

test('Partners bootstrap rejects drift, unknown fields and inconsistent states', async () => {
  const mutations = [
    (value) => { value.extra = true; },
    (value) => { value.data.program.commission_rate_bps = 1900; },
    (value) => { value.data.program.attribution_window_days = 31; },
    (value) => { value.data.program.maturation_days = 44; },
    (value) => { value.data.program.payout_thresholds = { EUR: 0 }; },
    (value) => { value.data.program.payout_thresholds = {}; },
    (value) => { value.data.visibility.visible = false; },
    (value) => { value.data.eligibility.eligible = false; },
    (value) => { value.data.program = null; },
    (value) => { value.data.policy.individual_available = false; },
    (value) => {
      value.data.allowlist.required = true;
      value.data.allowlist.included = false;
    },
    (value) => {
      value.data.account.exists = true;
      value.data.account.status = 'approved';
      value.data.account.account_type = 'individual';
      value.data.account.verification_status = 'verified';
      value.data.account.contract_status = 'accepted';
      value.data.account.link_status = 'active';
    },
    (value) => { value.data.account.link_status = 'none'; },
    (value) => { value.data.policy.subdivision_code = 'FR--IDF'; },
    (value) => { value.data.policy.minimum_age = 100; },
    (value) => { value.data.policy.kyc_level = 'standard'; },
    (value) => { value.data.policy.capacity_required = false; },
    (value) => { value.data.policy.country_code = 'US'; },
    (value) => {
      value.data.visibility = { visible: true, reason: 'existing_account' };
    },
    (value) => {
      value.data.eligibility = { eligible: false, reason: 'account_blocked' };
    },
    (value) => {
      value.data.eligibility = {
        eligible: false,
        reason: 'account_attention_required',
      };
    },
    (value) => {
      value.data.allowlist.required = false;
    },
    (value) => {
      value.data.flags.partners_enabled = false;
      value.data.eligibility = { eligible: false, reason: 'disabled' };
    },
    (value) => {
      value.data.visibility = { visible: true, reason: 'existing_account' };
      value.data.eligibility = { eligible: false, reason: 'account_blocked' };
      value.data.account = {
        exists: true,
        status: 'held',
        account_type: 'individual',
        verification_status: 'verified',
        contract_status: 'accepted',
        link_status: 'active',
      };
    },
  ];

  for (const mutate of mutations) {
    const envelope = validEnvelope();
    mutate(envelope);
    const { cloud } = loadCloudApi(envelope);
    await assert.rejects(
      cloud.partners.bootstrap({ countryCode: 'FR', subdivisionCode: 'FR-IDF' }),
      (error) => error && error.code === 'partners_contract_invalid',
    );
  }
});

test('existing accounts keep their authoritative stored jurisdiction', async () => {
  const envelope = validEnvelope();
  envelope.data.visibility = { visible: true, reason: 'existing_account' };
  envelope.data.policy.country_code = 'US';
  envelope.data.policy.subdivision_code = 'US-CA';
  envelope.data.account = {
    exists: true,
    status: 'active',
    account_type: 'individual',
    verification_status: 'verified',
    contract_status: 'accepted',
    link_status: 'none',
  };
  const { cloud } = loadCloudApi(envelope);
  const result = await cloud.partners.bootstrap({
    countryCode: 'FR',
    subdivisionCode: 'FR-IDF',
  });
  assert.equal(result.data.policy.country_code, 'US');
  assert.equal(result.data.account.exists, true);
});

test('existing account attention is a valid sanitized state', async () => {
  const envelope = validEnvelope();
  envelope.data.visibility = { visible: true, reason: 'existing_account' };
  envelope.data.eligibility = {
    eligible: false,
    reason: 'account_attention_required',
  };
  envelope.data.account = {
    exists: true,
    status: 'active',
    account_type: 'individual',
    verification_status: 'verified',
    contract_status: 'accepted',
    link_status: 'none',
  };
  const { cloud } = loadCloudApi(envelope);
  const result = await cloud.partners.bootstrap();
  assert.equal(result.data.eligibility.reason, 'account_attention_required');
});

test('Partners jurisdiction input is bounded before any request is sent', async () => {
  const { cloud, requests } = loadCloudApi(validEnvelope());
  for (const subdivisionCode of ['FR--IDF', 'ABCDEFGHIJKLM', 'FR_75', 'US-CA', 'FRX-IDF']) {
    await assert.rejects(
      cloud.partners.bootstrap({ countryCode: 'FR', subdivisionCode }),
      (error) => error && error.code === 'partners_jurisdiction_invalid',
    );
  }
  await assert.rejects(
    cloud.partners.bootstrap({ countryCode: 'FRA' }),
    (error) => error && error.code === 'partners_jurisdiction_invalid',
  );
  await assert.rejects(
    cloud.partners.bootstrap({ subdivisionCode: 'FR-IDF' }),
    (error) => error && error.code === 'partners_jurisdiction_invalid',
  );
  assert.equal(requests.length, 0);
});

test('Settings remains responsive when Partners is disabled, rejected or slow', async () => {
  const window = {
    location: { search: '' },
  };
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          id,
          hidden: false,
          textContent: '',
          style: {},
          setAttribute() {},
        });
      }
      return elements.get(id);
    },
  };
  const context = vm.createContext({
    window,
    document,
    navigator: { userAgent: '' },
    console: { log() {}, warn() {}, debug() {}, error() {} },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => callback(),
  });
  window.window = window;
  vm.runInContext(settingsSource, context, { filename: 'public/js/pages/Settings.js' });

  const page = Object.create(window.SettingsPage.prototype);
  page.app = { currentUser: { cloud: true, device: false } };
  page.refreshAccessCard = async () => {};
  page.refreshSourceHealthCard = async () => {};

  for (const refreshPartnersEntry of [
    () => new Promise(() => {}),
    () => Promise.reject(new Error('feature unavailable')),
  ]) {
    page.refreshPartnersEntry = refreshPartnersEntry;
    const outcome = await Promise.race([
      page.refreshAccountSettings().then(() => 'settings-rendered'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 40)),
    ]);
    assert.equal(outcome, 'settings-rendered');
  }
});

test('visibility probing is fail-closed and aborts a slow Edge request', async () => {
  const settingsRow = {
    hidden: false,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  };
  const window = {
    NorvaCloud: {
      partners: {
        bootstrap({ signal }) {
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            }, { once: true });
          });
        },
      },
    },
  };
  const context = vm.createContext({
    window,
    document: {
      getElementById: (id) => (id === 'settings-partners-row' ? settingsRow : null),
      querySelector: () => null,
    },
    navigator: { language: 'en-US', onLine: true },
    AbortController,
    Intl,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => callback(),
    history: { back() {} },
  });
  window.window = window;
  vm.runInContext(pageSource, context, { filename: 'public/js/pages/PartnersPage.js' });

  const page = new window.PartnersPage({ currentUser: { cloud: true, device: false } });
  page._visibilityTimeoutMs = 10;
  const outcome = await Promise.race([
    page.primeVisibility(),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100)),
  ]);
  assert.equal(outcome, false);
  assert.equal(settingsRow.hidden, true);
  assert.equal(settingsRow.attributes['aria-hidden'], 'true');
});

test('foreground loading times out to a sanitized retry state, while navigation abort stays silent', async () => {
  const makePage = () => {
    const container = {
      innerHTML: '',
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    const window = {
      NorvaCloud: {
        partners: {
          bootstrap({ signal }) {
            return new Promise((resolve, reject) => {
              signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              }, { once: true });
            });
          },
        },
      },
    };
    const context = vm.createContext({
      window,
      document: {
        getElementById: (id) => (id === 'page-partners' ? container : null),
        querySelector: () => null,
      },
      navigator: { language: 'en-US', onLine: true },
      AbortController,
      Intl,
      setTimeout,
      clearTimeout,
      requestAnimationFrame: (callback) => callback(),
      history: { back() {} },
    });
    window.window = window;
    vm.runInContext(pageSource, context, { filename: 'public/js/pages/PartnersPage.js' });
    return {
      container,
      page: new window.PartnersPage({ currentUser: { cloud: true, device: false } }),
    };
  };

  const timed = makePage();
  timed.page._showTimeoutMs = 10;
  await timed.page.show();
  assert.match(timed.container.innerHTML, /Partners is temporarily unavailable/);
  assert.match(timed.container.innerHTML, /data-partners-retry/);
  assert.doesNotMatch(timed.container.innerHTML, /aborted|AbortError/);

  const navigated = makePage();
  navigated.page._showTimeoutMs = 100;
  const showing = navigated.page.show();
  navigated.page.hide();
  await showing;
  assert.doesNotMatch(navigated.container.innerHTML, /temporarily unavailable/);
});

test('strict account states resolve to active, pending, attention and terminal views', () => {
  const window = {};
  const context = vm.createContext({
    window,
    document: { getElementById: () => null, querySelector: () => null },
    navigator: { language: 'en-US' },
    AbortController,
    Intl,
    setTimeout,
    clearTimeout,
    requestAnimationFrame() {},
    history: { back() {} },
  });
  window.window = window;
  vm.runInContext(pageSource, context, { filename: 'public/js/pages/PartnersPage.js' });
  const page = new window.PartnersPage({ currentUser: { cloud: true, device: false } });
  const data = validEnvelope().data;
  data.visibility.reason = 'existing_account';
  data.account = {
    exists: true,
    status: 'active',
    account_type: 'individual',
    verification_status: 'verified',
    contract_status: 'accepted',
    link_status: 'none',
  };
  assert.equal(page.resolveView(data), 'active', 'an active account need not have a link yet');

  data.account.status = 'pending_verification';
  data.account.verification_status = 'pending';
  data.account.contract_status = 'not_accepted';
  assert.equal(page.resolveView(data), 'pending');

  data.account.verification_status = 'failed';
  assert.equal(page.resolveView(data), 'attention');
  data.account.verification_status = 'expired';
  assert.equal(page.resolveView(data), 'attention');
  data.account.verification_status = 'verified';
  data.account.contract_status = 'expired';
  assert.equal(page.resolveView(data), 'attention');

  data.account.status = 'suspended';
  assert.equal(page.resolveView(data), 'disabled');

  data.account.status = 'held';
  data.account.verification_status = 'pending';
  data.account.contract_status = 'not_accepted';
  data.eligibility = { eligible: false, reason: 'account_blocked' };
  assert.equal(
    page.resolveView(data),
    'attention',
    'held accounts remain reviewable even though the RPC reports account_blocked',
  );

  data.account.status = 'suspended';
  assert.equal(page.resolveView(data), 'disabled');

  data.flags.partners_enabled = true;
  data.visibility = { visible: true, reason: 'available' };
  data.eligibility = { eligible: false, reason: 'country_required' };
  data.account = {
    exists: false,
    status: null,
    account_type: null,
    verification_status: null,
    contract_status: null,
    link_status: null,
  };
  assert.equal(page.resolveView(data), 'jurisdiction');
  data.eligibility.reason = 'country_not_supported';
  assert.equal(page.resolveView(data), 'jurisdiction');
});

test('existing accounts with unavailable stored policy never show the jurisdiction form', () => {
  const container = {
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const window = {};
  const context = vm.createContext({
    window,
    document: {
      getElementById: (id) => (id === 'page-partners' ? container : null),
      querySelector: () => null,
    },
    navigator: { language: 'en-US' },
    AbortController,
    Intl,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => callback(),
    history: { back() {} },
  });
  window.window = window;
  vm.runInContext(pageSource, context, { filename: 'public/js/pages/PartnersPage.js' });
  const page = new window.PartnersPage({ currentUser: { cloud: true, device: false } });
  page._visible = true;
  const data = validEnvelope().data;
  data.visibility = { visible: true, reason: 'existing_account' };
  data.policy = null;
  data.account = {
    exists: true,
    status: 'active',
    account_type: 'individual',
    verification_status: 'verified',
    contract_status: 'accepted',
    link_status: 'none',
  };

  for (const reason of ['country_not_supported', 'subdivision_not_supported']) {
    data.eligibility = { eligible: false, reason };
    assert.equal(page.resolveView(data), 'attention');
    page.renderBootstrap(data);
    assert.match(container.innerHTML, /Policy unavailable/);
    assert.match(container.innerHTML, /jurisdiction already stored on this partner account/);
    assert.doesNotMatch(container.innerHTML, /data-partners-jurisdiction|Check availability/);
  }
});

test('jurisdiction recovery is explicit, friendly, strict and never inferred', () => {
  const container = {
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const window = {
    NorvaRegions: {
      COUNTRIES: [
        { code: 'FR', name: 'France', kind: 'country' },
        { code: 'US', name: 'United States', kind: 'country' },
        { code: 'MAGHREB', name: 'Maghreb', kind: 'bundle' },
      ],
      BUNDLES: [{ code: 'INTERNATIONAL', name: 'International', kind: 'bundle' }],
    },
  };
  const context = vm.createContext({
    window,
    document: {
      getElementById: (id) => (id === 'page-partners' ? container : null),
      querySelector: () => null,
    },
    navigator: { language: 'en-US' },
    AbortController,
    Intl,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => callback(),
    history: { back() {} },
  });
  window.window = window;
  vm.runInContext(pageSource, context, { filename: 'public/js/pages/PartnersPage.js' });
  const page = new window.PartnersPage({ currentUser: { cloud: true, device: false } });
  const data = validEnvelope().data;
  data.eligibility = { eligible: false, reason: 'country_required' };
  data.policy = null;
  page._visible = true;
  page.renderJurisdiction(data);

  assert.match(container.innerHTML, /data-partners-country-open/);
  assert.match(container.innerHTML, /data-partners-country-overlay hidden/);
  assert.match(container.innerHTML, /data-region-pop role="dialog" aria-modal="true"/);
  assert.match(container.innerHTML, /role="combobox"/);
  assert.match(container.innerHTML, /role="listbox"/);
  assert.match(container.innerHTML, /data-partners-country-option="FR"/);
  assert.match(container.innerHTML, /data-partners-country-option="US"/);
  assert.match(container.innerHTML, /Country not listed\? Enter code/);
  assert.doesNotMatch(container.innerHTML, /<datalist|<select|list="partners-country-options"/);
  assert.doesNotMatch(container.innerHTML, /MAGHREB|INTERNATIONAL/);
  assert.match(container.innerHTML, /name="countryCode" type="hidden"\s+value=""/);
  assert.match(container.innerHTML, />Choose a country<\/span>/);
  assert.match(container.innerHTML, /data-partners-country-manual-input[\s\S]{0,220}placeholder="FR"/);
  assert.match(container.innerHTML, /Nothing is selected or inferred automatically/);
  assert.match(container.innerHTML, /does not promise eligibility, earnings or programme access/);
  assert.equal(
    page.jurisdictionIsValid(
      { countryCode: 'FR', subdivisionCode: 'FR-IDF' },
      { countryRequired: true },
    ),
    true,
  );
  for (const subdivisionCode of ['US-CA', 'FRX-IDF', 'FR--IDF']) {
    assert.equal(
      page.jurisdictionIsValid(
        { countryCode: 'FR', subdivisionCode },
        { countryRequired: true },
      ),
      false,
      subdivisionCode,
    );
  }
  assert.equal(
    page.jurisdictionIsValid(
      { countryCode: '', subdivisionCode: 'FR-IDF' },
      { countryRequired: false },
    ),
    false,
  );
  assert.doesNotMatch(pageSource, /inferFromLocale|navigator\.geolocation|getCurrentPosition/);
  assert.match(pageSource, /window\.NorvaRegions\?\.COUNTRIES/);
  assert.doesNotMatch(pageSource, /NorvaRegions\?\.BUNDLES|NorvaRegions\.list\(/);
  assert.match(pageSource, /while \(node\?\.parentElement\)/);
  assert.match(pageSource, /ariaHidden:\s*element\.getAttribute\('aria-hidden'\)/);
  assert.match(pageSource, /element\.inert = inert/);
  assert.match(pageSource, /if \(ariaHidden == null\) element\.removeAttribute\('aria-hidden'\)/);
  assert.match(pageSource, /search\.focus\(\{ preventScroll: true \}\)[\s\S]{0,120}isolateBackground\(\)/);
  assert.match(pageSource, /event\.key === 'Escape'[\s\S]{0,520}event\.key !== 'Tab'/);
  assert.match(
    standaloneSource,
    /\[data-region-picker\] \[data-region-pop\]:not\(\[hidden\]\)[\s\S]{0,260}__regionClose[\s\S]{0,120}return 'handled'/,
  );
});

test('bootstrap cache is short-lived, jurisdiction-scoped and session-scoped', async () => {
  let sessionToken = 'opaque-user-session-one';
  let calls = 0;
  const response = validEnvelope();
  const window = {
    NorvaCloud: {
      get token() { return sessionToken; },
      partners: {
        bootstrap: async () => {
          calls += 1;
          return clone(response);
        },
      },
    },
  };
  const context = vm.createContext({
    window,
    document: { getElementById: () => null, querySelector: () => null },
    navigator: { language: 'en-US', onLine: true },
    AbortController,
    Intl,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    requestAnimationFrame() {},
    history: { back() {} },
  });
  window.window = window;
  vm.runInContext(pageSource, context, { filename: 'public/js/pages/PartnersPage.js' });
  const page = new window.PartnersPage({ currentUser: { cloud: true, device: false } });
  page.renderLoading = () => {};
  page.renderBootstrap = () => {};
  page.setEntryVisibility = () => true;

  await page.loadBootstrap({ countryCode: 'FR', subdivisionCode: 'FR-IDF' });
  await page.loadBootstrap({ countryCode: 'FR', subdivisionCode: 'FR-IDF' });
  assert.equal(calls, 1, 'a fresh cache entry should be reused only in the background');
  assert.ok(page._bootstrapTtlMs > 0 && page._bootstrapTtlMs <= 60_000);

  page.bootstrapEnvelope.cachedAt -= page._bootstrapTtlMs + 1;
  await page.loadBootstrap({ countryCode: 'FR', subdivisionCode: 'FR-IDF' });
  assert.equal(calls, 2, 'expired data must revalidate');

  await page.loadBootstrap({ countryCode: 'US', subdivisionCode: 'US-CA' });
  assert.equal(calls, 3, 'jurisdiction changes must not reuse another policy response');

  page._jurisdiction = { countryCode: 'US', subdivisionCode: 'US-CA' };
  sessionToken = 'opaque-user-session-two';
  await page.loadBootstrap();
  assert.equal(calls, 4, 'session changes must not reuse another account response');
  assert.deepEqual(
    JSON.parse(JSON.stringify(page._jurisdiction)),
    { countryCode: '', subdivisionCode: '' },
  );

  await page.show({ countryCode: 'FR', subdivisionCode: 'FR-IDF' });
  await page.show({ countryCode: 'FR', subdivisionCode: 'FR-IDF' });
  assert.equal(calls, 6, 'every foreground show must revalidate even inside the TTL');
  assert.doesNotMatch(JSON.stringify(page.bootstrapEnvelope), /opaque-user-session/);
});

test('Partners is a secondary, server-gated route with exact user actions and no local financial authority', () => {
  assert.match(htmlSource, /id="settings-partners-row"\s+hidden\s+aria-hidden="true"/);
  assert.match(htmlSource, /id="page-partners"\s+class="page"/);
  assert.match(htmlSource, /src="\/js\/vendor\/qrcode\.js\?v=1"/);
  assert.match(htmlSource, /src="\/js\/pages\/PartnersPage\.js\?v=4"/);
  assert.doesNotMatch(htmlSource, /class="nav-link"[^>]*data-page="partners"/);
  assert.match(appSource, /this\.pages\.partners\s*=\s*new PartnersPage\(this\)/);
  assert.match(appSource, /data-act="partners"\s+hidden\s+aria-hidden="true"/);
  assert.match(appSource, /primeVisibility\?\.\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(appSource, /claimPendingPartnerReferral\(\)/);
  assert.match(appSource, /NorvaCloud\.partners\.claimReferral\(\)/);
  assert.match(settingsSource, /void this\.refreshPartnersEntry\(\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(pageSource, /localStorage|sessionStorage/);
  assert.doesNotMatch(pageSource, /referral[_-]?(?:code|token)\s*=/i);
  assert.match(pageSource, /data-partners-join disabled/);
  assert.match(pageSource, /data-partners-individual-confirm/);
  assert.match(pageSource, /data-partners-terms-confirm/);
  assert.match(pageSource, /window\.NorvaCloud\.partners\.apply/);
  assert.match(pageSource, /window\.NorvaCloud\.partners\.acceptTerms/);
  assert.match(pageSource, /window\.NorvaCloud\.partners\.rotateLink/);
  assert.match(pageSource, /window\.NorvaCloud\.partners\.dashboard/);
  const partnersNamespace = cloudSource.match(
    /partners:\s*Object\.freeze\(\{([\s\S]{0,1200}?)\}\),/,
  )?.[1] || '';
  for (const binding of [
    'bootstrap: partnersBootstrap',
    'apply: partnersApply',
    'acceptTerms: partnersAcceptTerms',
    'rotateLink: partnersRotateLink',
    'startKyc: partnersStartKyc',
    'claimReferral: partnersClaimReferral',
    'payoutProfile: partnersPayoutProfile',
    'saveTokenizedPayoutProfile: partnersSaveTokenizedPayoutProfile',
    'dashboard: partnersDashboard',
  ]) {
    assert.match(partnersNamespace, new RegExp(binding.replace(': ', ':\\s*')));
  }
  assert.match(cloudSource, /partners:\s*Object\.freeze\(\{\}\)/);
  assert.doesNotMatch(pageSource, /Math\.random\(\).*referral|referral.*Math\.random\(\)/i);
});

test('Partners states, copy and accessibility are complete but sanitized', () => {
  for (const state of [
    'renderLoading',
    'renderDiscovery',
    'renderPending',
    'renderAttention',
    'renderActive',
    'renderJurisdiction',
    'renderUnavailable',
  ]) {
    assert.match(pageSource, new RegExp(`\\b${state}\\b`));
  }
  for (const reason of [
    'disabled',
    'invite_only',
    'country_required',
    'country_not_supported',
    'subdivision_not_supported',
    'not_allowlisted',
    'account_blocked',
    'account_attention_required',
  ]) {
    assert.match(pageSource, new RegExp(`['"]${reason}['"]`));
  }
  assert.match(pageSource, /data\.eligibility\.eligible\s*\?\s*'discovery'/);
  assert.match(pageSource, /Identity, age and applicable jurisdiction policy/);
  assert.match(pageSource, /header\('Checking availability', 'partners-title'\)/);
  assert.match(pageSource, /Attribution window:<\/strong> \$\{days\} days/);
  assert.match(
    pageSource,
    /<dt>Attribution window<\/dt><dd>\$\{program\.attribution_window_days\} days/,
  );
  assert.doesNotMatch(pageSource, /verifies an individual identity, residence/i);
  assert.doesNotMatch(pageSource, /(?:error|err)\?*\.message/);
  assert.match(pageSource, /aria-live="\$\{politeness\}"/);
  assert.match(pageSource, /aria-busy="true"/);
  assert.match(pageSource, /opener\?\.isConnected/);
  assert.match(pageSource, /history\.back\(\)/);
  assert.match(
    pageSource,
    /data\.eligibility\.reason === 'not_allowlisted'[\s\S]{0,100}data\.allowlist\.included[\s\S]{0,80}return 'jurisdiction'/,
  );
  assert.match(cssSource, /\.partners-shell[\s\S]{0,420}safe-area-inset-bottom/);
  assert.match(cssSource, /\.partners-primary-action,[\s\S]{0,100}min-height:\s*44px/);
  assert.match(cssSource, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]{0,100}animation:\s*none/);
  const partnersCss = cssSource.slice(cssSource.indexOf('#page-partners'));
  const mutedUses = [...partnersCss.matchAll(/color:\s*var\(--color-text-muted\)/g)];
  assert.equal(
    mutedUses.length,
    1,
    'small Partners information must use the AA text token; muted is reserved for disabled UI',
  );
  assert.match(
    partnersCss,
    /\.partners-shell \.btn:disabled\s*\{[\s\S]{0,100}color:\s*var\(--color-text-muted\)/,
  );
  assert.match(
    partnersCss,
    /\.partners-program-facts > div,[\s\S]{0,160}flex-wrap:\s*wrap/,
    '1.3 font scaling must not force fact labels and values to overlap',
  );
  assert.match(partnersCss, /\.partners-field input[\s\S]{0,180}min-height:\s*48px/);
  assert.match(partnersCss, /\.partners-country-option\s*\{[\s\S]{0,100}min-height:\s*48px/);
  assert.match(
    partnersCss,
    /\.partners-country-dialog\.region-picker-pop\s*\{[\s\S]{0,260}max-height:\s*calc\(100dvh/,
  );
  assert.match(
    partnersCss,
    /\.partners-country-picker-overlay\s*\{[\s\S]{0,300}safe-area-inset-bottom/,
  );
  assert.match(
    partnersCss,
    /\.partners-shell \[tabindex="-1"\]:focus\s*\{\s*outline:\s*none/,
  );
});

test('Partners route participates in bounded native continuity without storing programme data', () => {
  assert.match(
    appSource,
    /const allowed = new Set\(\['home', 'live', 'movies', 'series', 'settings', 'partners'\]\)/,
  );
  assert.match(pageSource, /getScrollElement\(\)[\s\S]{0,120}\.partners-shell/);
  assert.match(appSource, /const currentPage = this\.getPageScrollElement\(page\)/);
  assert.match(appSource, /const prevPageEl = this\.getPageScrollElement\(this\.currentPage\)/);
  assert.match(appSource, /this\.restorePageScroll\(pageName, this\._pageScroll\?\.\[pageName\]\)/);
  const continuityWrites = appSource.match(
    /localStorage\.setItem\(NORVA_NATIVE_CONTINUITY_KEY,[\s\S]{0,260}\)/,
  );
  assert.ok(continuityWrites, 'missing bounded native continuity write');
  assert.doesNotMatch(
    continuityWrites[0],
    /commission|payout|referral|verification|contract|eligibility|programme/i,
  );
  assert.match(serviceWorkerSource, /CACHE_VERSION\s*=\s*'norva-sw-v6'/);
  assert.match(cssSource, /\.main-content\s*\{\s*padding-bottom:\s*var\(--bottom-nav-h\)/);
  assert.match(
    cssSource,
    /\.partners-shell[\s\S]{0,500}scroll-padding-block:[^;]*var\(--bottom-nav-h\)/,
  );
  assert.match(htmlSource, /main\.css\?v=96/);
  assert.match(htmlSource, /cloudApi\.js\?v=55/);
  assert.match(htmlSource, /standalone\.js\?v=10/);
  assert.match(htmlSource, /Settings\.js\?v=46/);
  assert.match(htmlSource, /PartnersPage\.js\?v=4/);
  assert.match(htmlSource, /app\.js\?v=60/);
});

test('Didit return identifiers are scrubbed before analytics, referrers or auth redirects', () => {
  assert.match(
    appSource,
    /this\._partnersKycReturn = this\.capturePartnersKycReturn\(\)/,
  );
  assert.match(
    appSource,
    /getAll\('verificationSessionId'\)[\s\S]{0,420}getAll\('status'\)/,
  );
  assert.match(
    appSource,
    /url\.searchParams\.delete\('verificationSessionId'\)[\s\S]{0,160}url\.searchParams\.delete\('status'\)/,
  );
  assert.match(
    appSource,
    /url\.hash = '#partners'[\s\S]{0,220}history\.replaceState/,
  );
  assert.match(pageSource, /consumePartnersKycReturnNotice/);
  assert.doesNotMatch(appSource, /sessionStorage\.[^(]+\([^)]*verificationSessionId/);
  assert.doesNotMatch(appSource, /localStorage\.[^(]+\([^)]*verificationSessionId/);
  assert.match(
    serviceWorkerSource,
    /url\.pathname === '\/partners-kyc-return'[\s\S]{0,180}hasSensitiveDiditParams\(url\)/,
  );
  assert.match(
    serviceWorkerSource,
    /url\.searchParams\.has\('verificationSessionId'\)/,
  );
  assert.match(
    serviceWorkerSource,
    /response\.ok && canCacheRequest\(request\)/,
  );
  assert.match(
    serviceWorkerSource,
    /new URL\(request\.url\)\.search === ''/,
  );
});
